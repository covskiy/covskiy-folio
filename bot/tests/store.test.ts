import { describe, expect, it, vi } from "vitest";
import { createConfig } from "../config";
import type { RedisRest } from "../redis-rest";
import { createStore, HISTORY_TTL_SECONDS, type StoreDeps } from "../store";

// Домен тестируется через фейковый command/pipeline — без vi.stubGlobal и без
// сети: transport-контракт (fail-open → null вместо throw) воспроизводится
// возвращаемым значением фейка, как у реального redis-rest.

/** Моки command/pipeline фейкового транспорта. */
type CommandMock = ReturnType<typeof vi.fn<(command: unknown[]) => Promise<unknown>>>;
type PipelineMock = ReturnType<
  typeof vi.fn<(commands: unknown[][]) => Promise<(unknown | null)[] | null>>
>;

/**
 * Фейковый транспорт: опциональные хендлеры отвечают на команды, без хендлера —
 * null (как реальный transport при недоступном Redis).
 */
function fakeRedis(
  handlers: {
    command?: (command: unknown[]) => unknown;
    pipeline?: (commands: unknown[][]) => (unknown | null)[] | null;
  } = {},
): { redis: RedisRest; command: CommandMock; pipeline: PipelineMock } {
  const command = vi.fn(async (c: unknown[]) => (handlers.command ? handlers.command(c) : null));
  const pipeline = vi.fn(async (cs: unknown[][]) =>
    handlers.pipeline ? handlers.pipeline(cs) : null,
  );
  return { redis: { command, pipeline }, command, pipeline };
}

/** Хендлеры фейкового транспорта; строка-функция — shorthand для command. */
type Handlers = Parameters<typeof fakeRedis>[0];
type HandlerArg = Handlers | ((command: unknown[]) => unknown);

/** createStore с фейковым транспортом (config не нужен: его читает только ping). */
function makeStore(handlers: HandlerArg = {}, deps: Omit<StoreDeps, "redis"> = {}) {
  const resolved: Handlers = typeof handlers === "function" ? { command: handlers } : handlers;
  const fake = fakeRedis(resolved);
  return { store: createStore({ ...deps, redis: fake.redis }), ...fake };
}

/** Ответ одиночной команды, как его отдаёт реальный transport (data.result). */
function ok(result: unknown): unknown {
  return result;
}

