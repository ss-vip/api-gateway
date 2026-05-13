// ============================================================
// Dashboard Resources — Channels / Filters / Config CRUD
// ============================================================
import { Hono } from "hono";
import { getAdminPass, verifyPassword, hashPassword } from "./auth.js";

const DEFAULTS = { token: "sk-test123456", delay_period: 300 };

// ---- API Key Masking ---- //
function maskApiKey(key) {
  if (!key || key.length < 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
function isMaskedKey(key) {
  return key && key.includes("****");
}

export default function (clearCache) {
  const api = new Hono();

  // ================================================================
  // Auth Middleware (protects all routes except public suffixes)
  // ================================================================
  const PUBLIC_SUFFIXES = ["/auth-status", "/config", "/verify-token"];
  api.use("*", async (c, next) => {
    const path = c.req.path;
    // Public paths always accessible (no auth needed for these)
    if (PUBLIC_SUFFIXES.some((s) => path.endsWith(s))) return await next();
    const storedHash = await getAdminPass(c);
    // When no password is set, only /admin-pass is allowed
    if (!storedHash) {
      if (path.endsWith("/admin-pass")) return await next();
      return c.json({ error: "請先設定密碼" }, 403);
    }
    const inputToken = c.req.header("X-Admin-Token");
    if (!inputToken) return c.json({ error: "Unauthorized" }, 401);
    if (!(await verifyPassword(inputToken, storedHash)))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  // ================================================================
  // Channels
  // ================================================================

  api.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, base_url, provider, model, weight,
              is_enabled, is_vision, last_429, consecutive_errors,
              last_error_msg, last_error_at,
              rpm_limit, rpd_limit, rpm_count, rpm_reset_at,
              rpd_count, rpd_reset_at, max_tokens, support_tools,
              response_time, fallback_model
       FROM channels ORDER BY id`
    ).all();
    return c.json((results || []).map((ch) => ({ ...ch, api_key: maskApiKey(ch.api_key || "") })));
  });

  api.post("/batch-channels", async (c) => {
    const channels = await c.req.json();
    const maskedIds = channels.filter((ch) => ch.id != null && isMaskedKey(ch.api_key)).map((ch) => ch.id);
    const existingKeys = {};
    if (maskedIds.length > 0) {
      const ph = maskedIds.map(() => "?").join(",");
      const existing = await c.env.DB.prepare(`SELECT id, api_key FROM channels WHERE id IN (${ph})`).bind(...maskedIds).all();
      for (const row of existing.results || []) existingKeys[row.id] = row.api_key;
    }
    const batch = [c.env.DB.prepare("DELETE FROM channels")];
    for (const ch of channels) {
      const apiKey = isMaskedKey(ch.api_key) ? existingKeys[ch.id] || ch.api_key : ch.api_key || "";
      batch.push(
        c.env.DB.prepare(
          `INSERT INTO channels (id, name, base_url, api_key, provider, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, response_time, fallback_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey, ch.provider || "openai",
          ch.model || "", ch.weight || 1, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
          ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
          ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
          ch.support_tools ? 1 : 0, ch.response_time || 0, ch.fallback_model || ""
        )
      );
    }
    await c.env.DB.batch(batch);
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/channels/:id/reset-health", async (c) => {
    await c.env.DB.prepare("UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0 WHERE id=?").bind(c.req.param("id")).run();
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/channels/reset-all-health", async (c) => {
    await c.env.DB.prepare("UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0").run();
    clearCache();
    return c.json({ ok: true });
  });

  // ================================================================
  // Filters
  // ================================================================

  api.get("/filters", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all();
    return c.json(results || []);
  });

  api.post("/filters", async (c) => {
    const filters = await c.req.json();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM filters"),
      ...filters.map((f) =>
        c.env.DB.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0)
      ),
    ]);
    clearCache();
    return c.json({ ok: true });
  });

  // ================================================================
  // Config & Auth Endpoints
  // ================================================================

  api.get("/config", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
      return c.json({
        token: cf?.client_token || DEFAULTS.token,
        recovery_period: cf?.recovery_period || DEFAULTS.delay_period,
        db_sync_url: cf?.db_sync_url || "",
      });
    } catch (e) {
      return c.json({ token: DEFAULTS.token, recovery_period: DEFAULTS.delay_period, db_sync_url: "" });
    }
  });

  api.get("/auth-status", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
      return c.json({ needsSetup: !cf?.admin_password });
    } catch (e) {
      return c.json({ needsSetup: true });
    }
  });

  api.post("/verify-token", async (c) => {
    const { token } = await c.req.json();
    if (!token) return c.json({ valid: false }, 400);
    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ valid: false }, 403);
    return c.json({ valid: await verifyPassword(token, storedHash) });
  });

  api.post("/config", async (c) => {
    const b = await c.req.json();
    const ex = await c.env.DB.prepare("SELECT id FROM config WHERE id=1").first();
    try {
      if (ex) {
        await c.env.DB.prepare("UPDATE config SET client_token=?, recovery_period=?, db_sync_url=? WHERE id=1")
          .bind(b.token || DEFAULTS.token, parseInt(b.recovery_period) || DEFAULTS.delay_period, b.db_sync_url || "").run();
      } else {
        await c.env.DB.prepare("INSERT INTO config (id, client_token, recovery_period, db_sync_url) VALUES (1, ?, ?, ?)")
          .bind(b.token || DEFAULTS.token, parseInt(b.recovery_period) || DEFAULTS.delay_period, b.db_sync_url || "").run();
      }
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/proxy-models", async (c) => {
    const { url, key } = await c.req.json();
    if (!url) return c.json({ error: "Missing URL" }, 400);
    let target = url.trim().replace(/\/+$/, "");
    if (!target.endsWith("/models")) {
      if (target.endsWith("/chat/completions")) target = target.replace("/chat/completions", "/models");
      else if (target.includes("/v1")) target = target.split("/v1")[0] + "/v1/models";
      else target += "/v1/models";
    }
    try {
      const res = await fetch(target, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) return c.json({ error: `Upstream error: ${res.status}` }, res.status);
      return c.json(await res.json());
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  api.post("/admin-pass", async (c) => {
    const { pass } = await c.req.json();
    if (!pass || pass.length < 6 || pass.length > 20)
      return c.json({ error: "Password must be 6-20 characters" }, 400);
    const hashedPass = await hashPassword(pass);
    const ex = await c.env.DB.prepare("SELECT id FROM config WHERE id=1").first();
    if (ex) {
      await c.env.DB.prepare("UPDATE config SET admin_password=? WHERE id=1").bind(hashedPass).run();
    } else {
      await c.env.DB.prepare("INSERT INTO config (id, admin_password) VALUES (1, ?)").bind(hashedPass).run();
    }
    clearCache();
    return c.json({ ok: true });
  });

  // ================================================================
  // Import / Export / Reset
  // ================================================================

  // GET /export: dump full state as JSON (backup / migrate / sync)
  api.get("/export", async (c) => {
    const [channels, filters] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const config = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    // Include raw api_key (masking breaks sync). Admin UI download uses separate display.
    return c.json({
      channels: channels.results || [],
      filters: filters.results || [],
      config: config ? { token: config.client_token, recovery_period: config.recovery_period, db_sync_url: config.db_sync_url || "" } : {},
    });
  });

  api.post("/import-all", async (c) => {
    const d = await c.req.json();
    const batch = [];
    if (d.channels) {
      batch.push(c.env.DB.prepare("DELETE FROM channels"));
      const maskedIds = d.channels.filter((ch) => ch.id != null && isMaskedKey(ch.api_key)).map((ch) => ch.id);
      const existingKeys = {};
      if (maskedIds.length > 0) {
        const ph = maskedIds.map(() => "?").join(",");
        const existing = await c.env.DB.prepare(`SELECT id, api_key FROM channels WHERE id IN (${ph})`).bind(...maskedIds).all();
        for (const row of existing.results || []) existingKeys[row.id] = row.api_key;
      }
      for (const ch of d.channels) {
        const apiKey = isMaskedKey(ch.api_key) ? existingKeys[ch.id] || ch.api_key : ch.api_key || "";
        batch.push(
          c.env.DB.prepare(
            `INSERT INTO channels (id, name, base_url, api_key, provider, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, response_time, fallback_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey, ch.provider || "openai",
            ch.model || "", ch.weight || 1, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
            ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
            ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
            ch.support_tools ? 1 : 0, ch.response_time || 0, ch.fallback_model || ""
          )
        );
      }
    }
    if (d.filters) {
      batch.push(c.env.DB.prepare("DELETE FROM filters"));
      for (const f of d.filters) {
        batch.push(c.env.DB.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0));
      }
    }
    if (d.config) {
      const currentPass = await getAdminPass(c);
      batch.push(
        c.env.DB.prepare("INSERT OR REPLACE INTO config (id, client_token, admin_password, recovery_period) VALUES (1, ?, ?, ?)")
          .bind(d.config.token || DEFAULTS.token, currentPass || "", parseInt(d.config.recovery_period) || DEFAULTS.delay_period)
      );
    }
    if (batch.length > 0) await c.env.DB.batch(batch);
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/reset", async (c) => {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare("UPDATE config SET client_token=?, recovery_period=? WHERE id=1").bind(DEFAULTS.token, DEFAULTS.delay_period),
    ]);
    clearCache();
    return c.json({ ok: true });
  });

  return api;
}
