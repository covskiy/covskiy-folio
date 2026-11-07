import { config } from "./config.js";
import { log } from "./log.js";
import { incrCounter } from "./store.js";

// Rate-limit «мозга» против выжигания квот (Ollama free / Upstash free / Vercel
// Hobby): каждый вопрос — расход LLM-токенов и Redis-команд, без лимита цикл
// curl сжигает недельную квоту за часы. Фиксированное окно в Redis: дёшево
// (один pipeline на запрос) и без состояния в функции (serverless).
// Парсинг и дефолты порогов (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_SECONDS) живут
// в config.ts — здесь готовый типизированный слайс config.rateLimit.

/**
 * Отметить запрос в бакете и сказать, пропускать ли его.
 * Fail-open по store (та же философия, что у истории): Redis недоступен —
 * пропускаем, бот обязан отвечать и без лимитера.
 * @param {string} bucket - Идентификатор бакета: `web:{ip}` для вебчата,
 *   `tg:{chatId}` для Telegram (префикс `rate:` добавляется здесь).
 * @returns {Promise<boolean>} true — запрос в пределах лимита (или Redis недоступен).
 */
export async function hitRateLimit(bucket: string): Promise<boolean> {
  // Один доступ к геттеру на вызов: env перечитывается на каждый слайс,
  // а окно и порог внутри одного вызова должны быть из одного «снимка».
  const { max, windowSeconds } = config.rateLimit;
  const key = `rate:${bucket}`;
  const counter = await incrCounter(key, windowSeconds);
  if (counter !== null && counter > max) {
    // IP/chatId в логе — не секрет (секреты только token/key), владельцу он
    // нужен, чтобы видеть источник шторма. Троттлинг — по бакету, не по тексту.
    log.warnThrottled("rate-limit", key, `лимит исчерпан: ${bucket}`);
    return false;
  }
  return true;
}
