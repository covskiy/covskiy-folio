import { describe, expect, it } from "vitest";
import { systemPrompt } from "../brain/prompt";

describe("systemPrompt", () => {
  it("подставляет записи вместо {{KNOWLEDGE}}: секции с заголовками, плейсхолдер исчезает", () => {
    const prompt = systemPrompt([
      { title: "Тема один", text: "Текст один" },
      { title: "Тема два", text: "Текст два" },
    ]);

    expect(prompt).toContain("## Тема один\nТекст один");
    expect(prompt).toContain("## Тема два\nТекст два");
    expect(prompt).not.toContain("{{KNOWLEDGE}}");
  });

  it("кэш по идентичности массива: тот же массив — тот же промт без пересборки", () => {
    const entries = [{ title: "Тема", text: "Текст" }];

    const first = systemPrompt(entries);
    const second = systemPrompt(entries);

    expect(second).toBe(first);
  });
});
