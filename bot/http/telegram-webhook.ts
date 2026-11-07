import process from "node:process";
import { log } from "../log.js";
import { answer } from "../brain/brain.js";
import { knowledgeEntries } from "../brain/prompt.js";
import { hitRateLimit } from "../rate-limit.js";
import {
  appendHistory,
  clearHistory,
  getHistory,
  isSeen,
  markSeen,
  tgKey,
  tgSeenKey,
} from "../store.js";
import {
  answerCallbackQuery,
  editMessageText,
  sendChatAction,
  sendMessage,
  type TgInlineKeyboardMarkup,
  type TgMessage,
} from "../telegram-api.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const WELCOME_TEXT = [
  "Привет! Я справочный бот этого сайта — отвечу на вопросы обо мне, моих услугах и контактах.",
  "Задай вопрос текстом или нажми кнопку ниже.",
].join("\n");

const HELP_TEXT = [
  "Что я умею:",
  "• отвечаю на вопросы — по справке этого сайта, с учётом истории диалога;",
  "• /about — коротко о владельце;",
  "• /reset — начать новый диалог (очистить историю);",
  "• /help — этот список.",
].join("\n");

const RESET_DONE_TEXT = "История диалога очищена — начинаем с чистого листа.";

const UNKNOWN_COMMAND_TEXT = "Не знаю такую команду. Набери /help — покажу, что умею.";

const CALLBACK_ERROR_TEXT = "Кнопка устарела. Набери /start — дам свежие подсказки.";

const RATE_LIMIT_TEXT =
  "Слишком много вопросов подряд — сделай небольшую паузу и попробуй снова 🙂";

// На /start — первые 3 элемента справки, те же темы, что чипсы вебчата.
const START_BUTTONS_COUNT = 3;

// Час — с запасом перекрывает ретраи Telegram по одному апдейту, ключи чистятся сами.
const SEEN_TTL_SECONDS = 3_600;

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: TgMessage;
}

interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  // Telegram всегда шлёт update_id у известных нам типов апдейтов; отсутствие
  // (неизвестный тип или битый JSON) — не повод ронять обработку.
  update_id?: number;
}

// callback_data ограничен 64 байтами, поэтому кнопка несёт только индекс,
// а вопрос восстанавливается из справки по номеру (те же темы, что чипсы сайта).
function startKeyboard(): TgInlineKeyboardMarkup {
  const buttons = knowledgeEntries()
    .slice(0, START_BUTTONS_COUNT)
    .map((item, index) => ({ text: item.title, callback_data: `ask:${index}` }));
  return { inline_keyboard: buttons.map((button) => [button]) };
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
  if (!(await hitRateLimit(`tg:${chatId}`))) {
    await sendMessage(chatId, RATE_LIMIT_TEXT);
    return;
  }
  // Индикатор «печатает…» до похода в Redis/LLM; один вызов без таймеров и
  // повторов — LLM обычно укладывается в окно ~5 с, повторять значило бы
  // тратить время инвокации.
  try {
    await sendChatAction(chatId, "typing");
  } catch {
    // Индикатор — косметика, не повод терять ответ.
  }
  const key = tgKey(chatId);
  const history = await getHistory(key);
  const { text: reply } = await answer(question, history);
  await sendMessage(chatId, reply);
  await appendHistory(key, [
    { role: "user", content: question },
    { role: "assistant", content: reply },
  ]);
}

// /about берём из справки: элемент с заголовком «Кто я». Заголовок может
// переименовать сам владелец (контент правится в knowledge.json без правки
// кода), поэтому fallback — первый элемент: команда обязана осмысленно
// отвечать при любой правке контента.
async function aboutText(): Promise<string> {
  const entries = knowledgeEntries();
  const about = entries.find((item) => item.title === "Кто я") ?? entries[0];
  return about?.text ?? "Информация о владельце пока не заполнена.";
}

