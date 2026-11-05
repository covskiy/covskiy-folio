import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";

// Уникальные module/key на тест: lastSeenAt троттлинга живёт на модуль —
// без этого гашение из одного теста потревожило бы соседний.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("log: порог из LOG_LEVEL", () => {
  it("дефолт warn: debug/info скрыты, warn/error пишутся с префиксом модуля", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    log.debug("t1", "d");
    log.info("t1", "i");
    log.warn("t1", "w");
    log.error("t1", "e");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[t1] w");
    expect(errorSpy).toHaveBeenCalledWith("[t1] e");
  });

  it("LOG_LEVEL=debug открывает трейсы", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    log.debug("t2", "видно");
    expect(debugSpy).toHaveBeenCalledWith("[t2] видно");
  });

  it("мусор в LOG_LEVEL откатывается к дефолту warn", () => {
    vi.stubEnv("LOG_LEVEL", "не-уровень");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    log.debug("t3", "скрыто");
    expect(debugSpy).not.toHaveBeenCalled();
  });
});

describe("log: warnThrottled", () => {
  it("повтор внутри интервала гасится, другой ключ — нет", () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warnThrottled("tt1", "k1", "первый", 60_000);
    log.warnThrottled("tt1", "k1", "повтор", 60_000);
    log.warnThrottled("tt1", "k2", "другой ключ", 60_000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, "[tt1] первый");
    expect(warnSpy).toHaveBeenNthCalledWith(2, "[tt1] другой ключ");
    vi.useRealTimers();
  });

  it("после интервала ключ логируется снова", () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warnThrottled("tt2", "k", "раз", 60_000);
    vi.advanceTimersByTime(60_001);
    log.warnThrottled("tt2", "k", "два", 60_000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(2, "[tt2] два");
    vi.useRealTimers();
  });
});
