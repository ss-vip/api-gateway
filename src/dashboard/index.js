// ============================================================
// Dashboard — Admin App Router
// Mounts: API resources (/api/*), Portal (/), Login (/login)
// Mounted at /admin in main app (index.js)
// ============================================================
import { Hono } from "hono";
import { verifyPassword, getAdminPass } from "./auth.js";
import createResourcesApp from "./resources.js";
import { UI_SHELL } from "./portal.js";

const LOGIN_BAN_DURATION = 900;
const LOGIN_MAX_FAILURES = 10;

export default function (clearCache) {
  const app = new Hono();

  // ---- REST API: /api/* (becomes /admin/api/*) ---- //
  app.route("/api", createResourcesApp(clearCache));

  // ---- Portal: / (serves SPA HTML at /admin) ---- //
  app.get("/", (c) => c.html(UI_SHELL));

  // ---- Login: POST /login (at /admin/login, outside API auth middleware) ---- //
  app.post("/login", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
    const host = c.req.header("Host") || "localhost";
    const banKey = `login-ban:${ip}`;
    const failKey = `login-fail:${ip}`;
    const kv = caches.default;
    const banCacheKey = new Request(`https://${host}/_internal/${banKey}`);
    if (await kv.match(banCacheKey))
      return c.json({ error: "嘗試過多，請 15 分鐘後再试" }, 429);

    const { password } = await c.req.json();
    if (!password) return c.json({ error: "密碼 required" }, 400);

    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ error: "尚未設定密碼" }, 403);

    if (await verifyPassword(password, storedHash)) {
      c.executionCtx.waitUntil(
        Promise.all([
          kv.delete(banCacheKey).catch(() => {}),
          kv.delete(new Request(`https://${host}/_internal/${failKey}`)).catch(() => {}),
        ])
      );
      return c.json({ ok: true });
    }

    // Failure tracking
    const failCacheKey = new Request(`https://${host}/_internal/${failKey}`);
    const failResponse = await kv.match(failCacheKey);
    let failCount = 1;
    if (failResponse) {
      const failData = await failResponse.json().catch(() => ({ count: 1 }));
      failCount = (failData.count || 0) + 1;
    }

    if (failCount >= LOGIN_MAX_FAILURES) {
      c.executionCtx.waitUntil(
        Promise.all([
          kv.put(banCacheKey, new Response("banned", { status: 429, headers: { "Cache-Control": `max-age=${LOGIN_BAN_DURATION}` } })).catch(() => {}),
          kv.delete(failCacheKey).catch(() => {}),
        ])
      );
      return c.json({ error: "IP 已被封鎖 15 分鐘" }, 429);
    }

    c.executionCtx.waitUntil(
      kv.put(failCacheKey, new Response(JSON.stringify({ count: failCount }), { headers: { "Cache-Control": `max-age=${LOGIN_BAN_DURATION}` } })).catch(() => {})
    );
    return c.json({ error: "密碼錯誤" }, 401);
  });

  return app;
}
