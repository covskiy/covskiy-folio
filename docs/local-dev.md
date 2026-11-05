# Локальная разработка

> Полный мануал владельца — включая подробную инструкцию по llama.cpp — в
> [manual.md](manual.md).

## Два процесса

Статика и функции разрабатываются разными серверами, а vite их склеивает прокси.
Для повседневной работы функция поднимается dev-адаптером:

| Процесс                | Порт | Что даёт                                                              |
| ---------------------- | ---- | --------------------------------------------------------------------- |
| `npm run dev`          | 5173 | vite dev: HMR фронтенда; `/api` проксирует на 3000 (`vite.config.ts`) |
| `npm run dev:function` | 3000 | функция локально: tsc `api/` + `bot/`, контент, env из `.env.local`   |

```bash
# терминал 1
npm run dev:function             # замена сломанного vercel dev (см. ниже)
# терминал 2
npm run dev                      # открыть http://localhost:5173
```

> `vercel dev` на этой машине не работает — три проверенные грабли:
>
> 1. CLI в неэлевированном процессе падает с `EPERM: symlink` в кэше билдеров —
>    лечится включением Windows Developer Mode (Параметры → Для разработчиков).
> 2. Виртуальные диски (RAM-диск ImDisk, subst): CLI вызывает `fs.realpath.native`
>    — обёртку libuv над `GetFinalPathNameByHandle`, которая на таких томах не
>    работает ни для одного пути (проверено: падает даже на файле), с `EISDIR`.
> 3. Даже на физическом диске с Developer Mode CLI v65 (нативный бинарник)
>    роутит иначе, чем прод-edge: rewrite из `vercel.json` до функции не
>    доводится — путь, не совпадающий с файлом в `api/` (как `/api/chat`),
>    уезжает в заспавненный vite. Прокси автономного vite (`/api → :3000`)
>    при этом замыкает петлю vercel → vite → vercel: заголовки `x-vercel-*`
>    растут с каждым кругом до 431, POST с телом роняет обвязку
>    (`read ECONNRESET`). Итог: страницы открываются, API не работает —
>    функция доступна только по собственному пути `/api/bot`. Поэтому
>    `vite.config.ts` включает прокси только вне vercel dev (детектор — env
>    `PORT`). Остальной тулчейн (vite, tsc, vitest, git) нативный realpath
>    не зовёт — на виртуальных дисках работает.

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
npm run typecheck     # строгие типы: src + api + bot
npm run test          # Vitest: сеть подменена (fetch = vi.fn)
npm run build         # прод-сборка MPA в dist/
```

Тесты (`bot/tests/`) не ходят в сеть: глобальный `fetch` подменяется через
`vi.stubGlobal`, LLM и Telegram Bot API имитируются фикс-ответами. Поэтому
«падение LLM → dumb-режим» и «ошибка Telegram не роняет webhook» покрыты юнитами.

## Проверка функции без Vercel (опционально)

Функция — это просто объект с `fetch(request)`. Чтобы проверить её так, как её
запускает Vercel (нативный ESM-лоадер, без бандлера), оттранслируй серверные файлы
и загрузи нативно:

```bash
npx tsc --ignoreConfig api/bot.ts bot --outDir .tmp/sim \
  --module nodenext --moduleResolution nodenext --target es2022 \
  --lib es2022,dom,dom.iterable --skipLibCheck
printf '{"type":"module"}' > .tmp/sim/package.json
node --env-file=.env.local -e "import('./.tmp/sim/api/bot.js').then(h => h.default.fetch(new Request('http://x/api/chat'))).then(r => r.text()).then(console.log)"
```

Именно нативная загрузка (а не `esbuild --bundle`, который всё склеивает) ловит
главный грабль — забытые расширения `.js` в относительных импортах `api/` и `bot/`.

Для полноценной локальной отладки используй `npm run dev:function` (раздел ниже) —
ручная симуляция остаётся как одноразовая проверка без сервера.

## Dev-адаптер функции (`npm run dev:function`)

Основной способ поднять функцию локально — адаптер `bot/dev/dev-function.mjs`
(вне `api/`, не деплоится); `vercel dev` на этой машине не работает — примечание
в начале файла и [tasks/01-refactor-plan.md](../tasks/01-refactor-plan.md) →
«Локальные грабли»:

```bash
# терминал 1
npm run dev:function             # node:http на 3000
# терминал 2
npm run dev                      # открыть http://localhost:5173
```

Адаптер сам, на каждом старте:

1. компилирует `api/bot.ts` (+ подтянутые импортами `bot/`) в `.tmp/dev-function`
   нативным tsc — та же нативная ESM-загрузка, что и на Vercel, ловит забытые
   `.js`-расширения;
2. копирует в скомпилированный `bot/` контент — `knowledge.json` и `prompts/`
   (tsc за собой json/md не тянет, без копии `prompt.ts` упадёт ENOENT);
3. подхватывает `.env.local`, если он есть (уже выставленные переменные не
   перекрывает); нет файла — просто пустые env (сработает fail-open store /
   dumb-режим brain);
4. слушает `127.0.0.1:3000` и на каждый запрос вызывает `default.fetch`,
   конвертируя node req ↔ Request / Response ↔ node res; ошибка обработчика —
   500 и лог в консоль сервера.

Порт меняется переменной `DEV_FUNCTION_PORT` (по умолчанию 3000 — под vite proxy).
Ручная симуляция из раздела выше остаётся как одноразовая проверка без сервера.

## Заглушка Upstash (история без облака)

Ручные тесты не обязаны тратить запросы реального Redis. В `.env.local`:

```env
UPSTASH_REDIS_REST_URL=http://upstash.fake
UPSTASH_REDIS_REST_TOKEN=fake
```

Адаптер увидит адрес `upstash.fake` и подменит `fetch` для него: команды
`get/set/del/ping/ttl` уходят в память процесса (трафик виден в консоли как
`[dev-function][fake-upstash] …`), до облака ничего не долетает — функция в
`bot/store.ts` при этом не меняется. История переживает перезагрузку страницы,
но не рестарт адаптера — осознанный компромисс заглушки. Вернуться на реальный
Redis: раскомментировать `KV_REST_API_URL/TOKEN` и убрать пару выше.
