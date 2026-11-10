// config — готовый типизированный слайс llm; дефолтный инстанс для рантайма.
import {
  config,
  type AppConfig,
  type LlmProviderKind,
  type LlmProviderSettings,
} from "../config.js";
import { log as rootLog, type Logger } from "../log.js";
import { createOpenAiAdapter } from "./openai.js";
import type { LlmAdapterFactory, LlmMessage } from "./types.js";

export type { LlmAdapter, LlmAdapterDeps, LlmMessage, LlmProbe } from "./types.js";

/**
 * Транспорт LLM — фасад над цепочкой OpenAI-совместимых провайдеров
 * (Ollama Cloud, Cloudflare Workers AI, llama.cpp, …). Единственное место, где
 * решается, К КОМУ идти: порядок слотов LLM_1_*…LLM_9_*, fallback на любую
 * ошибку, общий бюджет времени и cooldown упавшего провайдера.
 *
 * Никакой доменной логики: system-промт собирает brain (prompt.ts), сюда
 * приходит ГОТОВЫЙ массив сообщений. Парсинг env и issues — в config.ts,
 * сетевой протокол — в llm/openai.ts.
 *
 * Зависимости инжектируются через deps и резолвятся НА КАЖДЫЙ вызов, а не при
 * создании фабрики: подмена глобального fetch (vi.stubGlobal), config
 * (vi.stubEnv) или часов после import должна быть видна.
 *
 * Состояние cooldown — Map в замыкании инстанса: brain создаёт createLlm()
 * один раз, поэтому в тёплом инстансе Vercel оно переживает запросы и
 * сбрасывается холодным стартом. В Redis не выносим: для визитки это лишняя
 * зависимость и задержка (решение владельца).
 */

/** Зависимости транспорта — точки инъекции для тестов; в рантайме createLlm(). */
export interface LlmDeps {
  /** Готовый конфиг; по умолчанию дефолтный config из config.ts (process.env). */
  config?: AppConfig;
  /** Подмена сети; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
  /** Часы для дедлайна/cooldown/latencyMs; по умолчанию Date.now. */
  clock?: () => number;
  /** Логгер; по умолчанию общий log из log.ts. */
  log?: Logger;
}

/** Health одного провайдера в ответе админ-маршрута (?section=health). */
export interface LlmProviderHealth {
  /** id слота (LLM_n_ID или provider-<n>). */
  id: string;
  /** true — провайдер ответил успешно хотя бы на одну из проб. */
  ok: boolean;
  /** Задержка в мс от начала пробы до успешного ответа. */
  latencyMs?: number;
  /** Какая проба сработала (GET /models или минимальный chat/completions). */
  detail?: string;
  /** Причина отказа: статус endpoint / текст ошибки сети. Без секретов. */
  error?: string;
}

/**
 * Результат health-check LLM для админ-маршрута (?section=health).
 * Верхнеуровневые ok/latencyMs/detail/error — агрегат для старых читателей
 * health; providers — картина по каждому слоту; issues — дефекты конфига.
 */
export interface LlmPing {
  /** true — ответил хотя бы один провайдер. */
  ok: boolean;
  /** Задержка первого здорового провайдера, мс. */
  latencyMs?: number;
  /** Проба первого здорового провайдера. */
  detail?: string;
  /** Причина: провайдеров нет или не ответил никто. Без секретов. */
  error?: string;
  /** По каждому провайдеру в порядке конфига. */
  providers: LlmProviderHealth[];
  /** Неполные слоты, неизвестные KIND/поля, дубли ID, пропуски нумерации. */
  issues: string[];
}

// Таймаут каждой пробы ping — не env (health-check не настраивают под
// провайдера), поэтому живёт здесь, а не в config.ts. Пробы параллельные,
// поэтому health длится не N × 10 с.
const LLM_PING_TIMEOUT_MS = 10_000;

// Реестр адаптеров: добавление нового протокола — новый файл и одна запись.
const ADAPTERS: Record<LlmProviderKind, LlmAdapterFactory> = {
  openai: createOpenAiAdapter,
};

/**
 * Фабрика транспорта: возвращает { chat, ping }. deps резолвятся на каждый
 * вызов chat/ping — подмена fetch/config после создания инстанса работает.
 * @param {LlmDeps} deps - Инъекции config/fetchImpl/clock/log; без аргументов —
 *   глобальный fetch и дефолтный config (process.env).
 * @returns chat(messages) — бросает, если не ответил никто; ping() — никогда
 *   не бросает.
 */
