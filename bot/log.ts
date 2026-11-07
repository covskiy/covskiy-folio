// config — готовый типизированный слайс logLevel; дефолтный инстанс для
// рантайма (парсинг LOG_LEVEL — в config.ts, здесь только сравнение порогов).
import { config, type AppConfig, type LogLevel } from "./config.js";

/**
 * Единая точка логирования серверной части. Зачем не голый console.*: уровень
 * через env LOG_LEVEL (по умолчанию warn — в лог дашборда попадают только
 * деградации и ошибки, per-update трейсы спрятаны в debug), троттлинг
 * повторяющихся предупреждений и единый формат «[модуль] сообщение», на который
 * завязаны таблицы диагностики в docs/manual.md и runbook.
 *
 * Состояние — инстансное, а не модульное (фабрика createLogger): троттлинг
 * живёт в Map внутри замыкания, а не на уровне модуля — инстансы не гасят
 * предупреждения друг друга, а тестам не нужны уникальные module/key на тест и
 * fake timers: время (now) и вывод (out) инжектируются через deps. Дефолтный
 * `log = createLogger()` сохраняет все существующие `import { log }` без правок.
 *
 * Vercel Observability маппит console.debug/info/warn/error на severity —
 * фильтрация по уровню в дашборде работает без нашего участия. Метод консоли
 * выбирается на каждый вызов, не кэшируется: тесты spying console.* видят
 * вызовы через дефолтный логгер. То же с уровнем — ленивый геттер
 * config.logLevel перечитывает env на каждый вызов: подмена через vi.stubEnv
 * на дефолтном log продолжает работать.
 */

// Локальное имя типа сохранено для минимального диффа; единственное
// определение уровней теперь в config.ts (там же парсинг LOG_LEVEL).
type Level = LogLevel;

// Порядок важности: строки ниже порога в лог не попадают.
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Зависимости логгера — точки инъекции для тестов; в рантайме используется
 * createLogger() без аргументов (env/now/out берутся как раньше).
 */
export interface LoggerDeps {
  /** Готовый конфиг; по умолчанию дефолтный config из config.ts (process.env). */
  config?: AppConfig;
  /** Часы для троттлинга; по умолчанию Date.now. */
  now?: () => number;
  // Partial: тесты подменяют только те методы, которые проверяют; отсутствующие
  // методы работают через console как раньше.
  /** Приёмник вывода (по умолчанию глобальный console). */
  out?: Partial<Pick<Console, "debug" | "info" | "warn" | "error">>;
}

/**
 * Фабрика логгера: lastSeenAt троттлинга — Map внутри замыкания этого инстанса.
 * @param {LoggerDeps} deps - Инъекции env/now/out; без аргументов — поведение как раньше.
 * @returns Логгер с методами debug/info/warn/error/warnThrottled.
 */
export function createLogger(deps: LoggerDeps = {}) {
  const lastSeenAt = new Map<string, number>();

  // Геттер config.logLevel ленивый (env перечитывается на доступ), поэтому
  // порог резолвим на каждый вызов: подмена через vi.stubEnv на дефолтном log
  // продолжает работать.
  function threshold(): Level {
    return (deps.config ?? config).logLevel;
  }

  function enabled(level: Level): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold()];
  }

  function emit(module: string, level: Level, message: string): void {
    const line = `[${module}] ${message}`;
    const out = deps.out;
    if (level === "error") (out?.error ?? console.error)(line);
    else if (level === "warn") (out?.warn ?? console.warn)(line);
    else if (level === "info") (out?.info ?? console.info)(line);
    else (out?.debug ?? console.debug)(line);
  }

  return {
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
     * на жизнь инстанса. Сообщения с одним key могут различаться — печатается
     * первое в интервале (точный статус деградации всегда есть в health-роуте).
     */
    warnThrottled(module: string, key: string, message: string, intervalMs = 60_000): void {
      if (!enabled("warn")) return;
      const stampKey = `${module}:${key}`;
      const now = (deps.now ?? Date.now)();
      if (now - (lastSeenAt.get(stampKey) ?? 0) < intervalMs) return;
      lastSeenAt.set(stampKey, now);
      emit(module, "warn", message);
    },
  };
}

/**
 * Тип инстанса логгера — для фабрик, принимающих log как зависимость
 * (bot/llm.ts, bot/redis-rest.ts, …): структурная подмена в тестах без контрактов-файлов.
 */
export type Logger = ReturnType<typeof createLogger>;

export const log = createLogger();
