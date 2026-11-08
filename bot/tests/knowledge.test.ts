import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemPrompt } from "../brain/prompt";
import {
  createKnowledge,
  knowledge,
  uiTopics,
  type KnowledgeItem,
  type KnowledgeStore,
} from "../brain/knowledge";
import type { Logger } from "../log";

/** Шпион-логгер: полная форма Logger, все методы — vi.fn. */
function makeLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    warnThrottled: vi.fn(),
  };
}

/** Хранилище на управляемой фикстуре: read возвращает JSON или бросает. */
function makeKnowledge(readImpl: (url: URL) => string) {
  const log = makeLog();
  const store = createKnowledge({ read: readImpl, log });
  return { store, log };
}

/** Фейковое хранилище на готовых записях — для чистых тестов uiTopics. */
function storeWith(entries: KnowledgeItem[]): Pick<KnowledgeStore, "load"> {
  return { load: () => entries };
}

/** Читалка-фикстура для systemPrompt: см. prompt.test.ts. */
function fixtureRead(parts: Record<string, string>) {
  return {
    read: (url: URL) => {
      const name = url.pathname.split("/").at(-1) ?? "";
      const content = parts[name];
      if (content === undefined) throw new Error(`неожиданный файл промта: ${name}`);
      return content;
    },
  };
}

