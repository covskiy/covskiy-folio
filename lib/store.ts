import process from "node:process";

// Хранилище истории диалогов (вебчат + Telegram) поверх Upstash Redis REST API.
// Чистый fetch без SDK: REST-эндпоинт у Upstash один, зависимости не нужны,
// а Vercel-функция и так живёт на нативном fetch.

/**
 * Сообщение диалога — единый формат истории для вебчата и Telegram.
 */
export interface ChatMessage {
  /** Автор сообщения; LLM-протокол различает только эти две роли. */
  role: "user" | "assistant";
  /** Текст сообщения. */
  content: string;
}

// Решение владельца: история живёт 24 часа, TTL обновляется при каждой записи,
// так что «скользящее окно» активности чата.
/**
 * TTL истории диалога в Redis, секунды (24 часа); обновляется при каждой записи.
 */
export const HISTORY_TTL_SECONDS = 86_400;

const REST_TIMEOUT_MS = 5_000;

// Два семейства имён одной и той же базы: UPSTASH_REDIS_REST_* даёт upstash.com
// при создании базы напрямую, KV_REST_API_* инжектит интеграция Vercel
// Marketplace (из её пяти переменных нужны только эти две: READ_ONLY-токен и
// не-REST KV_URL/REDIS_URL хранилищу не подходят). Пары не смешиваем: приоритет
// у UPSTASH-семейства, неполная пара — как отсутствие (stateless).
function restEnv(): { url: string; token: string } | null {
  for (const [urlName, tokenName] of [
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  ] as const) {
    const url = process.env[urlName]?.trim();
    const token = process.env[tokenName]?.trim();
    if (url && token) return { url: url.replace(/\/+$/, ""), token };
  }
  return null;
}

