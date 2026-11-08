// История диалога живёт на сервере (Redis, ключ по sessionId) — клиент шлёт
// только {sessionId, text}. В localStorage хранится один sessionId, чтобы
// контекст переживал перезагрузку страницы (серверный TTL — 24 часа).

/**
 * Чип-подсказка виджета — тема из справки сайта.
 */
export interface ChatChip {
  /** Текст чипа; при клике отправляется как готовый вопрос. */
  title: string;
}

/**
 * Бутстрап виджета из GET /api/chat: чипсы-темы и текст помощи (кнопка «?»).
 */
export interface ChatBootstrap {
  chips: ChatChip[];
  help: string;
}

/**
 * Результат POST /api/chat: text и mode всегда; suggestions прилагает сервер
 * только к dumb-fallback (подсказки следующего вопроса).
 */
export interface AskChatResult {
  text: string;
  mode: "llm" | "dumb";
  suggestions?: ChatChip[];
}

const SESSION_KEY = "covskiy-folio:chat-session-id";

/**
 * Идентификатор сессии чата: берётся из localStorage, при отсутствии —
 * создаётся uuid и сохраняется туда. Ключ истории диалога живёт на сервере,
 * клиент шлёт только sessionId.
 * @returns {string} Стабильный в рамках браузера sessionId (переживает перезагрузку;
 *   недоступный localStorage — id живёт до перезагрузки страницы).
 */
export function getSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
  } catch {
    // приватный режим браузера — id просто проживёт до перезагрузки страницы
  }
  return storeSessionId(crypto.randomUUID());
}

// «Новый диалог»: новый sessionId — старый ключ Redis истечёт по TTL сам.
/**
 * «Новый диалог»: сохраняет свежий uuid вместо старого sessionId, после чего
 * сервер начнёт новую историю (старый ключ Redis истечёт по TTL сам).
 * @returns {string} Новый sessionId.
 */
export function renewSessionId(): string {
  return storeSessionId(crypto.randomUUID());
}

function storeSessionId(id: string): string {
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    // переполнение квоты или приватный режим — некритично
  }
  return id;
}

// Валидатор чипа: ответ сервера — недоверенные данные, форма {title: string}
// проверяется до использования (рендер и так через textContent).
function isChatChip(chip: unknown): chip is ChatChip {
  return typeof chip === "object" && chip !== null && typeof (chip as ChatChip).title === "string";
}

// Чипсы и подсказки dumb-fallback рендерятся одним рядом — лимит один и тот же,
// зеркалит DUMB_SUGGESTIONS_LIMIT на сервере (bot/brain/brain.ts).
const MAX_SUGGESTIONS = 3;

// Бутстрап (чипсы + help) грузится один раз за жизнь страницы — виджет
// переиспользует его для первого разворачивания, «нового диалога», кнопки «?»
// и локальных команд.
/**
 * Загрузить бутстрап виджета с GET /api/chat: чипсы-подсказки и текст помощи.
 * @returns {Promise<ChatBootstrap>} Валидированные чипы и строка help; ошибка
 *   сети, не-2xx или битый ответ → { chips: [], help: "" } — не бросает.
 */
export async function fetchChatBootstrap(): Promise<ChatBootstrap> {
  try {
    const response = await fetch("/api/chat");
    if (!response.ok) return { chips: [], help: "" };
    const data = (await response.json()) as { chips?: unknown; help?: unknown };
    return {
      chips: Array.isArray(data.chips) ? data.chips.filter(isChatChip) : [],
      // help — статический текст сервера; пустой/нестроковый → "" : виджет
      // подставит свой запасной текст (HELP_TEXT_WEBCHAT_FALLBACK).
      help: typeof data.help === "string" ? data.help : "",
    };
  } catch {
    return { chips: [], help: "" };
  }
}

/**
 * Отправить вопрос в чат: POST /api/chat {sessionId, text}.
 * @param {string} sessionId - Идентификатор сессии (см. getSessionId/renewSessionId).
 * @param {string} text - Текст вопроса (клиент ограничен 2000 символами —
 *   maxlength инпута виджета).
 * @returns {Promise<AskChatResult>} Текст ответа, режим ('dumb' — офлайн-справка
 *   без нейросети) и suggestions для dumb-fallback: валидированные чипы, максимум
 *   3; поля нет, если сервер подсказок не вернул.
 * @throws {Error} Не-2xx ответ API или пустой text в ответе.
 */
export async function askChat(sessionId: string, text: string): Promise<AskChatResult> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  if (!response.ok) throw new Error(`API ответил ${response.status}`);

  const data = (await response.json()) as {
    text?: unknown;
    mode?: unknown;
    suggestions?: unknown;
  };
  if (typeof data.text !== "string" || !data.text) throw new Error("Пустой ответ API");
  // Поле отсутствует / не массив → подсказок нет: пустой массив из сервера
  // тоже не рисуем, чтобы виджет не показывал пустой ряд.
  const suggestions = Array.isArray(data.suggestions)
    ? data.suggestions.filter(isChatChip).slice(0, MAX_SUGGESTIONS)
    : undefined;
  return {
    text: data.text,
    mode: data.mode === "dumb" ? "dumb" : "llm",
    ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
  };
}
