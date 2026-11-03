import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook } from "../lib/telegram-webhook";

const SECRET = "test-secret";
const URL = "http://localhost/api/telegram";

function updateWithText(text: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify({ message: { message_id: 1, chat: { id: 42 }, text } }),
  });
}

/**
 * Подменяет глобальный fetch: вызовы sendMessage в Bot API отвечают успехом,
 * вызовы в LLM (из brain) — фиксированным ответом. Возвращает мок для проверок.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const payload = url.includes("/sendMessage")
      ? { ok: true, result: { message_id: 2, chat: { id: 42 } } }
      : { choices: [{ message: { content: "ответ brain" } }] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("handleTelegramWebhook", () => {
  it("без секрет-заголовка → 401", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramWebhook(new Request(URL, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("без TELEGRAM_WEBHOOK_SECRET в env → 401 даже с заголовком", async () => {
    const res = await handleTelegramWebhook(updateWithText("/start"));
    expect(res.status).toBe(401);
  });

  it("чужой секрет → 401", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "другой-секрет");
    const res = await handleTelegramWebhook(updateWithText("/start"));
    expect(res.status).toBe(401);
  });

  it("/start → приветствие через sendMessage в тот же чат", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    const res = await handleTelegramWebhook(updateWithText("/start"));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(String(init.body)) as { chat_id: number; text: string };
    expect(body.chat_id).toBe(42);
    expect(body.text).toContain("Привет");
  });

  it("вопрос → ответ brain через sendMessage", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    const fetchMock = stubFetch();

    await handleTelegramWebhook(updateWithText("кто ты?"));

    const [, init] = fetchMock.mock.calls.at(-1) as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      chat_id: 42,
      text: "ответ brain",
    });
  });

  it("update без текста — просто 200 без вызовов", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    const res = await handleTelegramWebhook(
      new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({ message: { message_id: 3, chat: { id: 42 } } }),
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("битый JSON — 200 ok (Telegram не должен повторять доставку)", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramWebhook(
      new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
        body: "{oops",
      }),
    );
    expect(res.status).toBe(200);
  });
});
