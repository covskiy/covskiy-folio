import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramWebhookHandler } from "../http/telegram-webhook";
import type { KnowledgeItem } from "../brain/knowledge";
import type { ChatMessage } from "../store";
import type { Logger } from "../log";
import type { TgInlineKeyboardMarkup, TgMessage } from "../telegram-api";

const SECRET = "test-secret";
const URL = "http://localhost/api/telegram";
const SECRET_HEADER = { "x-telegram-bot-api-secret-token": SECRET };

/** Фикстура справки: chip-записи НЕ первые (порядок массива не управляет кнопками),
 *  «Кто я» — about-пометка без chip. Маркеры «Услуги»/«Стоимость»/«Константин Ковский» держат ассерты команд. */
const KNOWLEDGE_ENTRIES: KnowledgeItem[] = [
  {
    id: "intro",
    title: "Вступление",
    text: "Не попадает в кнопки: позиция массива не управляет UI.",
  },
  { id: "services", title: "Услуги", text: "Пять направлений: сайты, боты.", chip: true },
  { id: "pricing", title: "Стоимость", text: "Оценка под конкретную задачу.", chip: true },
  { id: "contacts", title: "Контакты", text: "Telegram: @devCovskiy.", chip: true },
  { id: "about", title: "Кто я", text: "Константин Ковский — тестовая справка.", about: true },
];

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

function updateWithMyChatMember(status: string, chatId = 42): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...SECRET_HEADER },
    // update_id задан намеренно: у события блокировки проверяется и дедупликация
    body: JSON.stringify({
      update_id: 30,
      my_chat_member: {
        chat: { id: chatId },
        old_chat_member: { status: status === "kicked" ? "member" : "kicked" },
        new_chat_member: { status },
      },
    }),
  });
}

