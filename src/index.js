import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import portalHtml from "./dashboard/portal.html";

const UPSTREAM_TIMEOUT_MS = 120_000;
const CHANNEL_COOLDOWN_MS = UPSTREAM_TIMEOUT_MS;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const TOKEN_TTL = 60_000;
const FILTER_TTL = 180_000;
const SESSION_TTL = 86400000;
const SESSION_PRUNE_INTERVAL = 50;
const adminSessions = new Map();
let sessionPruneCounter = 0;

async function generateSessionToken(env) {
  const token = generateToken("sess-");
  const expiresAt = Date.now() + SESSION_TTL;
  adminSessions.set(token, expiresAt);
  await env.DB.prepare("INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expiresAt).run().catch(() => {});
  return token;
}

async function isValidSession(env, token) {
  const expiry = adminSessions.get(token);
  if (expiry) {
    if (Date.now() > expiry) { adminSessions.delete(token); return false; }
    return true;
  }
  try {
    const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token=?").bind(token).first();
    if (row && row.expires_at > Date.now()) {
      adminSessions.set(token, row.expires_at);
      return true;
    }
    if (row) {
      env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(token).run().catch(() => {});
    }
  } catch (e) {}
  return false;
}

let pruneD1Counter = 0;
function maybePruneSessions() {
  if (++sessionPruneCounter % SESSION_PRUNE_INTERVAL !== 0) return;
  const now = Date.now();
  for (const [k, v] of adminSessions) { if (now > v) adminSessions.delete(k); }
  if (adminSessions.size > 10000) adminSessions.clear();
}
async function pruneSessionD1(env) {
  if (++pruneD1Counter % 20 !== 0) return;
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run().catch(() => {});
}
const REFRESH_MS = 60_000;
const D1_BATCH_LIMIT = 99;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_BAN_MS = 15 * 60 * 1000;
const SETUP_MAX_ATTEMPTS = 5;
const SETUP_BAN_MS = 10 * 60 * 1000;
const API_PREFIXES = ["/v1", "/v1beta", "/v2", "/v3", "/v4"];
const STREAM_TYPES = ["both", "stream", "nonstream"];
const BLOCKED_CUSTOM_HEADERS = new Set(["authorization", "content-type", "content-length", "host", "connection", "transfer-encoding"]);
const CHANNEL_TYPES = ["chat", "image_gen", "image_edit", "tts", "stt", "embed", "moderate", "assistant", "fine_tune", "file", "responses", "batches", "models", "realtime"];
const CHANNEL_TYPE_ROUTES = {
  chat:       ["/chat/completions", "/completions"],
  image_gen:  ["/images/generations"],
  image_edit: ["/images/edits", "/images/variations"],
  stt:        ["/audio/transcriptions", "/audio/translations"],
  tts:        ["/audio/speech"],
  embed:      ["/embeddings"],
  moderate:   ["/moderations"],
  assistant:  ["/assistants", "/threads", "/vector-stores"],
  fine_tune:  ["/fine-tuning", "/fine_tuning"],
  file:       ["/files"],
  responses:  ["/responses"],
  batches:    ["/batches"],
  models:     ["/models"],
  realtime:   ["/realtime"],
};

function getPathChannelType(suffix) {
  for (const [type, routes] of Object.entries(CHANNEL_TYPE_ROUTES)) {
    for (const route of routes) {
      if (suffix === route || suffix.startsWith(route + "/")) return type;
    }
  }
  return "chat";
}

function generateToken(prefix = "sk-") {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = new Uint32Array(30);
  crypto.getRandomValues(rand);
  let t = prefix;
  for (let i = 0; i < 30; i++) t += chars[rand[i] % chars.length];
  return t;
}

const API_KEY_REGEX = /(["']?api_key["']?\s*[:=]\s*["']?)([^"'\s,}\]">]+)/gi;

function maskApiKey(str) {
  if (typeof str !== "string") return str;
  return str.replace(API_KEY_REGEX, (m, pre, key) => {
    if (key.length > 8) return pre + key.slice(0, 8) + "***";
    return pre + "***";
  });
}

function getDefaults() {
  return { token: generateToken() };
}

function requestId() {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return "req_" + Array.from(buf).map(b => b.toString(36).padStart(2, "0")).join("");
}

function logStructured(level, msg, extra = {}) {
  const entry = { ts: Date.now(), level, msg, ...extra };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

async function retry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      const delay = Math.min(100 * Math.pow(2, i), 3000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let pepper = "";
function setPepper(p) { pepper = p || ""; }

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

let schemaReady = false;

const CHANNELS_DDL = `CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL DEFAULT '',
  base_url    TEXT    NOT NULL DEFAULT '',
  api_key     TEXT    NOT NULL DEFAULT '',
  model       TEXT    NOT NULL DEFAULT '',
  weight      INTEGER NOT NULL DEFAULT 50,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  stream_type TEXT    NOT NULL DEFAULT 'both',
  channel_type TEXT   NOT NULL DEFAULT 'chat',
  headers     TEXT    NOT NULL DEFAULT '[]',
  provider_options TEXT NOT NULL DEFAULT '[]',
  provider     TEXT    NOT NULL DEFAULT '',
  absolute_url INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT unixepoch(),
  updated_at  INTEGER NOT NULL DEFAULT unixepoch(),
  support_tools INTEGER NOT NULL DEFAULT 1,
  response_time INTEGER NOT NULL DEFAULT 0,
  fallback_model TEXT NOT NULL DEFAULT '',
  max_tokens INTEGER NOT NULL DEFAULT 0,
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  rpd_limit INTEGER NOT NULL DEFAULT 0,
  rpm_count INTEGER NOT NULL DEFAULT 0,
  rpm_reset_at INTEGER NOT NULL DEFAULT 0,
  rpd_count INTEGER NOT NULL DEFAULT 0,
  rpd_reset_at INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error_msg TEXT NOT NULL DEFAULT '',
  last_error_at INTEGER NOT NULL DEFAULT 0,
  support_stream INTEGER NOT NULL DEFAULT 1,
  support_image_gen INTEGER NOT NULL DEFAULT 0,
  support_audio_tts INTEGER NOT NULL DEFAULT 0,
  support_audio_stt INTEGER NOT NULL DEFAULT 0,
  support_image_edit INTEGER NOT NULL DEFAULT 0,
  support_embeddings INTEGER NOT NULL DEFAULT 0,
  health_check_enabled INTEGER NOT NULL DEFAULT 0,
  health_check_interval INTEGER NOT NULL DEFAULT 300,
  health_check_timeout INTEGER NOT NULL DEFAULT 5,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  cache_enabled INTEGER NOT NULL DEFAULT 0,
  cache_ttl INTEGER NOT NULL DEFAULT 3600,
  rate_limit_algorithm TEXT NOT NULL DEFAULT 'rpm',
  rate_limit_capacity INTEGER NOT NULL DEFAULT 0,
  rate_limit_rate INTEGER NOT NULL DEFAULT 0,
  rate_limit_key TEXT NOT NULL DEFAULT ''
)`;

const FILTERS_DDL = `CREATE TABLE IF NOT EXISTS filters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT    NOT NULL,
  mode        INTEGER NOT NULL DEFAULT 1,
  is_enabled  INTEGER NOT NULL DEFAULT 1
)`;

const CONFIG_DDL = `CREATE TABLE IF NOT EXISTS config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  client_token    TEXT    NOT NULL DEFAULT '',
  admin_password  TEXT    NOT NULL DEFAULT ''
)`;

const SCHEMA_META_DDL = `CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`;

const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;

const ALL_DDLS = [CHANNELS_DDL, FILTERS_DDL, CONFIG_DDL, SCHEMA_META_DDL, SESSIONS_DDL];
const ALL_TABLES = ["channels", "filters", "config", "schema_meta", "sessions"];

async function ensureSchema(env) {
  if (schemaReady) return;
  let ok = 0;
  for (let i = 0; i < ALL_DDLS.length; i++) {
    try {
      await env.DB.prepare(ALL_DDLS[i]).run();
      ok++;
    } catch (e) {
      console.error(`[schema] failed to create table ${ALL_TABLES[i]}:`, e.message);
    }
  }
  try {
    const cf = await env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    if (!cf) {
      const token = generateToken();
      await env.DB.prepare(
        "INSERT INTO config (id, client_token, admin_password) VALUES (1, ?, '')"
      ).bind(token).run();
    } else if (!cf.client_token) {
      const token = generateToken();
      await env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(token).run();
    }
  } catch (e) {
    console.error("[schema] failed to ensure config row:", e.message);
  }
  if (ok > 0) console.log(`[schema] ${ok}/${ALL_DDLS.length} tables ready`);
  // 用 DB flag 判斷 migration 是否已完成，避免重複 39 次 ALTER TABLE probe
  let schemaVer = "0";
  try {
    const meta = await env.DB.prepare("SELECT value FROM schema_meta WHERE key='schema_ver'").first();
    schemaVer = meta?.value || "0";
  } catch (e) { /* schema_meta 表格尚未就緒 */ }
  if (schemaVer < "2") {
    const migrations = [
      "ALTER TABLE channels ADD COLUMN stream_type TEXT NOT NULL DEFAULT 'both'",
      "ALTER TABLE channels ADD COLUMN headers TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE channels ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'chat'",
      "ALTER TABLE channels ADD COLUMN provider_options TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE channels ADD COLUMN provider TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE channels ADD COLUMN absolute_url INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN cooldown_until INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN support_tools INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE channels ADD COLUMN response_time INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN fallback_model TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE channels ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rpd_limit INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rpm_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rpm_reset_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rpd_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rpd_reset_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN last_error_msg TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE channels ADD COLUMN last_error_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN support_stream INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE channels ADD COLUMN support_image_gen INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN support_audio_tts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN support_audio_stt INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN support_image_edit INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN support_embeddings INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN health_check_enabled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN health_check_interval INTEGER NOT NULL DEFAULT 300",
      "ALTER TABLE channels ADD COLUMN health_check_timeout INTEGER NOT NULL DEFAULT 5",
      "ALTER TABLE channels ADD COLUMN consecutive_successes INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN cache_enabled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN cache_ttl INTEGER NOT NULL DEFAULT 3600",
      "ALTER TABLE channels ADD COLUMN rate_limit_algorithm TEXT NOT NULL DEFAULT 'rpm'",
      "ALTER TABLE channels ADD COLUMN rate_limit_capacity INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rate_limit_rate INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN rate_limit_key TEXT NOT NULL DEFAULT ''",
    ];
    for (const sql of migrations) {
      try { await env.DB.prepare(sql).run(); } catch (e) { /* 欄位已存在則略過 */ }
    }
  }
  // migration 完成後寫入 DB flag，下次冷啟動直接跳過
  await env.DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_ver', '2')").run();
  schemaReady = true;
}

class RollingFilter {
  constructor(filters) {
    this.filters = (filters || []).filter(f => f.is_enabled && f.text && f.text.length >= 1 && f.text.length <= 30);
    this.buf = "";
    this.safe = this.filters.reduce((m, f) => Math.max(m, f.text.length - 1), 0);
    this.truncated = false;
  }
  transform(chunk) {
    if (this.filters.length === 0) return chunk;
    if (this.truncated) return "";
    this.buf += chunk;
    for (const f of this.filters) {
      if (f.mode === 1) {
        const idx = this.buf.indexOf(f.text);
        if (idx !== -1) { this.buf = this.buf.substring(0, idx); this.truncated = true; break; }
      } else {
        this.buf = this.buf.split(f.text).join("");
      }
    }
    if (this.truncated) { const out = this.buf; this.buf = ""; return out; }
    const flush = Math.max(0, this.buf.length - this.safe);
    const out = this.buf.slice(0, flush);
    this.buf = this.buf.slice(flush);
    return out;
  }
  flush() {
    if (this.truncated) return "";
    const out = this.buf; this.buf = ""; return out;
  }
  static applyStatic(text, filters) {
    if (!text || !filters || filters.length === 0) return text;
    const enabled = filters.filter(f => f.is_enabled && f.text && f.text.length >= 1 && f.text.length <= 30);
    let out = text;
    for (const f of enabled) {
      if (f.mode === 1) { const idx = out.indexOf(f.text); if (idx !== -1) out = out.substring(0, idx); }
      else { out = out.split(f.text).join(""); }
    }
    return out;
  }
}

let cachedChannels = null;
let lastLoad = 0;
let loadPromise = null;
const degradedUntil = new Map();

async function loadChannels(env, channelType) {
  const now = Date.now();
  if (!channelType && cachedChannels && now - lastLoad < REFRESH_MS) return cachedChannels;
  if (loadPromise && !channelType) return loadPromise;
  loadPromise = (async () => {
    try {
      let sql = `SELECT id, name, base_url, api_key, weight, stream_type, channel_type, headers,
        cooldown_until, rpm_limit, rpd_limit, rpm_count, rpm_reset_at, rpd_count, rpd_reset_at,
        consecutive_errors, consecutive_successes, health_check_enabled, health_check_interval, health_check_timeout,
        cache_enabled, cache_ttl,
        rate_limit_algorithm, rate_limit_capacity, rate_limit_rate,
        fallback_model, model, max_tokens, is_enabled
        FROM channels WHERE is_enabled = 1`;
      const params = [];
      if (channelType) { sql += " AND channel_type = ?"; params.push(channelType); }
      sql += " ORDER BY weight DESC";
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      const rows = results || [];
      const nowMs = Date.now();
      const active = rows.filter(ch => !ch.cooldown_until || ch.cooldown_until <= nowMs);
      for (const ch of rows) {
        if (ch.cooldown_until > 0 && ch.cooldown_until <= nowMs) {
          env.DB.prepare("UPDATE channels SET cooldown_until=0 WHERE id=?").bind(ch.id).run().catch(() => {});
        }
        if (ch.cooldown_until > nowMs) { degradedUntil.set(ch.id, ch.cooldown_until); }
      }
      if (!channelType) { cachedChannels = active; lastLoad = Date.now(); }
      return active;
    } catch (e) {
      console.error("[channel] load error:", e.message);
      if (!channelType) cachedChannels = cachedChannels || [];
      return cachedChannels || [];
    }
  })();
  return loadPromise;
}

function clearChannelCache() {
  cachedChannels = null;
  lastLoad = 0;
}

function selectChannel(channels, exclude = new Set()) {
  // 如果所有 channel 都已 degraded，嘗試撈取已冷卻完畢的 channel
  const healthy = channels.filter(c => !exclude.has(c.id) && !isDegraded(c.id));
  if (healthy.length === 0) return null;
  const pool = healthy;
  const totalWeight = pool.reduce((s, c) => s + Math.max(c.weight, 1), 0);
  let r = Math.random() * totalWeight;
  for (const c of pool) {
    r -= Math.max(c.weight, 1);
    if (r <= 0) return c;
  }
  return pool[pool.length - 1];
}

function markDegraded(channelId, env) {
  const until = Date.now() + CHANNEL_COOLDOWN_MS;
  degradedUntil.set(channelId, until);
  if (env) {
    // 遞增 consecutive_errors；達閾值則自動關閉 channel（冷卻過後管理員可手動重啟）
    env.DB.prepare(`UPDATE channels SET cooldown_until=?, consecutive_errors=consecutive_errors+1, consecutive_successes=0 WHERE id=?`).bind(until, channelId).run().catch(() => {});
  }
}

function markHealthy(channelId, env) {
  degradedUntil.delete(channelId);
  if (env) {
    // 遞增 consecutive_successes；達 3 次則重置 consecutive_errors 與 cooldown
    env.DB.prepare(`UPDATE channels SET cooldown_until=0, consecutive_successes=consecutive_successes+1, consecutive_errors=CASE WHEN consecutive_errors>0 THEN consecutive_errors-1 ELSE 0 END WHERE id=?`).bind(channelId).run().catch(() => {});
  }
}

function isDegraded(channelId) {
  const until = degradedUntil.get(channelId);
  if (!until) return false;
  if (Date.now() < until) return true;
  degradedUntil.delete(channelId);
  return false;
}

// 簡易記憶體 Token Bucket（按 channelId）
const tokenBuckets = new Map();
const TOKEN_BUCKET_SYNC_MS = 30000;
let lastBucketSync = 0;

function checkRateLimit(channel) {
  if (!channel.rpm_limit && !channel.rpd_limit && !channel.rate_limit_capacity) return { ok: true };
  const now = Date.now();
  const cid = channel.id || 0;
  let bucket = tokenBuckets.get(cid);
  if (!bucket) {
    bucket = {
      rpm: channel.rpm_limit || 0, rpmTs: now, rpmCount: 0,
      rpd: channel.rpd_limit || 0, rpdTs: now, rpdCount: 0,
      tokens: channel.rate_limit_capacity || 0, tokenTs: now,
      capacity: channel.rate_limit_capacity || 0, rate: (channel.rate_limit_rate || 0) / 60,
    };
    tokenBuckets.set(cid, bucket);
  }
  // RPM 檢查
  if (bucket.rpm > 0) {
    if (now - bucket.rpmTs > 60000) { bucket.rpmCount = 0; bucket.rpmTs = now; }
    if (bucket.rpmCount >= bucket.rpm) return { ok: false, reason: "rpm_limit" };
    bucket.rpmCount++;
  }
  // RPD 檢查
  if (bucket.rpd > 0) {
    if (now - bucket.rpdTs > 86400000) { bucket.rpdCount = 0; bucket.rpdTs = now; }
    if (bucket.rpdCount >= bucket.rpd) return { ok: false, reason: "rpd_limit" };
    bucket.rpdCount++;
  }
  // Token Bucket（演算法）
  if (bucket.capacity > 0 && bucket.rate > 0) {
    const elapsed = (now - bucket.tokenTs) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.rate);
    bucket.tokenTs = now;
    if (bucket.tokens < 1) return { ok: false, reason: "rate_limit" };
    bucket.tokens -= 1;
  }
  return { ok: true };
}

// 記憶體快取（non-stream 響應）
const responseCache = new Map();
const CACHE_MAX_ENTRIES = 200;

function getCacheKey(model, body) {
  if (!body) return null;
  try {
    const p = typeof body === "string" ? JSON.parse(body) : body;
    const msgHash = JSON.stringify(p.messages || p.input || "");
    return `${model || ""}:${msgHash.length}:${hashStr(msgHash)}`;
  } catch { return null; }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h.toString(36);
}

function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { responseCache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data, ttl) {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey) responseCache.delete(firstKey);
  }
  responseCache.set(key, { data, expires: Date.now() + (ttl || 3600) * 1000 });
}

