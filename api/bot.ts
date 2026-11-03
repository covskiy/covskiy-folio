// Нативный ESM (package.json: "type": "module") требует расширения в
// относительных импортах — Vercel запускает функцию голым Node-лоадером.
import { handleWebChat } from "../lib/webchat.js";
import { handleTelegramWebhook } from "../lib/telegram-webhook.js";

// Единственная Vercel Function проекта: маршрутизация по пути запроса.
// /api/chat и /api/telegram попадают сюда через rewrites из vercel.json,
// а общий код живёт в lib/ (вне api/ — так Vercel собирает одну функцию).
export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/api/chat":
        return handleWebChat(request);
      case "/api/telegram":
        return handleTelegramWebhook(request);
      default:
        return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
    }
  },
};
