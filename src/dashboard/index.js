import { Hono } from "hono";
import { verifyPassword, getAdminPass } from "./auth.js";
import createResourcesApp from "./resources.js";
import { UI_SHELL } from "./portal.js";

const LOGIN_MAX_FAILURES = 10;
const BAN_MS = 15 * 60 * 1000;
const LOGIN_STATE_CLEANUP_INTERVAL = 300_000;

const loginState = new Map();
let lastCleanupTs = 0;

function pruneLoginState() {
  const now = Date.now();
  for (const [ip, state] of loginState) {
    if (state.banUntil > 0 && now >= state.banUntil) {
      loginState.delete(ip);
    }
  }
}

function cleanupStaleLoginEntries() {
  const now = Date.now();
  if (now - lastCleanupTs < LOGIN_STATE_CLEANUP_INTERVAL) return;
  lastCleanupTs = now;
  if (loginState.size > 1000) {
    pruneLoginState();
  }
}

export default function (clearCache) {
  const app = new Hono();

  app.route("/api", createResourcesApp(clearCache));

  app.get("/", (c) => c.html(UI_SHELL));

  app.post("/login", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
    cleanupStaleLoginEntries();

    const state = loginState.get(ip) || { count: 0, banUntil: 0 };

    if (Date.now() < state.banUntil) {
      return c.json({ error: "嘗試過多，請 15 分鐘後再试" }, 429);
    }

    const { password } = await c.req.json();
    if (!password) return c.json({ error: "密碼 required" }, 400);

    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ error: "尚未設定密碼" }, 403);

    if (await verifyPassword(password, storedHash)) {
      loginState.delete(ip);
      return c.json({ ok: true });
    }

    const newCount = state.count + 1;
    if (newCount >= LOGIN_MAX_FAILURES) {
      loginState.set(ip, { count: 0, banUntil: Date.now() + BAN_MS });
      return c.json({ error: "IP 已被封鎖 15 分鐘" }, 429);
    }

    loginState.set(ip, { count: newCount, banUntil: 0 });
    return c.json({ error: "密碼錯誤" }, 401);
  });

  return app;
}
