import { afterEach, describe, expect, it, vi } from "vitest";
import { config, createConfig } from "../config";

// Тесты чистые: env — обычные объекты (config ленив и перечитывает env на
// каждый доступ), сети нет, vi.stubGlobal не нужен. vi.stubEnv — только для
// дефолтного config (зеркально log.test.ts).
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("config: llm", () => {
  it("слоты разбираются по возрастанию номера: trim, слэши, id/kind/apiKey", () => {
    const cfg = createConfig({
      LLM_2_BASE_URL: "  https://backup.example.com/v1///  ",
      LLM_2_MODEL: " backup-model ",
      LLM_2_ID: " backup ",
      LLM_2_API_KEY: " sk-backup ",
      LLM_1_BASE_URL: "https://main.example.com/v1",
      LLM_1_MODEL: " main-model ",
      LLM_1_KIND: "openai",
      LLM_1_TIMEOUT_MS: "25000",
      LLM_MAX_TOKENS: "512",
      LLM_TOTAL_TIMEOUT_MS: "30000",
      LLM_COOLDOWN_MS: "120000",
    });

    expect(cfg.llm).toEqual({
      providers: [
        {
          id: "provider-1",
          kind: "openai",
          baseUrl: "https://main.example.com/v1",
          apiKey: undefined,
          model: "main-model",
          timeoutMs: 25_000,
        },
        {
          id: "backup",
          kind: "openai",
          baseUrl: "https://backup.example.com/v1",
          apiKey: "sk-backup",
          model: "backup-model",
          timeoutMs: 15_000,
        },
      ],
      maxTokens: 512,
      totalTimeoutMs: 30_000,
      cooldownMs: 120_000,
      issues: [],
    });
  });

  it("ID/KIND по умолчанию; LLM_TIMEOUT_MS — дефолт таймаута попытки", () => {
    const cfg = createConfig({
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
      LLM_TIMEOUT_MS: "7000",
    });

    expect(cfg.llm.providers).toEqual([
      {
        id: "provider-1",
        kind: "openai",
        baseUrl: "https://x",
        apiKey: undefined,
        model: "m",
        timeoutMs: 7_000,
      },
    ]);
  });

  it("нет слотов → providers: [], issues: [] и дефолты общих ручек", () => {
    expect(createConfig({}).llm).toEqual({
      providers: [],
      maxTokens: 1_024,
      totalTimeoutMs: 20_000,
      cooldownMs: 60_000,
      issues: [],
    });
  });

  it("пустой LLM_n_API_KEY → undefined, не пустая строка", () => {
    const cfg = createConfig({
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
      LLM_1_API_KEY: "   ",
    });
    expect(cfg.llm.providers[0].apiKey).toBeUndefined();
  });

  it("неполный слот → issues, валидный соседний остаётся в цепочке", () => {
    const cfg = createConfig({
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
      LLM_2_BASE_URL: "https://y",
    });

    expect(cfg.llm.providers.map((provider) => provider.id)).toEqual(["provider-1"]);
    expect(cfg.llm.issues).toEqual([expect.stringContaining("LLM_2_")]);
  });

  it("неизвестный KIND → issues, слот не попадает в цепочку", () => {
    const cfg = createConfig({
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
      LLM_1_KIND: "anthropic",
    });

    expect(cfg.llm.providers).toEqual([]);
    expect(cfg.llm.issues).toEqual([expect.stringContaining("KIND")]);
  });

  it("дубль ID → issues, второй слот пропущен", () => {
    const cfg = createConfig({
      LLM_1_ID: "same",
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
      LLM_2_ID: "same",
      LLM_2_BASE_URL: "https://y",
      LLM_2_MODEL: "m",
    });

    expect(cfg.llm.providers).toHaveLength(1);
    expect(cfg.llm.issues).toEqual([expect.stringContaining("дубль")]);
  });

  it("пропуск нумерации → issues, валидные слоты всё равно используются", () => {
    const cfg = createConfig({
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
      LLM_3_BASE_URL: "https://z",
      LLM_3_MODEL: "m",
    });

    expect(cfg.llm.providers.map((provider) => provider.id)).toEqual(["provider-1", "provider-3"]);
    expect(cfg.llm.issues).toEqual([expect.stringContaining("LLM_2_*")]);
  });

  it("номер вне диапазона 1…9 → issues, слот не используется", () => {
    const cfg = createConfig({
      LLM_0_BASE_URL: "https://zero",
      LLM_0_MODEL: "m",
      LLM_10_BASE_URL: "https://ten",
      LLM_10_MODEL: "m",
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
    });

    expect(cfg.llm.providers.map((provider) => provider.id)).toEqual(["provider-1"]);
    expect(cfg.llm.issues).toEqual([
      expect.stringContaining("LLM_0_*"),
      expect.stringContaining("LLM_10_*"),
    ]);
  });

  it("неизвестное поле слота → issues (опечатка не теряется молча)", () => {
    const cfg = createConfig({
      LLM_1_BASE_URL: "https://x",
      LLM_1_MODEL: "m",
      LLM_1_BASEURL: "https://typo",
    });

    expect(cfg.llm.providers).toHaveLength(1);
    expect(cfg.llm.issues).toEqual([expect.stringContaining("BASEURL")]);
  });

  it("мусор/ноль/отрицательное/пустое в числах — дефолт: валидно только конечное и > 0", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      const cfg = createConfig({
        LLM_1_BASE_URL: "https://x",
        LLM_1_MODEL: "m",
        LLM_1_TIMEOUT_MS: bad,
        LLM_TOTAL_TIMEOUT_MS: bad,
        LLM_COOLDOWN_MS: bad,
        LLM_MAX_TOKENS: bad,
      });
      expect(cfg.llm).toMatchObject({
        maxTokens: 1_024,
        totalTimeoutMs: 20_000,
        cooldownMs: 60_000,
      });
      expect(cfg.llm.providers[0].timeoutMs).toBe(15_000);
    }
  });
});

