import "./chat.css";
import { askChat, loadHistory, saveHistory, type ChatMessage } from "./chat-api";

const GREETING =
  "Привет! Я справка этого сайта — отвечу на вопросы о владельце. Спроси что-нибудь 🙂";
const ERROR_TEXT = "Не получилось связаться с сервером. Попробуй ещё раз чуть позже.";

export function mountChatWidget(): void {
  const root = document.createElement("div");
  root.className = "chat";
  root.innerHTML = `
    <button class="chat__toggle" type="button" aria-label="Открыть чат">💬</button>
    <section class="chat__panel" hidden aria-label="Чат-справка">
      <header class="chat__header">
        <span class="chat__title">Справка</span>
        <button class="chat__close" type="button" aria-label="Закрыть чат">✕</button>
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

  let history: ChatMessage[] = loadHistory();
  let busy = false;
  let opened = false;

  function scrollToEnd(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setOpened(open: boolean): void {
    opened = open;
    panelEl.hidden = !open;
    toggleEl.classList.toggle("is-open", open);
    if (open) {
      inputEl.focus();
      scrollToEnd();
    }
  }

  toggleEl.addEventListener("click", () => setOpened(!opened));
  root.querySelector(".chat__close")!.addEventListener("click", () => setOpened(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpened(false);
  });

  function addMessage(message: ChatMessage): void {
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

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = inputEl.value.trim();
    if (!content || busy) return;

    busy = true;
    inputEl.value = "";

    const userMessage: ChatMessage = { role: "user", content };
    history.push(userMessage);
    saveHistory(history);
    addMessage(userMessage);

    const typing = showTyping();
    try {
      const { text, mode } = await askChat(history);
      typing.remove();
      const reply: ChatMessage = { role: "assistant", content: text, mode };
      history.push(reply);
      saveHistory(history);
      addMessage(reply);
    } catch {
      typing.remove();
      addMessage({ role: "assistant", content: ERROR_TEXT });
    } finally {
      busy = false;
      inputEl.focus();
    }
  });

  // Восстановить прошлую переписку или показать приветствие (в историю не пишем)
  if (history.length === 0) {
    addMessage({ role: "assistant", content: GREETING });
  } else {
    history.forEach(addMessage);
  }
}
