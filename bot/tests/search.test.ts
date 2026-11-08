import { describe, expect, it } from "vitest";
import { rankKnowledge } from "../brain/search";
import { knowledge } from "../brain/knowledge";
import type { KnowledgeItem } from "../brain/knowledge";

/**
 * Фикстура справки: тесты поиска не зависят от контента реального
 * knowledge.json. Названия id повторяют ключевые записи реального файла,
 * поэтому таблица «вопрос → топ-1» читается как интеграция.
 */
const FIXTURE_ENTRIES: KnowledgeItem[] = [
  {
    id: "services",
    title: "Услуги",
    text: "Сайты, Telegram-боты, интеграции нейросетей, PWA-приложения.",
    keywords: ["услуги", "направления", "умеешь", "делаешь", "чем занимаешься"],
  },
  {
    id: "pricing",
    title: "Стоимость",
    text: "Цена зависит от объёма проекта.",
    keywords: ["цена", "цены", "стоит", "бюджет", "оплата", "дорого"],
  },
  {
    id: "contacts",
    title: "Контакты",
    text: "Связаться быстрее всего в Telegram.",
    contact: true,
    keywords: ["связаться", "написать", "контакт", "почта", "email", "телеграм", "telegram"],
  },
  {
    id: "pwa",
    title: "PWA",
    text: "Прогрессивное веб-приложение ставится на телефон.",
    keywords: ["pwa", "офлайн"],
  },
  {
    id: "service-telegram-bots",
    title: "Услуга: Telegram-боты и Mini App",
    text: "Продукт внутри мессенджера.",
    keywords: ["телеграм", "telegram", "бот", "mini app"],
  },
  {
    id: "legacy-code",
    title: "Работаете с чужим кодом?",
    text: "Да: аудит, рефакторинг, миграции, доработка легаси.",
    keywords: ["чужой код", "легаси", "аудит"],
  },
  {
    id: "glossary",
    title: "Глоссарий",
    text: "Короткие термины ищутся наравне с длинными словами.",
    keywords: ["IT", "UX", "UI", "AI", "ИИ", "JS", "TS"],
  },
];

