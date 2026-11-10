# 05 — LLM: цепочка провайдеров, fallback и cooldown

Статус: **черновик задачи, ничего не реализовано**.
Дата: 2026-11-10.
Основание: разбор `bot/llm.ts`, `bot/config.ts`, `bot/http/telegram-admin.ts`,
`bot/tests/llm.test.ts`, `bot/tests/config.test.ts`, `docs/architecture.md`,
`docs/manual.md`, `.env.example`, `AGENTS.md` + обсуждение с владельцем.
Внешняя сверка: Cloudflare Workers AI, OpenAI-compatible endpoints
(`https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/`).
Уточнено после обсуждения: слоты `LLM_1_*`…`LLM_9_*`, единая директория
`bot/llm/` с `index.ts`, типы слайса в `config.ts`, `README.md` обновляем,
`tasks/checklist-pre-final-testing.md` не трогаем.

Цель — заменить единственный OpenAI-совместимый endpoint на упорядоченную
цепочку провайдеров с автоматическим fallback, общим бюджетом времени и
запоминанием недоступного провайдера в тёплом инстансе. Добавление нового
OpenAI-совместимого провайдера должно быть настройкой env, а не правкой кода.

## Сводка

| №   | Приоритет | Тема                                               | Основные файлы                                   |
| --- | --------- | -------------------------------------------------- | ------------------------------------------------ |
| 1   | P0        | Конфиг: `LLM_1_*`…`LLM_9_*` вместо одного `LLM_*`  | `bot/config.ts`, `bot/tests/config.test.ts`      |
| 2   | P0        | Вынести OpenAI-совместимый адаптер из `bot/llm.ts` | `bot/llm/*`, `bot/llm/index.ts`                  |
| 3   | P0        | Цепочка fallback + общий дедлайн                   | `bot/llm/index.ts`, `bot/tests/llm.test.ts`      |
| 4   | P0        | Circuit breaker с cooldown в тёплом инстансе       | `bot/llm/index.ts`, `bot/tests/llm.test.ts`      |
| 5   | P0        | Health по каждому провайдеру + `issues`            | `bot/llm/index.ts`, `bot/http/telegram-admin.ts` |
| 6   | P1        | Обновить документацию и `.env.example`             | `docs/*`, `.env.example`, `AGENTS.md`            |
| 7   | P1        | Проверки: format, lint, typecheck, test            | весь проект                                      |

За пределами задачи: streaming, векторный поиск, балансировка по latency,
hedged requests, общий cooldown в Redis, нативные протоколы Cloudflare
(`/ai/run`) и Anthropic.

---

## Контекст: что сейчас не так

`bot/llm.ts` — единственный транспорт LLM. Он умеет ровно один endpoint:
читает `config.llm` (`baseUrl`, `apiKey`, `model`, `timeoutMs`, `maxTokens`) и
ходит на `${baseUrl}/chat/completions`. Любая ошибка — сеть, таймаут, не-2xx,
пустой ответ — уходит в `brain.answer`, который логирует причину и отвечает
dumb-режимом по справке.

Проблемы:

- **Один провайдер.** Падение Ollama Cloud / Cloudflare / любого endpoint сразу
  переводит бота в dumb-режим, хотя рядом может быть живой запасной.
- **Нет понятия «порядок провайдеров».** env описывает один endpoint, добавить
  второй без правки кода нельзя.
- **Нет общего бюджета времени.** Если попыток станет несколько, каждая может
  съесть свой таймаут, и пользователь будет ждать `N × LLM_TIMEOUT_MS`.
- **Health показывает только один LLM.** Не видно, какой провайдер упал, а
  какой ответил.
- **Мёртвый primary стоит таймаута на каждом запросе.** В тёплом инстансе
  Vercel это особенно заметно: пока primary лежит, каждый вопрос сначала ждёт
  его таймаут, потом идёт к запасному.

