import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import registerGateway, { clearCache } from "./gateway.js";
import createDashboardApp from "./dashboard/index.js";
import { JsonDB } from "./lib/storage.js";
import { cleanupState } from "./lib/adaptive.js";

const app = new Hono();

// ---- 資料庫（鎖定絕對路徑） ---- //
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "db.json");

const _db = new JsonDB(null, DB_PATH);

// ---- 並發限制（最多 50 同時）---- //
let activeRequests = 0;
app.use("*", async (c, next) => {
  if (activeRequests >= 50) return c.json({ error: "overload", type: "overload" }, 503);
  activeRequests++;
  try { await next(); } finally { activeRequests--; }
});

// ---- 惰性 GC：有請求進來時才檢查記憶體 ---- //
let lastGc = 0;
let lastCleanup = 0;
function maybeGc() {
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rss > 400) {
    console.warn("[gc] high memory: " + rss + "MB");
    if (typeof global.gc === "function") global.gc();
  }
}
// 中間件：每 300 秒懶惰檢查記憶體 + 清除已刪除渠道的 adaptive 資料
app.use("*", async (c, next) => {
  try {
    const now = Date.now();
    if (now - lastGc > 300_000) { lastGc = now; maybeGc(); }
    if (now - lastCleanup > 600_000) { lastCleanup = now;
      cleanupState(new Set((_db.data?.channels || []).map((/** @type {any} */ ch) => ch.id)));
    }
  } catch (e) {}
  await next();
});

// ---- 優雅關機 ---- //
const shutdown = (/** @type {string} */ sig) => { console.log("[exit] " + sig); _db.save(); process.exit(0); };
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---- 共用中間層 ---- //
app.use("*", (/** @type {any} */ c, next) => {
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

// ---- 路由 ---- //
registerGateway(app);
app.route("/admin", createDashboardApp(clearCache));
app.get("/", (c) => c.redirect("/admin"));
app.get("/health", (c) => c.json({
  ok: true, uptime: process.uptime(), mem: Math.round(process.memoryUsage().rss / 1024 / 1024), channels: _db?.data?.channels?.length || 0,
}));

export default app;

// ---- 啟動 ---- //
const PORT = parseInt(process.env.PORT || "7860", 10);
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log("gateway running on :" + info.port + " (" + process.pid + ")");
  console.log("[routes] /health | /admin | /v1/chat/completions");
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("[port] " + PORT + " in use");
  } else {
    console.error("[port] " + e.message);
  }
  process.exit(1);
});
