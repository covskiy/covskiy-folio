import process from "node:process";
// Тип инстанса логгера — структурная подмена в тестах без контрактов-файлов.
import { createLogger, type Logger } from "./log.js";

/**
 * Транспорт Upstash Redis REST API — единственное место, где код ходит в
 * Upstash по HTTP. Никакой доменной логики: команды приходят готовыми
 * массивами (`["get", key]`, …), а история/лимитер/дедупликация живут в
 * store.ts. Вынесен из store.ts (§11 фазы B), чтобы домен читался как «как
 * устроена история», а не «как устроен Upstash REST». Чистый fetch без SDK:
 * REST-эндпоинт у Upstash один, зависимости не нужны, а Vercel-функция и так
 * живёт на нативном fetch.
 *
 * Зависимости инжектируются через deps и резолвятся НА КАЖДЫЙ вызов, а не при
 * создании фабрики: подмена глобального fetch (vi.stubGlobal) или env
 * (vi.stubEnv / мутация объекта) после import должна быть видна — иначе тесты
 * и логика «env запекается в деплой» ломаются незаметно.
 *
 * Дублирование «fetch + timeout + JSON» с llm.ts и telegram-api.ts оставлено
 * сознательно: у трёх мест разная семантика ошибок (throw / ok:false /
 * fail-open), общий хелпер сделает хуже (см. задачу §12).
 */

/** Зависимости транспорта — точки инъекции для тестов; в рантайме createRedisRest(). */
export interface RedisRestDeps {
  /** Источник UPSTASH_REDIS_REST_* / KV_REST_API_*; по умолчанию process.env. */
  env?: NodeJS.ProcessEnv;
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

// Два семейства имён одной и той же базы: UPSTASH_REDIS_REST_* даёт upstash.com
// при создании базы напрямую, KV_REST_API_* инжектит интеграция Vercel
// Marketplace (из её пяти переменных нужны только эти две: READ_ONLY-токен и
// не-REST KV_URL/REDIS_URL хранилищу не подходят). Пары не смешиваем: приоритет
// у UPSTASH-семейства, неполная пара — как отсутствие (stateless).
/**
 * Разворачивает env в пару {url, token} для Upstash REST; env приходит
 * аргументом (уже зарезолвенный на вызов) — читаем только его.
 * Экспортирована для ping в store.ts: там отсутствие env — не fail-open-сбой,
 * а честный диагностируемый результат «не настроен».
 * @param {NodeJS.ProcessEnv} env - Источник переменных (process.env или инъекция).
 * @returns Пара url/token (трим значений, срез хвостовых слэшей URL) или null, если пары нет.
 */
export function restEnv(env: NodeJS.ProcessEnv): { url: string; token: string } | null {
  for (const [urlName, tokenName] of [
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  ] as const) {
    const url = env[urlName]?.trim();
    const token = env[tokenName]?.trim();
    if (url && token) return { url: url.replace(/\/+$/, ""), token };
  }
  return null;
}

/**
 * Фабрика транспорта: возвращает { command, pipeline }. env/fetch/timeout
 * резолвятся на каждый вызов command/pipeline; log — один инстанс на фабрику:
 * троттлинг warn'ов живёт в Map внутри его замыкания, свежий логгер на вызов
 * превратил бы warnThrottled в спам.
 * @param {RedisRestDeps} deps - Инъекции env/fetchImpl/log/timeoutMs; без аргументов —
 *   глобальный fetch и process.env, как раньше.
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
    // Резолв на вызов: подмена глобального fetch/env после импорта видна.
    const env = restEnv(deps.env ?? process.env);
    if (!env) {
      // Warn с троттлингом, не throw: отсутствие env — нормальный stateless-режим,
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
      const response = await doFetch(env.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.token}` },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warnThrottled(
          LOG_MODULE,
          "rest-status",
          `Upstash REST вернул ${response.status} — работаю без истории`,
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
    const env = restEnv(deps.env ?? process.env);
    if (!env) {
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
      const response = await doFetch(env.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.token}` },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warnThrottled(
          LOG_MODULE,
          "rest-status",
          `Upstash REST вернул ${response.status} (pipeline) — работаю без лимитера`,
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
