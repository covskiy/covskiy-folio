import { beforeEach, describe, expect, it, vi } from "vitest";
import bot from "../../api/bot";

// api/bot.ts жёстко импортирует дефолтные обработчики, поэтому роутинг
// тестируется через vi.mock: фабрики-моки возвращают фейковые async-функции,
// фиксирующие вызов, — проверки pathname → хендлер и 404 остаются те же.
const handlers = vi.hoisted(() => {
  const marker = (name: string) => async (request: Request) =>
    Response.json({ handler: name, url: request.url });
  return {
    webChat: vi.fn(marker("webchat")),
    telegramWebhook: vi.fn(marker("telegram")),
    telegramAdmin: vi.fn(marker("admin")),
  };
});

// Логгер мокается: проверяем запись об ошибке роутера и не сыплем console.error в вывод тестов.
const logFakes = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  warnThrottled: vi.fn(),
}));

vi.mock("../http/webchat.js", () => ({ handleWebChat: handlers.webChat }));
vi.mock("../http/telegram-webhook.js", () => ({
  handleTelegramWebhook: handlers.telegramWebhook,
}));
vi.mock("../http/telegram-admin.js", () => ({ handleTelegramAdmin: handlers.telegramAdmin }));
vi.mock("../log.js", () => ({ log: logFakes }));

beforeEach(() => {
  handlers.webChat.mockClear();
  handlers.telegramWebhook.mockClear();
  handlers.telegramAdmin.mockClear();
  logFakes.error.mockClear();
});

describe("роутер api/bot (единая функция)", () => {
  it("неизвестный путь → 404, обработчики не вызываются", async () => {
    const res = await bot.fetch(new Request("http://localhost/api/other"));
    expect(res.status).toBe(404);
    expect(handlers.webChat).not.toHaveBeenCalled();
    expect(handlers.telegramWebhook).not.toHaveBeenCalled();
    expect(handlers.telegramAdmin).not.toHaveBeenCalled();
  });

  it("/api/chat прокидывается в вебчат", async () => {
    const request = new Request("http://localhost/api/chat");
    const res = await bot.fetch(request);
    await expect(res.json()).resolves.toEqual({
      handler: "webchat",
      url: "http://localhost/api/chat",
    });
    expect(handlers.webChat).toHaveBeenCalledTimes(1);
    expect(handlers.webChat).toHaveBeenCalledWith(request);
  });

  it("/api/telegram прокидывается в webhook", async () => {
    const request = new Request("http://localhost/api/telegram", { method: "POST", body: "{}" });
    const res = await bot.fetch(request);
    await expect(res.json()).resolves.toMatchObject({ handler: "telegram" });
    expect(handlers.telegramWebhook).toHaveBeenCalledTimes(1);
    expect(handlers.telegramWebhook).toHaveBeenCalledWith(request);
  });

  it("/api/telegram-setup прокидывается в админ-маршрут", async () => {
    const request = new Request("http://localhost/api/telegram-setup");
    const res = await bot.fetch(request);
    await expect(res.json()).resolves.toMatchObject({ handler: "admin" });
    expect(handlers.telegramAdmin).toHaveBeenCalledTimes(1);
    expect(handlers.telegramAdmin).toHaveBeenCalledWith(request);
  });

  it("бросок обработчика → контрактный 500 JSON и запись в лог, а не платформенная ошибка", async () => {
    handlers.webChat.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const res = await bot.fetch(new Request("http://localhost/api/chat"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Internal Error" });
    // Причина — в логе с контекстом пути; тело ответа деталей не раскрывает
    expect(logFakes.error).toHaveBeenCalledTimes(1);
    const [scope, message] = logFakes.error.mock.calls[0] as [string, string];
    expect(scope).toBe("router");
    expect(message).toContain("/api/chat");
    expect(message).toContain("boom");
  });
});
