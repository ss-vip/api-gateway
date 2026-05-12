// ============================================================
// Entry Point — Cloudflare Worker
// CORS + mount gateway + mount dashboard
// ============================================================
import { Hono } from "hono";
import { cors } from "hono/cors";
import registerGateway from "./gateway.js";
import createDashboardApp from "./dashboard/index.js";

const app = new Hono();

// ---- CORS (applies to all routes) ---- //
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: false,
  })
);

// ---- Gateway: API proxy (register routes at /v1/*) ---- //
registerGateway(app);

// ---- Dashboard: admin app (mounted at /admin) ---- //
const clearCache = () => {
  // placeholder — gateway manages its own cache internally
};
app.route("/admin", createDashboardApp(clearCache));

// ---- Root: redirect to dashboard ---- //
app.get("/", (c) => c.redirect("/admin"));

export default app;
