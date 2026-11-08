import { readFileSync } from "node:fs";
import { log as rootLog, type Logger } from "../log.js";

/**
 * Одна запись справки — элемент контента бота из bot/brain/knowledge.json.
 * Контент правится руками (см. docs/manual.md → §5.1), поэтому контракт полей
 * явный: позиция в массиве управляет только порядком секций промта, а роли
 * для UI — флагами chip/about, не положением и не точным заголовком.
 */
export interface KnowledgeItem {
  /** Стабильный ссылочный slug: callback_data кнопок = `ask:{id}`. Уникален;
   *  переименование = старые кнопки получают «кнопка устарела» — видимая операция. */
  id: string;
  /** Заголовок-тема: вставляется в промт и служит текстом чипа/кнопки-подсказки. */
  title: string;
  /** Текст ответа: вставляется в промт и отдаётся в dumb-режиме как есть. */
  text: string;
  /** Пометка UI-темы: запись попадает в чипсы вебчата и кнопки /start (uiTopics). */
  chip?: true;
  /** Пометка «текст о владельце»: запись отвечает на /about. */
  about?: true;
}

// Slug id: строчная латиница/цифры/дефис, начинается с буквы. Начало с буквы
// гарантирует, что legacy-кнопки с индексом (ask:0..2, только цифры) не
// совпадут с новым id и уйдут в ветку «кнопка устарела». Длина ≤ 48 — запас
// под лимит Telegram 64 байта на callback_data (префикс «ask:» + slug).
// Валидация и разбор callback_data обязаны пользоваться одним источником
// формата: тело без якорей экспортируется отдельно — якоря каждый регекс
// ставит свои (вставка якорёванного source внутрь другого якорёванного
// паттерна делает совпадение невозможным: ^ask:(^...$)$).
export const ID_PATTERN_SOURCE = "[a-z][a-z0-9-]{0,47}";
export const ID_PATTERN = new RegExp(`^${ID_PATTERN_SOURCE}$`);

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
      // id уникален: две записи с одним id = кнопка ведёт «не туда» молча,
      // поэтому дубль отбрасывается (первая в файле выигрывает).
      const seenIds = new Set<string>();
      parsed.forEach((item, index) => {
        const record = item as Partial<KnowledgeItem> | null;
        if (
          typeof record !== "object" ||
          record === null ||
          typeof record.title !== "string" ||
          record.title.trim() === "" ||
          typeof record.text !== "string" ||
          record.text.trim() === ""
        ) {
          log.warn("knowledge", `запись ${index} отброшена: нет непустых строк title/text`);
          return;
        }
        const id = typeof record.id === "string" ? record.id : "";
        if (!ID_PATTERN.test(id)) {
          log.warn(
            "knowledge",
            `запись ${index} отброшена: id отсутствует или не slug (строчные латинские/дефис, с буквы, до 48)`,
          );
          return;
        }
        if (seenIds.has(id)) {
          log.warn("knowledge", `запись ${index} отброшена: дубликат id «${id}»`);
          return;
        }
        seenIds.add(id);
        // Пометка не-булевым true — правка руками мимо контракта («chip»: «true»):
        // запись живёт, но в UI не попадает — владелец должен увидеть это в логе.
        if (record.chip !== undefined && record.chip !== true) {
          log.warn(
            "knowledge",
            `запись ${index} (id «${id}»): chip не true — пометка игнорируется`,
          );
        }
        if (record.about !== undefined && record.about !== true) {
          log.warn(
            "knowledge",
            `запись ${index} (id «${id}»): about не true — пометка игнорируется`,
          );
        }
        // Запись сохраняется как есть — вместе с пометками и лишними полями:
        // UI-контракт лежит поверх контента, а не вместо него.
        entries.push(record as KnowledgeItem);
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

// Единый источник UI-подсказок: число И состав задаются здесь, оба канала
// (чипсы вебчата и кнопки /start) обязаны показывать одно и то же. Состав —
// помеченные chip: true в порядке файла; позиция записи в массиве управляет
// только порядком секций промта, а не интерфейсом. uiTopics доверяет load():
// валидация уже отбросила записи без валидного id, так что chip-пометка
// без кнопки-носителя невозможна.
export const UI_TOPICS_COUNT = 3;

/**
 * Темы для чипсов вебчата и кнопок /start: помеченные chip: true записи
 * (первые limit штук в порядке файла). Справка недоступна → пустой список —
 * UI-ветки деградируют без подсказок, а не ошибкой (см. обработчики).
 * @param {Pick<KnowledgeStore, "load">} store - Хранилище справки (дефолтное или инъекция).
 * @param {number} [limit=UI_TOPICS_COUNT] - Максимум тем (по умолчанию 3 —
 *   UI_TOPICS_COUNT, одно число на оба канала).
 * @returns {KnowledgeItem[]} Темы в порядке файла.
 */
export function uiTopics(
  store: Pick<KnowledgeStore, "load">,
  limit: number = UI_TOPICS_COUNT,
): KnowledgeItem[] {
  return (store.load() ?? []).filter((item) => item.chip === true).slice(0, limit);
}