Cloudflare Workers AI отдаёт OpenAI-совместимый Chat Completions:
`https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions`,
`Authorization: Bearer <API_TOKEN>`, стандартный `choices[0].message.content`.
Поэтому сторонний npm-пакет не нужен: Cloudflare подключается как обычный
OpenAI-совместимый провайдер.

## Решения владельца

1. **Ломать совместимость можно** — проект ещё не опубликован. Старые
   `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` не поддерживаем, миграционных
   алиасов не делаем.
2. **Env — нумерованные слоты** `LLM_1_*`, `LLM_2_*`, …; порядок номеров =
   порядок попыток.
3. **Fallback — на любую ошибку**: сеть, таймаут, не-2xx, пустой ответ,
   битый JSON. Плюс общий дедлайн на весь `chat()`.
4. **Health — список провайдеров** с `id/ok/latencyMs/detail/error` и
   агрегатом `ok`.
5. **Cooldown — circuit breaker в тёплом инстансе.** Упавший провайдер
   пропускается на `LLM_COOLDOWN_MS`, затем снова пробуется первым. Если все
   провайдеры в cooldown — пробуем всех (half-open), чтобы не было полного
   простоя.
6. **Cooldown в Redis не делаем.** Для визитки это лишняя зависимость и
   задержка; состояние в памяти инстанса даёт нужный эффект.
7. **SDK не добавляем.** Только `fetch`, как сейчас.
8. **AI Gateway не обязателен.** Его встроенные fallbacks относятся к
   Universal endpoint, а не к OpenAI-совместимому `/v1`; цепочка живёт в коде.
   AI Gateway при желании можно указать просто как `baseUrl`.
9. **Слоты нумеруются 1…9.** `n = 0` и `n > 9` — ошибка конфига (`issues`),
   слот не используется: опечатка не должна молча менять цепочку.
10. **Типы слайса — в `bot/config.ts`** (`LlmProviderSettings`,
    `LlmProviderKind`, `LlmSettings`), контракты адаптера — в
    `bot/llm/types.ts`; config не импортирует ничего из `bot/`.
11. **Одна директория `bot/llm/`**: фасад — `index.ts`, рядом `types.ts` и
    `openai.ts`. Импорты явные — `../llm/index.js`; плоский файл рядом с
    одноимённой папкой не используем.
12. **`README.md` обновляем** (таблица env описывает изменившийся контракт);
    `tasks/checklist-pre-final-testing.md` — исторический чек-лист, не трогаем.

---

## Архитектура

### Модули

```
bot/config.ts              — парсинг LLM_1_*…LLM_9_*; типы слайса и issues
bot/llm/index.ts           — фасад: createLlm() → цепочка, cooldown, health
bot/llm/types.ts           — контракты адаптера: LlmAdapter, LlmProbe, LlmMessage
bot/llm/openai.ts          — OpenAI-совместимый адаптер (chat + probe), fetch
```

`bot/llm.ts` переезжает в директорию: `bot/llm/index.ts` — фасад, рядом
`types.ts` и `openai.ts`. Плоский файл + одноимённая папка не используем:
в нативном ESM каталог не резолвится в `index.js`, а соседство файла с
каталогом — скрытая ловушка для следующей правки. Импорт становится явным:
`../llm/index.js` (в тестах — `../llm/index`). Затронуто пять мест:
`bot/brain/brain.ts`, `bot/http/telegram-admin.ts`, `bot/tests/llm.test.ts`,
`bot/tests/brain.test.ts`, `bot/tests/telegram-admin.test.ts`.

Публичный контракт `createLlm()` не меняется: `{ chat, ping }`; `LlmMessage` и
`LlmPing` реэкспортируются из `bot/llm/index.ts`, поэтому потребители не
переписываются. `bot/http/webchat.ts` и `bot/http/telegram-webhook.ts`
импортируют `brain.js`, а не LLM-транспорт, и не меняются вовсе;
`bot/http/telegram-admin.ts` — только тип `ping`.

### Типы

