// Тип инстанса логгера — структурная подмена в тестах без контрактов-файлов.
import type { Logger } from "./log.js";
// Единое определение сообщения диалога живёт в store.ts — дублировать нельзя.
import type { ChatMessage } from "./store.js";
// config — готовый типизированный слайс llm; дефолтный инстанс для рантайма.
import { config } from "./config.js";
import type { AppConfig } from "./config.js";

/**
 * Сообщение для LLM-протокола: история диалога (ChatMessage, user/assistant)
 * плюс system-промт, который в историю не пишется и потому в ChatMessage
 * не входит. Источник ролей всё равно один — store.ts.
 */
export type LlmMessage = ChatMessage | { role: "system"; content: string };

/**
 * Транспорт LLM — единственное место, где код ходит в OpenAI-совместимый
 * endpoint (Ollama Cloud, llama.cpp, …). Никакой доменной логики: system-промт
 * собирает brain (prompt.ts), транспорт получает ГОТОВЫЙ массив сообщений.
 *
 * Транспорт не знает, КАК парсится env: config.ts отдаёт готовый типизированный
 * слайс llm (baseUrl без слэшей, ключ trim'нутый, числа с дефолтами) — здесь
 * только склейка URL и fetch-вызов.
 *
 * Зависимости инжектируются через deps и резолвятся НА КАЖДЫЙ вызов, а не при
 * создании фабрики: подмена глобального fetch (vi.stubEnv / vi.stubGlobal) или
 * config после import должна быть видна — иначе тесты и логика «env запекается
 * в деплой» ломаются незаметно.
 *
 * Дублирование «fetch + timeout + JSON» с telegram-api и redis-rest оставлено
 * сознательно: у трёх мест разная семантика ошибок (throw / ok:false /
 * fail-open), общий хелпер сделает хуже.
 */

/** Зависимости транспорта — точки инъекции для тестов; в рантайме createLlm(). */
export interface LlmDeps {
  /** Готовый конфиг; по умолчанию дефолтный config из config.ts (process.env). */
  config?: AppConfig;
  /** Подмена сети; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
  /** Часы для latencyMs в ping; по умолчанию Date.now. */
  clock?: () => number;
  /** Логгер (зарезервировано фабриками, собирающими граф зависимостей). */
  log?: Logger;
}

/**
 * Результат health-check LLM для админ-маршрута (?section=health).
 */
export interface LlmPing {
  /** true — провайдер ответил успешно хотя бы на одну из проб. */
  ok: boolean;
  /** Задержка в мс от начала пинга до успешной пробы. */
  latencyMs?: number;
  /** Какая проба сработала (GET /models или минимальный chat/completions). */
  detail?: string;
  /** Причина отказа: не настроен / статус endpoint / текст ошибки сети. Без секретов. */
  error?: string;
}

// Таймаут каждой пробы ping — не env (health-check не настраивают под
// провайдера), поэтому живёт здесь, а не в config.ts.
const LLM_PING_TIMEOUT_MS = 10_000;

/**
 * Фабрика транспорта: возвращает { chat, ping }. deps резолвятся на каждый
 * вызов chat/ping — подмена fetch/config после создания инстанса работает.
 * @param {LlmDeps} deps - Инъекции config/fetchImpl/clock/log; без аргументов —
 *   глобальный fetch и дефолтный config (process.env).
 * @returns chat(messages) — бросает при любой проблеме; ping() — никогда не бросает.
 */
export function createLlm(deps: LlmDeps = {}) {
  /**
   * Запрос к chat/completions с готовым массивом сообщений.
   * @param {LlmMessage[]} messages - Готовые сообщения (system ставит brain).
   * @returns {Promise<string>} Обрезанный текст ответа.
   * @throws «LLM не настроен…» / «LLM endpoint вернул N» / «LLM вернул пустой
   *   ответ» / сетевые ошибки и таймаут (LLM_TIMEOUT_MS, дефолт 15 с).
   */
  async function chat(messages: LlmMessage[]): Promise<string> {
    // Резолв на вызов: подмена глобального fetch/config после импорта видна.
    const doFetch = deps.fetchImpl ?? fetch;
    const cfg = (deps.config ?? config).llm;
    if (!cfg) throw new Error("LLM не настроен: нужны LLM_BASE_URL и LLM_MODEL");

    const response = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.3,
        max_tokens: cfg.maxTokens,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM endpoint вернул ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("LLM вернул пустой ответ");
    return text;
  }

  // Дешёвая проверка доступности: сначала GET /models (не тратит токены), при
  // отказе — минимальный chat/completions (не все провайдеры отдают /models).
  // Никогда не бросает: раздел health должен жить даже при мёртвом провайдере.
  /**
   * Проверка доступности LLM-провайдера для админ-маршрута (?section=health):
   * сначала GET /models, при отказе — минимальный POST /chat/completions.
   * Таймаут каждой пробы — 10 с; latencyMs считается по clock из deps.
   *
   * Не настроен (config.llm === null) — {ok:false, error:"не настроен"};
   * apiKey из конфига уходит как Bearer.
   *
   * @returns {Promise<LlmPing>} ok/latencyMs/detail при успехе, ok:false + error при отказе.
   */
  async function ping(): Promise<LlmPing> {
    // Резолв на вызов — по тем же причинам, что и в chat.
    const doFetch = deps.fetchImpl ?? fetch;
    const cfg = (deps.config ?? config).llm;
    if (!cfg) {
      return { ok: false, error: "не настроен: нужны LLM_BASE_URL и LLM_MODEL" };
    }
    const headers: Record<string, string> = cfg.apiKey
      ? { Authorization: `Bearer ${cfg.apiKey}` }
      : {};
    const startedAt = (deps.clock ?? Date.now)();

    try {
      const response = await doFetch(`${cfg.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(LLM_PING_TIMEOUT_MS),
      });
      if (response.ok) {
        return {
          ok: true,
          latencyMs: (deps.clock ?? Date.now)() - startedAt,
          detail: "GET /models",
        };
      }
    } catch {
      // /models может не существовать или провайдер лежит — пробуем сам endpoint.
    }

    try {
      const response = await doFetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        // max_tokens: 1 — ping не должен стоить генерации.
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(LLM_PING_TIMEOUT_MS),
      });
      if (response.ok) {
        return {
          ok: true,
          latencyMs: (deps.clock ?? Date.now)() - startedAt,
          detail: "POST /chat/completions (минимальный запрос)",
        };
      }
      // Только статус, без тела: в ответе провайдера могут быть служебные детали.
      return { ok: false, error: `endpoint вернул ${response.status}` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: reason };
    }
  }

  return { chat, ping };
}
