import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramWebhookHandler } from "../http/telegram-webhook";
import type { ChatMessage } from "../store";
import type { Logger } from "../log";
import type { TgInlineKeyboardMarkup, TgMessage } from "../telegram-api";

const SECRET = "test-secret";
const URL = "http://localhost/api/telegram";
const SECRET_HEADER = { "x-telegram-bot-api-secret-token": SECRET };

function updateWithText(text: string, updateId?: number): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...SECRET_HEADER },
    // update_id: undefined не попадает в JSON — апдейт без него тоже валиден.
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: 1, chat: { id: 42 }, text },
    }),
  });
}

function updateWithCallback(data: string, messageId = 10): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...SECRET_HEADER },
    body: JSON.stringify({
      callback_query: {
        id: "cbq-1",
        data,
        // Сообщение с кнопкой — это /start, у него всегда есть текст.
        message: { message_id: messageId, chat: { id: 42 }, text: "Привет!" },
      },
    }),
  });
}

interface HarnessOptions {
  /** Ответ fakeBrain. */
  llmText?: string;
  /** Порог фейкового лимитера на один бакет (по умолчанию — без лимита). */
  rateLimitMax?: number;
  /** Режим мёртвого Redis: store-фейк ведёт себя fail-open ([] / no-op / false) — как реальный store при недоступном Redis. */
  deadStore?: boolean;
  /** Если задан: первая sendMessage с таким текстом бросает (проверки порядка «отправить → записать» и ретрая). */
  replySendFailsText?: string;
}

interface Harness {
  handle: (request: Request) => Promise<Response>;
  /** Скрытый журнал всех фейков в порядке вызовов: порядок «typing → brain → отправка → запись» проверяется по нему. */
  events: string[];
  history: Map<string, ChatMessage[]>;
  seen: Set<string>;
  store: {
    getHistory: ReturnType<typeof vi.fn>;
    appendHistory: ReturnType<typeof vi.fn>;
    clearHistory: ReturnType<typeof vi.fn>;
    isSeen: ReturnType<typeof vi.fn>;
    markSeen: ReturnType<typeof vi.fn>;
  };
  brain: { answer: ReturnType<typeof vi.fn> };
  tg: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendChatAction: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
  };
  limit: ReturnType<typeof vi.fn>;
  log: Logger;
}

