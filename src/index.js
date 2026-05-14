import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import registerGateway, { clearCache } from "./gateway.js";
import createDashboardApp from "./dashboard/index.js";
import { JsonDB } from "./lib/storage.js";
import { cleanupState } from "./lib/adaptive.js";

const app = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "db.json");

const _db = new JsonDB(null, DB_PATH);

let activeRequests = 0;
app.use("*", async (c, next) => {
  if (activeRequests >= 30) return c.json({ error: "overload", type: "overload" }, 503);
  activeRequests++;
  try { await next(); } finally { activeRequests--; }
});

let lastGc = 0, lastCleanup = 0, gcCount = 0;
function maybeGc() {
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rss > 150) {
    if (typeof global.gc === "function") { global.gc(); gcCount++; }
    if (rss > 250) console.warn("[gc] high memory: " + rss + "MB (total GC: " + gcCount + ")");
  }
}

app.use("*", async (c, next) => {
  try {
    const now = Date.now();
    if (now - lastGc > 300_000) { lastGc = now; maybeGc(); }
    if (now - lastCleanup > 600_000) { lastCleanup = now;
      cleanupState(new Set((_db.data?.channels || []).map((ch) => ch.id)));
    }
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

const PORT = parseInt(process.env.PORT || "7860", 10);
const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log("[gateway] running on :" + PORT + " (" + process.pid + ")");
});

server.on("error", (e) => {
  console.error("[port]", e.code === "EADDRINUSE" ? PORT + " in use" : e.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandled]", reason?.message || String(reason));
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
