import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramAdminHandler } from "../http/telegram-admin";
import { createConfig } from "../config";
import { createLlm, type LlmPing } from "../llm/index";
import { createStore, type RedisPing, type Store } from "../store";
import { createTelegramApi, type TelegramApi, type TgWebhookInfo } from "../telegram-api";
import type { KnowledgeItem } from "../brain/knowledge";
import type { Logger } from "../log";

const SECRET = "test-secret";
const SETUP_URL = "http://localhost/api/telegram-setup";
const HEALTH_URL = `${SETUP_URL}?section=health`;
const PROMPT_URL = `${SETUP_URL}?section=prompt`;

/** Фикстура справки: маркеры промт-теста. */
const PROMPT_ENTRIES: KnowledgeItem[] = [
  { id: "fixture-topic", title: "Тема-фикстура", text: "Текст-фикстура справки" },
];

/** Ответ Bot API на getWebhookInfo (фикстура для пункта telegram в health). */
const WEBHOOK_RESULT: TgWebhookInfo = {
  url: "https://site.example/api/telegram",
  pending_update_count: 2,
};

/** Молчаливый логгер: обработчик логирует, тесты — нет. */
const silentLog: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  warnThrottled: vi.fn(),
};

interface HarnessOptions {
  /** Env секрета для config (не задан — TELEGRAM_WEBHOOK_SECRET отсутствует). */
  secret?: string;
  webhook?: TgWebhookInfo;
  /** Если задан: tg-фейк бросает ошибку с этим текстом (502). */
  tgError?: string;
  llmPing?: LlmPing;
  redisPing?: RedisPing;
  /** Справка недоступна (load() → null). */
  noKnowledge?: boolean;
}

interface Harness {
  handle: (request: Request) => Promise<Response>;
  tg: {
    getWebhookInfo: ReturnType<typeof vi.fn>;
    setWebhook: ReturnType<typeof vi.fn>;
  };
  llm: { ping: ReturnType<typeof vi.fn> };
  store: { ping: ReturnType<typeof vi.fn> };
  knowledge: { load: ReturnType<typeof vi.fn> };
}