/**
 * Собирает обработчик на явных фейках: store — Map-бэкед (история + маркеры
 * дедупликации), brain — управляемый ответ, tg — запись вызовов Bot API,
 * limit — счётчик на бакет. Сеть не подменяется — её нет ни в одном пути.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const history = new Map<string, ChatMessage[]>();
  const seen = new Set<string>();
  const dead = options.deadStore === true;

  const store = {
    getHistory: vi.fn(async (key: string): Promise<ChatMessage[]> => {
      events.push("store:getHistory");
      return dead ? [] : (history.get(key) ?? []);
    }),
    appendHistory: vi.fn(async (key: string, messages: ChatMessage[]): Promise<void> => {
      events.push("store:appendHistory");
      if (!dead) history.set(key, [...(history.get(key) ?? []), ...messages]);
    }),
    clearHistory: vi.fn(async (key: string): Promise<void> => {
      events.push("store:clearHistory");
      if (!dead) history.delete(key);
    }),
    isSeen: vi.fn(async (key: string): Promise<boolean> => {
      events.push("store:isSeen");
      return !dead && seen.has(key);
    }),
    markSeen: vi.fn(async (key: string, _ttlSeconds: number): Promise<void> => {
      events.push("store:markSeen");
      if (!dead) seen.add(key);
    }),
  };

  const brain = {
    answer: vi.fn(
      async (
        _question: string,
        _history: ChatMessage[] = [],
      ): Promise<{ text: string; mode: "llm" }> => {
        events.push("brain:answer");
        return { text: options.llmText ?? "ответ brain", mode: "llm" };
      },
    ),
  };

  let replySendFailures = 0;
  const tg = {
    sendMessage: vi.fn(
      async (
        chatId: number,
        text: string,
        _replyMarkup?: TgInlineKeyboardMarkup,
      ): Promise<TgMessage> => {
        events.push("tg:sendMessage");
        if (text === options.replySendFailsText && replySendFailures++ === 0) {
          throw new Error("Telegram sendMessage failed: падение отправки");
        }
        return { message_id: 2, chat: { id: chatId } };
      },
    ),
    sendChatAction: vi.fn(async (_chatId: number, _action: string): Promise<boolean> => {
      events.push("tg:sendChatAction");
      return true;
    }),
    answerCallbackQuery: vi.fn(async (_id: string, _text?: string): Promise<boolean> => {
      events.push("tg:answerCallbackQuery");
      return true;
    }),
    editMessageText: vi.fn(
      async (chatId: number, messageId: number, _text: string): Promise<TgMessage> => {
        events.push("tg:editMessageText");
        return { message_id: messageId, chat: { id: chatId } };
      },
    ),
  };

  const counters = new Map<string, number>();
  const limit = vi.fn(async (bucket: string): Promise<boolean> => {
    events.push("limit:hit");
    const next = (counters.get(bucket) ?? 0) + 1;
    counters.set(bucket, next);
    return next <= (options.rateLimitMax ?? Number.POSITIVE_INFINITY);
  });

  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    warnThrottled: vi.fn(),
  };

  const handle = createTelegramWebhookHandler({ store, brain, tg, log, limit });
  return { handle, events, history, seen, store, brain, tg, limit, log };
}

/** Последняя отправка sendMessage: [chatId, text, replyMarkup?]. */
function lastSend(tg: Harness["tg"]): [number, string, TgInlineKeyboardMarkup | undefined] {
  return tg.sendMessage.mock.calls.at(-1) as [number, string, TgInlineKeyboardMarkup | undefined];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleTelegramWebhook", () => {
  it("без секрет-заголовка → 401", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle } = makeHarness();
    const res = await handle(new Request(URL, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("без TELEGRAM_WEBHOOK_SECRET в env → 401 даже с заголовком", async () => {
    const { handle } = makeHarness();
    const res = await handle(updateWithText("/start"));
    expect(res.status).toBe(401);
  });

  it("чужой секрет → 401", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "другой-секрет");
    const { handle } = makeHarness();
    const res = await handle(updateWithText("/start"));
    expect(res.status).toBe(401);
  });

  it("/start → приветствие с inline-кнопками-подсказками", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness();

    const res = await handle(updateWithText("/start"));

    expect(res.status).toBe(200);
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, keyboard] = lastSend(tg);
    expect(chatId).toBe(42);
    expect(text).toContain("Привет");
    expect(keyboard?.inline_keyboard).toHaveLength(3);
    expect(keyboard?.inline_keyboard[0][0]).toMatchObject({
      callback_data: "ask:0",
      text: "Услуги",
    });
    expect(keyboard?.inline_keyboard[2][0]).toMatchObject({ callback_data: "ask:2" });
  });

  it("/help → список умений, без обращения к LLM", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness();

    await handle(updateWithText("/help"));

    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("/reset");
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("/reset → очистка истории и подтверждение", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, store } = makeHarness();

    await handle(updateWithText("/reset"));

    expect(store.clearHistory).toHaveBeenCalledWith("chat:tg:42");
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("очищена");
  });

  it("/about → текст элемента справки «Кто я»", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness();

    await handle(updateWithText("/about"));

    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("Константин Ковский");
  });

  it("неизвестная команда → подсказка вызвать /help", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness();

    await handle(updateWithText("/bannana"));

    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("/help");
  });

  it("вопрос → typing+brain+sendMessage, ответ пишется в историю как пара", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, tg, store } = makeHarness();

    await handle(updateWithText("кто ты?"));

    // Индикатор «печатает…» уходит до обращения к LLM, отправка — до записи в историю
    expect(events).toEqual([
      "limit:hit",
      "tg:sendChatAction",
      "store:getHistory",
      "brain:answer",
      "tg:sendMessage",
      "store:appendHistory",
    ]);
    expect(tg.sendMessage).toHaveBeenCalledWith(42, "ответ brain");
    expect(store.appendHistory).toHaveBeenCalledWith("chat:tg:42", [
      { role: "user", content: "кто ты?" },
      { role: "assistant", content: "ответ brain" },
    ]);
  });

  it("callback ask:{n} → answerCallbackQuery, ответ как обычный вопрос, клавиатура снята", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, tg, brain } = makeHarness();

    const res = await handle(updateWithCallback("ask:1", 10));

    expect(res.status).toBe(200);
    expect(events).toEqual([
      "tg:answerCallbackQuery",
      "limit:hit",
      "tg:sendChatAction",
      "store:getHistory",
      "brain:answer",
      "tg:sendMessage",
      "store:appendHistory",
      "tg:editMessageText",
    ]);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq-1");
    // Вопрос кнопки — title элемента справки, уходит в brain как обычная реплика
    expect(brain.answer.mock.calls[0][0]).toBe("Стоимость");
    // Клавиатура снята: editMessageText тем же текстом, без reply_markup
    expect(tg.editMessageText).toHaveBeenCalledWith(42, 10, "Привет!");
  });

  it("битый callback_data → answerCallbackQuery с текстом-ошибкой, LLM молчит", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness();

    await handle(updateWithCallback("ask:999"));

    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq-1", expect.any(String));
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("update без текста — просто 200 без вызовов", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain, store, limit } = makeHarness();

    const res = await handle(
      new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...SECRET_HEADER },
        body: JSON.stringify({ message: { message_id: 3, chat: { id: 42 } } }),
      }),
    );

    expect(res.status).toBe(200);
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(brain.answer).not.toHaveBeenCalled();
    expect(store.getHistory).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("битый JSON — 200 ok (Telegram не должен повторять доставку)", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness();
    const res = await handle(
      new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...SECRET_HEADER },
        body: "{oops",
      }),
    );
    expect(res.status).toBe(200);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });
});

