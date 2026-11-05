import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook } from "../http/telegram-webhook";

const SECRET = "test-secret";
const URL = "http://localhost/api/telegram";
const SECRET_HEADER = { "x-telegram-bot-api-secret-token": SECRET };

function updateWithText(text: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...SECRET_HEADER },
    body: JSON.stringify({ message: { message_id: 1, chat: { id: 42 }, text } }),
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

/** Тело запроса к Bot API по номеру вызова fetch. */
function tgBody(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  expect(String(url)).toContain("api.telegram.org");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function tgMethod(fetchMock: ReturnType<typeof vi.fn>, call: number): string {
  const [url] = fetchMock.mock.calls[call] as [string];
  return String(url).split("/").at(-1) as string;
}

function tgUrl(fetchMock: ReturnType<typeof vi.fn>, call: number): string {
  const [url] = fetchMock.mock.calls[call] as [string];
  return String(url);
}

/**
 * Подменяет глобальный fetch: вызовы в Bot API отвечают успехом,
 * вызовы в LLM (из brain) — фиксированным ответом. Возвращает мок для проверок.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const isBotApi = url.includes("api.telegram.org");
    const result =
      isBotApi && url.includes("/sendMessage") ? { message_id: 2, chat: { id: 42 } } : true;
    const payload = isBotApi
      ? { ok: true, result }
      : { choices: [{ message: { content: "ответ brain" } }] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubLlm(): void {
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:9999/v1");
  vi.stubEnv("LLM_MODEL", "test-model");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("handleTelegramWebhook", () => {
  it("без секрет-заголовка → 401", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramWebhook(new Request(URL, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("без TELEGRAM_WEBHOOK_SECRET в env → 401 даже с заголовком", async () => {
    const res = await handleTelegramWebhook(updateWithText("/start"));
    expect(res.status).toBe(401);
  });

  it("чужой секрет → 401", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "другой-секрет");
    const res = await handleTelegramWebhook(updateWithText("/start"));
    expect(res.status).toBe(401);
  });

  it("/start → приветствие с inline-кнопками-подсказками", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    const res = await handleTelegramWebhook(updateWithText("/start"));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = tgBody(fetchMock, 0);
    expect(body.chat_id).toBe(42);
    expect(String(body.text)).toContain("Привет");
    const keyboard = (
      body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard;
    expect(keyboard).toHaveLength(3);
    expect(keyboard[0][0]).toMatchObject({ callback_data: "ask:0", text: "Кто я" });
    expect(keyboard[2][0]).toMatchObject({ callback_data: "ask:2" });
  });

  it("/help → список умений, без обращения к LLM", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    await handleTelegramWebhook(updateWithText("/help"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tgMethod(fetchMock, 0)).toBe("sendMessage");
    expect(String(tgBody(fetchMock, 0).text)).toContain("/reset");
  });

  it("/reset → очистка истории и подтверждение", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    await handleTelegramWebhook(updateWithText("/reset"));

    // store fail-open без env: Redis не вызывается, только sendMessage.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(tgBody(fetchMock, 0).text)).toContain("очищена");
  });

  it("/about → текст элемента справки «Кто я»", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    await handleTelegramWebhook(updateWithText("/about"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(tgBody(fetchMock, 0).text)).toContain("Меня зовут Covskiy");
  });

  it("неизвестная команда → подсказка вызвать /help", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    await handleTelegramWebhook(updateWithText("/bannana"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(tgBody(fetchMock, 0).text)).toContain("/help");
  });

  it("вопрос → история+brain+sendMessage, ответ пишется в историю как пара", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    stubLlm();
    const fetchMock = stubFetch();

    await handleTelegramWebhook(updateWithText("кто ты?"));

    expect(tgUrl(fetchMock, 0)).toContain("chat/completions");
    expect(tgMethod(fetchMock, 1)).toBe("sendMessage");
    expect(tgBody(fetchMock, 1)).toMatchObject({ chat_id: 42, text: "ответ brain" });
  });

  it("callback ask:{n} → answerCallbackQuery, ответ как обычный вопрос, клавиатура снята", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    stubLlm();
    const fetchMock = stubFetch();

    const res = await handleTelegramWebhook(updateWithCallback("ask:1", 10));

    expect(res.status).toBe(200);
    expect(tgMethod(fetchMock, 0)).toBe("answerCallbackQuery");
    expect(tgBody(fetchMock, 0)).toMatchObject({ callback_query_id: "cbq-1" });
    // Вопрос кнопки — title элемента справки, уходит в LLM как обычная реплика
    expect(tgUrl(fetchMock, 1)).toContain("chat/completions");
    const llmBody = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
    ) as {
      messages: { content: string }[];
    };
    expect(llmBody.messages.at(-1)?.content).toBe("Чем могу помочь");
    expect(tgMethod(fetchMock, 2)).toBe("sendMessage");
    // Клавиатура снята: editMessageText тем же текстом, без reply_markup
    expect(tgMethod(fetchMock, 3)).toBe("editMessageText");
    const edit = tgBody(fetchMock, 3);
    expect(edit).toMatchObject({ chat_id: 42, message_id: 10 });
    expect(edit.reply_markup).toBeUndefined();
  });

  it("битый callback_data → answerCallbackQuery с текстом-ошибкой, LLM молчит", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    await handleTelegramWebhook(updateWithCallback("ask:999"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tgMethod(fetchMock, 0)).toBe("answerCallbackQuery");
    expect(tgBody(fetchMock, 0)).toMatchObject({
      callback_query_id: "cbq-1",
      text: expect.any(String),
    });
  });

  it("update без текста — просто 200 без вызовов", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const fetchMock = stubFetch();

    const res = await handleTelegramWebhook(
      new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...SECRET_HEADER },
        body: JSON.stringify({ message: { message_id: 3, chat: { id: 42 } } }),
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("битый JSON — 200 ok (Telegram не должен повторять доставку)", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const res = await handleTelegramWebhook(
      new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...SECRET_HEADER },
        body: "{oops",
      }),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * Полный стек на Map-«Redis»: REST-команды Upstash обслуживаются локальной Map
 * (get/set/del), Bot API — успехом, LLM — фиксированным ответом.
 */
function stubRedisBotApiAndLlm(llmText: string): {
  fetchMock: ReturnType<typeof vi.fn>;
  store: Map<string, string>;
} {
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  stubLlm();
  const store = new Map<string, string>();
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://upstash.test") {
      const command = JSON.parse(String(init?.body)) as string[];
      if (command[0] === "get") {
        return new Response(JSON.stringify({ result: store.get(command[1]) ?? null }));
      }
      if (command[0] === "set") {
        store.set(command[1], String(command[2]));
        return new Response(JSON.stringify({ result: "OK" }));
      }
      if (command[0] === "del") {
        store.delete(command[1]);
        return new Response(JSON.stringify({ result: 1 }));
      }
      throw new Error(`неожиданная команда Redis: ${command[0]}`);
    }
    if (url.includes("api.telegram.org")) {
      const result = url.includes("/sendMessage") ? { message_id: 2, chat: { id: 42 } } : true;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: llmText } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, store };
}