// Команды не пишутся в историю: это действия интерфейса, а не реплики
// диалога — иначе они засоряли бы контекст LLM.
async function handleCommand(chatId: number, text: string): Promise<void> {
  // /start@BotName и лишние аргументы сводим к имени команды.
  const command = (text.slice(1).split(/\s+/)[0] ?? "").split("@")[0].toLowerCase();
  switch (command) {
    case "start":
      await sendMessage(chatId, WELCOME_TEXT, startKeyboard());
      return;
    case "help":
      await sendMessage(chatId, HELP_TEXT);
      return;
    case "reset":
      await clearHistory(tgKey(chatId));
      await sendMessage(chatId, RESET_DONE_TEXT);
      return;
    case "about":
      await sendMessage(chatId, await aboutText());
      return;
    default:
      await sendMessage(chatId, UNKNOWN_COMMAND_TEXT);
  }
}

async function handleCallbackQuery(callback: TgCallbackQuery): Promise<void> {
  const match = /^ask:(\d+)$/.exec(callback.data ?? "");
  const entries = knowledgeEntries();
  const index = match ? Number(match[1]) : Number.NaN;
  const entry = Number.isInteger(index) && index >= 0 ? entries[index] : undefined;

  if (!entry) {
    // Битый формат или индекс вне диапазона: гасим спиннер с пояснением,
    // историю и чат не трогаем.
    await answerCallbackQuery(callback.id, CALLBACK_ERROR_TEXT);
    return;
  }

  // Спиннер гасим сразу: пользователь не должен ждать LLM с «часиками».
  await answerCallbackQuery(callback.id);

  const message = callback.message;
  if (!message) return; // ответить некуда — не наш сценарий, апдейт просто отброшен

  // Нажатие кнопки обрабатываем как обычный вопрос (с историей).
  await answerAsQuestion(message.chat.id, entry.title);

  // Кнопка одноразовая: снимаем клавиатуру со старого сообщения /start,
  // чтобы повторные нажатия не засоряли диалог. Косметика — сбой не критичен.
  if (message.text !== undefined) {
    try {
      await editMessageText(message.chat.id, message.message_id, message.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("telegram-webhook", `не смог снять клавиатуру (${reason})`);
    }
  }
}

/**
 * Обработчик /api/telegram — все апдейты Telegram-бота: свободный текст → ответ
 * «мозга» с серверной историей, команды /start /help /reset /about, нажатия
 * inline-кнопок (callback_data вида ask:{index}).
 *
 * Auth: заголовок x-telegram-bot-api-secret-token должен совпасть с
 * TELEGRAM_WEBHOOK_SECRET — иначе 401. Всегда возвращает 2xx после обработки,
 * иначе Telegram будет повторять доставку update; ошибки обработчика глотаются
 * с логом (пользователю уходит сообщение о неполадках, спиннер кнопки гасится).
 * Апдейты без текста (фото, стикеры) грациозно игнорируются.
 *
 * Env: TELEGRAM_WEBHOOK_SECRET (без него все запросы — 401); через lib —
 * TELEGRAM_BOT_TOKEN, UPSTASH_REDIS_REST_URL/TOKEN (fail-open без Redis).
 *
 * @param {Request} request - Входящий запрос функции.
 * @returns {Promise<Response>} JSON {ok:true}; 401 при неверном/отсутствующем секрете.
 */
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
  if (seenKey && (await isSeen(seenKey))) {
    log.debug("telegram-webhook", `дубль update ${update.update_id} — уже обработан, пропускаю`);
    return Response.json({ ok: true });
  }

  if (update.callback_query) {
    try {
      await handleCallbackQuery(update.callback_query);
      // Маркер только после успешной обработки: если она бросила — маркера нет,
      // и повтор дойдёт до LLM.
      if (seenKey) await markSeen(seenKey, SEEN_TTL_SECONDS);
    } catch (error) {
      log.error(
        "telegram-webhook",
        `callback_query: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Спиннер всё равно надо погасить, иначе он крутится до таймаута Telegram.
      try {
        await answerCallbackQuery(update.callback_query.id);
      } catch {
        // Уже отвечен или сеть недоступна — не критично.
      }
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
      if (seenKey) await markSeen(seenKey, SEEN_TTL_SECONDS);
      log.debug("telegram-webhook", `ответ отправлен в ${message.chat.id}`);
    } catch (error) {
      log.error("telegram-webhook", error instanceof Error ? error.message : String(error));
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
  // Сообщение без текста (фото, стикеры, …) грациозно игнорируем:
  // отвечать нечего, а пинг-понг «напиши текстом» только засоряет чат.

  // Telegram ждёт 2xx, иначе будет повторять отправку update
  return Response.json({ ok: true });
}
