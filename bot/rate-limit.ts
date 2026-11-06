import process from "node:process";
import { log } from "./log.js";
import { incrCounter } from "./store.js";

// Rate-limit «мозга» против выжигания квот (Ollama free / Upstash free / Vercel
// Hobby): каждый вопрос — расход LLM-токенов и Redis-команд, без лимита цикл
// curl сжигает недельную квоту за часы. Фиксированное окно в Redis: дёшево
// (один pipeline на запрос) и без состояния в функции (serverless).
// Пороги — env с дефолтом в коде (паттерн LLM_TIMEOUT_MS): при атаке порог
// ужесточается из дашборда Vercel + Redeploy, без коммита.

const RATE_LIMIT_MAX_DEFAULT = 15;
const RATE_LIMIT_WINDOW_DEFAULT_SECONDS = 3_600;

// Мусор/ноль в env — снова дефолт: посетитель прод-сайта не должен остаться
// без лимитера из-за опечатки в переменной.
function limitMax(): number {
  return Number(process.env.RATE_LIMIT_MAX) || RATE_LIMIT_MAX_DEFAULT;
}

function limitWindowSeconds(): number {
  return Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || RATE_LIMIT_WINDOW_DEFAULT_SECONDS;
}

/**
 * Отметить запрос в бакете и сказать, пропускать ли его.
 * Fail-open по store (та же философия, что у истории): Redis недоступен —
 * пропускаем, бот обязан отвечать и без лимитера.
 * @param {string} bucket - Идентификатор бакета: `web:{ip}` для вебчата,
 *   `tg:{chatId}` для Telegram (префикс `rate:` добавляется здесь).
 * @returns {Promise<boolean>} true — запрос в пределах лимита (или Redis недоступен).
 */
export async function hitRateLimit(bucket: string): Promise<boolean> {
  const key = `rate:${bucket}`;
  const counter = await incrCounter(key, limitWindowSeconds());
  if (counter !== null && counter > limitMax()) {
    // IP/chatId в логе — не секрет (секреты только token/key), владельцу он
    // нужен, чтобы видеть источник шторма. Троттлинг — по бакету, не по тексту.
    log.warnThrottled("rate-limit", key, `лимит исчерпан: ${bucket}`);
    return false;
  }
  return true;
}
