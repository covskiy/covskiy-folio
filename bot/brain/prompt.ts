import { readFileSync } from "node:fs";

/**
 * Одна запись справки — элемент контента бота из lib/knowledge.json.
 */
export interface KnowledgeItem {
  /** Заголовок-тема: вставляется в промт и служит текстом чипа/кнопки-подсказки. */
  title: string;
  /** Текст ответа: вставляется в промт и отдаётся в dumb-режиме как есть. */
  text: string;
}

// Знания — lib/knowledge.json: тот же fs-паттерн с литеральным путём,
// без import-атрибутов (и их рисков на трансляторе облака).
// Читаем лениво, а не при загрузке модуля: тогда даже затерявшийся в
// артефакте json роняет только запрос (в dumb-режим), а не весь импорт.
let cachedEntries: KnowledgeItem[] | undefined;

/**
 * Все записи справки из lib/knowledge.json. Читается лениво и кэшируется —
 * файл читается один раз за жизнь инстанса функции.
 * @returns {KnowledgeItem[]} Записи справки в порядке файла.
 */
export function knowledgeEntries(): KnowledgeItem[] {
  cachedEntries ??= JSON.parse(
    readFileSync(new URL("./knowledge.json", import.meta.url), "utf8"),
  ) as KnowledgeItem[];
  return cachedEntries;
}

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
 * Собранный system-промт: lib/prompts/00-persona.md + 10-rules.md +
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
