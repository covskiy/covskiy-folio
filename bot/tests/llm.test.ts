import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfig } from "../config";
import { createLlm, type LlmMessage } from "../llm";

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

/** env с минимальной конфигурацией LLM; объект мутабелен — проверяем резолв на вызов. */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    LLM_BASE_URL: "http://127.0.0.1:9999/v1",
    LLM_MODEL: "test-model",
    ...overrides,
  };
}

/** Инъекция config вместо env-мешка: значения литералами, парсинг в config.ts. */
function makeConfig(overrides: Record<string, string | undefined> = {}) {
  return createConfig(makeEnv(overrides));
}

/** Мок fetch, уважающий signal, как реальный: иначе AbortSignal.timeout не протестировать. */
function slowFetch(delayMs: number, response: () => Response): FetchMock {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("The operation was aborted"));
      });
    });
    return response();
  });
}

describe("chat", () => {
  it("не настроен (нет LLM_BASE_URL/LLM_MODEL) → throw с точным текстом, без сети", async () => {
    const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();
    const llm = createLlm({
      config: createConfig({ LLM_BASE_URL: "", LLM_MODEL: undefined }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).rejects.toThrow(
      "LLM не настроен: нужны LLM_BASE_URL и LLM_MODEL",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("не-2xx → throw «LLM endpoint вернул N»", async () => {
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: vi.fn(
        async () => new Response("boom", { status: 500 }),
      ) as unknown as typeof fetch,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).rejects.toThrow(
      "LLM endpoint вернул 500",
    );
  });

  it("пустой content → throw «LLM вернул пустой ответ»", async () => {
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: vi.fn(async () => llmResponse("   ")) as unknown as typeof fetch,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).rejects.toThrow(
      "LLM вернул пустой ответ",
    );
  });

  it("успех → обрезанный (trim) текст ответа", async () => {
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: vi.fn(async () => llmResponse("  ответ с пробелами  ")) as unknown as typeof fetch,
    });

    await expect(llm.chat([{ role: "user", content: "вопрос" }])).resolves.toBe(
      "ответ с пробелами",
    );
  });

  it("messages уходят в body как есть — system ставит brain, не транспорт", async () => {
    const fetchMock: FetchMock = vi.fn(async () => llmResponse("Ок"));
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const messages: LlmMessage[] = [
      { role: "system", content: "system-промт" },
      { role: "user", content: "вопрос" },
    ];

    await llm.chat(messages);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9999/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as { messages: LlmMessage[] };
    expect(body.messages).toEqual(messages);
  });

  it("Authorization — только при заданном LLM_API_KEY; без ключа заголовка нет", async () => {
    const fetchMock: FetchMock = vi.fn(async () => llmResponse("Ок"));
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await llm.chat([{ role: "user", content: "без ключа" }]);
    let headers = (fetchMock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();

    const llmWithKey = createLlm({
      config: makeConfig({ LLM_API_KEY: "secret-key" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await llmWithKey.chat([{ role: "user", content: "с ключом" }]);
    headers = (fetchMock.mock.calls[1][1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
  });

  it("LLM_MAX_TOKENS попадает в body; мусор/ноль — снова дефолт 1024", async () => {
    const fetchMock: FetchMock = vi.fn(async () => llmResponse("Ок"));
    // env-объект мутабелен, config над ним — ленивый: правки между вызовами
    // видны, потому что (deps.config ?? config).llm резолвится НА КАЖДЫЙ вызов.
    const env = makeEnv();
    const llm = createLlm({
      config: createConfig(env),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const bodyMaxTokens = (): number => {
      const [, init] = fetchMock.mock.calls.at(-1)!;
      return (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens;
    };

    await llm.chat([{ role: "user", content: "вопрос" }]);
    expect(bodyMaxTokens()).toBe(1_024);

    env.LLM_MAX_TOKENS = "2048";
    await llm.chat([{ role: "user", content: "вопрос" }]);
    expect(bodyMaxTokens()).toBe(2_048);

    env.LLM_MAX_TOKENS = "мусор";
    await llm.chat([{ role: "user", content: "вопрос" }]);
    expect(bodyMaxTokens()).toBe(1_024);
  });

  it("LLM_TIMEOUT_MS: ответ дольше лимита → throw; мусор в env — дефолт 15 с", async () => {
    const slow = slowFetch(50, () => llmResponse("поздно"));
    const llm = createLlm({
      config: makeConfig({ LLM_TIMEOUT_MS: "10" }),
      fetchImpl: slow as unknown as typeof fetch,
    });
    await expect(llm.chat([{ role: "user", content: "вопрос" }])).rejects.toThrow();

    const patient = slowFetch(20, () => llmResponse("успел"));
    const lenient = createLlm({
      config: makeConfig({ LLM_TIMEOUT_MS: "не-число" }),
      fetchImpl: patient as unknown as typeof fetch,
    });
    await expect(lenient.chat([{ role: "user", content: "вопрос" }])).resolves.toBe("успел");
  });

  it("fetch/config резолвятся на каждый вызов: подмена после создания фабрики видна", async () => {
    // Если резолвить deps при создании, подмена глобального fetch
    // (vi.stubGlobal) и env (vi.stubEnv → дефолтный config) после импорта была
    // бы невидима. Ленивость config детально покрыта в config.test.ts;
    // инъекционный вариант — в тесте max_tokens выше.
    const llm = createLlm(); // без deps — глобальный fetch и дефолтный config
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
    vi.stubEnv("LLM_MODEL", "test-model");
    const fetchMock = vi.fn(async () => llmResponse("Ок"));
    vi.stubGlobal("fetch", fetchMock);

    await llm.chat([{ role: "user", content: "вопрос" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ping", () => {
  it('не настроен → {ok:false, error:"не настроен…"}, без сети', async () => {
    const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();
    const llm = createLlm({
      config: createConfig({}),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(llm.ping()).resolves.toEqual({
      ok: false,
      error: "не настроен: нужны LLM_BASE_URL и LLM_MODEL",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("/models ок → ok:true, detail «GET /models», latencyMs по clock", async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    // Часы-счётчик: каждое обращение +500 мс — latencyMs считается по clock.
    let ticks = 0;
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      clock: () => (ticks += 500),
    });

    const result = await llm.ping();

    expect(result).toEqual({ ok: true, latencyMs: 500, detail: "GET /models" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9999/v1/models");
    expect(init?.method).toBeUndefined(); // GET, не тратит токены
  });

  it("/models не ок → fallback на минимальный chat/completions → ok:true", async () => {
    const fetchMock: FetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/models") ? new Response("nope", { status: 404 }) : llmResponse("pong"),
    );
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await llm.ping();

    expect(result).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
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

  it("оба endpoint не ок → ok:false со статусом последнего ответа", async () => {
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: vi.fn(
        async () => new Response("down", { status: 503 }),
      ) as unknown as typeof fetch,
    });

    await expect(llm.ping()).resolves.toEqual({ ok: false, error: "endpoint вернул 503" });
  });

  it("сеть падает исключением → ok:false с текстом причины", async () => {
    const llm = createLlm({
      config: makeConfig(),
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(llm.ping()).resolves.toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});
