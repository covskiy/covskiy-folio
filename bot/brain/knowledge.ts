import { readFileSync } from "node:fs";

/**
 * Одна запись справки — элемент контента бота из bot/brain/knowledge.json.
 */
export interface KnowledgeItem {
  /** Заголовок-тема: вставляется в промт и служит текстом чипа/кнопки-подсказки. */
  title: string;
  /** Текст ответа: вставляется в промт и отдаётся в dumb-режиме как есть. */
  text: string;
}

// Знания — bot/brain/knowledge.json: тот же fs-паттерн с литеральным путём,
// без import-атрибутов (и их рисков на трансляторе облака).
// Читаем лениво, а не при загрузке модуля: тогда даже затерявшийся в
// артефакте json роняет только запрос (в dumb-режим), а не весь импорт.
let cachedEntries: KnowledgeItem[] | undefined;

/**
 * Все записи справки из bot/brain/knowledge.json. Читается лениво и кэшируется —
 * файл читается один раз за жизнь инстанса функции.
 * @returns {KnowledgeItem[]} Записи справки в порядке файла.
 */
export function knowledgeEntries(): KnowledgeItem[] {
  cachedEntries ??= JSON.parse(
    readFileSync(new URL("./knowledge.json", import.meta.url), "utf8"),
  ) as KnowledgeItem[];
  return cachedEntries;
}
