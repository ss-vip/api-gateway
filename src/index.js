import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import registerGateway, { clearCache } from "./gateway.js";
import createDashboardApp from "./dashboard/index.js";
import { JsonDB } from "./lib/storage.js";
import { cleanupState } from "./lib/adaptive.js";
import { MAX_CONCURRENT_REQUESTS, GC_MEMORY_THRESHOLD_MB, ENABLE_BACKUPS, LOG_TRUNCATE_LINES, LOG_KEEP_LINES } from "./lib/constants.js";

const app = new Hono();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "db.json");
const _db = new JsonDB(null, DB_PATH);

const TEMP_DIR = resolve(__dirname, "../temp");
const LOG_DIR = process.env.LOG_DIR || resolve(__dirname, "../logs");
const BACKUP_DIR = process.env.BACKUP_DIR || resolve(__dirname, "../backups");
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch (e) { console.error("[init] mkdir TEMP_DIR:", e.message); }
try { mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { console.error("[init] mkdir LOG_DIR:", e.message); }
try { mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { console.error("[init] mkdir BACKUP_DIR:", e.message); }

try { writeFileSync(resolve(TEMP_DIR, "app.pid"), String(process.pid), "utf-8"); } catch (e) { console.error("[init] pid file:", e.message); }

let lastBackupDate = "";
function runMaintenance() {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  const rssKB = Math.round(process.memoryUsage().rss / 1024);

  try { appendFileSync(resolve(LOG_DIR, "mem.log"), `[${ts}] rss=${rssKB}KB\n`, "utf-8"); } catch {}

  if (ENABLE_BACKUPS && now.getHours() === 0 && now.getDate() !== parseInt(lastBackupDate.slice(-2)) && existsSync(DB_PATH)) {
    lastBackupDate = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
    try {
      const content = readFileSync(DB_PATH);
      const prev = readdirSync(BACKUP_DIR).filter(f => f.startsWith("db.")).sort().pop();
      let changed = true;
      if (prev) {
        try {
          const oldContent = gunzipSync(readFileSync(resolve(BACKUP_DIR, prev)));
          if (oldContent.equals(content)) changed = false;
        } catch {}
      }
      if (changed) {
        writeFileSync(resolve(BACKUP_DIR, `db.${lastBackupDate}.json.gz`), gzipSync(content));
        try { appendFileSync(resolve(LOG_DIR, "backup.log"), `[${ts}] backup saved (changed)\n`, "utf-8"); } catch {}
      }
      const cutoff = Date.now() - 7 * 86400 * 1000;
      for (const f of readdirSync(BACKUP_DIR)) {
        if (f.startsWith("db.") && statSync(resolve(BACKUP_DIR, f)).mtimeMs < cutoff) {
          try { unlinkSync(resolve(BACKUP_DIR, f)); } catch {}
        }
      }
    } catch (e) { console.error("[maint] backup:", e.message); }
  }

  for (const name of ["mem.log", "backup.log", "restart.log"]) {
    try {
      const p = resolve(LOG_DIR, name);
      if (existsSync(p)) {
        const lines = readFileSync(p, "utf-8").split("\n");
        if (lines.length > LOG_TRUNCATE_LINES) writeFileSync(p, lines.slice(-LOG_KEEP_LINES).join("\n"), "utf-8");
      }
    } catch {}
  }

  cleanupState(new Set((_db.data?.channels || []).map((ch) => ch.id)));
}

const maintTimer = setInterval(runMaintenance, 300_000);
maintTimer.unref();
runMaintenance();

for (const ev of ["exit", "SIGTERM", "SIGINT"]) {
  process.on(ev, () => { try { unlinkSync(resolve(TEMP_DIR, "app.pid")); } catch {} });
}

let activeRequests = 0;
app.use("*", async (c, next) => {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) return c.json({ error: "overload", type: "overload" }, 503);
  activeRequests++;
  await next();
  activeRequests--;
});
app.use("*", async (c, next) => {
  await next();
  try {
    c.res.headers.set("X-RateLimit-Limit", String(MAX_CONCURRENT_REQUESTS));
    c.res.headers.set("X-RateLimit-Remaining", String(Math.max(0, MAX_CONCURRENT_REQUESTS - (activeRequests + 1))));
  } catch (e) {}
});

let lastGc = 0, gcCount = 0;
function maybeGc() {
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rss > GC_MEMORY_THRESHOLD_MB) {
    if (typeof global.gc === "function") { global.gc(); gcCount++; }
    if (rss > GC_MEMORY_THRESHOLD_MB * 1.6) console.warn("[gc] high memory: " + rss + "MB (threshold: " + GC_MEMORY_THRESHOLD_MB + "MB, total GC: " + gcCount + ")");
  }
}

app.use("*", async (c, next) => {
  try {
    if (Date.now() - lastGc > 300_000) { lastGc = Date.now(); maybeGc(); }
  } catch (e) {}
  await next();
});

app.use("*", (c, next) => {
  c.env = Object.assign(c.env || {}, { DB: c.env?.DB || _db });
  return next();
});

app.use("*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600, credentials: false,
}));

registerGateway(app);
app.route("/admin", createDashboardApp(clearCache));
app.get("/", (c) => c.redirect("/admin"));
app.get("/health", (c) => c.json({
  ok: true, uptime: process.uptime(),
  mem: Math.round(process.memoryUsage().rss / 1024 / 1024),
  channels: _db?.data?.channels?.length || 0,
}));

app.notFound((c) => c.json({
  error: "not_found", path: c.req.path, method: c.req.method,
  message: "Route not found: " + c.req.method + " " + c.req.path,
}, 404));

app.onError((err, c) => {
  console.error("[error]", err.message);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export function shutdownDb() {
  _db.save();
}

const PORT = Math.min(65535, Math.max(1024, parseInt(process.env.PORT, 10) || 7860));
const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log("[gateway] running on :" + PORT + " (" + process.pid + ")");
});

server.on("error", (e) => {
  console.error("[port]", e.code === "EADDRINUSE" ? PORT + " in use" : e.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandled]", reason?.message || String(reason));
  if (process.listenerCount("unhandledRejection") <= 1) process.exitCode = 1;
});
process.on("uncaughtException", (err) => {
  console.error("[uncaught]", err.message);
  shutdownDb();
  server.close(() => process.exit(1));
});
process.on("SIGTERM", () => {
  console.log("[exit] SIGTERM"); shutdownDb(); server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("[exit] SIGINT"); shutdownDb(); server.close(() => process.exit(0));
});

export default app;
