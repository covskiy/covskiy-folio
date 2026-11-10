// Тип инстанса логгера — структурная подмена в тестах без контрактов-файлов.
import { createLogger, type Logger } from "./log.js";
// config — готовый типизированный слайс redis; дефолтный инстанс для рантайма.
import { config } from "./config.js";
import type { AppConfig } from "./config.js";

/**
 * Транспорт Upstash Redis REST API — единственное место, где код ходит в
 * Upstash по HTTP. Никакой доменной логики: команды приходят готовыми
 * массивами (`["get", key]`, …), а история/лимитер/дедупликация живут в
 * store.ts. Разделение сознательное: store.ts читается как «как устроена
 * история», а не «как устроен Upstash REST». Чистый fetch без SDK:
 * REST-эндпоинт у Upstash один, зависимости не нужны, а Vercel-функция и так
 * живёт на нативном fetch.
 *
 * Транспорт не знает, КАК парсится env: config.ts отдаёт готовый слайс redis
 * (url без слэшей, токен trim'нутый, приоритет UPSTASH-семейства над KV) или
 * null — null означает stateless-режим, здесь это fail-open (null из command).
 *
 * Зависимости инжектируются через deps и резолвятся НА КАЖДЫЙ вызов, а не при
 * создании фабрики: подмена глобального fetch (vi.stubGlobal) или config
 * (ленивые геттеры перечитывают env на каждый доступ) после import должна быть
 * видна — иначе тесты и логика «env запекается в деплой» ломаются незаметно.
 *
 * Дублирование «fetch + timeout + JSON» с bot/llm/openai.ts и telegram-api.ts оставлено
 * сознательно: у трёх мест разная семантика ошибок (throw / ok:false /
 * fail-open), общий хелпер сделает хуже.
 */

/** Зависимости транспорта — точки инъекции для тестов; в рантайме createRedisRest(). */
export interface RedisRestDeps {
  /** Готовый конфиг; по умолчанию дефолтный config из config.ts (process.env). */
  config?: AppConfig;
  /** Подмена сети; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
  /** Логгер деградаций; по умолчанию createLogger() — один инстанс на фабрику. */
  log?: Logger;
  /** Таймаут одного REST-запроса, мс; по умолчанию 5000. */
  timeoutMs?: number;
}

// Деградация Redis — это деградация store целиком (история, лимитер,
// дедупликация), поэтому модуль в логах остаётся «store»: таблицы диагностики
// в docs/manual.md и runbook завязаны на этот префикс.
const LOG_MODULE = "store";

// Дефолт таймаута одного REST-запроса.
const DEFAULT_TIMEOUT_MS = 5_000;

// Тело ошибки Upstash диагностически ценно: текст вида «ERR unsupported arg
// type…» указывает прямо на несовместимый формат запроса, а секретов не
// содержит — в warn идёт сжатый сниппет. Пустое тело (CDN/прокси без текста)
// строку не засоряет.
function errorBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat ? ` — тело: ${flat.length > 200 ? `${flat.slice(0, 200)}…` : flat}` : "";
}

/**
 * Фабрика транспорта: возвращает { command, pipeline }. config/fetch/timeout
 * резолвятся на каждый вызов command/pipeline; log — один инстанс на фабрику:
 * троттлинг warn'ов живёт в Map внутри его замыкания, свежий логгер на вызов
 * превратил бы warnThrottled в спам.
 * @param {RedisRestDeps} deps - Инъекции config/fetchImpl/log/timeoutMs; без аргументов —
 *   глобальный fetch и дефолтный config (process.env).
 * @returns command(command) — одна команда; pipeline(commands) — массив команд одним POST.
 */
