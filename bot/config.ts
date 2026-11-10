import process from "node:process";

/**
 * Единая конфигурация серверной части — все чтения env-переменных собраны
 * здесь, а не размазаны process.env.* по модулям.
 *
 * Слайсы (LlmSettings, RedisSettings, …) типизированы, и потребитель,
 * читающий config.llm.providers, защищён tsc: несуществующее поле — ошибка
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

/** Тип провайдера LLM: ключ реестра адаптеров в bot/llm/index.ts. */
export type LlmProviderKind = "openai";

/** Один провайдер цепочки: слот env `LLM_<n>_*`. */
export interface LlmProviderSettings {
  /** Идентификатор для логов и health (env LLM_n_ID, дефолт provider-<n>). */
  id: string;
  /** Протокол адаптера (env LLM_n_KIND, дефолт openai). */
  kind: LlmProviderKind;
  /** Базовый URL endpoint: trim + без хвостовых слэшей. */
  baseUrl: string;
  /** Bearer-ключ endpoint; undefined, если пустая/отсутствует. */
  apiKey?: string;
  /** Модель (напр. @cf/meta/llama-3.1-8b-instruct). */
  model: string;
  /** Таймаут одной попытки, мс (LLM_n_TIMEOUT_MS, дефолт LLM_TIMEOUT_MS). */
  timeoutMs: number;
}

/**
 * Срез LLM_*-переменных: упорядоченная цепочка провайдеров и общие ручки.
 * Не-null всегда — «LLM не настроен» выражается пустым providers; так health
 * показывает issues даже без валидных слотов.
 */
