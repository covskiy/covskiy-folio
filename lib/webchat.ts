import { answer, type ChatMessage } from "./brain.js";

const MAX_MESSAGES = 12;
const MAX_CONTENT_LENGTH = 2_000;

export async function handleWebChat(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({ ok: true, service: "webchat" });
  }
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const raw = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw)) {
    return Response.json({ ok: false, error: "Ожидался массив messages" }, { status: 400 });
  }

  const history: ChatMessage[] = [];
  for (const item of raw.slice(-MAX_MESSAGES)) {
    if (typeof item !== "object" || item === null) continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > MAX_CONTENT_LENGTH) continue;
    history.push({ role, content: trimmed });
  }

  if (history.length === 0) {
    return Response.json({ ok: false, error: "Пустая история" }, { status: 400 });
  }

  const { text, mode } = await answer(history);
  return Response.json({ ok: true, text, mode });
}
