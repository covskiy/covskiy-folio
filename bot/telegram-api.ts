// config — готовый типизированный слайс telegram (токен/секрет trim'нутые,
// apiRoot без хвостовых слэшей и с дефолтом); дефолтный инстанс для рантайма.
// Env-оверрайд TELEGRAM_API_ROOT — только для локального смоука против мока
// (bot/dev/mock-telegram-api.mjs), на прод не задавать.
import { config } from "./config.js";
import type { AppConfig } from "./config.js";

/**
 * Транспорт Bot API — единственное место, где код ходит в Telegram
 * (sendMessage/answerCallbackQuery/editMessageText/…). Никакой доменной
 * логики: обработчики получают готовые слайсы апдейта.
 *
 * Состояние инстансное, а не модульное (фабрика createTelegramApi): tgCall
 * и шесть публичных функций живут в замыкании, deps (config, fetchImpl)
 * резолвятся НА КАЖДЫЙ вызов, а не при создании фабрики — подмена после
 * создания инстанса остаётся видимой (тот же принцип, что у createLlm).
 *
 * Дефолтный инстанс с поимённым переэкспортом — точка прямых импортов
 * обработчиков (telegram-webhook.ts, telegram-admin.ts).
 */

/**
 * Зависимости транспорта — точки инъекции для тестов; в рантайме
 * createTelegramApi() без аргументов (дефолтный config и глобальный fetch).
 */
