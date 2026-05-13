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

// ---- 記憶體監控 + 垃圾清理（每 30 秒）---- //
setInterval(() => {
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rss > 400) {
    console.warn("[gc] high memory: " + rss + "MB");
    if (typeof global.gc === "function") global.gc();
  }
  // 清除已刪除渠道的 adaptive 學習資料
  cleanupState(new Set((_db.data.channels || []).map((c) => c.id)));
}, 30000);

// ---- 優雅關機 ---- //
const shutdown = (sig) => { console.log("[exit] " + sig); _db.save(); process.exit(0); };
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---- 共用中間層 ---- //
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

// ---- 路由 ---- //
registerGateway(app);
app.route("/admin", createDashboardApp(clearCache));
app.get("/", (c) => c.redirect("/admin"));

export default app;

// ---- 啟動 ---- //
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = 7860;
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log("gateway running on :" + info.port);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error("[port] " + PORT + " in use, please check other processes");
    } else {
      console.error("[port] " + e.message);
    }
    process.exit(1);
  });
}
