import { describe, expect, it, vi } from "vitest";
import { createTelegramApi } from "../telegram-api";
import { createConfig } from "../config";

// Инъекции через фабрику (createTelegramApi({ fetchImpl, config })): env и
// глобальный fetch не трогаем. Сети нет: каждый фетч — Response из JSON-строки.
const apiConfig = createConfig({ TELEGRAM_BOT_TOKEN: "test-token" });

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("telegram-api: tgCall при ok:false", () => {
  it("flood-лимит: retry_after из parameters попадает в текст ошибки", async () => {
    const api = createTelegramApi({
      config: apiConfig,
      fetchImpl: vi.fn(async () =>
        okResponse({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 5 },
        }),
      ),
    });

    await expect(api.sendMessage(42, "привет")).rejects.toThrow(
      "Telegram sendMessage failed: Too Many Requests (retry_after: 5s)",
    );
  });

  it("без parameters — текст ошибки как раньше, без хвоста retry_after", async () => {
    const api = createTelegramApi({
      config: apiConfig,
      fetchImpl: vi.fn(async () =>
        okResponse({ ok: false, description: "Bad Request: chat not found" }),
      ),
    });

    await expect(api.sendMessage(42, "привет")).rejects.toThrow(
      "Telegram sendMessage failed: Bad Request: chat not found",
    );
  });

  it("fetchImpl резолвится на вызов: подмена deps после создания видна", async () => {
    const first = vi.fn(async () =>
      okResponse({ ok: true, result: { message_id: 1, chat: { id: 42 } } }),
    );
    // fetchImpl аннотирован: иначе deps запечёт сигнатуру first и подмену
    // вторым моком (с другим числом параметров) typecheck не пропустит.
    const deps: { config: typeof apiConfig; fetchImpl: typeof fetch } = {
      config: apiConfig,
      fetchImpl: first,
    };
    const api = createTelegramApi(deps);

    await api.sendMessage(42, "раз");
    expect(first).toHaveBeenCalledOnce();

    // Меняем свойство deps ПОСЛЕ создания инстанса — второй вызов обязан уйти
    // в новый фетч (гарантия «не запёкся при создании»).
    const second = vi.fn(async (_url: string | URL | Request) =>
      okResponse({ ok: true, result: { message_id: 2, chat: { id: 42 } } }),
    );
    deps.fetchImpl = second;

    await api.sendMessage(42, "два");
    expect(second).toHaveBeenCalledOnce();
    expect(second.mock.calls[0][0]).toContain("/bottest-token/sendMessage");
  });

  it("без токена в config — rejects «TELEGRAM_BOT_TOKEN не задан»", async () => {
    const api = createTelegramApi({
      config: createConfig({}),
      fetchImpl: vi.fn(async () => okResponse({ ok: true, result: true })),
    });

    await expect(api.sendMessage(42, "привет")).rejects.toThrow("TELEGRAM_BOT_TOKEN не задан");
  });
});
