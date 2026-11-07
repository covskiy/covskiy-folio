import process from "node:process";
import { createLlm } from "../llm.js";
import { log } from "../log.js";
import { systemPrompt } from "../brain/prompt.js";
import { ping as pingRedis } from "../store.js";
import { getWebhookInfo, setWebhook, type TgWebhookInfo } from "../telegram-api.js";

// Дефолтный инстанс транспорта: env резолвится внутри на каждый вызов,
// так что подмена env в тестах и Redeploy с новыми LLM_* работают как раньше.
const llm = createLlm();

// Админ-маршрут: регистрация и диагностика Telegram-вебхука, health бота,
// просмотр собранного промта (шаг 7 плана). Защищён тем же секретом, что и
// вебхук; без секрета отвечаем 404, чтобы не подтверждать существование маршрута.
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

type TelegramHealth = { ok: true; webhook: TgWebhookInfo } | { ok: false; error: string };

async function telegramHealth(): Promise<TelegramHealth> {
  try {
    return { ok: true, webhook: await getWebhookInfo() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: reason };
  }
}

// Пункты health независимы: считаем параллельно, ошибка одного (уже пойманная
// внутри ping-функций) не влияет на остальные.
async function healthResponse(): Promise<Response> {
  const [llmHealth, redis, telegram] = await Promise.all([
    llm.ping(),
    pingRedis(),
    telegramHealth(),
  ]);
  return Response.json({ ok: true, llm: llmHealth, redis, telegram });
}

/**
 * Обработчик /api/telegram-setup — админ-маршрут владельца:
 * GET без section — диагностика вебхука (getWebhookInfo),
 * GET ?section=health — health LLM, Redis и Telegram (параллельно),
 * GET ?section=prompt — собранный system-промт,
 * POST — установка вебхука на текущий origin (setWebhook).
 *
 * Auth: секрет в заголовке x-telegram-bot-api-secret-token; без
 * TELEGRAM_WEBHOOK_SECRET или при несовпадении — 404 (не 401: маршрут
 * не подтверждает своё существование). Ошибка Telegram API — 502 с текстом.
 *
 * Env: TELEGRAM_WEBHOOK_SECRET (обязателен); для health — LLM_BASE_URL/
 * LLM_MODEL/LLM_API_KEY и UPSTASH_REDIS_REST_URL/TOKEN.
 *
 * @param {Request} request - Входящий запрос функции.
 * @returns {Promise<Response>} JSON; коды: 200, 404 (секрет отсутствует/неверен), 405, 502.
 */
export async function handleTelegramAdmin(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    // Печатаем только факт поломки конфигурации, не значение секрета.
    log.error("telegram-admin", "TELEGRAM_WEBHOOK_SECRET не задан в env");
    return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
  }
  if (request.headers.get(SECRET_HEADER) !== secret) {
    log.warnThrottled(
      "telegram-admin",
      "bad-secret",
      `отклонён запрос с неверным секретом (${request.method})`,
    );
    return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
  }

  try {
    if (request.method === "GET") {
      // Ветвление по query-параметру: маршрут исторически адресуется одним
      // путём (/api/telegram-setup), подпути через vercel.json не заводим.
      const section = new URL(request.url).searchParams.get("section");
      if (section === "health") return await healthResponse();
      if (section === "prompt") {
        // Под секретом можно целиком; справка уже внутри промта.
        return Response.json({ ok: true, prompt: systemPrompt() });
      }
      // Без section — историческое поведение: диагностика вебхука.
      const webhook = await getWebhookInfo();
      log.debug("telegram-admin", `getWebhookInfo: ${JSON.stringify(webhook)}`);
      return Response.json({ ok: true, webhook });
    }
    if (request.method === "POST") {
      const origin = new URL(request.url).origin;
      const url = `${origin}/api/telegram`;
      const result = await setWebhook({
        url,
        secret_token: secret,
        // callback_query нужен для кнопок-подсказок на /start (шаг 6 плана).
        allowed_updates: ["message", "callback_query"],
      });
      log.info("telegram-admin", `вебхук установлен: ${url}`);
      return Response.json({ ok: true, result });
    }
    return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
  } catch (error) {
    // Ошибку Telegram API отдаём как есть — это диагностика для владельца.
    const reason = error instanceof Error ? error.message : String(error);
    log.error("telegram-admin", `ошибка Telegram API: ${reason}`);
    return Response.json({ ok: false, error: reason }, { status: 502 });
  }
}
