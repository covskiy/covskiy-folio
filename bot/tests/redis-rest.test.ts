import { describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../log";
import { createRedisRest, restEnv, type RedisRestDeps } from "../redis-rest";

// Транспорт тестируется через инъекцию fetchImpl/env/log — без vi.stubGlobal:
// подменяется только то, что объявлено в deps, глобальное состояние не трогаем.

const REDIS_URL = "http://upstash.test";

/** Ответ Upstash REST на одиночную команду: {result} при успехе. */
function ok(result: unknown): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Логгер-шпион: собирает warn-строки (с префиксом модуля) вместо console. */
function makeLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  const log = createLogger({ env: {}, out: { warn: (line: string) => warns.push(line) } });
  return { log, warns };
}

/** Фабрика с дефолтной Upstash-парой env и моком fetch, отдающим ok(result). */
function makeTransport(
  result: unknown,
  overrides: Partial<RedisRestDeps> = {},
): { redis: ReturnType<typeof createRedisRest>; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async () => ok(result));
  const redis = createRedisRest({
    env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "test-token" },
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...overrides,
  });
  return { redis, fetchMock };
}

describe("restEnv: env-семейства (два имени одной базы)", () => {
  it("приоритет UPSTASH над KV: оба семейства заданы → UPSTASH-пара", () => {
    expect(
      restEnv({
        UPSTASH_REDIS_REST_URL: "http://upstash.test",
        UPSTASH_REDIS_REST_TOKEN: "upstash-token",
        KV_REST_API_URL: "http://kv.test",
        KV_REST_API_TOKEN: "kv-token",
      }),
    ).toEqual({ url: "http://upstash.test", token: "upstash-token" });
  });

  it("неполная пара — как отсутствие (пары не смешиваются)", () => {
    expect(restEnv({ UPSTASH_REDIS_REST_URL: "http://upstash.test" })).toBeNull();
    expect(restEnv({ UPSTASH_REDIS_REST_TOKEN: "tok" })).toBeNull();
    expect(
      restEnv({ UPSTASH_REDIS_REST_URL: "http://upstash.test", KV_REST_API_TOKEN: "kv" }),
    ).toBeNull();
  });

  it("KV_REST_API_URL/TOKEN (интеграция Vercel Marketplace) работают как источник", () => {
    expect(restEnv({ KV_REST_API_URL: "http://kv.test/", KV_REST_API_TOKEN: "kv-token" })).toEqual({
      url: "http://kv.test",
      token: "kv-token",
    });
  });

  it("трим значений и срез хвостовых слэшей URL", () => {
    expect(
      restEnv({
        UPSTASH_REDIS_REST_URL: "  http://upstash.test///  ",
        UPSTASH_REDIS_REST_TOKEN: "  tok  ",
      }),
    ).toEqual({ url: "http://upstash.test", token: "tok" });
  });

  it("пустые строки — отсутствие (restEnv тримит и считает их отсутствием)", () => {
    expect(restEnv({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" })).toBeNull();
  });
});

describe("command: одиночная REST-команда", () => {
  it("200 ok → result", async () => {
    const { redis } = makeTransport("сырое значение");
    await expect(redis.command(["get", "ключ"])).resolves.toBe("сырое значение");
  });

  it("fetchImpl получает POST с Bearer из токена, телом-массивом и сигналом таймаута", async () => {
    const { redis, fetchMock } = makeTransport("OK");
    await redis.command(["set", "chat:web:abc", "значение", "EX", "60"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REDIS_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(init.body))).toEqual(["set", "chat:web:abc", "значение", "EX", "60"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("env задан с хвостовыми слэшами → fetch получает URL без них", async () => {
    const fetchMock = vi.fn(async () => ok("OK"));
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: `${REDIS_URL}/`, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await redis.command(["ping"]);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(REDIS_URL);
  });

  it("не-2xx → null + warn rest-status", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.command(["get", "k"])).resolves.toBeNull();
    expect(warns).toEqual(["[store] Upstash REST вернул 500 — работаю без истории"]);
  });

  it("200 c {error} → null + warn rest-error", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "ERR max requests limit exceeded" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.command(["get", "k"])).resolves.toBeNull();
    expect(warns).toEqual([
      "[store] Upstash вернул ошибку (ERR max requests limit exceeded) — работаю без истории",
    ]);
  });

  it("сеть падает исключением → null + warn network", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.command(["get", "k"])).resolves.toBeNull();
    expect(warns).toEqual(["[store] Upstash недоступен (ECONNREFUSED) — работаю без истории"]);
  });

  it("result: null в ответе → null (не ошибка)", async () => {
    const { redis } = makeTransport(null);
    await expect(redis.command(["get", "нет-такого"])).resolves.toBeNull();
  });
});

describe("command: нет env (stateless-режим)", () => {
  it("→ null, warn no-env, fetch не зовётся", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(async () => ok("OK"));
    const redis = createRedisRest({
      env: {},
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.command(["get", "k"])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warns).toEqual([
      "[store] Upstash Redis не настроен (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN) — работаю без истории",
    ]);
  });

  it("троттлинг: второй вызов в окне гасится (один инстанс логгера — одна Map)", async () => {
    const { log, warns } = makeLog();
    const redis = createRedisRest({ env: {}, log });

    await redis.command(["get", "k"]);
    await redis.command(["get", "k"]);
    await redis.command(["get", "k"]);

    expect(warns).toHaveLength(1);
  });

  it("command и pipeline делят один throttle-ключ no-env", async () => {
    const { log, warns } = makeLog();
    const redis = createRedisRest({ env: {}, log });

    await redis.command(["get", "k"]);
    await redis.pipeline([["incr", "rate:1"]]);

    expect(warns).toEqual([
      "[store] Upstash Redis не настроен (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN) — работаю без истории",
    ]);
  });

  it("у фабрики без deps.log свой createLogger() — инстансы не гасят друг друга", async () => {
    const warns: string[] = [];
    const out = { warn: (line: string) => warns.push(line) };
    // Разные фабрики без deps.log получают разные дефолтные логгеры (разные Map троттлинга).
    await createRedisRest({ env: {}, log: createLogger({ out }) }).command(["get", "k"]);
    await createRedisRest({ env: {}, log: createLogger({ out }) }).command(["get", "k"]);

    expect(warns).toHaveLength(2);
  });
});

describe("pipeline: массив команд одним POST", () => {
  it("тело — массив команд, ответ-массив разворачивается в значения", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify([{ result: 3 }, { result: 1 }])),
    );
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      redis.pipeline([
        ["incr", "rate:web:1"],
        ["expire", "rate:web:1", "3600", "NX"],
      ]),
    ).resolves.toEqual([3, 1]);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toEqual([
      ["incr", "rate:web:1"],
      ["expire", "rate:web:1", "3600", "NX"],
    ]);
  });

  it("элементы с error → null на их местах", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify([{ error: "WRONGTYPE" }, { result: 1 }])),
    );
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      redis.pipeline([
        ["incr", "k"],
        ["expire", "k", "60", "NX"],
      ]),
    ).resolves.toEqual([null, 1]);
  });

  it("ответ не массив → null (без warn: это аномалия ответа, не деградация)", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: 1 })));
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.pipeline([["incr", "k"]])).resolves.toBeNull();
    expect(warns).toEqual([]);
  });

  it("не-2xx → null + warn rest-status с пометкой pipeline", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.pipeline([["incr", "k"]])).resolves.toBeNull();
    expect(warns).toEqual(["[store] Upstash REST вернул 503 (pipeline) — работаю без лимитера"]);
  });

  it("сеть падает исключением → null + warn network без лимитера", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    const redis = createRedisRest({
      env: { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: "tok" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.pipeline([["incr", "k"]])).resolves.toBeNull();
    expect(warns).toEqual(["[store] Upstash недоступен (ETIMEDOUT) — работаю без лимитера"]);
  });

  it("env нет → null + warn no-env (тот же ключ, что у command)", async () => {
    const { log, warns } = makeLog();
    const fetchMock = vi.fn(async () => ok(1));
    const redis = createRedisRest({
      env: {},
      fetchImpl: fetchMock as unknown as typeof fetch,
      log,
    });

    await expect(redis.pipeline([["incr", "k"]])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warns).toEqual([
      "[store] Upstash Redis не настроен (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN) — работаю без лимитера",
    ]);
  });
});

describe("deps: резолв на вызов, а не при создании фабрики", () => {
  it("env, подменённый после создания инстанса, виден (мутируемый объект)", async () => {
    const env: NodeJS.ProcessEnv = {};
    const fetchMock = vi.fn(async () => ok("OK"));
    const redis = createRedisRest({ env, fetchImpl: fetchMock as unknown as typeof fetch });

    await redis.command(["get", "k"]);
    expect(fetchMock).not.toHaveBeenCalled();

    // Мутация после создания — то же, что vi.stubEnv между вызовами.
    env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    env.UPSTASH_REDIS_REST_TOKEN = "late-token";
    await redis.command(["get", "k"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REDIS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer late-token");
  });
});