// Команда передаётся JSON-массивом в теле POST: значение (JSON истории) может
// быть длинным и содержать любые символы — в URL-пути ему было бы тесно.
// Fail-open: любая проблема (нет env, сеть, не 200, битый ответ) даёт null
// и console.warn — бот обязан отвечать и без Redis, в stateless-режиме.
async function runCommand(command: unknown[]): Promise<unknown> {
  const env = restEnv();
  if (!env) {
    // Один warn на вызов, не throw: отсутствие env — нормальный stateless-режим.
    console.warn(
      "[store] Upstash Redis не настроен (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN) — работаю без истории",
    );
    return null;
  }
  try {
    const response = await fetch(env.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}` },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[store] Upstash REST вернул ${response.status} — работаю без истории`);
      return null;
    }
    const data = (await response.json()) as { result?: unknown; error?: string };
    if (data.error) {
      console.warn(`[store] Upstash вернул ошибку (${data.error}) — работаю без истории`);
      return null;
    }
    return data.result ?? null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[store] Upstash недоступен (${reason}) — работаю без истории`);
    return null;
  }
}

// ── Примитивы над ключами ───────────────────────────────────────────

/**
 * Значение ключа Redis (GET).
 * Env: UPSTASH_REDIS_REST_* или KV_REST_API_URL/TOKEN — см. restEnv (без них — null и warn).
 * @param {string} key - Ключ Redis.
 * @returns {Promise<string|null>} Значение или null: ключа нет / store недоступен (fail-open, не бросает).
 */
export async function getValue(key: string): Promise<string | null> {
  const result = await runCommand(["get", key]);
  return typeof result === "string" ? result : null;
}

/**
 * Записать значение с TTL (SET … EX) — TTL отсчитывается заново при каждой записи.
 * @param {string} key - Ключ Redis.
 * @param {string} value - Строковое значение (для истории — JSON-строка).
 * @param {number} ttlSeconds - Время жизни ключа в секундах.
 * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
 */
export async function setValue(key: string, value: string, ttlSeconds: number): Promise<void> {
  await runCommand(["set", key, value, "EX", String(ttlSeconds)]);
}

/**
 * Удалить ключ (DEL).
 * @param {string} key - Ключ Redis.
 * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
 */
export async function delKey(key: string): Promise<void> {
  await runCommand(["del", key]);
}

// ── Health-check для админ-маршрута ─────────────────────────────────

/**
 * Результат health-check Redis для админ-маршрута (?section=health).
 */
export interface RedisPing {
  /** true — получен ответ PONG. */
  ok: boolean;
  /** Задержка PING→PONG в мс. */
  latencyMs?: number;
  /** Причина отказа: «не настроен» (нет env) либо «нет ответа PONG» (детали в warn-логах). */
  reason?: string;
}

// В отличие от рабочих операций (fail-open, null и warn), здесь отсутствие
// env — честный диагностируемый результат «не настроен», а не сбой.
/**
 * Проверка доступности Upstash Redis командой PING.
 * Env: UPSTASH_REDIS_REST_* или KV_REST_API_URL/TOKEN (см. restEnv).
 * Не бросает: отсутствие env здесь — не сбой, а честный результат ok:false.
 * @returns {Promise<RedisPing>} ok/latencyMs при успехе, ok:false + reason при отказе.
 */
export async function ping(): Promise<RedisPing> {
  if (!restEnv()) {
    return { ok: false, reason: "не настроен: UPSTASH_REDIS_REST_* / KV_REST_API_* отсутствуют" };
  }
  const startedAt = Date.now();
  const result = await runCommand(["ping"]);
  if (result === "PONG") {
    return { ok: true, latencyMs: Date.now() - startedAt };
  }
  // runCommand глотает детали (сеть / не-200 / ошибка в ответе) — они в warn-логах.
  return { ok: false, reason: "нет ответа PONG (детали — в warn-логах store)" };
}

// ── История диалога: одна JSON-строка на ключ ───────────────────────
// Массив целиком в одном значении: атомарная запись одним SET вместо
// нескольких RPUSH; гонки concurrent-запросов одного чата для визитки
// не критичны (last-write-wins).

// Ключи формируются из данных клиента, поэтому битое значение в Redis —
// не повод ронять запрос: отдаём пустую историю.
function parseHistory(raw: string | null): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ChatMessage =>
        typeof item === "object" &&
        item !== null &&
        ((item as ChatMessage).role === "user" || (item as ChatMessage).role === "assistant") &&
        typeof (item as ChatMessage).content === "string",
    );
  } catch {
    return [];
  }
}

/**
 * История диалога по ключу. Битое значение (не JSON, чужие элементы) молча
 * превращается в пустую историю: ключи формируются из данных клиента, и битое
 * значение в Redis — не повод ронять запрос.
 * @param {string} key - Ключ Redis (см. webKey/tgKey).
 * @returns {Promise<ChatMessage[]>} Валидные сообщения в порядке добавления; [] при пусто/ошибке (fail-open).
 */
export async function getHistory(key: string): Promise<ChatMessage[]> {
  return parseHistory(await getValue(key));
}

/**
 * Дописать сообщения в конец истории: достать → дополнить → записать одним SET
 * с обновлением TTL (24 ч). Пустой список — no-op без обращения к Redis.
 * @param {string} key - Ключ Redis.
 * @param {ChatMessage[]} messages - Сообщения для добавления в конец.
 * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
 */
export async function appendHistory(key: string, messages: ChatMessage[]): Promise<void> {
  if (messages.length === 0) return;
  // Достать → дополнить → записать одним SET с обновлением TTL.
  const history = await getHistory(key);
  await setValue(key, JSON.stringify([...history, ...messages]), HISTORY_TTL_SECONDS);
}

/**
 * Очистить историю диалога (удалить ключ).
 * @param {string} key - Ключ Redis.
 * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
 */
export async function clearHistory(key: string): Promise<void> {
  await delKey(key);
}

// ── Помощники ключей ────────────────────────────────────────────────

/**
 * Ключ истории вебчата.
 * @param {string} sessionId - Идентификатор сессии из виджета (валидацию делает обработчик).
 * @returns {string} Ключ вида `chat:web:{sessionId}`.
 */
export function webKey(sessionId: string): string {
  return `chat:web:${sessionId}`;
}

/**
 * Ключ истории Telegram-диалога.
 * @param {number|string} chatId - Идентификатор чата Telegram.
 * @returns {string} Ключ вида `chat:tg:{chatId}`.
 */
export function tgKey(chatId: number | string): string {
  return `chat:tg:${chatId}`;
}
