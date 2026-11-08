import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebChatHandler } from "../http/webchat";
import { HELP_TEXT_WEBCHAT } from "../brain/help";
import type { KnowledgeItem } from "../brain/knowledge";
import type { ChatMessage } from "../store";

const URL = "http://localhost/api/chat";
const SESSION_ID = "3f2a9c8e-1b4d-4e6f-9a7b-2c5d8e0f1a2b";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface HarnessOptions {
  /** Ответ fakeBrain. */
  llmText?: string;
  /** Режим ответа fakeBrain (по умолчанию llm). */
  mode?: "llm" | "dumb";
  /** Подсказки dumb-fallback от fakeBrain; не заданы — поля в ответе нет. */
  suggestions?: Array<{ id: string; title: string }>;
  /** Порог фейкового лимитера на один бакет (по умолчанию — без лимита). */
  rateLimitMax?: number;
  /** Режим мёртвого Redis: store-фейк ведёт себя fail-open ([] / no-op) — как реальный store при недоступном Redis. */
  deadStore?: boolean;
  /** Записи справки для GET-чипсов (по умолчанию — фикстура из 4 тем). */
  entries?: KnowledgeItem[];
  /** Справка недоступна (load() → null). */
  noKnowledge?: boolean;
}

interface Harness {
  handle: (request: Request) => Promise<Response>;
  history: Map<string, ChatMessage[]>;
  store: {
    getHistory: ReturnType<typeof vi.fn>;
    appendHistory: ReturnType<typeof vi.fn>;
  };
  brain: { answer: ReturnType<typeof vi.fn> };
  limit: ReturnType<typeof vi.fn>;
  knowledge: { load: ReturnType<typeof vi.fn> };
}

