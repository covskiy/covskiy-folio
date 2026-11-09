import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfig } from "../config";
import { answer, createBrain, type Llm } from "../brain/brain";
import { createKnowledge, type KnowledgeItem } from "../brain/knowledge";
import { createLlm, type LlmMessage, type LlmPing } from "../llm";
import type { ChatMessage } from "../store";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Фикстура справки: brain-тесты не зависят от контента реального knowledge.json. */
const FIXTURE_ENTRIES: KnowledgeItem[] = [
  { id: "contacts", title: "Контакты", text: "Связаться быстрее всего в Telegram." },
  { id: "services", title: "Услуги", text: "Сайты, боты, интеграции нейросетей." },
];

/** Фейковое хранилище справки на фикстуре. */
function fakeKnowledge(entries: KnowledgeItem[] = FIXTURE_ENTRIES) {
  return { load: () => entries };
}

/** Фейковый транспорт: chat по сценарию, ping — заглушка (brain его не зовёт). */
function fakeLlm(chatImpl: (messages: LlmMessage[]) => Promise<string>): Llm {
  return {
    chat: vi.fn(chatImpl),
    ping: vi.fn(async (): Promise<LlmPing> => ({ ok: true })),
  };
}

/** Шпион-логгер: полная форма Logger, все методы — vi.fn. */
function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    warnThrottled: vi.fn(),
  };
}

/** Транспорт, который всегда падает — brain должен уходить в dumb без сети. */
function brokenLlm(): Llm {
  return fakeLlm(async () => {
    throw new Error("LLM endpoint вернул 500");
  });
}

describe("answer: LLM-ветка", () => {
  it('успешный chat → {mode:"llm"}; system-промт и вопрос собирает brain', async () => {
    const llm = fakeLlm(async () => "Ответ от LLM");
    const log = makeLog();
    const { answer: brainAnswer } = createBrain({ llm, log, knowledge: fakeKnowledge() });

    const result = await brainAnswer("привет");

    expect(result).toEqual({ text: "Ответ от LLM", mode: "llm" });
    // LLM-ответ решает вопрос сам: подсказок «что спросить дальше» не нужно
    expect(result.suggestions).toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
    const messages = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as LlmMessage[];
    expect(messages[0].role).toBe("system");
    // Без истории: system + сам вопрос
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "привет" });
  });

  it("HISTORY_WINDOW: из 14 сообщений истории в chat уходят ровно 10 последних + вопрос", async () => {
    const llm = fakeLlm(async () => "Ок");
    const { answer: brainAnswer } = createBrain({ llm, knowledge: fakeKnowledge() });

    const history = Array.from({ length: 14 }, (_, i): ChatMessage => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `сообщение ${i}`,
    }));
    await brainAnswer("текущий вопрос", history);

    const messages = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as LlmMessage[];
    // system + 10 сообщений истории + вопрос
    expect(messages).toHaveLength(12);
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toMatchObject({ content: "сообщение 4" });
    expect(messages[10]).toMatchObject({ content: "сообщение 13" });
    expect(messages[11]).toMatchObject({ role: "user", content: "текущий вопрос" });
  });

  it("LLM отвечает markdown-ом → наружу и в историю уходит чистый plain text", async () => {
    const llm = fakeLlm(async () =>
      [
        "Пять направлений:",
        "- **PWA-приложения** — офлайн;",
        "- `фронтенд` — React.",
        "",
        "### Детали — в личных.",
      ].join("\n"),
    );
    const log = makeLog();
    const { answer: brainAnswer } = createBrain({ llm, log, knowledge: fakeKnowledge() });

    const result = await brainAnswer("что ты умеешь?");

    // Модель прислала markdown — промт запретил, но не гарантирует
    expect(result.mode).toBe("llm");
    expect(result.text).toBe(
      [
        "Пять направлений:",
        "• PWA-приложения — офлайн;",
        "• фронтенд — React.",
        "",
        "Детали — в личных.",
      ].join("\n"),
    );
    expect(result.text).not.toContain("**");
  });

  it("HISTORY_WINDOW из env: окно 2 → в chat system + 2 последних + вопрос", async () => {
    vi.stubEnv("HISTORY_WINDOW", "2");
    const llm = fakeLlm(async () => "Ок");
    const { answer: brainAnswer } = createBrain({ llm, knowledge: fakeKnowledge() });

    const history = Array.from({ length: 14 }, (_, i): ChatMessage => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `сообщение ${i}`,
    }));
    await brainAnswer("текущий вопрос", history);

    const messages = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as LlmMessage[];
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({ content: "сообщение 12" });
    expect(messages[2]).toMatchObject({ content: "сообщение 13" });
    expect(messages[3]).toMatchObject({ role: "user", content: "текущий вопрос" });
  });
});

