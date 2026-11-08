import { createLlm } from "../llm.js";
import { log as rootLog, type Logger } from "../log.js";
import { systemPrompt } from "./prompt.js";
import {
  knowledge as rootKnowledge,
  type KnowledgeItem,
  type KnowledgeStore,
} from "./knowledge.js";
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

const DUMB_SCORE_THRESHOLD = 0.2;

// Решение владельца: в промт идёт последние 10 сообщений диалога.
const HISTORY_WINDOW = 10;

const FALLBACK_ANSWER = [
  "Не нашёл точного ответа в справке. 🤔",
  "Попробуй спросить иначе или напиши владельцу сайта напрямую — контакты на странице «Контакты».",
].join("\n");

// Ответ при недоступной справке — это не dumb-fallback «не нашёл»: справка
// сломана целиком, и LLM сознательно не зовётся — без знаний он отвечал бы
// выдумками. Текст честно переносит контакт на владельца.
const UNAVAILABLE_ANSWER = [
  "Справка временно недоступна. 🛠",
  "Напиши владельцу напрямую — контакты на странице «Контакты».",
].join("\n");

/** Тип инстанса LLM-транспорта — структурная подмена в тестах. */
export type Llm = ReturnType<typeof createLlm>;

/**
 * Зависимости «мозга» — точки инъекции для тестов; в рантайме createBrain()
 * без аргументов (llm и log — дефолтные инстансы).
 */
export interface BrainDeps {
  /** Транспорт LLM; по умолчанию createLlm() (глобальный fetch + process.env). */
  llm?: Llm;
  /** Логгер деградаций; по умолчанию общий log из bot/log.ts. */
  log?: Logger;
  /** Хранилище справки; по умолчанию общий knowledge из brain/knowledge.ts. */
  knowledge?: KnowledgeStore;
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

function dumbAnswer(question: string, entries: KnowledgeItem[]): string {
  const tokens = tokenize(question);
  if (tokens.length === 0) return FALLBACK_ANSWER;

  let best: { item: KnowledgeItem; score: number } | null = null;
  for (const item of entries) {
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
 * Фабрика «мозга»: answer живёт в замыкании, llm/log — инъекции. Дефолтный
 * `answer = createBrain().answer` — точка импорта для вебчата и Telegram;
 * тесты подставляют фейковый llm вместо сети.
 * @param {BrainDeps} deps - Инъекции llm/log; без аргументов — дефолтные llm/log.
 * @returns Обработчик answer(question, history).
 */
export function createBrain(deps: BrainDeps = {}) {
  // Дефолты — ленивые инстансы рантайма; тесты приходят со своими через deps.
  const llm = deps.llm ?? createLlm();
  const log = deps.log ?? rootLog;
  const knowledge = deps.knowledge ?? rootKnowledge;

  /**
   * Отвечает на вопрос пользователя; единая точка входа для вебчата и Telegram.
   * Спрашивает LLM (bot/llm.ts) с system-промтом (prompt.ts) и историей; при
   * любой ошибке транспорта (LLM не настроен, таймаут, не-2xx, пустой ответ)
   * падает в dumb-режим — поиск по справке без сети. Если справка недоступна
   * (битый/отсутствующий knowledge.json) — безопасный текст без сети и без
   * вызова LLM. Никогда не бросает.
   *
   * Env (читает транспорт): LLM_BASE_URL + LLM_MODEL (для llm-режима; без них —
   * сразу dumb), LLM_API_KEY (опциональный Bearer), LLM_TIMEOUT_MS/LLM_MAX_TOKENS.
   *
   * @param {string} question - Текущий вопрос пользователя.
   * @param {ChatMessage[]} [history=[]] - Предыдущие сообщения диалога (уже
   *   достанные из store); в промт идут последние 10.
   * @returns {Promise<BrainAnswer>} Текст ответа и mode: 'llm' | 'dumb'.
   */
  async function answer(question: string, history: ChatMessage[] = []): Promise<BrainAnswer> {
    // question — текущий вопрос пользователя, history — предыдущие сообщения
    // диалога (уже достанные из store; оба канала передают её, см. вебчат и
    // bot/http/telegram-webhook.ts).

    // Справка — общий источник знаний обоих режимов. Недоступна целиком →
    // короткое замыкание до try: безопасный ответ, LLM не зовётся. Внутри
    // try после этого остаются только ошибки транспорта, поэтому
    // «LLM недоступен» в catch не врёт про причину.
    const entries = knowledge.load();
    if (!entries) return { text: UNAVAILABLE_ANSWER, mode: "dumb" };

    const recent = history.slice(-HISTORY_WINDOW).map(({ role, content }) => ({ role, content }));
    try {
      // System-промт ставит brain: транспорт не знает про prompt.ts.
      return {
        text: await llm.chat([
          { role: "system", content: systemPrompt(entries) },
          ...recent,
          { role: "user", content: question },
        ]),
        mode: "llm",
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("brain", `LLM недоступен (${reason}), отвечаю в dumb-режиме`);
      // Dumb-режим работает по одному вопросу — историю игнорирует сознательно.
      return { text: dumbAnswer(question, entries), mode: "dumb" };
    }
  }

  return { answer };
}

/**
 * Тип инстанса «мозга» — для фабрик, принимающих brain как зависимость:
 * структурная подмена в тестах без контрактов-файлов.
 */
export type Brain = ReturnType<typeof createBrain>;

export const answer = createBrain().answer;
