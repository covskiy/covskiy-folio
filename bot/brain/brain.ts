import process from "node:process";
import { knowledgeEntries, systemPrompt, type KnowledgeItem } from "./prompt.js";
// Единое определение сообщения диалога живёт в store.ts — дублировать нельзя.
import type { ChatMessage } from "../store.js";

/**
 * Ответ «мозга» — единый формат для вебчата и Telegram.
 */
export interface BrainAnswer {
  /** Готовый к отправке текст ответа. */
  text: string;
  /** 'llm' — ответила нейросеть, 'dumb' — локальный поиск по справке */
  mode: "llm" | "dumb";
}

// Дефолт таймаута запроса к LLM. env LLM_TIMEOUT_MS (мс) переопределяет его
// на каждый вызов askLlm — как остальные LLM_* в llmConfig(): локальные модели
// с reasoning отвечают дольше прода, их лимит живёт в .env.local, не в коде.
// Мусор/ноль в env — снова дефолт (посетитель прод-сайта не должен ждать минуту).
const LLM_TIMEOUT_DEFAULT_MS = 15_000;

function llmTimeoutMs(): number {
  return Number(process.env.LLM_TIMEOUT_MS) || LLM_TIMEOUT_DEFAULT_MS;
}
const DUMB_SCORE_THRESHOLD = 0.2;

// Решение владельца: в промт идёт последние 10 сообщений диалога.
const HISTORY_WINDOW = 10;

const FALLBACK_ANSWER = [
  "Не нашёл точного ответа в справке. 🤔",
  "Попробуй спросить иначе или напиши владельцу сайта напрямую — контакты на странице «Контакты».",
].join("\n");

// ── LLM через OpenAI-совместимый endpoint (Ollama Cloud, llama.cpp, …) ──

interface LlmConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

function llmConfig(): LlmConfig | null {
  const baseUrl = process.env.LLM_BASE_URL?.trim().replace(/\/+$/, "");
  const model = process.env.LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: process.env.LLM_API_KEY?.trim() || undefined, model };
}

async function askLlm(history: ChatMessage[]): Promise<string> {
  const cfg = llmConfig();
  if (!cfg) throw new Error("LLM не настроен: нужны LLM_BASE_URL и LLM_MODEL");

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: systemPrompt() }, ...history],
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(llmTimeoutMs()),
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

// ── Health-check LLM для админ-маршрута ─────────────────────────────

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

const LLM_PING_TIMEOUT_MS = 10_000;

// Дешёвая проверка доступности: сначала GET /models (не тратит токены), при
// отказе — минимальный chat/completions (не все провайдеры отдают /models).
// Никогда не бросает: раздел health должен жить даже при мёртвом провайдере.
/**
 * Проверка доступности LLM-провайдера для админ-маршрута (?section=health):
 * сначала GET /models, при отказе — минимальный POST /chat/completions.
 * Таймаут каждой пробы — 10 с.
 *
 * Env: LLM_BASE_URL + LLM_MODEL (без них — {ok:false, error:"не настроен"}),
 * LLM_API_KEY (опционален, уходит как Bearer).
 *
 * Никогда не бросает — результат всегда объект LlmPing.
 * @returns {Promise<LlmPing>} ok/latencyMs/detail при успехе, ok:false + error при отказе.
 */
export async function pingLlm(): Promise<LlmPing> {
  const cfg = llmConfig();
  if (!cfg) {
    return { ok: false, error: "не настроен: нужны LLM_BASE_URL и LLM_MODEL" };
  }
  const headers: Record<string, string> = cfg.apiKey
    ? { Authorization: `Bearer ${cfg.apiKey}` }
    : {};
  const startedAt = Date.now();

  try {
    const response = await fetch(`${cfg.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(LLM_PING_TIMEOUT_MS),
    });
    if (response.ok) {
      return { ok: true, latencyMs: Date.now() - startedAt, detail: "GET /models" };
    }
  } catch {
    // /models может не существовать или провайдер лежит — пробуем сам endpoint.
  }

  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
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
        latencyMs: Date.now() - startedAt,
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

// ── Dumb-режим: поиск по справке без нейросети ─────────────────────

const STOP_WORDS = new Set([
  "как",
  "что",
  "для",
  "или",
  "это",
  "мне",
  "надо",
  "можно",
  "есть",
  "какой",
  "какая",
  "какие",
  "почему",
  "зачем",
  "когда",
  "где",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function dumbAnswer(question: string): string {
  const tokens = tokenize(question);
  if (tokens.length === 0) return FALLBACK_ANSWER;

  let best: { item: KnowledgeItem; score: number } | null = null;
  for (const item of knowledgeEntries()) {
    const haystack = tokenize(`${item.title} ${item.text}`);
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    const score = hits / tokens.length;
    if (!best || score > best.score) best = { item, score };
  }

  if (!best || best.score < DUMB_SCORE_THRESHOLD) return FALLBACK_ANSWER;
  return best.item.text;
}

// ── Единая точка входа для вебчата и Telegram ──────────────────────

/**
 * Отвечает на вопрос пользователя; единая точка входа для вебчата и Telegram.
 * Спрашивает LLM с system-промтом (lib/prompt.ts) и историей; при любой ошибке
 * (LLM не настроен, таймаут — env LLM_TIMEOUT_MS, дефолт 15 с, не-2xx, пустой
 * ответ) падает в dumb-режим —
 * поиск по справке без сети. Никогда не бросает.
 *
 * Env: LLM_BASE_URL + LLM_MODEL (для llm-режима; без них — сразу dumb),
 * LLM_API_KEY (опциональный Bearer).
 *
 * @param {string} question - Текущий вопрос пользователя.
 * @param {ChatMessage[]} [history=[]] - Предыдущие сообщения диалога (уже
 *   достанные из store); в промт идут последние 10. Telegram-обработчик пока
 *   зовёт answer(question) без неё, контекст туда подключит шаг 5 плана.
 * @returns {Promise<BrainAnswer>} Текст ответа и mode: 'llm' | 'dumb'.
 */
export async function answer(question: string, history: ChatMessage[] = []): Promise<BrainAnswer> {
  // question — текущий вопрос пользователя, history — предыдущие сообщения
  // диалога (уже достанные из store). История необязательна: Telegram-обработчик
  // пока зовёт answer(question) без неё, контекст туда подключит шаг 5 плана.

  const recent = history.slice(-HISTORY_WINDOW).map(({ role, content }) => ({ role, content }));
  try {
    return { text: await askLlm([...recent, { role: "user", content: question }]), mode: "llm" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[brain] LLM недоступен (${reason}), отвечаю в dumb-режиме`);
    // Dumb-режим работает по одному вопросу — историю игнорирует сознательно.
    return { text: dumbAnswer(question), mode: "dumb" };
  }
}
