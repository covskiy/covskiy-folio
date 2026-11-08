// Нативный ESM (package.json: "type": "module") требует расширения в
// относительных импортах — Vercel запускает функцию голым Node-лоадером.
import { handleWebChat } from "../bot/http/webchat.js";
import { handleTelegramWebhook } from "../bot/http/telegram-webhook.js";
import { handleTelegramAdmin } from "../bot/http/telegram-admin.js";
import { log } from "../bot/log.js";

// Единственная Vercel Function проекта: маршрутизация по пути запроса.
// /api/chat и /api/telegram попадают сюда через rewrites из vercel.json,
// а общий код живёт в bot/ (вне api/ — так Vercel собирает одну функцию).
/**
 * Fetch-обработчик единственной Vercel Function: маршрутизация по pathname.
 *
 * Верхний try/catch — последняя линия обороны HTTP-контракта {ok, error}:
 * непредвиденный бросок любого обработчика превращается в JSON 500, а не в
 * платформенную ошибку без тела (вебчат тогда не может отличить «API ответил
 * ошибкой» от «ответа вообще нет»). Причина уходит в лог с контекстом пути;
 * тело ответа деталей не раскрывает. Для /api/telegram 500 сознателен:
 * апдейт не был обработан, и повторная доставка от Telegram — штатный путь
 * дедупликации.
 *
 * @param {Request} request - Входящий запрос.
 * @returns {Promise<Response>} Ответ соответствующего обработчика из bot/:
 *   /api/chat → webchat, /api/telegram → telegram-webhook,
 *   /api/telegram-setup → telegram-admin; неизвестный путь —
 *   404 JSON {ok:false, error:"Not Found"}; непредвиденный бросок
 *   обработчика — 500 JSON {ok:false, error:"Internal Error"}.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      // await обязателен в КАЖДОЙ ветке: return промиса без await уходит мимо
      // catch — реджекция не попадает в этот try (ловится только тестом).
      switch (pathname) {
        case "/api/chat":
          return await handleWebChat(request);
        case "/api/telegram":
          return await handleTelegramWebhook(request);
        case "/api/telegram-setup":
          return await handleTelegramAdmin(request);
        default:
          return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("router", `${request.method} ${pathname}: ${reason}`);
      return Response.json({ ok: false, error: "Internal Error" }, { status: 500 });
    }
  },
};
