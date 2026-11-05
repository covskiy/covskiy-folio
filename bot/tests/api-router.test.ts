import { afterEach, describe, expect, it, vi } from "vitest";
import bot from "../../api/bot";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("роутер api/bot (единая функция)", () => {
  it("неизвестный путь → 404", async () => {
    const res = await bot.fetch(new Request("http://localhost/api/other"));
    expect(res.status).toBe(404);
  });

  it("/api/chat прокидывается в вебчат", async () => {
    const res = await bot.fetch(new Request("http://localhost/api/chat"));
    await expect(res.json()).resolves.toMatchObject({ service: "webchat" });
  });

  it("/api/telegram прокидывается в webhook (без секрета → 401)", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s");
    const res = await bot.fetch(
      new Request("http://localhost/api/telegram", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  it("/api/telegram-setup прокидывается в админ-маршрут (без секрета → 404)", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s");
    const res = await bot.fetch(new Request("http://localhost/api/telegram-setup"));
    expect(res.status).toBe(404);
  });
});
