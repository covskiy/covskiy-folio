import process from "node:process";

/**
 * Единая конфигурация серверной части — все чтения env-переменных собраны
 * здесь, а не размазаны process.env.* по модулям.
 *
 * Слайсы (LlmSettings, RedisSettings, …) типизированы, и потребитель,
 * читающий config.llm.baseUrl, защищён tsc: несуществующее поле — ошибка
 * компиляции, а не молчаливый undefined в проде (индексная сигнатура
 * ProcessEnv от @types/node даёт только IDE-подсказки). Заодно парсинг (trim,
 * срез слэшей, Number(...) с дефолтом) живёт в одном месте, а не копируется
 * потребителями.
 *
 * Почему геттеры, а не разовый снапшот: env перечитывается на КАЖДЫЙ доступ —
 * подмена vi.stubEnv или мутация env-объекта после createConfig() остаются
 * видимыми (тот же принцип, что у log/llm/redis-rest; живой тест —
 * log.test.ts). Заодно это fail-open на холодном старте: импорт модуля ничего
 * не читает и не бросает, неполный env на момент старта не ломает запуск —
 * недостающее проявится как null/дефолт в момент использования.
 *
 * Почему не импортирует ничего из bot/ (только node:process): config —
 * основание графа зависимостей, любое обратное ребро (log, store, …) дало бы
 * цикл.
 *
 * Парсинг: числа — Number(...), строки — trim, URL — срез хвостовых слэшей —
 * с ОДНИМ ужесточением, согласованным владельцем: число валидно только если
 * конечное и > 0 — отрицательный таймаут/окно бессмысленны.
 */

/** Уровни логирования; строка в env — register-независимая (см. logLevel). */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Срез LLM_*-переменных; null — LLM не настроен (нет baseUrl или model). */
export interface LlmSettings {
  /** Базовый URL endpoint: trim + без хвостовых слэшей (склейка путей конкатенацией). */
  baseUrl: string;
  /** Bearer-ключ endpoint; undefined, если пустая/отсутствует. */
  apiKey?: string;
  /** Модель (напр. gpt-oss:20b). */
  model: string;
  /** Таймаут запроса, мс (env LLM_TIMEOUT_MS, дефолт 15000). */
  timeoutMs: number;
  /** Потолок генерации ответа, токенов (env LLM_MAX_TOKENS, дефолт 1024). */
  maxTokens: number;
}

/** Срез Redis-переменных одной пары; null — полной пары нет (stateless-режим). */
export interface RedisSettings {
  /** REST-адрес базы: trim + без хвостовых слэшей. */
  url: string;
  /** REST-токен базы. */
  token: string;
}

/** Срез Telegram-переменных. */
export interface TelegramSettings {
  /** Токен бота от @BotFather: trim; undefined, если пустой/отсутствует. */
  botToken?: string;
  /** Секрет webhook-заголовка x-telegram-bot-api-secret-token: trim; undefined, если пустой. */
  webhookSecret?: string;
  /** Корень Bot API (env TELEGRAM_API_ROOT, дефолт — официальный api.telegram.org). */
  apiRoot: string;
  /** TTL маркера дедупликации апдейтов, секунд (env TELEGRAM_SEEN_TTL_SECONDS, дефолт 3600). */
  seenTtlSeconds: number;
}

/** Срез порогов rate-limit: env RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_SECONDS. */
export interface RateLimitSettings {
  /** Максимум вопросов на окно на один ключ IP/chatId (дефолт 15). */
  max: number;
  /** Длина окна, секунд (дефолт 3600). */
  windowSeconds: number;
}

/** Срез управляющих ручек «мозга»: env HISTORY_WINDOW / DUMB_SCORE_THRESHOLD. */
export interface BrainSettings {
  /** Реплик диалога в промте (дефолт 10). */
  historyWindow: number;
  /** Порог уверенности dumb-ответа: ниже — fallback с подсказками (дефолт 0.3). */
  dumbScoreThreshold: number;
}

/** Срез памяти диалога: env HISTORY_TTL_SECONDS. */
export interface HistorySettings {
  /** TTL ключа истории в Redis, секунды; обновляется при каждой записи —
   *  «скользящее окно» активности (дефолт 86400 = 24 ч). */
  ttlSeconds: number;
}

