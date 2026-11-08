import { afterEach, describe, expect, it, vi } from "vitest";
import { config, createConfig } from "../config";

// Тесты чистые: env — обычные объекты (config ленив и перечитывает env на
// каждый доступ), сети нет, vi.stubGlobal не нужен. vi.stubEnv — только для
// дефолтного config (зеркально log.test.ts).
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("config: llm", () => {
  it("полный набор разбирается: trim, срез слэшей baseUrl, apiKey, числа", () => {
    const cfg = createConfig({
      LLM_BASE_URL: "  https://ollama.com/v1///  ",
      LLM_MODEL: " gpt-oss:20b ",
      LLM_API_KEY: " sk-test ",
      LLM_TIMEOUT_MS: "25000",
      LLM_MAX_TOKENS: "512",
    });

    expect(cfg.llm).toEqual({
      baseUrl: "https://ollama.com/v1",
      apiKey: "sk-test",
      model: "gpt-oss:20b",
      timeoutMs: 25_000,
      maxTokens: 512,
    });
  });

  it("нет LLM_BASE_URL → null", () => {
    expect(createConfig({ LLM_MODEL: "m" }).llm).toBeNull();
  });

  it("нет LLM_MODEL → null", () => {
    expect(createConfig({ LLM_BASE_URL: "https://x" }).llm).toBeNull();
  });

  it("пустой LLM_API_KEY → undefined, не пустая строка", () => {
    const cfg = createConfig({ LLM_BASE_URL: "https://x", LLM_MODEL: "m", LLM_API_KEY: "   " });
    expect(cfg.llm?.apiKey).toBeUndefined();
  });

  it("без числовых env — дефолты 15000/1024", () => {
    const cfg = createConfig({ LLM_BASE_URL: "https://x", LLM_MODEL: "m" });
    expect(cfg.llm).toMatchObject({ timeoutMs: 15_000, maxTokens: 1_024 });
  });

  it("мусор/ноль/отрицательное/пустое в числах — дефолт: валидно только конечное и > 0", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      const cfg = createConfig({
        LLM_BASE_URL: "https://x",
        LLM_MODEL: "m",
        LLM_TIMEOUT_MS: bad,
        LLM_MAX_TOKENS: bad,
      });
      expect(cfg.llm).toMatchObject({ timeoutMs: 15_000, maxTokens: 1_024 });
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
    const env: NodeJS.ProcessEnv = { LLM_BASE_URL: "https://x" };
    const cfg = createConfig(env);
    expect(cfg.llm).toBeNull();

    // Модель добавили позже — llm стал не-null: env перечитан, не закэширован.
    env.LLM_MODEL = "m";
    expect(cfg.llm).toEqual({
      baseUrl: "https://x",
      apiKey: undefined,
      model: "m",
      timeoutMs: 15_000,
      maxTokens: 1_024,
    });

    env.LOG_LEVEL = "debug";
    expect(cfg.logLevel).toBe("debug");
  });

  it("дефолтный config видит vi.stubEnv (обратная совместимость, зеркально log.test.ts)", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    expect(config.logLevel).toBe("debug");
  });
});