/**
 * Собирает обработчик на явных фейках: store — Map-бэкед история, brain —
 * управляемый ответ, limit — счётчик на бакет. Сеть не подменяется — её нет
 * ни в одном пути обработчика.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const history = new Map<string, ChatMessage[]>();
  const dead = options.deadStore === true;

  const store = {
    getHistory: vi.fn(async (key: string): Promise<ChatMessage[]> =>
      dead ? [] : (history.get(key) ?? []),
    ),
    appendHistory: vi.fn(async (key: string, messages: ChatMessage[]): Promise<void> => {
      if (!dead) history.set(key, [...(history.get(key) ?? []), ...messages]);
    }),
  };

  const brain = {
    answer: vi.fn(
      async (
        _question: string,
        _history: ChatMessage[] = [],
      ): Promise<{
        text: string;
        mode: "llm" | "dumb";
        suggestions?: Array<{ id: string; title: string }>;
      }> => ({
        text: options.llmText ?? "Ответ",
        mode: options.mode ?? "llm",
        ...(options.suggestions ? { suggestions: options.suggestions } : {}),
      }),
    ),
  };

  const counters = new Map<string, number>();
  const limit = vi.fn(async (bucket: string): Promise<boolean> => {
    const next = (counters.get(bucket) ?? 0) + 1;
    counters.set(bucket, next);
    return next <= (options.rateLimitMax ?? Number.POSITIVE_INFINITY);
  });

  // Дефолтная фикстура: первая запись без пометки chip — позиция в массиве
  // не управляет чипсами; четвёртая пометка проверяет лимит срезом.
  const DEFAULT_ENTRIES: KnowledgeItem[] = [
    { id: "intro", title: "Не чипс", text: "первая запись без пометки" },
    { id: "topic-1", title: "Тема 1", text: "текст 1", chip: true },
    { id: "topic-2", title: "Тема 2", text: "текст 2", chip: true },
    { id: "topic-3", title: "Тема 3", text: "текст 3", chip: true },
    { id: "topic-4", title: "Тема 4", text: "текст 4", chip: true },
  ];

  const knowledge = {
    load: vi.fn(() => (options.noKnowledge ? null : (options.entries ?? DEFAULT_ENTRIES))),
  };

  const handle = createWebChatHandler({ store, brain, limit, knowledge });
  return { handle, history, store, brain, limit, knowledge };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleWebChat: GET", () => {
  it("возвращает чипсы из помеченных chip записей и текст помощи: позиция в массиве не важна, лимит 3", async () => {
    const { handle } = makeHarness();
    const res = await handle(new Request(URL));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "webchat",
      chips: [{ title: "Тема 1" }, { title: "Тема 2" }, { title: "Тема 3" }],
      // help — статическая константа brain/help.ts: кнопка «?» не зависит от справки
      help: HELP_TEXT_WEBCHAT,
    });
  });

  it("справка недоступна → 200: чипсы пустые, а help остаётся (не 500)", async () => {
    const { handle } = makeHarness({ noKnowledge: true });

    const res = await handle(new Request(URL));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "webchat",
      chips: [],
      help: HELP_TEXT_WEBCHAT,
    });
  });
});

describe("handleWebChat: POST", () => {
  it("чужой HTTP-метод → 405", async () => {
    const { handle } = makeHarness();
    const res = await handle(new Request(URL, { method: "PUT" }));
    expect(res.status).toBe(405);
  });

  it("битый JSON → 400", async () => {
    const { handle } = makeHarness();
    const res = await handle(post("{oops"));
    expect(res.status).toBe(400);
  });

  it("sessionId не проходит паттерн (короткий / чужие символы) → 400", async () => {
    const { handle } = makeHarness();
    for (const bad of ["abc", "с пробелом!!", "", 42, null]) {
      const res = await handle(post({ sessionId: bad, text: "вопрос" }));
      expect(res.status).toBe(400);
    }
  });

  it("пустой или слишком длинный text → 400", async () => {
    const { handle } = makeHarness();
    for (const bad of ["", "   \n", "x".repeat(2001), 42]) {
      const res = await handle(post({ sessionId: SESSION_ID, text: bad }));
      expect(res.status).toBe(400);
    }
  });

  it("валидный вопрос → {ok, text, mode} от brain", async () => {
    const { handle } = makeHarness({ llmText: "Ответ ассистента" });
    const res = await handle(post({ sessionId: SESSION_ID, text: "  вопрос  " }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      text: "Ответ ассистента",
      mode: "llm",
    });
  });

  it("dumb-fallback с подсказками → suggestions только {title} (без id)", async () => {
    const { handle } = makeHarness({
      mode: "dumb",
      llmText: "Не нашёл точного ответа в справке. 🤔",
      suggestions: [
        { id: "contacts", title: "Контакты" },
        { id: "services", title: "Услуги" },
        { id: "pricing", title: "Стоимость" },
      ],
    });

    const res = await handle(post({ sessionId: SESSION_ID, text: "ракета на марс" }));

    expect(res.status).toBe(200);
    // toEqual: id клиенту не нужен и в JSON не попадает
    await expect(res.json()).resolves.toEqual({
      ok: true,
      text: "Не нашёл точного ответа в справке. 🤔",
      mode: "dumb",
      suggestions: [{ title: "Контакты" }, { title: "Услуги" }, { title: "Стоимость" }],
    });
  });

  it("fallback без подсказок → поля suggestions в JSON нет", async () => {
    const { handle } = makeHarness({ mode: "dumb", llmText: "Не нашёл…" });

    const res = await handle(post({ sessionId: SESSION_ID, text: "ракета на марс" }));

    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toEqual({ ok: true, text: "Не нашёл…", mode: "dumb" });
    expect("suggestions" in data).toBe(false);
  });

  it("LLM-ответ и уверенный dumb-ответ → suggestions нет", async () => {
    const { handle } = makeHarness({ llmText: "Ответ ассистента" });
    const llmRes = await handle(post({ sessionId: SESSION_ID, text: "вопрос" }));
    const llmData = (await llmRes.json()) as Record<string, unknown>;
    expect("suggestions" in llmData).toBe(false);

    // Уверенный dumb-ответ: brain нашёл запись, но подсказки при нём не прилагает
    const { handle: dumbHandle } = makeHarness({ mode: "dumb", llmText: "Стоимость\n\n…" });
    const dumbRes = await dumbHandle(post({ sessionId: SESSION_ID, text: "вопрос" }));
    const dumbData = (await dumbRes.json()) as Record<string, unknown>;
    expect("suggestions" in dumbData).toBe(false);
  });

  it("вопрос уходит в brain без истории и пара вопрос/ответ сохраняется в store", async () => {
    const { handle, history, brain, store } = makeHarness({ llmText: "Ответ" });
    await handle(post({ sessionId: SESSION_ID, text: "первый вопрос" }));

    expect(brain.answer).toHaveBeenCalledWith("первый вопрос", []);

    expect(store.appendHistory).toHaveBeenCalledWith(`chat:web:${SESSION_ID}`, [
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "Ответ" },
    ]);
    expect(history.get(`chat:web:${SESSION_ID}`)).toEqual([
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "Ответ" },
    ]);
  });

  it("второй вопрос того же sessionId уходит в brain вместе с историей", async () => {
    const { handle, history, brain } = makeHarness({ llmText: "Ответ" });
    await handle(post({ sessionId: SESSION_ID, text: "первый вопрос" }));
    await handle(post({ sessionId: SESSION_ID, text: "второй вопрос" }));

    // Второй вызов brain получил сохранённую пару как историю
    expect(brain.answer).toHaveBeenLastCalledWith("второй вопрос", [
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "Ответ" },
    ]);
    expect(history.get(`chat:web:${SESSION_ID}`)).toBeDefined();
  });

  it("text ровно 2000 символов (граница лимита) проходит", async () => {
    const { handle } = makeHarness();
    const res = await handle(post({ sessionId: SESSION_ID, text: "x".repeat(2_000) }));
    expect(res.status).toBe(200);
  });
});

describe("handleWebChat: стены против злоупотреблений (Origin, rate-limit)", () => {
  it("чужой Origin → 403, без походов в store, brain и лимитер", async () => {
    const { handle, store, brain, limit } = makeHarness();
    const res = await handle(
      post({ sessionId: SESSION_ID, text: "вопрос" }, { Origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
    expect(store.getHistory).not.toHaveBeenCalled();
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("свой Origin (совпал с origin запроса) → 200", async () => {
    const { handle } = makeHarness();
    const res = await handle(
      post({ sessionId: SESSION_ID, text: "вопрос" }, { Origin: "http://localhost" }),
    );
    expect(res.status).toBe(200);
  });

  it("без Origin (curl, скрипт) пропускается — скриптовый шторм ловит rate-limit", async () => {
    const { handle } = makeHarness();
    const res = await handle(post({ sessionId: SESSION_ID, text: "вопрос" }));
    expect(res.status).toBe(200);
  });

  it("превышен лимит (fakeLimit → false) → 429, brain вызван только на первый вопрос", async () => {
    const { handle, brain } = makeHarness({ rateLimitMax: 1 });
    const first = await handle(post({ sessionId: SESSION_ID, text: "первый" }));
    expect(first.status).toBe(200);
    const second = await handle(post({ sessionId: SESSION_ID, text: "второй" }));
    expect(second.status).toBe(429);
    expect(brain.answer).toHaveBeenCalledTimes(1);
  });

  it("бакет лимита — web:{ip}: запросы с разных IP не делят одно окно", async () => {
    const { handle, limit } = makeHarness({ rateLimitMax: 1 });
    const first = await handle(
      post({ sessionId: SESSION_ID, text: "первый" }, { "x-real-ip": "203.0.113.1" }),
    );
    const second = await handle(
      post({ sessionId: SESSION_ID, text: "второй" }, { "x-real-ip": "203.0.113.2" }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(limit.mock.calls).toEqual([["web:203.0.113.1"], ["web:203.0.113.2"]]);
  });
});

describe("handleWebChat: fail-open (store в режиме мёртвого Redis)", () => {
  it("store не отвечает (пусто/no-op) — вебчат всё равно отвечает ответом brain, 200 ok", async () => {
    const { handle, brain } = makeHarness({ deadStore: true, llmText: "Ответ" });

    const res = await handle(post({ sessionId: SESSION_ID, text: "вопрос" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, text: "Ответ", mode: "llm" });
    // brain вызван, несмотря на пустые историю и запись
    expect(brain.answer).toHaveBeenCalledTimes(1);
  });
});
