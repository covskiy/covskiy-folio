import process from "node:process";
// Транспорт Upstash REST вынесен в redis-rest.ts (§11 фазы B): здесь остаётся
// только домен — история, дедупликация, лимитер, ключи. restEnv переиспользуется
// из транспорта: ping отличает «не настроен» от «нет ответа», это не fail-open.
import { createRedisRest, restEnv, type RedisRest } from "./redis-rest.js";
// Тип инстанса логгера — структурная подмена в тестах без контрактов-файлов.
import type { Logger } from "./log.js";

/**
 * Хранилище истории диалогов (вебчат + Telegram) поверх Upstash Redis REST API:
 * доменные операции над ключами (TTL, капы, парсинг) без протокола транспорта.
 * Фабрика createStore — шов для тестов (фейковый redis вместо сети); дефолтный
 * инстанс с поимённым переэкспортом сохраняет все существующие импорты store.
 */

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

/**
 * Зависимости хранилища — точки инъекции для тестов; в рантайме createStore()
 * без аргументов (redis собирается из process.env и глобального fetch).
 */
export interface StoreDeps {
  /** Транспорт Upstash REST (createRedisRest); по умолчанию собирается из deps.env. */
  redis?: RedisRest;
  /** Логгер деградаций дефолтного транспорта; по умолчанию createLogger() внутри redis-rest. */
  log?: Logger;
  // Единый источник env для дефолтного транспорта и проверки «не настроен» в
  // ping — иначе инстанс с инжектированным env отвечал бы ping'ом из process.env.
  /** Источник UPSTASH_REDIS_REST_* / KV_REST_API_*; по умолчанию process.env. */
  env?: NodeJS.ProcessEnv;
}

// ── История диалога: одна JSON-строка на ключ ───────────────────────
// Массив целиком в одном значении: атомарная запись одним SET вместо
// нескольких RPUSH; гонки concurrent-запросов одного чата для визитки
// не критичны (last-write-wins).

// Капы на запись: ответ LLM без max_tokens мог быть простынёй, и она легла бы
// в Redis и в промт каждого следующего запроса (HISTORY_WINDOW режет число
// сообщений, но не их размер) — так атаки сжигали квоту ускоряясь. Число
// сообщений с запасом перекрывает HISTORY_WINDOW (10) из brain.ts.
const HISTORY_MAX_MESSAGES = 20;
const HISTORY_MAX_CONTENT_LENGTH = 4_000;

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

/**
 * Фабрика хранилища: доменные функции живут в замыкании над транспортом (как
 * answer в createBrain). Fail-open 1-в-1 с прежним модулем: ни одна функция
 * не бросает — гарантия fail-open лежит в транспорте (redis-rest возвращает
 * null вместо throw), домен лишь интерпретирует null как «пусто».
 * @param {StoreDeps} deps - Инъекции redis/log/env; без аргументов — поведение как раньше.
 * @returns Доменные операции над Redis (история, дедупликация, лимитер, ping, ключи).
 */
