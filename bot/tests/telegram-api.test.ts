import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "../telegram-api";

// Инъекции через env (config ленив и перечитывает env на каждый доступ) и
// vi.stubGlobal("fetch") — своей точки инъекции у telegram-api пока нет.
// Сети нет: каждый фетч — Response из JSON-строки.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("telegram-api: tgCall при ok:false", () => {
  it("flood-лимит: retry_after из parameters попадает в текст ошибки", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 5 },
        }),
      ),
    );

    await expect(sendMessage(42, "привет")).rejects.toThrow(
      "Telegram sendMessage failed: Too Many Requests (retry_after: 5s)",
    );
  });

  it("без parameters — текст ошибки как раньше, без хвоста retry_after", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ ok: false, description: "Bad Request: chat not found" })),
    );

    await expect(sendMessage(42, "привет")).rejects.toThrow(
      "Telegram sendMessage failed: Bad Request: chat not found",
    );
  });
});
