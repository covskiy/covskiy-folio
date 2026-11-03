# Локальная разработка

## Два процесса

Статика и функции разрабатываются разными серверами, а vite их склеивает прокси:

| Процесс                        | Порт | Что даёт                                                              |
| ------------------------------ | ---- | --------------------------------------------------------------------- |
| `npm run dev`                  | 5173 | vite dev: HMR фронтенда; `/api` проксирует на 3000 (`vite.config.ts`) |
| `npx vercel dev --listen 3000` | 3000 | Vercel Functions локально + env из связанного проекта                 |

```bash
# терминал 1
npx vercel dev --listen 3000     # требуется `npx vercel link` один раз
# терминал 2
npm run dev                      # открыть http://localhost:5173
```

> На Windows (Win10 + Git Bash) `vercel dev` падает с `EISDIR: illegal operation
> on a directory, realpath '<проект>'`. Тогда функция проверяется юнит-тестами и
> симуляцией из раздела ниже, а сквозняк — на preview/прод-деплое.

Env для локалки: `npx vercel env pull .env.local` (подтягивает переменные проекта
из Vercel; команда **перезаписывает** файл — свои локальные правки вноси после pull).

## llama.cpp вместо Ollama Cloud (без траты токенов)

LLM-endpoint настраивается переменными, поэтому локально удобнее дешёвый/бесплатный
вариант — llama.cpp с OpenAI-совместимым сервером:

```bash
llama-server -m model.gguf --port 8080
```

`.env.local` (создай из `.env.example`):

```env
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_API_KEY=none
LLM_MODEL=my-model
```

Полезный побочный эффект: останови `llama-server` — и brain по таймауту уйдёт
в dumb-режим. Так fallback тестируется честно, без правок кода.

> `localhost` в `.env.local` работает только локально: в облаке Vercel твоего
> llama-server нет. Прод-значения (`https://ollama.com/v1`) живут отдельно
> в env Vercel — среды изолированы.

## Проверки

```bash
npm run typecheck     # строгие типы: src + api + lib + tests
npm run test          # Vitest: сеть подменена (fetch = vi.fn)
npm run build         # прод-сборка MPA в dist/
```

Тесты (`tests/`) не ходят в сеть: глобальный `fetch` подменяется через
`vi.stubGlobal`, LLM и Telegram Bot API имитируются фикс-ответами. Поэтому
«падение LLM → dumb-режим» и «ошибка Telegram не роняет webhook» покрыты юнитами.

## Проверка функции без Vercel (опционально)

Функция — это просто объект с `fetch(request)`. Чтобы проверить её так, как её
запускает Vercel (нативный ESM-лоадер, без бандлера), оттранслируй серверные файлы
и загрузи нативно:

```bash
npx tsc --ignoreConfig api/bot.ts lib --outDir .tmp/sim \
  --module nodenext --moduleResolution nodenext --target es2022 \
  --lib es2022,dom,dom.iterable --skipLibCheck
printf '{"type":"module"}' > .tmp/sim/package.json
node --env-file=.env.local -e "import('./.tmp/sim/api/bot.js').then(h => h.default.fetch(new Request('http://x/api/chat'))).then(r => r.text()).then(console.log)"
```

Именно нативная загрузка (а не `esbuild --bundle`, который всё склеивает) ловит
главный грабль — забытые расширения `.js` в относительных импортах `api/` и `lib/`.

Для полноценной локальной отладки удобнее `vercel dev` — если он работает
(см. замечание в начале файла).
