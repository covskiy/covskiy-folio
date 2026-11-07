import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendHistory,
  clearHistory,
  getHistory,
  getValue,
  HISTORY_TTL_SECONDS,
  incrCounter,
  isSeen,
  markSeen,
  setValue,
  tgKey,
  tgSeenKey,
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

  it("appendHistory обрезает историю до последних 20 сообщений", async () => {
    const existing = Array.from({ length: 19 }, (_, i) => ({
      role: "user" as const,
      content: `старое ${i}`,
    }));
    let saved: Array<{ role: string; content: string }> = [];
    stubUpstash((command) => {
      if (command[0] === "get") return ok(JSON.stringify(existing));
      saved = JSON.parse(String(command[2])) as Array<{ role: string; content: string }>;
      return ok("OK");
    });

    await appendHistory("chat:web:abc", [
      { role: "assistant", content: "ответ 19" },
      { role: "assistant", content: "ответ 20" },
    ]);

    expect(saved).toHaveLength(20);
    expect(saved[0]).toEqual({ role: "user", content: "старое 1" });
    expect(saved.at(-1)).toEqual({ role: "assistant", content: "ответ 20" });
  });

  it("appendHistory обрезает реплику длиннее 4000 символов", async () => {
    let saved: Array<{ role: string; content: string }> = [];
    stubUpstash((command) => {
      if (command[0] === "get") return ok(null);
      saved = JSON.parse(String(command[2])) as Array<{ role: string; content: string }>;
      return ok("OK");
    });

    await appendHistory("chat:web:abc", [{ role: "user", content: "x".repeat(4_500) }]);

    expect(saved).toHaveLength(1);
    expect(saved[0].content).toHaveLength(4_000);
  });

  it("incrCounter шлёт pipeline [incr, expire NX] одним POST и возвращает счётчик", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    let body: unknown;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      // Ответ pipeline — массив {result} по элементам, а не {result} целиком.
      return new Response(JSON.stringify([{ result: 3 }, { result: 1 }]));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(incrCounter("rate:web:1", 3600)).resolves.toBe(3);
    expect(body).toEqual([
      ["incr", "rate:web:1"],
      // NX: TTL только если его нет — окно стартует с первого хита, не скользит
      ["expire", "rate:web:1", "3600", "NX"],
    ]);
  });

  it("incrCounter: ошибка в элементе pipeline → null (fail-open)", async () => {
    stubUpstash(
      () =>
        new Response(JSON.stringify([{ error: "WRONGTYPE" }, { result: 1 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(incrCounter("rate:web:1", 3600)).resolves.toBeNull();
  });

  it("помощники ключей формируют префиксы chat:web / chat:tg / tg:seen", () => {
    expect(webKey("abc")).toBe("chat:web:abc");
    expect(tgKey(42)).toBe("chat:tg:42");
    expect(tgSeenKey(987654)).toBe("tg:seen:987654");
  });
});

describe("store: дедупликация Telegram-апдейтов (isSeen / markSeen)", () => {
  it("isSeen: без маркера false; после markSeen true", async () => {
    const store = new Map<string, string>();
    stubUpstash((command) => {
      if (command[0] === "get") return ok(store.get(String(command[1])) ?? null);
      store.set(String(command[1]), String(command[2]));
      return ok("OK");
    });

    await expect(isSeen("tg:seen:987654")).resolves.toBe(false);
    await markSeen("tg:seen:987654", 3600);
    await expect(isSeen("tg:seen:987654")).resolves.toBe(true);
  });

  it("markSeen шлёт [set, key, 1, EX, ttl, NX]: маркер «1», NX — страховка от гонки", async () => {
    const fetchMock = stubUpstash(() => ok("OK"));

    await markSeen("tg:seen:987654", 3600);

    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual([
      "set",
      "tg:seen:987654",
      "1",
      "EX",
      "3600",
      "NX",
    ]);
  });

  it("fail-open: REST падает исключением → isSeen false, markSeen no-op без throw", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", REDIS_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Дедупликация — улучшение, а не условие работы: любая проблема Redis
    // означает «не видели» и «не запомнили», обработка продолжается.
    await expect(isSeen("tg:seen:987654")).resolves.toBe(false);
    await expect(markSeen("tg:seen:987654", 3600)).resolves.toBeUndefined();
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