export interface TelegramApiDeps {
  /** Готовый конфиг; по умолчанию дефолтный config из config.ts (process.env). */
  config?: AppConfig;
  /** Подмена сети; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Чат Telegram — подмножество полей Bot API, нужное боту.
 */
export interface TgChat {
  /** Идентификатор чата — он же часть ключа истории в store. */
  id: number;
  /** Имя пользователя (если не скрыто настройками приватности). */
  first_name?: string;
  /** @username, если есть. */
  username?: string;
}

/**
 * Сообщение Telegram — подмножество полей Bot API, нужное боту.
 */
export interface TgMessage {
  /** Идентификатор сообщения в чате (нужен для editMessageText). */
  message_id: number;
  /** Чат, в котором находится сообщение. */
  chat: TgChat;
  /** Текст; отсутствует у сообщений без текста (фото, стикеры, …). */
  text?: string;
}

/**
 * Кнопка inline-клавиатуры Telegram.
 */
export interface TgInlineKeyboardButton {
  /** Надпись на кнопке. */
  text: string;
  /** Данные, вернувшиеся в callback_query (лимит 64 байта — у нас только индекс). */
  callback_data: string;
}

/**
 * Inline-клавиатура Telegram.
 */
export interface TgInlineKeyboardMarkup {
  /** Строки кнопок (каждая строка — массив кнопок). */
  inline_keyboard: TgInlineKeyboardButton[][];
}

/**
 * Состояние вебхука — подмножество WebhookInfo Bot API (диагностика доставки).
 */
export interface TgWebhookInfo {
  /** URL вебхука; пусто, если не установлен. */
  url?: string;
  /** Число апдейтов, ожидающих доставки. */
  pending_update_count?: number;
  /** Unix-время последней ошибки доставки. */
  last_error_date?: number;
  /** Текст последней ошибки доставки. */
  last_error_message?: string;
  /** Фильтр типов событий из setWebhook; поля нет, если фильтр не задавался. */
  allowed_updates?: string[];
}

// Лимит Telegram на текст одного сообщения; длинные ответы brain режем на части.
const TEXT_LIMIT = 4_096;

function splitForLimit(text: string): string[] {
  if (text.length <= TEXT_LIMIT) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > TEXT_LIMIT) {
    // Режем по последнему переводу строки в окне, чтобы не рвать строки
    // посередине; если перенос слишком далеко от края — режем жёстко.
    let cut = rest.lastIndexOf("\n", TEXT_LIMIT);
    if (cut < TEXT_LIMIT / 2) cut = TEXT_LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  parts.push(rest);
  return parts;
}

/**
 * Фабрика транспорта Bot API: tgCall и публичные методы — в замыкании этого
 * инстанса. deps резолвятся на каждый вызов tgCall — подмена fetch/config
 * после создания инстанса работает.
 * @param {TelegramApiDeps} deps - Инъекции config/fetchImpl; без аргументов —
 *   глобальный fetch и дефолтный config (process.env).
 * @returns Шесть методов Bot API, бросающих при проблеме сети/токена/ok:false.
 */
export function createTelegramApi(deps: TelegramApiDeps = {}) {
  /**
   * Вызов метода Bot API. При ok:false бросает; если Telegram вернул
   * parameters.retry_after (flood-лимит, секунды) — число добавляется в текст
   * ошибки хвостом «(retry_after: Ns)».
   * @param {string} method - Имя метода Bot API.
   * @param {unknown} payload - Тело запроса (JSON-сериализуемый объект).
   * @returns {Promise<T>} Поле result ответа Bot API.
   * @throws {Error} Не задан TELEGRAM_BOT_TOKEN, ошибка сети или ok:false
   *   (описание/status из ответа, плюс retry_after при flood-лимите).
   */
  async function tgCall<T>(method: string, payload: unknown): Promise<T> {
    // Срез и транспорт резолвим на каждый вызов, не при создании фабрики:
    // подмена deps/config после создания инстанса остаётся видимой.
    const tg = (deps.config ?? config).telegram;
    const token = tg.botToken;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");

    const response = await (deps.fetchImpl ?? fetch)(`${tg.apiRoot}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    const data = (await response.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!data.ok) {
      // retry_after (flood) в текст ошибки, не в сон: ожидание здесь сжигает время
      // инвокации, а повторную доставку делает сам Telegram.
      const after = data.parameters?.retry_after;
      throw new Error(
        `Telegram ${method} failed: ${data.description ?? response.status}` +
          (after !== undefined ? ` (retry_after: ${after}s)` : ""),
      );
    }
    return data.result as T;
  }

  /**
   * Отправить текст в чат. Ответы длиннее 4096 символов (лимит Telegram на одно
   * сообщение) режутся на части по переводам строк и отправляются последовательно;
   * replyMarkup прикрепляется только к последней части.
   *
   * Env: TELEGRAM_BOT_TOKEN — без него бросает. Бросает и при ошибке сети/API
   * (таймаут 10 с); fallback пользователю — ответственность вызывающего.
   *
   * @param {number} chatId - Идентификатор чата.
   * @param {string} text - Текст сообщения (любой длины).
   * @param {TgInlineKeyboardMarkup} [replyMarkup] - Inline-клавиатура для последней части.
   * @returns {Promise<TgMessage>} Последнее отправленное сообщение.
   * @throws {Error} Нет TELEGRAM_BOT_TOKEN, ошибка сети или Telegram API.
   */
  async function sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TgInlineKeyboardMarkup,
  ): Promise<TgMessage> {
    const parts = splitForLimit(text);
    let sent: TgMessage | undefined;
    for (let i = 0; i < parts.length; i++) {
      // Клавиатура прикрепляется к последней части: в чате она визуально
      // «прижата» к низу переписки, а не к середине длинного ответа.
      const markup = i === parts.length - 1 ? replyMarkup : undefined;
      sent = await tgCall<TgMessage>("sendMessage", {
        chat_id: chatId,
        text: parts[i],
        ...(markup ? { reply_markup: markup } : {}),
      });
    }
    return sent as TgMessage;
  }

  // Гасит «часики» на нажатой кнопке; text (если задан) — всплывающее уведомление.
  /**
   * Гасит «часики» на нажатой inline-кнопке (answerCallbackQuery Bot API).
   * @param {string} callbackQueryId - id из callback_query, на который отвечаем.
   * @param {string} [text] - Всплывающее уведомление над кнопкой (сообщение не отправляется).
   * @returns {Promise<boolean>} true при успехе (result метода Bot API).
   * @throws {Error} Нет TELEGRAM_BOT_TOKEN, ошибка сети или Telegram API.
   */
  function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return tgCall<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  // Правка текста сообщения. reply_markup намеренно не передаём: это способ
  // снять inline-клавиатуру (кнопки-подсказки у нас одноразовые).
  /**
   * Правка текста сообщения (editMessageText Bot API).
   * @param {number} chatId - Идентификатор чата.
   * @param {number} messageId - Идентификатор правимого сообщения.
   * @param {string} text - Новый текст сообщения.
   * @returns {Promise<TgMessage>} Результат правки от Bot API.
   * @throws {Error} Нет TELEGRAM_BOT_TOKEN, ошибка сети или Telegram API
   *   (в т.ч. «text is not modified» — при повторной правке без изменения).
   */
  function editMessageText(chatId: number, messageId: number, text: string): Promise<TgMessage> {
    return tgCall<TgMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  /**
   * Служебный статус «печатает…» в шапке чата (sendChatAction Bot API):
   * НЕ создаёт сообщение, в историю не попадает, исчезает сам (~5 с) — окно
   * рассчитано на время генерации LLM. Ошибка здесь — косметика и не повод
   * ронять обработку (глотает вызывающий).
   * @param {number} chatId - Идентификатор чата.
   * @param {string} action - Действие Bot API (у нас всегда "typing").
   * @returns {Promise<boolean>} true при успехе.
   * @throws {Error} Нет TELEGRAM_BOT_TOKEN, ошибка сети или Telegram API.
   */
  function sendChatAction(chatId: number, action: string): Promise<boolean> {
    return tgCall<boolean>("sendChatAction", { chat_id: chatId, action });
  }

  /**
   * Зарегистрировать вебхук бота (setWebhook Bot API).
   * @param {object} params - Параметры метода.
   * @param {string} params.url - HTTPS-URL, на который Telegram шлёт апдейты.
   * @param {string} [params.secret_token] - Секрет для заголовка x-telegram-bot-api-secret-token.
   * @param {string[]} [params.allowed_updates] - Типы апдейтов; без него callback_query не приходит.
   * @returns {Promise<boolean>} true при успехе.
   * @throws {Error} Нет TELEGRAM_BOT_TOKEN, ошибка сети или Telegram API.
   */
  function setWebhook(params: {
    url: string;
    secret_token?: string;
    allowed_updates?: string[];
  }): Promise<boolean> {
    return tgCall<boolean>("setWebhook", params);
  }

  /**
   * Текущее состояние вебхука (getWebhookInfo Bot API) — диагностика доставки
   * апдейтов для админ-маршрута.
   * @returns {Promise<TgWebhookInfo>} Данные WebhookInfo.
   * @throws {Error} Нет TELEGRAM_BOT_TOKEN, ошибка сети или Telegram API.
   */
  function getWebhookInfo(): Promise<TgWebhookInfo> {
    return tgCall<TgWebhookInfo>("getWebhookInfo", {});
  }

  return {
    sendMessage,
    sendChatAction,
    answerCallbackQuery,
    editMessageText,
    setWebhook,
    getWebhookInfo,
  };
}

export type TelegramApi = ReturnType<typeof createTelegramApi>;

// Дефолтный инстанс + поимённый переэкспорт: текущие импорты обработчиков
// (telegram-webhook.ts, telegram-admin.ts) продолжают работать без правок.
const defaultApi = createTelegramApi();
export const sendMessage = defaultApi.sendMessage;
export const sendChatAction = defaultApi.sendChatAction;
export const answerCallbackQuery = defaultApi.answerCallbackQuery;
export const editMessageText = defaultApi.editMessageText;
export const setWebhook = defaultApi.setWebhook;
export const getWebhookInfo = defaultApi.getWebhookInfo;
