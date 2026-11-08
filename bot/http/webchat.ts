import { answer, type Brain } from "../brain/brain.js";
import { HELP_TEXT_WEBCHAT } from "../brain/help.js";
import { uiTopics, knowledge as rootKnowledge, type KnowledgeStore } from "../brain/knowledge.js";
import { hitRateLimit } from "../rate-limit.js";
import { appendHistory, getHistory, webKey, type Store } from "../store.js";

// sessionId — данные клиента и часть ключа Redis, поэтому жёсткий белый список:
// только [A-Za-z0-9_-], длина 8–64 (uuid и crypto-строки проходят). Всё, что не
// прошло паттерн, до ключа не доходит.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Лимит текста вопроса: совпадает с maxlength инпута виджета
// (src/chat/chat-widget.ts) — длиннее клиент всё равно не отправит.
const MAX_TEXT_LENGTH = 2_000;

// Origin-проверка — стена против drive-by из чужих страниц: браузер сам ставит
// Origin на каждый POST и JS не может его подделать (forbidden header name),
// поэтому чужой Origin = запрос со сторонней страницы. curl Origin не ставит
// вовсе — его ловит rate-limit, поэтому отсутствие заголовка пропускаем.
// Разрешённый origin выводится из request.url: совпадает и на прод-домене,
// и на preview-деплоях, и в локальных dev-режимах — vite-прокси должен
// сохранять клиентский Host (в vite.config.ts задано changeOrigin: false:
// шорткат-форма прокси молча форсирует changeOrigin: true и переписывает
// Host на таргет, что ломало все браузерные POST локально), vercel dev
// раздаёт сайт и /api с одного origin.
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
 * Зависимости обработчика вебчата — точки инъекции для тестов; дефолтная
 * сборка handleWebChat берёт дефолтные инстансы store/brain/rate-limit.
 */
export interface WebChatHandlerDeps {
  /** Слайс хранилища: достать и дописать историю диалога. */
  store: Pick<Store, "getHistory" | "appendHistory">;
  /** «Мозг»: ответ на вопрос с учётом истории. */
  brain: Pick<Brain, "answer">;
  /** Лимитер по бакету `web:{ip}`; true — запрос в пределах лимита. */
  limit: (bucket: string) => Promise<boolean>;
  /** Источник справки для чипсов GET-ветки; null — недоступна (→ пустой список). */
  knowledge: Pick<KnowledgeStore, "load">;
}

/**
 * Фабрика обработчика /api/chat: тело и приватные помощники (sameOrigin,
 * clientIp) живут в замыкании над deps — тесты подставляют фейки вместо
 * store/brain/лимитера, не трогая сеть.
 * @param {WebChatHandlerDeps} deps - Инъекции store/brain/limit.
 * @returns Обработчик handleWebChat(request).
 */
export function createWebChatHandler(deps: WebChatHandlerDeps) {
  const { store, brain, limit, knowledge } = deps;

  /**
   * Обработчик /api/chat — бэкенд вебчата. GET отдаёт статус, чипсы-подсказки
   * (uiTopics: помеченные chip: true записи, максимум 3; недоступная справка —
   * пустой список: чипсы декорация, виджет переживает их отсутствие) и текст
   * помощи — статическую константу из brain/help.ts, не зависящую от справки:
   * она отдаётся всегда, кнопка «?» обязана работать и в offline-режиме.
   * POST {sessionId, text} — ответ «мозга» с серверной историей диалога
   * (достать → спросить → дописать пару вопрос/ответ).
   *
   * Стены против злоупотреблений, до парсинга тела: same-origin (чужая страница
   * не может гонять запросы из браузеров посетителей) → rate-limit по IP
   * (см. bot/rate-limit.ts). Дальше валидация: sessionId —
   * [A-Za-z0-9_-]{8,64}, text — непустой до 2000 символов; нарушение, битый JSON
   * или чужой метод — JSON с ok:false (400/405).
   * Fail-open по store: без Redis ответ всё равно уходит, просто без контекста.
   *
   * @param {Request} request - Входящий запрос функции.
   * @returns {Promise<Response>} GET → {ok, service, chips, help};
   *   POST → {ok, text, mode, suggestions?} — подсказки (только {title}, id
   *   клиенту не нужен) прилагает brain только к dumb-fallback: у llm-ответа,
   *   уверенного dumb-ответа и UNAVAILABLE_ANSWER поля в JSON нет.
   */
  async function handleWebChat(request: Request): Promise<Response> {
    if (request.method === "GET") {
      // Чипсы — те же uiTopics, что кнопки /start: один состав на оба канала.
      // Форма {title}: клик по чипу отправляет title как готовый вопрос текстом —
      // заголовки справки сформулированы как темы-вопросы, отдельное поле q
      // ничего бы не добавило, кроме сущности. Чипсы — декорация: недоступная
      // справка или пометки chip дают пустой список, а не 500 (причина — в логе
      // хранилища справки).
      const chips = uiTopics(knowledge).map((item) => ({ title: item.title }));
      return Response.json({ ok: true, service: "webchat", chips, help: HELP_TEXT_WEBCHAT });
    }
    if (request.method !== "POST") {
      return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
    }

    // Стены идут до парсинга тела: чужой Origin и шторм отсекаются без траты CPU
    // на JSON.parse (тело могло быть на 4.5 МБ мусора) и без Redis/LLM.
    if (!sameOrigin(request)) {
      return Response.json({ ok: false, error: "Запрос с чужого источника" }, { status: 403 });
    }
    if (!(await limit(`web:${clientIp(request)}`))) {
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
    //
    // Асимметрия каналов сознательна: здесь запись ДО возврата ответа — после
    // return в serverless ничего не выполнить, а waitUntil (новая зависимость)
    // сознательно не заводим. У вебчата нет автоматического повтора доставки,
    // поэтому «фантомная пара» при упавшей отправке менее вредна, чем в
    // Telegram, где порядок обратный — отправить → записать (см.
    // bot/http/telegram-webhook.ts).
    const key = webKey(sessionId);
    const history = await store.getHistory(key);
    const { text: reply, mode, suggestions } = await brain.answer(question, history);
    await store.appendHistory(key, [
      { role: "user", content: question },
      { role: "assistant", content: reply },
    ]);

    // Подсказки — UI-слой поверх текста: клиенту хватает {title} (id нужен
    // только Telegram для callback_data), в историю диалога они не идут. Поле
    // отсутствует целиком, когда brain их не вернул — старые клиенты,
    // игнорирующие незнакомые поля, не ломаются.
    const body: {
      ok: true;
      text: string;
      mode: "llm" | "dumb";
      suggestions?: Array<{ title: string }>;
    } = { ok: true, text: reply, mode };
    if (suggestions && suggestions.length > 0) {
      body.suggestions = suggestions.map(({ title }) => ({ title }));
    }

    return Response.json(body);
  }

  return handleWebChat;
}

// Дефолтная сборка из поимённых экспортов модулей: api/bot.ts импортирует
// handler напрямую, тесты приходят со своими фейками через createWebChatHandler.
export const handleWebChat = createWebChatHandler({
  store: { getHistory, appendHistory },
  brain: { answer },
  limit: hitRateLimit,
  knowledge: rootKnowledge,
});
