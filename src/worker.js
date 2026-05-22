import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import registerGateway, { clearCache } from "./gateway.js";
import createDashboardApp from "./dashboard/index.js";
import { registerMaintenance } from "./routes/maintenance.js";
import { generateToken } from "./lib/db.js";

async function initConfig(env) {
  // 自動檢查並補齊新版新增的欄位（針對舊版升級用戶）
  const newCols = [
    "support_stream INTEGER NOT NULL DEFAULT 1",
    "support_image_gen INTEGER NOT NULL DEFAULT 0",
    "support_audio_tts INTEGER NOT NULL DEFAULT 0",
    "support_audio_stt INTEGER NOT NULL DEFAULT 0",
    "support_image_edit INTEGER NOT NULL DEFAULT 0",
    "support_embeddings INTEGER NOT NULL DEFAULT 0"
  ];
  for (const colDef of newCols) {
    try {
      await env.DB.prepare(`ALTER TABLE channels ADD COLUMN ${colDef}`).run();
    } catch (e) {
      // 欄位若已存在會拋出錯誤，直接忽略即可
    }
  }

  try {
    const cf = await env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    if (cf && !cf.client_token) {
      const token = generateToken();
      await env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(token).run();
      console.log("[init] generated client_token:", token);
    }
  } catch (e) {
    console.error("[init] config error:", e.message);
  }
}

const app = new Hono();

app.use("*", logger());
app.use("*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: false,
}));

let inited = false;
let initLock = null;
app.use("*", async (c, next) => {
  if (!inited) {
    if (!initLock) initLock = (async () => {
      try {
        await initConfig(c.env);
        inited = true;
      } catch (e) {
        console.error("[init]", e.message);
      }
      initLock = null;
    })();
    await initLock;
  }
  await next();
});

registerGateway(app);
app.route("/admin", createDashboardApp(clearCache));
registerMaintenance(app);
app.get("/", (c) => c.redirect("/admin"));

app.notFound((c) => c.json({
  error: { message: "Route not found: " + c.req.method + " " + c.req.path, type: "invalid_request_error", param: null, code: "not_found" },
}, 404));

app.onError((err, c) => {
  console.error("[error]", err.message);
  return c.json({ error: { message: "The server had an error processing your request", type: "server_error", param: null, code: "api_error" } }, 500);
});

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
