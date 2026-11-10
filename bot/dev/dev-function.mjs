/**
 * Локальный dev-адаптер Vercel Function — поднимает функцию без `vercel dev`:
 * на этой машине тот падает EPERM на symlink в кэше билдеров (Windows).
 *
 * Что делает: компилирует api/bot.ts + bot/ в .tmp/dev-function (нативный
 * Node-лоадер, как на Vercel — ловит забытые .js-расширения), копирует туда
 * контент (bot/brain/knowledge.json, bot/brain/prompts/ — tsc за импортами
 * json/md не идёт, без копии prompt.ts упадёт ENOENT), поднимает node:http
 * на порту 3000 (vite proxy уже смотрит на 3000) и на каждый запрос зовёт
 * default.fetch. Не деплоится: живёт в bot/dev/, вне api/.
 *
 * Порт: 3000 (под vite proxy), переопределяется env DEV_FUNCTION_PORT.
 * Env: опционально читает .env.local (уже выставленные переменные не
 * перекрывает); нет файла — работает без env, тогда сработает fail-open
 * store / dumb-режим brain.
 *
 * Запуск: npm run dev:function.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// bot/dev/dev-function.mjs → bot/ → ROOT: вверх на два каталога.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT_DIR = join(ROOT, ".tmp", "dev-function");
const PORT = Number(process.env.DEV_FUNCTION_PORT) || 3000; // 3000 — под vite proxy

// ── env: .env.local опционален; нет файла — просто пустые env,
// тогда сработает fail-open store / dumb-режим brain.
function loadEnvFile() {
  const envPath = join(ROOT, ".env.local");
  if (!existsSync(envPath)) {
    console.warn("[dev-function] .env.local не найден — работаю без env (fail-open/dumb)");
    return;
  }
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Кавычки vercel env pull / ручных правок снимаем.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Уже выставленные переменные не перекрываем — явный env приоритетнее.
    // Значения не печатаем: в .env.local живут секреты (токены/ключи), а их
    // вывод в логи запрещён правилами репозитория.
    process.env[key] ??= value;
  }
  console.warn("[dev-function] env загружен из .env.local");
}

// ── Fake Upstash: in-memory заглушка REST-эндпоинта ─────────────────
// Активируется парой UPSTASH_REDIS_REST_URL=http://upstash.fake (+ любой
// токен) в .env.local. Зачем: ручные тесты не должны тратить запросы
// бесплатного тарифа реального Upstash и зависеть от сети. Подменяется
// только fetch на адрес заглушки — llama.cpp и Telegram API идут своим
// ходом. История живёт в памяти процесса и умирает с рестартом адаптера.
function installFakeUpstash() {
  const fakeUrl = process.env.UPSTASH_REDIS_REST_URL ?? "";
  if (!fakeUrl.startsWith("http://upstash.fake")) return;
  const db = new Map(); // key -> { value, expiresAt: number | null }
  const alive = (entry) => entry && (entry.expiresAt === null || entry.expiresAt > Date.now());

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith(fakeUrl)) return realFetch(input, init);
    let command;
    try {
      command = JSON.parse(init?.body ?? "[]");
    } catch {
      return Response.json({ error: "fake upstash: битый JSON команды" }, { status: 400 });
    }
    const [op, key, value, exMode, exSeconds] = command;
    let result = null;
    if (op === "ping") result = "PONG";
    else if (op === "get") result = alive(db.get(key)) ? db.get(key).value : null;
    else if (op === "set") {
      db.set(key, {
        value,
        expiresAt: exMode === "EX" ? Date.now() + Number(exSeconds) * 1000 : null,
      });
      result = "OK";
    } else if (op === "del") {
      result = db.delete(key) ? 1 : 0;
    } else if (op === "ttl") {
      const entry = db.get(key);
      result = alive(entry) ? Math.round((entry.expiresAt - Date.now()) / 1000) : -2;
    } else {
      return Response.json({ error: `fake upstash: команда ${op} не поддержана` }, { status: 400 });
    }
    console.warn(`[dev-function][fake-upstash] ${JSON.stringify(command).slice(0, 120)}`);
    return Response.json({ result });
  };
  console.warn("[dev-function] Upstash-заглушка активна (in-memory; история до рестарта адаптера)");
}

// ── Компиляция: вход один — api/bot.ts, импорты в bot/ tsc подтягивает сам
// (каталог «bot» как root file tsc 7 не резолвит). --ignoreConfig обязателен:
// иначе tsc 7 ошибкой TS5112 требует его при файлах на CLI.
function compile() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(dirname(OUT_DIR), { recursive: true });
  // Команда строкой (не массив + shell): иначе Node ругается DEP0190.
  // Аргументы — константы и пути этого репо, инъекции не из чего собрать.
  const command = [
    "npx tsc",
    "--ignoreConfig",
    "api/bot.ts",
    "--outDir",
    OUT_DIR,
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--target",
    "es2022",
    "--lib",
    "es2022,dom,dom.iterable",
    "--types",
    "node",
    "--skipLibCheck",
  ].join(" ");
  const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tsc завершился с кодом ${result.status}`);
  }
  // Вне api/ создаётся свой package.json: .tmp наследует "type": "module" от
  // корня, но делаем каталог самодостаточным — меньше сюрпризов при переносе.
  writeFileSync(join(OUT_DIR, "package.json"), '{"type":"module"}\n');
  // Контент промта: tsc трясёт только .ts-импорты; json/md в артефакт
  // попадают только явным копированием — кладём рядом со скомпилированным
  // bot/brain/prompt.js, откуда он читается литеральным new URL.
  cpSync(
    join(ROOT, "bot", "brain", "knowledge.json"),
    join(OUT_DIR, "bot", "brain", "knowledge.json"),
  );
  cpSync(join(ROOT, "bot", "brain", "prompts"), join(OUT_DIR, "bot", "brain", "prompts"), {
    recursive: true,
  });
}

// ── Конвертация node req ↔ Request / Response ↔ node res ───────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function callHandler(handler, req) {
  // URL собирается из Host-заголовка, а не захардкоженного адреса: sameOrigin
  // в webchat сравнивает Origin запроса с origin request.url. Браузерный POST
  // идёт через vite-прокси с Origin http://localhost:5173, и прокси Host не
  // переписывает (changeOrigin не включён) — только URL с этим Host даёт
  // совпадение. Хардкод 127.0.0.1:3000 делал любой браузерный POST локально
  // «чужим источником» (403), при этом curl без Origin проходил — потому
  // и не ловилось. Фолбэк на прямой адрес — на случай запроса без Host.
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  const url = `http://${host}${req.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
  });
  return handler.default.fetch(request);
}

function main() {
  loadEnvFile();
  installFakeUpstash();
  compile();

  import(pathToFileURL(join(OUT_DIR, "api", "bot.js")).href).then((handler) => {
    const server = createServer(async (req, res) => {
      try {
        const response = await callHandler(handler, req);
        const body = Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, [...response.headers]);
        res.end(body);
      } catch (error) {
        // Ошибка обработчика не должна убивать сервер: 500 и лог.
        console.error("[dev-function] ошибка обработчика:", error);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      }
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.warn(`[dev-function] слушаю http://127.0.0.1:${PORT} (vite proxy /api → сюда)`);
    });
  });
}

main();
