import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import registerGateway, { clearGatewayCache } from "./gateway.js";
import createDashboardApp, { pruneLoginState } from "./dashboard/index.js";
import { setPepper } from "./dashboard/resources.js";
import { ensureSchema } from "./lib/schema.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length", "X-Request-Id"],
  maxAge: 600,
}));

// 啟動時初始化 schema + client_token
let inited = false;
let initLock = null;

async function initConfig(env) {
  setPepper("vg7p@2mK9#qR");
  try { await ensureSchema(env); } catch (e) { console.error("[schema]", e.message); }
}

app.use("*", async (c, next) => {
  if (!inited) {
    if (!initLock) {
      initLock = (async () => {
        try {
          await initConfig(c.env);
          inited = true;
        } catch (e) {
          console.error("[init]", e.message);
        }
        initLock = null;
      })();
    }
    await initLock;
  }
  await next();
});

registerGateway(app);
app.route("/admin", createDashboardApp(clearGatewayCache));
app.get("/", (c) => c.redirect("/admin"));

// 404
app.notFound((c) => c.json({
  error: {
    message: `Route not found: ${c.req.method} ${c.req.path}`,
    type: "invalid_request_error", param: null, code: "not_found",
  },
}, 404));

// 全域錯誤處理
app.onError((err, c) => {
  console.error("[error]", err.message);
  return c.json({
    error: {
      message: "The server had an error processing your request",
      type: "server_error", param: null, code: "api_error",
    },
  }, 500);
});

export { pruneLoginState };

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
