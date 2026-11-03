import process from "node:process";
import { getWebhookInfo, setWebhook } from "./telegram-api.js";

// Админ-маршрут: регистрация и диагностика Telegram-вебхука.
// Защищён тем же секретом, что и вебхук; без секрета отвечаем 404,
// чтобы не подтверждать существование маршрута.
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export async function handleTelegramAdmin(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get(SECRET_HEADER) !== secret) {
    return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
  }

  try {
    if (request.method === "GET") {
      return Response.json({ ok: true, webhook: await getWebhookInfo() });
    }
    if (request.method === "POST") {
      const origin = new URL(request.url).origin;
      const result = await setWebhook({
        url: `${origin}/api/telegram`,
        secret_token: secret,
        allowed_updates: ["message"],
      });
      return Response.json({ ok: true, result });
    }
    return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
  } catch (error) {
    // Ошибку Telegram API отдаём как есть — это диагностика для владельца.
    const reason = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: reason }, { status: 502 });
  }
}
