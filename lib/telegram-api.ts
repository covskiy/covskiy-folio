// Явный импорт вместо "types" в tsconfig: резолв @types не должен зависеть
// от окружения сборки (на Vercel tsc запускается из другого cwd).
import process from "node:process";

const API_ROOT = "https://api.telegram.org";

export interface TgChat {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
}

async function tgCall<T>(method: string, payload: unknown): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");

  const response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await response.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
  };
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? response.status}`);
  }
  return data.result as T;
}

export function sendMessage(chatId: number, text: string): Promise<TgMessage> {
  return tgCall<TgMessage>("sendMessage", { chat_id: chatId, text });
}

export interface TgWebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

export function setWebhook(params: {
  url: string;
  secret_token?: string;
  allowed_updates?: string[];
}): Promise<boolean> {
  return tgCall<boolean>("setWebhook", params);
}

export function getWebhookInfo(): Promise<TgWebhookInfo> {
  return tgCall<TgWebhookInfo>("getWebhookInfo", {});
}