/** Корневой срез конфигурации; каждый слайс — ленивый геттер над env. */
export interface AppConfig {
  /** null — LLM_BASE_URL или LLM_MODEL отсутствуют. */
  readonly llm: LlmSettings | null;
  /** null — нет полной пары; приоритет UPSTASH_REDIS_REST_* над KV_REST_API_*. */
  readonly redis: RedisSettings | null;
  readonly telegram: TelegramSettings;
  readonly rateLimit: RateLimitSettings;
  readonly brain: BrainSettings;
  readonly history: HistorySettings;
  readonly logLevel: LogLevel;
}

// Дефолт таймаута запроса к LLM (мс); env LLM_TIMEOUT_MS переопределяет его
// на каждый вызов — локальные модели с reasoning отвечают дольше прода, их
// лимит живёт в .env.local, не в коде. Мусор/ноль в env — снова дефолт:
// посетитель прод-сайта не должен ждать минуту.
const LLM_TIMEOUT_DEFAULT_MS = 15_000;

// Потолок генерации (токенов); env LLM_MAX_TOKENS переопределяет. Без него
// ответ мог быть простынёй на всю квоту, а история хранит его целиком и тащит
// в промт каждого следующего запроса — атака «выдай максимум текста» сжигала
// квоту ускоряясь.
const LLM_MAX_TOKENS_DEFAULT = 1_024;

// Rate-limit «мозга» против выжигания квот (Ollama free / Upstash free /
// Vercel Hobby): каждый вопрос — расход LLM-токенов и Redis-команд, без лимита
// цикл curl сжигает недельную квоту за часы. Пороги — env с дефолтом в коде:
// при атаке порог ужесточается из дашборда Vercel + Redeploy, без коммита.
const RATE_LIMIT_MAX_DEFAULT = 15;
const RATE_LIMIT_WINDOW_DEFAULT_SECONDS = 3_600;

// Управляющие ручки «мозга»: env HISTORY_WINDOW / DUMB_SCORE_THRESHOLD
// переопределяют дефолты (10 / 0.3). Окно — баланс расхода токенов и ширины
// контекста (кап на объём хранимой истории — в store.ts); порог решает, где
// dumb-ответ сменяется честным fallback с подсказками (tasks/04, §2).
const HISTORY_WINDOW_DEFAULT = 10;
const DUMB_SCORE_THRESHOLD_DEFAULT = 0.3;

// TTL истории диалога в Redis; env HISTORY_TTL_SECONDS переопределяет.
// TTL обновляется при каждой записи, поэтому окно скользящее, а не жёсткое.
const HISTORY_TTL_DEFAULT_SECONDS = 86_400;

// TTL маркера дедупликации Telegram-апдейтов; env TELEGRAM_SEEN_TTL_SECONDS
// переопределяет. Час — с запасом поверх ретраев Telegram по одному апдейту.
const TELEGRAM_SEEN_TTL_DEFAULT_SECONDS = 3_600;

// Корень Bot API: дефолт — официальный api.telegram.org; env-оверрайд
// TELEGRAM_API_ROOT — только для локального смоука против мока
// (bot/dev/mock-telegram-api.mjs), на прод не задавать.
const TELEGRAM_API_ROOT_DEFAULT = "https://api.telegram.org";

// Trim строки из env; пустая/отсутствующая — undefined (в слайсах это «не задано»).
function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

// Число из env: валидно только конечное и > 0, иначе дефолт. Мусор/ноль/минус
// в переменной не должен менять поведение прода (Number("abc") === NaN).
function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// URL без хвостовых слэшей: пути склеиваются конкатенацией
// (`${url}/chat/completions`), двойной слэш на стыке не должен зависеть
// от аккуратности автора env.
function withoutTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function llmSettings(env: NodeJS.ProcessEnv): LlmSettings | null {
  const baseUrl = str(env, "LLM_BASE_URL");
  const model = str(env, "LLM_MODEL");
  // Нет одного из двух обязательных — LLM не настроен; что с этим делать,
  // решает потребитель: brain — dumb-поиск, ping — {ok:false, «не настроен»}.
  if (!baseUrl || !model) return null;
  return {
    baseUrl: withoutTrailingSlashes(baseUrl),
    apiKey: str(env, "LLM_API_KEY"),
    model,
    timeoutMs: num(env, "LLM_TIMEOUT_MS", LLM_TIMEOUT_DEFAULT_MS),
    maxTokens: num(env, "LLM_MAX_TOKENS", LLM_MAX_TOKENS_DEFAULT),
  };
}

