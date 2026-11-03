import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebChat } from "../lib/webchat";

const URL = "http://localhost/api/chat";

function post(body: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function stubLlmReturning(text: string): void {
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
  vi.stubEnv("LLM_MODEL", "test-model");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("handleWebChat", () => {
  it("GET — smoke-проверка живости", async () => {
    const res = await handleWebChat(new Request(URL));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, service: "webchat" });
  });

  it("чужой HTTP-метод → 405", async () => {
    const res = await handleWebChat(new Request(URL, { method: "PUT" }));
    expect(res.status).toBe(405);
  });

  it("битый JSON → 400", async () => {
    const res = await handleWebChat(post("{oops"));
    expect(res.status).toBe(400);
  });

  it("messages не массив → 400", async () => {
    const res = await handleWebChat(post(JSON.stringify({ messages: "привет" })));
    expect(res.status).toBe(400);
  });

  it("сообщения с чужими ролями отфильтровываются → 400", async () => {
    const res = await handleWebChat(
      post(JSON.stringify({ messages: [{ role: "system", content: "взлом" }] })),
    );
    expect(res.status).toBe(400);
  });

  it("валидный вопрос → {ok, text, mode} от brain", async () => {
    stubLlmReturning("Ответ ассистента");
    const res = await handleWebChat(
      post(JSON.stringify({ messages: [{ role: "user", content: "вопрос" }] })),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      text: "Ответ ассистента",
      mode: "llm",
    });
  });

  it("история обрезается до последних сообщений (без system-промпта)", async () => {
    stubLlmReturning("Ок");
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: "user",
      content: `сообщение ${i}`,
    }));
    await handleWebChat(post(JSON.stringify({ messages })));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const history = body.messages.filter((m) => m.role !== "system");
    expect(history.length).toBeLessThanOrEqual(12);
    expect(history.at(-1)).toMatchObject({ content: "сообщение 29" });
  });
});
