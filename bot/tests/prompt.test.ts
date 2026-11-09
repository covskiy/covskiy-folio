import { describe, expect, it, vi } from "vitest";
import { systemPrompt, type PromptDeps } from "../brain/prompt";
import type { KnowledgeItem } from "../brain/knowledge";

/** Читалка-фикстура: отдаёт содержимое по имени файла, неожиданный файл — бросок. */
function fixtureRead(parts: Record<string, string>): PromptDeps {
  return {
    read: (url: URL) => {
      const name = url.pathname.split("/").at(-1) ?? "";
      const content = parts[name];
      if (content === undefined) throw new Error(`неожиданный файл промта: ${name}`);
      return content;
    },
  };
}

/** Свежий массив на каждый тест: кэш сборки ключуется идентичностью массива. */
function entries(): KnowledgeItem[] {
  return [
    { id: "one", title: "Тема один", text: "Текст один" },
    { id: "two", title: "Тема два", text: "Текст два" },
  ];
}

const THREE_PARTS = {
  "00-persona.md": "ПЕРСОНА.",
  "10-rules.md": "ПРАВИЛА.",
  "20-knowledge.md": "СПРАВКА:\n\n{{KNOWLEDGE}}",
};

describe("systemPrompt: сборка", () => {
  it("склеивает разделы и подставляет записи вместо {{KNOWLEDGE}}", () => {
    const prompt = systemPrompt(entries(), fixtureRead(THREE_PARTS));

    expect(prompt).toContain("ПЕРСОНА.");
    expect(prompt).toContain("ПРАВИЛА.");
    expect(prompt).toContain("Тема один:\nТекст один");
    expect(prompt).toContain("Тема два:\nТекст два");
    expect(prompt).not.toContain("{{KNOWLEDGE}}");
  });

  it("md-разделы trim'ятся перед склейкой", () => {
    const prompt = systemPrompt(entries(), fixtureRead(THREE_PARTS));

    expect(prompt).not.toContain("ПЕРСОНА.\n\n\n");
    expect(prompt).toContain("ПЕРСОНА.\n\nПРАВИЛА.");
  });

  it("кэш по идентичности массива: тот же массив — md перечитан один раз", () => {
    const read = vi.fn((url: URL) =>
      url.pathname.endsWith("20-knowledge.md") ? "{{KNOWLEDGE}}" : "текст раздела",
    );
    const sameEntries = [{ id: "topic", title: "Тема", text: "Текст" }];

    const first = systemPrompt(sameEntries, { read });
    const second = systemPrompt(sameEntries, { read });

    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(3); // три md-раздела, один проход сборки
  });
});

describe("systemPrompt: контракт плейсхолдера", () => {
  it("плейсхолдер пропал → бросок с точной причиной (найдено: 0)", () => {
    expect(() =>
      systemPrompt(
        entries(),
        fixtureRead({
          "00-persona.md": "ПЕРСОНА.",
          "10-rules.md": "ПРАВИЛА.",
          "20-knowledge.md": "СПРАВКА без плейсхолдера",
        }),
      ),
    ).toThrow("{{KNOWLEDGE}} должен встречаться ровно 1 раз, найдено: 0");
  });

  it("дубль плейсхолдера → бросок с числом вхождений (найдено: 2)", () => {
    expect(() =>
      systemPrompt(
        entries(),
        fixtureRead({
          "00-persona.md": "ПЕРСОНА.",
          "10-rules.md": "ДУБЛЬ: {{KNOWLEDGE}}",
          "20-knowledge.md": "{{KNOWLEDGE}}",
        }),
      ),
    ).toThrow("{{KNOWLEDGE}} должен встречаться ровно 1 раз, найдено: 2");
  });

  it("реальные md-файлы собираются: плейсхолдер на месте и потребляется", () => {
    // Страховка реальных промт-файлов: правка 20-knowledge.md ловится
    // pre-commit'ом, а не на проде (реальный fs — как в рантайме).
    const prompt = systemPrompt(entries());

    expect(prompt).toContain("Тема один:");
    expect(prompt).not.toContain("{{KNOWLEDGE}}");
  });
});
