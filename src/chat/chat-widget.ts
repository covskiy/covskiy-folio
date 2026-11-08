import "./chat.css";
import {
  askChat,
  fetchChatBootstrap,
  getSessionId,
  renewSessionId,
  type ChatBootstrap,
  type ChatChip,
} from "./chat-api";
// Единый источник текста помощи на оба канала: bot/brain/help.ts — модуль без
// импортов и node-зависимостей, поэтому в бандл клиента уходит только строковая
// константа, а не серверный код (дублировать текст помощи в src/ не нужно).
import { HELP_TEXT_WEBCHAT_FALLBACK } from "../../bot/brain/help.js";

const GREETING =
  "Привет! Я справка этого сайта — отвечу на вопросы о владельце. Спроси что-нибудь 🙂";
const ERROR_TEXT = "Не получилось связаться с сервером. Попробуй ещё раз чуть позже.";

interface BubbleMessage {
  role: "user" | "assistant";
  content: string;
  /** Только у ответов: 'dumb' — офлайн-справка без нейросети */
  mode?: "llm" | "dumb";
}

/**
 * Монтирует плавающий чат-виджет в <body>: кнопка-тумблер, панель с историей
 * сообщений, чипсами-подсказками и формой отправки. Транскрипт на странице —
 * только до перезагрузки (история диалога держит сервер в Redis по sessionId
 * из localStorage, TTL 24 ч); кнопка «Новый диалог» меняет sessionId.
 * Бутстрап (чипсы + текст помощи) грузится с GET /api/chat один раз за жизнь
 * страницы; помощь «?» и локальные команды /help, /start обходятся без POST.
 * Ошибка сети показывается системным сообщением в чате, виджет не падает.
 */
