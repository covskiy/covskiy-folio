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

// Чипсы-подсказки приходят с GET /api/chat при разворачивании виджета.
/**
 * Загрузить чипсы-подсказки с GET /api/chat.
 * @returns {Promise<ChatChip[]>} Валидные чипы; [] при не-2xx, битом ответе или
 *   ошибке сети — не бросает.
 */
export async function fetchChips(): Promise<ChatChip[]> {
  const response = await fetch("/api/chat");
  if (!response.ok) return [];
  const data = (await response.json()) as { chips?: unknown };
  if (!Array.isArray(data.chips)) return [];
  return data.chips.filter(
    (chip): chip is ChatChip =>
      typeof chip === "object" && chip !== null && typeof (chip as ChatChip).title === "string",
  );
}

/**
 * Отправить вопрос в чат: POST /api/chat {sessionId, text}.
 * @param {string} sessionId - Идентификатор сессии (см. getSessionId/renewSessionId).
 * @param {string} text - Текст вопроса (клиент ограничен 2000 символами —
 *   maxlength инпута виджета).
 * @returns {Promise<{text: string, mode: "llm"|"dumb"}>} Текст ответа и режим:
 *   'dumb' — офлайн-справка без нейросети.
 * @throws {Error} Не-2xx ответ API или пустой text в ответе.
 */
export async function askChat(
  sessionId: string,
  text: string,
): Promise<{ text: string; mode: "llm" | "dumb" }> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  if (!response.ok) throw new Error(`API ответил ${response.status}`);

  const data = (await response.json()) as { text?: unknown; mode?: unknown };
  if (typeof data.text !== "string" || !data.text) throw new Error("Пустой ответ API");
  return { text: data.text, mode: data.mode === "dumb" ? "dumb" : "llm" };
}