interface HarnessOptions {
  /** Ответ fakeBrain. */
  llmText?: string;
  /** Режим ответа fakeBrain (по умолчанию llm). */
  mode?: "llm" | "dumb";
  /** Подсказки dumb-fallback от fakeBrain; не заданы — клавиатуры не будет. */
  suggestions?: Array<{ id: string; title: string }>;
  /** Порог фейкового лимитера на один бакет (по умолчанию — без лимита). */
  rateLimitMax?: number;
  /** Режим мёртвого Redis: store-фейк ведёт себя fail-open ([] / no-op / false) — как реальный store при недоступном Redis. */
  deadStore?: boolean;
  /** Если задан: первая sendMessage с таким текстом бросает (проверки порядка «отправить → записать» и ретрая). */
  replySendFailsText?: string;
  /** Записи справки вместо фикстуры (для проверок fallback'а /about). */
  entries?: KnowledgeItem[];
  /** Справка недоступна (load() → null). */
  noKnowledge?: boolean;
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
  knowledge: { load: ReturnType<typeof vi.fn> };
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
      ): Promise<{
        text: string;
        mode: "llm" | "dumb";
        suggestions?: Array<{ id: string; title: string }>;
      }> => {
        events.push("brain:answer");
        return {
          text: options.llmText ?? "ответ brain",
          mode: options.mode ?? "llm",
          ...(options.suggestions ? { suggestions: options.suggestions } : {}),
        };
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

  const knowledge = {
    load: vi.fn(() => (options.noKnowledge ? null : (options.entries ?? KNOWLEDGE_ENTRIES))),
  };

  const handle = createTelegramWebhookHandler({ store, brain, tg, log, limit, knowledge });
  return { handle, events, history, seen, store, brain, tg, limit, knowledge, log };
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

  it("/start → приветствие с inline-кнопками по uiTopics: chip-записи не первые в массиве", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness();

    const res = await handle(updateWithText("/start"));

    expect(res.status).toBe(200);
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, keyboard] = lastSend(tg);
    expect(chatId).toBe(42);
    expect(text).toContain("Привет");
    expect(keyboard?.inline_keyboard).toHaveLength(3);
    // callback_data несёт slug записи, а не индекс — правки контента не меняют смысл кнопки
    expect(keyboard?.inline_keyboard[0][0]).toMatchObject({
      callback_data: "ask:services",
      text: "Услуги",
    });
    expect(keyboard?.inline_keyboard[2][0]).toMatchObject({ callback_data: "ask:contacts" });
  });

  it("/help → текст помощи + кнопки тем, без обращения к LLM", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness();

    await handle(updateWithText("/help"));

    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("/reset");
    expect(lastSend(tg)[1]).toContain("/about");
    // Темы кликабельны: тот же startKeyboard, что у /start
    const keyboard = lastSend(tg)[2];
    expect(keyboard?.inline_keyboard).toHaveLength(3);
    expect(keyboard?.inline_keyboard[0][0]).toMatchObject({
      text: "Услуги",
      callback_data: "ask:services",
    });
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("справка недоступна: /help → текст без кнопок, а не «неполадки»", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness({ noKnowledge: true });

    await handle(updateWithText("/help"));

    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("/help");
    expect(lastSend(tg)[2]).toBeUndefined();
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

  it("в справке нет пометки about → /about отвечает заглушкой, а не произвольной первой записью", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness({
      entries: [
        { id: "services", title: "Услуги", text: "Текст про услуги" },
        { id: "pricing", title: "Стоимость", text: "Текст про стоимость" },
      ],
    });

    await handle(updateWithText("/about"));

    expect(lastSend(tg)[1]).toContain("Информация о владельце пока не заполнена");
  });

  it("справка недоступна: /start → приветствие без клавиатуры, а не «неполадки»", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness({ noKnowledge: true });

    const res = await handle(updateWithText("/start"));

    expect(res.status).toBe(200);
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, keyboard] = lastSend(tg);
    expect(chatId).toBe(42);
    expect(text).toContain("Привет");
    expect(keyboard).toBeUndefined();
  });

  it("справка недоступна: /about → осмысленная заглушка, а не «неполадки»", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness({ noKnowledge: true });

    await handle(updateWithText("/about"));

    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSend(tg)[1]).toContain("Информация о владельце пока не заполнена");
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
    // Третий аргумент — reply_markup: без подсказок он undefined (без клавиатуры)
    expect(tg.sendMessage).toHaveBeenCalledWith(42, "ответ brain", undefined);
    expect(store.appendHistory).toHaveBeenCalledWith("chat:tg:42", [
      { role: "user", content: "кто ты?" },
      { role: "assistant", content: "ответ brain" },
    ]);
  });

  it("«печатает» повторяется, пока brain отвечает, и гасится после отправки ответа", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    vi.useFakeTimers();
    try {
      const { handle, events, brain, tg } = makeHarness();
      // Brain «думает» 10 с: старый одиночный typing уже погас бы на 5-й секунде.
      brain.answer.mockImplementationOnce(async () => {
        events.push("brain:answer");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { text: "медленный ответ", mode: "llm" };
      });

      const pending = handle(updateWithText("медленный вопрос"));

      // 4.5 с и 9 с: повторы индикатора поверх первого вызова (t=0) —
      // всё ещё до ответа brain (10 с).
      await vi.advanceTimersByTimeAsync(4_500);
      await vi.advanceTimersByTimeAsync(4_500);
      expect(tg.sendChatAction).toHaveBeenCalledTimes(3);

      // 10 с: brain ответил — цикл гасится abort'ом, повторов после sendMessage нет.
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(tg.sendChatAction).toHaveBeenCalledTimes(3);
      expect(events.lastIndexOf("tg:sendChatAction")).toBeLessThan(
        events.indexOf("tg:sendMessage"),
      );
      expect(events[events.length - 1]).toBe("store:appendHistory");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dumb-fallback с подсказками → sendMessage получает inline-клавиатуру с ask:{id}", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness({
      mode: "dumb",
      llmText: "Не нашёл точного ответа в справке. 🤔",
      suggestions: [
        { id: "contacts", title: "Контакты" },
        { id: "services", title: "Услуги" },
      ],
    });

    await handle(updateWithText("ракета на марс"));

    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, keyboard] = lastSend(tg);
    expect(chatId).toBe(42);
    expect(text).toBe("Не нашёл точного ответа в справке. 🤔");
    // callback_data = ask:{id} — клик уходит в существующий handleCallbackQuery
    expect(keyboard?.inline_keyboard).toEqual([
      [{ text: "Контакты", callback_data: "ask:contacts" }],
      [{ text: "Услуги", callback_data: "ask:services" }],
    ]);
  });

  it("dumb-fallback без подсказок → сообщение без клавиатуры", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg } = makeHarness({ mode: "dumb", llmText: "Не нашёл…" });

    await handle(updateWithText("ракета на марс"));

    expect(tg.sendMessage).toHaveBeenCalledWith(42, "Не нашёл…", undefined);
  });

  it("callback ask:{id} → answerCallbackQuery, ответ как обычный вопрос, клавиатура снята", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, tg, brain } = makeHarness();

    const res = await handle(updateWithCallback("ask:pricing", 10));

    expect(res.status).toBe(200);
    // Клавиатура снимается сразу после ack, до ответа — окно даблклика закрыто
    expect(events).toEqual([
      "tg:answerCallbackQuery",
      "tg:editMessageText",
      "limit:hit",
      "tg:sendChatAction",
      "store:getHistory",
      "brain:answer",
      "tg:sendMessage",
      "store:appendHistory",
    ]);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq-1");
    // Вопрос кнопки — title записи по её id, уходит в brain как обычная реплика
    expect(brain.answer.mock.calls[0][0]).toBe("Стоимость");
    // Клавиатура снята: editMessageText тем же текстом, без reply_markup
    expect(tg.editMessageText).toHaveBeenCalledWith(42, 10, "Привет!");
  });

  it("битый callback_data (не slug) → answerCallbackQuery с текстом-ошибкой, LLM молчит", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness();

    // ask:999 — формат legacy-кнопок с индексом: новый паттерн его не пускает
    await handle(updateWithCallback("ask:999"));

    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq-1", expect.any(String));
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("id кнопки не найден (запись удалили/переименовали) → «кнопка устарела», не чужой ответ", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness();

    await handle(updateWithCallback("ask:removed-topic"));

    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq-1", expect.any(String));
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("справка недоступна: кнопка → «кнопка устарела», а не молча погасший спиннер", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness({ noKnowledge: true });

    const res = await handle(updateWithCallback("ask:1"));

    expect(res.status).toBe(200);
    expect(tg.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq-1", expect.any(String));
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("ack валидной кнопки упал (query is too old) → ответ всё равно ушёл, warn в лог", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, tg, brain, log } = makeHarness();
    // Telegram повторяет апдейт, id нажатия уже просрочен — ack бросает
    tg.answerCallbackQuery.mockRejectedValueOnce(
      new Error("query is too old and response timeout expired or query ID is invalid"),
    );

    const res = await handle(updateWithCallback("ask:pricing", 10));

    expect(res.status).toBe(200);
    // Вопрос ушёл в brain и ответ дошёл до пользователя — ack не уронил ветку
    expect(brain.answer).toHaveBeenCalledWith("Стоимость", []);
    expect(tg.sendMessage).toHaveBeenCalledWith(42, "ответ brain", undefined);
    // Дальше: снять клавиатуру → лимит → … → отправить. Первого
    // "tg:answerCallbackQuery" в журнале нет: mockRejectedValueOnce подменяет
    // имплементацию целиком, фейк не успевает записать событие
    expect(events).toEqual([
      "tg:editMessageText",
      "limit:hit",
      "tg:sendChatAction",
      "store:getHistory",
      "brain:answer",
      "tg:sendMessage",
      "store:appendHistory",
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      "telegram-webhook",
      expect.stringContaining("не смог погасить спиннер"),
    );
  });

  it("callback: отправка ответа упала → fallback-сообщение о неполадках", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, tg } = makeHarness({ replySendFailsText: "ответ brain" });

    const res = await handle(updateWithCallback("ask:services", 10));

    expect(res.status).toBe(200);
    // Первая отправка упала → catch: погасить спиннер и отправить fallback
    // (fallback-вызов без reply_markup — в mock.calls ровно два аргумента)
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
    expect(lastSend(tg)).toEqual([42, "У меня технические неполадки — попробуй спросить позже."]);
    // Клавиатура уже снята (до ответа) — повторный клик по мёртвым кнопкам
    // невозможен, повтор апдейта дойдёт до LLM как обычное нажатие
    expect(tg.editMessageText).toHaveBeenCalledTimes(1);
    // Пара в историю не попала (порядок «отправить → записать»)
    expect(events).toEqual([
      "tg:answerCallbackQuery",
      "tg:editMessageText",
      "limit:hit",
      "tg:sendChatAction",
      "store:getHistory",
      "brain:answer",
      "tg:sendMessage",
      "tg:answerCallbackQuery",
      "tg:sendMessage",
    ]);
  });

  it("битый callback_data: клавиатура тоже снята — мёртвые кнопки не тостят вечно", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, tg, brain } = makeHarness();

    const res = await handle(updateWithCallback("ask:999"));

    expect(res.status).toBe(200);
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("cbq-1", expect.any(String));
    expect(tg.editMessageText).toHaveBeenCalledWith(42, 10, "Привет!");
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("my_chat_member kicked → история чата очищена, Telegram API не тронут", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, store, tg, brain, limit, log } = makeHarness();

    const res = await handle(updateWithMyChatMember("kicked"));

    expect(res.status).toBe(200);
    expect(store.clearHistory).toHaveBeenCalledWith("chat:tg:42");
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(brain.answer).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    // Дедупликация ведётся как у остальных апдейтов: isSeen до обработки,
    // markSeen после
    expect(events).toEqual(["store:isSeen", "store:clearHistory", "store:markSeen"]);
    expect(log.warn).toHaveBeenCalledWith(
      "telegram-webhook",
      expect.stringContaining("заблокировал бота"),
    );
  });

  it("my_chat_member member (разблокировка) → история не трогается", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, store, log } = makeHarness();

    const res = await handle(updateWithMyChatMember("member"));

    expect(res.status).toBe(200);
    expect(store.clearHistory).not.toHaveBeenCalled();
    expect(events).toEqual(["store:isSeen", "store:markSeen"]);
    expect(log.debug).toHaveBeenCalledWith(
      "telegram-webhook",
      expect.stringContaining("разблокировал"),
    );
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
  it("callback ask:services → answerCallbackQuery → brain с историей → sendMessage → appendHistory → editMessageText, пара в истории", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const { handle, events, history, tg, brain } = makeHarness();
    // Предыдущий диалог: brain должен получить его вместе с вопросом кнопки.
    history.set("chat:tg:42", [{ role: "user", content: "старый вопрос" }]);

    const res = await handle(updateWithCallback("ask:services", 10));

    expect(res.status).toBe(200);
    // Полный порядок: спиннер → снять клавиатуру → лимит → «печатает…» →
    // история → brain → отправить → записать
    expect(events).toEqual([
      "tg:answerCallbackQuery",
      "tg:editMessageText",
      "limit:hit",
      "tg:sendChatAction",
      "store:getHistory",
      "brain:answer",
      "tg:sendMessage",
      "store:appendHistory",
    ]);
    // brain получил старую историю и вопрос кнопки — title записи по её id
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
    // Третий аргумент — reply_markup: без подсказок он undefined (без клавиатуры)
    expect(tg.sendMessage).toHaveBeenCalledWith(42, "ответ brain", undefined);
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
