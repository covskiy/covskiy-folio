import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendHistory,
  clearHistory,
  getHistory,
  getValue,
  HISTORY_TTL_SECONDS,
  setValue,
  tgKey,
  webKey,
} from "../store";

const REDIS_URL = "http://upstash.test";

/**
 * Подменяет env и fetch: обработчик получает разобранную REST-команду Upstash
 * (JSON-массив из тела POST) и возвращает ответ.
 */
function stubUpstash(
  handler: (command: unknown[]) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as unknown[];
    return handler(command);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch, которого не должно быть: любой вызов роняет тест. */
function stubFetchThatMustNotBeCalled(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    throw new Error("unexpected network call");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("store: REST-команды", () => {
  it("setValue шлёт SET с TTL: [set, key, value, EX, 86400], URL и Bearer из env", async () => {
    // Хвостовой слэш в URL — частая опечатка в env, store обязан его срезать.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", `${REDIS_URL}/`);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ok("OK"));
    vi.stubGlobal("fetch", fetchMock);

    await setValue("chat:web:abc", '[{"role":"user"}]', HISTORY_TTL_SECONDS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REDIS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(init.body))).toEqual([
      "set",
      "chat:web:abc",
      '[{"role":"user"}]',
      "EX",
      "86400",
    ]);
  });

  it("getValue шлёт GET и возвращает строковый result", async () => {
    stubUpstash(() => ok("сырое значение"));
    await expect(getValue("ключ")).resolves.toBe("сырое значение");
  });

  it("getHistory парсит JSON-историю из GET", async () => {
    stubUpstash(() => ok(JSON.stringify([{ role: "user", content: "вопрос" }])));
    await expect(getHistory("chat:tg:42")).resolves.toEqual([{ role: "user", content: "вопрос" }]);
  });

  it("clearHistory шлёт DEL ключа", async () => {
    const fetchMock = stubUpstash(() => ok(1));
    await clearHistory("chat:tg:42");
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual([
      "del",
      "chat:tg:42",
    ]);
  });

  it("appendHistory дописывает пару к существующей истории одним SET с обновлением TTL", async () => {
    const existing = [{ role: "user", content: "старый вопрос" }];
    let saved: unknown;
    stubUpstash((command) => {
      if (command[0] === "get") return ok(JSON.stringify(existing));
      saved = command;
      return ok("OK");
    });

    await appendHistory("chat:web:abc", [{ role: "assistant", content: "ответ" }]);

    expect(saved).toEqual([
      "set",
      "chat:web:abc",
      JSON.stringify([
        { role: "user", content: "старый вопрос" },
        { role: "assistant", content: "ответ" },
      ]),
      "EX",
      String(HISTORY_TTL_SECONDS),
    ]);
  });

  it("appendHistory с пустым списком — no-op без обращения к Redis", async () => {
    const fetchMock = stubFetchThatMustNotBeCalled();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    await appendHistory("chat:web:abc", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("помощники ключей формируют префиксы chat:web / chat:tg", () => {
    expect(webKey("abc")).toBe("chat:web:abc");
    expect(tgKey(42)).toBe("chat:tg:42");
  });
});

describe("store: env-имена (два семейства одной базы)", () => {
  it("KV_REST_API_URL/TOKEN (интеграция Vercel Marketplace) работают как источник", async () => {
    vi.stubEnv("KV_REST_API_URL", "http://kv.test/");
    vi.stubEnv("KV_REST_API_TOKEN", "kv-token");
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ok("OK"));
    vi.stubGlobal("fetch", fetchMock);

    await setValue("chat:web:abc", "x", 60);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://kv.test");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kv-token");
  });

  it("оба семейства заданы → берётся приоритетная UPSTASH-пара", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "upstash-token");
    vi.stubEnv("KV_REST_API_URL", "http://kv.test");
    vi.stubEnv("KV_REST_API_TOKEN", "kv-token");
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ok("OK"));
    vi.stubGlobal("fetch", fetchMock);

    await setValue("chat:web:abc", "x", 60);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://upstash.test");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer upstash-token");
  });

  it("пары не смешиваются: URL из одного семейства и токен из другого → stateless", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.test");
    vi.stubEnv("KV_REST_API_TOKEN", "kv-token");
    const fetchMock = stubFetchThatMustNotBeCalled();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(getValue("chat:web:abc")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("store: fail-open (любая проблема — пустой результат без throw)", () => {
  it("env не задан (пустые строки): getValue → null, appendHistory — no-op, fetch не зовётся", async () => {
    // Пустые строки вместо удаления env: restEnv тримит и считает их отсутствием.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const fetchMock = stubFetchThatMustNotBeCalled();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(getValue("chat:web:abc")).resolves.toBeNull();
    await expect(getHistory("chat:web:abc")).resolves.toEqual([]);
    await appendHistory("chat:web:abc", [{ role: "user", content: "вопрос" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REST вернул 500 → пустая история, запись не падает", async () => {
    stubUpstash(async () => new Response("boom", { status: 500 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(getHistory("chat:web:abc")).resolves.toEqual([]);
    await expect(setValue("chat:web:abc", "x", 60)).resolves.toBeUndefined();
  });

  it("fetch бросил (сеть недоступна) → пустая история, запись не падает", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(getHistory("chat:web:abc")).resolves.toEqual([]);
    await expect(
      appendHistory("chat:web:abc", [{ role: "user", content: "в" }]),
    ).resolves.toBeUndefined();
  });

  it("Upstash вернул {error} → пустая история", async () => {
    stubUpstash(
      async () =>
        new Response(JSON.stringify({ error: "ERR max requests limit exceeded" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(getHistory("chat:web:abc")).resolves.toEqual([]);
  });

  it("история — битый JSON → пустой массив", async () => {
    stubUpstash(() => ok("{oops"));
    await expect(getHistory("chat:web:abc")).resolves.toEqual([]);
  });

  it("история — не массив (строка/объект/null) → пустой массив", async () => {
    stubUpstash((_command) => ok(JSON.stringify({ role: "user" })));
    await expect(getHistory("chat:web:abc")).resolves.toEqual([]);

    stubUpstash((_command) => ok(JSON.stringify("строка")));
    await expect(getHistory("chat:web:abc")).resolves.toEqual([]);
  });

  it("элементы с неверным role/content (и не-объекты) отфильтровываются, валидные остаются", async () => {
    const raw = [
      { role: "user", content: "валидный" },
      { role: "system", content: "чужая роль" },
      { role: "user", content: 42 },
      { role: "user" },
      null,
      "строка",
      { role: "assistant", content: "валидный ответ" },
    ];
    stubUpstash((_command) => ok(JSON.stringify(raw)));
    await expect(getHistory("chat:web:abc")).resolves.toEqual([
      { role: "user", content: "валидный" },
      { role: "assistant", content: "валидный ответ" },
    ]);
  });

  it("ping: REST упал → ok:false с причиной, без throw", async () => {
    stubUpstash(async () => new Response("boom", { status: 500 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await import("../store").then((m) => m.ping());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("PONG");
  });
});