export function mountChatWidget(): void {
  const root = document.createElement("div");
  root.className = "chat";
  root.innerHTML = `
    <button class="chat__toggle" type="button" aria-label="Открыть чат">💬</button>
    <section class="chat__panel" hidden aria-label="Чат-справка">
      <header class="chat__header">
        <span class="chat__title">Справка</span>
        <span class="chat__header-actions">
          <button class="chat__help" type="button" aria-label="Помощь" title="Помощь">?</button>
          <button class="chat__new" type="button" aria-label="Новый диалог" title="Новый диалог">⟳</button>
          <button class="chat__close" type="button" aria-label="Закрыть чат">✕</button>
        </span>
      </header>
      <div class="chat__messages" role="log" aria-live="polite"></div>
      <form class="chat__form">
        <input class="chat__input" type="text" placeholder="Спросите что-нибудь…"
               autocomplete="off" maxlength="2000" />
        <button class="chat__send" type="submit" aria-label="Отправить">➤</button>
      </form>
    </section>
  `;
  document.body.append(root);

  const toggleEl = root.querySelector<HTMLButtonElement>(".chat__toggle")!;
  const panelEl = root.querySelector<HTMLElement>(".chat__panel")!;
  const messagesEl = root.querySelector<HTMLDivElement>(".chat__messages")!;
  const formEl = root.querySelector<HTMLFormElement>(".chat__form")!;
  const inputEl = root.querySelector<HTMLInputElement>(".chat__input")!;

  // sessionId переживает перезагрузку (localStorage), сам транскрипт — нет:
  // контекст диалога держит сервер в Redis (TTL 24ч), перезагрузка → пустой виджет.
  let sessionId = getSessionId();
  let busy = false;
  let opened = false;
  // Текущий ряд чипов (стартовые чипсы или подсказки dumb-fallback — один
  // элемент .chat__chips над формой); null — на экране его нет.
  let chipsEl: HTMLElement | null = null;
  // Чипсы уместны только в пустом диалоге: показываются при первом
  // разворачивании и после «нового диалога»; начатый диалог переоткрытию
  // панели чипсы не возвращает.
  let chipsShown = false;
  // Бутстрап (чипсы + help) — один сетевой запрос за жизнь страницы: промт
  // мемоизируется, повторные клики «?» и переоткрытия читают кэш.
  let bootstrapPromise: Promise<ChatBootstrap> | null = null;

  function ensureBootstrap(): Promise<ChatBootstrap> {
    bootstrapPromise ??= fetchChatBootstrap();
    return bootstrapPromise;
  }

  function scrollToEnd(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setOpened(open: boolean): void {
    opened = open;
    panelEl.hidden = !open;
    toggleEl.classList.toggle("is-open", open);
    if (open) {
      if (!chipsShown) {
        chipsShown = true;
        void ensureBootstrap().then((data) => {
          // Пока бутстрап летел, диалог мог начаться (busy) или «?» уже
          // нарисовал свои чипсы (chipsEl) — тогда ничего не добавляем.
          if (opened && !busy && !chipsEl) renderChips(data.chips);
        });
      }
      inputEl.focus();
      scrollToEnd();
    }
  }

  toggleEl.addEventListener("click", () => setOpened(!opened));
  root.querySelector(".chat__close")!.addEventListener("click", () => setOpened(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpened(false);
  });

  function addMessage(message: BubbleMessage): void {
    const bubble = document.createElement("div");
    bubble.className = `chat__msg chat__msg--${message.role}`;

    const text = document.createElement("p");
    text.className = "chat__text";
    text.textContent = message.content;
    bubble.append(text);

    if (message.role === "assistant" && message.mode === "dumb") {
      const badge = document.createElement("span");
      badge.className = "chat__badge";
      badge.textContent = "офлайн-справка";
      bubble.append(badge);
    }

    messagesEl.append(bubble);
    scrollToEnd();
  }

  function showTyping(): HTMLElement {
    const bubble = document.createElement("div");
    bubble.className = "chat__msg chat__msg--assistant chat__msg--typing";
    bubble.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.append(bubble);
    scrollToEnd();
    return bubble;
  }

  // Чипсы-подсказки и подсказки dumb-fallback — один ряд над формой: любая
  // новая реплика (вопрос, команда, помощь) убирает предыдущий ряд.
  function removeChips(): void {
    chipsEl?.remove();
    chipsEl = null;
  }

  // Ряд чипов из готового списка (бутстрап или подсказки dumb-fallback):
  // синхронный — сетевого запроса внутри нет, данные уже на клиенте.
  function renderChips(chips: ChatChip[]): void {
    removeChips();
    if (chips.length === 0) return;
    chipsEl = document.createElement("div");
    chipsEl.className = "chat__chips";
    for (const chip of chips) {
      chipsEl.append(renderChip(chip));
    }
    messagesEl.append(chipsEl);
    scrollToEnd();
  }

  // Клик по чипу = отправить его текст как обычный вопрос.
  function renderChip(chip: ChatChip): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat__chip";
    button.textContent = chip.title;
    button.addEventListener("click", () => {
      if (!busy) void sendMessage(chip.title);
    });
    return button;
  }

  // Кнопка «?» — offline-помощь об интерфейсе: текст помощи из бутстрапа
  // (пустой или неответивший GET подменяется запасным текстом из bot/brain/help.ts)
  // плюс чипсы тем, если они есть. В POST не ходит и в серверную историю не
  // попадает; busy не даёт вставить помощь между вопросом и ответом в полёте
  // и гасит двойной клик.
  async function showHelp(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const data = await ensureBootstrap();
      removeChips();
      addMessage({ role: "assistant", content: data.help || HELP_TEXT_WEBCHAT_FALLBACK });
      renderChips(data.chips);
    } finally {
      busy = false;
      inputEl.focus();
    }
  }

  root.querySelector(".chat__help")!.addEventListener("click", () => {
    void showHelp();
  });

  function showGreeting(): void {
    addMessage({ role: "assistant", content: GREETING });
  }

  // Кнопка «новый диалог»: новый sessionId — старый ключ Redis истечёт по TTL.
  root.querySelector(".chat__new")!.addEventListener("click", () => {
    if (busy) return;
    sessionId = renewSessionId();
    messagesEl.innerHTML = "";
    chipsEl = null;
    // Чипсы нового диалога рисуются ниже; переоткрытию панели они не нужны.
    chipsShown = true;
    showGreeting();
    // Чипсы — из уже загруженного бутстрапа: новый сетевой запрос не нужен.
    void ensureBootstrap().then((data) => {
      if (!busy && !chipsEl) renderChips(data.chips);
    });
    inputEl.focus();
  });

  // Локальные команды вебчата — только точное совпадение после trim() и
  // toLowerCase(): «/help extra» уходит в POST обычным вопросом. Команда видна
  // как реплика пользователя, ответ ассистента локальный: в POST и серверную
  // историю она не ходит.
  async function runLocalCommand(content: string, command: "/help" | "/start"): Promise<void> {
    busy = true;
    try {
      const data = await ensureBootstrap();
      removeChips();
      addMessage({ role: "user", content });
      if (command === "/start") {
        addMessage({ role: "assistant", content: GREETING });
      } else {
        addMessage({ role: "assistant", content: data.help || HELP_TEXT_WEBCHAT_FALLBACK });
      }
      renderChips(data.chips);
    } finally {
      busy = false;
      inputEl.focus();
    }
  }

  async function sendMessage(content: string): Promise<void> {
    busy = true;

    const userMessage: BubbleMessage = { role: "user", content };
    addMessage(userMessage);
    // Диалог начался — чипсы и старые подсказки больше не нужны.
    removeChips();

    const typing = showTyping();
    try {
      const { text, mode, suggestions } = await askChat(sessionId, content);
      typing.remove();
      addMessage({ role: "assistant", content: text, mode });
      // Подсказки dumb-fallback: тот же ряд чипов, клик — обычный вопрос.
      // askChat отдаёт suggestions только непустыми, поэтому проверки длины не нужно.
      if (suggestions) renderChips(suggestions);
    } catch {
      typing.remove();
      addMessage({ role: "assistant", content: ERROR_TEXT });
    } finally {
      busy = false;
      inputEl.focus();
    }
  }

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = inputEl.value.trim();
    if (!content || busy) return;
    inputEl.value = "";
    const command = content.toLowerCase();
    if (command === "/help" || command === "/start") {
      void runLocalCommand(content, command);
      return;
    }
    void sendMessage(content);
  });

  showGreeting();
}
