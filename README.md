# Covskiy Folio

Сайт-визитка: статический MPA на **Vite** + **одна** Vercel Function, которая обслуживает
и вебчат на сайте, и Telegram-бота. Оба канала отвечают одним «мозгом»-справочником:

- если доступен OpenAI-совместимый LLM-endpoint (по умолчанию **Ollama Cloud**,
  локально — **llama.cpp**) — вопрос обрабатывает нейросеть;
- если LLM недоступен — включается **dumb-режим**: поиск по справке (морфология,
  IDF, синонимы `keywords`) без нейросети и без токенов; промах поиска приходит
  с подсказками тем, среди которых гарантированно есть контакты, а помощь
  (`?` в вебчате, `/help` в Telegram) работает в любом режиме.

История диалогов (вебчат и Telegram) живёт на сервере — **Upstash Redis**,
TTL 24 часа; без Redis бот отвечает в stateless-режиме (fail-open).

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
│     ├─ chat-widget.ts                     # UI виджета (кнопка → панель, «печатает…», помощь «?», подсказки)
│     ├─ chat-api.ts                        # клиент /api/chat: sessionId в localStorage, бутстрап (чипсы + помощь)
│     └─ chat.css                           # стили виджета
├─ bot/                                     # СЕРВЕРНАЯ ЛОГИКА (вне api/ — см. docs/architecture.md)
│  ├─ http/                                 # обработчики маршрутов
│  │  ├─ webchat.ts                         # /api/chat (валидация → brain → история)
│  │  ├─ telegram-webhook.ts                # /api/telegram (secret, команды, кнопки)
│  │  └─ telegram-admin.ts                  # /api/telegram-setup (health, промт, вебхук)
│  ├─ telegram-api.ts                       # обёртка Bot API (sendMessage и др.) на fetch
│  ├─ brain/                                # «мозг» + контент
│  │  ├─ brain.ts                           # answer(): LLM (env LLM_TIMEOUT_MS, дефолт 15 c) → dumb (порог env DUMB_SCORE_THRESHOLD, дефолт 0.3; подсказки fallback)
│  │  ├─ search.ts                          # dumb-поиск: rankKnowledge() — нормализация, стемминг, IDF, keywords
│  │  ├─ knowledge.ts                       # хранилище справки: безопасное чтение, uiTopics()
│  │  ├─ help.ts                            # тексты помощи: вебчат (?/help), Telegram /help, запасной
│  │  ├─ prompt.ts                          # сборщик system prompt (md-разделы + справка)
│  │  ├─ knowledge.json                     # ★ СПРАВКА «мозга» — редактируй здесь
│  │  └─ prompts/                           # разделы system prompt (persona, rules, knowledge)
│  ├─ store.ts                              # история диалогов: Upstash Redis REST, fail-open
│  ├─ tests/                                # unit-тесты (Vitest): brain, поиск, помощь, знания, промт, store, webchat, webhook, admin, роутер
│  └─ dev/
│     └─ dev-function.mjs                   # dev-адаптер (замена vercel dev) + заглушка Upstash, не деплоится
├─ api/
│  └─ bot.ts                                # ЕДИНСТВЕННАЯ Vercel Function — роутер по pathname
├─ docs/
│  ├─ architecture.md                       # как всё устроено и почему именно так
│  ├─ manual.md                             # мануал владельца: контент, дебаг, llama.cpp
│  ├─ deploy.md                             # пошаговый деплой: GitHub → Vercel → webhook
│  ├─ local-dev.md                          # локальная разработка, llama.cpp, тесты
│  ├─ telegram.md                           # создание бота и настройка webhook
│  └─ telegram-webhook-runbook.md           # регистрация вебхука (runbook)
├─ tasks/                                   # план рефакторинга (история решений)
├─ .agents/skills/ + skills-lock.json       # официальные агент-скилы Vercel (skills.sh)
├─ AGENTS.md                                # правила для агентов: команды, коммиты, цепочка git
├─ .husky/                                  # pre-commit (format→lint→types→test) + commit-msg (commitlint)
├─ .commitlintrc.json                       # правила сообщений коммитов (Conventional Commits)
├─ .editorconfig                            # единые настройки редакторов (LF, отступы)
├─ .gitattributes                           # LF в репо и при checkout — без LF/CRLF-морганий
├─ .oxlintrc.json / .oxfmtrc.json           # конфиги линтера и форматтера
├─ vercel.json                              # rewrites: /api/chat, /api/telegram, /api/telegram-setup → /api/bot
├─ vite.config.ts                           # MPA-входы + proxy /api для локалки
├─ tsconfig.json                            # строгий TS (фронт + функции + тесты)
├─ .env.example                             # профили llama.cpp / Ollama Cloud + плейсхолдеры Upstash
└─ package.json
```

## Команды

| Команда                | Что делает                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run dev`          | vite dev-сервер (5173). Для `/api` параллельно нужен `npm run dev:function` — см. `docs/local-dev.md` |
| `npm run dev:function` | локальная функция на node:http (3000): замена сломанного `vercel dev` — см. `docs/local-dev.md`       |
| `npm run build`        | прод-сборка MPA в `dist/`                                                                             |
| `npm run test`         | unit-тесты (Vitest, без сети — fetch подменяется)                                                     |
| `npm run typecheck`    | строгая проверка типов (`tsc --noEmit`)                                                               |
| `npm run lint`         | oxlint (Rust-линтер из oxc) по коду проекта                                                           |
| `npm run format`       | oxfmt — форматирование всех файлов                                                                    |
| `npm run format:check` | проверка форматирования (часть pre-commit хука husky)                                                 |