export function createRedisRest(deps: RedisRestDeps = {}) {
  const log = deps.log ?? createLogger();

  // Команда передаётся JSON-массивом в теле POST: значение (JSON истории) может
  // быть длинным и содержать любые символы — в URL-пути ему было бы тесно.
  // Fail-open: любая проблема (нет env, сеть, не 200, битый ответ) даёт null
  // и warn через log — бот обязан отвечать и без Redis, в stateless-режиме.
  /**
   * Выполнить одну REST-команду (POST JSON-массивом, Bearer из токена).
   * @param {unknown[]} command - Команда Upstash, например `["get", key]`.
   * @returns {Promise<unknown>} result из ответа; null при любой проблеме (fail-open, не бросает).
   */
  async function command(command: unknown[]): Promise<unknown> {
    // Резолв на вызов: подмена глобального fetch/config после импорта видна.
    const redis = (deps.config ?? config).redis;
    if (!redis) {
      // Warn с троттлингом, не throw: отсутствие пары — нормальный stateless-режим,
      // без троттлинга этот текст повторялся бы на каждый вопрос.
      log.warnThrottled(
        LOG_MODULE,
        "no-env",
        "Upstash Redis не настроен (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN) — работаю без истории",
      );
      return null;
    }
    const doFetch = deps.fetchImpl ?? fetch;
    try {
      const response = await doFetch(redis.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${redis.token}` },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warnThrottled(
          LOG_MODULE,
          "rest-status",
          `Upstash REST вернул ${response.status}${errorBody(await response.text())} — работаю без истории`,
        );
        return null;
      }
      const data = (await response.json()) as { result?: unknown; error?: string };
      if (data.error) {
        log.warnThrottled(
          LOG_MODULE,
          "rest-error",
          `Upstash вернул ошибку (${data.error}) — работаю без истории`,
        );
        return null;
      }
      return data.result ?? null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warnThrottled(
        LOG_MODULE,
        "network",
        `Upstash недоступен (${reason}) — работаю без истории`,
      );
      return null;
    }
  }

  // Pipeline — массив команд в одном теле POST, ответ — массив {result}/{error}
  // по элементам (у одиночной команды ответ — один объект, поэтому отдельная
  // функция). Лимитер ходит в Redis на каждый запрос, дорожить roundtrip'ом нельзя.
  /**
   * Выполнить массив команд одним POST (для лимитера: INCR + EXPIRE NX).
   * @param {unknown[][]} commands - Команды Upstash по элементам.
   * @returns {Promise<(unknown | null)[] | null>} Ответы по элементам (ошибка
   *   элемента → null) или null при проблеме всего запроса (fail-open, не бросает).
   */
  async function pipeline(commands: unknown[][]): Promise<(unknown | null)[] | null> {
    // Резолв на вызов — как у command.
    const redis = (deps.config ?? config).redis;
    if (!redis) {
      // Тот же throttle-ключ, что у command: деградация одна, не дублируем.
      log.warnThrottled(
        LOG_MODULE,
        "no-env",
        "Upstash Redis не настроен (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN) — работаю без лимитера",
      );
      return null;
    }
    const doFetch = deps.fetchImpl ?? fetch;
    try {
      // Пайплайн живёт на отдельном пути /pipeline: базовый эндпоинт принимает
      // только одну плоскую команду, а на массив массивов отвечает 400
      // «ERR unsupported arg type: "["» — на этом формате лимитер молча
      // деградировал с запуска (нашли по прод-логам 2026-11-09).
      const response = await doFetch(`${redis.url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redis.token}` },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warnThrottled(
          LOG_MODULE,
          "rest-status",
          `Upstash REST вернул ${response.status} (pipeline)${errorBody(await response.text())} — работаю без лимитера`,
        );
        return null;
      }
      const data = (await response.json()) as Array<{ result?: unknown; error?: string }>;
      if (!Array.isArray(data)) return null;
      return data.map((item) => (item.error ? null : (item.result ?? null)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warnThrottled(
        LOG_MODULE,
        "network",
        `Upstash недоступен (${reason}) — работаю без лимитера`,
      );
      return null;
    }
  }

  return { command, pipeline };
}

/** Тип инстанса транспорта — структурная подмена в тестах и в StoreDeps (store.ts). */
export type RedisRest = ReturnType<typeof createRedisRest>;