```ts
export type LlmProviderKind = "openai"; // ключ реестра адаптеров; пока один

export interface LlmProviderSettings {
  id: string; // "cloudflare", "backup"; для логов и health
  kind: LlmProviderKind;
  baseUrl: string; // без хвостовых слэшей
  apiKey?: string;
  model: string;
  timeoutMs: number; // на одну попытку
}

export interface LlmSettings {
  providers: LlmProviderSettings[]; // порядок = порядок попыток
  maxTokens: number;
  totalTimeoutMs: number; // общий бюджет chat()
  cooldownMs: number;
  issues: string[]; // неполные/невалидные слоты
}
```

Эти типы живут в `bot/config.ts`: config — основание графа зависимостей и не
импортирует ничего из `bot/`. `bot/llm/types.ts` импортирует
`LlmProviderSettings` из `config.js` и добавляет контракты адаптера.
`LlmMessage` переезжает в `types.ts` (адаптеру нужен тип сообщений, а импорт из
`llm/index.ts` дал бы цикл) и реэкспортируется фасадом — публичный путь импорта
не меняется.

`AppConfig.llm` становится **не-null**: «LLM не настроен» теперь
`providers.length === 0`. Это нужно, чтобы health мог показать `issues` даже
тогда, когда валидных провайдеров нет. Остальные слайсы конфига не меняются.

### Конфиг: правила парсинга

- Индексы слотов читаются из env по маске `LLM_(\d+)_` (например,
  `LLM_1_BASE_URL` → слот 1). Общие ручки (`LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS`,
  `LLM_TOTAL_TIMEOUT_MS`, `LLM_COOLDOWN_MS`) под маску не попадают: после
  `LLM_` у них нет цифры.
- Допустимый диапазон — **n от 1 до 9**. Порядок попыток — по возрастанию `n`.
- Обязательные поля слота: `BASE_URL`, `MODEL`. `ID` по умолчанию
  `provider-<n>`, `KIND` по умолчанию `openai`, `API_KEY` опционален,
  `TIMEOUT_MS` по умолчанию `LLM_TIMEOUT_MS`.
- Неполный слот (есть часть `LLM_n_*`, но нет `BASE_URL` или `MODEL`) не
  добавляется в `providers`, причина попадает в `issues`.
- Неизвестный `KIND` — слот в `issues`, в цепочку не попадает.
- Дубль `ID` — второй слот в `issues`, чтобы не было неоднозначного ключа
  состояния.
- Пропуск в нумерации (`LLM_1_*`, `LLM_3_*`) — `issues`; валидные слоты всё
  равно используются.
- `n = 0` или `n > 9` — `issues`, слот не используется: опечатка
  (`LLM_0_*`, `LLM_10_*`) не должна молча менять цепочку.
- Неизвестный суффикс слота (`LLM_1_BASEURL`, `LLM_1_APIKEY`) — `issues`:
  иначе опечатка в имени переменной молча теряется.
- Хвостовые слэши `BASE_URL` срезаются, строки trim'аются, как сейчас.
- Числа валидны только конечные и `> 0`; мусор/ноль — дефолт.

### Адаптер

```ts
interface LlmAdapter {
  chat(
    settings: LlmProviderSettings,
    messages: LlmMessage[],
    opts: { maxTokens: number; timeoutMs: number },
  ): Promise<string>;

  probe(settings: LlmProviderSettings, opts: { timeoutMs: number }): Promise<LlmProbe>;
}

interface LlmAdapterDeps {
  /** Подмена сети; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
}

type LlmAdapterFactory = (deps?: LlmAdapterDeps) => LlmAdapter;
```

Контракты выше — в `bot/llm/types.ts`; `LlmProviderSettings` импортируется туда
из `config.js`. Реестр `Record<LlmProviderKind, LlmAdapterFactory>` живёт в
`bot/llm/index.ts`.

`openai.ts` экспортирует `createOpenAiAdapter(deps = {})` — фабрику по тому же
принципу, что `createRedisRest`/`createTelegramApi`/`createLlm`: `fetchImpl`
лежит в `deps`, а внутри `chat`/`probe` резолвится на каждый вызов
(`const doFetch = deps.fetchImpl ?? fetch`), а не запоминается при создании
фабрики. В `createLlm` адаптер создаётся **на попытку** с текущим
`deps.fetchImpl`, поэтому подмена `fetch`/`deps` после создания `createLlm()`
остаётся видимой.

