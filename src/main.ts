import "./style.css";
import { mountChatWidget } from "./chat/chat-widget";

// Год в футере на каждой странице
for (const el of document.querySelectorAll<HTMLElement>("[data-year]")) {
  el.textContent = String(new Date().getFullYear());
}

mountChatWidget();
