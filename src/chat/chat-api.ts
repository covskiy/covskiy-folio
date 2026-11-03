export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Только у ответов: каким способом получен ('llm' — нейросеть, 'dumb' — офлайн-справка) */
  mode?: "llm" | "dumb";
}

const STORAGE_KEY = "covskiy-folio:chat-history";
const MAX_SENT_MESSAGES = 8;
const MAX_STORED_MESSAGES = 50;

export function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
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

export function saveHistory(history: ChatMessage[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_STORED_MESSAGES)));
  } catch {
    // приватный режим браузера или переполнение квоты — некритично
  }
}

export async function askChat(
  history: ChatMessage[],
): Promise<{ text: string; mode: "llm" | "dumb" }> {
  // Контекст диалога несёт клиент: отправляем последние сообщения
  const messages = history
    .slice(-MAX_SENT_MESSAGES)
    .map(({ role, content }) => ({ role, content }));

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!response.ok) throw new Error(`API ответил ${response.status}`);

  const data = (await response.json()) as { text?: unknown; mode?: unknown };
  if (typeof data.text !== "string" || !data.text) throw new Error("Пустой ответ API");
  return { text: data.text, mode: data.mode === "dumb" ? "dumb" : "llm" };
}
