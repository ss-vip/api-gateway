import { Hono } from "hono";
import { retry } from "../lib/retry.js";
import { maskApiKey } from "../lib/logger.js";

const D1_BATCH_LIMIT = 99; // D1 單次 batch 最多 99 筆

/**
 * Split an array of D1 statements into chunks and execute sequentially.
 */
async function batchChunked(db, stmts) {
  for (let i = 0; i < stmts.length; i += D1_BATCH_LIMIT) {
    const chunk = stmts.slice(i, i + D1_BATCH_LIMIT);
    if (chunk.length > 0) {
      await retry(() => db.batch(chunk));
    }
  }
}

let pepper = "";
function setPepper(p) { pepper = p || ""; }

const RES_CACHE_TTL = 30_000;
let resCacheGen = 0;

function withCache(fn) {
  let localCache = { data: null, ts: 0, gen: -1 };
  return async (c) => {
    if (localCache.gen === resCacheGen && localCache.data && Date.now() - localCache.ts < RES_CACHE_TTL) {
      return c.json(localCache.data);
    }
    const data = await fn(c);
    localCache = { data, ts: Date.now(), gen: resCacheGen };
    return c.json(data);
  };
}

function clearResCache() {
  resCacheGen++;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pepper + password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return bytesToHex(salt) + ":" + bytesToHex(new Uint8Array(bits));
}
async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (!storedHash.includes(":")) {
    if (storedHash.length !== 64) return false;
    const legacyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("vg7p@2mK9#qR" + password));
    return bytesToHex(new Uint8Array(legacyHash)) === storedHash;
  }
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pepper + password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return bytesToHex(new Uint8Array(bits)) === hashHex;
}
async function getAdminPass(c) {
  const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
  return cf?.admin_password || null;
}

export { getAdminPass, verifyPassword, setPepper };

function generateFallbackToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = new Uint32Array(30);
  crypto.getRandomValues(rand);
  let t = "sk-";
  for (let i = 0; i < 30; i++) t += chars[rand[i] % chars.length];
  return t;
}
function getDefaults() {
  return { token: generateFallbackToken() };
}

const setupRateLimit = new Map();
const SETUP_MAX_ATTEMPTS = 5;
const SETUP_BAN_MS = 10 * 60 * 1000; // 10 minutes

function checkSetupRateLimit(ip) {
  if (setupRateLimit.size > 500) {
    const now = Date.now();
    for (const [k, v] of setupRateLimit) {
      if (v.banUntil > 0 && now >= v.banUntil) setupRateLimit.delete(k);
    }
    if (setupRateLimit.size > 500) setupRateLimit.clear();
  }
  const state = setupRateLimit.get(ip) || { count: 0, banUntil: 0 };
  const attempt = state.count + 1;
  if (Date.now() < state.banUntil) return { blocked: true, remaining: 0 };
  if (attempt > SETUP_MAX_ATTEMPTS) {
    setupRateLimit.set(ip, { count: 0, banUntil: Date.now() + SETUP_BAN_MS });
    return { blocked: true, remaining: 0 };
  }
  setupRateLimit.set(ip, { count: attempt, banUntil: 0 });
  return { blocked: false, remaining: SETUP_MAX_ATTEMPTS - attempt };
}

function validateChannelData(channels) {
  const errors = [];
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (ch.weight !== undefined && (typeof ch.weight !== "number" || ch.weight < 1 || ch.weight > 1000))
      errors.push(`[${i}] Invalid weight ${ch.weight}, must be 1–1000`);
    if (!ch.base_url || (typeof ch.base_url === "string" && ch.base_url.trim().length === 0)) {
      errors.push(`[${i}] base_url is required`);
    } else if (ch.base_url && typeof ch.base_url === "string") {
      try { new URL(ch.base_url); } catch (e) { errors.push(`[${i}] Invalid base_url "${ch.base_url}"`); }
    }
  }
  return errors;
}

const CHANNEL_INSERT_COLS = "id, name, base_url, api_key, model, weight, is_enabled";
const CHANNEL_INSERT_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?";