// Два семейства имён одной и той же базы, пары не смешиваем: UPSTASH_REDIS_REST_*
// даёт upstash.com при создании базы напрямую, KV_REST_API_* инжектит
// интеграция Vercel Marketplace. Приоритет у UPSTASH-семейства; неполная пара
// семейства — как отсутствие, ищем дальше (stateless).
const REDIS_ENV_FAMILIES = [
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
] as const;

function redisSettings(env: NodeJS.ProcessEnv): RedisSettings | null {
  for (const [urlName, tokenName] of REDIS_ENV_FAMILIES) {
    const url = str(env, urlName);
    const token = str(env, tokenName);
    if (url && token) return { url: withoutTrailingSlashes(url), token };
  }
  return null;
}

function telegramSettings(env: NodeJS.ProcessEnv): TelegramSettings {
  return {
    // trim и undefined при пустоте — нормализация согласована владельцем:
    // хвостовые пробелы в токене попали бы в URL `/bot<token>/…` и сломали бы
    // auth.
    botToken: str(env, "TELEGRAM_BOT_TOKEN"),
    webhookSecret: str(env, "TELEGRAM_WEBHOOK_SECRET"),
    // Срез слэшей ДО фолбэка: значение из одних слэшей деградирует в дефолт,
    // а не в пустой корень.
    apiRoot:
      withoutTrailingSlashes(str(env, "TELEGRAM_API_ROOT") ?? "") || TELEGRAM_API_ROOT_DEFAULT,
    seenTtlSeconds: num(env, "TELEGRAM_SEEN_TTL_SECONDS", TELEGRAM_SEEN_TTL_DEFAULT_SECONDS),
  };
}

function rateLimitSettings(env: NodeJS.ProcessEnv): RateLimitSettings {
  return {
    max: num(env, "RATE_LIMIT_MAX", RATE_LIMIT_MAX_DEFAULT),
    windowSeconds: num(env, "RATE_LIMIT_WINDOW_SECONDS", RATE_LIMIT_WINDOW_DEFAULT_SECONDS),
  };
}

function brainSettings(env: NodeJS.ProcessEnv): BrainSettings {
  return {
    historyWindow: num(env, "HISTORY_WINDOW", HISTORY_WINDOW_DEFAULT),
    dumbScoreThreshold: num(env, "DUMB_SCORE_THRESHOLD", DUMB_SCORE_THRESHOLD_DEFAULT),
  };
}

function historySettings(env: NodeJS.ProcessEnv): HistorySettings {
  return { ttlSeconds: num(env, "HISTORY_TTL_SECONDS", HISTORY_TTL_DEFAULT_SECONDS) };
}

function logLevelSettings(env: NodeJS.ProcessEnv): LogLevel {
  // Регистр и пробелы по краям прощаются («DEBUG» проходит) — как в log.ts.
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  switch (raw) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return raw;
    default:
      return "warn";
  }
}

/**
 * Фабрика конфигурации над переданным env (по умолчанию process.env).
 * Возвращает объект с геттерами: env перечитывается на каждый доступ к слайсу,
 * подмена/мутация env после создания остаются видимыми.
 * @param {NodeJS.ProcessEnv} [env] - Источник переменных; по умолчанию process.env.
 * @returns {AppConfig} Ленивые слайсы llm/redis/telegram/rateLimit/logLevel.
 */
export function createConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    get llm() {
      return llmSettings(env);
    },
    get redis() {
      return redisSettings(env);
    },
    get telegram() {
      return telegramSettings(env);
    },
    get rateLimit() {
      return rateLimitSettings(env);
    },
    get brain() {
      return brainSettings(env);
    },
    get history() {
      return historySettings(env);
    },
    get logLevel() {
      return logLevelSettings(env);
    },
  };
}

/**
 * Дефолтный инстанс над process.env — для `import { config }` без фабрик;
 * env всё равно перечитывается на доступ, поэтому vi.stubEnv на нём
 * продолжает работать (тест — config.test.ts).
 */
export const config = createConfig();
