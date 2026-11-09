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

/**
 * Зависимости сборки промта — точки инъекции для тестов; в рантайме
 * systemPrompt(entries) без deps (реальный fs).
 */
export interface PromptDeps {
  /** Читает раздел промта по URL; по умолчанию readFileSync(url, "utf8"). */
  read?: (url: URL) => string;
}

// Кэш сборки по ИДЕНТИЧНОСТИ массива записей: knowledge.load() возвращает
// один и тот же массив на жизнь инстанса, поэтому повторная сборка не
// перечитывает md-файлы. Ключ — только entries: рантайм всегда идёт с
// дефолтным read, тесты приходят со свежими массивами. WeakMap вместо
// кэша-строки сознательно: вернувшаяся справка — это НОВЫЙ массив,
// деградированное состояние не может «застыть» в кэше.
const promptCache = new WeakMap<KnowledgeItem[], string>();

/**
 * Собранный system-промт: bot/brain/prompts/00-persona.md + 10-rules.md +
 * 20-knowledge.md, склеенные пустой строкой, со справкой вместо {{KNOWLEDGE}}.
 * Записи принимает готовыми (из knowledge.ts): сборка промта не читает
 * knowledge.json сама — за безопасное чтение отвечает знаниевый модуль.
 *
 * Контракт плейсхолдера: {{KNOWLEDGE}} в собранной заготовке ровно один.
 * Пропал — LLM ушёл бы в промт без справки и начал выдумывать; дубль —
 * в промт уехал бы сырой {{KNOWLEDGE}}. Оба случая — ошибка правки md,
 * сборка бросает с точной причиной: answer() ловит и уходит в dumb с честным
 * логом (dumb-режим промт не использует), админка ?section=prompt отдаёт 502
 * с этой же причиной, тест ловит нарушение в pre-commit.
 *
 * @param {KnowledgeItem[]} entries - Валидированные записи справки.
 * @param {PromptDeps} [deps] - Инъекция read для тестов.
 * @returns {string} Готовый system-промт для LLM.
 */
export function systemPrompt(entries: KnowledgeItem[], deps: PromptDeps = {}): string {
  const read = deps.read ?? ((url: URL) => readFileSync(url, "utf8"));
  let cached = promptCache.get(entries);
  if (cached === undefined) {
    const joined = PARTS.map((url) => read(url).trim()).join("\n\n");
    const occurrences = joined.split("{{KNOWLEDGE}}").length - 1;
    if (occurrences !== 1) {
      throw new Error(`{{KNOWLEDGE}} должен встречаться ровно 1 раз, найдено: ${occurrences}`);
    }
    cached = joined.replace(
      "{{KNOWLEDGE}}",
      // Функция вместо строки: $-последовательности в тексте справки
      // иначе были бы съедены как спец-паттерны замены. Заголовок без «##»:
      // markdown в справке провоцирует модель зеркалить разметку, которую
      // мы запретили в 10-rules.md.
      () => entries.map((item) => `${item.title}:\n${item.text}`).join("\n\n"),
    );
    promptCache.set(entries, cached);
  }
  return cached;
}