describe("answer: dumb-режим (fallback)", () => {
  it("ошибка chat → dumb-ответ по справке + log.error с причиной", async () => {
    const llm = brokenLlm();
    const log = makeLog();
    const { answer: brainAnswer } = createBrain({ llm, log, knowledge: fakeKnowledge() });

    const result = await brainAnswer("как связаться?");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Telegram");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "brain",
      expect.stringContaining("LLM недоступен (LLM endpoint вернул 500)"),
    );
  });

  it("LLM не настроен (транспорт бросает) → dumb-ответ по справке", async () => {
    // Реальный транспорт с пустым config — та же ситуация «без LLM в env вообще».
    const { answer: brainAnswer } = createBrain({
      llm: createLlm({ config: createConfig({}) }),
      knowledge: fakeKnowledge(),
    });

    const result = await brainAnswer("расскажи про услуги");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Сайты");
  });

  it("незнакомый вопрос → вежливый fallback, а не чужой параграф", async () => {
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(),
    });

    const result = await brainAnswer("когда запуск ракеты на марс?");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Не нашёл");
  });
});

describe("answer: оркестрация search (инъекция)", () => {
  const ITEM = FIXTURE_ENTRIES[0];

  /** Фейковый поиск: возвращает заданные попадания, сам вызов — шпион. */
  function fakeSearch(hits: Array<{ item: KnowledgeItem; score: number }>) {
    return vi.fn(() => hits);
  }

  it("LLM успешен → search не вызван", async () => {
    const search = fakeSearch([{ item: ITEM, score: 1 }]);
    const { answer: brainAnswer } = createBrain({
      llm: fakeLlm(async () => "Ответ от LLM"),
      knowledge: fakeKnowledge(),
      search,
    });

    const result = await brainAnswer("любой вопрос");

    expect(result).toEqual({ text: "Ответ от LLM", mode: "llm" });
    expect(search).not.toHaveBeenCalled();
  });

  it("LLM упал → search вызван ровно один раз с (question, entries)", async () => {
    const search = fakeSearch([]);
    const entries = fakeKnowledge().load() as KnowledgeItem[];
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(),
      search,
    });

    await brainAnswer("как связаться?");

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("как связаться?", entries);
  });

  it("уверенное попадание (score >= порога) → заголовок, пустая строка, текст", async () => {
    const search = fakeSearch([{ item: ITEM, score: 0.3 }]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(),
      search,
    });

    const result = await brainAnswer("как связаться?");

    expect(result).toEqual({ text: `${ITEM.title}\n\n${ITEM.text}`, mode: "dumb" });
  });

  it("попадание ниже порога → fallback с near-miss-подсказкой, а не чужой текст", async () => {
    const search = fakeSearch([{ item: ITEM, score: 0.29 }]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(),
      search,
    });

    const result = await brainAnswer("незнакомый вопрос");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Не нашёл");
    expect(result.text).not.toContain(ITEM.text);
    // Единственный источник подсказок здесь — сам near-miss: contact и chip в
    // фикстуре нет, поэтому список ровно из одного попадания ниже порога
    expect(result.suggestions).toEqual([{ id: ITEM.id, title: ITEM.title }]);
  });

  it("порог из env: DUMB_SCORE_THRESHOLD=0.9 переводит score 0.3 в fallback с near-miss-подсказкой", async () => {
    vi.stubEnv("DUMB_SCORE_THRESHOLD", "0.9");
    const search = fakeSearch([{ item: ITEM, score: 0.3 }]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(),
      search,
    });

    const result = await brainAnswer("как связаться?");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Не нашёл");
    // Тот же hit стал near-miss — поведение порога управляется env.
    expect(result.suggestions).toEqual([{ id: ITEM.id, title: ITEM.title }]);
  });

  it("пустые попадания (search вернул []) → FALLBACK_PLAIN, поля suggestions нет", async () => {
    const search = fakeSearch([]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(),
      search,
    });

    const result = await brainAnswer("ракета на марс");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Не нашёл");
    expect(result.suggestions).toBeUndefined();
  });

  it("knowledge.load() === null → search не вызван, UNAVAILABLE_ANSWER", async () => {
    const search = fakeSearch([{ item: ITEM, score: 1 }]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: { load: () => null },
      search,
    });

    const result = await brainAnswer("любой вопрос");

    expect(result).toEqual({
      text: expect.stringContaining("Справка временно недоступна"),
      mode: "dumb",
    });
    expect(search).not.toHaveBeenCalled();
    // UNAVAILABLE_ANSWER — не fallback поиска: справки нет, подсказкам неоткуда взяться
    expect(result.suggestions).toBeUndefined();
  });
});

