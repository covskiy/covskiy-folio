import process from "node:process";
import { answer } from "./brain.js";
import { sendMessage, type TgMessage } from "./telegram-api.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const WELCOME_TEXT = "Привет! Я справочный бот этого сайта. Задай вопрос — попробую ответить.";

interface TgUpdate {
  message?: TgMessage;
}

export async function handleTelegramWebhook(request: Request): Promise<Response> {
  // Проверяем, что запрос пришёл действительно от Telegram (секрет задаётся в setWebhook)
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || request.headers.get(SECRET_HEADER) !== expected) {
    return Response.json({ ok: false }, { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return Response.json({ ok: true });
  }

  const message = update.message;
  if (message?.text) {
    try {
      console.log(`[telegram-webhook] апдейт от ${message.chat.id}: ${message.text.slice(0, 80)}`);
      const reply = message.text.startsWith("/start")
        ? WELCOME_TEXT
        : (await answer([{ role: "user", content: message.text }])).text;
      await sendMessage(message.chat.id, reply);
      console.log(`[telegram-webhook] ответ отправлен в ${message.chat.id}`);
    } catch (error) {
      console.error("[telegram-webhook]", error);
      try {
        await sendMessage(
          message.chat.id,
          "У меня технические неполадки — попробуй спросить позже.",
        );
      } catch {
        // Ответить не вышло — Telegram сам повторит доставку update
      }
    }
  }

  // Telegram ждёт 2xx, иначе будет повторять отправку update
  return Response.json({ ok: true });
}
