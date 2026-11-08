import { readFileSync } from "node:fs";
import { knowledgeEntries } from "./knowledge.js";

// Порядок в массиве = порядок секций в промте.
// Цифровые префиксы имён — для человека, порядок решает код.
// Литерал new URL(...) в вызове обязателен: nodeFileTrace на Vercel
// затрейсит в артефакт только такие пути.
const PARTS = [
  new URL("./prompts/00-persona.md", import.meta.url),
  new URL("./prompts/10-rules.md", import.meta.url),
  new URL("./prompts/20-knowledge.md", import.meta.url),
] as const;

let cached: string | undefined;

/**
 * Собранный system-промт: bot/brain/prompts/00-persona.md + 10-rules.md +
 * 20-knowledge.md, склеенные пустой строкой, со справкой вместо {{KNOWLEDGE}}.
 * Результат кэшируется — файлы читаются один раз за жизнь инстанса.
 * @returns {string} Готовый system-промт для LLM.
 */
export function systemPrompt(): string {
  cached ??= PARTS.map((url) => readFileSync(url, "utf8").trim())
    .join("\n\n")
    .replace(
      "{{KNOWLEDGE}}",
      // Функция вместо строки: $-последовательности в тексте справки
      // иначе были бы съедены как спец-паттерны замены.
      () =>
        knowledgeEntries()
          .map((item) => `## ${item.title}\n${item.text}`)
          .join("\n\n"),
    );
  return cached;
}
