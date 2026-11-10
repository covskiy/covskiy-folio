import type { LlmProviderSettings } from "../config.js";
import type { LlmAdapter, LlmAdapterDeps, LlmMessage, LlmProbe } from "./types.js";

/**
 * OpenAI-совместимый адаптер: единственное место, где код ходит в
 * `${baseUrl}/chat/completions` и `${baseUrl}/models` (Ollama Cloud,
 * Cloudflare Workers AI, llama.cpp, любой совместимый endpoint).
 *
 * Никакой доменной логики: system-промт собирает brain (prompt.ts), сюда
 * приходит ГОТОВЫЙ массив сообщений и готовые настройки слота — парсинг env
 * остался в config.ts.
 *
 * `fetchImpl` лежит в deps и резолвится НА КАЖДЫЙ вызов, а не запоминается при
 * создании фабрики: подмена глобального fetch после import должна быть видна
 * (тот же принцип, что у redis-rest/telegram-api). Цепочка создаёт адаптер на
 * попытку с текущим deps.fetchImpl.
 *
 * Дублирование «fetch + timeout + JSON» с telegram-api и redis-rest оставлено
 * сознательно: у мест разная семантика ошибок (throw / ok:false / fail-open),
 * общий хелпер сделал бы хуже.
 */
export function createOpenAiAdapter(deps: LlmAdapterDeps = {}): LlmAdapter {
  /**
   * Запрос chat/completions.
   * @throws «LLM endpoint вернул N» / «LLM вернул пустой ответ» / сеть/таймаут.
   */
  async function chat(
    settings: LlmProviderSettings,
    messages: LlmMessage[],
    opts: { maxTokens: number; timeoutMs: number },
  ): Promise<string> {
    // Резолв на вызов: подмена глобального fetch после импорта видна.
    const doFetch = deps.fetchImpl ?? fetch;

    const response = await doFetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.3,
        max_tokens: opts.maxTokens,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
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
  async function probe(
    settings: LlmProviderSettings,
    opts: { timeoutMs: number },
  ): Promise<LlmProbe> {
    const doFetch = deps.fetchImpl ?? fetch;
    const headers: Record<string, string> = settings.apiKey
      ? { Authorization: `Bearer ${settings.apiKey}` }
      : {};

    try {
      const response = await doFetch(`${settings.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (response.ok) return { ok: true, detail: "GET /models" };
    } catch {
      // /models может не существовать или провайдер лежит — пробуем сам endpoint.
    }

    try {
      const response = await doFetch(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        // max_tokens: 1 — ping не должен стоить генерации.
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (response.ok) {
        return { ok: true, detail: "POST /chat/completions (минимальный запрос)" };
      }
      // Только статус, без тела: в ответе провайдера могут быть служебные детали.
      return { ok: false, error: `endpoint вернул ${response.status}` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: reason };
    }
  }

  return { chat, probe };
}