describe("handleTelegramWebhook: с включённым Redis (Map-мок REST)", () => {
  it("callback ask:0 → answerCallbackQuery → LLM с историей → sendMessage → editMessageText, пара в истории", async () => {
    const { fetchMock, store } = stubRedisBotApiAndLlm("ответ brain");
    // Предыдущий диалог: LLM должен получить его вместе с вопросом кнопки.
    store.set("chat:tg:42", JSON.stringify([{ role: "user", content: "старый вопрос" }]));

    const res = await handleTelegramWebhook(updateWithCallback("ask:0", 10));

    expect(res.status).toBe(200);
    expect(tgMethod(fetchMock, 0)).toBe("answerCallbackQuery");
    // История досталась из Redis до похода в LLM
    expect(tgUrl(fetchMock, 1)).toBe("http://upstash.test");
    expect(tgUrl(fetchMock, 2)).toContain("chat/completions");
    const llmBody = JSON.parse(
      String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body),
    ) as { messages: { role: string; content: string }[] };
    expect(llmBody.messages.at(-2)).toMatchObject({ role: "user", content: "старый вопрос" });
    // Вопрос кнопки — title первого элемента справки
    expect(llmBody.messages.at(-1)).toMatchObject({ role: "user", content: "Кто я" });
    // appendHistory — это get(3) + set(4) в Redis, затем sendMessage и editMessageText
    expect(tgUrl(fetchMock, 3)).toBe("http://upstash.test");
    expect(tgUrl(fetchMock, 4)).toBe("http://upstash.test");
    expect(tgMethod(fetchMock, 5)).toBe("sendMessage");
    expect(tgMethod(fetchMock, 6)).toBe("editMessageText");
    const edit = tgBody(fetchMock, 6);
    expect(edit).toMatchObject({ chat_id: 42, message_id: 10, text: "Привет!" });
    expect(edit.reply_markup).toBeUndefined();

    const saved = JSON.parse(store.get("chat:tg:42") ?? "[]") as Array<{
      role: string;
      content: string;
    }>;
    expect(saved).toEqual([
      { role: "user", content: "старый вопрос" },
      { role: "user", content: "Кто я" },
      { role: "assistant", content: "ответ brain" },
    ]);
  });

  it("/reset реально удаляет ключ истории в Redis и подтверждает", async () => {
    const { fetchMock, store } = stubRedisBotApiAndLlm("ответ");
    store.set("chat:tg:42", JSON.stringify([{ role: "user", content: "старый вопрос" }]));

    await handleTelegramWebhook(updateWithText("/reset"));

    // DEL ушёл в Redis, ключ пропал
    const delCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "http://upstash.test" &&
        (JSON.parse(String((init as RequestInit).body)) as string[])[0] === "del",
    );
    expect(delCall).toBeDefined();
    expect(JSON.parse(String((delCall as [string, RequestInit])[1].body))).toEqual([
      "del",
      "chat:tg:42",
    ]);
    expect(store.has("chat:tg:42")).toBe(false);
    // Последний вызов — sendMessage с подтверждением пользователю
    const lastCall = fetchMock.mock.calls.length - 1;
    expect(tgMethod(fetchMock, lastCall)).toBe("sendMessage");
    expect(String(tgBody(fetchMock, lastCall).text)).toContain("очищена");
  });

  it("команды (/help) не пишутся в историю: ни get, ни set в Redis", async () => {
    const { fetchMock, store } = stubRedisBotApiAndLlm("ответ");

    await handleTelegramWebhook(updateWithText("/help"));

    const redisCommands = fetchMock.mock.calls
      .filter(([url]) => String(url) === "http://upstash.test")
      .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as string[])[0]);
    expect(redisCommands).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("свободный текст пишет пару user/assistant в историю ключа chat:tg:{chatId}", async () => {
    const { store } = stubRedisBotApiAndLlm("ответ brain");

    await handleTelegramWebhook(updateWithText("кто ты?"));

    expect(store.get("chat:tg:42")).toBe(
      JSON.stringify([
        { role: "user", content: "кто ты?" },
        { role: "assistant", content: "ответ brain" },
      ]),
    );
  });
});

describe("handleTelegramWebhook: fail-open (Upstash задан, но REST всегда падает)", () => {
  it("свободный текст: REST падает исключением — бот всё равно отвечает, 200 ok", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    stubLlm();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === "http://upstash.test") {
        throw new Error("ECONNREFUSED");
      }
      if (String(input).includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ответ" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleTelegramWebhook(updateWithText("кто ты?"));

    expect(res.status).toBe(200);
    // LLM вызван, ответ доставлен пользователю несмотря на мёртвый Redis
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("chat/completions"))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/sendMessage"))).toBe(true);
  });
});
