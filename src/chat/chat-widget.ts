import "./chat.css";
import { askChat, fetchChips, getSessionId, renewSessionId, type ChatChip } from "./chat-api";

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
  let chipsLoaded = false;
  let chipsEl: HTMLElement | null = null;

  function scrollToEnd(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setOpened(open: boolean): void {
    opened = open;
    panelEl.hidden = !open;
    toggleEl.classList.toggle("is-open", open);
    if (open) {
      // Чипсы — один раз за жизнь страницы, при первом разворачивании.
      if (!chipsLoaded) {
        chipsLoaded = true;
        void renderChips();
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

  async function renderChips(): Promise<void> {
    // Чипсы уместны только в пустом диалоге: после первого вопроса убираем.
    if (chipsEl) chipsEl.remove();
    const chips = await fetchChips();
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

  function showGreeting(): void {
    addMessage({ role: "assistant", content: GREETING });
  }

  // Кнопка «новый диалог»: новый sessionId — старый ключ Redis истечёт по TTL.
  root.querySelector(".chat__new")!.addEventListener("click", () => {
    if (busy) return;
    sessionId = renewSessionId();
    messagesEl.innerHTML = "";
    chipsEl = null;
    showGreeting();
    void renderChips();
    inputEl.focus();
  });

  async function sendMessage(content: string): Promise<void> {
    busy = true;

    const userMessage: BubbleMessage = { role: "user", content };
    addMessage(userMessage);
    // Диалог начался — чипсы-подсказки больше не нужны.
    chipsEl?.remove();
    chipsEl = null;

    const typing = showTyping();
    try {
      const { text, mode } = await askChat(sessionId, content);
      typing.remove();
      addMessage({ role: "assistant", content: text, mode });
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
    void sendMessage(content);
  });

  showGreeting();
}