`openai.ts` повторяет текущую логику:

- `chat`: `POST ${baseUrl}/chat/completions`, Bearer только при непустом
  `apiKey`, `temperature: 0.3`, `max_tokens`, `AbortSignal.timeout(timeoutMs)`;
  не-2xx → throw, пустой `content` → throw, иначе trim.
- `probe`: сначала `GET /models`, при любой проблеме — минимальный
  `POST /chat/completions` с `max_tokens: 1`; никогда не бросает.

### Инъекция fetch — существующий прецедент

В проекте уже есть три транспорта с одинаковым контрактом:

- `bot/redis-rest.ts` — `RedisRestDeps.fetchImpl`, резолв в `command`/`pipeline`;
- `bot/telegram-api.ts` — `TelegramApiDeps.fetchImpl`, резолв в `tgCall`;
- `bot/llm/index.ts` — `LlmDeps.fetchImpl`, резолв в `chat`/`ping`.

Тесты не подменяют глобальный `fetch`: `createRedisRest({ fetchImpl })`,
`createTelegramApi({ fetchImpl })`, `createLlm({ fetchImpl })`. Отдельный тест
проверяет, что `vi.stubGlobal("fetch", …)` после создания инстанса тоже виден
(ленивый резолв). Для нового адаптера сохраняем ту же схему:

- `createLlm({ config, fetchImpl, clock, log })` — основная точка инъекции для
  тестов цепочки;
- `createOpenAiAdapter({ fetchImpl })` — прямая точка инъекции для тестов
  payload/headers адаптера;
- моки типизируются как `as unknown as typeof fetch` (как в
  `llm.test.ts`/`redis-rest.test.ts`), чтобы не подстраивать сигнатуру `vi.fn`
  под `RequestInfo | URL`;
- для тестов таймаута остаётся helper `slowFetch`, уважающий
  `AbortSignal`/`init.signal`, как в текущем `llm.test.ts`.

### Цепочка fallback

`createLlm(deps)` резолвит `config`/`fetch`/`clock`/`log` **на каждый вызов**,
как сейчас. Состояние circuit breaker — `Map<providerId, downUntil>` в замыкании
инстанса `createLlm()`. `brain` создаёт `createLlm()` один раз, поэтому
состояние живёт в тёплом инстансе и сбрасывается холодным стартом.

Алгоритм `chat()`:

1. Взять `providers` из `config.llm`; если пусто — бросить
   `LLM не настроен: нет LLM-провайдеров` (или перечислить `issues`).
2. `deadline = clock() + totalTimeoutMs`.
3. Сначала пройти провайдеров **не в cooldown** в порядке конфига.
4. Если все они упали и остались провайдеры в cooldown — добрать их
   (half-open), пока позволяет бюджет. Уже опрошенных не повторять.
5. На каждую попытку: `timeout = min(provider.timeoutMs, deadline - clock())`.
   Если остаток `<= 0` — прервать цепочку.
6. Успех: удалить `downUntil` провайдера, вернуть текст.
7. Ошибка: `downUntil = clock() + cooldownMs`, записать причину, идти дальше.
8. Если упали все — бросить агрегированную ошибку:
   `LLM: все провайдеры недоступны (cloudflare: 429; backup: timeout)`.

Особенности:

- Внутри одного провайдера ретраев нет. Ретрай — это следующая попытка
  цепочки.
- Если все провайдеры в cooldown, цепочка не блокируется: half-open пробует
  всех по порядку. Это защищает от «LLM выключен на минуту» при тотальном
  сбое.
- Если после cooldown primary снова упал, cooldown продлевается; если ответил —
  запись удаляется, приоритет возвращается к нему.
- Если primary здоров, а backup в cooldown, при падении primary в том же
  запросе backup всё равно будет опрошен (пункт 4), но только если остался
  бюджет.