## Коммиты

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, …) — проверяет commitlint
в хуке `commit-msg`. Pre-commit husky перед каждым коммитом сам гоняет
`format:check → lint → typecheck → test`. Пуш — только по согласованию.

## Переменные окружения

Задаются на Vercel (Settings → Environment Variables / `vercel env add`) и опционально
в `.env.local` для локалки. Шаблон — в `.env.example`.

| Переменная                 | Зачем                                                             | Пример (прод)            |
| -------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `LLM_BASE_URL`             | база OpenAI-совместимого API, к ней добавится `/chat/completions` | `https://ollama.com/v1`  |
| `LLM_API_KEY`              | Bearer-токен (для llama.cpp не нужен)                             | ключ из ollama.com       |
| `LLM_MODEL`                | имя модели                                                        | `gpt-oss:20b`            |
| `UPSTASH_REDIS_REST_URL`   | REST-эндпоинт Upstash Redis (память диалогов)                     | `https://….upstash.io`   |
| `UPSTASH_REDIS_REST_TOKEN` | Bearer-токен того же REST API                                     | длинный токен из Upstash |
| `TELEGRAM_BOT_TOKEN`       | токен бота от @BotFather                                          | `123456:ABC-…`           |
| `TELEGRAM_WEBHOOK_SECRET`  | секрет для проверки запросов webhook                              | длинная случайная строка |

Без `LLM_*` проект полностью работоспособен — просто всегда отвечает dumb-режимом.
Без `UPSTASH_*` — тоже, но без памяти диалога (stateless, fail-open). База Upstash,
созданная через Vercel Marketplace, приезжает парой `KV_REST_API_URL`/`KV_REST_API_TOKEN`
— store.ts понимает оба семейства имён (см. `.env.example`).

## Обновление справки

Справка — [`bot/brain/knowledge.json`](bot/brain/knowledge.json) (массив
`{id, title, text, keywords?, contact?, chip?, about?}` — контракт полей в
[docs/manual.md](docs/manual.md),
раздел «Правки контента»),
system prompt — [`bot/brain/prompts/`](bot/brain/prompts). Поменял текст → `git push` →
автодеплой → и сайт, и бот отвечают по-новому. Синонимы для dumb-поиска —
`keywords`: вопрос стабильно не находится — сначала добавь синоним, а не правь
алгоритм (`bot/brain/search.ts`). История диалогов живёт в
Upstash Redis и на контент не влияет: она истечёт по TTL сама (24 часа) или
очистится командой `/reset`.

## Дальше

- Мануал владельца (контент, дебаг, llama.cpp) — [docs/manual.md](docs/manual.md)
- Как это работает внутри — [docs/architecture.md](docs/architecture.md)
- Первый деплой — [docs/deploy.md](docs/deploy.md)
- Локалка и llama.cpp — [docs/local-dev.md](docs/local-dev.md)
- Telegram-бот — [docs/telegram.md](docs/telegram.md)
