import { afterEach, describe, expect, it, vi } from "vitest";
import { createKnowledge, knowledge } from "../brain/knowledge";
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("knowledge: безопасное чтение", () => {
  it("валидный JSON → записи отдаются как есть; лишние поля сохраняются", () => {
    const { store } = makeKnowledge(() =>
      JSON.stringify([{ title: "Услуги", text: "Сайты и боты", chip: true }]),
    );

    const entries = store.load();

    expect(entries).toEqual([{ title: "Услуги", text: "Сайты и боты", chip: true }]);
  });

  it("кэш исхода: повторный load() отдаёт тот же массив и не перечитывает файл", () => {
    const read = vi.fn(() => JSON.stringify([{ title: "Тема", text: "Текст" }]));
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
  it("битые записи отбрасываются с warn, валидные живут (fail-soft)", () => {
    const json = JSON.stringify([
      { title: "нет текста" },
      { title: "Услуги", text: "Сайты и боты" },
      { title: "", text: "пустой заголовок" },
      { text: "нет заголовка" },
      "не объект",
      null,
      { title: "Контакты", text: "Telegram" },
    ]);
    const { store, log } = makeKnowledge(() => json);

    const entries = store.load();

    expect(entries).toEqual([
      { title: "Услуги", text: "Сайты и боты" },
      { title: "Контакты", text: "Telegram" },
    ]);
    // По warn на каждую из пяти отброшенных записей
    expect(log.warn).toHaveBeenCalledTimes(5);
  });

  it("реальный knowledge.json валиден: непустые title/text у каждой записи", () => {
    // Страховка контента: правка knowledge.json руками ловится pre-commit'ом,
    // а не на проде (файл читается дефолтным инстансом — реальный fs).
    const entries = knowledge.load() ?? [];

    expect(entries.length).toBeGreaterThan(0);
    for (const item of entries) {
      expect(item.title.trim()).not.toBe("");
      expect(item.text.trim()).not.toBe("");
    }
  });
});