describe("answer: подсказки dumb-fallback (pickSuggestions)", () => {
  /** Фикстура fallback с подсказками: contact-запись + chip-темы для uiTopics. */
  const SUGGESTION_ENTRIES: KnowledgeItem[] = [
    { id: "services", title: "Услуги", text: "Сайты, боты, интеграции нейросетей.", chip: true },
    { id: "pricing", title: "Стоимость", text: "Оценка под конкретную задачу.", chip: true },
    {
      id: "contacts",
      title: "Контакты",
      text: "Связаться быстрее всего в Telegram.",
      contact: true,
    },
    { id: "about", title: "Кто я", text: "Константин Ковский — тестовая справка.", about: true },
  ];

  function fakeSearch(hits: Array<{ item: KnowledgeItem; score: number }>) {
    return vi.fn(() => hits);
  }

  it("fallback без near-miss (search → []) → FALLBACK_WITH_SUGGESTIONS: contact-запись + uiTopics", async () => {
    const search = fakeSearch([]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(SUGGESTION_ENTRIES),
      search,
    });

    const result = await brainAnswer("ракета на марс");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("выбери тему ниже");
    // Порядок: contact-запись (near-miss пуст) → chip-темы в порядке файла
    expect(result.suggestions).toEqual([
      { id: "contacts", title: "Контакты" },
      { id: "services", title: "Услуги" },
      { id: "pricing", title: "Стоимость" },
    ]);
  });

  it("fallback с near-miss → до 2 попаданий ниже порога, затем contact, затем uiTopics", async () => {
    const search = fakeSearch([
      { item: SUGGESTION_ENTRIES[3], score: 0.25 }, // about
      { item: SUGGESTION_ENTRIES[1], score: 0.15 }, // pricing
      { item: SUGGESTION_ENTRIES[0], score: 0.1 }, // services — третий near-miss отсекается
    ]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(SUGGESTION_ENTRIES),
      search,
    });

    const result = await brainAnswer("незнакомый вопрос");

    // Пул: [about, pricing] + contact + uiTopics([services, pricing]) →
    // дедуп → [about, pricing, contacts, services] → лимит 3
    expect(result.suggestions).toEqual([
      { id: "about", title: "Кто я" },
      { id: "pricing", title: "Стоимость" },
      { id: "contacts", title: "Контакты" },
    ]);
  });

  it("дубликаты по id убираются, максимум 3 подсказки", async () => {
    // near-miss содержит contact-запись и chip-тему: обе вернутся в пул второй раз
    const search = fakeSearch([
      { item: SUGGESTION_ENTRIES[2], score: 0.25 }, // contacts (она же contact)
      { item: SUGGESTION_ENTRIES[0], score: 0.2 }, // services (она же в uiTopics)
    ]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(SUGGESTION_ENTRIES),
      search,
    });

    const result = await brainAnswer("незнакомый вопрос");

    const suggestions = result.suggestions ?? [];
    expect(suggestions).toHaveLength(3);
    const ids = suggestions.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    // Повторы заняли бы первые слоты: из uiTopics прорывается третья тема
    expect(suggestions).toEqual([
      { id: "contacts", title: "Контакты" },
      { id: "services", title: "Услуги" },
      { id: "pricing", title: "Стоимость" },
    ]);
  });

  it("подсказок нет (нет contact, uiTopics пуст) → FALLBACK_PLAIN, поля suggestions нет", async () => {
    const search = fakeSearch([]);
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      // FIXTURE_ENTRIES: без contact и chip — собирать подсказки не из чего
      knowledge: fakeKnowledge(),
      search,
    });

    const result = await brainAnswer("ракета на марс");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Попробуй спросить иначе.");
    expect(result.text).not.toContain("выбери тему ниже");
    expect("suggestions" in result).toBe(false);
  });

  it("уверенный dumb-ответ → подсказок нет, даже если контакт и темы доступны", async () => {
    const search = fakeSearch([{ item: SUGGESTION_ENTRIES[2], score: 0.9 }]); // contacts
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      knowledge: fakeKnowledge(SUGGESTION_ENTRIES),
      search,
    });

    const result = await brainAnswer("как связаться?");

    expect(result).toEqual({
      text: `${SUGGESTION_ENTRIES[2].title}\n\n${SUGGESTION_ENTRIES[2].text}`,
      mode: "dumb",
    });
    expect(result.suggestions).toBeUndefined();
  });
});

