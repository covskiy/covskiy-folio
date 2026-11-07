// Единая точка правды по списку серверных env-переменных — bot/config.ts:
// слайсы типизированы, и опечатка в имени переменной ловится tsc в месте
// потребления. Здесь список не дублируется: индексная сигнатура ProcessEnv
// от @types/node опечатки не ловит — только IDE-подсказки.
//
// Здесь остаётся только PORT: её читает vite.config.ts, а сборке фронта знать
// про bot/config.ts не нужно. Профиль установки — .env.example, значения —
// env Vercel / .env.local.

export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** Порт vite в dev (читает vite.config.ts) */
      PORT?: string;
    }
  }
}
