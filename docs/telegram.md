# Telegram-бот

## 1. Создание бота

1. В Telegram открыть [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Задать имя (отображается в чате) и username (заканчивается на `bot`).
3. BotFather выдаст **токен** вида `123456789:AAF...` — это `TELEGRAM_BOT_TOKEN`.
   Токен = полный доступ к боту: не коммитить, не слать в чаты.

Полезно сразу в BotFather: `/setuserpic` (аватар), `/setdescription`, `/setabouttext`.

## 2. Секрет webhook

Придумай длинную случайную строку (например, сгенерируй):

```bash
node -e "console.log(crypto.randomBytes(24).toString('hex'))"
```

Это `TELEGRAM_WEBHOOK_SECRET`: одно значение в env на Vercel, то же — параметром
`secret_token` при setWebhook. Telegram будет присылать его в каждом запросе
заголовком `X-Telegram-Bot-Api-Secret-Token`, а `bot/http/telegram-webhook.ts` сверяет.

## 3. Регистрация webhook

Основной способ — через админ-маршрут на Vercel (`bot/http/telegram-admin.ts`):
прямого доступа к api.telegram.org не нужно (у части провайдеров он заблокирован).

```bash
curl -X POST https://covskiy-folio.vercel.app/api/telegram-setup \
  -H "x-telegram-bot-api-secret-token: $TELEGRAM_WEBHOOK_SECRET"
```

Маршрут сам подставит `url` вебхука (из origin запроса) и `secret_token`
(из env Vercel), `allowed_updates: ["message", "callback_query"]` — второе нужно
для inline-кнопок на `/start`. Ожидаемый ответ:
`{"ok":true,"result":true,"description":"Webhook was set"}`.

Проверка (тем же адресом, метод GET):

```bash
curl https://covskiy-folio.vercel.app/api/telegram-setup \
  -H "x-telegram-bot-api-secret-token: $TELEGRAM_WEBHOOK_SECRET"
```

Хорошо: `url` задан, `pending_update_count` маленький, нет `last_error_message`.

Прямой вызов Bot API — если есть VPN/DPI до Telegram:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://covskiy-folio.vercel.app/api/telegram" \
  --data-urlencode "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  --data-urlencode 'allowed_updates=["message","callback_query","my_chat_member"]'
```

Без `allowed_updates` Telegram сохранит прежний фильтр, а не поставит новый —
список здесь должен совпадать с `bot/http/telegram-admin.ts`.

## 4. Как это работает

```
Пользователь пишет боту (или жмёт inline-кнопку на /start)
  → Telegram делает POST на /api/telegram
      (заголовок X-Telegram-Bot-Api-Secret-Token = наш секрет)
  → api/bot.ts → bot/http/telegram-webhook.ts
      сверяет секрет
      → команда (/start, /help, /reset, /about)? — ответ без записи в историю
      → иначе: история из Redis (chat:tg:{chat_id}) → brain.answer()
        → пара вопрос/ответ в историю → sendMessage
  → функция отвечает Telegram 200 (иначе приедет повтор)
```

История диалога живёт в Upstash Redis (`chat:tg:{chat_id}`, TTL 24 часа) —
контекст сохраняется между сообщениями; `/reset` очищает её сразу. Fail-open:
без Redis бот отвечает, просто без контекста.

Один бот обслуживает неограниченное число чатов: ответ уходит в
`update.message.chat.id` — тот чат, откуда пришло сообщение.

## 5. Смена/снятие webhook

Перенести на другой URL или сменить секрет — просто вызвать setWebhook заново
(админ-маршрут из шага 3 или прямой вызов). Снять webhook можно только прямым
вызовом `deleteWebhook` — админ-маршрут его не делает:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"   # отключить
```

После смены `TELEGRAM_WEBHOOK_SECRET` в env Vercel не забудь redeploy — иначе
все запросы начнут получать 401.