let tokenCache = { token: null, ts: 0 };

async function resolveClientToken(env) {
  if (tokenCache.token && Date.now() - tokenCache.ts < TOKEN_TTL) return tokenCache.token;
  try {
    const cf = await env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    tokenCache = { token: cf?.client_token || null, ts: Date.now() };
  } catch {
    tokenCache = { token: null, ts: Date.now() };
  }
  return tokenCache.token;
}

let filterCache = { data: null, ts: 0 };

async function loadFilters(env) {
  if (filterCache.data && Date.now() - filterCache.ts < FILTER_TTL) return filterCache.data;
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, text, mode, is_enabled FROM filters WHERE is_enabled = 1 ORDER BY id"
    ).all();
    filterCache = { data: results || [], ts: Date.now() };
  } catch {
    filterCache = { data: [], ts: Date.now() };
  }
  return filterCache.data;
}

function clearGatewayCache() {
  tokenCache = { token: null, ts: 0 };
  filterCache = { data: null, ts: 0 };
  clearChannelCache();
}

function buildBaseHeaders(reqHeaders, rid) {
  const headers = new Headers(reqHeaders);
  headers.set("X-Request-Id", rid);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-worker");
  headers.delete("cf-visitor");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");
  return headers;
}

function cleanResponseHeaders(headers) {
  const h = new Headers(headers);
  h.delete("content-encoding");
  h.delete("transfer-encoding");
  h.delete("cf-ray");
  h.delete("cf-cache-status");
  return h;
}

