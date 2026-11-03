import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelegramAdmin } from "../lib/telegram-admin";

const SECRET = "test-secret";
const SETUP_URL = "http://localhost/api/telegram-setup";

/** Подменяет глобальный fetch: Bot API всегда отвечает успехом. */
function stubFetch(): ReturnType<typeof vi.fn> {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("handleTelegramAdmin", () => {
  it("без секрет-заголовка → 404 (маршрут скрыт)", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramAdmin(new Request(SETUP_URL));
    expect(res.status).toBe(404);
  });

  it("без секрета в env → 404 даже с заголовком", async () => {
    const res = await handleTelegramAdmin(
      new Request(SETUP_URL, { headers: { "x-telegram-bot-api-secret-token": SECRET } }),
    );
    expect(res.status).toBe(404);
  });

  it("чужой секрет → 404", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "другой-секрет");
    const res = await handleTelegramAdmin(
      new Request(SETUP_URL, { headers: { "x-telegram-bot-api-secret-token": SECRET } }),
    );
    expect(res.status).toBe(404);
  });

  it("GET → getWebhookInfo", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    const res = await handleTelegramAdmin(
      new Request(SETUP_URL, { headers: { "x-telegram-bot-api-secret-token": SECRET } }),
    );

    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/getWebhookInfo");
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("POST → setWebhook с url из origin, секретом и allowed_updates", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    const res = await handleTelegramAdmin(
      new Request(SETUP_URL, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
      }),
    );

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/setWebhook");
    expect(JSON.parse(String(init.body))).toMatchObject({
      url: "http://localhost/api/telegram",
      secret_token: SECRET,
      allowed_updates: ["message"],
    });
  });

  it("ошибка Telegram API → 502 с текстом", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const res = await handleTelegramAdmin(
      new Request(SETUP_URL, { headers: { "x-telegram-bot-api-secret-token": SECRET } }),
    );

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });
});