describe("handleTelegramWebhook: с фейковым store (история и дедупликация на Map)", () => {
  it("callback ask:0 → answerCallbackQuery → brain с историей → sendMessage → appendHistory → editMessageText, пара в истории", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, history, tg, brain } = makeHarness();
    // Предыдущий диалог: brain должен получить его вместе с вопросом кнопки.
    history.set("chat:tg:42", [{ role: "user", content: "старый вопрос" }]);

    const res = await handle(updateWithCallback("ask:0", 10));

    expect(res.status).toBe(200);
    // Полный порядок: спиннер → лимит → «печатает…» → история → brain →
    // отправить → записать → снять клавиатуру
    expect(events).toEqual([
      "tg:answerCallbackQuery",
      "limit:hit",
      "tg:sendChatAction",
      "store:getHistory",
      "brain:answer",
      "tg:sendMessage",
      "store:appendHistory",
      "tg:editMessageText",
    ]);
    // brain получил старую историю и вопрос кнопки — title первого элемента справки
    expect(brain.answer).toHaveBeenCalledWith("Услуги", [
      { role: "user", content: "старый вопрос" },
    ]);
    const edit = tg.editMessageText.mock.calls[0] as unknown[];
    expect(edit).toEqual([42, 10, "Привет!"]);

    expect(history.get("chat:tg:42")).toEqual([
      { role: "user", content: "старый вопрос" },
      { role: "user", content: "Услуги" },
      { role: "assistant", content: "ответ brain" },
    ]);
  });

  it("/reset реально удаляет ключ истории и подтверждает", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, history, tg, store } = makeHarness();
    history.set("chat:tg:42", [{ role: "user", content: "старый вопрос" }]);

    await handle(updateWithText("/reset"));

    // DEL ушёл в store, ключ пропал
    expect(store.clearHistory).toHaveBeenCalledWith("chat:tg:42");
    expect(history.has("chat:tg:42")).toBe(false);
    // Подтверждение пользователю
    expect(lastSend(tg)[1]).toContain("очищена");
  });

  it("команды (/help) не пишутся в историю: ни get, ни append", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, history, store } = makeHarness();

    await handle(updateWithText("/help"));

    expect(store.getHistory).not.toHaveBeenCalled();
    expect(store.appendHistory).not.toHaveBeenCalled();
    expect(history.size).toBe(0);
  });

  it("свободный текст пишет пару user/assistant в историю ключа chat:tg:{chatId}", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, history } = makeHarness();

    await handle(updateWithText("кто ты?"));

    expect(history.get("chat:tg:42")).toEqual([
      { role: "user", content: "кто ты?" },
      { role: "assistant", content: "ответ brain" },
    ]);
  });

  it("sendMessage упал → appendHistory не выполнялся, fallback уходит", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    // Падает только отправка ответа brain; fallback «технические неполадки» проходит.
    const { handle, events, tg, store } = makeHarness({ replySendFailsText: "ответ brain" });

    const res = await handle(updateWithText("кто ты?"));

    expect(res.status).toBe(200);
    // Последняя отправка — fallback-сообщение о неполадках
    expect(lastSend(tg)[1]).toContain("технические неполадки");
    // Порядок «отправить → записать»: после упавшей отправки записи в историю нет,
    // иначе фантомная пара осталась бы в контексте следующего вопроса.
    expect(events).not.toContain("store:appendHistory");
    expect(store.appendHistory).not.toHaveBeenCalled();
  });

  it("лимит исчерпан (fakeLimit → false) → текст лимита, brain не вызывается, ответ остаётся 200", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness({ rateLimitMax: 1 });

    const first = await handle(updateWithText("первый"));
    expect(first.status).toBe(200);
    const second = await handle(updateWithText("второй"));
    // Telegram ждёт 2xx всегда — лимит сообщается в тексте, а не статусом
    expect(second.status).toBe(200);

    expect(brain.answer).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("Слишком много");
  });
});

