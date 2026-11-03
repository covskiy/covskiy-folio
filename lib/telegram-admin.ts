import process from "node:process";
import { getWebhookInfo, setWebhook } from "./telegram-api.js";

// Админ-маршрут: регистрация и диагностика Telegram-вебхука.
// Защищён тем же секретом, что и вебхук; без секрета отвечаем 404,
// чтобы не подтверждать существование маршрута.
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export async function handleTelegramAdmin(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    // Печатаем только факт поломки конфигурации, не значение секрета.
    console.error("[telegram-admin] TELEGRAM_WEBHOOK_SECRET не задан в env");
    return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
  }
  if (request.headers.get(SECRET_HEADER) !== secret) {
    console.warn(`[telegram-admin] отклонён запрос с неверным секретом (${request.method})`);
    return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
  }

  try {
    if (request.method === "GET") {
      const webhook = await getWebhookInfo();
      console.log("[telegram-admin] getWebhookInfo:", JSON.stringify(webhook));
      return Response.json({ ok: true, webhook });
    }
    if (request.method === "POST") {
      const origin = new URL(request.url).origin;
      const url = `${origin}/api/telegram`;
      const result = await setWebhook({
        url,
        secret_token: secret,
        allowed_updates: ["message"],
      });
      console.log(`[telegram-admin] вебхук установлен: ${url}`);
      return Response.json({ ok: true, result });
    }
    return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
  } catch (error) {
    // Ошибку Telegram API отдаём как есть — это диагностика для владельца.
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[telegram-admin] ошибка Telegram API:", reason);
    return Response.json({ ok: false, error: reason }, { status: 502 });
  }
}
