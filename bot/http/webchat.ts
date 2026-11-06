import { answer } from "../brain/brain.js";
import { knowledgeEntries } from "../brain/prompt.js";
import { hitRateLimit } from "../rate-limit.js";
import { appendHistory, getHistory, webKey } from "../store.js";

// sessionId — данные клиента и часть ключа Redis, поэтому жёсткий белый список:
// только [A-Za-z0-9_-], длина 8–64 (uuid и crypto-строки проходят). Всё, что не
// прошло паттерн, до ключа не доходит.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Лимит текста вопроса: совпадает с maxlength инпута виджета
// (src/chat/chat-widget.ts) — длиннее клиент всё равно не отправит.
const MAX_TEXT_LENGTH = 2_000;

// План: «чипсы сайта — первые 3 элемента JSON». Форма {title}: клик по чипу
// отправляет title как готовый вопрос текстом — заголовки справки сформулированы
// как темы-вопросы, отдельное поле q ничего бы не добавило, кроме сущности.
const CHIPS_COUNT = 3;

// Origin-проверка — стена против drive-by из чужих страниц: браузер сам ставит
// Origin на каждый POST и JS не может его подделать (forbidden header name),
// поэтому чужой Origin = запрос со сторонней страницы. curl Origin не ставит
// вовсе — его ловит rate-limit, поэтому отсутствие заголовка пропускаем.
// Разрешённый origin выводится из request.url: совпадает и на прод-домене,
// и на preview-деплоях, и в локальных dev-режимах (vite-прокси не переписывает
// Host, vercel dev раздаёт сайт и /api с одного origin).
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

// IP для лимитера: x-real-ip выставляет прокси Vercel и клиент подделать его
// не может; x-forwarded-for может нести клиентскую цепочку — только запасным.
// На Vercel оба всегда есть; «unknown» — бакет для экзотики без заголовков,
// такие клиенты делят одно окно (безопасно, просто теснее).
function clientIp(request: Request): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Обработчик /api/chat — бэкенд вебчата. GET отдаёт статус и чипсы-подсказки
 * (первые 3 элемента справки); POST {sessionId, text} — ответ «мозга» с
 * серверной историей диалога (достать → спросить → дописать пару вопрос/ответ).
 *
 * Стены против злоупотреблений, до парсинга тела: same-origin (чужая страница
 * не может гонять запросы из браузеров посетителей) → rate-limit по IP
 * (см. bot/rate-limit.ts). Дальше валидация: sessionId —
 * [A-Za-z0-9_-]{8,64}, text — непустой до 2000 символов; нарушение, битый JSON
 * или чужой метод — JSON с ok:false (400/405).
 * Fail-open по store: без Redis ответ всё равно уходит, просто без контекста.
 *
 * @param {Request} request - Входящий запрос функции.
 * @returns {Promise<Response>} GET → {ok, service, chips}; POST → {ok, text, mode}.
 */
export async function handleWebChat(request: Request): Promise<Response> {
  if (request.method === "GET") {
    const chips = knowledgeEntries()
      .slice(0, CHIPS_COUNT)
      .map((item) => ({ title: item.title }));
    return Response.json({ ok: true, service: "webchat", chips });
  }
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
  }

  // Стены идут до парсинга тела: чужой Origin и шторм отсекаются без траты CPU
  // на JSON.parse (тело могло быть на 4.5 МБ мусора) и без Redis/LLM.
  if (!sameOrigin(request)) {
    return Response.json({ ok: false, error: "Запрос с чужого источника" }, { status: 403 });
  }
  if (!(await hitRateLimit(`web:${clientIp(request)}`))) {
    return Response.json(
      { ok: false, error: "Слишком много запросов — попробуй позже" },
      { status: 429 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { sessionId, text } = (payload ?? {}) as { sessionId?: unknown; text?: unknown };

  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return Response.json({ ok: false, error: "Некорректный sessionId" }, { status: 400 });
  }

  const question = typeof text === "string" ? text.trim() : "";
  if (!question || question.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { ok: false, error: `Нужен непустой text до ${MAX_TEXT_LENGTH} символов` },
      { status: 400 },
    );
  }

  // История диалога живёт на сервере: достали → спросили → сохранили пару
  // вопрос/ответ. Fail-open store: без Redis ответ всё равно уходит.
  const key = webKey(sessionId);
  const history = await getHistory(key);
  const { text: reply, mode } = await answer(question, history);
  await appendHistory(key, [
    { role: "user", content: question },
    { role: "assistant", content: reply },
  ]);

  return Response.json({ ok: true, text: reply, mode });
}
