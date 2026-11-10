// config — готовый типизированный слайс telegram (секрет trim'нутый);
// дефолтный инстанс для рантайма.
import { config } from "../config.js";
import { log as rootLog, type Logger } from "../log.js";
import { answer, type Brain } from "../brain/brain.js";
// Текст помощи — общий источник на оба канала (brain/help.ts), а не локальная
// константа: вебчат и Telegram не должны разъезжаться формулировками.
import { HELP_TEXT_TELEGRAM } from "../brain/help.js";
import {
  ID_PATTERN_SOURCE,
  uiTopics,
  knowledge as rootKnowledge,
  type KnowledgeStore,
} from "../brain/knowledge.js";
import { hitRateLimit } from "../rate-limit.js";
import {
  appendHistory,
  clearHistory,
  getHistory,
  isSeen,
  markSeen,
  tgKey,
  tgSeenKey,
  type Store,
} from "../store.js";
import {
  answerCallbackQuery,
  editMessageText,
  sendChatAction,
  sendMessage,
  type TelegramApi,
  type TgInlineKeyboardMarkup,
  type TgMessage,
} from "../telegram-api.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const WELCOME_TEXT = [
  "Привет! Я справочный бот этого сайта — отвечу на вопросы обо мне, моих услугах и контактах.",
  "Задай вопрос текстом или нажми кнопку ниже.",
].join("\n");

const RESET_DONE_TEXT = "История диалога очищена — начинаем с чистого листа.";

const UNKNOWN_COMMAND_TEXT = "Не знаю такую команду. Набери /help — покажу, что умею.";

const CALLBACK_ERROR_TEXT = "Кнопка устарела. Набери /start — дам свежие подсказки.";

// Общий fallback для message- и callback-веток: при сбое отправки ответа
// пользователь должен увидеть хотя бы это, а не тишину.
const TECHNICAL_TROUBLE_TEXT = "У меня технические неполадки — попробуй спросить позже.";

const RATE_LIMIT_TEXT =
  "Слишком много вопросов подряд — сделай небольшую паузу и попробуй снова 🙂";

// Интервал повторов индикатора «печатает…»: Telegram держит статус ~5 с,
// обновляем чаще, чтобы не мигал. Константа, не env: окно фиксировано Bot API,
// настраивать нечего.
const TYPING_REFRESH_MS = 4_500;

// TTL маркера дедупликации — env TELEGRAM_SEEN_TTL_SECONDS (дефолт 3600,
// слайс telegram в config.ts): час с запасом перекрывает ретраи Telegram
// по одному апдейту, ключи чистятся сами.

// Разбор callback_data кнопки /start: ask:{id}. Slug-часть берётся из того же
// источника формата, что валидирует записи (ID_PATTERN_SOURCE), поэтому кнопка
// без записи-источника невозможна; legacy-кнопки с индексом (ask:0, только
// цифры) паттерн не совпадает — уходят в ветку «кнопка устарела».
const CALLBACK_PATTERN = new RegExp(`^ask:(${ID_PATTERN_SOURCE})$`);

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: TgMessage;
}

// my_chat_member — статус самого бота в чате (Bot API ChatMemberUpdated).
// Для личного чата важны два статуса: kicked — пользователь заблокировал бота,
// member — разблокировал. Остальные поля ChatMemberUpdated не нужны.
interface TgMyChatMember {
  chat: TgMessage["chat"];
  old_chat_member: { status: string };
  new_chat_member: { status: string };
}

interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgMyChatMember;
  // Telegram всегда шлёт update_id у известных нам типов апдейтов; отсутствие
  // (неизвестный тип или битый JSON) — не повод ронять обработку.
  update_id?: number;
}

/**
 * Зависимости обработчика вебхука — точки инъекции для тестов; дефолтная
 * сборка handleTelegramWebhook берёт дефолтные инстансы store/brain/tg/log.
 */