export function createLlm(deps: LlmDeps = {}) {
  // downUntil: id провайдера → момент, до которого его не трогаем. Живёт в
  // замыкании инстанса; ключ — id (дубли отсекает config.ts).
  const downUntil = new Map<string, number>();

  /**
   * Запрос к цепочке провайдеров с готовым массивом сообщений.
   *
   * Порядок: сначала слоты не в cooldown (по возрастанию n), затем — в cooldown
   * (half-open), чтобы тотальный сбой не выключал LLM на весь TTL. Внутри
   * одного провайдера ретраев нет: ретрай — это следующая попытка цепочки.
   * Бюджет общий: timeout попытки = min(свой таймаут, остаток дедлайна).
   *
   * @param {LlmMessage[]} messages - Готовые сообщения (system ставит brain).
   * @returns {Promise<string>} Обрезанный текст первого успешного ответа.
   * @throws «LLM не настроен…» / агрегированная ошибка со всеми id и причинами.
   */
  async function chat(messages: LlmMessage[]): Promise<string> {
    // Резолв на вызов: подмена глобального fetch/config/clock после импорта видна.
    const cfg = (deps.config ?? config).llm;
    const clock = deps.clock ?? Date.now;
    const logger = deps.log ?? rootLog;

    if (cfg.providers.length === 0) {
      const details = cfg.issues.length > 0 ? ` (${cfg.issues.join("; ")})` : "";
      throw new Error(`LLM не настроен: нет LLM-провайдеров${details}`);
    }

    const deadline = clock() + cfg.totalTimeoutMs;
    const now = clock();
    const fresh = cfg.providers.filter((provider) => (downUntil.get(provider.id) ?? 0) <= now);
    const cooled = cfg.providers.filter((provider) => (downUntil.get(provider.id) ?? 0) > now);
    for (const provider of cooled) {
      logger.debug("llm", `провайдер ${provider.id} в cooldown — пробуем после остальных`);
    }

    const order = [...fresh, ...cooled];
    const failures: Array<{ provider: LlmProviderSettings; reason: string }> = [];

    for (let index = 0; index < order.length; index++) {
      const provider = order[index];
      const remaining = deadline - clock();
      if (remaining <= 0) {
        // Бюджет исчерпан: оставшиеся даже не пробуем, но перечисляем в ошибке.
        for (const rest of order.slice(index)) {
          failures.push({ provider: rest, reason: "бюджет времени исчерпан" });
        }
        break;
      }

      const timeoutMs = Math.max(1, Math.floor(Math.min(provider.timeoutMs, remaining)));
      // Адаптер — на попытку с текущим fetchImpl: подмена deps.fetchImpl после
      // создания createLlm() остаётся видимой (ленивый резолв).
      const adapter = ADAPTERS[provider.kind]({ fetchImpl: deps.fetchImpl });
      try {
        const text = await adapter.chat(provider, messages, {
          maxTokens: cfg.maxTokens,
          timeoutMs,
        });
        // Успех возвращает приоритет: следующий запрос снова начнёт с него.
        downUntil.delete(provider.id);
        return text;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        downUntil.set(provider.id, clock() + cfg.cooldownMs);
        failures.push({ provider, reason });
        // Секреты не попадают: reason — статус/текст ошибки сети, не ключ.
        logger.warnThrottled(
          "llm",
          `provider:${provider.id}`,
          `провайдер ${provider.id} недоступен: ${reason}`,
        );
      }
    }

    const summary = failures.map(({ provider, reason }) => `${provider.id}: ${reason}`).join("; ");
    throw new Error(`LLM: все провайдеры недоступны${summary ? ` (${summary})` : ""}`);
  }

  // Health: пробы всех провайдеров параллельно (Promise.all), иначе N × 10 с.
  // Никогда не бросает; cooldown не трогает — health показывает реальную
  // картину, а не то, кого цепочка сейчас пропускает.
  /**
   * Проверка доступности всех провайдеров для админ-маршрута (?section=health).
   * Таймаут каждой пробы — 10 с; latencyMs считается по clock из deps.
   * @returns {Promise<LlmPing>} агрегат ok + providers + issues конфига.
   */
  async function ping(): Promise<LlmPing> {
    const cfg = (deps.config ?? config).llm;
    const clock = deps.clock ?? Date.now;

    if (cfg.providers.length === 0) {
      return {
        ok: false,
        error: "не настроен: нет LLM-провайдеров",
        providers: [],
        issues: cfg.issues,
      };
    }

    const providers = await Promise.all(
      cfg.providers.map(async (provider): Promise<LlmProviderHealth> => {
        const startedAt = clock();
        const adapter = ADAPTERS[provider.kind]({ fetchImpl: deps.fetchImpl });
        try {
          const probe = await adapter.probe(provider, { timeoutMs: LLM_PING_TIMEOUT_MS });
          if (!probe.ok) return { id: provider.id, ok: false, error: probe.error };
          return {
            id: provider.id,
            ok: true,
            latencyMs: clock() - startedAt,
            detail: probe.detail,
          };
        } catch (error) {
          // Контракт probe — «не бросает», но health не должен падать даже при
          // нарушении контракта адаптером.
          const reason = error instanceof Error ? error.message : String(error);
          return { id: provider.id, ok: false, error: reason };
        }
      }),
    );

    const healthy = providers.find((provider) => provider.ok);
    if (healthy) {
      return {
        ok: true,
        latencyMs: healthy.latencyMs,
        detail: healthy.detail,
        providers,
        issues: cfg.issues,
      };
    }

    const failed = providers
      .map((provider) => `${provider.id}: ${provider.error ?? "неизвестная ошибка"}`)
      .join("; ");
    return {
      ok: false,
      error: `все провайдеры недоступны (${failed})`,
      providers,
      issues: cfg.issues,
    };
  }

  return { chat, ping };
}

/** Тип инстанса LLM-транспорта — для фабрик, принимающих llm как зависимость. */
export type Llm = ReturnType<typeof createLlm>;
