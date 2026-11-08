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
});
