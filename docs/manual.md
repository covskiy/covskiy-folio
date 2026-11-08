# Мануал владельца

Самодостаточная инструкция: как устроен бот сайта, как править контент и поведение,
как дебажить поломки и запускать локальную разработку — в том числе с локальным
llama.cpp. Архитектурные «почему» (зачем одна функция, почему fail-open и т.п.) не
дублируются — см. [architecture.md](architecture.md); здесь — «как пользоваться и чинить».

## Оглавление

1. [Шпаргалка](#1-шпаргалка)
2. [Карта файлов: что где лежит и «что смотреть, если...»](#2-карта-файлов-что-где-лежит-и-что-смотреть-если)
3. [Поток вебчата end-to-end](#3-поток-вебчата-end-to-end)
4. [Поток Telegram end-to-end](#4-поток-telegram-end-to-end)
5. [Правки контента: рецепты](#5-правки-контента-рецепты)
6. [Память диалога: посмотреть и почистить руками](#6-память-диалога-посмотреть-и-почистить-руками)
7. [Локальная разработка (базовый вариант)](#7-локальная-разработка-базовый-вариант)
8. [Локальный llama.cpp (полная инструкция)](#8-локальный-llamacpp-полная-инструкция)
9. [Дебаг и диагностика](#9-дебаг-и-диагностика)
10. [Тесты](#10-тесты)
11. [Деплой (кратко)](#11-деплой-кратко)

---

## 1. Шпаргалка

| Хочу…                                            | Что делать                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Запустить локальную разработку                   | Терминал 1: `npm run dev:function` (порт 3000); терминал 2: `npm run dev` (vite, 5173) — раздел [7](#7-локальная-разработка-базовый-вариант) |
| Прогнать тесты                                   | `npm run test` (или `npm run test:watch` — следить за изменениями)                                                                           |
| Проверить типы / линтер / формат                 | `npm run typecheck` / `npm run lint` / `npm run format:check` (форматировать: `npm run format`)                                              |
| Поменять справку бота                            | `bot/brain/knowledge.json` (массив `{id, title, text, keywords?, contact?, chip?, about?}`) — раздел [5](#5-правки-контента-рецепты)         |
| Вопрос «не находится» в dumb-режиме              | добавь синоним в `keywords` записи (`knowledge.json`), не алгоритм — раздел [5.1](#51-добавитьизменить-элемент-справки)                      |
| Поменять тон/правила ответов                     | `bot/brain/prompts/00-persona.md` (кто бот) и `bot/brain/prompts/10-rules.md` (как отвечать)                                                 |
| Сменить модель / провайдера LLM                  | env `LLM_BASE_URL` + `LLM_MODEL` (и `LLM_API_KEY`), затем Redeploy — рецепт [5.4](#54-сменить-модель-или-провайдера)                         |
| Посмотреть промт на проде                        | `GET /api/telegram-setup?section=prompt` с секрет-заголовком — раздел [9.1](#91-админ-маршрут-apitelegram-setup)                             |
| Посмотреть health (LLM/Redis/Telegram)           | `GET /api/telegram-setup?section=health` с секрет-заголовком                                                                                 |
| Проверить/перерегистрировать вебхук              | `GET` / `POST /api/telegram-setup` с секрет-заголовком — [telegram-webhook-runbook.md](telegram-webhook-runbook.md)                          |
| Почистить историю чата                           | Telegram: `/reset`; вебчат: кнопка «новый диалог» (⟳) или ключ Redis руками — раздел [6](#6-память-диалога-посмотреть-и-почистить-руками)    |
| Выкатить                                         | `git push` → Vercel задеплоит сам — раздел [11](#11-деплой-кратко), детали в [deploy.md](deploy.md)                                          |
| Посмотреть логи функции                          | Дашборд Vercel → Observability → Logs (на Hobby retention 1 час) или `npx vercel logs <deployment-url>`                                      |
| Экспериментировать с локальной моделью бесплатно | llama.cpp локально — раздел [8](#8-локальный-llamacpp-полная-инструкция)                                                                     |

**Десять минут на понимание.** Оба канала — вебчат и Telegram — бьют в одну
Vercel Function (`api/bot.ts`, роутер по pathname), которая за ответом всегда
ходит в один «мозг» — `answer()` из `bot/brain/brain.ts`:

```
вопрос (вебчат или Telegram)
  → bot/store.ts: достать историю диалога из Upstash Redis (нет Redis — ок, пусто)
  → bot/brain/brain.ts answer(): system-промт (bot/brain/prompt.ts из bot/brain/prompts/*.md
    + bot/brain/knowledge.json) + последние 10 сообщений + вопрос → LLM
  → LLM недоступен/таймаут → dumb-режим: поиск по той же справке без сети
  → ответ отправляется, пара вопрос/ответ дописывается в историю
```

Всё остальное — детали доставки и обвязка, которые разбираются по разделам ниже.

---

## 2. Карта файлов: что где лежит и «что смотреть, если...»

### Дерево серверной части и фронта

| Файл                                 | Роль                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/bot.ts`                         | Единственная Vercel Function — роутер по pathname: `/api/chat`, `/api/telegram`, `/api/telegram-setup`, иначе 404 JSON                                                        |
| `bot/config.ts`                      | Единый слайс env: типизированные `llm` / `redis` / `telegram` / `rateLimit` / `logLevel` над ленивыми геттерами; парсинг (trim, срез слэшей, числа с дефолтом) — только здесь |
| `bot/log.ts`                         | Логгер-фабрика `createLogger()`: префикс `[модуль]`, уровень из `LOG_LEVEL` (дефолт warn), `warnThrottled`; таблица строк — раздел [9.2](#92-логи-vercel)                     |
| `bot/llm.ts`                         | LLM-транспорт: `chat()` — запрос к OpenAI-совместимому endpoint (таймаут `LLM_TIMEOUT_MS`), `ping()` — health для админ-маршрута                                              |
| `bot/brain/brain.ts`                 | «Мозг»: `answer()` — LLM через транспорт `bot/llm.ts`; при любой ошибке dumb-режим — порог 0.3, ответ `title + text`, подсказки fallback (fetch/ping в brain не живёт)        |
| `bot/brain/search.ts`                | Dumb-поиск: `rankKnowledge()` — нормализация, стемминг, IDF, синонимы `keywords`; порога и сети в модуле нет — порог и подсказки решает brain.ts                              |
| `bot/brain/knowledge.ts`             | Хранилище справки: `load()` — безопасное чтение и валидация формы (title/text, keywords, contact — никогда не бросает), `uiTopics()` — единый состав чипсов и кнопок /start   |
| `bot/brain/help.ts`                  | Тексты помощи на оба канала (`?`/`/help` вебчата, `/help` Telegram, запасной текст вебчата); модуль без импортов — не зависит от LLM/Redis/справки                            |
| `bot/brain/prompt.ts`                | Сборщик system-промта: `systemPrompt(entries)` склеивает `bot/brain/prompts/*.md` и вставляет справку вместо `{{KNOWLEDGE}}`                                                  |
| `bot/brain/knowledge.json`           | ★ Справка бота — массив `{id, title, text, keywords?, contact?, chip?, about?}`. Единственное место правки контента (контракт полей — §5.1)                                   |
| `bot/brain/prompts/`                 | Разделы промта готовым текстом: `00-persona.md`, `10-rules.md`, `20-knowledge.md`                                                                                             |
| `bot/redis-rest.ts`                  | Транспорт Upstash REST: команда — JSON-массив в теле POST (`fetch`, таймаут 5 с, fail-open); логирует деградации с префиксом `[store]`                                        |
| `bot/store.ts`                       | История диалогов: домен поверх `bot/redis-rest.ts` — ключи `chat:web:{sessionId}` / `chat:tg:{chatId}`, TTL 24 ч, дедупликация, лимитер, fail-open                            |
| `bot/rate-limit.ts`                  | Лимитер «мозга»: `hitRateLimit(bucket)` — фиксированное окно в Redis, пороги из `config.rateLimit`, fail-open                                                                 |
| `bot/http/webchat.ts`                | Обработчик `/api/chat`: GET — чипсы и помощь; POST — валидация, история, `answer()`, ответ `{ok, text, mode, suggestions?}`                                                   |
| `bot/http/telegram-webhook.ts`       | Обработчик `/api/telegram`: секрет, команды `/start /help /reset /about` (`/help` — с кнопками тем), свободный текст, кнопки `ask:{id}` (/start и подсказки fallback)         |
| `bot/telegram-api.ts`                | Тонкая обёртка Bot API на fetch: `sendMessage` (резка на 4096), `answerCallbackQuery`, `editMessageText`, `sendChatAction`, `setWebhook`, `getWebhookInfo`                    |
| `bot/http/telegram-admin.ts`         | Админ-маршрут `/api/telegram-setup`: health, просмотр промта, диагностика/регистрация вебхука; без секрета — 404                                                              |
| `src/chat/chat-api.ts`               | Клиент вебчата: sessionId в localStorage (ключ `covskiy-folio:chat-session-id`), `fetchChatBootstrap()` (чипсы + помощь), `askChat()`                                         |
| `src/chat/chat-widget.ts`            | UI виджета: кнопка-тумблер, панель, «печатает…», бейдж «офлайн-справка», чипсы и подсказки fallback, помощь «?», команды `/help`/`/start`, кнопка «новый диалог»              |
| `src/chat/chat.css`                  | Стили виджета                                                                                                                                                                 |
| `bot/dev/dev-function.mjs`           | Dev-адаптер функции (замена сломанного `vercel dev`): компиляция в `.tmp/dev-function`, контент, `.env.local`, порт 3000                                                      |
| `bot/tests/`                         | Юнит-тесты в 15 файлах (Vitest, сеть замокана) — раздел [10](#10-тесты)                                                                                                       |
| `vercel.json`                        | Только rewrites: `/api/chat`, `/api/telegram`, `/api/telegram-setup` → `/api/bot`                                                                                             |
| `.env.example`                       | Шаблон env: профиль llama.cpp и Ollama Cloud + плейсхолдеры Upstash/Telegram                                                                                                  |
| `src/main.ts`, `*.html`, `style.css` | Статика MPA: страницы, монтирование виджета (`mountChatWidget()` в `src/main.ts`)                                                                                             |

### Симптом → какие файлы смотреть первым делом

| Симптом                                          | Файлы в порядке просмотра                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Бот отвечает в режиме «офлайн-справка»           | `bot/llm.ts` → `bot/config.ts` (env `LLM_BASE_URL`/`LLM_MODEL`, таймаут — env `LLM_TIMEOUT_MS`, дефолт 15 с) → логи (`[brain]`) → раздел [9.3](#93-mode-dumb-как-симптом) |
| Бот не помнит контекст диалога                   | `bot/store.ts` → `bot/redis-rest.ts` (env `UPSTASH_*` / `KV_REST_API_*`, TTL) → warn-логи `[store]` → раздел [6](#6-память-диалога-посмотреть-и-почистить-руками)         |
| Вебчат не грузит чипсы/помощь                    | `bot/http/webchat.ts` (`uiTopics`, GET-ветка) → `src/chat/chat-api.ts` (`fetchChatBootstrap` — молча отдаёт пусто при не-2xx) → `src/chat/chat-widget.ts` (`renderChips`) |
| Вопрос «не находится» в dumb-режиме              | `bot/brain/knowledge.json` (`keywords` записи — сначала синоним!) → `bot/brain/search.ts` (`rankKnowledge`) — раздел [5.1](#51-добавитьизменить-элемент-справки)          |
| Telegram не отвечает                             | `bot/http/telegram-webhook.ts` + `bot/telegram-api.ts` → вебхук: `GET /api/telegram-setup` → [telegram-webhook-runbook.md](telegram-webhook-runbook.md)                   |
| Кнопки в Telegram не работают                    | `bot/http/telegram-webhook.ts` (`handleCallbackQuery`, `startKeyboard`) → `allowed_updates` при регистрации вебхука — раздел [9.4](#94-типовые-поломки-таблицей)          |
| 500 на `/api/*`                                  | Логи Vercel (`ERR_MODULE_NOT_FOUND`?) → `api/bot.ts` и импорты в `bot/` (расширения `.js`) → раздел [9.4](#94-типовые-поломки-таблицей)                                   |
| Ответы бота «не из той справки» / промт странный | `bot/brain/knowledge.json` + `bot/brain/prompt.ts` → посмотреть собранный промт через `?section=prompt` (раздел [9.1](#91-админ-маршрут-apitelegram-setup))               |

---

## 3. Поток вебчата end-to-end

Путь запроса от клика пользователя до ответа — с именами файлов и функций:

1. **Виджет.** `src/chat/chat-widget.ts` → `mountChatWidget()` (вызывается из
   `src/main.ts`) рисует плавающую кнопку и панель. Пользователь вводит текст в
   `maxlength="2000"` инпут и жмёт отправку → `sendMessage(content)` внутри
   `chat-widget.ts`. Клик по чипу или подсказке dumb-fallback — тот же
   `sendMessage(title)`: чип отправляет свой текст как готовый вопрос.
2. **Клиентский API.** `src/chat/chat-api.ts` → `askChat(sessionId, text)`:
   `POST /api/chat` с телом `{sessionId, text}`. sessionId берётся из
   `getSessionId()` — uuid из localStorage (ключ `covskiy-folio:chat-session-id`),
   поэтому контекст переживает перезагрузку страницы.
3. **Rewrite.** На Vercel `vercel.json` отправляет `/api/chat` в единственную
   функцию `/api/bot` (`api/bot.ts`), где `switch` по pathname ведёт в
   `handleWebChat` из `bot/http/webchat.ts`. Локально vite-прокси (`vite.config.ts`)
   шлёт `/api` на порт 3000.
4. **Валидация** (`bot/http/webchat.ts`, `handleWebChat`):
   - GET → сразу `{ok, service: "webchat", chips, help}` — чипсы: `uiTopics()` из
     `bot/brain/knowledge.ts` (помеченные `chip: true` записи, максимум 3);
     недоступная справка — пустой список, не 500. `help` — текст помощи из
     `bot/brain/help.ts`, отдаётся всегда: кнопка «?» работает и в offline-режиме;
   - другой метод → 405;
   - битый JSON → 400 `Invalid JSON`;
   - sessionId — белый список `SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/`
     (он часть ключа Redis, произвольные ключи не пропускаются);
   - text — непустой после `trim()`, не длиннее `MAX_TEXT_LENGTH = 2000`.
     Нарушения → 400 с `ok: false`.
5. **История.** `bot/store.ts` → `getHistory(webKey(sessionId))` — ключ вида
   `chat:web:{sessionId}`. Redis недоступен? `getHistory` вернёт `[]` (fail-open),
   ответ всё равно уйдёт — просто без контекста.
6. **Мозг.** `bot/brain/brain.ts` → `answer(question, history)`: в LLM уходит payload
   `{model, messages: [system + последние N сообщений (env `HISTORY_WINDOW`, дефолт 10) + текущий вопрос], temperature: 0.3}`
   на `${LLM_BASE_URL}/chat/completions`, таймаут `LLM_TIMEOUT_MS` — env,
   дефолт 15 000 мс.
   Ошибка транспорта → dumb-режим: `rankKnowledge()` из `bot/brain/search.ts`
   ищет по той же справке (морфология, IDF, синонимы `keywords`); попадание
   выше `DUMB_SCORE_THRESHOLD = 0.3` → ответ `title + text`, промах → fallback
   с подсказками (до 3: near-miss → контакт `contact: true` → `uiTopics`) или
   `FALLBACK_PLAIN`. Ошибка сборки промта (битый `{{KNOWLEDGE}}`) — отдельная
   деградация с честным логом «system-промт не собран»: LLM не вызывается,
   dumb отвечает по справке (раздел [9.3](#93-modedumb-как-симптом)).
7. **Ответ.** `handleWebChat` возвращает `{ok: true, text, mode, suggestions?}`,
   где `mode` — `"llm"` или `"dumb"`; `suggestions` — подсказки следующего
   вопроса (только `{title}`, без id) — прилагаются только к dumb-fallback:
   у llm-ответа, уверенного dumb-ответа и недоступной справки поля в JSON нет.
8. **Сохранение.** `appendHistory(key, [{role: "user", ...}, {role: "assistant", ...}])`
   — пара вопрос/ответ одним SET с обновлением TTL 24 ч.
9. **Рендер.** Виджет убирает индикатор «печатает…» и рисует пузырь; при
   `mode: "dumb"` к ответу добавляется бейдж «офлайн-справка»
   (`chat-widget.ts`, `addMessage`). Подсказки dumb-fallback рисуются тем же
   рядом чипов над формой; клик — обычный вопрос. Ошибка сети/API — системное
   сообщение `ERROR_TEXT`, виджет не падает.
10. **Бутстрап.** Чипсы и текст помощи грузятся одним GET `/api/chat` один раз
    за жизнь страницы (`fetchChatBootstrap()` из `chat-api.ts`, при не-2xx
    молча пусто): чипсы рисуются при первом разворачивании и после «нового
    диалога», повторные клики «?» и переоткрытия читают кэш. Любая новая
    реплика убирает предыдущий ряд чипов — за ненадобностью.
11. **«Новый диалог»** (кнопка ⟳, `chat-widget.ts`): `renewSessionId()` из
    `chat-api.ts` сохраняет свежий uuid — сервер начнёт новую историю, старый
    ключ Redis истечёт по TTL сам. Транскрипт на странице очищается.
12. **Помощь и локальные команды.** Кнопка «?» и точный ввод `/help` или
    `/start` (после `trim()` + `toLowerCase()`; «/help extra» — обычный вопрос)
    обходятся без POST: «?» и `/help` показывают текст помощи из бутстрапа
    (запасной — `HELP_TEXT_WEBCHAT_FALLBACK` из `bot/brain/help.ts`) плюс
    чипсы, `/start` — приветствие. В историю диалога команды не пишутся.

---

## 4. Поток Telegram end-to-end

1. **Вебхук.** Telegram шлёт `POST /api/telegram` с заголовком
   `X-Telegram-Bot-Api-Secret-Token`. Rewrite ведёт в `api/bot.ts` →
   `handleTelegramWebhook` (`bot/http/telegram-webhook.ts`).
2. **Секрет.** Заголовок сверяется с env `TELEGRAM_WEBHOOK_SECRET`. Не совпал или
   env пуст → `401` и ничего не происходит (чужие запросы не тратят вызовы LLM).
   После проверки — всегда `2xx {ok: true}` (иначе Telegram будет повторять
   доставку update), даже при ошибке обработчика.
   2a. **Дедупликация.** Telegram — at-least-once: при не-2xx или потерянном ответе
   он повторяет ТОТ ЖЕ update с тем же `update_id`. До обработки — GET маркера
   `tg:seen:{update_id}` в Redis (примитив `isSeen` из `bot/store.ts`): маркер
   есть — апдейт уже обработан, `200 {ok: true}` и выход. После успешной
   обработки — SET маркера `EX 3600 NX` (`markSeen`, TTL 1 час — с запасом
   перекрывает ретраи, ключи чистятся сами). Маркер ставится после, а не до:
   маркер до работы ломает сценарий «функция убита по таймауту» — повтор увидел
   бы маркер и молча не ответил бы, это хуже дубля. Без Redis (fail-open)
   дедупликация отключается — оба «повтора» обрабатываются полноценно.
3. **Ветвление** в `handleTelegramWebhook`:
   - `callback_query` → `handleCallbackQuery` (пункт 6);
   - `message.text` начинается с `/` → `handleCommand` (пункт 4);
   - `message.text` — свободный текст → `answerAsQuestion` (пункт 5);
   - сообщение без текста (фото, стикеры) — молча игнорируется.
     Битый JSON в теле → тоже `200 {ok: true}`.
4. **Команды** (`handleCommand`; `/start@BotName` и лишние аргументы сводятся к
   имени). Команды **не пишутся в историю** — это действия интерфейса, а не
   реплики диалога:
   - `/start` → `sendMessage(chatId, WELCOME_TEXT, startKeyboard())` — приветствие
     - inline-кнопки: `uiTopics()` (те же темы, что чипсы вебчата),
       `callback_data = "ask:{id}"`;
   - `/help` → `HELP_TEXT_TELEGRAM` из `bot/brain/help.ts` + тот же
     `startKeyboard()`: темы кликабельны, помощь работает без LLM; недоступная
     справка → только текст, без кнопок;
   - `/reset` → `clearHistory(tgKey(chatId))` — ключ удаляется, история пуста
     (это единственная команда, трогающая Redis);
   - `/about` → `aboutText()`: текст записи с пометкой `about: true` (заголовок
     можно переименовывать свободно); пометки нет или справка недоступна —
     заглушка «Информация о владельце пока не заполнена»;
   - неизвестная команда → `UNKNOWN_COMMAND_TEXT`.
5. **Свободный текст** — `answerAsQuestion(chatId, question)`: тот же поток, что в
   вебчате, ключ `chat:tg:{chatId}` — `sendChatAction(chatId, "typing")`
   (индикатор «печатает…», ошибка глотается) → `getHistory` →
   `answer(question, history)` → `sendMessage(chatId, reply)` → `appendHistory`
   (пара вопрос/ответ). Подсказки dumb-fallback прилагаются к ответу
   inline-клавиатурой `ask:{id}` — клик идёт в существующий
   `handleCallbackQuery` как нажатие кнопки /start; в историю пишется только
   текст. Порядок «отправить → записать» сознателен: при упавшей
   отправке в историю не должно попасть ничего — фантомная пара осталась бы в
   контексте, и при повторе LLM продолжал бы старую мысль.
   `sendMessage` из `bot/telegram-api.ts` режет ответы длиннее 4096 символов
   (лимит Telegram) по последнему переводу строки. Ошибка на любом шаге
   ловится: пользователю уходит «У меня технические неполадки…», наружу — 2xx.
6. **Кнопка (`callback_query`, `data = "ask:{id}"`).** Кнопка несёт slug записи
   справки — перестановка и правка контента не меняют смысл старой кнопки,
   а удаление/переименование `id` уводит старые кнопки в ветку «устарела».
   Лимит Telegram — 64 байта, slug влезает с запасом. Порядок вызовов
   в `handleCallbackQuery`:
   1. распарсить `ask:{id}` (тот же `ID_PATTERN`, что валидирует записи), найти
      запись по `id`; битый формат или неизвестный id (включая legacy-кнопки
      с индексом) → `answerCallbackQuery(id, CALLBACK_ERROR_TEXT)`
      («Кнопка устарела…») и всё;
   2. `answerCallbackQuery(id)` — спиннер гасится сразу, не дожидаясь LLM;
   3. `answerAsQuestion(message.chat.id, entry.title)` — как обычный вопрос
      (с историей, пункт 5);
   4. `editMessageText(chatId, message_id, message.text)` — снимает одноразовую
      клавиатуру со старого сообщения `/start`; сбой не критичен, ловится с warn
      (`[telegram-webhook] не смог снять клавиатуру…`).
7. **Регистрация.** Вебхук ставится POST-ом на админ-маршрут: `setWebhook` с
   `url` = origin запроса + `/api/telegram`, `secret_token` из env и
   `allowed_updates: ["message", "callback_query"]` — без `callback_query` в этом
   списке кнопки просто не приходят (частая причина «кнопки не работают» после
   старой регистрации). Детали — [telegram.md](telegram.md) и
   [telegram-webhook-runbook.md](telegram-webhook-runbook.md).

---

## 5. Правки контента: рецепты

Общее правило для всех рецептов: контент и env **запекаются в артефакт на
деплое**. Правка = коммит → `git push` → автодеплой Vercel → сайт и бот отвечают
по-новому. Никаких отдельных шагов публикации контента нет. (Исключение — env:
после правки переменных в дашборде нужен Redeploy, см. раздел [11](#11-деплой-кратко).)

### 5.1 Добавить/изменить элемент справки

1. Открой `bot/brain/knowledge.json` — массив объектов
   `{id, title, text, keywords?, contact?, chip?, about?}`.
2. Добавь объект или поправь существующий:
   - `id` — **обязательный** стабильный slug: строчные латинские буквы/цифры/
     дефис, начинается с буквы, до 48 символов, уникальный. По нему кнопка
     /start находит запись. **Переименование `id` — видимая операция**: старые
     кнопки у пользователей получат «Кнопка устарела» — переименовывай
     осознанно;
   - `title` — тема-вопрос (он же текст чипа и кнопки);
   - `text` — текст ответа;
   - `keywords` — массив синонимов для dumb-поиска: слова, которыми люди
     называют тему, а не пересказ текста (`цена`, `бюджет`, `связаться`).
     В промт и UI не попадают — только поисковый слой. **Стоп-слова в
     `keywords` не работают** (`сколько`, `как`, `что`, `расскажи`…): они
     вырезаются и из вопроса, и из `keywords` — вопрос «Сколько стоит?»
     ловится через `стоит`/`цена`/`стоимость`, а не через `сколько`.
     **Правило владельца**: вопрос стабильно не находится — сначала добавь
     синоним в `keywords`, и только потом правь алгоритм поиска;
   - `contact: true` — запись-контакт: гарантированно попадает в подсказки
     dumb-fallback, чтобы офлайн-режим всегда оставлял путь к владельцу.
     В чипсы, кнопки /start и промт не попадает (несколько таких записей —
     не ошибка, берётся первая в файле);
   - `chip: true` — запись попадает в чипсы вебчата и кнопки /start (первые 3
     помеченных в порядке файла);
   - `about: true` — запись отвечает на `/about`.
3. `git push`.

Что произойдёт автоматически — справка применяется **во всех** этих местах без
правки кода:

- **system-промт LLM**: `bot/brain/prompt.ts` → `systemPrompt()` вставляет все элементы
  в `{{KNOWLEDGE}}` секции `20-knowledge.md` (формат: `## {title}` + текст);
- **чипсы вебчата** и **inline-кнопки `/start` в Telegram**: `uiTopics()` из
  `bot/brain/knowledge.ts` — одни и те же темы на оба канала (пометки `chip`,
  максимум 3);
- **`/about`**: запись с пометкой `about: true`;
- **dumb-поиск**: `bot/brain/search.ts` → `rankKnowledge()` ищет по `title`,
  `keywords` и `text` (заголовок и синонимы — полным весом, текст — половинным).

Итого: один JSON меняет поведение всех потребителей. Порядок массива задаёт
только порядок секций в промте — чипсы и кнопки определяются пометками `chip`,
поэтому записи можно переставлять свободно. Если валидация отбросила запись
(битый `id`, пустой `title`/`text`) — в логах появится `[knowledge] запись N
отброшена…`, а смоук-тест реального файла упадёт в pre-commit ещё до коммита.
Мусорные `keywords` (не массив непустых строк) и `contact` не `true` запись не
убивают: в логах `[knowledge]` предупреждение, поле удаляется или флаг
игнорируется — правь JSON, чтобы синоним/контакт заработали.

### 5.2 Изменить тон/правила ответов

- `bot/brain/prompts/00-persona.md` — кто такой ассистент (сейчас: «дружелюбный
  ассистент-справка на сайте-визитке»).
- `bot/brain/prompts/10-rules.md` — как отвечать (сейчас: коротко, по-русски, только по
  справке, честно признавать незнание).

Правишь текст → пуш → деплой. Менять код не нужно. Проверить результат на проде:
`GET /api/telegram-setup?section=prompt` — раздел [9.1](#91-админ-маршрут-apitelegram-setup).

### 5.3 Изменить структуру промта / добавить файл-часть

Порядок и состав промта зашиты в `bot/brain/prompt.ts` массивом `PARTS`:

```ts
const PARTS = [
  new URL("./prompts/00-persona.md", import.meta.url),
  new URL("./prompts/10-rules.md", import.meta.url),
  new URL("./prompts/20-knowledge.md", import.meta.url),
] as const;
```

- Порядок в массиве = порядок секций в промте; цифровые префиксы имён файлов —
  просто удобство для человека, код их не сортирует.
- Склейка: файлы `trim()`-ятся и соединяются пустой строкой; в `20-knowledge.md`
  плейсхолдер `{{KNOWLEDGE}}` заменяется справкой — **ровно один** на всю
  заготовку: пропал или задвоился → сборка бросает с точной причиной
  («{{KNOWLEDGE}} должен встречаться ровно 1 раз, найдено: N»), бот уходит
  в dumb-режим, админка `?section=prompt` показывает 502 с этой же причиной.
  Новый файл с новым плейсхолдером потребует правки `systemPrompt()`.
- **Важно:** новый `*.md` в `bot/brain/prompts/` сам по себе в промт не попадёт и в
  артефакт деплоя не уедет. Путь файла должен быть упомянут литералом
  `new URL(...)` в `bot/brain/prompt.ts` — таков механизм трейсинга файлов Vercel
  (nodeFileTrace; таблица паттернов — в
  [architecture.md](architecture.md) → «Грабли платформы»). Если добавить md и не
  упомянуть литералом: локально всё работает, на проде — `ENOENT` в логах и
  уход в dumb-режим (кэш сборки в `systemPrompt()` инстанс не перечитывает —
  см. пункт про перезапуск в [9.2](#92-логи-vercel)).

### 5.4 Сменить модель или провайдера

Env-переменные (прод — Vercel → Settings → Environment Variables):

- `LLM_BASE_URL` — база OpenAI-совместимого API. Код (`bot/config.ts`)
  обрезает хвостовые `/`; `/chat/completions` дописывает транспорт `bot/llm.ts`:
  для Ollama Cloud это
  `https://ollama.com/v1`, для llama.cpp — `http://127.0.0.1:8080/v1` (про `/v1`
  подробнее в разделе [8](#8-локальный-llamacpp-полная-инструкция)).
- `LLM_MODEL` — имя модели (для llama.cpp локально — любая строка).
- `LLM_API_KEY` — опционален: пустой/отсутствующий просто не добавляет заголовок
  `Authorization: Bearer …` (в `bot/config.ts` пустая строка после trim
  превращается в undefined).

После правки env — **Redeploy** (env запекается в деплой, раздел [11](#11-деплой-кратко)).
Локально то же самое в `.env.local` — вступает в силу при перезапуске
`npm run dev:function`.

### 5.5 Поменять TTL истории / окно контекста / порог dumb-ответа

Управляющие ручки — env (слайсы brain/history в `bot/config.ts`, дефолты в коде;
на Vercel после правки — Redeploy):

- TTL истории: `HISTORY_TTL_SECONDS` (секунды; дефолт 86 400, обновляется при
  каждой записи — «скользящее окно» активности).
- Окно контекста: `HISTORY_WINDOW` — сколько последних сообщений диалога
  уходит в LLM (дефолт 10).
- Порог dumb-ответа: `DUMB_SCORE_THRESHOLD` (дефолт 0.3) — выше строже: чаще
  честный fallback с подсказками, ниже — чаще уверенный ответ по совпадению.
- TTL дедупликации Telegram-апдейтов: `TELEGRAM_SEEN_TTL_SECONDS`
  (дефолт 3600 — час с запасом перекрывает ретраи Telegram).

Стартовые значения и комментарии — в `.env.example`. После правки прогони
`npm run test`: сквозные тесты (store/brain) подхватывают env через `vi.stubEnv`.

### 5.6 Поменять лимит текста вебчата

Лимит живёт в **двух местах**, менять синхронно:

1. `MAX_TEXT_LENGTH = 2_000` в `bot/http/webchat.ts` (серверная валидация, иначе 400);
2. `maxlength="2000"` в инпуте виджета `src/chat/chat-widget.ts` (клиент просто
   не даст набрать больше).

Расхождение не сломает ничего: сервер отбракует длинное с 400, виджет покажет
`ERROR_TEXT`. Но пользователю будет непонятно — поэтому оба места сразу.

### 5.7 Добавить Telegram-команду

1. `bot/http/telegram-webhook.ts` → `handleCommand`: добавить `case "newcmd":` —
   ответ через `sendMessage(chatId, ...)`. Команды в историю не пишутся, так что
   просто отвечай и возвращайся.
2. Если ответ зависит от справки — бери из `bot/brain/knowledge.ts`: `load()`
   для всех записей, `uiTopics()` для подсказок (образец — `aboutText()` по
   пометке `about: true`).
3. Текст подсказки о команде добавь в `HELP_TEXT_TELEGRAM` в `bot/brain/help.ts`
   (там же живут тексты помощи вебчата — один источник на оба канала).
4. Пуш → деплой. Регистрировать вебхук заново не нужно: `allowed_updates:
   ["message"]` уже покрывает любые команды.

После каждого рецепта: правка = пуш → деплой → оба канала (вебчат и Telegram)
отвечают по-новому.

---

## 6. Память диалога: посмотреть и почистить руками

Формат (`bot/store.ts`):

- Ключи: `chat:web:{sessionId}` (вебчат; sessionId — uuid из localStorage) и
  `chat:tg:{chatId}` (Telegram).
- Значение — **одна JSON-строка**: массив сообщений `[{"role":"user"|"assistant","content":"…"}, …]`,
  пишется целиком одним SET.
- TTL: env `HISTORY_TTL_SECONDS` (дефолт 86 400 = 24 часа), обновляется при каждой записи.

Руками через Upstash REST (команды передаются **JSON-массивом** в теле POST;
имена переменных зависят от происхождения базы: `UPSTASH_REDIS_REST_URL/TOKEN`
для базы с upstash.com или `KV_REST_API_URL/TOKEN` для базы из Vercel
Marketplace — те же, что в `.env.local` после `npx vercel env pull`; ниже в
примерах `UPSTASH_*`, для Marketplace подставь `KV_REST_API_URL`/`KV_REST_API_TOKEN`):

```bash
# прочитать историю Telegram-диалога
curl -X POST "$UPSTASH_REDIS_REST_URL" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -d '["get","chat:tg:123456789"]'

# удалить ключ (то же, что /reset у бота)
curl -X POST "$UPSTASH_REDIS_REST_URL" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -d '["del","chat:tg:123456789"]'

# проверить живость Redis (ожидаем result "PONG")
curl -X POST "$UPSTASH_REDIS_REST_URL" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -d '["ping"]'

# TTL ключа в секундах
curl -X POST "$UPSTASH_REDIS_REST_URL" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -d '["ttl","chat:web:aabbccdd-1234-5678-9abc-def012345678"]'
```

Токен (`UPSTASH_REDIS_REST_TOKEN`) — секрет: в чат, скриншоты и логи не печатать,
в команды подставлять через переменную окружения, как выше (Git Bash умеет
`export UPSTASH_REDIS_REST_TOKEN=…` в текущей сессии).

Поведение при отсутствии/недоступности Redis — **fail-open**: `runCommand` в
`bot/store.ts` при любой проблеме (нет env, сеть, не-200, ошибка в ответе) возвращает
`null` с `console.warn` (`[store] …`), история считается пустой, запрос не падает.
Бот работает stateless: каждый вопрос — сам по себе, контекста нет. Это же
происходит, если значение ключа битое: `parseHistory` молча превращает его в `[]`.

Почистить историю у пользователя: Telegram — команда `/reset` (удаляет ключ
сразу); вебчат — кнопка «новый диалог» (новый sessionId, старый ключ истечёт по
TTL сам). Напрямую руками — `["del", ключ]` из примера выше.

---

## 7. Локальная разработка (базовый вариант)

Два процесса, vite склеивает их прокси (`vite.config.ts`: `/api` → `127.0.0.1:3000`).
Детали и история «почему не `vercel dev`» — [local-dev.md](local-dev.md).

```bash
# терминал 1 — функция
npm run dev:function
# терминал 2 — сайт
npm run dev        # открыть http://localhost:5173
```

Что делает `bot/dev/dev-function.mjs` на каждом старте:

1. **env**: читает `.env.local` из корня, если есть (кавычки снимает; уже
   выставленные переменные не перекрывает). Нет файла — работает с пустыми env:
   store уйдёт в fail-open, brain — в dumb. Так что «без env тоже можно» — просто
   увидишь офлайн-режим.
2. **компиляция**: чистит `.tmp/dev-function` и компилирует туда `api/bot.ts`
   вместе со всеми импортами из `bot/` (`npx tsc --ignoreConfig api/bot.ts …
   --module nodenext`). Рантайм — нативный Node-лоадер, как на Vercel, поэтому
   забытые `.js`-расширения в импортах ловятся локально.
3. **контент**: копирует в артефакт `bot/brain/knowledge.json` и `bot/brain/prompts/` —
   tsc за собой json/md не тянет, без копии упали бы с `ENOENT` читающие их
   `knowledge.ts` (json) и `prompt.ts` (md).
4. **сервер**: поднимает `node:http` на `127.0.0.1:3000` (переопределяется env
   `DEV_FUNCTION_PORT`) и на каждый запрос конвертирует node req ↔ Request,
   зовёт `default.fetch`, возвращает Response. Ошибка обработчика — 500 и лог
   `[dev-function]`, сервер не умирает.

Проверка без браузера (Git Bash):

```bash
# чипсы и помощь — GET
curl http://127.0.0.1:3000/api/chat
# {"ok":true,"service":"webchat","chips":[{"title":"Услуги"},…],"help":"Я — справка этого сайта…"}

# вопрос — POST (без LLM ожидаем mode:"dumb")
curl -X POST http://127.0.0.1:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-session-01","text":"как связаться"}'
# {"ok":true,"text":"…","mode":"dumb"}
```

Типовые ситуации:

- **Порт 3000 занят** — задай другой: `DEV_FUNCTION_PORT=3010 npm run dev:function`.
  Но vite-прокси смотрит на 3000 из `vite.config.ts` — если меняешь порт функции,
  поменяй и прокси, либо оставь функцию на 3000 и разберись, кто занял порт.
- **Правил `knowledge.json` / `prompts/*.md` / код в `bot/`** — просто перезапусти
  `npm run dev:function`: он пересобирает и перекопирует всё заново при каждом
  старте. Правки контента без перезапуска не подхватятся (файлы читаются в
  артефакт лениво и кэшируются).
- **Локально нет Telegram/Redis** — это нормально: вебчат работает, история —
  stateless, кнопки не потестируешь без туннеля (для этого тестируют на
  preview-деплое, раздел [11](#11-деплой-кратко)).

---

## 8. Локальный llama.cpp (полная инструкция)

Зачем: локальная модель — эксперименты с промтом и справкой без траты токенов и
без сети. llama.cpp поднимает OpenAI-совместимый сервер, который brain вызывает
как обычный провайдер.

### 8.1 Формат LLM_BASE_URL — сверка с кодом

В `bot/config.ts` URL парсится, в `bot/llm.ts` — используется:

```ts
// config.ts: хвостовые / срезаются (и trim заодно)
baseUrl: withoutTrailingSlashes(str(env, "LLM_BASE_URL")),
…
// llm.ts
fetch(`${cfg.baseUrl}/chat/completions`, …)
```

То есть к `LLM_BASE_URL` **всегда дописывается `/chat/completions`**, а базовый
URL обязан уже включать `/v1`. Финальный формат для llama.cpp:

```env
LLM_BASE_URL=http://127.0.0.1:8080/v1
```

- С `/v1`: запрос уйдёт на `http://127.0.0.1:8080/v1/chat/completions` — ровно
  туда, куда отвечает llama-server.
- Без `/v1` (`http://127.0.0.1:8080`): запрос попадёт на
  `/chat/completions` (без префикса) — endpoint не тот, ответ будет не 2xx, и
  brain уйдёт в dumb-режим. Если dumb при живом сервере — первым делом проверь `/v1`.
- `LLM_API_KEY` по коду **не обязателен**: пустая строка/отсутствие →
  `apiKey: undefined` → заголовок `Authorization` вообще не отправляется
  (`...(cfg.apiKey ? { Authorization: Bearer … } : {})`). llama.cpp ключ не
  проверяет, так что можно не задавать вовсе (в `.env.example` стоит
  `LLM_API_KEY=none` — безвредная строка).
- `LLM_MODEL` — обязательна по коду (слайс `config.llm` без неё возвращает null →
  сразу dumb), но llama.cpp игнорирует имя: модель уже загружена файлом при
  старте сервера. Подойдёт `LLM_MODEL=my-model`.
- Таймаут запроса — env `LLM_TIMEOUT_MS` (мс, дефолт 15 секунд,
  `AbortSignal.timeout`). Для медленной локальной модели подними в
  `.env.local`, например `LLM_TIMEOUT_MS=60000`.

### 8.2 Установка llama.cpp на Windows

Готовый билд (рекомендую): взять zip со страницы релизов
[github.com/ggml-org/llama.cpp/releases](https://github.com/ggml-org/llama.cpp/releases)
— там лежат предсобранные архивы для Windows. Какой билд — по твоей видеокарте:

- NVIDIA → билд с **CUDA** (быстрее всего на NVIDIA);
- AMD/Intel или не хочешь ставить драйверные тулкиты → **Vulkan** (кросс-вендорный);
- слабая машина / только CPU → CPU-билд (медленно, но работает).

Распакуй — внутри будет `llama-server.exe` (и набор `llama-*.exe`).

Сборка из исходников (если нужен свежий master) — кратко, по официальному
[docs/build.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md):

```bash
cmake -B build
cmake --build build --config Release
# с GPU: cmake -B build -DGGML_CUDA=ON     (NVIDIA, нужен CUDA toolkit)
#        cmake -B build -DGGML_VULKAN=ON   (нужен Vulkan SDK)
```

### 8.3 Где взять модель

GGUF-модели — с [huggingface.co](https://huggingface.co) (искать «gguf»). Для
справочного бота визитки разумный дефолт — небольшая инструкт-модель в квантовании
**Q4_K_M** (баланс качества и скорости/памяти). Скачанный `*.gguf` положи куда-нибудь
за пределами репозитория.

### 8.4 Запуск сервера

Флаги сверены с официальным README сервера
([tools/server/README.md](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)):

```bash
llama-server -m C:/models/my-model.Q4_K_M.gguf --port 8080
```

- `-m, --model FNAME` — путь к gguf;
- `--port PORT` — порт (по умолчанию 9931, мы задаём 8080);
- `--host HOST` — по умолчанию `127.0.0.1`, для локалки менять не нужно;
- `-c, --ctx-size N` — размер контекста в токенах (по умолчанию берётся из
  модели; на слабой машине можно ограничить, например `-c 4096`);
- `-np, --parallel N` — число слотов (по умолчанию авто).

Сервер готов, когда поднимется и `GET /health` начнёт отвечать `200` с
`{"status":"ok"}` (во время загрузки модели health отвечает `503`).

### 8.5 `.env.local` для локального llama.cpp

Создай `.env.local` в корне (из шаблона `.env.example`, профиль 1):

```env
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_API_KEY=none
LLM_MODEL=my-model

# Память диалогов (Upstash). База из Vercel Marketplace привозит переменные
# KV_REST_API_URL/TOKEN сама после vercel env pull; для базы с upstash.com
# вписывай UPSTASH_REDIS_REST_URL/TOKEN. Для тестов без облака — профиль 3
# из .env.example: UPSTASH_REDIS_REST_URL=http://upstash.fake (in-memory
# заглушка адаптера). Пусто → stateless (fail-open).
# UPSTASH_REDIS_REST_URL=
# UPSTASH_REDIS_REST_TOKEN=

# TELEGRAM_BOT_TOKEN=          # для вебчата не нужны; задавай, только если
# TELEGRAM_WEBHOOK_SECRET=     # хочешь возиться с Telegram локально
```

Важные предупреждения:

- `.env.local` влияет **только на локальный запуск** (`npm run dev:function`
  читает его при старте). Прод-значения живут отдельно в env Vercel и не
  синхронизируются вниз — см. [deploy.md](deploy.md).
- Если раньше делал `npx vercel env pull .env.local` — там лежат прод-секреты
  (ключи Ollama/Upstash/Telegram). На время игр с llama.cpp можешь их закомментировать,
  а после — вернуть. **Не коммить `.env.local` никогда** (он в `.gitignore`, но проверь
  перед `git add -f`).

### 8.6 Проверка живого llama.cpp

```bash
# health — ожидаем {"status":"ok"} (503, пока модель ещё грузится)
curl http://127.0.0.1:8080/health

# минимальный chat/completions — ожидаем JSON c choices[0].message.content
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"my-model","messages":[{"role":"user","content":"Привет!"}]}'
```

### 8.7 Сквозная проверка с ботом

```bash
# терминал 1: llama-server -m … --port 8080
# терминал 2: npm run dev:function
# терминал 3: npm run dev
curl -X POST http://127.0.0.1:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"llama-test-01","text":"кто ты такой"}'
```

Ожидаем `"mode":"llm"` и осмысленный ответ от модели. В логе `dev:function` при
успехе нет строк `[brain]`. Если пришло `"mode":"dumb"` — смотри лог `dev:function`:
там будет `[brain] LLM недоступен (…), отвечаю в dumb-режиме` с причиной:

| Причина в логе `[brain]`                      | Что проверить                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `LLM endpoint вернул 404` (или другой не-2xx) | `/v1` в `LLM_BASE_URL`? Сервер запущен? (`curl /health`)                    |
| Таймаут / «The operation was aborted»         | Первый ответ локальной модели может идти дольше 15 с — см. ниже про прогрев |
| `LLM не настроен`                             | `.env.local` существует и перечитан? Перезапусти `npm run dev:function`     |
| Connection refused / fetch failed             | Сервер не поднят или порт не 8080                                           |

### 8.8 Грабли локального llama.cpp

- **Медленный первый инференс.** Первый запрос после старта сервера — прогрев
  (загрузка весов в GPU/кэш): может легко превысить таймаут brain и уйти в dumb.
  Отправь первый «прогревочный» запрос через curl из 8.6, дождись ответа —
  дальше скорость нормальная. Если медленно постоянно (модель с reasoning легко
  думает дольше 15 с) — подними `LLM_TIMEOUT_MS` в `.env.local`; не помогает —
  модель слишком тяжёлая, бери квант меньше.
- **Контекст модели vs окно истории.** Brain шлёт system-промт + последние 10
  сообщений диалога (`HISTORY_WINDOW`). Промт со всей справкой — уже заметный
  кусок токенов; следи, чтобы `-c` (ctx-size) сервера вмещал промт + 10 сообщений
  - ответ, иначе модель начнёт обрезать контекст и отвечать странно.
- **`LLM_API_KEY` пустой** — это нормально (Bearer не отправится, llama.cpp не
  требует ключа). Не пытайся «починить» несуществующую проблему 401.

---

## 9. Дебаг и диагностика

### 9.1 Админ-маршрут `/api/telegram-setup`

Обработчик — `bot/http/telegram-admin.ts`. Защита — секрет-заголовок
`x-telegram-bot-api-secret-token`, значение обязано совпасть с env
**`TELEGRAM_WEBHOOK_SECRET`** (то же имя переменной, что у вебхука; в коде это
константа `SECRET_HEADER` и `process.env.TELEGRAM_WEBHOOK_SECRET`). Без секрета —
`404 Not Found` (маршрут не подтверждает своё существование), ошибка Telegram API — `502`.

Значение секрета лежит в `.env.local` (прод — в env Vercel). В команды вставлять
руками не надо — читай из файла (как в runbook):

```bash
cd /c/IT/covskiy-folio
SECRET=$(sed -n 's/^TELEGRAM_WEBHOOK_SECRET=//p' .env.local | head -n1 | sed -e 's/\r$//' -e 's/^"//' -e 's/"$//')

# health: LLM + Redis + Telegram параллельно
curl -sS "https://covskiy-folio.vercel.app/api/telegram-setup?section=health" \
  -H "x-telegram-bot-api-secret-token: $SECRET"

# собранный system-промт (целиком, со справкой)
curl -sS "https://covskiy-folio.vercel.app/api/telegram-setup?section=prompt" \
  -H "x-telegram-bot-api-secret-token: $SECRET"

# состояние вебхука (getWebhookInfo) — без section
curl -sS "https://covskiy-folio.vercel.app/api/telegram-setup" \
  -H "x-telegram-bot-api-secret-token: $SECRET"

# (пере)регистрация вебхука на текущий origin
curl -sS -X POST "https://covskiy-folio.vercel.app/api/telegram-setup" \
  -H "x-telegram-bot-api-secret-token: $SECRET"
```

Расшифровка `?section=health` (`{llm, redis, telegram}`, считаются параллельно,
ошибка одного не валит остальные):

| Поле       | `ok: true`                                                                                | `ok: false` и что значит                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm`      | `latencyMs` + `detail: "GET /models"` или `"POST /chat/completions (минимальный запрос)"` | `error: "не настроен…"` (нет `LLM_BASE_URL`/`LLM_MODEL`), `error: "endpoint вернул …"` (не-2xx), либо текст сетевой ошибки. Таймаут каждой пробы — 10 с (`ping` из `bot/llm.ts`) |
| `redis`    | `latencyMs` (PING → PONG)                                                                 | `reason: "не настроен…"` (нет `UPSTASH_REDIS_REST_*` / `KV_REST_API_*`) или `"нет ответа PONG…"` (детали — в warn-логах `[store]`). `ping()` из `bot/store.ts`                   |
| `telegram` | `webhook: {url, pending_update_count, …}`                                                 | `error` — текст исключения от Bot API (обычно «TELEGRAM_BOT_TOKEN не задан» или ошибка сети до api.telegram.org)                                                                 |

`vercel.app` из локальной сети может резаться (RST на TLS) — ретраить команду;
если совсем никак — socks5-вариант из
[telegram-webhook-runbook.md](telegram-webhook-runbook.md).

### 9.2 Логи Vercel

Где: дашборд → проект → Observability → Logs (на Hobby retention 1 час — смотреть
сразу после воспроизведения) или `npx vercel logs <deployment-url>`. Характерные
строки (префиксы — по модулям). Уровень по умолчанию — **warn** (деградации и
ошибки); per-update трейсы и dump'ы — уровень **debug**, видны при env
`LOG_LEVEL=debug` (на Vercel: `vercel env add LOG_LEVEL production` + Redeploy,
после диагностики вернуть):

| Строка в логе                                                                                     | Кто пишет / что значит                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[brain] LLM недоступен (…), отвечаю в dumb-режиме`                                               | `bot/brain/brain.ts`: LLM не настроен / не-2xx / таймаут `LLM_TIMEOUT_MS` (дефолт 15 с) / пустой ответ. В скобках — точная причина                                                                                                                                                                               |
| `[brain] system-промт не собран (…), отвечаю в dumb-режиме`                                       | `bot/brain/brain.ts`: ошибка сборки system-промта — битый плейсхолдер `{{KNOWLEDGE}}` или недоступный md-раздел ([5.3](#53-изменить-структуру-промта--добавить-файл-часть)). LLM при этой ошибке не вызывался: ошибка контента логируется честно, а не как «LLM недоступен». Dumb отвечает по справке как обычно |
| `[store] Upstash Redis не настроен (…)`                                                           | `bot/redis-rest.ts` (префикс `store`): нет env → штатный stateless-режим                                                                                                                                                                                                                                         |
| `[store] Upstash REST вернул …` / `Upstash недоступен (…)` / `Upstash вернул ошибку (…)`          | `bot/redis-rest.ts`: Redis не отвечает — бот работает, но без истории (fail-open)                                                                                                                                                                                                                                |
| `ENOENT … knowledge.json` или `…prompts/…md`                                                      | Файл контента не попал в артефакт: забыл пуш файла / не упомянул путь литералом (`knowledge.json` — в `bot/brain/knowledge.ts`, md-разделы — в `bot/brain/prompt.ts`) → см. [5.3](#53-изменить-структуру-промта--добавить-файл-часть)                                                                            |
| `[telegram-webhook] апдейт от …` / `ответ отправлен в …`                                          | `bot/http/telegram-webhook.ts`: апдейт получен и обработан — норма. **debug** — виден при `LOG_LEVEL=debug`                                                                                                                                                                                                      |
| `[telegram-admin] getWebhookInfo: {…}`                                                            | `bot/http/telegram-admin.ts`: dump ответа Bot API. **debug** — виден при `LOG_LEVEL=debug`                                                                                                                                                                                                                       |
| `[telegram-admin] вебхук установлен: …`                                                           | `bot/http/telegram-admin.ts`: setWebhook прошёл. **info** — виден при `LOG_LEVEL=info` и выше                                                                                                                                                                                                                    |
| `[telegram-webhook] не смог снять клавиатуру (…)`                                                 | Сбой `editMessageText` — некритичная косметика                                                                                                                                                                                                                                                                   |
| `[telegram-admin] TELEGRAM_WEBHOOK_SECRET не задан в env` / `отклонён запрос с неверным секретом` | `bot/http/telegram-admin.ts`: кто-то стучится в админ-маршрут без секрета (или env потерялся — тогда Redeploy)                                                                                                                                                                                                   |
| `ERR_MODULE_NOT_FOUND` + 500 на любой `/api/*`                                                    | Забытое расширение `.js` в относительном импорте — см. таблицу типовых поломок ниже                                                                                                                                                                                                                              |

Помни: md/json-контент читается лениво и кэшируется на тёплый инстанс
(чтение справки — `bot/brain/knowledge.ts`, сборка промта — `prompt.ts`) — если
файл доехал до прод только что, тёплый
инстанс его не перечитает; новый деплой поднимает новые инстансы, так что
лечится само. Локально аналог — перезапуск `npm run dev:function`.

### 9.3 `mode=dumb` как симптом

Бейдж «офлайн-справка» в вебчате / отсутствие LLM-ответа. Все причины разом:

1. **LLM не настроен** — env `LLM_BASE_URL` или `LLM_MODEL` пусты (слайс
   `config.llm` в `bot/config.ts` вернёт null). Добавил переменные? Нужен
   Redeploy: env запекается в деплой, просто «сохранить» мало (раздел [11](#11-деплой-кратко)).
2. **LLM недоступен** — endpoint отвечает не-2xx или сеть недоступна. Проверь
   health `?section=health` и URL (прод: `https://ollama.com/v1`).
3. **Таймаут** — дефолт 15 с, поднимается env `LLM_TIMEOUT_MS`; медленный
   провайдер/модель; локальный llama.cpp — прогрев
   (раздел [8.8](#88-грабли-локального-llamacpp)).
4. **Файлы промта/справки затерялись в артефакте** — `ENOENT` в логах: md/json не
   запушен или путь не литеральный (`knowledge.json` — в `knowledge.ts`,
   md-разделы — в `prompt.ts`, см. [5.3](#53-изменить-структуру-промта--добавить-файл-часть)).
   Локально не ловится — локальные проверки файлы видят на диске.
5. **Пустой ответ LLM** — endpoint вернул 2xx без `choices[0].message.content`.
6. **Сломан плейсхолдер промта** — в логах `system-промт не собран
   ({{KNOWLEDGE}} должен встречаться ровно 1 раз, найдено: N)`
   ([5.3](#53-изменить-структуру-промта--добавить-файл-часть)): md-файл правили
   мимо контракта. Сборка промта — отдельный шаг до вызова LLM, поэтому лог
   честный (не «LLM недоступен») и LLM при этой ошибке не вызывается. Dumb при
   этом отвечает по справке как обычно.

При dumb сайт и бот **продолжают работать** — это фича, а не авария: dumb-режим
отвечает по справке без сети, а промах поиска не оставляет без выхода — fallback
приходит с подсказками тем (до 3 чипсов/кнопок), среди которых гарантированно
есть контакт (запись с `contact: true`). Но если dumb стал постоянным — идём по
списку.

### 9.4 Типовые поломки таблицей

| Симптом                              | Вероятная причина                                                                                                           | Действие                                                                                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Бот всегда «офлайн-справка»          | Env `LLM_*` не заданы/не запеклись; endpoint лежит; `/v1` потерялся в URL; md-файл ENOENT                                   | `?section=health` → логи `[brain]` → Redeploy после правки env; llama.cpp — раздел [8](#8-локальный-llamacpp-полная-инструкция)                                                        |
| Бот не помнит диалог                 | Redis не настроен/недоступен (fail-open, stateless); TTL 24 ч истёк                                                         | `?section=health` → `redis`; warn-логи `[store]`; руками — раздел [6](#6-память-диалога-посмотреть-и-почистить-руками)                                                                 |
| Telegram молчит                      | Вебхук снят/смотрит не туда; секрет не совпадает (401); функция падает                                                      | `GET /api/telegram-setup` (getWebhookInfo) → [telegram-webhook-runbook.md](telegram-webhook-runbook.md) → перерегистрировать POST-ом; после смены `TELEGRAM_WEBHOOK_SECRET` — Redeploy |
| Кнопки в Telegram не нажимаются      | Вебхук зарегистрирован без `allowed_updates: ["message","callback_query"]` (старая регистрация) — callback_query не доходит | Перерегистрировать: `POST /api/telegram-setup` — он выставит правильный список; проверить `getWebhookInfo`                                                                             |
| Чипсы пустые                         | `fetchChatBootstrap()` молча получил не-2xx; справка недоступна или нет пометок `chip`                                      | `curl https://…/api/chat` — есть ли `chips` и `help`; проверить `bot/brain/knowledge.json` (пометки `chip`) и логи `[knowledge]`                                                       |
| 500 на `/api/*`                      | `ERR_MODULE_NOT_FOUND`: забыли `.js` в относительном импорте `api/`/`bot/`                                                  | См. ниже. Локально ловится только `npm run dev:function` (нативный лоадер) — vite/vitest/tsc расширение прощают                                                                        |
| «Промт не поменялся» после правки md | Кэш тёплого инстанса; либо файл не уехал в артефакт                                                                         | Проверить `?section=prompt`; если старое — само пройдёт; если ENOENT — [5.3](#53-изменить-структуру-промта--добавить-файл-часть)                                                       |

Про `.js`-расширения подробнее. Проект — нативный ESM (`"type": "module"`):
Vercel запускает функцию голым Node-лоадером, а тот требует расширения в
относительных импортах (`"../bot/http/webchat.js"` в `api/bot.ts`). Без расширения —
`ERR_MODULE_NOT_FOUND` и 500 на **любом** запросе к функции. Локально vite
(фронт), vitest и tsc расширение прощают — прод-падение локальными проверками не
поймать. Поэтому: относительные импорты в `api/` и `bot/` — только с `.js`, а
после любых новых импортов — прогнать `npm run dev:function` и дёрнуть
`curl http://127.0.0.1:3000/api/chat` (нативная загрузка как на проде).

### 9.5 Проверка вебхука

1. `GET /api/telegram-setup` (с секрет-заголовком) → `getWebhookInfo`: должен быть
   `url` (прод: `https://covskiy-folio.vercel.app/api/telegram`), маленький
   `pending_update_count`, отсутствие `last_error_message`/`last_error_date`.
2. Тест на preview-деплое перекидывает вебхук с прода (вебхук у бота один!) —
   после теста верни его обратно POST-ом на прод-URL. Подробно —
   [telegram-webhook-runbook.md](telegram-webhook-runbook.md) и
   [architecture.md](architecture.md) → «Грабли платформы».
3. Смена `TELEGRAM_WEBHOOK_SECRET` в env без Redeploy = все запросы начнут
   получать 401 (функция ещё держит старое значение).

---

## 10. Тесты

```bash
npm run test         # один прогон (vitest run)
npm run test:watch   # следить за изменениями
```

Сеть в тестах не используется — двумя способами. Обработчики и «мозг» принимают
зависимости через фабрики-инъекции: тесты подставляют явные фейки store/brain/tg/
лимитера/справки вместо стабов. Транспорты, дотягивающиеся до глобального `fetch`
(llm, redis-rest), подменяются `vi.stubGlobal`/`fetchImpl`. env — через
`vi.stubEnv`, роутер `api/bot.ts` — через `vi.mock` обработчиков. Для Upstash
есть образцовый стаб `stubUpstash` в `bot/tests/store.test.ts`: он парсит
JSON-массив команды из тела POST и возвращает заготовленный Response — именно
так проверяется REST-протокол store.

Покрытие — 243 теста в 15 файлах (`bot/tests/`):

| Файл                                 | Сколько | Что покрывает                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot/tests/config.test.ts`           | 21      | Слайсы config: парсинг env (trim, срез слэшей, числа с дефолтом), приоритет UPSTASH-семейства, ленивые геттеры (stubEnv после createConfig остаётся видимым)                                                                                                         |
| `bot/tests/llm.test.ts`              | 14      | Транспорт LLM: `chat` (payload, Bearer, не-2xx, пустой ответ), `ping` (GET /models → минимальный chat, latency, «не настроен»)                                                                                                                                       |
| `bot/tests/log.test.ts`              | 8       | Порог из LOG_LEVEL (в т.ч. мусор → warn), warnThrottled (интервал, ключи, независимые инстансы), дефолтный log через vi.stubEnv                                                                                                                                      |
| `bot/tests/redis-rest.test.ts`       | 19      | Транспорт Upstash REST: command/pipeline, Bearer из токена, fail-open (null + warn), throttle-ключи, резолв deps на вызов                                                                                                                                            |
| `bot/tests/store.test.ts`            | 28      | Домен истории: ключи `webKey`/`tgKey`, TTL-константа, капы записи, парсинг битой истории, дедупликация, incrCounter, ping, фабрика                                                                                                                                   |
| `bot/tests/knowledge.test.ts`        | 21      | Безопасное чтение (кэш исхода, null при битом JSON), валидация формы (title/text, slug id, дубликаты, пометки chip/about, keywords, contact), `uiTopics`, смоук реального JSON                                                                                       |
| `bot/tests/prompt.test.ts`           | 6       | Сборка на фикстурных md, контракт плейсхолдера (ровно один — иначе бросок с причиной), смоук реальных md                                                                                                                                                             |
| `bot/tests/brain.test.ts`            | 22      | payload в LLM (system+история+вопрос), ошибка транспорта → dumb, оркестрация search (порог 0.3, ответ `title + text`), подсказки fallback (near-miss → contact → uiTopics), честный лог «system-промт не собран», справка недоступна → безопасный ответ (не бросает) |
| `bot/tests/search.test.ts`           | 27      | Ранжирование `rankKnowledge`: корпус вопросов («Сколько стоит?» → pricing и т.п.), нормализация и стемминг, скоринг и tie-break, детерминированность, смоук реального knowledge.json (каждая запись находится по своему title)                                       |
| `bot/tests/help.test.ts`             | 5       | Тексты помощи: непустые, без секретов, текст вебчата без Telegram-команд, запасной текст не пуст; импорт модуля не тянет LLM/сеть/env                                                                                                                                |
| `bot/tests/webchat.test.ts`          | 19      | GET (чипсы + help; недоступная справка → 200, help остаётся), валидация sessionId/text (включая границу 2000), suggestions только у dumb-fallback ({title}, без подсказок поля нет), поток история→LLM→append, Origin/rate-limit, fail-open                          |
| `bot/tests/telegram-webhook.test.ts` | 31      | секрет-заголовок, команды (/help — текст + кнопки тем; в историю не пишутся), кнопки `ask:{id}` и ветки деградации, подсказки dumb-fallback → inline-клавиатура, свободный текст, 2xx при ошибках                                                                    |
| `bot/tests/telegram-api.test.ts`     | 4       | Транспорт Bot API: резка длинных сообщений, retry_after в тексте ошибки, разбор ok:false                                                                                                                                                                             |
| `bot/tests/telegram-admin.test.ts`   | 13      | 404 без секрета, health/prompt/вебхук по `section` (справка недоступна → 502), POST setWebhook, 502 при ошибке Telegram                                                                                                                                              |
| `bot/tests/api-router.test.ts`       | 5       | роутинг `api/bot.ts` по pathname, 404 на неизвестный путь, бросок обработчика → контрактный 500 с записью в лог                                                                                                                                                      |

Добавить тест под свой сценарий: открой ближайший по теме файл, скопируй
соседний `it(...)` и замени стаб/ассерты. Для store-сценариев бери `stubUpstash`
из `bot/tests/store.test.ts`; для brain/webhook/admin — харнессы `makeHarness`
с инъекцией фейков; для знаний/промта — `makeKnowledge`/`fixtureRead` с инъекцией
чтения файлов. Тесты идут в pre-commit, так что без них коммит не пройдёт.

Полный набор перед коммитом (husky прогоняет сам, но можно и руками):

```bash
npm run format:check   # форматирование (oxfmt)
npm run lint           # oxlint
npm run typecheck      # tsc --noEmit, strict
npm run test           # vitest
```

Сообщение коммита — Conventional Commits (`feat|fix|docs|chore|…: описание`),
проверяет commitlint в хуке `commit-msg`. Пуш — только по явному согласованию.

---

## 11. Деплой (кратко)

Полный пошаговый сценарий — [deploy.md](deploy.md). Коротко, что помнить каждый день:

- Цепочка: рабочая копия → `origin` (локальный bare) → GitHub; пуш в `main` = прод.
- Каждое `git push` в `main` — автодеплой; ветки (не main) получают preview-URL
  (commit-URL + стабильный branch-URL).
- Контент (`knowledge.json`, `prompts/*.md`) и env **запекаются в деплой**:
  поменял env в дашборде/CLI — нужен Redeploy (Deployments → ⋯ → Redeploy).
- Upstash Redis удобнее через Vercel Marketplace (Storage → Create Database →
  Upstash Redis) — env провижинятся сами; иначе `npx vercel env add …`.
- Telegram-бот на preview: вебхук у бота один — тест на preview перекидывает его
  с прода; после теста вернуть POST-ом на прод (раздел [9.5](#95-проверка-вебхука)).
- Проверка после деплоя: сайт открывается, чат отвечает, `GET /api/chat` отдаёт
  чипсы, боту в Telegram — `/start`.

---

## Куда смотреть дальше

- [architecture.md](architecture.md) — почему так устроено (одна функция, fail-open,
  трейсинг файлов, грабли платформы).
- [deploy.md](deploy.md) — деплой с нуля.
- [local-dev.md](local-dev.md) — локальная разработка и ручная симуляция рантайма.
- [telegram.md](telegram.md) — создание бота у BotFather и секрет вебхука.
- [telegram-webhook-runbook.md](telegram-webhook-runbook.md) — регистрация/диагностика
  вебхука, обход блокировки vercel.app.
