// Единое определение сообщения диалога живёт в store.ts — дублировать нельзя.
import type { ChatMessage } from "../store.js";
import type { LlmProviderSettings } from "../config.js";

/**
 * Сообщение для LLM-протокола: история диалога (ChatMessage, user/assistant)
 * плюс system-промт, который в историю не пишется и потому в ChatMessage
 * не входит. Источник ролей всё равно один — store.ts.
 *
 * Живёт здесь, а не в фасаде: адаптеру нужен тип сообщений, а импорт из
 * `llm/index.ts` дал бы цикл index → openai → index. Фасад реэкспортирует тип,
 * поэтому публичный путь импорта не меняется.
 */
export type LlmMessage = ChatMessage | { role: "system"; content: string };

/**
 * Результат одной пробы провайдера (без latencyMs: её меряет цепочка вокруг
 * вызова адаптера, чтобы clock инжектировался в одном месте).
 */
export interface LlmProbe {
  /** true — провайдер ответил успешно хотя бы на одну из проб. */
  ok: boolean;
  /** Какая проба сработала (GET /models или минимальный chat/completions). */
  detail?: string;
  /** Причина отказа: статус endpoint / текст ошибки сети. Без секретов. */
  error?: string;
}

/** Контракт протокола провайдера: один адаптер на KIND. */
export interface LlmAdapter {
  /**
   * Запрос chat/completions с готовым массивом сообщений.
   * @throws при любой проблеме: сеть, таймаут, не-2xx, пустой ответ.
   */
  chat(
    settings: LlmProviderSettings,
    messages: LlmMessage[],
    opts: { maxTokens: number; timeoutMs: number },
  ): Promise<string>;

  /** Дешёвая проверка доступности; никогда не бросает. */
  probe(settings: LlmProviderSettings, opts: { timeoutMs: number }): Promise<LlmProbe>;
}

/** Зависимости адаптера — точка подмены сети в тестах. */
export interface LlmAdapterDeps {
  /** Подмена сети; по умолчанию глобальный fetch (резолв на каждый вызов). */
  fetchImpl?: typeof fetch;
}

/** Фабрика адаптера; реестр KIND → фабрика живёт в llm/index.ts. */
export type LlmAdapterFactory = (deps?: LlmAdapterDeps) => LlmAdapter;