/** Разделы промта для fixtureRead: плейсхолдер справки должен быть ровно один. */
const PROMPT_PARTS = {
  "00-persona.md": "ПЕРСОНА.",
  "10-rules.md": "ПРАВИЛА.",
  "20-knowledge.md": "СПРАВКА:\n\n{{KNOWLEDGE}}",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("knowledge: безопасное чтение", () => {
  it("валидный JSON → записи отдаются как есть; пометки и лишние поля сохраняются", () => {
    const { store } = makeKnowledge(() =>
      JSON.stringify([
        { id: "services", title: "Услуги", text: "Сайты и боты", chip: true, extra: 1 },
      ]),
    );

    const entries = store.load();

    expect(entries).toEqual([
      { id: "services", title: "Услуги", text: "Сайты и боты", chip: true, extra: 1 },
    ]);
  });

  it("кэш исхода: повторный load() отдаёт тот же массив и не перечитывает файл", () => {
    const read = vi.fn(() => JSON.stringify([{ id: "topic", title: "Тема", text: "Текст" }]));
    const { store } = makeKnowledge(read as (url: URL) => string);

    const first = store.load();
    const second = store.load();

    // Тот же массив: на идентичности опирается кэш сборки промта
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("битый JSON → null и warn с причиной; повторный load() не перечитывает", () => {
    const { store, log } = makeKnowledge(() => "{oops");

    expect(store.load()).toBeNull();
    expect(store.load()).toBeNull();
    // Неудача кэшируется: один warn на инстанс, а не на каждый запрос
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "knowledge",
      expect.stringContaining("справка недоступна"),
    );
  });

  it("read бросает (ENOENT-сценарий) → null, не бросает", () => {
    const { store, log } = makeKnowledge(() => {
      throw new Error("ENOENT: no such file");
    });

    expect(store.load()).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("knowledge", expect.stringContaining("ENOENT"));
  });

  it("корень не массив → null", () => {
    const { store } = makeKnowledge(() => JSON.stringify({ title: "не массив" }));

    expect(store.load()).toBeNull();
  });

  it("пустой массив — валидное состояние → []", () => {
    const { store } = makeKnowledge(() => "[]");

    expect(store.load()).toEqual([]);
  });
});

describe("knowledge: валидация формы", () => {
  it("записи без непустых title/text отбрасываются с warn (fail-soft)", () => {
    const json = JSON.stringify([
      { id: "no-text", title: "нет текста" },
      { id: "services", title: "Услуги", text: "Сайты и боты" },
      { id: "", title: "", text: "пустой заголовок" },
      { id: "no-title", text: "нет заголовка" },
      "не объект",
      null,
      { id: "contacts", title: "Контакты", text: "Telegram" },
    ]);
    const { store, log } = makeKnowledge(() => json);

    const entries = store.load();

    expect(entries).toEqual([
      { id: "services", title: "Услуги", text: "Сайты и боты" },
      { id: "contacts", title: "Контакты", text: "Telegram" },
    ]);
    // По warn на каждую из пяти отброшенных записей
    expect(log.warn).toHaveBeenCalledTimes(5);
  });

  it("id обязателен и должен быть slug'ом: нарушение → запись отброшена с warn", () => {
    const json = JSON.stringify([
      { title: "нет id", text: "текст" },
      { id: "2", title: "только цифры (legacy-индекс)", text: "текст" },
      { id: "UPPER", title: "капс", text: "текст" },
      { id: "тема", title: "кириллица", text: "текст" },
      { id: "-lead", title: "начинается с дефиса", text: "текст" },
      { id: "a".repeat(49), title: "длиннее 48", text: "текст" },
      { id: "valid-id", title: "Ок", text: "текст" },
    ]);
    const { store, log } = makeKnowledge(() => json);

    const entries = store.load();

    expect(entries).toEqual([{ id: "valid-id", title: "Ок", text: "текст" }]);
    expect(log.warn).toHaveBeenCalledTimes(6);
  });

  it("дубликат id: вторая запись отбрасывается, первая выигрывает (кнопка не ведёт «не туда»)", () => {
    const json = JSON.stringify([
      { id: "services", title: "Первая", text: "текст" },
      { id: "services", title: "Вторая", text: "текст" },
    ]);
    const { store, log } = makeKnowledge(() => json);

    const entries = store.load();

    expect(entries).toEqual([{ id: "services", title: "Первая", text: "текст" }]);
    expect(log.warn).toHaveBeenCalledWith("knowledge", expect.stringContaining("дубликат id"));
  });

  it("chip/about не true (правка руками мимо контракта) → запись живёт, пометка игнорируется с warn", () => {
    const json = JSON.stringify([
      { id: "wrong-mark", title: "Тема", text: "текст", chip: "true", about: 1 },
    ]);
    const { store, log } = makeKnowledge(() => json);

    const entries = store.load();

    expect(entries).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith("knowledge", expect.stringContaining("chip не true"));
    expect(log.warn).toHaveBeenCalledWith("knowledge", expect.stringContaining("about не true"));
  });

  it("валидный keywords — массив непустых строк — сохраняется как есть", () => {
    const json = JSON.stringify([
      { id: "pricing", title: "Стоимость", text: "текст", keywords: ["цена", "стоит"] },
      { id: "empty", title: "Пустой", text: "текст", keywords: [] },
    ]);
    const { store, log } = makeKnowledge(() => json);

    expect(store.load()).toEqual([
      { id: "pricing", title: "Стоимость", text: "текст", keywords: ["цена", "стоит"] },
      { id: "empty", title: "Пустой", text: "текст", keywords: [] },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keywords-мусор: строка, число, массив с пустой строкой → warn, поле удалено, запись живёт", () => {
    const json = JSON.stringify([
      { id: "a", title: "Т", text: "текст", keywords: "цена" },
      { id: "b", title: "Т", text: "текст", keywords: 42 },
      { id: "c", title: "Т", text: "текст", keywords: ["цена", ""] },
      { id: "d", title: "Т", text: "текст", keywords: [42] },
    ]);
    const { store, log } = makeKnowledge(() => json);

    const entries = store.load();

    // Поле удалено целиком — мусор не доезжает до поиска, записи остались
    expect(entries).toEqual([
      { id: "a", title: "Т", text: "текст" },
      { id: "b", title: "Т", text: "текст" },
      { id: "c", title: "Т", text: "текст" },
      { id: "d", title: "Т", text: "текст" },
    ]);
    expect(log.warn).toHaveBeenCalledTimes(4);
    expect(log.warn).toHaveBeenCalledWith(
      "knowledge",
      expect.stringContaining("keywords не массив непустых строк"),
    );
  });

  it("keywords не попадают в systemPrompt и uiTopics — только поисковый слой", () => {
    const entries: KnowledgeItem[] = [
      {
        id: "chip-record",
        title: "Тема-чип",
        text: "Текст справки.",
        chip: true,
        keywords: ["секретный-синоним"],
      },
      {
        id: "plain-record",
        title: "Тема без чипа",
        text: "Текст.",
        keywords: ["секретный-синоним"],
      },
    ];

    // Промт собирается из title+text: синоним в него не утекает
    const prompt = systemPrompt(entries, fixtureRead(PROMPT_PARTS));
    expect(prompt).toContain("## Тема-чип\nТекст справки.");
    expect(prompt).not.toContain("секретный-синоним");

    // uiTopics собирается по chip-пометке: keywords не влияют на состав
    expect(uiTopics(storeWith(entries)).map((item) => item.id)).toEqual(["chip-record"]);
  });

  it("contact: true сохраняется как есть", () => {
    const { store, log } = makeKnowledge(() =>
      JSON.stringify([{ id: "contacts", title: "Контакты", text: "текст", contact: true }]),
    );

    expect(store.load()).toEqual([
      { id: "contacts", title: "Контакты", text: "текст", contact: true },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("contact не true (правка руками мимо контракта) → warn, флаг игнорируется, запись живёт", () => {
    const json = JSON.stringify([
      { id: "a", title: "Т", text: "текст", contact: "true" },
      { id: "b", title: "Т", text: "текст", contact: 1 },
    ]);
    const { store, log } = makeKnowledge(() => json);

    const entries = store.load();

    // Записи живы вместе с сырым значением — потребители проверяют === true
    expect(entries).toEqual([
      { id: "a", title: "Т", text: "текст", contact: "true" },
      { id: "b", title: "Т", text: "текст", contact: 1 },
    ]);
    expect(entries?.every((item) => item.contact !== true)).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith("knowledge", expect.stringContaining("contact не true"));
  });

  it("несколько contact: true — не ошибка: выбор первой в файле остаётся за потребителем (find)", () => {
    const json = JSON.stringify([
      { id: "first", title: "Первая", text: "текст", contact: true },
      { id: "second", title: "Вторая", text: "текст", contact: true },
    ]);
    const { store, log } = makeKnowledge(() => json);

    expect(store.load()).toEqual([
      { id: "first", title: "Первая", text: "текст", contact: true },
      { id: "second", title: "Вторая", text: "текст", contact: true },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("реальный knowledge.json валиден целиком: ничего не отброшено, id уникальны, UI-пометки на месте", () => {
    // Страховка контента: правка knowledge.json руками ловится pre-commit'ом,
    // а не на проде (файл читается дефолтным инстансом — реальный fs).
    const raw = JSON.parse(
      readFileSync(new URL("../brain/knowledge.json", import.meta.url), "utf8"),
    ) as unknown[];
    const entries = knowledge.load() ?? [];

    // Валидация не отбросила ни одной записи
    expect(entries.length).toBe(raw.length);
    // id уникальны — иначе кнопки молча вели бы «не туда»
    const ids = entries.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of entries) {
      expect(item.title.trim()).not.toBe("");
      expect(item.text.trim()).not.toBe("");
    }
    // UI-пометки существуют: чипсы для кнопок и текст для /about
    expect(entries.filter((item) => item.chip === true).length).toBeGreaterThan(0);
    expect(entries.some((item) => item.about === true)).toBe(true);
    // Стартовый набор dumb-поиска на месте: синонимы заполнены, есть запись-контакт
    expect(entries.filter((item) => item.keywords !== undefined).length).toBeGreaterThan(0);
    expect(entries.some((item) => item.contact === true)).toBe(true);
  });
});

describe("uiTopics: единый источник UI-подсказок (чипсы вебчата + кнопки /start)", () => {
  const FIXTURE: KnowledgeItem[] = [
    { id: "intro", title: "Вступление", text: "без пометки" },
    { id: "topic-a", title: "Тема A", text: "текст", chip: true },
    { id: "topic-b", title: "Тема B", text: "текст", chip: true },
    { id: "topic-c", title: "Тема C", text: "текст", chip: true },
    { id: "topic-d", title: "Тема D", text: "текст", chip: true },
    { id: "about", title: "Кто я", text: "текст", about: true },
  ];

  it("берёт помеченные chip в порядке файла — не первые в массиве; лимит по умолчанию 3", () => {
    expect(uiTopics(storeWith(FIXTURE)).map((item) => item.id)).toEqual([
      "topic-a",
      "topic-b",
      "topic-c",
    ]);
  });

  it("явный limit режет список (для тестов и будущих потребителей)", () => {
    expect(uiTopics(storeWith(FIXTURE), 2).map((item) => item.id)).toEqual(["topic-a", "topic-b"]);
  });

  it("справка недоступна (load → null) → пустой список, не бросает", () => {
    expect(uiTopics({ load: () => null })).toEqual([]);
  });

  it("нет пометок chip → пустой список: UI уходит без подсказок, а не ошибкой", () => {
    const noChips: KnowledgeItem[] = [
      { id: "intro", title: "Вступление", text: "без пометки" },
      { id: "about", title: "Кто я", text: "текст", about: true },
    ];

    expect(uiTopics(storeWith(noChips))).toEqual([]);
  });
});