export interface TelegramWebhookHandlerDeps {
  /** Слайс хранилища: история диалога и дедупликация апдейтов. */
  store: Pick<Store, "getHistory" | "appendHistory" | "clearHistory" | "isSeen" | "markSeen">;
  /** «Мозг»: ответ на вопрос с учётом истории. */
  brain: Pick<Brain, "answer">;
  /** Слайс транспорта Bot API: отправка и косметика чата. */
  tg: Pick<
    TelegramApi,
    "sendMessage" | "sendChatAction" | "answerCallbackQuery" | "editMessageText"
  >;
  /** Логгер обработчика (деградации editMessageText, трейсы апдейтов). */
  log: Logger;
  /** Лимитер по бакету `tg:{chatId}`; true — вопрос в пределах лимита. */
  limit: (bucket: string) => Promise<boolean>;
  /** Источник справки: кнопки /start, /about и восстановление вопроса кнопки. */
  knowledge: Pick<KnowledgeStore, "load">;
}

/**
 * Фабрика обработчика /api/telegram: тело и приватные помощники (startKeyboard,
 * aboutText, answerAsQuestion, handleCommand, handleCallbackQuery) живут в
 * замыкании над deps — тесты подставляют фейки вместо store/brain/tg/log,
 * не трогая сеть.
 * @param {TelegramWebhookHandlerDeps} deps - Инъекции store/brain/tg/log/limit.
 * @returns Обработчик handleTelegramWebhook(request).
 */