describe("store: история (getHistory / appendHistory / clearHistory)", () => {
  it("getHistory парсит JSON-историю из GET", async () => {
    const { store, command } = makeStore(() =>
      ok(JSON.stringify([{ role: "user", content: "вопрос" }])),
    );

    await expect(store.getHistory("chat:tg:42")).resolves.toEqual([
      { role: "user", content: "вопрос" },
    ]);
    expect(command).toHaveBeenCalledWith(["get", "chat:tg:42"]);
  });

  it("история — битый JSON → пустой массив (ключи из данных клиента, не повод ронять)", async () => {
    const { store } = makeStore(() => ok("{oops"));
    await expect(store.getHistory("chat:web:abc")).resolves.toEqual([]);
  });

  it("история — не массив (объект/строка) → пустой массив", async () => {
    const { store } = makeStore(() => ok(JSON.stringify({ role: "user" })));
    await expect(store.getHistory("chat:web:abc")).resolves.toEqual([]);

    const second = makeStore(() => ok(JSON.stringify("строка")));
    await expect(second.store.getHistory("chat:web:abc")).resolves.toEqual([]);
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
    const { store } = makeStore(() => ok(JSON.stringify(raw)));
    await expect(store.getHistory("chat:web:abc")).resolves.toEqual([
      { role: "user", content: "валидный" },
      { role: "assistant", content: "валидный ответ" },
    ]);
  });

  it("appendHistory дописывает пару к существующей истории одним SET с обновлением TTL (EX)", async () => {
    const existing = [{ role: "user", content: "старый вопрос" }];
    const { store, command } = makeStore((c) => {
      if (c[0] === "get") return ok(JSON.stringify(existing));
      return ok("OK");
    });

    await store.appendHistory("chat:web:abc", [{ role: "assistant", content: "ответ" }]);

    expect(command).toHaveBeenLastCalledWith([
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

  it("appendHistory: истории ещё нет (get → null) → пишет только новые сообщения", async () => {
    const { store, command } = makeStore(() => ok(null));

    await store.appendHistory("chat:web:abc", [{ role: "user", content: "вопрос" }]);

    expect(command).toHaveBeenLastCalledWith([
      "set",
      "chat:web:abc",
      JSON.stringify([{ role: "user", content: "вопрос" }]),
      "EX",
      String(HISTORY_TTL_SECONDS),
    ]);
  });

  it("appendHistory с пустым списком — no-op без обращения к Redis", async () => {
    const { store, command, pipeline } = makeStore();

    await store.appendHistory("chat:web:abc", []);

    expect(command).not.toHaveBeenCalled();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("appendHistory обрезает историю до последних 20 сообщений", async () => {
    const existing = Array.from({ length: 19 }, (_, i) => ({
      role: "user" as const,
      content: `старое ${i}`,
    }));
    let saved: Array<{ role: string; content: string }> = [];
    const { store } = makeStore((c) => {
      if (c[0] === "get") return ok(JSON.stringify(existing));
      saved = JSON.parse(String(c[2])) as Array<{ role: string; content: string }>;
      return ok("OK");
    });

    await store.appendHistory("chat:web:abc", [
      { role: "assistant", content: "ответ 19" },
      { role: "assistant", content: "ответ 20" },
    ]);

    expect(saved).toHaveLength(20);
    expect(saved[0]).toEqual({ role: "user", content: "старое 1" });
    expect(saved.at(-1)).toEqual({ role: "assistant", content: "ответ 20" });
  });

  it("appendHistory обрезает реплику длиннее 4000 символов", async () => {
    let saved: Array<{ role: string; content: string }> = [];
    const { store } = makeStore((c) => {
      if (c[0] === "get") return ok(null);
      saved = JSON.parse(String(c[2])) as Array<{ role: string; content: string }>;
      return ok("OK");
    });

    await store.appendHistory("chat:web:abc", [{ role: "user", content: "x".repeat(4_500) }]);

    expect(saved).toHaveLength(1);
    expect(saved[0].content).toHaveLength(4_000);
  });

  it("appendHistory fail-open: get → null (Redis недоступен) — запись не падает", async () => {
    const { store } = makeStore();
    await expect(
      store.appendHistory("chat:web:abc", [{ role: "user", content: "в" }]),
    ).resolves.toBeUndefined();
  });

  it("clearHistory шлёт DEL ключа", async () => {
    const { store, command } = makeStore(() => ok(1));

    await store.clearHistory("chat:tg:42");

    expect(command).toHaveBeenCalledWith(["del", "chat:tg:42"]);
  });
});

describe("store: примитивы getValue / setValue", () => {
  it("getValue возвращает строковый result", async () => {
    const { store } = makeStore(() => ok("сырое значение"));
    await expect(store.getValue("ключ")).resolves.toBe("сырое значение");
  });

  it("getValue: не-строка (null/число) → null", async () => {
    const { store } = makeStore(() => ok(null));
    await expect(store.getValue("ключ")).resolves.toBeNull();

    const second = makeStore(() => ok(42));
    await expect(second.store.getValue("ключ")).resolves.toBeNull();
  });

  it("setValue шлёт SET с TTL: [set, key, value, EX, ttl]", async () => {
    const { store, command } = makeStore(() => ok("OK"));

    await store.setValue("chat:web:abc", '[{"role":"user"}]', 60);

    expect(command).toHaveBeenCalledWith(["set", "chat:web:abc", '[{"role":"user"}]', "EX", "60"]);
  });
});

describe("store: дедупликация Telegram-апдейтов (isSeen / markSeen)", () => {
  it("isSeen: без маркера false; после markSeen true (маркер «1»)", async () => {
    let marker: unknown = null;
    const { store } = makeStore((c) => {
      if (c[0] === "get") return ok(marker);
      marker = c[2];
      return ok("OK");
    });

    await expect(store.isSeen("tg:seen:987654")).resolves.toBe(false);
    await store.markSeen("tg:seen:987654", 3600);
    expect(marker).toBe("1");
    await expect(store.isSeen("tg:seen:987654")).resolves.toBe(true);
  });

  it("markSeen шлёт [set, key, 1, EX, ttl, NX]: NX — страховка от гонки", async () => {
    const { store, command } = makeStore(() => ok("OK"));

    await store.markSeen("tg:seen:987654", 3600);

    expect(command).toHaveBeenCalledWith(["set", "tg:seen:987654", "1", "EX", "3600", "NX"]);
  });

  it("fail-open: command → null (Redis недоступен) → isSeen false, markSeen no-op без throw", async () => {
    const { store } = makeStore();

    // Дедупликация — улучшение, а не условие работы: любая проблема Redis
    // означает «не видели» и «не запомнили», обработка продолжается.
    await expect(store.isSeen("tg:seen:987654")).resolves.toBe(false);
    await expect(store.markSeen("tg:seen:987654", 3600)).resolves.toBeUndefined();
  });
});

describe("store: incrCounter (лимитер через pipeline)", () => {
  it("берёт значение из pipeline и шлёт [incr, expire NX] одним вызовом", async () => {
    const { store, pipeline } = makeStore({
      pipeline: () => [3, 1],
    });

    await expect(store.incrCounter("rate:web:1", 3600)).resolves.toBe(3);
    expect(pipeline).toHaveBeenCalledWith([
      ["incr", "rate:web:1"],
      // NX: TTL только если его нет — окно стартует с первого хита, не скользит
      ["expire", "rate:web:1", "3600", "NX"],
    ]);
  });

  it("pipeline → null (весь запрос упал) → null (fail-open)", async () => {
    const { store } = makeStore();
    await expect(store.incrCounter("rate:web:1", 3600)).resolves.toBeNull();
  });

  it("ошибка элемента → transport отдал null на месте → null", async () => {
    const { store } = makeStore({ pipeline: () => [null, 1] });
    await expect(store.incrCounter("rate:web:1", 3600)).resolves.toBeNull();
  });

  it("не-число в ответе (строка от мока) → null", async () => {
    const { store } = makeStore({ pipeline: () => ["3", 1] });
    await expect(store.incrCounter("rate:web:1", 3600)).resolves.toBeNull();
  });
});

describe("store: ping (health-check)", () => {
  it("пары в config нет → ok:false «не настроен», redis не вызывается", async () => {
    const { store, command } = makeStore(undefined, { config: createConfig({}) });

    const result = await store.ping();

    expect(result).toEqual({
      ok: false,
      reason: "не настроен: UPSTASH_REDIS_REST_* / KV_REST_API_* отсутствуют",
    });
    expect(command).not.toHaveBeenCalled();
  });

  it("PONG → ok:true с latencyMs", async () => {
    const { store, command } = makeStore(() => ok("PONG"), {
      config: createConfig({
        UPSTASH_REDIS_REST_URL: "http://upstash.test",
        UPSTASH_REDIS_REST_TOKEN: "tok",
      }),
    });

    const result = await store.ping();

    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(command).toHaveBeenCalledWith(["ping"]);
  });

  it("REST упал (command → null) → ok:false с причиной PONG, без throw", async () => {
    const { store } = makeStore(() => ok(null), {
      config: createConfig({
        UPSTASH_REDIS_REST_URL: "http://upstash.test",
        UPSTASH_REDIS_REST_TOKEN: "tok",
      }),
    });

    const result = await store.ping();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("PONG");
  });

  it("пара неполная (только URL) → «не настроен» (пары не смешиваются)", async () => {
    const { store, command } = makeStore(undefined, {
      config: createConfig({ UPSTASH_REDIS_REST_URL: "http://upstash.test" }),
    });

    const result = await store.ping();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("не настроен");
    expect(command).not.toHaveBeenCalled();
  });
});

describe("store: фабрика и дефолтный инстанс", () => {
  it("два инстанса с разными redis не мешают друг другу (одна запись → только в свой redis)", async () => {
    const first = makeStore(() => ok("OK"));
    const second = makeStore(() => ok("OK"));

    await first.store.setValue("chat:web:abc", "x", 60);
    await second.store.getValue("chat:web:abc");

    expect(first.command).toHaveBeenCalledTimes(1);
    expect(first.command).toHaveBeenCalledWith(["set", "chat:web:abc", "x", "EX", "60"]);
    expect(second.command).toHaveBeenCalledTimes(1);
    expect(second.command).toHaveBeenCalledWith(["get", "chat:web:abc"]);
  });

  it("помощники ключей формируют префиксы chat:web / chat:tg / tg:seen", () => {
    const store = createStore();
    expect(store.webKey("abc")).toBe("chat:web:abc");
    expect(store.tgKey(42)).toBe("chat:tg:42");
    expect(store.tgSeenKey(987654)).toBe("tg:seen:987654");
  });

  it("дефолтные экспорты — те же доменные операции (поимённый переэкспорт)", async () => {
    const store = await import("../store");
    // Чистые помощники доступны без сети и env — этого достаточно, чтобы
    // убедиться, что переэкспорт жив; сетевые ветки дефолтного инстанса
    // покрывают тесты webchat/telegram-webhook/telegram-admin.
    expect(store.webKey("abc")).toBe("chat:web:abc");
    expect(store.HISTORY_TTL_SECONDS).toBe(86_400);
    expect(typeof store.appendHistory).toBe("function");
    expect(typeof store.incrCounter).toBe("function");
    expect(typeof store.ping).toBe("function");
  });
});
