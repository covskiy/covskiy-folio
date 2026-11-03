# Деплой: GitHub → Vercel → Telegram webhook

Пошагово от нуля до работающего продакшена. Команды — из корня проекта.

## 0. Предпосылки

- Аккаунты [GitHub](https://github.com) и [Vercel](https://vercel.com) (Hobby-план бесплатен).
- Node.js 20+ локально.

## 1. Репозиторий на GitHub

```bash
git init -b main                # если репо ещё не инициализирован
git add .
git commit -m "initial: vite mpa + vercel function (webchat + telegram bot)"
```

Создать репо и запушить — либо на github.com вручную (New repository → … →
`git remote add origin …` → `git push -u origin main`), либо через GitHub CLI:

```bash
gh repo create covskiy-folio --private --source=. --push
```

## 2. Проект на Vercel

```bash
npx vercel login                # авторизация через браузер
```

Дальше — рекомендуемый путь (автодеплой на каждый push):

1. [vercel.com/new](https://vercel.com/new) → Import Git Repository → выбрать `covskiy-folio`.
2. Framework Preset определится сам (**Vite**), Build Command `vite build`, Output `dist` — не трогать.
3. **Deploy** — первый деплой можно сделать сразу, переменные добавим следом.

Альтернатива без дашборда: `npx vercel link` → `npx vercel --prod`.

## 3. Переменные окружения

На Vercel (Project → Settings → Environment Variables) или через CLI:

```bash
npx vercel env add LLM_BASE_URL production        # https://ollama.com/v1
npx vercel env add LLM_API_KEY production         # ключ из ollama.com
npx vercel env add LLM_MODEL production           # например gpt-oss:20b
npx vercel env add TELEGRAM_BOT_TOKEN production  # токен от @BotFather
npx vercel env add TELEGRAM_WEBHOOK_SECRET production
```

После добавления переменных сделай **Redeploy** (Deployments → ⋯ → Redeploy),
чтобы они попали в работающую функцию.

> Секретные значения не должны попадать в git: в репозитории только `.env.example`.

## 4. Webhook Telegram

После деплоя у проекта есть URL вида `https://covskiy-folio.vercel.app`.
Регистрируем webhook (секрет должен совпадать с `TELEGRAM_WEBHOOK_SECRET` из шага 3):

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://covskiy-folio.vercel.app/api/telegram" \
  --data-urlencode "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Ожидаемый ответ: `{"ok":true,"result":true,"description":"Webhook was set"}`.
Проверка: `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo` —
`url` задан, `last_error_message` отсутствует.

Подробности про бота — [telegram.md](telegram.md).

## 5. Проверка продакшена

- `https://<project>.vercel.app/` — открывается сайт; чат в правом нижнем углу
  отвечает (бейдж «офлайн-справка», если LLM ещё не настроен).
- `https://<project>.vercel.app/api/chat` (GET) → `{"ok":true,"service":"webchat"}`.
- Написать боту в Telegram `/start` → приветствие; вопрос → ответ.
- Логи функции: `npx vercel logs <deployment-url>` или дашборд → Observability.

## Обычный цикл разработки

```bash
git add . && git commit -m "…" && git push
# → Vercel собирает и деплоит автоматически; PR'ы получают preview-URL
```

Обновил справку в `lib/knowledge.ts` — просто пуш: сайт и бот отвечают по-новому.

## Если что-то не так

| Симптом                       | Где смотреть                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------- |
| 401 на webhook                | совпадает ли `TELEGRAM_WEBHOOK_SECRET` с secret_token в setWebhook                |
| Бот молчит                    | `getWebhookInfo` → `last_error_message`; логи функции в дашборде                  |
| Чат отвечает «офлайн-справка» | env `LLM_*` заданы? redeploy после добавления? endpoint доступен?                 |
| Сборка упала                  | вкладка Build в Vercel: локально повторяется `npm run build && npm run typecheck` |