export function createStore(deps: StoreDeps = {}) {
  // Дефолт — инстанс рантайма; тесты приходят со своим транспортом через deps.
  const redis = deps.redis ?? createRedisRest({ env: deps.env, log: deps.log });
  // Единый источник env для транспорта и ping: «не настроен» в ping должен
  // определяться теми же переменными, что и ходит сам store.
  const env = deps.env ?? process.env;

  /**
   * Атомарный счётчик для rate-limit'а: INCR + EXPIRE NX одним pipeline.
   * EXPIRE NX ставит TTL только если у ключа его ещё нет — окно стартует с первого
   * хита и не «скользит» за каждым запросом (иначе постоянный трафик никогда
   * не выходил бы из окна). Fail-open: проблема Redis → null (лимит пропускает).
   * @param {string} key - Ключ счётчика (prefix `rate:` даёт вызывающий модуль).
   * @param {number} ttlSeconds - Длина окна в секундах.
   * @returns {Promise<number|null>} Значение счётчика после INCR; null при недоступности Redis.
   */
  async function incrCounter(key: string, ttlSeconds: number): Promise<number | null> {
    const results = await redis.pipeline([
      ["incr", key],
      ["expire", key, String(ttlSeconds), "NX"],
    ]);
    const value = results?.[0];
    return typeof value === "number" ? value : null;
  }

  // ── Примитивы над ключами ───────────────────────────────────────

  /**
   * Значение ключа Redis (GET).
   * Env: UPSTASH_REDIS_REST_* или KV_REST_API_URL/TOKEN — см. restEnv (без них — null и warn).
   * @param {string} key - Ключ Redis.
   * @returns {Promise<string|null>} Значение или null: ключа нет / store недоступен (fail-open, не бросает).
   */
  async function getValue(key: string): Promise<string | null> {
    const result = await redis.command(["get", key]);
    return typeof result === "string" ? result : null;
  }

  /**
   * Записать значение с TTL (SET … EX) — TTL отсчитывается заново при каждой записи.
   * @param {string} key - Ключ Redis.
   * @param {string} value - Строковое значение (для истории — JSON-строка).
   * @param {number} ttlSeconds - Время жизни ключа в секундах.
   * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
   */
  async function setValue(key: string, value: string, ttlSeconds: number): Promise<void> {
    await redis.command(["set", key, value, "EX", String(ttlSeconds)]);
  }

  // Дедупликация Telegram-апдейтов: Telegram — at-least-once, при не-2xx или
  // потерянном ответе он повторяет ТОТ ЖЕ JSON с тем же update_id. Повтор
  // неотличим от нового вопроса: второй вызов LLM, вторая пара в истории.
  /**
   * Видели ли уже этот апдейт (GET маркера дедупликации).
   * Fail-open: любая проблема Redis → false («не видели») — дедупликация
   * улучшение, а не условие работы: бот обязан отвечать и без Redis.
   * @param {string} key - Ключ маркера (см. tgSeenKey).
   * @returns {Promise<boolean>} true, если маркер стоит (непустая строка — «1»).
   */
  async function isSeen(key: string): Promise<boolean> {
    const result = await redis.command(["get", key]);
    return typeof result === "string" && result.length > 0;
  }

  /**
   * Поставить маркер «апдейт обработан» (SET … EX NX). NX — при гипотетической
   * гонке (Telegram один апдейт параллельно не шлёт, но страховка дешёвая)
   * не затирает существующий маркер.
   * @param {string} key - Ключ маркера (см. tgSeenKey).
   * @param {number} ttlSeconds - Время жизни маркера в секундах.
   * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
   */
  async function markSeen(key: string, ttlSeconds: number): Promise<void> {
    await redis.command(["set", key, "1", "EX", String(ttlSeconds), "NX"]);
  }

  /**
   * Удалить ключ (DEL).
   * @param {string} key - Ключ Redis.
   * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
   */
  async function delKey(key: string): Promise<void> {
    await redis.command(["del", key]);
  }

  // ── Health-check для админ-маршрута ─────────────────────────────

  // В отличие от рабочих операций (fail-open, null и warn), здесь отсутствие
  // env — честный диагностируемый результат «не настроен», а не сбой.
  /**
   * Проверка доступности Upstash Redis командой PING.
   * Env: UPSTASH_REDIS_REST_* или KV_REST_API_URL/TOKEN (см. restEnv).
   * Не бросает: отсутствие env здесь — не сбой, а честный результат ok:false.
   * @returns {Promise<RedisPing>} ok/latencyMs при успехе, ok:false + reason при отказе.
   */
  async function ping(): Promise<RedisPing> {
    if (!restEnv(env)) {
      return { ok: false, reason: "не настроен: UPSTASH_REDIS_REST_* / KV_REST_API_* отсутствуют" };
    }
    const startedAt = Date.now();
    const result = await redis.command(["ping"]);
    if (result === "PONG") {
      return { ok: true, latencyMs: Date.now() - startedAt };
    }
    // Транспорт глотает детали (сеть / не-200 / ошибка в ответе) — они в warn-логах.
    return { ok: false, reason: "нет ответа PONG (детали — в warn-логах store)" };
  }

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
  async function getHistory(key: string): Promise<ChatMessage[]> {
    return parseHistory(await getValue(key));
  }

  /**
   * Дописать сообщения в конец истории: достать → дополнить → записать одним SET
   * с обновлением TTL (24 ч). Пустой список — no-op без обращения к Redis.
   * Запись ограничена капами: последние 20 сообщений, каждая реплика не длиннее
   * 4000 символов — раздутая история не забивает free-tier Redis и контекст промта.
   * @param {string} key - Ключ Redis.
   * @param {ChatMessage[]} messages - Сообщения для добавления в конец.
   * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
   */
  async function appendHistory(key: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    // Достать → дополнить → обрезать по капам → записать одним SET с обновлением TTL.
    const history = await getHistory(key);
    const capped = [...history, ...messages]
      .map(({ role, content }) => ({ role, content: content.slice(0, HISTORY_MAX_CONTENT_LENGTH) }))
      .slice(-HISTORY_MAX_MESSAGES);
    await setValue(key, JSON.stringify(capped), HISTORY_TTL_SECONDS);
  }

  /**
   * Очистить историю диалога (удалить ключ).
   * @param {string} key - Ключ Redis.
   * @returns {Promise<void>} Ничего; при недоступности Redis — no-op (fail-open, не бросает).
   */
  async function clearHistory(key: string): Promise<void> {
    await delKey(key);
  }

  // ── Помощники ключей ────────────────────────────────────────────

  /**
   * Ключ истории вебчата.
   * @param {string} sessionId - Идентификатор сессии из виджета (валидацию делает обработчик).
   * @returns {string} Ключ вида `chat:web:{sessionId}`.
   */
  function webKey(sessionId: string): string {
    return `chat:web:${sessionId}`;
  }

  /**
   * Ключ истории Telegram-диалога.
   * @param {number|string} chatId - Идентификатор чата Telegram.
   * @returns {string} Ключ вида `chat:tg:{chatId}`.
   */
  function tgKey(chatId: number | string): string {
    return `chat:tg:${chatId}`;
  }

  /**
   * Ключ маркера дедупликации Telegram-апдейта (см. isSeen/markSeen).
   * @param {number|string} updateId - Идентификатор апдейта Telegram.
   * @returns {string} Ключ вида `tg:seen:{updateId}`.
   */
  function tgSeenKey(updateId: number | string): string {
    return `tg:seen:${updateId}`;
  }

  return {
    incrCounter,
    getValue,
    setValue,
    isSeen,
    markSeen,
    delKey,
    ping,
    getHistory,
    appendHistory,
    clearHistory,
    webKey,
    tgKey,
    tgSeenKey,
  };
}

/** Тип инстанса хранилища — структурная подмена в тестах и будущих контрактах (§13). */
export type Store = ReturnType<typeof createStore>;

// Дефолтный инстанс с поимённым переэкспортом: все существующие импорты вида
// `import { getHistory } from "./store.js"` по проекту (webchat, telegram-*,
// rate-limit) не меняются.
const defaultStore = createStore();
export const incrCounter = defaultStore.incrCounter;
export const getValue = defaultStore.getValue;
export const setValue = defaultStore.setValue;
export const isSeen = defaultStore.isSeen;
export const markSeen = defaultStore.markSeen;
export const delKey = defaultStore.delKey;
export const ping = defaultStore.ping;
export const getHistory = defaultStore.getHistory;
export const appendHistory = defaultStore.appendHistory;
export const clearHistory = defaultStore.clearHistory;
export const webKey = defaultStore.webKey;
export const tgKey = defaultStore.tgKey;
export const tgSeenKey = defaultStore.tgSeenKey;
