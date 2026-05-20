import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import registerGateway, { clearCache } from "./gateway.js";
import createDashboardApp from "./dashboard/index.js";
import { registerMaintenance } from "./routes/maintenance.js";
import { generateToken } from "./lib/db.js";

async function initConfig(env) {
  const cf = await env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
  if (cf && !cf.client_token) {
    const token = generateToken();
    await env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(token).run();
    console.log("[init] generated client_token:", token);
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
      try { await initConfig(c.env); } catch (e) { console.error("[init]", e.message); }
      inited = true;
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
  error: "not_found", path: c.req.path, method: c.req.method,
  message: "Route not found: " + c.req.method + " " + c.req.path,
}, 404));

app.onError((err, c) => {
  console.error("[error]", err.message);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
