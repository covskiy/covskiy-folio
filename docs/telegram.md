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
заголовком `X-Telegram-Bot-Api-Secret-Token`, а `lib/telegram-webhook.ts` сверяет.

## 3. Регистрация webhook

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://covskiy-folio.vercel.app/api/telegram" \
  --data-urlencode "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Требования Telegram к URL: HTTPS (у Vercel это из коробки) и совпадение секрета.

Проверка:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Хорошо: `url` задан, `pending_update_count` маленький, нет `last_error_message`.

## 4. Как это работает

```
Пользователь пишет боту
  → Telegram делает POST на /api/telegram
      (заголовок X-Telegram-Bot-Api-Secret-Token = наш секрет)
  → api/bot.ts → lib/telegram-webhook.ts
      сверяет секрет → /start? приветствие : brain.answer()
  → sendMessage обратно в чат
  → функция отвечает Telegram 200 (иначе приедет повтор)
```

Один бот обслуживает неограниченное число чатов: ответ уходит в
`update.message.chat.id` — тот чат, откуда пришло сообщение.

## 5. Смена/снятие webhook

```bash
# перенести на другой URL или сменить секрет — просто вызвать setWebhook заново
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"   # отключить
```

После смены `TELEGRAM_WEBHOOK_SECRET` в env Vercel не забудь redeploy — иначе
все запросы начнут получать 401.
