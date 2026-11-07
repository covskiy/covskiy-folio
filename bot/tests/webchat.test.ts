import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebChatHandler } from "../http/webchat";
import { knowledgeEntries } from "../brain/prompt";
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
  /** Порог фейкового лимитера на один бакет (по умолчанию — без лимита). */
  rateLimitMax?: number;
  /** Режим мёртвого Redis: store-фейк ведёт себя fail-open ([] / no-op) — как реальный store при недоступном Redis. */
  deadStore?: boolean;
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
      ): Promise<{ text: string; mode: "llm" }> => ({
        text: options.llmText ?? "Ответ",
        mode: "llm",
      }),
    ),
  };

  const counters = new Map<string, number>();
  const limit = vi.fn(async (bucket: string): Promise<boolean> => {
    const next = (counters.get(bucket) ?? 0) + 1;
    counters.set(bucket, next);
    return next <= (options.rateLimitMax ?? Number.POSITIVE_INFINITY);
  });

  const handle = createWebChatHandler({ store, brain, limit });
  return { handle, history, store, brain, limit };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleWebChat: GET", () => {
  it("возвращает service и первые 3 чипса из справки", async () => {
    const { handle } = makeHarness();
    const res = await handle(new Request(URL));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "webchat",
      chips: knowledgeEntries()
        .slice(0, 3)
        .map((item) => ({ title: item.title })),
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
