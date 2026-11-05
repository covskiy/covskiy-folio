import { afterEach, describe, expect, it, vi } from "vitest";
import { answer } from "../lib/brain";
import type { ChatMessage } from "../lib/store";

function llmResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("answer: LLM-ветка", () => {
  it("ходит в ${LLM_BASE_URL}/chat/completions с Bearer и моделью", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_API_KEY", "secret-key");
    vi.stubEnv("LLM_MODEL", "test-model");
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      llmResponse("Ответ от LLM"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await answer("привет");

    expect(result).toEqual({ text: "Ответ от LLM", mode: "llm" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9999/v1/chat/completions");
    const headers = (requestInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(String(requestInit?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("test-model");
    // Без истории: system + сам вопрос
    expect(body.messages[0].role).toBe("system");
    expect(body.messages).toHaveLength(2);
    expect(body.messages.at(-1)?.content).toBe("привет");
  });

  it("история: последние 10 сообщений вставляются перед текущим вопросом", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => llmResponse("Ок"));
    vi.stubGlobal("fetch", fetchMock);

    const history = Array.from({ length: 14 }, (_, i): ChatMessage => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `сообщение ${i}`,
    }));
    await answer("текущий вопрос", history);

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(requestInit?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    // system + 10 сообщений истории + вопрос
    expect(body.messages).toHaveLength(12);
    expect(body.messages[1]).toMatchObject({ content: "сообщение 4" });
    expect(body.messages[10]).toMatchObject({ content: "сообщение 13" });
    expect(body.messages[11]).toMatchObject({ role: "user", content: "текущий вопрос" });
  });
});

describe("answer: таймаут LLM_TIMEOUT_MS", () => {
  it("env LLM_TIMEOUT_MS перекрывает дефолт: ответ дольше лимита → dumb", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    vi.stubEnv("LLM_TIMEOUT_MS", "10");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        // Мок уважает signal, как реальный fetch — иначе AbortSignal.timeout
        // в brain не протестировать.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("The operation was aborted"));
          });
        });
        return llmResponse("поздно");
      }),
    );

    const result = await answer("вопрос");

    expect(result.mode).toBe("dumb");
  });

  it("мусор в env LLM_TIMEOUT_MS → работает дефолт 15 с", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    vi.stubEnv("LLM_TIMEOUT_MS", "не-число");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return llmResponse("успел");
      }),
    );

    const result = await answer("вопрос");

    expect(result.mode).toBe("llm");
  });
});

describe("answer: dumb-режим (fallback)", () => {
  it("ошибка LLM-endpoint → поиск по справке", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    const result = await answer("как связаться?");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Telegram");
  });

  it("без LLM в env вообще → dumb-ответ по справке", async () => {
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");

    const result = await answer("расскажи про сайт");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Vite");
  });

  it("незнакомый вопрос → вежливый fallback, а не чужой параграф", async () => {
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");

    const result = await answer("когда запуск ракеты на марс?");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Не нашёл");
  });
});
