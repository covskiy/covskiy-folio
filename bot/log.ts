import process from "node:process";

/**
 * Единая точка логирования серверной части. Зачем не голый console.*: уровень
 * через env LOG_LEVEL (по умолчанию warn — в лог дашборда попадают только
 * деградации и ошибки, per-update трейсы спрятаны в debug), троттлинг
 * повторяющихся предупреждений и единый формат «[модуль] сообщение», на который
 * завязаны таблицы диагностики в docs/manual.md и runbook.
 *
 * Vercel Observability маппит console.debug/info/warn/error на severity —
 * фильтрация по уровню в дашборде работает без нашего участия. Метод консоли
 * выбирается на каждый вызов, не кэшируется: тесты spying console.* видят
 * вызовы через логгер.
 */

type Level = "debug" | "info" | "warn" | "error";

// Порядок важности: строки ниже порога в лог не попадают.
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function threshold(): Level {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return raw && raw in LEVEL_ORDER ? (raw as Level) : "warn";
}

function enabled(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold()];
}

function emit(module: string, level: Level, message: string): void {
  const line = `[${module}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "info") console.info(line);
  else console.debug(line);
}

// Повторяющиеся предупреждения (каждый вопрос в stateless-режиме, сканеры на
// админ-маршруте) гасим: одинаковый ключ не чаще intervalMs на жизнь инстанса.
const lastSeenAt = new Map<string, number>();

export const log = {
  debug(module: string, message: string): void {
    if (enabled("debug")) emit(module, "debug", message);
  },
  info(module: string, message: string): void {
    if (enabled("info")) emit(module, "info", message);
  },
  warn(module: string, message: string): void {
    if (enabled("warn")) emit(module, "warn", message);
  },
  error(module: string, message: string): void {
    if (enabled("error")) emit(module, "error", message);
  },
  /**
   * Предупреждение с троттлингом: одинаковый key логируется не чаще intervalMs
   * на инстанс. Сообщения с одним key могут различаться — печатается первое
   * в интервале (точный статус деградации всегда есть в health-роуте).
   */
  warnThrottled(module: string, key: string, message: string, intervalMs = 60_000): void {
    if (!enabled("warn")) return;
    const stampKey = `${module}:${key}`;
    const now = Date.now();
    if (now - (lastSeenAt.get(stampKey) ?? 0) < intervalMs) return;
    lastSeenAt.set(stampKey, now);
    emit(module, "warn", message);
  },
};