function createFilterTransform(filters) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const line of parts) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") { controller.enqueue(encoder.encode(line + "\n")); continue; }
          try {
            const parsed = JSON.parse(payload);
            if (parsed.choices) {
              for (const choice of parsed.choices) {
                const delta = choice?.delta || {};
                if (delta.content) delta.content = RollingFilter.applyStatic(delta.content, filters);
                if (delta.refusal) delta.refusal = RollingFilter.applyStatic(delta.refusal, filters);
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.arguments) tc.function.arguments = RollingFilter.applyStatic(tc.function.arguments, filters);
                  }
                }
              }
            }
            controller.enqueue(encoder.encode("data: " + JSON.stringify(parsed) + "\n"));
          } catch { controller.enqueue(encoder.encode(line + "\n")); }
        } else { controller.enqueue(encoder.encode(line + "\n")); }
      }
    },
    flush(controller) { if (buf) controller.enqueue(encoder.encode(buf + "\n")); },
  });
}

function createIdleTimeoutStream(readable, idleMs) {
  const reader = readable.getReader();
  const { readable: out, writable } = new TransformStream();
  const writer = writable.getWriter();
  let idleTimer;
  (async () => {
    try {
      while (true) {
        clearTimeout(idleTimer);
        const timeout = new Promise((_, reject) => { idleTimer = setTimeout(() => reject(new Error("idle")), idleMs); });
        const result = await Promise.race([reader.read(), timeout]);
        clearTimeout(idleTimer);
        if (result.done) { await writer.close(); return; }
        await writer.write(result.value);
      }
    } catch (e) { await writer.close(); }
    finally { clearTimeout(idleTimer); reader.releaseLock(); }
  })();
  return out;
}

