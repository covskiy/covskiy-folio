# Регистрация Telegram-вебхука (runbook)

api.telegram.org у провайдера заблокирован (РКН), поэтому вебхук ставится через
админ-маршрут на проде: запрос к vercel.app, а Telegram API функция дёргает
со своей стороны. Обработчик — `lib/telegram-admin.ts` (логи с префиксом
`[telegram-admin]`), задеплоен в коммите `3af0340`.

Нюанс сети: vercel.app из локальной сети режется недетерминированно (RST на
TLS у большинства соединений, иногда прорывается). Команды ниже ретраить,
пока не пройдёт.

## Секрет

Значение `TELEGRAM_WEBHOOK_SECRET` лежит в `.env.local` (в git не попадает).
В команды руками не вставлять и нигде не печатать — curl-вариант читает сам.

## 1. Регистрация (POST setWebhook)

```bash
cd /c/IT/covskiy-folio
SECRET=$(sed -n 's/^TELEGRAM_WEBHOOK_SECRET=//p' .env.local | head -n1 | sed -e 's/\r$//' -e 's/^"//' -e 's/"$//')

curl -sS -X POST https://covskiy-folio.vercel.app/api/telegram-setup \
  -H "x-telegram-bot-api-secret-token: $SECRET"
```

Ожидаемо: `{"ok":true,"result":true}`

## 2. Проверка (GET getWebhookInfo)

```bash
curl -sS https://covskiy-folio.vercel.app/api/telegram-setup \
  -H "x-telegram-bot-api-secret-token: $SECRET"
```

Ожидаемо: `"url":"https://covskiy-folio.vercel.app/api/telegram"`,
`last_error_message` отсутствует.

## Вариант REST Client (VS Code)

```http
### Регистрация вебхука
POST https://covskiy-folio.vercel.app/api/telegram-setup
x-telegram-bot-api-secret-token: <ЗНАЧЕНИЕ_ИЗ_.env.local>

### Проверка
GET https://covskiy-folio.vercel.app/api/telegram-setup
x-telegram-bot-api-secret-token: <ЗНАЧЕНИЕ_ИЗ_.env.local>
```

Файл с вклеенным секретом не коммитить (`.gitignore` закрывает только `.env*`).

## 3. Сквозная проверка

Написать боту `/start` в Telegram. В панели Vercel (проект → Logs; на Hobby
retention 1 час — смотреть сразу) появятся:

```
[telegram-admin] getWebhookInfo: {...}
[telegram-webhook] апдейт от <chat_id>: /start
[telegram-webhook] ответ отправлен в <chat_id>
```

## Диагностика по ответам

| Ответ                                           | Причина                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| 404 `{"ok":false,"error":"Not Found"}`          | Секрет не совпал или не задан (какой случай — видно по warn/error в логе) |
| 502 с `"error":"Telegram setWebhook failed: …"` | До Telegram достучались, но API ответил ошибкой — текст в теле и в логе   |
| Connection reset / timeout                      | Блокировка на пути — ретраить, это не ошибка маршрута                     |

## Если не прорваться вообще

Прокси-клиент (socks5 на 127.0.0.1:8734, мост на 8735) шлёт vercel.app в
direct — проверено и на домене, и на IP. Нужно добавить в клиенте правило
домена `vercel.app` → через прокси (или включить глобальный режим), затем:

```bash
curl -sS -x socks5h://127.0.0.1:8734 -X POST https://covskiy-folio.vercel.app/api/telegram-setup \
  -H "x-telegram-bot-api-secret-token: $SECRET"
```
