# AGENTS.md — правила работы с этим репозиторием

## Что за проект

Сайт-визитка: статический MPA на **Vite** + **одна** Vercel Function (`api/bot.ts`),
обслуживающая вебчат на сайте и Telegram-бота единым «мозгом»-справочником.
LLM — упорядоченная цепочка OpenAI-совместимых провайдеров (`LLM_1_*`…`LLM_9_*`:
fallback на любую ошибку, общий бюджет времени, cooldown упавшего слота); при
недоступности всех — dumb-поиск по справке. Без БД.
Полная архитектура — [docs/architecture.md](docs/architecture.md).

## Команды

| Команда                | Зачем                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `npm run dev`          | vite (5173), `/api` → proxy на 3000                                |
| `npm run dev:function` | функция локально на 3000 (адаптер `bot/dev/`, env из `.env.local`) |
| `npm run build`        | прод-сборка MPA в `dist/`                                          |
| `npm run test`         | Vitest (сеть подменена моками)                                     |
| `npm run typecheck`    | `tsc --noEmit` (strict)                                            |
| `npm run lint`         | oxlint                                                             |
| `npm run format`       | oxfmt --write                                                      |

## Хуки git (husky)

- **pre-commit**: `format:check → lint → typecheck → test`. Если упало — чинить,
  а не обходить (`--no-verify` не использовать без явной просьбы пользователя).
- **commit-msg**: commitlint, Conventional Commits —
  `feat|fix|perf|revert|docs|style|chore|refactor|test|build|ci: описание`.

## Коммиты и публикация

- Пушить **только по явному подтверждению пользователя**.
- Цепочка: рабочая копия → `origin` (локальный bare `D:/Code/bare-rep/covskiy-folio.git`)
  → GitHub. bare → GitHub — по HTTPS (Git Credential Manager):

  ```bash
  git push origin main
  git --git-dir="D:/Code/bare-rep/covskiy-folio.git" push origin main
  ```

- Основная ветка — `main`.

## Секреты

- `.env*` в git не попадают; секреты — только в env Vercel или локальном `.env.local`.
- Не выводить в чат/логи значения `TELEGRAM_BOT_TOKEN`, `LLM_n_API_KEY`, `TELEGRAM_WEBHOOK_SECRET`.

## Код

- TypeScript strict; форматтер — **oxfmt** (не prettier), линтер — **oxlint** (не eslint);
  конфиги в корне (`.oxfmtrc.json`, `.oxlintrc.json`).
- Файлы — LF (`.gitattributes`, `.editorconfig`); не менять переводы строк руками.
- Комментарии объясняют «почему», а не «что»; пользовательские тексты — по-русски.
- Контент справки бота правится в `bot/brain/knowledge.json` (промт — в
  `bot/brain/prompts/*.md`), не в коде `bot/brain/brain.ts`. Dumb-поиск живёт в
  `bot/brain/search.ts` (порог и подсказки — в `brain.ts`): вопрос не находится —
  сначала добавь синоним в `keywords` записи, не правь алгоритм. Тексты помощи
  (вебчат `?`/`/help`, Telegram `/help`) — только в `bot/brain/help.ts`.
- Функция одна: `api/bot.ts` — только роутер по pathname; новая логика — в `bot/`,
  новый маршрут — ветка switch + обработчик в `bot/` (+ rewrites в `vercel.json`).
- Относительные импорты в `api/` и `bot/` — **только с расширением `.js`** (`"./brain.js"`).
  Сервер живёт в нативном ESM (`"type": "module"`): Vercel грузит функцию голым
  Node-лоадером и без расширения падает с 500 `ERR_MODULE_NOT_FOUND`. Локально
  vite/vitest/tsc расширение прощают — прод-ошибку локальными проверками не поймать.
- `process` в серверном коде — только через `import process from "node:process"`,
  не как глобал (типы не должны зависеть от резолва `types` в tsconfig).
- Общий серверный код держим **вне `api/`** (Vercel деплоит каждый файл `api/` как отдельную функцию).
- Тесты не ходят в сеть: `fetch` подменяется через `vi.stubGlobal` (см. `bot/tests/`).

## Платформа (Vercel)

- Hobby-план, Fluid compute; функции в корневом `api/`, `vercel.json` — только rewrites.
- Env: слоты `LLM_1_*`…`LLM_9_*` (`ID`, `KIND`, `BASE_URL`, `API_KEY`, `MODEL`,
  `TIMEOUT_MS`; номер = порядок попыток), Redis — пара `UPSTASH_REDIS_REST_*`
  или `KV_REST_API_URL/TOKEN` от интеграции Marketplace (store.ts понимает оба
  семейства), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; опционально
  `LOG_LEVEL` (дефолт warn — `bot/log.ts`), `LLM_TIMEOUT_MS`/`LLM_MAX_TOKENS`
  (дефолт 15000/1024 — `bot/config.ts`), `LLM_TOTAL_TIMEOUT_MS`/`LLM_COOLDOWN_MS`
  (дефолт 20000/60000 — `bot/config.ts`), `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_SECONDS`
  (дефолт 15/3600 — `bot/rate-limit.ts`), `HISTORY_WINDOW`/`DUMB_SCORE_THRESHOLD`
  (дефолт 10/0.3 — `bot/brain/brain.ts`), `HISTORY_TTL_SECONDS` (дефолт 86400 —
  `bot/store.ts`), `TELEGRAM_SEEN_TTL_SECONDS` (дефолт 3600 — `bot/http/telegram-webhook.ts`).
  Env запекается в деплой: после правки переменных — Redeploy; `.env.local` наверх
  не синхронизируется (значения — `vercel env add` или дашборд). Грабли платформы —
  [docs/architecture.md](docs/architecture.md) → «Грабли платформы».
- Установлены официальные агент-скилы Vercel: `.agents/skills/` (source `vercel-labs/agent-skills`,
  зафиксировано в `skills-lock.json`). Каталоги `agent/`, `.zcode/`, `.claude/` — производные,
  в git не ходят.