describe("rankKnowledge: корпус вопросов (таблица §4)", () => {
  it("«Сколько стоит?» → pricing первым", () => {
    const hits = rankKnowledge("Сколько стоит?", FIXTURE_ENTRIES);
    expect(hits[0].item.id).toBe("pricing");
    expect(hits[0].score).toBeGreaterThanOrEqual(0.3);
  });

  it("«Сколько стоит PWA?» → pricing первым: редкое «стоит» весит больше частого «pwa»", () => {
    const hits = rankKnowledge("Сколько стоит PWA?", FIXTURE_ENTRIES);
    expect(hits[0].item.id).toBe("pricing");
    expect(hits[0].item.id).not.toBe("pwa");
    // Обе записи уверенные, но pricing выше — смысл IDF-взвешивания
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("«как связаться?» → contacts", () => {
    expect(rankKnowledge("как связаться?", FIXTURE_ENTRIES)[0].item.id).toBe("contacts");
  });

  it("«телеграм» → contacts первым, service-telegram-bots в топе", () => {
    const hits = rankKnowledge("телеграм", FIXTURE_ENTRIES);
    expect(hits[0].item.id).toBe("contacts");
    expect(hits.slice(0, 2).map((hit) => hit.item.id)).toContain("service-telegram-bots");
  });

  it("«работаешь с чужим кодом?» → legacy-code (морфология: работаешь ↔ работаете)", () => {
    const hits = rankKnowledge("работаешь с чужим кодом?", FIXTURE_ENTRIES);
    expect(hits[0].item.id).toBe("legacy-code");
    expect(hits[0].score).toBeGreaterThanOrEqual(0.3);
  });

  it("«что ты умеешь?» → services", () => {
    expect(rankKnowledge("что ты умеешь?", FIXTURE_ENTRIES)[0].item.id).toBe("services");
  });

  it("«ракета на марс» → []", () => {
    expect(rankKnowledge("ракета на марс", FIXTURE_ENTRIES)).toEqual([]);
  });

  it("«IT» и «UX» находят запись по keywords (allowlist коротких слов)", () => {
    expect(rankKnowledge("IT", FIXTURE_ENTRIES)[0].item.id).toBe("glossary");
    expect(rankKnowledge("UX", FIXTURE_ENTRIES)[0].item.id).toBe("glossary");
  });
});

describe("rankKnowledge: пустые и непоисковые входы", () => {
  it("пустая строка → []", () => {
    expect(rankKnowledge("", FIXTURE_ENTRIES)).toEqual([]);
  });

  it("пунктуация без слов → []", () => {
    expect(rankKnowledge("?!., — «»()", FIXTURE_ENTRIES)).toEqual([]);
  });

  it("только стоп-слова → []", () => {
    expect(rankKnowledge("как что для это?", FIXTURE_ENTRIES)).toEqual([]);
  });

  it("пустая справка → []", () => {
    expect(rankKnowledge("телеграм", [])).toEqual([]);
  });

  it("детерминированность: два одинаковых вызова — одинаковый порядок", () => {
    const question = "телеграм-боты и цена";
    const first = rankKnowledge(question, FIXTURE_ENTRIES);
    const second = rankKnowledge(question, FIXTURE_ENTRIES);
    expect(second.map((hit) => hit.item.id)).toEqual(first.map((hit) => hit.item.id));
    expect(second.map((hit) => hit.score)).toEqual(first.map((hit) => hit.score));
  });
});

describe("rankKnowledge: нормализация и стемминг (через публичный API)", () => {
  const BASE: KnowledgeItem[] = [
    { id: "cost", title: "Стоимость", text: "Цена по задаче." },
    { id: "net", title: "Нейросеть", text: "Встраивание в процессы." },
    { id: "site", title: "Сайт", text: "Портфолио." },
    { id: "vol", title: "Тома", text: "Объём работ считаем по этапам." },
  ];

  it("ё → е: «объём» находит «Объём»", () => {
    expect(rankKnowledge("объём", BASE)[0].item.id).toBe("vol");
  });

  it("дефис — разделитель: «PWA-приложения» → pwa + приложения", () => {
    const entries: KnowledgeItem[] = [
      { id: "hyphen", title: "Тема", text: "Делаем PWA-приложения." },
    ];
    expect(rankKnowledge("pwa приложения", entries)[0].item.id).toBe("hyphen");
    expect(rankKnowledge("приложения", entries)[0].item.id).toBe("hyphen");
  });

  it("стоит ↔ Стоимость (равенство основ и префикс 4)", () => {
    expect(rankKnowledge("стоит", BASE)[0].item.id).toBe("cost");
  });

  it("цены ↔ Цена", () => {
    expect(rankKnowledge("цены", BASE)[0].item.id).toBe("cost");
  });

  it("нейросети ↔ Нейросеть", () => {
    expect(rankKnowledge("нейросети", BASE)[0].item.id).toBe("net");
  });

  it("сайты ↔ Сайт", () => {
    expect(rankKnowledge("сайты", BASE)[0].item.id).toBe("site");
  });

  it("стоп-слово вопроса само по себе ничего не находит", () => {
    expect(rankKnowledge("сколько?", BASE)).toEqual([]);
  });
});

describe("rankKnowledge: скоринг", () => {
  it("термин в нескольких полях берёт максимальный вес поля: score не превышает 1", () => {
    const hits = rankKnowledge("цена", [
      { id: "pricing", title: "Цена", text: "Цена зависит от объёма." },
    ]);
    expect(hits[0].score).toBe(1);
  });

  it("совпадение в text весит меньше, чем в title (веса полей)", () => {
    const hits = rankKnowledge("цена", [
      { id: "text-only", title: "Совсем другое", text: "Цена не о чём." },
      { id: "in-title", title: "Цена", text: "Что-то ещё." },
    ]);
    expect(hits[0].item.id).toBe("in-title");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("порядок — по убыванию score", () => {
    const hits = rankKnowledge("телеграм-боты и цена", FIXTURE_ENTRIES);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it("равные score и сильные совпадения сохраняют порядок файла (стабильность)", () => {
    // «телеграм» лежит в keywords обеих записей: score и strong равны,
    // остаётся порядок файла — contacts раньше.
    const hits = rankKnowledge("телеграм", FIXTURE_ENTRIES);
    const ids = hits.map((hit) => hit.item.id);
    expect(ids.indexOf("contacts")).toBeLessThan(ids.indexOf("service-telegram-bots"));
  });

  it("возвращает все попадания со score > 0, включая ниже любого порога", () => {
    // «цена» совпала, «блаходром» — нет: оба слагаемых знаменателя и числителя
    // детерминированы, порог в search не применяется
    const hits = rankKnowledge("цена и блаходром", FIXTURE_ENTRIES);
    expect(hits).toHaveLength(1);
    expect(hits[0].item.id).toBe("pricing");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThan(1);
  });
});

describe("rankKnowledge: смоук по реальному knowledge.json", () => {
  // Как в knowledge.test.ts: файл читает дефолтный store (реальный fs) —
  // тест выводится из контента, поэтому правки справки его не ломают,
  // а регрессии ранжирования ловятся.
  const loaded = knowledge.load();
  const entries = loaded ?? [];

  it("справка загрузилась — смоук не проверяет пустое множество", () => {
    expect(loaded).not.toBeNull();
    expect(entries.length).toBeGreaterThan(0);
  });

  it("каждая запись находится по своему title первой и уверенно", () => {
    for (const item of entries) {
      const hits = rankKnowledge(item.title, entries);
      expect(hits.length, `«${item.id}»: title не нашёл ни одной записи`).toBeGreaterThan(0);
      expect(hits[0].item.id, `«${item.id}»: по title «${item.title}» первая чужая запись`).toBe(
        item.id,
      );
      // Title-вопрос — уверенное попадание: порог brain должен пропускать
      expect(hits[0].score, `«${item.id}»: title не дотянул до порога`).toBeGreaterThanOrEqual(0.3);
    }
  });
});
