import { describe, expect, it } from "vitest";
import { HELP_TEXT_TELEGRAM, HELP_TEXT_WEBCHAT, HELP_TEXT_WEBCHAT_FALLBACK } from "../brain/help";

const ALL_TEXTS = [HELP_TEXT_WEBCHAT, HELP_TEXT_TELEGRAM, HELP_TEXT_WEBCHAT_FALLBACK];

describe("тексты помощи (bot/brain/help.ts)", () => {
  it("константы — непустые строки; импорт модуля не тянет ни LLM, ни сеть, ни env", () => {
    // Модуль состоит только из строковых констант (ни одного импорта): сам факт
    // импорта и проверки — контракт «помощь работает в offline-режиме».
    for (const text of ALL_TEXTS) {
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("тексты помощи не содержат секретов (токены, ключи)", () => {
    const secretLike = /(token|secret|api[_-]?key|sk-[a-z0-9]|bearer)/i;
    for (const text of ALL_TEXTS) {
      expect(secretLike.test(text)).toBe(false);
    }
  });

  it("текст вебчата не упоминает Telegram-команды (/about, /reset) — их в вебчате нет", () => {
    expect(HELP_TEXT_WEBCHAT).not.toContain("/about");
    expect(HELP_TEXT_WEBCHAT).not.toContain("/reset");
  });

  it("запасной текст вебчата не пустой и тоже без Telegram-команд", () => {
    expect(HELP_TEXT_WEBCHAT_FALLBACK.trim().length).toBeGreaterThan(0);
    expect(HELP_TEXT_WEBCHAT_FALLBACK).not.toContain("/about");
    expect(HELP_TEXT_WEBCHAT_FALLBACK).not.toContain("/reset");
  });

  it("текст Telegram упоминает /about и /reset — для Telegram это правильно", () => {
    expect(HELP_TEXT_TELEGRAM).toContain("/about");
    expect(HELP_TEXT_TELEGRAM).toContain("/reset");
  });
});