describe("config: redis", () => {
  it("приоритет UPSTASH-пары над KV-парой", () => {
    const cfg = createConfig({
      UPSTASH_REDIS_REST_URL: "https://up.example.com",
      UPSTASH_REDIS_REST_TOKEN: "up-token",
      KV_REST_API_URL: "https://kv.example.com",
      KV_REST_API_TOKEN: "kv-token",
    });
    expect(cfg.redis).toEqual({ url: "https://up.example.com", token: "up-token" });
  });

  it("неполная UPSTASH-пара + полная KV → KV (семейства не смешиваются)", () => {
    const cfg = createConfig({
      UPSTASH_REDIS_REST_URL: "https://up.example.com",
      KV_REST_API_URL: "https://kv.example.com",
      KV_REST_API_TOKEN: "kv-token",
    });
    expect(cfg.redis).toEqual({ url: "https://kv.example.com", token: "kv-token" });
  });

  it("обе пары неполные → null", () => {
    const cfg = createConfig({
      UPSTASH_REDIS_REST_TOKEN: "up-token",
      KV_REST_API_URL: "https://kv.example.com",
    });
    expect(cfg.redis).toBeNull();
  });

  it("trim значений и срез хвостовых слэшей URL", () => {
    const cfg = createConfig({
      UPSTASH_REDIS_REST_URL: "  https://up.example.com/  ",
      UPSTASH_REDIS_REST_TOKEN: "  tok  ",
    });
    expect(cfg.redis).toEqual({ url: "https://up.example.com", token: "tok" });
  });
});

describe("config: telegram", () => {
  it("без env: токен/секрет undefined, apiRoot — официальный, seenTtl — час", () => {
    expect(createConfig({}).telegram).toEqual({
      botToken: undefined,
      webhookSecret: undefined,
      apiRoot: "https://api.telegram.org",
      seenTtlSeconds: 3_600,
    });
  });

  it("оверрайд TELEGRAM_API_ROOT: trim + срез слэшей", () => {
    const cfg = createConfig({ TELEGRAM_API_ROOT: "  http://localhost:3001/tg///  " });
    expect(cfg.telegram.apiRoot).toBe("http://localhost:3001/tg");
  });

  it("токен и секрет тримятся; пустые → undefined", () => {
    const cfg = createConfig({
      TELEGRAM_BOT_TOKEN: "  123:abc  ",
      TELEGRAM_WEBHOOK_SECRET: "   ",
    });
    expect(cfg.telegram.botToken).toBe("123:abc");
    expect(cfg.telegram.webhookSecret).toBeUndefined();
  });

  it("TELEGRAM_SEEN_TTL_SECONDS: оверрайд парсится, мусор — дефолт", () => {
    expect(createConfig({ TELEGRAM_SEEN_TTL_SECONDS: "120" }).telegram.seenTtlSeconds).toBe(120);
    expect(createConfig({ TELEGRAM_SEEN_TTL_SECONDS: "abc" }).telegram.seenTtlSeconds).toBe(3_600);
  });
});