- Ключ cooldown — `id` провайдера. Записи для id, исчезнувших из env, безвредны
  (Map крошечная, чистка не нужна).
- Состояние не влияет на `ping()`: health проверяет реальную доступность всех
  провайдеров и не сбрасывает cooldown.

### Таймауты

| Ручка                  | Дефолт | Смысл                                                      |
| ---------------------- | ------ | ---------------------------------------------------------- |
| `LLM_TIMEOUT_MS`       | 15 000 | Таймаут одной попытки, если у слота нет `LLM_n_TIMEOUT_MS` |
| `LLM_n_TIMEOUT_MS`     | —      | Опциональное переопределение таймаута провайдера           |
| `LLM_TOTAL_TIMEOUT_MS` | 20 000 | Общий бюджет `chat()` на все попытки                       |
| `LLM_COOLDOWN_MS`      | 60 000 | Сколько не трогать упавшего провайдера                     |
| `LLM_MAX_TOKENS`       | 1 024  | Потолок генерации, общий для всех провайдеров              |
| `ping` (health)        | 10 000 | Фиксированный таймаут каждой пробы, пробы идут параллельно |

Локальный llama.cpp с долгим reasoning: поднять и `LLM_1_TIMEOUT_MS`, и
`LLM_TOTAL_TIMEOUT_MS` (например, 60 000 / 60 000), иначе общий бюджет срежет
ответ раньше попытки.

### Логи

- Падение провайдера: `log.warnThrottled("llm", "provider:<id>", ...)` с
  причиной без ключей и тел ответов.
- Пропуск из-за cooldown: `log.debug("llm", ...)`, чтобы не шуметь на проде.
- Итоговый отказ всех провайдеров уходит в `brain.answer`, который, как сейчас,
  логирует `[brain] LLM недоступен (...)` и отвечает dumb-режимом.
- Секреты (`LLM_n_API_KEY`, токены) не попадают ни в логи, ни в тексты ошибок.

---

## Env

```env
# ── Провайдер 1: Cloudflare Workers AI (OpenAI-compatible) ─────────
LLM_1_ID=cloudflare
LLM_1_KIND=openai
LLM_1_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
LLM_1_API_KEY=<API_TOKEN>
LLM_1_MODEL=@cf/meta/llama-3.1-8b-instruct

# ── Провайдер 2: запасной OpenAI-совместимый endpoint ──────────────
LLM_2_ID=backup
LLM_2_BASE_URL=https://api.groq.com/openai/v1
LLM_2_API_KEY=<key>
LLM_2_MODEL=llama-3.3-70b-versatile

# ── Общие ручки ────────────────────────────────────────────────────
LLM_TIMEOUT_MS=15000
LLM_TOTAL_TIMEOUT_MS=20000
LLM_COOLDOWN_MS=60000
LLM_MAX_TOKENS=1024
```

Конкретные имена моделей Cloudflare меняются — при настройке сверять каталог
Workers AI. Пример выше показывает формат, а не обязательную модель.

Слоты нумеруются 1…9; `LLM_0_*` и `LLM_10_*` попадут в `issues` и в цепочку не
войдут. Достаточно одного слота — второй добавляется без правки кода.

Локальный профиль llama.cpp теперь тоже нумерованный:

```env
LLM_1_ID=llama
LLM_1_BASE_URL=http://127.0.0.1:8080/v1
LLM_1_MODEL=my-model
LLM_1_TIMEOUT_MS=60000
LLM_TOTAL_TIMEOUT_MS=60000
```

`LLM_1_API_KEY` не задан — Bearer не отправится, llama.cpp это устраивает.

### Cloudflare: детали

- Токен — API token с доступом к Workers AI; аккаунт — `ACCOUNT_ID` из
  дашборда Cloudflare.
- `GET /models` на OpenAI-совместимом endpoint, скорее всего, вернёт 404;
  `ping` уже умеет падать на минимальный `POST /chat/completions`.