async function tryForward(env, path, method, baseHeaders, body, rid, streamType, clientSignal) {
  const matched = API_PREFIXES.find(p => path === p || path.startsWith(p + "/"));
  const suffix = matched ? path.slice(matched.length) : path;
  const requiredType = getPathChannelType(suffix);
  let channels = await loadChannels(env, requiredType);
  if (channels.length === 0) {
    if (requiredType !== "chat") {
      return { error: { message: `No enabled channel with type "${requiredType}" for path "${suffix}"`, status: 503 } };
    }
    channels = await loadChannels(env);
    if (channels.length === 0) return { error: { message: "No upstream channels available", status: 503 } };
  }
  let eligible = streamType ? channels.filter(c => c.stream_type === "both" || c.stream_type === streamType) : channels;
  if (eligible.length === 0) {
    logStructured("warn", "no channels match stream_type, falling back to all", { streamType, path, rid });
    eligible = channels;
  }
  // 非串流請求嘗試走快取
  if (streamType !== "stream" && body && requiredType !== "chat") {
    const ck = getCacheKey("", body);
    if (ck) {
      const cached = cacheGet(ck);
      if (cached) return { response: new Response(cached.body, { status: 200, headers: new Headers(cached.headers) }) };
    }
  }
  const attempted = new Set();
  for (let i = 0; i < Math.min(3, eligible.length); i++) {
    if (clientSignal?.aborted) return { error: { message: "Client disconnected", status: 499 } };
    const channel = selectChannel(eligible, attempted);
    if (!channel) break;
    // rate limit 檢查
    const rl = checkRateLimit(channel);
    if (!rl.ok) {
      attempted.add(channel.id);
      logStructured("warn", "rate limit exceeded, try next", { channel: channel.name, reason: rl.reason, rid });
      markDegraded(channel.id, env);
      continue;
    }
    const upstreamPath = suffix;
    const url = channel.base_url.replace(/\/+$/, "") + upstreamPath;
    const headers = new Headers(baseHeaders);
    headers.set("Authorization", `Bearer ${channel.api_key}`);
    // 套用自訂 header
    if (channel.headers) {
      try {
        const customHeaders = typeof channel.headers === "string" ? JSON.parse(channel.headers) : channel.headers;
        if (Array.isArray(customHeaders)) {
          for (const h of customHeaders) {
            if (h.key && h.key.trim() && !BLOCKED_CUSTOM_HEADERS.has(h.key.trim().toLowerCase())) headers.set(h.key.trim(), h.value || "");
          }
        }
      } catch (e) {}
    }
    // 從 provider_options 解析請求重寫規則
    let reqBody = body;
    if (channel.provider_options) {
      try {
        const opts = typeof channel.provider_options === "string" ? JSON.parse(channel.provider_options) : channel.provider_options;
        if (opts.rewrite?.request?.headers) {
          for (const [k, v] of Object.entries(opts.rewrite.request.headers)) {
            if (v === null || v === "") headers.delete(k);
            else headers.set(k, String(v));
          }
        }
        if (opts.rewrite?.request?.body && reqBody) {
          const bodyStr = reqBody instanceof ArrayBuffer ? new TextDecoder().decode(reqBody) : (typeof reqBody === "string" ? reqBody : null);
          if (bodyStr) {
            let parsed = JSON.parse(bodyStr);
            // model_map: 將用戶請求的 model 名稱映射到 provider 使用的 model 名稱
            if (opts.model_map && parsed.model) {
              const mapped = opts.model_map[parsed.model];
              if (mapped) parsed.model = mapped;
            }
            for (const [path, val] of Object.entries(opts.rewrite.request.body)) {
              if (path === "model") parsed.model = val;
              else if (path === "max_tokens") parsed.max_tokens = val;
              else if (path === "temperature") parsed.temperature = val;
              else if (path === "top_p") parsed.top_p = val;
              else { parsed[path] = val; }
            }
            reqBody = JSON.stringify(parsed);
          }
        }
      } catch (e) {}
    }
    // fallback_model: 覆寫請求 model（無論有無 provider_options 都適用）
    if (channel.fallback_model && reqBody) {
      try {
        const bodyStr = reqBody instanceof ArrayBuffer ? new TextDecoder().decode(reqBody) : (typeof reqBody === "string" ? reqBody : null);
        if (bodyStr) {
          const parsed = JSON.parse(bodyStr);
          if (parsed.model && parsed.model !== channel.fallback_model) {
            parsed.model = channel.fallback_model;
            reqBody = JSON.stringify(parsed);
          }
        }
      } catch (e) {}
    }
    let timer;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (clientSignal) {
      clientSignal.addEventListener("abort", onAbort, { once: true });
      if (clientSignal.aborted) {
        clientSignal.removeEventListener("abort", onAbort);
        controller.abort();
      }
    }
    try {
      if (method === "POST" && body && channel.stream_type === "nonstream") {
        try {
          const bodyStr = reqBody instanceof ArrayBuffer ? new TextDecoder().decode(reqBody) : reqBody;
          const parsed = JSON.parse(bodyStr);
          if (parsed.stream === true) {
            const { stream, ...rest } = parsed;
            reqBody = JSON.stringify(rest);
          }
        } catch (e) {}
      }
      timer = setTimeout(onAbort, UPSTREAM_TIMEOUT_MS);
      const res = await fetch(url, { method, headers, body: reqBody, signal: controller.signal });
      clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onAbort);
      if (res.ok) {
        markHealthy(channel.id, env);
        // 套用響應重寫 / 驗證
        if (channel.provider_options) {
          try {
            const opts = typeof channel.provider_options === "string" ? JSON.parse(channel.provider_options) : channel.provider_options;
            if (opts.validate?.response?.required_fields && res.headers.get("Content-Type")?.includes("json")) {
              const text = await res.clone().text();
              const parsed = JSON.parse(text);
              for (const field of opts.validate.response.required_fields) {
                if (field.includes(".")) {
                  const parts = field.split(".");
                  let val = parsed;
                  for (const p of parts) { if (val != null) val = val[p]; }
                  if (val == null) { logStructured("warn", "response validation failed", { channel: channel.name, missing: field, rid }); }
                } else if (parsed[field] == null) {
                  logStructured("warn", "response validation failed", { channel: channel.name, missing: field, rid });
                }
              }
            }
            if (opts.rewrite?.response?.headers) {
              for (const [k, v] of Object.entries(opts.rewrite.response.headers)) {
                if (v === null || v === "") res.headers.delete(k);
                else res.headers.set(k, String(v));
              }
            }
      } catch (e) {}
    }
        // 非串流快取：僅快取 embeddings / moderations 類型
        if (streamType !== "stream" && !(body && typeof body === "string" && body.includes('"stream":true'))) {
          const ct = res.headers.get("Content-Type") || "";
          if (ct.includes("application/json") && (requiredType === "embed" || requiredType === "moderate")) {
            res.clone().text().then(text => {
              const ck = getCacheKey("", body);
              if (ck) cacheSet(ck, { body: text, headers: { "Content-Type": ct } }, channel.cache_ttl || 3600);
            }).catch(() => {});
          }
        }
        return { response: res, channel };
      }
      if (res.status >= 500 || res.status === 429) {
        res.body?.cancel().catch(() => {});
        markDegraded(channel.id, env);
        logStructured("warn", "upstream error, retrying", { channel: channel.name, status: res.status, rid });
        continue;
      }
      return { response: res };
    } catch (err) {
      clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onAbort);
      if (clientSignal?.aborted) return { error: { message: "Client disconnected", status: 499 } };
      markDegraded(channel.id, env);
      logStructured("warn", "upstream fetch failed", { channel: channel.name, error: err.message, rid });
      continue;
    }
  }
  return { error: { message: "All upstream channels failed", status: 502 } };
}

