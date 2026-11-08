import { readFileSync } from "node:fs";
import { log as rootLog, type Logger } from "../log.js";

/**
 * Одна запись справки — элемент контента бота из bot/brain/knowledge.json.
 */
export interface KnowledgeItem {
  /** Заголовок-тема: вставляется в промт и служит текстом чипа/кнопки-подсказки. */
  title: string;
  /** Текст ответа: вставляется в промт и отдаётся в dumb-режиме как есть. */
  text: string;
}

/**
 * Хранилище справки — точка инъекции для brain и UI-обработчиков.
 */
export interface KnowledgeStore {
  /**
   * Валидированные записи справки или null, если справка недоступна целиком.
   * Никогда не бросает; исход чтения (успех и неудача) кэшируется на инстанс.
   */
  load(): KnowledgeItem[] | null;
}

/**
 * Зависимости хранилища справки — точки инъекции для тестов; в рантайме
 * createKnowledge() без аргументов (реальный fs и общий log).
 */
export interface KnowledgeDeps {
  /** Читает файл по URL; по умолчанию readFileSync(url, "utf8"). */
  read?: (url: URL) => string;
  /** Логгер деградаций; по умолчанию общий log из bot/log.ts. */
  log?: Logger;
}

/**
 * Фабрика хранилища справки.
 *
 * Знания — bot/brain/knowledge.json: fs-паттерн с литеральным путём, без
 * import-атрибутов (и их рисков на трансляторе облака). Литерал new URL(...)
 * внутри вызова обязателен: nodeFileTrace на Vercel затрейсит в артефакт
 * только такие пути. Чтение ленивое, а не при загрузке модуля: затерявшийся
 * в артефакте json не роняет импорт, а деградирует ответы.
 *
 * Валидация формы — контент правится руками, tsc json не проверяет:
 * - битая запись (нет/пуст title или text) отбрасывается с warn — одна
 *   кривая строка не убивает весь файл (fail-soft);
 * - не-массив или непарсируемый JSON → null — доверять файлу нельзя
 *   (fail-safe); потребители деградируют по своей роли: UI — пустые
 *   списки, brain — безопасный ответ, админка — диагностируемая ошибка.
 * Лишние поля у записей пропускаются сознательно: UI-контракт (id/chip)
 * ляжет поверх, а не через строгую схему.
 *
 * Исход чтения кэшируется, включая неудачу: битый файл не перечитывается
 * и не перелогируется на каждый запрос, null стабилен на жизнь инстанса.
 *
 * @param {KnowledgeDeps} deps - Инъекции read/log; без аргументов — fs и log.
 * @returns Хранилище с единственным методом load().
 */
export function createKnowledge(deps: KnowledgeDeps = {}): KnowledgeStore {
  const read = deps.read ?? ((url: URL) => readFileSync(url, "utf8"));
  const log = deps.log ?? rootLog;

  // undefined — «ещё не читали»; null — «читали, справка недоступна».
  let cached: KnowledgeItem[] | null | undefined;

  function load(): KnowledgeItem[] | null {
    if (cached !== undefined) return cached;
    try {
      const parsed: unknown = JSON.parse(read(new URL("./knowledge.json", import.meta.url)));
      if (!Array.isArray(parsed)) {
        log.warn("knowledge", "справка недоступна: корень knowledge.json не массив");
        cached = null;
        return cached;
      }
      const entries: KnowledgeItem[] = [];
      parsed.forEach((item, index) => {
        const record = item as Partial<KnowledgeItem> | null;
        const valid =
          typeof record === "object" &&
          record !== null &&
          typeof record.title === "string" &&
          record.title.trim() !== "" &&
          typeof record.text === "string" &&
          record.text.trim() !== "";
        if (valid) {
          // Запись сохраняется как есть — вместе с лишними полями: UI-контракт
          // (id/chip) добавляется поверх контента, а не вместо него.
          entries.push(record as KnowledgeItem);
        } else {
          log.warn("knowledge", `запись ${index} отброшена: нет непустых строк title/text`);
        }
      });
      cached = entries;
      return cached;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("knowledge", `справка недоступна: ${reason}`);
      cached = null;
      return cached;
    }
  }

  return { load };
}

// Дефолтная сборка: единый инстанс для brain, промта и UI-обработчиков —
// одно чтение файла и один warn на жизнь инстанса функции.
export const knowledge: KnowledgeStore = createKnowledge();