- 429 / capacity — обычная ошибка, уводит на следующего провайдера.
- `options.rejectIfBusy` у Cloudflare заставляет запрос падать вместо ожидания
  в очереди. Это потенциально полезно для fallback, но требует
  provider-specific поля в body; в этой задаче не делаем, оставляем заметку.
- AI Gateway можно использовать как `LLM_n_BASE_URL` формата
  `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/workers-ai/v1`,
  но его встроенные fallbacks — про Universal endpoint, не про `/v1`.

---

## Health

`ping()` остаётся «никогда не бросает». Пробы всех провайдеров запускаются
параллельно (`Promise.all`), чтобы health не длился `N × 10 с`.

Формат ответа `GET /api/telegram-setup?section=health`:

```json
{
  "llm": {
    "ok": true,
    "latencyMs": 420,
    "detail": "POST /chat/completions (минимальный запрос)",
    "providers": [
      {
        "id": "cloudflare",
        "ok": true,
        "latencyMs": 420,
        "detail": "POST /chat/completions (минимальный запрос)"
      },
      {
        "id": "backup",
        "ok": false,
        "error": "endpoint вернул 429"
      }
    ],
    "issues": []
  }
}
```

- `llm.ok` — `true`, если ответил хотя бы один провайдер.
- Верхнеуровневые `latencyMs` / `detail` — у первого здорового провайдера,
  чтобы старые читатели health не сломались.
- `llm.error` — только если не ответил никто или провайдеров нет.
- `issues` — из конфига: неполные слоты, неизвестный `KIND`, дубли `ID`,
  пропуски нумерации, слоты вне диапазона 1…9, неизвестные суффиксы.

`bot/http/telegram-admin.ts` меняется только типом ответа/докстрингом; логика
параллельного опроса `llm.ping()`, `store.ping()`, `telegramHealth()` остаётся.

---

## Изменения по файлам

### `bot/config.ts`

- Заменить `LlmSettings` на массив `providers` + общие `maxTokens`,
  `totalTimeoutMs`, `cooldownMs`, `issues`; здесь же `LlmProviderSettings` и
  `LlmProviderKind` (config — владелец типов слайса).
- `AppConfig.llm` — не-null; обновить докстринги про «null — не настроен».
- Новый парсер слотов `LLM_(\d+)_*` по ключам env, дефолты, `issues`;
  диапазон индексов — 1…9, вне диапазона и неизвестные суффиксы — `issues`.
- Константы: `LLM_TIMEOUT_DEFAULT_MS = 15_000`,
  `LLM_TOTAL_TIMEOUT_DEFAULT_MS = 20_000`,
  `LLM_COOLDOWN_DEFAULT_MS = 60_000`, `LLM_MAX_TOKENS_DEFAULT = 1_024`,
  `LLM_SLOT_MIN = 1`, `LLM_SLOT_MAX = 9`.
- Не импортировать ничего из `bot/` (кроме `node:process`).

### `bot/llm/index.ts` + `bot/llm/types.ts` + `bot/llm/openai.ts`

- `bot/llm.ts` → `bot/llm/index.ts`; обновить импорты в пяти местах на
  `../llm/index.js` (`../llm/index` в тестах).
- `bot/llm/openai.ts` — текущие `chat`/`ping` как `createOpenAiAdapter(deps)`.
- `bot/llm/types.ts` — `LlmAdapter`, `LlmProbe`, `LlmAdapterDeps`,
  `LlmAdapterFactory`, `LlmMessage`; `LlmProviderSettings` импортируется из
  `config.js`.
- В `bot/llm/index.ts` оставить публичный `createLlm()`: `chat`, `ping`,
  реэкспорт `LlmMessage`/`LlmPing`, `LlmDeps`, `Llm`; реестр адаптеров,
  цепочка, cooldown, агрегация ошибок.
- Сохранить инъекции `config`, `fetchImpl`, `clock`, `log`; резолв на каждый
  вызов. Адаптер создаётся на попытку с текущим `deps.fetchImpl`, чтобы
  подмена после создания `createLlm()` была видна.