describe("answer: сборка промта (честный лог)", () => {
  /** Сборщик промта, бросающий как сломанный {{KNOWLEDGE}} в md. */
  const brokenPrompt = (): string => {
    throw new Error("{{KNOWLEDGE}} должен встречаться ровно 1 раз, найдено: 0");
  };

  it("промт бросил → llm.chat не вызван, log.error про промт, без «LLM недоступен»", async () => {
    const llm = fakeLlm(async () => "LLM не должен вызываться");
    const log = makeLog();
    const search = vi.fn(() => []);
    const { answer: brainAnswer } = createBrain({
      llm,
      log,
      knowledge: fakeKnowledge(),
      prompt: brokenPrompt,
      search,
    });

    // Не бросает: контракт «никогда не бросает» действует и для этой деградации.
    const result = await brainAnswer("как связаться?");

    expect(llm.chat).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "brain",
      expect.stringContaining("system-промт не собран"),
    );
    const logged = (log.error as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(logged).not.toContain("LLM недоступен");
    expect(result.mode).toBe("dumb");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("промт собран, транспорт упал → по-прежнему «LLM недоступен»", async () => {
    const log = makeLog();
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      log,
      knowledge: fakeKnowledge(),
      prompt: () => "собранный промт",
    });

    const result = await brainAnswer("как связаться?");

    expect(result.mode).toBe("dumb");
    expect(log.error).toHaveBeenCalledWith("brain", expect.stringContaining("LLM недоступен"));
  });
});

describe("answer: справка недоступна (fail-safe)", () => {
  it("битый knowledge.json → безопасный ответ без вызова LLM и без ложного «LLM недоступен»", async () => {
    const brokenKnowledge = createKnowledge({ read: () => "{oops", log: makeLog() });
    const log = makeLog();
    const llm = fakeLlm(async () => "LLM не должен вызываться");
    const { answer: brainAnswer } = createBrain({ llm, log, knowledge: brokenKnowledge });

    const result = await brainAnswer("любой вопрос");

    expect(result).toEqual({
      text: expect.stringContaining("Справка временно недоступна"),
      mode: "dumb",
    });
    expect(llm.chat).not.toHaveBeenCalled();
    // Причина справки не маскируется под «LLM недоступен» — атрибуция честная
    expect(log.error).not.toHaveBeenCalled();
  });

  it("справка недоступна И LLM сломан → answer() резолвится: контракт «никогда не бросает»", async () => {
    const brokenKnowledge = createKnowledge({
      read: () => {
        throw new Error("ENOENT: knowledge.json отсутствует");
      },
      log: makeLog(),
    });
    const { answer: brainAnswer } = createBrain({
      llm: brokenLlm(),
      log: makeLog(),
      knowledge: brokenKnowledge,
    });

    const result = await brainAnswer("вопрос при двойной деградации");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Справка временно недоступна");
  });
});

describe("дефолтный экспорт answer", () => {
  it("переиспользует createBrain: dumb-путь работает без сети", async () => {
    // Дефолтный llm читает process.env на вызов — пустим его в dumb.
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");

    const result = await answer("когда запуск ракеты на марс?");

    expect(result.mode).toBe("dumb");
    expect(result.text).toContain("Не нашёл");
  });

  it("«Сколько стоит?» на реальной справке → уверенный dumb-ответ с заголовком", async () => {
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");

    const result = await answer("Сколько стоит?");

    expect(result.mode).toBe("dumb");
    // Заголовок записи, пустая строка, текст — формат formatHit
    expect(result.text.startsWith("Стоимость\n\n")).toBe(true);
  });
});
