// config — готовый типизированный слайс telegram (секрет trim'нутый);
// дефолтный инстанс для рантайма.
import { config, type AppConfig } from "../config.js";
import { createLlm, type Llm } from "../llm/index.js";
import { log as rootLog, type Logger } from "../log.js";
import { systemPrompt } from "../brain/prompt.js";
import { knowledge as rootKnowledge, type KnowledgeStore } from "../brain/knowledge.js";
import { ping as pingRedis, type Store } from "../store.js";
import {
  getWebhookInfo,
  setWebhook,
  type TelegramApi,
  type TgWebhookInfo,
} from "../telegram-api.js";

// Админ-маршрут: регистрация и диагностика Telegram-вебхука, health бота,
// просмотр собранного промта. Защищён тем же секретом, что и вебхук; без
// секрета отвечаем 404, чтобы не подтверждать существование маршрута.
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Зависимости обработчика админ-маршрута — точки инъекции для тестов; дефолтная
 * сборка handleTelegramAdmin берёт дефолтные инстансы config/llm/tg/store/log.
 */
export interface TelegramAdminHandlerDeps {
  /** Конфиг; секрет читается на КАЖДЫЙ запрос через config.telegram — ленивые геттеры держат vi.stubEnv-совместимость. */
  config: AppConfig;
  /** Слайс LLM-транспорта для пункта health. */
  llm: Pick<Llm, "ping">;
  /** Слайс транспорта Bot API: диагностика и установка вебхука. */
  tg: Pick<TelegramApi, "getWebhookInfo" | "setWebhook">;
  /** Слайс хранилища для пункта health (PING Redis). */
  store: Pick<Store, "ping">;
  /** Логгер обработчика (поломка конфигурации, результат setWebhook). */
  log: Logger;
  /** Источник справки для пункта ?section=prompt. */
  knowledge: Pick<KnowledgeStore, "load">;
}

/**
 * Фабрика обработчика /api/telegram-setup: тело и приватные помощники
 * (telegramHealth, healthResponse) живут в замыкании над deps — тесты
 * подставляют фейки вместо llm/tg/store и config из createConfig({...}).
 * @param {TelegramAdminHandlerDeps} deps - Инъекции config/llm/tg/store/log.
 * @returns Обработчик handleTelegramAdmin(request).
 */
export function createTelegramAdminHandler(deps: TelegramAdminHandlerDeps) {
  const { config, llm, tg, store, log, knowledge } = deps;

  type TelegramHealth = { ok: true; webhook: TgWebhookInfo } | { ok: false; error: string };

  async function telegramHealth(): Promise<TelegramHealth> {
    try {
      return { ok: true, webhook: await tg.getWebhookInfo() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: reason };
    }
  }

  // Пункты health независимы: считаем параллельно, ошибка одного (уже пойманная
  // внутри ping-функций) не влияет на остальные.
  async function healthResponse(): Promise<Response> {
    const [llmHealth, redis, telegram] = await Promise.all([
      llm.ping(),
      store.ping(),
      telegramHealth(),
    ]);
    return Response.json({ ok: true, llm: llmHealth, redis, telegram });
  }

  /**
   * Обработчик /api/telegram-setup — админ-маршрут владельца:
   * GET без section — диагностика вебхука (getWebhookInfo),
   * GET ?section=health — health LLM, Redis и Telegram (параллельно),
   * GET ?section=prompt — собранный system-промт,
   * POST — установка вебхука на текущий origin (setWebhook).
   *
   * Auth: секрет в заголовке x-telegram-bot-api-secret-token; без
   * TELEGRAM_WEBHOOK_SECRET или при несовпадении — 404 (не 401: маршрут
   * не подтверждает своё существование). Ошибка Telegram API — 502 с текстом.
   *
   * Env: TELEGRAM_WEBHOOK_SECRET (обязателен); для health — слоты
   * LLM_1_*…LLM_9_* и UPSTASH_REDIS_REST_URL/TOKEN.
   *
   * @param {Request} request - Входящий запрос функции.
   * @returns {Promise<Response>} JSON; коды: 200, 404 (секрет отсутствует/неверен), 405, 502.
   */
  async function handleTelegramAdmin(request: Request): Promise<Response> {
    // Секрет — на каждый запрос, не при создании фабрики: конфиг ленивый,
    // подмена env после сборки deps остаётся видимой.
    const secret = config.telegram.webhookSecret;
    if (!secret) {
      // Печатаем только факт поломки конфигурации, не значение секрета.
      log.error("telegram-admin", "TELEGRAM_WEBHOOK_SECRET не задан в env");
      return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
    }
    if (request.headers.get(SECRET_HEADER) !== secret) {
      log.warnThrottled(
        "telegram-admin",
        "bad-secret",
        `отклонён запрос с неверным секретом (${request.method})`,
      );
      return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
    }

    try {
      if (request.method === "GET") {
        // Ветвление по query-параметру: маршрут адресуется одним путём
        // (/api/telegram-setup), подпути через vercel.json не заводим.
        const section = new URL(request.url).searchParams.get("section");
        if (section === "health") return await healthResponse();
        if (section === "prompt") {
          const entries = knowledge.load();
          // Диагностика для владельца: недоступная справка — явная ошибка, а не
          // промт без секции знаний; причина уже в логе (warn хранилища).
          if (!entries) {
            return Response.json(
              { ok: false, error: "справка недоступна — причина в логах" },
              { status: 502 },
            );
          }
          // Под секретом можно целиком; справка уже внутри промта.
          return Response.json({ ok: true, prompt: systemPrompt(entries) });
        }
        // Без section — диагностика вебхука.
        const webhook = await tg.getWebhookInfo();
        log.debug("telegram-admin", `getWebhookInfo: ${JSON.stringify(webhook)}`);
        return Response.json({ ok: true, webhook });
      }
      if (request.method === "POST") {
        const origin = new URL(request.url).origin;
        const url = `${origin}/api/telegram`;
        const result = await tg.setWebhook({
          url,
          secret_token: secret,
          // callback_query — кнопки-подсказки на /start и dumb-fallback;
          // my_chat_member — блокировка бота: чистим историю заблокированного чата.
          // Фильтр хранится на стороне Telegram: после правки списка — перерегистрация
          // (POST /api/telegram-setup), деплой сам её не делает.
          allowed_updates: ["message", "callback_query", "my_chat_member"],
        });
        log.info("telegram-admin", `вебхук установлен: ${url}`);
        return Response.json({ ok: true, result });
      }
      return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
    } catch (error) {
      // Ошибку Telegram API отдаём как есть — это диагностика для владельца.
      const reason = error instanceof Error ? error.message : String(error);
      log.error("telegram-admin", `ошибка Telegram API: ${reason}`);
      return Response.json({ ok: false, error: reason }, { status: 502 });
    }
  }

  return handleTelegramAdmin;
}

// Дефолтная сборка из поимённых экспортов модулей: api/bot.ts импортирует
// handler напрямую, тесты приходят со своими фейками через createTelegramAdminHandler.
// Инстанс LLM-транспорта собирается здесь (не на модуле): env резолвится внутри
// на каждый вызов, так что Redeploy с новыми LLM_* работает без пересборки.
export const handleTelegramAdmin = createTelegramAdminHandler({
  config,
  llm: createLlm(),
  tg: { getWebhookInfo, setWebhook },
  store: { ping: pingRedis },
  log: rootLog,
  knowledge: rootKnowledge,
});