export function createTelegramWebhookHandler(deps: TelegramWebhookHandlerDeps) {
  const { store, brain, tg, log, limit, knowledge } = deps;

  // Кнопки /start — те же uiTopics, что чипсы вебчата: один состав на оба канала.
  // Кнопка несёт стабильный id записи (callback_data ограничен 64 байтами, slug
  // влезает с запасом): перестановка/правка контента не меняет смысл старой
  // кнопки. Справка недоступна или пометок chip нет → undefined: /start уходит
  // приветствием без кнопок — интерфейсная команда не должна превращаться
  // в «технические неполадки».
  function startKeyboard(): TgInlineKeyboardMarkup | undefined {
    const topics = uiTopics(knowledge);
    if (topics.length === 0) return undefined;
    return {
      inline_keyboard: topics.map((item) => [
        { text: item.title, callback_data: `ask:${item.id}` },
      ]),
    };
  }

  // Сон, прерываемый abort: typing-цикл гасится сразу после ответа, а не
  // досыпает свои 4.5 с после него. setTimeout в цикле, а не setInterval:
  // после abort не остаётся живых таймеров.
  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  // Повторяющийся индикатор «печатает…»: один sendChatAction Telegram держит
  // ~5 с, а цепочка LLM отвечает до LLM_TOTAL_TIMEOUT_MS — без повторов
  // посетитель большую часть ожидания смотрит на мёртвый чат. Цикл живёт
  // параллельно основному потоку и гасится abort'ом после отправки ответа;
  // сбои sendChatAction — косметика. Осознанно без await на цикле: зависший
  // in-flight sendChatAction (tgCall даёт ему 10 с) не должен задерживать
  // возврат 2xx Telegram'у — цикл безотказный, жить ему осталось недолго.
  async function refreshTyping(chatId: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await tg.sendChatAction(chatId, "typing");
      } catch {
        // Индикатор — косметика, не повод терять ответ.
      }
      await sleep(TYPING_REFRESH_MS, signal);
    }
  }

  // Единый поток для свободного текста и нажатой кнопки: лимит чата → индикатор
  // «печатает…» → история из Redis → ответ brain → отправка → пара вопрос/ответ
  // в историю. Лимитер до истории: шторм вопросов одного чата дешевле остановить
  // до похода в Redis/LLM. Бакет по chatId: атакующему нужны N аккаунтов на N
  // параллельных потоков, а Telegram сам душит массовые аккаунты. Fail-open
  // store — без Redis лимит не срабатывает. Команды (/start /help /reset /about)
  // лимит не тратят: это действия интерфейса без LLM.
  //
  // Порядок «отправить → записать» сознателен: если отправка упала, в историю не
  // должно попасть ничего — фантомная пара осталась бы в контексте, и при
  // повторе LLM продолжал бы старую мысль. Обратная цена (сбой записи после
  // успешной отправки — пара не сохранится) — деградация в пределах fail-open,
  // она менее заметна.
  async function answerAsQuestion(chatId: number, question: string): Promise<void> {
    if (!(await limit(`tg:${chatId}`))) {
      await tg.sendMessage(chatId, RATE_LIMIT_TEXT);
      return;
    }
    // Индикатор «печатает…» до похода в Redis/LLM; статус обновляется циклом
    // refreshTyping (см. её комментарий), гасится после отправки ответа.
    const typingDone = new AbortController();
    refreshTyping(chatId, typingDone.signal);
    try {
      const key = tgKey(chatId);
      const history = await store.getHistory(key);
      const { text: reply, suggestions } = await brain.answer(question, history);
      // Подсказки dumb-fallback → inline-клавиатура с callback_data ask:{id}:
      // клик идёт в существующий handleCallbackQuery, как нажатие кнопки /start.
      // Остальные режимы (llm-ответ, уверенный dumb, недоступная справка) —
      // без клавиатуры: ответу есть что сказать и без «что спросить дальше».
      // В историю пишется только текст: подсказки — UI-слой, не реплика диалога.
      const keyboard: TgInlineKeyboardMarkup | undefined = suggestions?.length
        ? {
            inline_keyboard: suggestions.map(({ id, title }) => [
              { text: title, callback_data: `ask:${id}` },
            ]),
          }
        : undefined;
      await tg.sendMessage(chatId, reply, keyboard);
      await store.appendHistory(key, [
        { role: "user", content: question },
        { role: "assistant", content: reply },
      ]);
    } finally {
      typingDone.abort();
    }
  }

  // /about берём запись с пометкой about: true — явный признак в контенте
  // вместо привязки к точному заголовку «Кто я» (заголовок можно переименовывать
  // свободно). Пометки нет или справка недоступна — осмысленная заглушка, а не
  // произвольная первая запись: команда интерфейсная, «неполадки» на ней не нужны.
  async function aboutText(): Promise<string> {
    const entries = knowledge.load();
    const about = entries?.find((item) => item.about === true);
    return about?.text ?? "Информация о владельце пока не заполнена.";
  }

  // Команды не пишутся в историю: это действия интерфейса, а не реплики
  // диалога — иначе они засоряли бы контекст LLM.
  async function handleCommand(chatId: number, text: string): Promise<void> {
    // /start@BotName и лишние аргументы сводим к имени команды.
    const command = (text.slice(1).split(/\s+/)[0] ?? "").split("@")[0].toLowerCase();
    switch (command) {
      case "start":
        await tg.sendMessage(chatId, WELCOME_TEXT, startKeyboard());
        return;
      case "help":
        // Помощь кликабельна: тот же startKeyboard, что у /start — темы
        // нажимаются как кнопки. Справка недоступна → startKeyboard() вернёт
        // undefined → уйдёт просто текст (команда не должна превращаться
        // в «технические неполадки»).
        await tg.sendMessage(chatId, HELP_TEXT_TELEGRAM, startKeyboard());
        return;
      case "reset":
        await store.clearHistory(tgKey(chatId));
        await tg.sendMessage(chatId, RESET_DONE_TEXT);
        return;
      case "about":
        await tg.sendMessage(chatId, await aboutText());
        return;
      default:
        await tg.sendMessage(chatId, UNKNOWN_COMMAND_TEXT);
    }
  }

  // Кнопка одноразовая: клавиатура снимается СРАЗУ после нажатия, до ответа.
  // Окно «клик → отправка ответа» — единственный шанс даблклика получить два
  // callback_query и два ответа (дедуп по update_id их не различает — это
  // разные апдейты, прод-инцидент 2026-11-10); убитая клавиатура делает
  // второй клик невозможным. Косметика — сбой не критичен.
  async function dropKeyboard(message: TgMessage): Promise<void> {
    if (message.text === undefined) return;
    try {
      await tg.editMessageText(message.chat.id, message.message_id, message.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("telegram-webhook", `не смог снять клавиатуру (${reason})`);
    }
  }

  async function handleCallbackQuery(callback: TgCallbackQuery): Promise<void> {
    const match = CALLBACK_PATTERN.exec(callback.data ?? "");
    const entries = knowledge.load();
    const id = match ? match[1] : null;
    // Неизвестный id (запись удалили/переименовали после отправки /start),
    // битый формат и legacy-кнопки с индексом — один путь «кнопка устарела»:
    // честный ответ вместо чужого ответа не на ту тему.
    const entry =
      id !== null && entries !== null ? entries.find((item) => item.id === id) : undefined;

    const message = callback.message;
    if (!message) return; // ответить некуда — не наш сценарий, апдейт просто отброшен

    if (!entry) {
      // Битый формат или индекс вне диапазона: гасим спиннер с пояснением,
      // историю и чат не трогаем. Ack — косметика: просроченный id нажатия
      // здесь ронять ветку нечему — отвечать всё равно нечего. Клавиатуру
      // снимаем тоже — иначе мёртвые кнопки тостят при каждом клике вечно.
      try {
        await tg.answerCallbackQuery(callback.id, CALLBACK_ERROR_TEXT);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn("telegram-webhook", `не смог ack «кнопка устарела» (${reason})`);
      }
      await dropKeyboard(message);
      return;
    }

    // Спиннер гасим сразу: пользователь не должен ждать LLM с «часиками».
    // Но ack до ответа — косметика: просроченный/повторный callback бросает
    // «query is too old…», и без глотания пользователь не получил бы ответа
    // вовсе (дефект №1 из docs/diagnosis.md §10).
    try {
      await tg.answerCallbackQuery(callback.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("telegram-webhook", `не смог погасить спиннер (${reason})`);
    }

    await dropKeyboard(message);

    // Нажатие кнопки обрабатываем как обычный вопрос (с историей).
    await answerAsQuestion(message.chat.id, entry.title);
  }

  /**
   * Обработчик /api/telegram — все апдейты Telegram-бота: свободный текст → ответ
   * «мозга» с серверной историей, команды /start /help /reset /about, нажатия
   * inline-кнопок (callback_data вида ask:{id} — slug записи справки), статус
   * самого бота (my_chat_member: блокировка чистит историю заблокированного чата).
   *
   * Auth: заголовок x-telegram-bot-api-secret-token должен совпасть с
   * TELEGRAM_WEBHOOK_SECRET — иначе 401. Всегда возвращает 2xx после обработки,
   * иначе Telegram будет повторять доставку update; ошибки обработчика глотаются
   * с логом (в message- и callback-ветках пользователь получает fallback-сообщение
   * о неполадках, спиннер кнопки гасится).
   * Апдейты без текста (фото, стикеры) грациозно игнорируются.
   *
   * Env: TELEGRAM_WEBHOOK_SECRET (без него все запросы — 401); остальные —
   * через bot/config.ts: TELEGRAM_BOT_TOKEN, UPSTASH_REDIS_REST_URL/TOKEN
   * (fail-open без Redis).
   *
   * @param {Request} request - Входящий запрос функции.
   * @returns {Promise<Response>} JSON {ok:true}; 401 при неверном/отсутствующем секрете.
   */
  async function handleTelegramWebhook(request: Request): Promise<Response> {
    // Проверяем, что запрос пришёл действительно от Telegram (секрет задаётся в setWebhook)
    const expected = config.telegram.webhookSecret;
    if (!expected || request.headers.get(SECRET_HEADER) !== expected) {
      return Response.json({ ok: false }, { status: 401 });
    }

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return Response.json({ ok: true });
    }

    // Дедупликация по update_id: Telegram — at-least-once, при не-2xx или
    // потерянном ответе он повторяет ТОТ ЖЕ JSON, а повтор неотличим от нового
    // вопроса (второй вызов LLM, вторая пара в истории). Маркер ставится ПОСЛЕ
    // успешной обработки, проверка — ДО: маркер до работы ломает сценарий
    // «функция убита по таймауту» — повтор увидел бы маркер и молча не ответил
    // бы, это хуже дубля. Параллельной доставки одного апдейта Telegram не
    // делает — повтор возможен только после неудачи, то есть до установки
    // маркера; NX в markSeen — страховка от гипотетической гонки.
    //
    // Дедупликация до hitRateLimit (лимитер внутри answerAsQuestion): иначе
    // повтор съедает хит лимита, и пользователь получает «слишком много
    // вопросов» из-за доставки одного сообщения. isSeen fail-open — без Redis
    // дедупликация просто отключается.
    const seenKey = typeof update.update_id === "number" ? tgSeenKey(update.update_id) : null;
    if (seenKey && (await store.isSeen(seenKey))) {
      log.debug("telegram-webhook", `дубль update ${update.update_id} — уже обработан, пропускаю`);
      return Response.json({ ok: true });
    }

    if (update.callback_query) {
      const callback = update.callback_query;
      try {
        // Как в message-ветке: нажатия должны быть видны в debug-логе, иначе
        // «кнопка молчит» неотличима от «событие не доставлено» (дефект №3).
        log.debug(
          "telegram-webhook",
          `апдейт ${update.update_id ?? "—"} callback «${callback.data ?? "—"}» от ${callback.message?.chat.id ?? "—"}`,
        );
        await handleCallbackQuery(callback);
        // Маркер только после успешной обработки: если она бросила — маркера нет,
        // и повтор дойдёт до LLM.
        if (seenKey) await store.markSeen(seenKey, config.telegram.seenTtlSeconds);
      } catch (error) {
        log.error(
          "telegram-webhook",
          `callback_query: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Спиннер всё равно надо погасить, иначе он крутится до таймаута Telegram.
        try {
          await tg.answerCallbackQuery(callback.id);
        } catch {
          // Уже отвечен или сеть недоступна — не критично.
        }
        // Fallback как в message-ветке: сбой отправки ответа не должен выглядеть
        // для пользователя тишиной (дефект №2). chatId может отсутствовать
        // (inline-режим — не наш сценарий, но guard дешевле предположения).
        const chatId = callback.message?.chat.id;
        if (chatId !== undefined) {
          try {
            await tg.sendMessage(chatId, TECHNICAL_TROUBLE_TEXT);
          } catch {
            // Ответить не вышло — Telegram сам повторит доставку update
          }
        }
      }
      // Telegram ждёт 2xx, иначе будет повторять отправку update
      return Response.json({ ok: true });
    }

    // Блокировка/разблокировка бота (Telegram присылает статус самого бота).
    // Это не реплика диалога: Telegram API не трогаем, лимит и историю ответов
    // не используем. Полезное действие одно — заблокированный чат чистим:
    // хвост диалога мёртвого чата не должен доживать в Redis до конца TTL.
    const myChatMember = update.my_chat_member;
    if (myChatMember) {
      try {
        const chatId = myChatMember.chat.id;
        const status = myChatMember.new_chat_member.status;
        if (status === "kicked") {
          log.warn("telegram-webhook", `чат ${chatId} заблокировал бота — очищаю историю`);
          await store.clearHistory(tgKey(chatId));
        } else if (status === "member") {
          log.debug("telegram-webhook", `чат ${chatId} разблокировал бота`);
        } else {
          log.debug("telegram-webhook", `чат ${chatId}: статус бота → ${status}`);
        }
        if (seenKey) await store.markSeen(seenKey, config.telegram.seenTtlSeconds);
      } catch (error) {
        log.error(
          "telegram-webhook",
          `my_chat_member: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Telegram ждёт 2xx, иначе будет повторять отправку update
      return Response.json({ ok: true });
    }

    const message = update.message;
    if (message?.text) {
      try {
        log.debug(
          "telegram-webhook",
          `апдейт ${update.update_id ?? "—"} от ${message.chat.id}: ${message.text.slice(0, 80)}`,
        );
        if (message.text.startsWith("/")) {
          await handleCommand(message.chat.id, message.text);
        } else {
          await answerAsQuestion(message.chat.id, message.text);
        }
        // Маркер после успешной обработки (см. комментарий к дедупликации выше):
        // бросок dispatch — маркера нет, Telegram повторит и дойдёт до LLM.
        if (seenKey) await store.markSeen(seenKey, config.telegram.seenTtlSeconds);
        log.debug("telegram-webhook", `ответ отправлен в ${message.chat.id}`);
      } catch (error) {
        log.error("telegram-webhook", error instanceof Error ? error.message : String(error));
        try {
          await tg.sendMessage(message.chat.id, TECHNICAL_TROUBLE_TEXT);
        } catch {
          // Ответить не вышло — Telegram сам повторит доставку update
        }
      }
    }
    // Сообщение без текста (фото, стикеры, …) грациозно игнорируем:
    // отвечать нечего, а пинг-понг «напиши текстом» только засоряет чат.

    // Telegram ждёт 2xx, иначе будет повторять отправку update
    return Response.json({ ok: true });
  }

  return handleTelegramWebhook;
}

// Дефолтная сборка из поимённых экспортов модулей: api/bot.ts импортирует
// handler напрямую, тесты приходят со своими фейками через createTelegramWebhookHandler.
export const handleTelegramWebhook = createTelegramWebhookHandler({
  store: { getHistory, appendHistory, clearHistory, isSeen, markSeen },
  brain: { answer },
  tg: { sendMessage, sendChatAction, answerCallbackQuery, editMessageText },
  log: rootLog,
  limit: hitRateLimit,
  knowledge: rootKnowledge,
});