async function handleChatCompletions(c) {
  const rid = requestId();
  const rawBody = await c.req.raw.clone().text();
  let body, isStream = false;
  try {
    body = JSON.parse(rawBody);
    isStream = body?.stream === true;
  } catch (e) {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error", param: null, code: "invalid_request_error" } }, 400);
  }
  logStructured("info", "chat completion", { model: body?.model || "unknown", stream: isStream, rid });
  const baseHeaders = buildBaseHeaders(c.req.raw.headers, rid);
  const result = await tryForward(c.env, c.req.path, "POST", baseHeaders, rawBody, rid, isStream ? "stream" : "nonstream", c.req.raw.signal);
  if (result.error) {
    return c.json({ error: { message: result.error.message, type: "upstream_error", param: null, code: "upstream_error" } }, result.error.status);
  }
  const { response: upstream } = result;
  const resHeaders = cleanResponseHeaders(upstream.headers);
  resHeaders.set("X-Request-Id", rid);
  if (isStream) {
    const ct = upstream.headers.get("Content-Type") || "";
    if (!ct.includes("text/event-stream")) {
      const text = await upstream.text();
      if (upstream.status !== 200) {
        try { return c.json(JSON.parse(text), upstream.status); } catch (e) { return c.text(text, upstream.status); }
      }
      const filters = await loadFilters(c.env);
      const sseHeaders = new Headers(resHeaders);
      sseHeaders.set("Content-Type", "text/event-stream");
      sseHeaders.set("Cache-Control", "no-cache");
      sseHeaders.set("X-Accel-Buffering", "no");
      return new Response(nonStreamToStream(text, filters), { status: 200, headers: sseHeaders });
    }
    let sseBody = createIdleTimeoutStream(upstream.body, STREAM_IDLE_TIMEOUT_MS);
    const filters = await loadFilters(c.env);
    if (filters.length > 0) sseBody = sseBody.pipeThrough(createFilterTransform(filters));
    resHeaders.set("Cache-Control", "no-cache");
    resHeaders.set("X-Accel-Buffering", "no");
    return new Response(sseBody, { status: upstream.status, headers: resHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

function nonStreamToStream(bodyText, filters) {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const sse = (data) => w.write(enc.encode("data: " + JSON.stringify(data) + "\n\n"));
  (async () => {
    try {
      const p = JSON.parse(bodyText);
      const id = p.id || "chatcmpl-" + Date.now();
      const created = p.created || Math.floor(Date.now() / 1000);
      const model = p.model || "unknown";
      if (!Array.isArray(p.choices) || p.choices.length === 0) {
        await w.write(enc.encode("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n"));
        if (p.usage) {
          await sse({ id, object: "chat.completion.chunk", created, model, choices: [], usage: p.usage });
        }
        await w.write(enc.encode("data: [DONE]\n\n"));
        await w.close();
        return;
      }
      for (const ch of p.choices) {
        const idx = ch.index || 0;
        const msg = ch.message || {};
        const finish = ch.finish_reason || null;
        if (msg.role) {
          await sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: idx, delta: { role: msg.role }, finish_reason: null }] });
        }
        if (msg.content) {
          const content = filters?.length > 0 ? RollingFilter.applyStatic(msg.content, filters) : msg.content;
          await sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: idx, delta: { content }, finish_reason: null }] });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            await sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: idx, delta: { tool_calls: [{ index: tc.index || 0, id: tc.id, type: tc.type || "function", function: { name: tc.function?.name || "", arguments: "" } }] }, finish_reason: null }] });
            if (tc.function?.arguments) {
              const filteredArgs = filters?.length > 0 ? RollingFilter.applyStatic(tc.function.arguments, filters) : tc.function.arguments;
              await sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: idx, delta: { tool_calls: [{ index: tc.index || 0, function: { arguments: filteredArgs } }] }, finish_reason: null }] });
            }
          }
        }
        await sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: idx, delta: {}, finish_reason: finish }] });
      }
      if (p.usage) {
        await sse({ id, object: "chat.completion.chunk", created, model, choices: [], usage: p.usage });
      }
      await w.write(enc.encode("data: [DONE]\n\n"));
    } catch (e) {
      logStructured("error", "non-stream to stream conversion failed", { error: e.message });
      try {
        const fallbackId = "chatcmpl-" + Date.now();
        await sse({ id: fallbackId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown", choices: [{ index: 0, delta: {}, finish_reason: "error" }] });
        await w.write(enc.encode("data: [DONE]\n\n"));
      } catch (e2) {}
    }
    try { await w.close(); } catch (e) { logStructured("warn", "closing non-stream writer failed", { error: e.message }); }
  })();
  return readable;
}

