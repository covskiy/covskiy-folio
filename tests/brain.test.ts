import { afterEach, describe, expect, it, vi } from "vitest";
import { answer } from "../lib/brain";

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

    const result = await answer([{ role: "user", content: "привет" }]);

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
    expect(body.messages[0].role).toBe("system");
    expect(body.messages.at(-1)?.content).toBe("привет");
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

    const result = await answer([{ role: "user", content: "как связаться?" }]);

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Telegram");
  });

  it("без LLM в env вообще → dumb-ответ по справке", async () => {
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");

    const result = await answer([{ role: "user", content: "расскажи про сайт" }]);

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Vite");
  });

  it("незнакомый вопрос → вежливый fallback, а не чужой параграф", async () => {
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");

    const result = await answer([{ role: "user", content: "когда запуск ракеты на марс?" }]);

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Не нашёл");
  });
});
