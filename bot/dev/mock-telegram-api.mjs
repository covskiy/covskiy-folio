/**
 * Локальный мок Telegram Bot API для офлайн-смоука вебхука. Подменяет
 * api.telegram.org через env TELEGRAM_API_ROOT в bot/telegram-api.ts — смоук
 * идёт без сети: ни токена бота, ни обращений наружу (РКН/приватность/цена).
 *
 * Запуск: node bot/dev/mock-telegram-api.mjs [порт=8091]
 *
 * Поведение: POST /bot<токен>/<метод> отвечает {ok:true, result} в форме Bot
 * API (sendMessage/editMessageText отдают фейковое сообщение, служебные
 * методы — true); неизвестный метод — ok:false. Журнал вызовов отдаётся тесту
 * через GET /__log — так фиксируется ПОРЯДОК sendChatAction → sendMessage без
 * парсинга stdout. Сырой URL (в нём путь с токеном) не логируется никогда —
 * только имя метода.
 *
 * Управляемое падение (путь «повтор после ошибки доходит до LLM»):
 * POST /__control {"failMethod":"sendMessage","once":true} — следующий вызов
 * метода ответит ok:false, затем сброс; {"clear":true} — снять принудительно.
 *
 * Не деплоится: живёт в bot/dev/, вне api/.
 *
 * @module
 */

import { createServer } from "node:http";
import process from "node:process";

const PORT = Number(process.argv[2]) || 8091;

// Журнал исходящих вызовов: доказательство порядка и состава для смоука.
const calls = [];

// Текущее управляемое падение (см. /__control).
let failMethod = null;
let failOnce = false;

// message_id у мока сквозной, чтобы editMessageText ссылался на живое сообщение.
let messageSeq = 100;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function telegramResult(method, body) {
  if (method === "sendMessage" || method === "editMessageText") {
    return {
      message_id: ++messageSeq,
      date: Math.floor(Date.now() / 1000),
      chat: { id: body.chat_id, type: "private", first_name: "Владелец" },
      text: body.text ?? "",
    };
  }
  // sendChatAction, answerCallbackQuery, setWebhook, getWebhookInfo, прочие.
  return true;
}

const server = createServer(async (req, res) => {
  const json = (status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (req.method === "GET" && req.url === "/__log") {
    return json(200, calls);
  }
  if (req.method === "POST" && req.url === "/__control") {
    const body = await readBody(req);
    if (body.clear) {
      failMethod = null;
      failOnce = false;
      return json(200, { ok: true, failMethod, failOnce });
    }
    failMethod = typeof body.failMethod === "string" ? body.failMethod : null;
    failOnce = body.once === true;
    return json(200, { ok: true, failMethod, failOnce });
  }

  const match = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(req.url ?? "");
  if (req.method !== "POST" || !match) {
    return json(404, { ok: false, description: "mock: неизвестный путь" });
  }

  const method = match[1];
  const body = await readBody(req);
  const event = {
    ts: new Date().toISOString(),
    method,
    chat_id: body.chat_id ?? null,
    text: typeof body.text === "string" ? body.text.slice(0, 100) : undefined,
    markup: body.reply_markup !== undefined,
  };
  calls.push(event);
  console.warn(`[mock-telegram] ${JSON.stringify(event)}`);

  if (method === failMethod) {
    if (failOnce) failMethod = null;
    return json(200, { ok: false, description: `mock: управляемое падение ${method}` });
  }
  return json(200, { ok: true, result: telegramResult(method, body) });
});

server.listen(PORT, "127.0.0.1", () => {
  console.warn(`[mock-telegram] слушаю http://127.0.0.1:${PORT}`);
});