async function handleModels(c) {
  const channels = await loadChannels(c.env);
  if (channels.length === 0) return c.json({ object: "list", data: [] });
  for (const channel of channels) {
    if (isDegraded(channel.id)) continue;
    try {
      const url = channel.base_url.replace(/\/+$/, "") + "/models";
      const headers = new Headers({ Authorization: `Bearer ${channel.api_key}` });
      if (channel.headers) {
        try {
          const ch = typeof channel.headers === "string" ? JSON.parse(channel.headers) : channel.headers;
          if (Array.isArray(ch)) for (const h of ch) { if (h.key && h.key.trim() && !BLOCKED_CUSTOM_HEADERS.has(h.key.trim().toLowerCase())) headers.set(h.key.trim(), h.value || ""); }
        } catch (e) {}
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        markHealthy(channel.id, c.env);
        return c.json(await res.json());
      }
      if (res.status >= 500 || res.status === 429) markDegraded(channel.id, c.env);
    } catch (e) {
      markDegraded(channel.id, c.env);
      logStructured("warn", "models fetch failed, trying next", { channel: channel.name, error: e.message });
    }
  }
  return c.json({ object: "list", data: [] });
}

async function handleGenericProxy(c) {
  const rid = requestId();
  const path = c.req.path;
  const baseHeaders = buildBaseHeaders(c.req.raw.headers, rid);
  const rawBody = c.req.method !== "GET" && c.req.method !== "HEAD"
    ? await c.req.raw.clone().arrayBuffer() : undefined;
  let streamType;
  if (rawBody) {
    try { const b = JSON.parse(new TextDecoder().decode(rawBody)); streamType = b?.stream === true ? "stream" : "nonstream"; } catch (e) {}
  }
  const result = await tryForward(c.env, path, c.req.method, baseHeaders, rawBody, rid, streamType, c.req.raw.signal);
  if (result.error) {
    return c.json({ error: { message: result.error.message, type: "upstream_error", param: null, code: "upstream_error" } }, result.error.status);
  }
  const { response: upstream } = result;
  const resHeaders = cleanResponseHeaders(upstream.headers);
  resHeaders.set("X-Request-Id", rid);
  const ct = upstream.headers.get("Content-Type") || "";
  if (ct.includes("text/event-stream")) {
    let sseBody = createIdleTimeoutStream(upstream.body, STREAM_IDLE_TIMEOUT_MS);
    const filters = await loadFilters(c.env);
    if (filters.length > 0) sseBody = sseBody.pipeThrough(createFilterTransform(filters));
    resHeaders.set("Cache-Control", "no-cache");
    resHeaders.set("X-Accel-Buffering", "no");
    return new Response(sseBody, { status: upstream.status, headers: resHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

async function authMiddleware(c, next) {
  if (c.req.method === "OPTIONS") return next();
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({
      error: { message: "Missing API key. Provide via Authorization: Bearer <key>", type: "auth_error", param: null, code: "invalid_api_key" },
    }, 401);
  }
  const key = auth.slice(7).trim();
  const validToken = await resolveClientToken(c.env);
  if (!validToken || key !== validToken) {
    return c.json({
      error: { message: "Invalid API key", type: "auth_error", param: null, code: "invalid_api_key" },
    }, 401);
  }
  await next();
}

function registerGateway(app) {
  for (const p of API_PREFIXES) {
    app.use(p + "/*", authMiddleware);
    app.post(p + "/chat/completions", handleChatCompletions);
    app.post(p + "/completions", handleChatCompletions);
    app.get(p + "/models", handleModels);
    app.all(p + "/*", handleGenericProxy);
  }
}


const setupRateLimit = new Map();

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
    if (ch.stream_type && !STREAM_TYPES.includes(ch.stream_type))
      errors.push(`[${i}] Invalid stream_type "${ch.stream_type}", must be one of: ${STREAM_TYPES.join(", ")}`);
    if (ch.channel_type && !CHANNEL_TYPES.includes(ch.channel_type))
      errors.push(`[${i}] Invalid channel_type "${ch.channel_type}", must be one of: ${CHANNEL_TYPES.join(", ")}`);
    if (ch.headers !== undefined) {
      if (!Array.isArray(ch.headers)) errors.push(`[${i}] headers must be an array`);
      else {
        for (let j = 0; j < ch.headers.length; j++) {
          const h = ch.headers[j];
          if (!h || typeof h !== "object" || !h.key || typeof h.key !== "string" || h.key.trim().length === 0)
            errors.push(`[${i}] headers[${j}]: key is required`);
          else if (/[^a-zA-Z0-9\-\_]/.test(h.key.trim()))
            errors.push(`[${i}] headers[${j}]: invalid key "${h.key}"`);
        }
      }
    }
  }
  return errors;
}

function createDashboardApi() {
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
    // fast path: session token (無 PBKDF2)
    maybePruneSessions();
    pruneSessionD1(c.env);
    if (await isValidSession(c.env, inputToken)) return await next();
    // slow path: legacy token (密碼), 驗證後回寫 session token
    if (await verifyPassword(inputToken, storedHash)) {
      const sessionToken = await generateSessionToken(c.env);
      c.header("X-Session-Token", sessionToken);
      return await next();
    }
    return c.json({ error: "Unauthorized" }, 401);
  });

  api.get("/init", async (c) => {
    const [ch, fl] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    const channels = (ch.results || []).map(ch => {
      let headers = ch.headers || [];
      if (typeof headers === "string") try { headers = JSON.parse(headers); } catch (e) { headers = []; }
      let provider_options = ch.provider_options || null;
      if (typeof provider_options === "string") try { provider_options = JSON.parse(provider_options); } catch (e) { provider_options = null; }
      return { ...ch, api_key: maskApiKey(ch.api_key || ''), headers, provider_options };
    });
    return c.json({ channels, filters: fl.results || [], config: { token: cf?.client_token || "" } });
  });

  api.post("/batch-channels", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body)) return c.json({ ok: false, error: "Expected array" }, 400);
    const errs = validateChannelData(body);
    if (errs.length > 0) return c.json({ ok: false, error: "Validation failed", details: errs }, 400);
    // D1 batch transactions have a 100-statement limit (D1_BATCH_LIMIT = 99).
    // DELETE occupies 1 slot, so we can atomically save at most D1_BATCH_LIMIT-1 channels.
    // Beyond that, sequential batches risk interleaving with concurrent requests.
    const maxChannels = D1_BATCH_LIMIT - 1;
    if (body.length > maxChannels) {
      return c.json({ ok: false, error: `Too many channels (${body.length}), max ${maxChannels}. Save in smaller batches.` }, 400);
    }
    const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
    const allKeys = {};
    for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
    const isMasked = (key) => typeof key === "string" && key.includes("***");
    const cols = "id, name, base_url, api_key, model, weight, is_enabled, stream_type, channel_type, headers, provider, provider_options, max_tokens, fallback_model, health_check_enabled, health_check_interval, health_check_timeout, cache_enabled, cache_ttl, rate_limit_algorithm, rate_limit_capacity, rate_limit_rate, rpm_limit, rpd_limit, consecutive_errors, last_error_msg, last_error_at, support_stream, support_image_gen, support_audio_tts, support_audio_stt, support_image_edit, support_embeddings, absolute_url, response_time, support_tools";
    const ph = cols.split(",").map(() => "?").join(",");
    const batch = [c.env.DB.prepare("DELETE FROM channels")];
    for (const ch of body) {
      const apiKey = (!ch.api_key || isMasked(ch.api_key)) ? (allKeys[ch.id] || "") : ch.api_key;
      batch.push(
        c.env.DB.prepare(`INSERT INTO channels (${cols}) VALUES (${ph})`).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey, ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0,
          ch.stream_type || "both", ch.channel_type || "chat", JSON.stringify(ch.headers || []),
          ch.provider || "", (ch.provider_options && typeof ch.provider_options === "object" ? JSON.stringify(ch.provider_options) : (typeof ch.provider_options === "string" ? ch.provider_options : "[]")), ch.max_tokens || 0, ch.fallback_model || "",
          ch.health_check_enabled ? 1 : 0, ch.health_check_interval || 300, ch.health_check_timeout || 5,
          ch.cache_enabled ? 1 : 0, ch.cache_ttl || 3600,
          ch.rate_limit_algorithm || "rpm", ch.rate_limit_capacity || 0, ch.rate_limit_rate || 0,
          ch.rpm_limit || 0, ch.rpd_limit || 0,
          ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
          ch.support_stream != null ? (ch.support_stream ? 1 : 0) : 1,
          ch.support_image_gen != null ? (ch.support_image_gen ? 1 : 0) : 0,
          ch.support_audio_tts != null ? (ch.support_audio_tts ? 1 : 0) : 0,
          ch.support_audio_stt != null ? (ch.support_audio_stt ? 1 : 0) : 0,
          ch.support_image_edit != null ? (ch.support_image_edit ? 1 : 0) : 0,
          ch.support_embeddings != null ? (ch.support_embeddings ? 1 : 0) : 0,
          ch.absolute_url ? 1 : 0, ch.response_time || 0, ch.support_tools != null ? (ch.support_tools ? 1 : 0) : 1
        )
      );
    }
    for (let i = 0; i < batch.length; i += D1_BATCH_LIMIT) {
      const chunk = batch.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length > 0) await retry(() => c.env.DB.batch(chunk));
    }
    clearGatewayCache();

    return c.json({ ok: true });
  });

  api.post("/filters", async (c) => {
    const filters = await c.req.json();
    const stmts = [
      c.env.DB.prepare("DELETE FROM filters"),
      ...filters.map((f) =>
        c.env.DB.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(f.text, f.mode !== undefined ? f.mode : 1, f.is_enabled ? 1 : 0)
      ),
    ];
    for (let i = 0; i < stmts.length; i += D1_BATCH_LIMIT) {
      const chunk = stmts.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length > 0) await retry(() => c.env.DB.batch(chunk));
    }
    clearGatewayCache();

    return c.json({ ok: true });
  });

  api.post("/config", async (c) => {
    const b = await c.req.json();
    const ex = await c.env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    const existingToken = ex?.client_token || "";
    try {
      const token = b.token || existingToken || getDefaults().token;
      if (ex) await c.env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(token).run();
      else await c.env.DB.prepare("INSERT INTO config (id, client_token, admin_password) VALUES (1, ?, '')").bind(token).run();
    } catch (e) { return c.json({ error: e.message }, 500); }
    clearGatewayCache();

    return c.json({ ok: true });
  });

  api.post("/verify-token", async (c) => {
    const { token } = await c.req.json();
    if (!token) return c.json({ valid: false }, 400);
    // fast path: session token
    if (await isValidSession(c.env, token)) return c.json({ valid: true });
    // slow path: 相容舊版 password token → 升級為 session token
    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ valid: false }, 403);
    if (await verifyPassword(token, storedHash)) {
      return c.json({ valid: true, sessionToken: await generateSessionToken(c.env) });
    }
    return c.json({ valid: false });
  });

  api.post("/admin-pass", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const rl = checkSetupRateLimit(ip);
    if (rl.blocked) return c.json({ error: "嘗試過多，請 10 分鐘後再试" }, 429);
    const { pass } = await c.req.json();
    if (!pass || pass.length < 6 || pass.length > 20) return c.json({ error: "密碼需 6-20 個字元" }, 400);
    const hashedPass = await hashPassword(pass);
    const ex = await c.env.DB.prepare("SELECT id FROM config WHERE id=1").first();
    if (ex) await c.env.DB.prepare("UPDATE config SET admin_password=? WHERE id=1").bind(hashedPass).run();
    else await c.env.DB.prepare("INSERT INTO config (id, client_token, admin_password) VALUES (1, ?, ?)").bind(generateToken(), hashedPass).run();
    clearGatewayCache();

    return c.json({ ok: true });
  });

  api.post("/channels/:id/test", async (c) => {
    const chId = parseInt(c.req.param("id"), 10);
    const reqBody = await c.req.json().catch(() => ({}));
    const fromBody = !!reqBody.base_url;
    let ch;
    if (fromBody) { ch = { id: chId, ...reqBody }; }
    else { const rows = (await c.env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(chId).all()).results || []; ch = rows[0]; }
    if (!ch) return c.json({ ok: false, error: "Channel not found", diagnosis: "渠道不存在" }, 404);
    const baseUrl = ch.base_url || "";
    const testUrl = baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const start = Date.now();
    try {
      const res = await fetch(testUrl, {
        method: "POST",
        headers: { Authorization: "Bearer " + (ch.api_key || ""), "Content-Type": "application/json" },
        body: JSON.stringify({ model: ch.model || "test", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      const ms = Date.now() - start;
      const ok = res.status === 200 || res.status === 400;
      return c.json({ ok, status: res.status, ms, diagnosis: ok ? "連線正常" : `HTTP ${res.status}` });
    } catch (e) {
      const ms = Date.now() - start;
      return c.json({ ok: false, status: 0, ms, diagnosis: "連線失敗: " + (e.message?.slice(0, 60) || "unknown") });
    }
  });

  api.post("/reset", async (c) => {
    const freshToken = generateToken();
    await retry(() => c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(freshToken),
    ]));
    clearGatewayCache();

    return c.json({ ok: true, new_token: freshToken });
  });

  api.get("/auth-status", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
      return c.json({ needsSetup: !cf?.admin_password });
    } catch (e) { return c.json({ needsSetup: true }); }
  });

  return api;
}

