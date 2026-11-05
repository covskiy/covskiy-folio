// Нативный ESM (package.json: "type": "module") требует расширения в
// относительных импортах — Vercel запускает функцию голым Node-лоадером.
import { handleWebChat } from "../bot/http/webchat.js";
import { handleTelegramWebhook } from "../bot/http/telegram-webhook.js";
import { handleTelegramAdmin } from "../bot/http/telegram-admin.js";

// Единственная Vercel Function проекта: маршрутизация по пути запроса.
// /api/chat и /api/telegram попадают сюда через rewrites из vercel.json,
// а общий код живёт в lib/ (вне api/ — так Vercel собирает одну функцию).
/**
 * Fetch-обработчик единственной Vercel Function: маршрутизация по pathname.
 *
 * @param {Request} request - Входящий запрос.
 * @returns {Promise<Response>} Ответ соответствующего обработчика из lib/:
 *   /api/chat → webchat, /api/telegram → telegram-webhook,
 *   /api/telegram-setup → telegram-admin; неизвестный путь —
 *   404 JSON {ok:false, error:"Not Found"}.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/api/chat":
        return handleWebChat(request);
      case "/api/telegram":
        return handleTelegramWebhook(request);
      case "/api/telegram-setup":
        return handleTelegramAdmin(request);
      default:
        return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
    }
  },
};
