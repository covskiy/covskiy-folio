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
    // Локалка: vite (5173) проксирует /api на vercel dev (3000)
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
