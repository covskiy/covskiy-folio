# Covskiy Folio

Сайт-визитка: статический MPA на **Vite** + **одна** Vercel Function, которая обслуживает
и вебчат на сайте, и Telegram-бота. Оба канала отвечают одним «мозгом»-справочником:

- если доступен OpenAI-совместимый LLM-endpoint (по умолчанию **Ollama Cloud**,
  локально — **llama.cpp**) — вопрос обрабатывает нейросеть;
- если LLM недоступен — включается **dumb-режим**: детерминированный поиск по
  параграфам справки, без нейросети и без токенов.

## Дерево проекта

```
covskiy-folio/
├─ index.html / about.html / contacts.html  # страницы MPA (входные точки Vite)
├─ public/
│  └─ favicon.svg                           # статика, копируется в dist как есть
├─ src/                                     # ФРОНТ (собирается Vite)
│  ├─ main.ts                               # вход: стили, год в футере, монтирование чата
│  ├─ style.css                             # стили страниц
│  ├─ vite-env.d.ts                         # типы Vite (импорт css и т.п.)
│  └─ chat/
│     ├─ chat-widget.ts                     # UI виджета (кнопка → панель, «печатает…»)
│     ├─ chat-api.ts                        # клиент /api/chat: история в localStorage
│     └─ chat.css                           # стили виджета
├─ lib/                                     # СЕРВЕРНАЯ ЛОГИКА (вне api/ — см. docs/architecture.md)
│  ├─ knowledge.ts                          # ★ СПРАВКА «мозга» — редактируй здесь
│  ├─ brain.ts                              # answer(): LLM (timeout 15 c) → fallback dumb
│  ├─ webchat.ts                            # обработчик /api/chat (валидация → brain)
│  ├─ telegram-webhook.ts                   # обработчик /api/telegram (secret, /start)
│  └─ telegram-api.ts                       # обёртка Bot API (sendMessage) на fetch
├─ api/
│  └─ bot.ts                                # ЕДИНСТВЕННАЯ Vercel Function — роутер по pathname
├─ tests/                                   # unit-тесты (Vitest): brain, webchat, webhook, роутер
├─ docs/
│  ├─ architecture.md                       # как всё устроено и почему именно так
│  ├─ deploy.md                             # пошаговый деплой: GitHub → Vercel → webhook
│  ├─ local-dev.md                          # локальная разработка, llama.cpp, тесты
│  └─ telegram.md                           # создание бота и настройка webhook
├─ .agents/skills/ + skills-lock.json       # официальные агент-скилы Vercel (skills.sh)
├─ vercel.json                              # rewrites: /api/chat и /api/telegram → /api/bot
├─ vite.config.ts                           # MPA-входы + proxy /api для локалки
├─ tsconfig.json                            # строгий TS (фронт + функции + тесты)
├─ .env.example                             # профиль llama.cpp / Ollama Cloud
└─ package.json
```

## Команды

| Команда                | Что делает                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `npm run dev`          | vite dev-сервер (5173). Для `/api` параллельно нужен `vercel dev` — см. `docs/local-dev.md` |
| `npm run build`        | прод-сборка MPA в `dist/`                                                                   |
| `npm run test`         | unit-тесты (Vitest, без сети — fetch подменяется)                                           |
| `npm run typecheck`    | строгая проверка типов (`tsc --noEmit`)                                                     |
| `npm run lint`         | oxlint (Rust-линтер из oxc) по коду проекта                                                 |
| `npm run format`       | oxfmt — форматирование всех файлов                                                          |
| `npm run format:check` | проверка форматирования (часть pre-commit хука husky)                                       |

## Переменные окружения

Задаются на Vercel (Settings → Environment Variables / `vercel env add`) и опционально
в `.env.local` для локалки. Шаблон — в `.env.example`.

| Переменная                | Зачем                                                             | Пример (прод)            |
| ------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `LLM_BASE_URL`            | база OpenAI-совместимого API, к ней добавится `/chat/completions` | `https://ollama.com/v1`  |
| `LLM_API_KEY`             | Bearer-токен (для llama.cpp не нужен)                             | ключ из ollama.com       |
| `LLM_MODEL`               | имя модели                                                        | `gpt-oss:20b`            |
| `TELEGRAM_BOT_TOKEN`      | токен бота от @BotFather                                          | `123456:ABC-…`           |
| `TELEGRAM_WEBHOOK_SECRET` | секрет для проверки запросов webhook                              | длинная случайная строка |

Без `LLM_*` проект полностью работоспособен — просто всегда отвечает dumb-режимом.

## Обновление справки

Весь «интеллект» бота и чата описан текстом в [`lib/knowledge.ts`](lib/knowledge.ts):
поменял параграфы → `git push` → автодеплой → и сайт, и бот отвечают по-новому.

## Дальше

- Как это работает внутри — [docs/architecture.md](docs/architecture.md)
- Первый деплой — [docs/deploy.md](docs/deploy.md)
- Локалка и llama.cpp — [docs/local-dev.md](docs/local-dev.md)
- Telegram-бот — [docs/telegram.md](docs/telegram.md)