- Не тянуть `brain`, `store`, `log` внутрь адаптера.

### `bot/http/telegram-admin.ts`

- Обновить тип `LlmPing` (экспортируется из `bot/llm/index.ts`) и докстринг env.
- Логика health не меняется.

### Тесты

`bot/tests/config.test.ts`:

- слот 1 и слот 2 в правильном порядке;
- дефолты `ID`, `KIND`, `TIMEOUT_MS`;
- trim и срез хвостовых слэшей;
- неполный слот → `issues`, валидный соседний остаётся;
- неизвестный `KIND` → `issues`;
- дубль `ID` → `issues`;
- пропуск нумерации → `issues`;
- `n = 0` и `n = 10` → `issues`, слот не используется;
- неизвестный суффикс слота (`LLM_1_BASEURL`) → `issues`;
- мусор/ноль в таймаутах → дефолты;
- нет слотов → `providers: []`, `issues: []`;
- ленивость: env перечитывается на каждый доступ.

`bot/tests/llm.test.ts`:

- инъекции через `createLlm({ config, fetchImpl, clock, log })` (импорт —
  `../llm/index`), без `vi.stubGlobal` — как в `redis-rest.test.ts` и
  `telegram-api.test.ts`; отдельный тест на ленивость: подмена `fetch` после
  создания `createLlm()` видна;
- адаптер отдельно: `createOpenAiAdapter({ fetchImpl })` — payload, headers,
  Bearer, пустой ответ, не-2xx, `/models` → fallback на минимальный chat;
- первый провайдер ответил → второй не вызывается;
- первый упал (500 / сеть / таймаут / пустой ответ / битый JSON) → второй
  ответил;
- все упали → агрегированная ошибка с id и причинами, без секретов;
- `LLM_MAX_TOKENS` и `Authorization` уходят в каждый запрос;
- `LLM_n_TIMEOUT_MS` переопределяет общий таймаут;
- общий дедлайн: первый «висит», второй получает остаток; после исчерпания
  бюджета оставшиеся не вызываются;
- cooldown: после падения первый пропускается на следующем запросе;
- cooldown истёк (сдвиг `clock`) → первый снова пробуется;
- успех очищает cooldown;
- все в cooldown → half-open пробует всех;
- primary упал, backup в cooldown → backup всё равно пробуется, если есть
  бюджет;
- состояние не течёт между разными инстансами `createLlm()`;
- `ping`: пробы параллельны (по мокам/порядку), частичный успех, все упали,
  нет провайдеров;
- `ping` не бросает ни при какой ошибке адаптера.

`bot/tests/brain.test.ts`, `telegram-admin.test.ts`:

- обновить точные тексты ошибок, если они поменялись;
- проверить, что агрегированная ошибка LLM уводит в dumb;
- health отдаёт `providers` и `issues`.

### Документация

- `docs/architecture.md`: схема «LLM chain», описание слоёв
  `llm/index.ts`/`llm/openai.ts`/`llm/types.ts`, таблица деградаций (падение
  одного провайдера → следующий, всех → dumb), таблица таймаутов, health, env.
- `docs/manual.md`: заменить `LLM_BASE_URL`-рецепты на `LLM_1_*`; Cloudflare
  как основной профиль; llama.cpp — локальный профиль; обновить health-таблицу,
  диагностику `[llm]`/`[brain]`, счётчики тестов.
- `.env.example`: Cloudflare + запасной провайдер; локальный llama.cpp;
  убрать Ollama-профиль.
- `AGENTS.md`: список env (`LLM_1_*`…`LLM_9_*`, `LLM_TOTAL_TIMEOUT_MS`,
  `LLM_COOLDOWN_MS`), описание архитектуры LLM-транспорта.
- `docs/deploy.md`, `docs/local-dev.md`: заменить старые `LLM_BASE_URL`-рецепты
  на нумерованные слоты.