/**
 * Собирает обработчик на фейках: config — createConfig({...}) (секрет через env
 * фабрики, не vi.stubEnv), llm/store/tg — управляемые фейки с записью вызовов.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const config = createConfig(
    options.secret === undefined ? {} : { TELEGRAM_WEBHOOK_SECRET: options.secret },
  );
  const llm = {
    ping: vi.fn(
      async (): Promise<LlmPing> =>
        options.llmPing ?? {
          ok: false,
          error: "не настроен: нет LLM-провайдеров",
          providers: [],
          issues: [],
        },
    ),
  };
  const store = {
    ping: vi.fn(
      async (): Promise<RedisPing> =>
        options.redisPing ?? {
          ok: false,
          reason: "не настроен: UPSTASH_REDIS_REST_* / KV_REST_API_* отсутствуют",
        },
    ),
  };
  const tg = {
    getWebhookInfo: vi.fn(async (): Promise<TgWebhookInfo> => {
      if (options.tgError) throw new Error(options.tgError);
      return options.webhook ?? WEBHOOK_RESULT;
    }),
    setWebhook: vi.fn(async (): Promise<boolean> => {
      if (options.tgError) throw new Error(options.tgError);
      return true;
    }),
  };
  const knowledge = {
    load: vi.fn(() => (options.noKnowledge ? null : PROMPT_ENTRIES)),
  };
  const handle = createTelegramAdminHandler({ config, llm, tg, store, log: silentLog, knowledge });
  return { handle, tg, llm, store, knowledge };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleTelegramAdmin", () => {
  it("без секрет-заголовка → 404 (маршрут скрыт)", async () => {
    const { handle } = makeHarness({ secret: SECRET });
    const res = await handle(new Request(SETUP_URL));
    expect(res.status).toBe(404);
  });

  it("без секрета в env → 404 даже с заголовком", async () => {
    const { handle } = makeHarness();
    const res = await handle(
      new Request(SETUP_URL, { headers: { "x-telegram-bot-api-secret-token": SECRET } }),
    );
    expect(res.status).toBe(404);
  });

  it("чужой секрет → 404", async () => {
    const { handle } = makeHarness({ secret: "другой-секрет" });
    const res = await handle(
      new Request(SETUP_URL, { headers: { "x-telegram-bot-api-secret-token": SECRET } }),
    );
    expect(res.status).toBe(404);
  });

  it("GET → getWebhookInfo", async () => {
    const { handle, tg } = makeHarness({ secret: SECRET });

    const res = await handle(
      new Request(SETUP_URL, { headers: { "x-telegram-bot-api-secret-token": SECRET } }),
    );

    expect(res.status).toBe(200);
    expect(tg.getWebhookInfo).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject({ ok: true, webhook: WEBHOOK_RESULT });
  });

  it("POST → setWebhook с url из origin, секретом и allowed_updates", async () => {
    const { handle, tg } = makeHarness({ secret: SECRET });

    const res = await handle(
      new Request(SETUP_URL, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
      }),
    );

    expect(res.status).toBe(200);
    expect(tg.setWebhook).toHaveBeenCalledTimes(1);
    expect(tg.setWebhook).toHaveBeenCalledWith({
      url: "http://localhost/api/telegram",
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
    });
  });

  it("ошибка Telegram API → 502 с текстом", async () => {
    const { handle } = makeHarness({
      secret: SECRET,
      tgError: "Telegram setWebhook failed: Unauthorized",
    });

    const res = await handle(
      new Request(SETUP_URL, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
      }),
    );

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "Telegram setWebhook failed: Unauthorized",
    });
  });
});

// ── Разделы health и prompt ─────────────────────────────────────────

function adminRequest(url: string, method = "GET"): Request {
  return new Request(url, { method, headers: { "x-telegram-bot-api-secret-token": SECRET } });
}

describe("handleTelegramAdmin: разделы health и prompt", () => {
  it("health без секрет-заголовка → 404", async () => {
    const { handle } = makeHarness({ secret: SECRET });
    const res = await handle(new Request(HEALTH_URL));
    expect(res.status).toBe(404);
  });

  it("prompt без секрет-заголовка → 404", async () => {
    const { handle } = makeHarness({ secret: SECRET });
    const res = await handle(new Request(PROMPT_URL));
    expect(res.status).toBe(404);
  });

  it("не-GET на разделы → 405", async () => {
    const { handle } = makeHarness({ secret: SECRET });
    for (const method of ["DELETE", "PUT"]) {
      const res = await handle(adminRequest(HEALTH_URL, method));
      expect(res.status).toBe(405);
    }
  });

  it("prompt → собранный systemPrompt с секцией справки из инъекции", async () => {
    const { handle } = makeHarness({ secret: SECRET });

    const res = await handle(adminRequest(PROMPT_URL));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; prompt: string };
    expect(body.ok).toBe(true);
    // Фикстура прошла через knowledge → systemPrompt: секция справки на месте
    expect(body.prompt).toContain("Тема-фикстура:");
    expect(body.prompt).toContain("Текст-фикстура справки");
    expect(body.prompt).not.toContain("{{KNOWLEDGE}}");
  });

  it("справка недоступна: prompt → 502 с диагностируемой ошибкой, а не промт без секции", async () => {
    const { handle } = makeHarness({ secret: SECRET, noKnowledge: true });

    const res = await handle(adminRequest(PROMPT_URL));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("health: ошибка одного пункта не роняет остальные", async () => {
    // llm — реальный транспорт: оба его пробы упадут в сеть (fetchImpl-фейк),
    // ping должен вернуть {ok:false, error} с текстом сетевой ошибки.
    const llm = createLlm({
      config: createConfig({ LLM_1_BASE_URL: "https://llm.test/v1", LLM_1_MODEL: "test-model" }),
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const tg = {
      getWebhookInfo: vi.fn(async (): Promise<TgWebhookInfo> => WEBHOOK_RESULT),
      setWebhook: vi.fn(async (): Promise<boolean> => true),
    };
    const store = { ping: vi.fn(async (): Promise<RedisPing> => ({ ok: true, latencyMs: 7 })) };

    const handle = createTelegramAdminHandler({
      config: createConfig({ TELEGRAM_WEBHOOK_SECRET: SECRET }),
      llm,
      tg,
      store,
      log: silentLog,
      knowledge: { load: () => PROMPT_ENTRIES },
    });

    const res = await handle(adminRequest(HEALTH_URL));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      llm: { ok: boolean; error?: string };
      redis: { ok: boolean; latencyMs?: number };
      telegram: { ok: boolean; webhook?: TgWebhookInfo };
    };
    expect(body.llm.ok).toBe(false);
    expect(body.llm.error).toContain("ECONNREFUSED");
    expect(body.redis.ok).toBe(true);
    expect(typeof body.redis.latencyMs).toBe("number");
    expect(body.telegram.ok).toBe(true);
    expect(body.telegram.webhook).toEqual(WEBHOOK_RESULT);
  });

  it("health без настроенного env: все пункты ok:false с причиной, без throw", async () => {
    // Все три пункта — реальные фабрики над ПУСТЫМ config: ни один не должен
    // дойти до сети, guard-фейк fetch падает при случайном походе.
    const guard = vi.fn(async () => {
      throw new Error("unexpected network call");
    });
    const emptyConfig = createConfig({});
    const llm = createLlm({ config: emptyConfig, fetchImpl: guard as unknown as typeof fetch });
    const store: Pick<Store, "ping"> = createStore({ config: emptyConfig });
    const tg: Pick<TelegramApi, "getWebhookInfo" | "setWebhook"> = createTelegramApi({
      config: emptyConfig,
    });

    const handle = createTelegramAdminHandler({
      config: createConfig({ TELEGRAM_WEBHOOK_SECRET: SECRET }),
      llm,
      tg,
      store,
      log: silentLog,
      knowledge: { load: () => PROMPT_ENTRIES },
    });

    const res = await handle(adminRequest(HEALTH_URL));

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
    // Сети не было: llm и store вернули «не настроен» до транспорта,
    // tg бросил до fetch (нет токена)
    expect(guard).not.toHaveBeenCalled();
  });
});
