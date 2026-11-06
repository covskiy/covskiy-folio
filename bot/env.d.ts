// Типы env-переменных сервера: декларации мержатся в NodeJS.ProcessEnv, поэтому
// IDE подсказывает имена process.env.* и JSDoc-описания при наведении. Это
// единая точка правды по списку переменных кода; профиль установки —
// .env.example, значения — env Vercel / .env.local.
//
// Почему тут, а не в src/vite-env.d.ts: env читает только серверная часть
// (bot/, api/, vite.config.ts), у клиента своих переменных нет. Почему
// export {}: без него файл — глобальный скрипт, где declare global по правилам
// TS не работает (мержить namespace можно только из модуля).
//
// Замечание: индексная сигнатура ProcessEnv остаётся (так устроен @types/node),
// поэтому опечатка в имени переменной tsc не поймает — главный барьер тут
// подсказки IDE, а не компилятор. Все значения — строки: числа парсит код
// (Number(...) || дефолт), логический тип в env не выражается.

export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      // ── LLM (bot/brain/brain.ts) ────────────────────────────────
      /** Базовый URL OpenAI-совместимого endpoint (напр. https://ollama.com/v1) */
      LLM_BASE_URL?: string;
      /** Модель (напр. gpt-oss:20b) */
      LLM_MODEL?: string;
      /** Bearer-ключ endpoint; опционален */
      LLM_API_KEY?: string;
      /** Таймаут запроса, мс (дефолт 15000) */
      LLM_TIMEOUT_MS?: string;
      /** Потолок генерации ответа, токенов (дефолт 1024) */
      LLM_MAX_TOKENS?: string;

      // ── Rate-limit (bot/rate-limit.ts) ──────────────────────────
      /** Максимум вопросов на окно на один ключ IP/chatId (дефолт 15) */
      RATE_LIMIT_MAX?: string;
      /** Длина окна, секунд (дефолт 3600) */
      RATE_LIMIT_WINDOW_SECONDS?: string;

      // ── Upstash Redis (bot/store.ts) ────────────────────────────
      /** REST-адрес базы (пара с UPSTASH_REDIS_REST_TOKEN) */
      UPSTASH_REDIS_REST_URL?: string;
      /** REST-токен базы */
      UPSTASH_REDIS_REST_TOKEN?: string;
      /** REST-адрес от интеграции Vercel Marketplace (альтернатива UPSTASH-паре) */
      KV_REST_API_URL?: string;
      /** REST-токен от интеграции Vercel Marketplace */
      KV_REST_API_TOKEN?: string;

      // ── Telegram (bot/telegram-api.ts, bot/http/*) ──────────────
      /** Токен бота от @BotFather */
      TELEGRAM_BOT_TOKEN?: string;
      /** Секрет webhook-заголовка x-telegram-bot-api-secret-token */
      TELEGRAM_WEBHOOK_SECRET?: string;

      // ── Прочее ──────────────────────────────────────────────────
      /** Уровень логирования: debug | info | warn | error (дефолт warn; bot/log.ts) */
      LOG_LEVEL?: string;
      /** Порт vite в dev (читает vite.config.ts) */
      PORT?: string;
    }
  }
}
