import { createLlm } from "../llm.js";
import { log as rootLog, type Logger } from "../log.js";
// Управляющие ручки (окно истории, порог dumb-ответа) — env-слайс brain из config.
import { config } from "../config.js";
import { systemPrompt } from "./prompt.js";
import { rankKnowledge, type SearchHit } from "./search.js";
import {
  knowledge as rootKnowledge,
  uiTopics,
  type KnowledgeItem,
  type KnowledgeStore,
} from "./knowledge.js";
// Единое определение сообщения диалога живёт в store.ts — дублировать нельзя.
import type { ChatMessage } from "../store.js";

/**
 * Подсказка следующего вопроса в dumb-fallback: id нужен Telegram для
 * callback_data (`ask:{id}`), title — текст кнопки/чипа вебчата.
 */
export interface BrainSuggestion {
  id: string;
  title: string;
}

/**
 * Ответ «мозга» — единый формат для вебчата и Telegram.
 */
export interface BrainAnswer {
  /** Готовый к отправке текст ответа. */
  text: string;
  /** 'llm' — ответила нейросеть, 'dumb' — локальный поиск по справке */
  mode: "llm" | "dumb";
  /** Варианты следующего вопроса; только для dumb-fallback (см. pickSuggestions). */
  suggestions?: BrainSuggestion[];
}

// Порог уверенности dumb-ответа — env DUMB_SCORE_THRESHOLD (дефолт 0.3,
// слайс brain в config.ts). Политика brain, не поиска: rankKnowledge возвращает
// все попадания, здесь решаем, какое считать ответом, а не подсказкой.

// Максимум подсказок dumb-fallback — рядом с порогом: обе величины из одного
// решения о качестве dumb-режима (см. tasks/04-dumb-mode-search-and-offline-help.md, §7).
const DUMB_SUGGESTIONS_LIMIT = 3;

// Dumb-ответ начинается с заголовка записи: без него «Пять направлений:…»
// непонятно, о чём ответ. Plain text: и Telegram, и вебчат рендерят его как есть.
function formatHit(item: KnowledgeItem): string {
  return `${item.title}\n\n${item.text}`;
}

// Решение владельца: в промт идут последние N сообщений диалога — env
// HISTORY_WINDOW (дефолт 10, слайс brain в config.ts).

// Два варианта fallback, выбор по наличию подсказок: строка «контакты на
// странице Контакты» ушла из текста — контакт гарантируется подсказкой
// (запись с contact: true всегда попадает в suggestions, см. pickSuggestions).
const FALLBACK_WITH_SUGGESTIONS = [
  "Не нашёл точного ответа в справке. 🤔",
  "Попробуй спросить иначе или выбери тему ниже.",
].join("\n");

const FALLBACK_PLAIN = ["Не нашёл точного ответа в справке. 🤔", "Попробуй спросить иначе."].join(
  "\n",
);

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
 * без аргументов (llm, log, search и knowledge — дефолтные инстансы).
 */
export interface BrainDeps {
  /** Транспорт LLM; по умолчанию createLlm() (глобальный fetch + process.env). */
  llm?: Llm;
  /** Логгер деградаций; по умолчанию общий log из bot/log.ts. */
  log?: Logger;
  /** Хранилище справки; по умолчанию общий knowledge из brain/knowledge.ts. */
  knowledge?: KnowledgeStore;
  /** Сборщик system-промта; по умолчанию systemPrompt из brain/prompt.ts. */
  prompt?: typeof systemPrompt;
  /** Поиск по справке; по умолчанию rankKnowledge из brain/search.ts. */
  search?: typeof rankKnowledge;
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
  const promptFn = deps.prompt ?? systemPrompt;
  const search = deps.search ?? rankKnowledge;

  // Подсказки dumb-fallback — «что спросить дальше»: до 2 near-miss (лучшие
  // попадания ниже порога), затем гарантированный контакт (запись с
  // contact: true), затем темы uiTopics добивают список до лимита. Пул собирается
  // с повторами сознательно: дедупликация по id — единая точка контракта «максимум
  // 3 уникальных» (near-miss легко совпадает с contact или темой). Подсказки —
  // UI-слой: вопрос и история не нужны, knowledge берётся из замыкания deps.
  function pickSuggestions(hits: SearchHit[], entries: KnowledgeItem[]): BrainSuggestion[] {
    const near = hits
      .filter((hit) => hit.score < config.brain.dumbScoreThreshold)
      .slice(0, 2)
      .map((hit) => hit.item);

    const contact = entries.find((item) => item.contact === true);
    const pool = [
      ...near,
      ...(contact ? [contact] : []),
      ...uiTopics(knowledge, DUMB_SUGGESTIONS_LIMIT),
    ];

    const seen = new Set<string>();
    const unique: KnowledgeItem[] = [];
    for (const item of pool) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      unique.push(item);
    }

