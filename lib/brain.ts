import process from "node:process";
import { KNOWLEDGE, type KnowledgeItem } from "./knowledge.js";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface BrainAnswer {
  text: string;
  /** 'llm' — ответила нейросеть, 'dumb' — локальный поиск по справке */
  mode: "llm" | "dumb";
}

const LLM_TIMEOUT_MS = 15_000;
const DUMB_SCORE_THRESHOLD = 0.2;

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

function systemPrompt(): string {
  const knowledge = KNOWLEDGE.map((item) => `## ${item.title}\n${item.text}`).join("\n\n");
  return [
    "Ты — дружелюбный ассистент-справка на сайте-визитке.",
    "Отвечай коротко, по-русски и только на основе справки ниже.",
    "Если ответа в справке нет — честно скажи об этом и предложи связаться с владельцем сайта напрямую.",
    "",
    "СПРАВКА:",
    knowledge,
  ].join("\n");
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
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
  for (const item of KNOWLEDGE) {
    const haystack = tokenize(`${item.title} ${item.text}`);
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    const score = hits / tokens.length;
    if (!best || score > best.score) best = { item, score };
  }

  if (!best || best.score < DUMB_SCORE_THRESHOLD) return FALLBACK_ANSWER;
  return best.item.text;
}

// ── Единая точка входа для вебчата и Telegram ──────────────────────

export async function answer(history: ChatMessage[]): Promise<BrainAnswer> {
  const question = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  try {
    return { text: await askLlm(history), mode: "llm" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[brain] LLM недоступен (${reason}), отвечаю в dumb-режиме`);
    return { text: dumbAnswer(question), mode: "dumb" };
  }
}
