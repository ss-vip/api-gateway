import { Hono } from "hono";

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const PEPPER = "vg7p@2mK9#qR";

async function hashPassword(password) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PEPPER + password));
  return bytesToHex(new Uint8Array(hash));
}
async function verifyPassword(password, storedHash) {
  if (!storedHash || storedHash.length !== 64) return false;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PEPPER + password));
  return bytesToHex(new Uint8Array(hash)) === storedHash;
}
async function getAdminPass(c) {
  try {
    const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
    return cf?.admin_password || null;
  } catch { return null; }
}

export { getAdminPass, verifyPassword, hashPassword };

function generateFallbackToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "sk-";
  for (let i = 0; i < 15; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}
const DEFAULTS = { token: generateFallbackToken(), delay_period: 300 };

export default function (clearCache) {
  const api = new Hono();

  const PUBLIC_SUFFIXES = ["/auth-status", "/verify-token"];
  api.use("*", async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_SUFFIXES.some((s) => path.endsWith(s))) return await next();
    const storedHash = await getAdminPass(c);
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

  api.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, name, base_url, api_key, model, weight,\
              is_enabled, is_vision, last_429, consecutive_errors,\
              last_error_msg, last_error_at,\
              rpm_limit, rpd_limit, rpm_count, rpm_reset_at,\
              rpd_count, rpd_reset_at, max_tokens, support_tools,\
              response_time, fallback_model, headers, provider_options, provider\
       FROM channels ORDER BY id"
    ).all();
    return c.json(results || []);
  });

  api.post("/batch-channels", async (c) => {
    const channels = await c.req.json();
    const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
    const allKeys = {};
    for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
    const batch = [c.env.DB.prepare("DELETE FROM channels")];
    for (const ch of channels) {
      const apiKey = ch.api_key || (allKeys[ch.id] || "");
      const h = ch.headers ? (typeof ch.headers === "object" ? JSON.stringify(ch.headers) : ch.headers) : null;
      const po = ch.provider_options ? (typeof ch.provider_options === "object" ? JSON.stringify(ch.provider_options) : ch.provider_options) : null;
      batch.push(
        c.env.DB.prepare(
          "INSERT INTO channels (id, name, base_url, api_key, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, response_time, fallback_model, headers, provider_options, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey,
          ch.model || "", ch.weight || 1, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
          ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
          ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
          ch.support_tools ? 1 : 0, ch.response_time || 0, ch.fallback_model || "",
          h, po, ch.provider || ""
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

  api.get("/config", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
      return c.json({
        token: cf?.client_token || DEFAULTS.token,
        recovery_period: cf?.recovery_period || DEFAULTS.delay_period,
      });
    } catch (e) {
      return c.json({ token: DEFAULTS.token, recovery_period: DEFAULTS.delay_period });
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
        await c.env.DB.prepare("UPDATE config SET client_token=?, recovery_period=? WHERE id=1")
          .bind(b.token || DEFAULTS.token, parseInt(b.recovery_period) || DEFAULTS.delay_period).run();
      } else {
        await c.env.DB.prepare("INSERT INTO config (id, client_token, recovery_period) VALUES (1, ?, ?)")
          .bind(b.token || DEFAULTS.token, parseInt(b.recovery_period) || DEFAULTS.delay_period).run();
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
      return c.json({ error: "密碼需 6-20 個字元" }, 400);
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

  api.get("/export", async (c) => {
    const [channels, filters] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const config = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    return c.json({
      channels: channels.results || [],
      filters: filters.results || [],
      config: config ? { token: config.client_token, recovery_period: config.recovery_period } : {},
    });
  });

  api.post("/import-all", async (c) => {
    const d = await c.req.json();
    const batch = [];
    if (d.channels) {
      batch.push(c.env.DB.prepare("DELETE FROM channels"));
      const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
      const allKeys = {};
      for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
      for (const ch of d.channels) {
        const apiKey = ch.api_key || (allKeys[ch.id] || "");
        const h = ch.headers ? (typeof ch.headers === "object" ? JSON.stringify(ch.headers) : ch.headers) : null;
        const po = ch.provider_options ? (typeof ch.provider_options === "object" ? JSON.stringify(ch.provider_options) : ch.provider_options) : null;
        batch.push(
          c.env.DB.prepare(
            "INSERT INTO channels (id, name, base_url, api_key, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, response_time, fallback_model, headers, provider_options, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey,
            ch.model || "", ch.weight || 1, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
            ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
            ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
            ch.support_tools ? 1 : 0, ch.response_time || 0, ch.fallback_model || "",
            h, po, ch.provider || ""
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
    const freshToken = generateFallbackToken();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare("UPDATE config SET client_token=?, recovery_period=? WHERE id=1").bind(freshToken, DEFAULTS.delay_period),
    ]);
    clearCache();
    return c.json({ ok: true, new_token: freshToken });
  });

  return api;
}