    return unique.slice(0, DUMB_SUGGESTIONS_LIMIT).map(({ id, title }) => ({ id, title }));
  }

  /**
   * Отвечает на вопрос пользователя; единая точка входа для вебчата и Telegram.
   * Спрашивает LLM (bot/llm.ts) с system-промтом (prompt.ts) и историей; при
   * любой ошибке транспорта (LLM не настроен, таймаут, не-2xx, пустой ответ)
   * падает в dumb-режим — поиск по справке без сети. Ошибка сборки промта
   * (битый {{KNOWLEDGE}} в md) — отдельная деградация с честным логом: промт
   * собирается в собственном try до вызова LLM, чтобы причина не маскировалась
   * под «LLM недоступен» — при ней LLM никто не вызывал. Если справка недоступна
   * (битый/отсутствующий knowledge.json) — безопасный текст без сети и без
   * вызова LLM. Никогда не бросает.
   *
   * Env (читает транспорт): LLM_BASE_URL + LLM_MODEL (для llm-режима; без них —
   * сразу dumb), LLM_API_KEY (опциональный Bearer), LLM_TIMEOUT_MS/LLM_MAX_TOKENS.
   * Свои ручки — env HISTORY_WINDOW (реплик истории в промте) и
   * DUMB_SCORE_THRESHOLD (порог уверенности dumb-ответа), слайс brain в config.
   *
   * @param {string} question - Текущий вопрос пользователя.
   * @param {ChatMessage[]} [history=[]] - Предыдущие сообщения диалога (уже
   *   достанные из store); в промт идут последние HISTORY_WINDOW (дефолт 10).
   * @returns {Promise<BrainAnswer>} Текст ответа и mode: 'llm' | 'dumb'; для
   *   dumb-fallback — ещё suggestions (подсказки следующего вопроса), у остальных
   *   режимов поля нет.
   */
  async function answer(question: string, history: ChatMessage[] = []): Promise<BrainAnswer> {
    // question — текущий вопрос пользователя, history — предыдущие сообщения
    // диалога (уже достанные из store; оба канала передают её, см. вебчат и
    // bot/http/telegram-webhook.ts).

    // Справка — общий источник знаний обоих режимов. Недоступна целиком →
    // короткое замыкание до try: безопасный ответ, LLM не зовётся.
    const entries = knowledge.load();
    if (!entries) return { text: UNAVAILABLE_ANSWER, mode: "dumb" };

    // Dumb-путь общий для обеих деградаций ниже: работает по одному вопросу —
    // историю игнорирует сознательно. Сам алгоритм ранжирования живёт в
    // brain/search.ts; brain решает только, уверенное ли попадание (порог)
    // и что отдать вместо промаха. Подсказки — только у fallback: уверенный
    // dumb-ответ вопрос уже решил, а UNAVAILABLE_ANSWER означает, что справки
    // нет вовсе и подсказки брать неоткуда.
    function dumbAnswer(entries: KnowledgeItem[]): BrainAnswer {
      const hits: SearchHit[] = search(question, entries);
      const best = hits[0];
      if (best && best.score >= config.brain.dumbScoreThreshold) {
        return { text: formatHit(best.item), mode: "dumb" };
      }
      const suggestions = pickSuggestions(hits, entries);
      return {
        text: suggestions.length > 0 ? FALLBACK_WITH_SUGGESTIONS : FALLBACK_PLAIN,
        mode: "dumb",
        ...(suggestions.length > 0 ? { suggestions } : {}),
      };
    }

    // Сборка промта — отдельно от try транспорта: systemPrompt() валидирует
    // {{KNOWLEDGE}} и бросает при сломанных md. Иначе ошибка контента ловилась
    // бы catch'ем транспорта и логировалась как «LLM недоступен» — ложная
    // атрибуция, уводящая диагностику не туда (см. tasks/04, §5).
    let prompt: string;
    try {
      prompt = promptFn(entries);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("brain", `system-промт не собран (${reason}), отвечаю в dumb-режиме`);
      return dumbAnswer(entries);
    }

    // System-промт ставит brain: транспорт не знает про prompt.ts. В этом try
    // остаются только ошибки транспорта — «LLM недоступен» в catch говорит
    // ровно то, что случилось.
    const recent = history
      .slice(-config.brain.historyWindow)
      .map(({ role, content }) => ({ role, content }));
    try {
      return {
        text: await llm.chat([
          { role: "system", content: prompt },
          ...recent,
          { role: "user", content: question },
        ]),
        mode: "llm",
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("brain", `LLM недоступен (${reason}), отвечаю в dumb-режиме`);
      return dumbAnswer(entries);
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
