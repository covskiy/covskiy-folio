import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebChat } from "../http/webchat";
import { knowledgeEntries } from "../brain/prompt";

const URL = "http://localhost/api/chat";
const SESSION_ID = "3f2a9c8e-1b4d-4e6f-9a7b-2c5d8e0f1a2b";

function post(body: unknown): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Подменяет глобальный fetch: вызовы в Upstash REST обслуживаются локальной
 * Map-« Redis» (get/set), вызовы в LLM — фиксированным ответом.
 */
function stubRedisAndLlm(llmText: string): {
  fetchMock: ReturnType<typeof vi.fn>;
  store: Map<string, string>;
} {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
  vi.stubEnv("LLM_MODEL", "test-model");
  const store = new Map<string, string>();
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://upstash.test") {
      const command = JSON.parse(String(init?.body)) as string[];
      if (command[0] === "get") {
        return new Response(JSON.stringify({ result: store.get(command[1]) ?? null }));
      }
      if (command[0] === "set") {
        store.set(command[1], String(command[2]));
        return new Response(JSON.stringify({ result: "OK" }));
      }
      throw new Error(`неожиданная команда Redis: ${command[0]}`);
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: llmText } }] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, store };
}

interface LlmRequestBody {
  messages: Array<{ role: string; content: string }>;
}

// Последний вызов fetch — это запись истории в Redis (appendHistory идёт после
// brain.answer), поэтому вызовы LLM отбираем по URL, а не по порядку.
function lastLlmBody(fetchMock: ReturnType<typeof vi.fn>): LlmRequestBody {
  const llmCall = fetchMock.mock.calls.findLast(
    ([input]) => String(input) === "http://127.0.0.1:9999/v1/chat/completions",
  ) as [unknown, RequestInit];
  return JSON.parse(String(llmCall[1]?.body)) as LlmRequestBody;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("handleWebChat: GET", () => {
  it("возвращает service и первые 3 чипса из справки", async () => {
    const res = await handleWebChat(new Request(URL));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "webchat",
      chips: knowledgeEntries()
        .slice(0, 3)
        .map((item) => ({ title: item.title })),
    });
  });
});

describe("handleWebChat: POST", () => {
  it("чужой HTTP-метод → 405", async () => {
    const res = await handleWebChat(new Request(URL, { method: "PUT" }));
    expect(res.status).toBe(405);
  });

  it("битый JSON → 400", async () => {
    const res = await handleWebChat(post("{oops"));
    expect(res.status).toBe(400);
  });

  it("sessionId не проходит паттерн (короткий / чужие символы) → 400", async () => {
    stubRedisAndLlm("ок");
    for (const bad of ["abc", "с пробелом!!", "", 42, null]) {
      const res = await handleWebChat(post({ sessionId: bad, text: "вопрос" }));
      expect(res.status).toBe(400);
    }
  });

  it("пустой или слишком длинный text → 400", async () => {
    stubRedisAndLlm("ок");
    for (const bad of ["", "   \n", "x".repeat(2001), 42]) {
      const res = await handleWebChat(post({ sessionId: SESSION_ID, text: bad }));
      expect(res.status).toBe(400);
    }
  });

  it("валидный вопрос → {ok, text, mode} от brain", async () => {
    stubRedisAndLlm("Ответ ассистента");
    const res = await handleWebChat(post({ sessionId: SESSION_ID, text: "  вопрос  " }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      text: "Ответ ассистента",
      mode: "llm",
    });
  });

  it("вопрос уходит в LLM без истории и пара вопрос/ответ сохраняется в Redis", async () => {
    const { fetchMock, store } = stubRedisAndLlm("Ответ");
    await handleWebChat(post({ sessionId: SESSION_ID, text: "первый вопрос" }));

    const body = lastLlmBody(fetchMock);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages.at(-1)).toMatchObject({ role: "user", content: "первый вопрос" });

    const saved = JSON.parse(store.get(`chat:web:${SESSION_ID}`) ?? "[]") as Array<{
      role: string;
      content: string;
    }>;
    expect(saved).toEqual([
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "Ответ" },
    ]);
  });

  it("второй вопрос того же sessionId уходит в LLM вместе с историей", async () => {
    const { fetchMock, store } = stubRedisAndLlm("Ответ");
    await handleWebChat(post({ sessionId: SESSION_ID, text: "первый вопрос" }));
    await handleWebChat(post({ sessionId: SESSION_ID, text: "второй вопрос" }));

    const body = lastLlmBody(fetchMock);
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "Ответ" },
      { role: "user", content: "второй вопрос" },
    ]);
    expect(store.get(`chat:web:${SESSION_ID}`)).toBeDefined();
  });

  it("text ровно 2000 символов (граница лимита) проходит", async () => {
    stubRedisAndLlm("Ответ");
    const res = await handleWebChat(post({ sessionId: SESSION_ID, text: "x".repeat(2_000) }));
    expect(res.status).toBe(200);
  });
});

describe("handleWebChat: fail-open (Upstash задан, но REST всегда падает)", () => {
  it("REST падает исключением — вебчат всё равно отвечает ответом LLM, 200 ok", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === "http://upstash.test") {
        throw new Error("ECONNREFUSED");
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Ответ" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleWebChat(post({ sessionId: SESSION_ID, text: "вопрос" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, text: "Ответ", mode: "llm" });
    // LLM вызван, несмотря на два упавших обращения к Redis (get + set)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("chat/completions"))).toBe(
      true,
    );
  });
});
