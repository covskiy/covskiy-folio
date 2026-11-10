import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfig, type LlmProviderSettings } from "../config";
import { createLlm, type LlmMessage } from "../llm/index";
import { createOpenAiAdapter } from "../llm/openai";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Тип мока fetch: сигнатура как у реального — обращения к mock.calls типизированы. */
type FetchMock = ReturnType<
  typeof vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>
>;

/** Ответ chat/completions с текстом в choices[0].message.content. */
function llmResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** env одного провайдера; объект мутабелен — проверяем резолв на вызов. */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    LLM_1_BASE_URL: "http://127.0.0.1:9999/v1",
    LLM_1_MODEL: "test-model",
    ...overrides,
  };
}

/** Два слота: порядок one → two = порядок попыток. */
function twoProviders(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    LLM_1_ID: "one",
    LLM_1_BASE_URL: "http://one.test/v1",
    LLM_1_MODEL: "one-model",
    LLM_2_ID: "two",
    LLM_2_BASE_URL: "http://two.test/v1",
    LLM_2_MODEL: "two-model",
    ...overrides,
  };
}

/** Инъекция config вместо env-мешка: значения литералами, парсинг в config.ts. */
function makeConfig(overrides: Record<string, string | undefined> = {}) {
  return createConfig(makeEnv(overrides));
}

/** Тихий логгер: падения провайдеров в тестах не должны шуметь в консоль. */
const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  warnThrottled() {},
};

/** Мок по адресу: ключ — подстрока URL, значение — обработчик. */
function routeFetch(
  routes: Array<[string, (url: string, init?: RequestInit) => Response | Promise<Response>]>,
): FetchMock {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const route = routes.find(([needle]) => href.includes(needle));
    if (!route) throw new Error(`unexpected fetch: ${href}`);
    return route[1](href, init);
  });
}

