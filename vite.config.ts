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
    //
    // Форма объекта с changeOrigin: false обязательна: шорткат-форма
    // (строка-таргет) молча форсирует changeOrigin: true (vite proxyMiddleware),
    // и Host запроса переписывается на 127.0.0.1:3000. А sameOrigin-стена
    // вебчата сравнивает Origin с origin request.url, который dev-адаптер
    // собирает из Host: с переписанным Host любой браузерный POST локально
    // получал 403 «Запрос с чужого источника» (curl без Origin не ловился).
    proxy: process.env.PORT
      ? undefined
      : { "/api": { target: "http://127.0.0.1:3000", changeOrigin: false } },
  },
});