describe("config: rateLimit", () => {
  it("без env — дефолты 15/3600", () => {
    expect(createConfig({}).rateLimit).toEqual({ max: 15, windowSeconds: 3_600 });
  });

  it("оверрайды парсятся числами", () => {
    expect(
      createConfig({ RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_SECONDS: "60" }).rateLimit,
    ).toEqual({ max: 3, windowSeconds: 60 });
  });

  it("мусор/ноль/отрицательное — дефолт", () => {
    for (const bad of ["abc", "0", "-1"]) {
      expect(
        createConfig({ RATE_LIMIT_MAX: bad, RATE_LIMIT_WINDOW_SECONDS: bad }).rateLimit,
      ).toEqual({ max: 15, windowSeconds: 3_600 });
    }
  });
});

describe("config: brain", () => {
  it("без env — дефолты 10/0.3", () => {
    expect(createConfig({}).brain).toEqual({ historyWindow: 10, dumbScoreThreshold: 0.3 });
  });

  it("оверрайды парсятся числами, дробный порог проходит", () => {
    expect(createConfig({ HISTORY_WINDOW: "4", DUMB_SCORE_THRESHOLD: "0.45" }).brain).toEqual({
      historyWindow: 4,
      dumbScoreThreshold: 0.45,
    });
  });

  it("мусор/ноль/отрицательное — дефолт", () => {
    for (const bad of ["abc", "0", "-1"]) {
      expect(createConfig({ HISTORY_WINDOW: bad, DUMB_SCORE_THRESHOLD: bad }).brain).toEqual({
        historyWindow: 10,
        dumbScoreThreshold: 0.3,
      });
    }
  });
});

describe("config: history", () => {
  it("без env — дефолт 86400 (24 ч)", () => {
    expect(createConfig({}).history).toEqual({ ttlSeconds: 86_400 });
  });

  it("оверрайд парсится, мусор — дефолт", () => {
    expect(createConfig({ HISTORY_TTL_SECONDS: "60" }).history).toEqual({ ttlSeconds: 60 });
    expect(createConfig({ HISTORY_TTL_SECONDS: "abc" }).history).toEqual({ ttlSeconds: 86_400 });
  });
});

describe("config: logLevel", () => {
  it("все четыре валидных значения проходят", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(createConfig({ LOG_LEVEL: level }).logLevel).toBe(level);
    }
  });

  it("верхний регистр и пробелы прощаются («DEBUG» → debug)", () => {
    expect(createConfig({ LOG_LEVEL: "  DEBUG  " }).logLevel).toBe("debug");
  });

  it("мусор и отсутствие — дефолт warn", () => {
    expect(createConfig({ LOG_LEVEL: "не-уровень" }).logLevel).toBe("warn");
    expect(createConfig({}).logLevel).toBe("warn");
  });
});

describe("config: ленивость", () => {
  it("мутация env-объекта после createConfig видна геттерам", () => {
    const env: NodeJS.ProcessEnv = { LLM_1_BASE_URL: "https://x" };
    const cfg = createConfig(env);
    expect(cfg.llm.providers).toEqual([]);
    expect(cfg.llm.issues).toEqual([expect.stringContaining("LLM_1_")]);

    // Модель добавили позже — слот стал валидным: env перечитан, не закэширован.
    env.LLM_1_MODEL = "m";
    expect(cfg.llm.providers).toEqual([
      {
        id: "provider-1",
        kind: "openai",
        baseUrl: "https://x",
        apiKey: undefined,
        model: "m",
        timeoutMs: 15_000,
      },
    ]);
    expect(cfg.llm.issues).toEqual([]);

    env.LOG_LEVEL = "debug";
    expect(cfg.logLevel).toBe("debug");
  });

  it("дефолтный config видит vi.stubEnv (обратная совместимость, зеркально log.test.ts)", () => {
    vi.stubEnv("LLM_1_BASE_URL", "https://x");
    vi.stubEnv("LLM_1_MODEL", "m");
    vi.stubEnv("LOG_LEVEL", "debug");
    expect(config.llm.providers).toHaveLength(1);
    expect(config.logLevel).toBe("debug");
  });
});