describe("chat: цепочка провайдеров", () => {
  it("нет провайдеров → throw с текстом и issues, без сети", async () => {
    const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();
    const llm = createLlm({
      config: createConfig({ LLM_1_BASE_URL: "https://x" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).rejects.toThrow(
      "LLM не настроен: нет LLM-провайдеров (LLM_1_*: нужны BASE_URL и MODEL",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("первый провайдер ответил → второй не вызывается", async () => {
    const fetchMock = routeFetch([["one.test", () => llmResponse("первый")]]);
    const llm = createLlm({
      config: createConfig(twoProviders()),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).resolves.toBe("первый");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://one.test/v1/chat/completions");
  });

  it("первый упал с 500 → второй ответил", async () => {
    const fetchMock = routeFetch([
      ["one.test", () => new Response("boom", { status: 500 })],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders()),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).resolves.toBe("второй");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["сеть", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["пустой ответ", () => Promise.resolve(llmResponse("   "))],
    ["битый JSON", () => Promise.resolve(new Response("not-json", { status: 200 }))],
  ])("первый упал (%s) → второй ответил", async (_name, firstResponse) => {
    const fetchMock = routeFetch([
      ["one.test", firstResponse],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders()),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).resolves.toBe("второй");
  });

  it("все упали → агрегированная ошибка с id и причинами, без секретов", async () => {
    const fetchMock = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;
    const llm = createLlm({
      config: createConfig(
        twoProviders({
          LLM_1_API_KEY: "secret-one",
          LLM_2_API_KEY: "secret-two",
        }),
      ),
      fetchImpl: fetchMock,
      log: silentLog,
    });

    const error = await llm.chat([{ role: "user", content: "вопрос" }]).catch((reason) => reason);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe(
      "LLM: все провайдеры недоступны (one: LLM endpoint вернул 500; two: LLM endpoint вернул 500)",
    );
    expect(message).not.toContain("secret-one");
    expect(message).not.toContain("secret-two");
  });

  it("LLM_MAX_TOKENS и Authorization уходят в запрос каждого провайдера", async () => {
    const fetchMock = routeFetch([
      ["one.test", () => new Response("boom", { status: 500 })],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(
        twoProviders({
          LLM_MAX_TOKENS: "2048",
          LLM_1_API_KEY: "secret-one",
          LLM_2_API_KEY: "secret-two",
        }),
      ),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    await llm.chat([{ role: "user", content: "вопрос" }]);

    for (const [index, expectedKey] of ["secret-one", "secret-two"].entries()) {
      const [, init] = fetchMock.mock.calls[index];
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = JSON.parse(String(init?.body)) as { max_tokens: number };
      expect(headers.Authorization).toBe(`Bearer ${expectedKey}`);
      expect(body.max_tokens).toBe(2_048);
    }
  });

  it("LLM_n_TIMEOUT_MS переопределяет общий таймаут попытки", async () => {
    const fetchMock = routeFetch([
      [
        "one.test",
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(llmResponse("поздно")), 50);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("The operation was aborted"));
            });
          }),
      ],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_1_TIMEOUT_MS: "10" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).resolves.toBe("второй");
  });

  it("общий бюджет: после исчерпания дедлайна оставшиеся не вызываются", async () => {
    let now = 0;
    const fetchMock = vi.fn(async () => {
      now += 100;
      return new Response("boom", { status: 500 });
    });
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_TOTAL_TIMEOUT_MS: "50" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    const error = await llm.chat([{ role: "user", content: "вопрос" }]).catch((reason) => reason);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toContain("two: бюджет времени исчерпан");
  });

  it("общий бюджет: второй получает остаток после быстрого падения первого", async () => {
    let now = 0;
    const fetchMock = routeFetch([
      [
        "one.test",
        () => {
          now += 20;
          return new Response("boom", { status: 500 });
        },
      ],
      [
        "two.test",
        () => {
          now += 10;
          return llmResponse("второй");
        },
      ],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_TOTAL_TIMEOUT_MS: "100" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).resolves.toBe("второй");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("chat: cooldown в тёплом инстансе", () => {
  it("после падения первый пропускается на следующем запросе", async () => {
    let now = 0;
    const fetchMock = routeFetch([
      [
        "one.test",
        () => {
          now += 1;
          return new Response("boom", { status: 500 });
        },
      ],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_COOLDOWN_MS: "1000" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "1" }])).resolves.toBe("второй");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // now = 1, cooldown первого до 1001 — второй запрос идёт сразу ко второму.
    await expect(llm.chat([{ role: "user", content: "2" }])).resolves.toBe("второй");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("two.test");
  });

  it("cooldown истёк → первый снова пробуется первым", async () => {
    let now = 0;
    let oneHealthy = false;
    const fetchMock = routeFetch([
      [
        "one.test",
        () =>
          oneHealthy
            ? llmResponse("первый снова")
            : (() => {
                now += 1;
                return new Response("boom", { status: 500 });
              })(),
      ],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_COOLDOWN_MS: "1000" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "1" }])).resolves.toBe("второй");

    now = 1001;
    oneHealthy = true;
    await expect(llm.chat([{ role: "user", content: "2" }])).resolves.toBe("первый снова");
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("one.test");
  });

  it("успех очищает cooldown: при откате часов провайдер всё равно свежий", async () => {
    let now = 0;
    let oneHealthy = false;
    const fetchMock = routeFetch([
      [
        "one.test",
        () =>
          oneHealthy
            ? llmResponse("первый")
            : (() => {
                now += 1;
                return new Response("boom", { status: 500 });
              })(),
      ],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_COOLDOWN_MS: "1000" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "1" }])).resolves.toBe("второй");

    // Прошёл cooldown, первый восстановился и ответил — запись снята.
    now = 1001;
    oneHealthy = true;
    await expect(llm.chat([{ role: "user", content: "2" }])).resolves.toBe("первый");

    // Часы «назад»: если бы запись осталась (downUntil 1001), первый был бы в
    // cooldown и ответил бы второй. Успех обязан был её удалить.
    now = 500;
    await expect(llm.chat([{ role: "user", content: "3" }])).resolves.toBe("первый");
  });

  it("все в cooldown → half-open пробует всех по порядку", async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    let now = 0;
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_COOLDOWN_MS: "1000" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    await expect(llm.chat([{ role: "user", content: "1" }])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Оба в cooldown — цепочка не блокируется и пробует всех снова.
    now = 1;
    await expect(llm.chat([{ role: "user", content: "2" }])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[2][0])).toContain("one.test");
    expect(String(fetchMock.mock.calls[3][0])).toContain("two.test");
  });

  it("primary упал, backup в cooldown → backup всё равно пробуется", async () => {
    let now = 0;
    let oneHealthy = false;
    let twoHealthy = false;
    const fetchMock = routeFetch([
      [
        "one.test",
        () => (oneHealthy ? llmResponse("первый") : new Response("boom", { status: 500 })),
      ],
      [
        "two.test",
        () => (twoHealthy ? llmResponse("второй") : new Response("boom", { status: 500 })),
      ],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_COOLDOWN_MS: "1000" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    // t=0: падают оба → оба в cooldown до 1000.
    await expect(llm.chat([{ role: "user", content: "1" }])).rejects.toThrow();

    // t=600: half-open, первый восстановился — успех снимает только его запись.
    now = 600;
    oneHealthy = true;
    await expect(llm.chat([{ role: "user", content: "2" }])).resolves.toBe("первый");

    // t=700: первый снова упал, backup ещё в cooldown (до 1000) — его добираем.
    now = 700;
    oneHealthy = false;
    twoHealthy = true;
    await expect(llm.chat([{ role: "user", content: "3" }])).resolves.toBe("второй");
  });

  it("ping не трогает cooldown-состояние цепочки", async () => {
    let now = 0;
    let oneHealthy = false;
    const fetchMock = routeFetch([
      [
        "one.test",
        () => (oneHealthy ? llmResponse("первый") : new Response("boom", { status: 500 })),
      ],
      ["two.test", () => llmResponse("второй")],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_COOLDOWN_MS: "1000" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });

    // t=0: первый падает — в cooldown до 1000, отвечает второй.
    await expect(llm.chat([{ role: "user", content: "1" }])).resolves.toBe("второй");

    // Health опрашивает всех (первый уже жив), но сбрасывать cooldown не вправе:
    // иначе следующий chat снова начал бы с провайдера, которого цепочка пропускает.
    oneHealthy = true;
    await expect(llm.ping()).resolves.toMatchObject({ ok: true });
    await expect(llm.chat([{ role: "user", content: "2" }])).resolves.toBe("второй");
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("two.test");
  });

  it("состояние не течёт между разными инстансами createLlm()", async () => {
    const config = createConfig(twoProviders({ LLM_COOLDOWN_MS: "1000" }));
    let now = 0;

    const failing = routeFetch([
      ["one.test", () => new Response("boom", { status: 500 })],
      ["two.test", () => llmResponse("второй")],
    ]);
    const first = createLlm({
      config,
      fetchImpl: failing as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });
    await expect(first.chat([{ role: "user", content: "1" }])).resolves.toBe("второй");

    // Второй инстанс не знает про cooldown первого — пробует primary снова.
    const healthy = routeFetch([["one.test", () => llmResponse("первый")]]);
    const second = createLlm({
      config,
      fetchImpl: healthy as unknown as typeof fetch,
      clock: () => now,
      log: silentLog,
    });
    await expect(second.chat([{ role: "user", content: "2" }])).resolves.toBe("первый");
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("fetch/config резолвятся на каждый вызов: подмена после создания фабрики видна", async () => {
    // Если резолвить deps при создании, подмена глобального fetch
    // (vi.stubGlobal) и env (vi.stubEnv → дефолтный config) после импорта была
    // бы невидима. Ленивость config детально покрыта в config.test.ts.
    const llm = createLlm({ log: silentLog }); // без deps — глобальный fetch и дефолтный config
    vi.stubEnv("LLM_1_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_1_MODEL", "test-model");
    const fetchMock = vi.fn(async () => llmResponse("Ок"));
    vi.stubGlobal("fetch", fetchMock);

    await llm.chat([{ role: "user", content: "вопрос" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ping", () => {
  it('нет провайдеров → {ok:false, error:"не настроен…", providers:[], issues}', async () => {
    const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();
    const llm = createLlm({
      config: createConfig({}),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    await expect(llm.ping()).resolves.toEqual({
      ok: false,
      error: "не настроен: нет LLM-провайдеров",
      providers: [],
      issues: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("пробы всех провайдеров идут параллельно", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response("[]", { status: 200 });
    });
    const llm = createLlm({
      config: createConfig(twoProviders()),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    const pending = llm.ping();
    // Обе пробы должны стартовать до того, как разрешится хоть одна.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    release();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.providers.map((provider) => provider.id)).toEqual(["one", "two"]);
  });

  it("частичный успех: ok:true, верхние latencyMs/detail — у первого здорового", async () => {
    const fetchMock = routeFetch([
      ["one.test", () => new Response("[]", { status: 200 })],
      ["two.test", () => new Response("down", { status: 429 })],
    ]);
    const llm = createLlm({
      config: createConfig(twoProviders()),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    const result = await llm.ping();

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(result.detail).toBe("GET /models");
    expect(result.providers).toEqual([
      { id: "one", ok: true, latencyMs: expect.any(Number), detail: "GET /models" },
      { id: "two", ok: false, error: "endpoint вернул 429" },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("latencyMs считается по clock из deps", async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    // Часы-счётчик: каждое обращение +500 мс — latencyMs считается по clock.
    let ticks = 0;
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => (ticks += 500),
      log: silentLog,
    });

    const result = await llm.ping();

    expect(result).toEqual({
      ok: true,
      latencyMs: 500,
      detail: "GET /models",
      providers: [{ id: "provider-1", ok: true, latencyMs: 500, detail: "GET /models" }],
      issues: [],
    });
  });

  it("все упали → ok:false с id и причинами, без секретов", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    const llm = createLlm({
      config: createConfig(twoProviders({ LLM_1_API_KEY: "secret-one" })),
      fetchImpl: fetchMock as unknown as typeof fetch,
      log: silentLog,
    });

    const result = await llm.ping();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "все провайдеры недоступны (one: endpoint вернул 503; two: endpoint вернул 503)",
    );
    expect(result.error).not.toContain("secret-one");
  });

  it("сеть падает исключением → ok:false, ping не бросает", async () => {
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      log: silentLog,
    });

    await expect(llm.ping()).resolves.toEqual({
      ok: false,
      error: "все провайдеры недоступны (provider-1: ECONNREFUSED)",
      providers: [{ id: "provider-1", ok: false, error: "ECONNREFUSED" }],
      issues: [],
    });
  });

  it("issues конфига уходят в health даже при пустой цепочке", async () => {
    const llm = createLlm({
      config: createConfig({ LLM_1_BASE_URL: "https://x" }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      log: silentLog,
    });

    const result = await llm.ping();

    expect(result.providers).toEqual([]);
    expect(result.issues).toEqual([expect.stringContaining("LLM_1_*")]);
  });
});

describe("createOpenAiAdapter", () => {
  const settings: LlmProviderSettings = {
    id: "provider-1",
    kind: "openai",
    baseUrl: "http://adapter.test/v1",
    apiKey: "secret-key",
    model: "test-model",
    timeoutMs: 1_000,
  };
  const messages: LlmMessage[] = [
    { role: "system", content: "system-промт" },
    { role: "user", content: "вопрос" },
  ];

  it("chat: URL, payload, Bearer и messages как есть", async () => {
    const fetchMock: FetchMock = vi.fn(async () => llmResponse("  ответ  "));
    const adapter = createOpenAiAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(
      adapter.chat(settings, messages, { maxTokens: 512, timeoutMs: 900 }),
    ).resolves.toBe("ответ");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://adapter.test/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "test-model",
      messages,
      temperature: 0.3,
      max_tokens: 512,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("chat: без apiKey заголовка Authorization нет", async () => {
    const fetchMock: FetchMock = vi.fn(async () => llmResponse("Ок"));
    const adapter = createOpenAiAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await adapter.chat({ ...settings, apiKey: undefined }, messages, {
      maxTokens: 1,
      timeoutMs: 100,
    });

    const headers = (fetchMock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("chat: не-2xx → throw «LLM endpoint вернул N»", async () => {
    const adapter = createOpenAiAdapter({
      fetchImpl: vi.fn(
        async () => new Response("boom", { status: 500 }),
      ) as unknown as typeof fetch,
    });

    await expect(
      adapter.chat(settings, messages, { maxTokens: 1, timeoutMs: 100 }),
    ).rejects.toThrow("LLM endpoint вернул 500");
  });

  it("chat: пустой content → throw «LLM вернул пустой ответ»", async () => {
    const adapter = createOpenAiAdapter({
      fetchImpl: vi.fn(async () => llmResponse("   ")) as unknown as typeof fetch,
    });

    await expect(
      adapter.chat(settings, messages, { maxTokens: 1, timeoutMs: 100 }),
    ).rejects.toThrow("LLM вернул пустой ответ");
  });

  it("probe: /models ок → ok:true, detail «GET /models», Bearer уходит", async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    const adapter = createOpenAiAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(adapter.probe(settings, { timeoutMs: 500 })).resolves.toEqual({
      ok: true,
      detail: "GET /models",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://adapter.test/v1/models");
    expect(init?.method).toBeUndefined(); // GET, не тратит токены
    expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe(
      "Bearer secret-key",
    );
  });

  it("probe: /models не ок → fallback на минимальный chat/completions", async () => {
    const fetchMock = routeFetch([
      ["/models", () => new Response("nope", { status: 404 })],
      ["/chat/completions", () => llmResponse("pong")],
    ]);
    const adapter = createOpenAiAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(adapter.probe(settings, { timeoutMs: 500 })).resolves.toEqual({
      ok: true,
      detail: "POST /chat/completions (минимальный запрос)",
    });
    const [, init] = fetchMock.mock.calls[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  });

  it("probe: оба endpoint не ок → ok:false со статусом последнего", async () => {
    const adapter = createOpenAiAdapter({
      fetchImpl: vi.fn(
        async () => new Response("down", { status: 503 }),
      ) as unknown as typeof fetch,
    });

    await expect(adapter.probe(settings, { timeoutMs: 500 })).resolves.toEqual({
      ok: false,
      error: "endpoint вернул 503",
    });
  });

  it("probe: сеть падает → ok:false, не бросает", async () => {
    const adapter = createOpenAiAdapter({
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(adapter.probe(settings, { timeoutMs: 500 })).resolves.toEqual({
      ok: false,
      error: "ECONNREFUSED",
    });
  });

  it("fetchImpl резолвится на каждый вызов: подмена после создания адаптера видна", async () => {
    const adapter = createOpenAiAdapter();
    const fetchMock = vi.fn(async () => llmResponse("Ок"));
    vi.stubGlobal("fetch", fetchMock);

    await adapter.chat(settings, messages, { maxTokens: 1, timeoutMs: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
