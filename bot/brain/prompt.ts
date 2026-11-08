import { readFileSync } from "node:fs";
import type { KnowledgeItem } from "./knowledge.js";

// Порядок в массиве = порядок секций в промте.
// Цифровые префиксы имён — для человека, порядок решает код.
// Литерал new URL(...) в вызове обязателен: nodeFileTrace на Vercel
// затрейсит в артефакт только такие пути.
const PARTS = [
  new URL("./prompts/00-persona.md", import.meta.url),
  new URL("./prompts/10-rules.md", import.meta.url),
  new URL("./prompts/20-knowledge.md", import.meta.url),
] as const;

// Кэш сборки по ИДЕНТИЧНОСТИ массива записей: knowledge.load() возвращает
// один и тот же массив на жизнь инстанса, поэтому повторная сборка не
// перечитывает md-файлы. WeakMap вместо кэша-строки сознательно: вернувшаяся
// справка — это НОВЫЙ массив, деградированное состояние не может «застыть»
// в кэше; разные фикстуры тестов не затирают друг друга.
const promptCache = new WeakMap<KnowledgeItem[], string>();

/**
 * Собранный system-промт: bot/brain/prompts/00-persona.md + 10-rules.md +
 * 20-knowledge.md, склеенные пустой строкой, со справкой вместо {{KNOWLEDGE}}.
 * Записи принимает готовыми (из knowledge.ts): сборка промта не читает
 * knowledge.json сама — за безопасное чтение отвечает знаниевый модуль.
 * @param {KnowledgeItem[]} entries - Валидированные записи справки.
 * @returns {string} Готовый system-промт для LLM.
 */
export function systemPrompt(entries: KnowledgeItem[]): string {
  let cached = promptCache.get(entries);
  if (cached === undefined) {
    cached = PARTS.map((url) => readFileSync(url, "utf8").trim())
      .join("\n\n")
      .replace(
        "{{KNOWLEDGE}}",
        // Функция вместо строки: $-последовательности в тексте справки
        // иначе были бы съедены как спец-паттерны замены.
        () => entries.map((item) => `## ${item.title}\n${item.text}`).join("\n\n"),
      );
    promptCache.set(entries, cached);
  }
  return cached;
}