export interface LlmSettings {
  /** Провайдеры в порядке попыток (слоты LLM_1_*…LLM_9_*). */
  providers: LlmProviderSettings[];
  /** Потолок генерации ответа, токенов (env LLM_MAX_TOKENS, дефолт 1024). */
  maxTokens: number;
  /** Общий бюджет chat() на все попытки, мс (LLM_TOTAL_TIMEOUT_MS, дефолт 20000). */
  totalTimeoutMs: number;
  /** Сколько не трогать упавшего провайдера, мс (LLM_COOLDOWN_MS, дефолт 60000). */
  cooldownMs: number;
  /** Неполные/невалидные слоты и опечатки — для логов и health. */
  issues: string[];
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
  /** Цепочка провайдеров LLM; пустой providers — LLM не настроен. */
  readonly llm: LlmSettings;
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

// Общий бюджет chat() на все попытки: без него цепочка из N провайдеров
// держала бы посетителя N × таймаут. 20 с — чуть больше одной попытки, чтобы
// запасной успел ответить, но человек не ждал минуту.
const LLM_TOTAL_TIMEOUT_DEFAULT_MS = 20_000;

// Cooldown упавшего провайдера: тёплый инстанс не ждёт его таймаут на каждом
// вопросе. 60 с — компромисс между «не долбить мёртвый endpoint» и «заметить
// восстановление».
const LLM_COOLDOWN_DEFAULT_MS = 60_000;

// Диапазон номеров слотов LLM_<n>_*: порядок номеров = порядок попыток.
// Вне диапазона — опечатка (LLM_0_*, LLM_10_*): слот в issues и не в цепочке.
const LLM_SLOT_MIN = 1;
const LLM_SLOT_MAX = 9;

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

// Маска слота провайдера: LLM_<n>_<FIELD>. Захватывает номер и имя поля.
const LLM_SLOT_KEY = /^LLM_(\d+)_(.+)$/;

// Поля слота; всё остальное — опечатка, которую нельзя терять молча.
const LLM_SLOT_FIELDS = new Set(["ID", "KIND", "BASE_URL", "API_KEY", "MODEL", "TIMEOUT_MS"]);

// Реестр допустимых протоколов: продублирован здесь, чтобы config не
// импортировал bot/llm (config — основание графа зависимостей).
const LLM_PROVIDER_KINDS: readonly LlmProviderKind[] = ["openai"];

function llmSettings(env: NodeJS.ProcessEnv): LlmSettings {
  const timeoutDefault = num(env, "LLM_TIMEOUT_MS", LLM_TIMEOUT_DEFAULT_MS);
  const issues: string[] = [];
  const indices = new Set<number>();

  // Номера слотов ищем по ключам env: общие ручки (LLM_TIMEOUT_MS,
  // LLM_MAX_TOKENS, LLM_TOTAL_TIMEOUT_MS, LLM_COOLDOWN_MS) под маску не
  // попадают — после LLM_ у них нет цифры.
  for (const key of Object.keys(env)) {
    const match = LLM_SLOT_KEY.exec(key);
    if (!match) continue;
    indices.add(Number(match[1]));
    if (!LLM_SLOT_FIELDS.has(match[2])) {
      issues.push(`LLM_${match[1]}_${match[2]}: неизвестное поле слота`);
    }
  }

  const sorted = [...indices].sort((a, b) => a - b);
  const inRange: number[] = [];
  for (const index of sorted) {
    if (index < LLM_SLOT_MIN || index > LLM_SLOT_MAX) {
      issues.push(`LLM_${index}_*: номер вне диапазона ${LLM_SLOT_MIN}…${LLM_SLOT_MAX}`);
      continue;
    }
    inRange.push(index);
  }

  // Дыры в нумерации: цепочка должна идти подряд с первого слота. Валидные
  // слоты всё равно используем — опечатка не должна молча терять живого
  // провайдера.
  if (inRange.length > 0) {
    const present = new Set(inRange);
    for (let index = LLM_SLOT_MIN; index <= inRange[inRange.length - 1]; index++) {
      if (!present.has(index)) issues.push(`LLM_${index}_*: пропуск в нумерации слотов`);
    }
  }

  const providers: LlmProviderSettings[] = [];
  const ids = new Set<string>();
  for (const index of inRange) {
    const prefix = `LLM_${index}_`;
    const baseUrl = str(env, `${prefix}BASE_URL`);
    const model = str(env, `${prefix}MODEL`);
    // Неполный слот — в issues: молча пропустить значит спрятать опечатку
    // в конфиге, из-за которой бот тихо уходит в dumb.
    if (!baseUrl || !model) {
      issues.push(`${prefix}*: нужны BASE_URL и MODEL — слот пропущен`);
      continue;
    }
    const kindRaw = str(env, `${prefix}KIND`) ?? "openai";
    const kind = LLM_PROVIDER_KINDS.find((candidate) => candidate === kindRaw);
    if (!kind) {
      issues.push(`${prefix}KIND: неизвестный тип «${kindRaw}» — слот пропущен`);
      continue;
    }
    // id — ключ cooldown и строка health: дубль сделал бы состояние
    // неоднозначным, поэтому второй слот с тем же id в цепочку не идёт.
    const id = str(env, `${prefix}ID`) ?? `provider-${index}`;
    if (ids.has(id)) {
      issues.push(`${prefix}ID: дубль «${id}» — слот пропущен`);
      continue;
    }
    ids.add(id);
    providers.push({
      id,
      kind,
      baseUrl: withoutTrailingSlashes(baseUrl),
      apiKey: str(env, `${prefix}API_KEY`),
      model,
      timeoutMs: num(env, `${prefix}TIMEOUT_MS`, timeoutDefault),
    });
  }

  return {
    providers,
    maxTokens: num(env, "LLM_MAX_TOKENS", LLM_MAX_TOKENS_DEFAULT),
    totalTimeoutMs: num(env, "LLM_TOTAL_TIMEOUT_MS", LLM_TOTAL_TIMEOUT_DEFAULT_MS),
    cooldownMs: num(env, "LLM_COOLDOWN_MS", LLM_COOLDOWN_DEFAULT_MS),
    issues,
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