describe("handleTelegramWebhook: fail-open (store в режиме мёртвого Redis)", () => {
  it("store не отвечает (пусто/no-op) — бот всё равно отвечает, 200 ok", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness({ deadStore: true });

    const res = await handle(updateWithText("кто ты?"));

    expect(res.status).toBe(200);
    // brain вызван, ответ доставлен пользователю несмотря на мёртвый store
    expect(brain.answer).toHaveBeenCalledTimes(1);
    expect(tg.sendMessage).toHaveBeenCalledWith(42, "ответ brain");
  });
});

describe("handleTelegramWebhook: дедупликация по update_id", () => {
  it("повтор после успеха гасится: brain и sendMessage ровно один раз, оба ответа 200 {ok:true}", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, seen, tg, brain } = makeHarness();

    const first = await handle(updateWithText("кто ты?", 987654));
    const second = await handle(updateWithText("кто ты?", 987654));

    // Telegram ждёт 2xx на обе доставки, но обрабатывается только первая
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ ok: true });

    expect(brain.answer).toHaveBeenCalledTimes(1);
    const replySends = (tg.sendMessage.mock.calls as unknown[][]).filter(
      (call) => call[1] === "ответ brain",
    );
    expect(replySends).toHaveLength(1);
    // Маркер поставлен только после успешной обработки
    expect(seen.has("tg:seen:987654")).toBe(true);
  });

  it("повтор после ошибки доходит до brain: маркер не ставится, ответ доставлен со второй попытки", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    // Первая отправка ответа падает → обработка бросила → маркера нет,
    // Telegram повторит доставку.
    const { handle, seen, history, tg, brain } = makeHarness({
      replySendFailsText: "ответ brain",
    });

    const first = await handle(updateWithText("кто ты?", 111222));
    expect(first.status).toBe(200);
    expect(seen.has("tg:seen:111222")).toBe(false);

    const second = await handle(updateWithText("кто ты?", 111222));

    expect(second.status).toBe(200);
    // brain вызван повторно — дедупликация не съела ретрай
    expect(brain.answer).toHaveBeenCalledTimes(2);
    // Fallback «неполадки» был только после первой доставки — второй POST
    // доставил настоящий ответ, а не извинение
    const fallbackSends = (tg.sendMessage.mock.calls as unknown[][]).filter((call) =>
      String(call[1]).includes("неполадки"),
    );
    expect(fallbackSends).toHaveLength(1);
    // После успешного повтора маркер установлен, пара записана в историю
    expect(seen.has("tg:seen:111222")).toBe(true);
    expect(history.get("chat:tg:42")).toEqual([
      { role: "user", content: "кто ты?" },
      { role: "assistant", content: "ответ brain" },
    ]);
  });

  it("без store — fail-open: два одинаковых апдейта обрабатываются полноценно", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness({ deadStore: true });

    const first = await handle(updateWithText("кто ты?", 333444));
    const second = await handle(updateWithText("кто ты?", 333444));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Маркер недоступен → дедупликация отключена, обе доставки отработали целиком
    expect(brain.answer).toHaveBeenCalledTimes(2);
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
  });
});
