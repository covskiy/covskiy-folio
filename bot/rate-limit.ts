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
    // Ключ троттлинга константный, а не бакет: уникальный IP/чат в ключе
    // разрастал бы Map троттлинга логгера навсегда (тёплый инстанс живёт долго,
    // бакетов неограниченно, а веб-бакет выводится из заголовков IP — атакующий
    // дёшево генерирует уникальные ключи). Цена: троттлинг общий на все бакеты
    // в течение интервала; источник шторма и так виден в тексте сообщения.
    log.warnThrottled("rate-limit", "exceeded", `лимит исчерпан: ${bucket}`);
    return false;
  }
  return true;
}
