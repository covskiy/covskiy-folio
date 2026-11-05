import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// MPA: каждая страница — отдельный вход сборки (рекомендованный режим для продакшена)
const page = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: page("index"),
        about: page("about"),
        contacts: page("contacts"),
      },
    },
  },
  server: {
    // vercel dev спавнит vite на случайном внутреннем порту и передаёт его через PORT;
    // vite сам её не читает — без этого vercel dev падает с "Failed to detect a server"
    port: Number(process.env.PORT) || 5173,
    // Прокси нужен только автономному vite (npm run dev: 5173 → функция на 3000).
    // Под vercel dev CLI сам раздаёт /api — прокси замыкает петлю
    // vercel:3000 → vite → vercel:3000: заголовки x-vercel-* растут с каждым
    // кругом до 431, POST с телом роняет обвязку (read ECONNRESET).
    // PORT — маркер «vite заспавнен vercel dev».
    proxy: process.env.PORT ? undefined : { "/api": "http://127.0.0.1:3000" },
  },
});