const loginState = new Map();
let lastCleanupTs = 0;

function pruneLoginState() {
  const now = Date.now();
  for (const [ip, state] of loginState) {
    if (state.banUntil > 0 && now >= state.banUntil) loginState.delete(ip);
  }
  if (loginState.size > 1000) {
    const entries = [...loginState.entries()].sort((a, b) => a[1].count - b[1].count);
    for (let i = 500; i < entries.length; i++) loginState.delete(entries[i][0]);
  }
}

function createDashboardApp() {
  const app = new Hono();
  app.route("/api", createDashboardApi());
  app.get("/", (c) => c.html(portalHtml));

  app.post("/login", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    if (Date.now() - lastCleanupTs > 300_000) { lastCleanupTs = Date.now(); if (loginState.size > 1000) pruneLoginState(); }
    const state = loginState.get(ip) || { count: 0, banUntil: 0 };
    if (Date.now() < state.banUntil) return c.json({ error: "嘗試過多，請 15 分鐘後再试" }, 429);
    const { password } = await c.req.json();
    if (!password) return c.json({ error: "密碼 required" }, 400);
    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ error: "尚未設定密碼" }, 403);
    if (await verifyPassword(password, storedHash)) {
      loginState.delete(ip);
      return c.json({ ok: true, sessionToken: await generateSessionToken(c.env) });
    }
    const newCount = state.count + 1;
    if (newCount >= LOGIN_MAX_FAILURES) {
      loginState.set(ip, { count: 0, banUntil: Date.now() + LOGIN_BAN_MS });
      return c.json({ error: "IP 已被封鎖 15 分鐘" }, 429);
    }
    loginState.set(ip, { count: newCount, banUntil: 0 });
    return c.json({ error: "密碼錯誤" }, 401);
  });

  return app;
}

async function initConfig(env) {
  setPepper(env.PASSWORD_PEPPER || "");
  try { await ensureSchema(env); } catch (e) { console.error("[schema]", e.message); }
  try {
    const cf = await env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    if (cf && !cf.client_token) {
      const token = generateToken();
      await env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(token).run();
    }
  } catch (e) { console.error("[init] config error:", e.message); }
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
      try { await initConfig(c.env); inited = true; } catch (e) { console.error("[init]", e.message); }
      initLock = null;
    })();
    await initLock;
  }
  await next();
});

registerGateway(app);
app.route("/admin", createDashboardApp());
app.get("/", (c) => c.redirect("/admin"));

app.notFound((c) => c.json({
  error: { message: "Route not found: " + c.req.method + " " + c.req.path, type: "invalid_request_error", param: null, code: "not_found" },
}, 404));

app.onError((err, c) => {
  console.error("[error]", err.message);
  return c.json({ error: { message: "The server had an error processing your request", type: "server_error", param: null, code: "api_error" } }, 500);
});

export { pruneLoginState };

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