export default function (_clearCache) {
  const api = new Hono();

  function clearCache() {
    _clearCache();
    clearResCache();
  }

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

  api.get("/init", withCache(async (c) => {
    const [ch, fl] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    const channels = (ch.results || []).map(ch => ({
      ...ch, api_key: maskApiKey(ch.api_key || ''),
    }));
    return {
      channels,
      filters: fl.results || [],
      config: { token: cf?.client_token || "" },
    };
  }));

  const channelsListHandler = withCache(async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all();
    return (results || []).map(ch => ({ ...ch, api_key: maskApiKey(ch.api_key || '') }));
  });

  api.get("/", channelsListHandler);
  api.get("/channels", channelsListHandler);

  api.post("/batch-channels", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body)) return c.json({ ok: false, error: "Expected array" }, 400);
    const channels = body;
    const errs = validateChannelData(channels);
    if (errs.length > 0) return c.json({ ok: false, error: "Validation failed", details: errs }, 400);
    const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
    const allKeys = {};
    for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
    const batch = [c.env.DB.prepare("DELETE FROM channels")];
    for (const ch of channels) {
      const apiKey = ch.api_key || (allKeys[ch.id] || "");
      batch.push(
        c.env.DB.prepare(
          `INSERT INTO channels (${CHANNEL_INSERT_COLS}) VALUES (${CHANNEL_INSERT_PLACEHOLDERS})`
        ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey,
          ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0
        )
      );
    }
    await batchChunked(c.env.DB, batch);
    clearCache();
    return c.json({ ok: true });
  });

  api.get("/filters", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all();
    return c.json(results || []);
  });

  api.post("/filters", async (c) => {
    const filters = await c.req.json();
    const stmts = [
      c.env.DB.prepare("DELETE FROM filters"),
      ...filters.map((f) =>
        c.env.DB.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0)
      ),
    ];
    await batchChunked(c.env.DB, stmts);
    clearCache();
    return c.json({ ok: true });
  });

  api.get("/config", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
      return c.json({
        token: cf?.client_token || getDefaults().token,
      });
    } catch (e) {
      return c.json({ token: getDefaults().token });
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
    const ex = await c.env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    const existingToken = ex?.client_token || "";
    try {
      const token = b.token || existingToken || getDefaults().token;
      if (ex) {
        await c.env.DB.prepare("UPDATE config SET client_token=? WHERE id=1")
          .bind(token).run();
      } else {
        await c.env.DB.prepare("INSERT INTO config (id, client_token) VALUES (1, ?)")
          .bind(token).run();
      }
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/admin-pass", async (c) => {
    const ip = c.req.header("CF-Connecting-IP")
      || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
      || "unknown";
    const rl = checkSetupRateLimit(ip);
    if (rl.blocked) return c.json({ error: "嘗試過多，請 10 分鐘後再试" }, 429);

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

  api.post("/channels/:id/test", async (c) => {
    const chId = parseInt(c.req.param("id"), 10);
    const reqBody = await c.req.json().catch(() => ({}));
    const fromBody = !!reqBody.base_url;
    let ch;
    if (fromBody) {
      ch = { id: chId, ...reqBody };
    } else {
      const rows = (await c.env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(chId).all()).results || [];
      ch = rows[0];
    }
    if (!ch) return c.json({ ok: false, error: "Channel not found", diagnosis: "渠道不存在" }, 404);

    const baseUrl = ch.base_url || "";
    const testUrl = baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const start = Date.now();
    try {
      const res = await fetch(testUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + (ch.api_key || ""),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: ch.model || "test", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      const ms = Date.now() - start;
      const ok = res.status === 200 || res.status === 400;
      return c.json({
        ok,
        status: res.status,
        ms,
        diagnosis: ok ? "連線正常" : `HTTP ${res.status}`,
      });
    } catch (e) {
      const ms = Date.now() - start;
      return c.json({
        ok: false,
        status: 0,
        ms,
        diagnosis: "連線失敗: " + (e.message?.slice(0, 60) || "unknown"),
      });
    }
  });

  api.post("/reset", async (c) => {
    const freshToken = generateFallbackToken();
    await retry(() => c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(freshToken),
    ]));
    clearCache();
    return c.json({ ok: true, new_token: freshToken });
  });

  return api;
}