- `README.md`: таблица env (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`) и фраза
  «по умолчанию Ollama Cloud» описывают изменившийся контракт — заменить на
  `LLM_1_*`…`LLM_9_*` и Cloudflare-профиль.
- `tasks/checklist-pre-final-testing.md` **не трогаем** — исторический чек-лист.

---

## Критерии готовности

1. Cloudflare Workers AI работает как основной провайдер через
   OpenAI-совместимый endpoint, без новых npm-зависимостей.
2. Второй провайдер добавляется только env-слотом `LLM_2_*` (слоты 1…9;
   `LLM_0_*`/`LLM_10_*` — `issues`, в цепочку не попадают).
3. Падение первого провайдера автоматически переводит запрос на второго;
   ответ пользователю не деградирует в dumb, если запасной жив.
4. После падения первого следующий запрос в том же тёплом инстансе не ждёт его
   таймаут (cooldown), но после истечения cooldown первый снова пробуется.
5. Общий бюджет `LLM_TOTAL_TIMEOUT_MS` соблюдается: суммарное время попыток не
   превышает его (с точностью до накладных расходов).
6. Если упали все — `brain` отвечает dumb-режимом, `answer()` не бросает.
7. Health показывает каждого провайдера отдельно, `issues` конфига и
   агрегированный `ok`.
8. В логах и ответах health нет ключей и тел ответов провайдеров.
9. `npm run format:check && npm run lint && npm run typecheck && npm run test`
   проходят.
10. Документация и `.env.example` не предлагают старую схему `LLM_BASE_URL` как
    рабочую.

## Проверка после реализации

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
```

Ручной смоук:

- `npm run dev:function` с `LLM_1_*` на Cloudflare → вопрос в вебчате получает
  `mode: "llm"`.
- Временно испортить `LLM_1_BASE_URL`/ключ → запрос уходит на `LLM_2_*`,
  в логах `[llm]` видно падение первого, health показывает `providers`.
- Испортить оба → `mode: "dumb"`, `[brain] LLM недоступен (все провайдеры...)`.
- `GET /api/telegram-setup?section=health` с секретом → `llm.providers` и
  `issues`.

## Риски и ограничения

- **Cooldown живёт в одном инстансе.** На Vercel несколько тёплых инстансов
  учатся независимо; это приемлемо. Общий cooldown в Redis не делаем.
- **Cooldown может временно скрыть восстановление** провайдера. Смягчение:
  TTL 60 с, half-open при всех недоступных, health показывает реальную картину.
- **Fallback может удвоить расход квоты** при таймауте. Rate-limit остаётся на
  уровне вопросов пользователя, а не вызовов провайдеров.
- **Ошибочный конфиг не должен молча исчезать.** Неполные слоты и дубли — в
  `issues` и health.
- **Env запекается в деплой:** после правки переменных нужен Redeploy.
- **Пуш — только по явному подтверждению владельца** (AGENTS.md).

## Порядок работ

1. `bot/config.ts`: типы слайса, парсер слотов 1…9, `issues`, общие ручки +
   тесты.
2. `bot/llm.ts` → `bot/llm/index.ts`, `bot/llm/types.ts`, `bot/llm/openai.ts`:
   адаптер и контракты; обновить импорты в пяти местах.
3. `bot/llm/index.ts`: цепочка, общий дедлайн, cooldown, агрегация ошибок +
   тесты.
4. `ping` и health + тесты.
5. Документация, `.env.example`, `AGENTS.md`, `README.md`.
6. Полный прогон проверок.
7. Настройка env Vercel и Redeploy — после подтверждения владельца.

## Что осталось выбрать при настройке (не блокирует код)

- Второй провайдер: вторая модель Cloudflare, другой OpenAI-совместимый сервис
  или локальный llama.cpp для разработки.
- Конкретные имена моделей Cloudflare (сверять каталог на момент настройки).
- Использовать ли Cloudflare AI Gateway как `baseUrl` или ходить напрямую в
  `api.cloudflare.com`.
- Тонкая настройка `LLM_COOLDOWN_MS` и `LLM_TOTAL_TIMEOUT_MS` по фактической
  latency.
