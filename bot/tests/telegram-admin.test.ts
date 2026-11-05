import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelegramAdmin } from "../http/telegram-admin";
import { systemPrompt } from "../brain/prompt";

const SECRET = "test-secret";
const SETUP_URL = "http://localhost/api/telegram-setup";
const HEALTH_URL = `${SETUP_URL}?section=health`;
const PROMPT_URL = `${SETUP_URL}?section=prompt`;

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
      allowed_updates: ["message", "callback_query"],
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

// ── Разделы health и prompt (шаг 7 плана) ───────────────────────────

/** Ответ Bot API на getWebhookInfo для маршрутизации fetch по URL. */
const WEBHOOK_RESULT = { url: "https://site.example/api/telegram", pending_update_count: 2 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Подменяет fetch так, чтобы каждый внешний сервис вёл себя по-своему. */
function stubFetchByUrl(route: (url: string) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => route(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function adminRequest(url: string, method = "GET"): Request {
  return new Request(url, { method, headers: { "x-telegram-bot-api-secret-token": SECRET } });
}

describe("handleTelegramAdmin: разделы health и prompt", () => {
  it("health без секрет-заголовка → 404", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramAdmin(new Request(HEALTH_URL));
    expect(res.status).toBe(404);
  });

  it("prompt без секрет-заголовка → 404", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramAdmin(new Request(PROMPT_URL));
    expect(res.status).toBe(404);
  });

  it("не-GET на разделы → 405", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    for (const method of ["DELETE", "PUT"]) {
      const res = await handleTelegramAdmin(adminRequest(HEALTH_URL, method));
      expect(res.status).toBe(405);
    }
  });

  it("prompt → собранный systemPrompt целиком", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramAdmin(adminRequest(PROMPT_URL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; prompt: string };
    expect(body.ok).toBe(true);
    expect(body.prompt).toBe(systemPrompt());
  });

  it("health: ошибка одного пункта не роняет остальные", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "redis-token");
    stubFetchByUrl(async (url) => {
      if (url.includes("api.telegram.org")) {
        return jsonResponse({ ok: true, result: WEBHOOK_RESULT });
      }
      if (url.includes("redis.test")) {
        return jsonResponse({ result: "PONG" });
      }
      // LLM-провайдер лежит целиком (сеть).
      throw new Error("ECONNREFUSED");
    });

    const res = await handleTelegramAdmin(adminRequest(HEALTH_URL));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      llm: { ok: boolean; error?: string };
      redis: { ok: boolean; latencyMs?: number };
      telegram: { ok: boolean; webhook?: typeof WEBHOOK_RESULT };
    };
    expect(body.llm.ok).toBe(false);
    expect(body.llm.error).toContain("ECONNREFUSED");
    expect(body.redis.ok).toBe(true);
    expect(typeof body.redis.latencyMs).toBe("number");
    expect(body.telegram.ok).toBe(true);
    expect(body.telegram.webhook).toEqual(WEBHOOK_RESULT);
  });

  it("health без настроенных env: все пункты ok:false с причиной, без throw", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    // fetch не должен вызываться вовсе — подменяем на падение как страховку
    // от случайного похода в сеть из теста.
    stubFetchByUrl(async () => {
      throw new Error("unexpected network call");
    });

    const res = await handleTelegramAdmin(adminRequest(HEALTH_URL));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm: { ok: boolean; error?: string };
      redis: { ok: boolean; reason?: string };
      telegram: { ok: false; error?: string };
    };
    expect(body.llm.ok).toBe(false);
    expect(body.llm.error).toContain("не настроен");
    expect(body.redis.ok).toBe(false);
    expect(body.redis.reason).toContain("не настроен");
    expect(body.telegram.ok).toBe(false);
  });
});
