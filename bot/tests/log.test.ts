import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, log } from "../log";

// Время — мутируемое замыкание, инжектируется через deps: fake timers не нужны,
// «часы» прокручиваются вызовом advance между обращениями к warnThrottled.
// Старт не с нуля: первый вызов сравнивается с «маркера не было» (0 в Map) —
// при now = 0 он был бы ошибочно погашен порогом.
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("log: порог из LOG_LEVEL (инъекция env/out)", () => {
  it("дефолт warn: debug/info скрыты, warn/error пишутся с префиксом модуля", () => {
    const out = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createLogger({ env: {}, out });

    logger.debug("t", "d");
    logger.info("t", "i");
    logger.warn("t", "w");
    logger.error("t", "e");

    expect(out.debug).not.toHaveBeenCalled();
    expect(out.info).not.toHaveBeenCalled();
    expect(out.warn).toHaveBeenCalledWith("[t] w");
    expect(out.error).toHaveBeenCalledWith("[t] e");
  });

  it("LOG_LEVEL=debug открывает трейсы", () => {
    const out = { debug: vi.fn() };
    const logger = createLogger({ env: { LOG_LEVEL: "debug" }, out });

    logger.debug("t", "видно");

    expect(out.debug).toHaveBeenCalledWith("[t] видно");
  });

  it("мусор в LOG_LEVEL откатывается к дефолту warn", () => {
    const out = { debug: vi.fn() };
    const logger = createLogger({ env: { LOG_LEVEL: "не-уровень" }, out });

    logger.debug("t", "скрыто");

    expect(out.debug).not.toHaveBeenCalled();
  });
});

describe("log: warnThrottled (инъекция now/out)", () => {
  it("повтор внутри интервала гасится, другой ключ — нет", () => {
    const clock = makeClock();
    const warn = vi.fn();
    const logger = createLogger({ now: clock.now, out: { warn } });

    logger.warnThrottled("tt", "k1", "первый", 60_000);
    logger.warnThrottled("tt", "k1", "повтор", 60_000);
    logger.warnThrottled("tt", "k2", "другой ключ", 60_000);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "[tt] первый");
    expect(warn).toHaveBeenNthCalledWith(2, "[tt] другой ключ");
  });

  it("после интервала ключ логируется снова", () => {
    const clock = makeClock();
    const warn = vi.fn();
    const logger = createLogger({ now: clock.now, out: { warn } });

    logger.warnThrottled("tt", "k", "раз", 60_000);
    clock.advance(60_001);
    logger.warnThrottled("tt", "k", "два", 60_000);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(2, "[tt] два");
  });

  it("два инстанса не гасят друг друга: lastSeenAt у каждого свой", () => {
    const clock = makeClock();
    const warnA = vi.fn();
    const warnB = vi.fn();
    const loggerA = createLogger({ now: clock.now, out: { warn: warnA } });
    const loggerB = createLogger({ now: clock.now, out: { warn: warnB } });

    // Один и тот же module/key — на модульном состоянии второй был бы погашен.
    loggerA.warnThrottled("tt", "k", "из A", 60_000);
    loggerB.warnThrottled("tt", "k", "из B", 60_000);

    expect(warnA).toHaveBeenCalledTimes(1);
    expect(warnB).toHaveBeenCalledTimes(1);
  });
});

describe("log: дефолтный log (обратная совместимость)", () => {
  it("env-подмена через vi.stubEnv продолжает работать: LOG_LEVEL=debug открывает трейсы", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    log.debug("t", "видно");

    expect(debugSpy).toHaveBeenCalledWith("[t] видно");
  });

  it("без LOG_LEVEL — дефолт warn, debug скрыт", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    log.debug("t", "скрыто");

    expect(debugSpy).not.toHaveBeenCalled();
  });
});
