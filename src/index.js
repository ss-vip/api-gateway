import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import portalHtml from "./dashboard.html";

const UPSTREAM_TIMEOUT_MS = 120_000;    // chat 請求總 timeout
const LONG_TIMEOUT_MS = 600_000;        // 非 chat（文生圖等）總 timeout, 配合 relay 即回 meta 架構
const CHANNEL_COOLDOWN_MS = UPSTREAM_TIMEOUT_MS;
const STREAM_IDLE_TIMEOUT_MS = 180_000;
const TOKEN_TTL = 60_000;
const FILTER_TTL = 180_000;
const SESSION_TTL = 604800000; // 7 天
const SESSION_PRUNE_INTERVAL = 50;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const adminSessions = new Map();
let sessionPruneCounter = 0;

// 自動學習：渠道實際能承載的 context 上限（從 runtime 錯誤回饋）
const contextOverflowAt = new Map();
function isContextLengthError(text) {
  return /context_length|context length|maximum.*(?:context|tokens)|exceeds.*limit|too many tokens|token limit|tokens per minute|tpm.*limit|rate_limit_exceeded/i.test(text);
}
function learnContextLimit(channelId, tokens) {
  const prev = contextOverflowAt.get(channelId);
  contextOverflowAt.set(channelId, prev !== undefined ? Math.min(prev, tokens) : tokens);
}
function successContextObserved(channelId, tokens) {
  const overflow = contextOverflowAt.get(channelId);
  if (overflow !== undefined && tokens >= overflow - 500) {
    contextOverflowAt.delete(channelId);
  }
}

// 自動學習：渠道實際上無法支援 tools / vision（從上游回空內容推斷）
const channelNoTools = new Set();
const channelNoVision = new Set();
function learnChannelNoTools(channelId, env) {
  channelNoTools.add(channelId);
  env?.DB?.prepare("UPDATE channels SET support_tools=0 WHERE id=?").bind(channelId).run().catch(() => {});
}
function learnChannelNoVision(channelId, env) {
  channelNoVision.add(channelId);
  env?.DB?.prepare("UPDATE channels SET support_vision=0 WHERE id=?").bind(channelId).run().catch(() => {});
}

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
const D1_BATCH_LIMIT = 100;
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
  support_vision INTEGER NOT NULL DEFAULT 0,
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
  rate_limit_key TEXT NOT NULL DEFAULT '',
  relay_url TEXT NOT NULL DEFAULT '',
  max_context_length INTEGER NOT NULL DEFAULT 0
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
  admin_password  TEXT    NOT NULL DEFAULT '',
  relay_url       TEXT    NOT NULL DEFAULT ''
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
  if (parseInt(schemaVer, 10) < 3) {
    const migrations = [];
    if (parseInt(schemaVer, 10) < 2) {
      migrations.push(
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
        "ALTER TABLE channels ADD COLUMN rate_limit_key TEXT NOT NULL DEFAULT ''"
      );
    }
    migrations.push("ALTER TABLE channels ADD COLUMN support_vision INTEGER NOT NULL DEFAULT 0");
    for (const sql of migrations) {
      try { await env.DB.prepare(sql).run(); } catch (e) { /* 欄位已存在則略過 */ }
    }
  }
  if (parseInt(schemaVer, 10) < 5) {
    // support_vision 已在 v3 中追加，此處僅追加 relay_url
    try { await env.DB.prepare("ALTER TABLE channels ADD COLUMN relay_url TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* 欄位已存在則略過 */ }
  }
  if (parseInt(schemaVer, 10) < 6) {
    try { await env.DB.prepare("ALTER TABLE channels ADD COLUMN max_context_length INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { /* 欄位已存在則略過 */ }
  }
  if (parseInt(schemaVer, 10) < 7) {
    try { await env.DB.prepare("ALTER TABLE config ADD COLUMN relay_url TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* 欄位已存在則略過 */ }
  }
  if (parseInt(schemaVer, 10) < 8) {
    try { await env.DB.prepare("ALTER TABLE config ADD COLUMN relay_token TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* 欄位已存在則略過 */ }
  }
  // migration 完成後寫入 DB flag，下次冷啟動直接跳過
  await env.DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_ver', '8')").run();
  schemaReady = true;
}

class RollingFilter {
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
const typeChannelCache = new Map(); // "type" => { data, ts }
const TYPE_CACHE_TTL = 30000;
const degradedUntil = new Map();

async function loadChannels(env, channelType) {
    const now = Date.now();
  if (channelType) {
    const cached = typeChannelCache.get(channelType);
    if (cached && now - cached.ts < TYPE_CACHE_TTL) return cached.data;
    return dbLoadChannels(env, channelType);
  }
  if (cachedChannels && now - lastLoad < REFRESH_MS) return cachedChannels;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const rows = await dbLoadChannels(env, null);
      cachedChannels = rows; lastLoad = Date.now();
      return rows;
    } catch (e) {
      console.error("[channel] load error:", e.message);
      cachedChannels = cachedChannels || [];
      return cachedChannels;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

async function dbLoadChannels(env, channelType) {
  try {
    let sql = `SELECT id, name, base_url, api_key, weight, stream_type, channel_type, headers,
      cooldown_until, rpm_limit, rpd_limit, rpm_count, rpm_reset_at, rpd_count, rpd_reset_at,
      consecutive_errors, consecutive_successes, health_check_enabled, health_check_interval, health_check_timeout,
      cache_enabled, cache_ttl,
      rate_limit_algorithm, rate_limit_capacity, rate_limit_rate,
      fallback_model, model, max_tokens, is_enabled, provider_options,
      support_tools, support_vision, max_context_length
      FROM channels WHERE is_enabled = 1`;
    const params = [];
    if (channelType) { sql += " AND channel_type = ?"; params.push(channelType); }
    sql += " ORDER BY weight DESC";
    const { results } = await env.DB.prepare(sql).bind(...params).all();
    const rows = (results || []).map(ch => {
      if (typeof ch.provider_options === "string") try { ch.provider_options = JSON.parse(ch.provider_options); } catch (e) { ch.provider_options = null; }
      if (ch.provider_options && Array.isArray(ch.provider_options) && ch.provider_options.length === 0) ch.provider_options = null;
      return ch;
    });
    const nowMs = Date.now();
    const active = rows.filter(ch => !ch.cooldown_until || ch.cooldown_until <= nowMs);
    for (const ch of rows) {
      if (ch.cooldown_until > 0 && ch.cooldown_until <= nowMs) {
        env.DB.prepare("UPDATE channels SET cooldown_until=0 WHERE id=?").bind(ch.id).run().catch(() => {});
      }
      if (ch.cooldown_until > nowMs) { degradedUntil.set(ch.id, ch.cooldown_until); }
    }
    if (channelType) { typeChannelCache.set(channelType, { data: active, ts: Date.now() }); }
    return active;
  } catch (e) {
    console.error("[channel] load error:", e.message);
    const fallback = channelType ? (typeChannelCache.get(channelType)?.data || []) : (cachedChannels || []);
    return fallback;
  }
}

function clearChannelCache() {
  cachedChannels = null;
  lastLoad = 0;
  loadPromise = null;
  typeChannelCache.clear();
  // 清除自動學習標記，讓下次請求重新評估
  channelNoTools.clear();
  channelNoVision.clear();
}

function selectChannel(channels, exclude = new Set(), estimatedContextTokens = 0) {
  const healthy = channels.filter(c => !exclude.has(c.id) && !isDegraded(c.id));
  if (healthy.length === 0) return null;
  const pool = healthy;
  // 動態權重：接近 limit 的渠道降權、小請求優先選有限 context 渠道（保留無限渠道給大請求）
  const weights = pool.map(c => {
    let weight = Math.max(c.weight, 1);
    if (c.max_context_length > 0 && estimatedContextTokens > 0) {
      const ratio = estimatedContextTokens / c.max_context_length;
      if (ratio >= 0.9) {
        weight *= 0.7;
      } else if (ratio >= 0.7) {
        weight *= 0.85;
      } else if (ratio < 0.5) {
        // 請求遠小於限制 → 加成，保留無限渠道給真正需要的大請求
        const boost = 1 + (1 - ratio * 2) * 0.5; // ratio 0 → *1.5, ratio 0.25 → *1.25, ratio 0.5 → 無加成
        weight *= boost;
      }
    }
    return weight;
  });
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
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
    env.DB.prepare(`UPDATE channels SET cooldown_until=0, consecutive_successes=consecutive_successes+1, consecutive_errors=0 WHERE id=?`).bind(channelId).run().catch(() => {});
  }
}

function isDegraded(channelId) {
  const until = degradedUntil.get(channelId);
  if (!until) return false;
  if (Date.now() < until) return true;
  degradedUntil.delete(channelId);
  return false;
}

const tokenBuckets = new Map();

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
  if (bucket.rpm > 0) {
    if (now - bucket.rpmTs > 60000) { bucket.rpmCount = 0; bucket.rpmTs = now; }
    if (bucket.rpmCount >= bucket.rpm) return { ok: false, reason: "rpm_limit" };
  }
  if (bucket.rpd > 0) {
    if (now - bucket.rpdTs > 86400000) { bucket.rpdCount = 0; bucket.rpdTs = now; }
    if (bucket.rpdCount >= bucket.rpd) return { ok: false, reason: "rpd_limit" };
  }
  if (bucket.capacity > 0 && bucket.rate > 0) {
    const elapsed = (now - bucket.tokenTs) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.rate);
    bucket.tokenTs = now;
    if (bucket.tokens < 1) return { ok: false, reason: "rate_limit" };
  }
  return { ok: true };
}

// 通過檢查後、實際發送請求前消耗配額
function consumeRateLimit(channel) {
  const cid = channel.id || 0;
  const bucket = tokenBuckets.get(cid);
  if (!bucket) return;
  if (bucket.rpm > 0) bucket.rpmCount++;
  if (bucket.rpd > 0) bucket.rpdCount++;
  if (bucket.capacity > 0 && bucket.rate > 0) bucket.tokens -= 1;
}

// 請求未到達上游時退還配額（連線失敗等）
function refundRateLimit(channel) {
  const cid = channel.id || 0;
  const bucket = tokenBuckets.get(cid);
  if (!bucket) return;
  if (bucket.rpm > 0 && bucket.rpmCount > 0) bucket.rpmCount--;
  if (bucket.rpd > 0 && bucket.rpdCount > 0) bucket.rpdCount--;
  if (bucket.capacity > 0 && bucket.rate > 0) bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
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

let globalConfigCache = { token: null, relay_url: null, relay_token: null, ts: 0 };

async function resolveGlobalConfig(env) {
  if (globalConfigCache.ts > 0 && Date.now() - globalConfigCache.ts < TOKEN_TTL) return globalConfigCache;
  try {
    const cf = await env.DB.prepare("SELECT client_token, relay_url, relay_token FROM config WHERE id=1").first();
    globalConfigCache = { token: cf?.client_token || null, relay_url: cf?.relay_url || null, relay_token: cf?.relay_token || null, ts: Date.now() };
  } catch {
    globalConfigCache = { token: null, relay_url: null, relay_token: null, ts: Date.now() };
  }
  return globalConfigCache;
}

async function resolveClientToken(env) {
  const cfg = await resolveGlobalConfig(env);
  return cfg.token;
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
  globalConfigCache = { token: null, relay_url: null, relay_token: null, ts: 0 };
  filterCache = { data: null, ts: 0 };
  tokenBuckets.clear();
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

// ---- Model 名稱回射工具 ----
// 將 SSE 串流中每個 data chunk 的 model 欄位覆寫為客戶端原始請求的 model 名稱
function createModelRewriteTransform(clientModel) {
  if (!clientModel) return new TransformStream(); // no-op
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const obj = JSON.parse(line.slice(6));
            if (obj.model !== undefined) obj.model = clientModel;
            controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));
            continue;
          } catch {}
        }
        if (line) controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      if (buf) controller.enqueue(encoder.encode(buf));
    }
  });
}

// 將 JSON 字串中的 model 欄位覆寫為客戶端原始請求的 model 名稱（非串流用）
function rewriteModelInJson(text, clientModel) {
  if (!clientModel || !text) return text;
  try {
    const obj = JSON.parse(text);
    if (obj.model !== undefined) {
      obj.model = clientModel;
      return JSON.stringify(obj);
    }
  } catch {}
  return text;
}

function createFilterTransform(filters) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  // Smart Split 狀態機：偵測上游把思考塞進 content 時，搬移到 reasoning_content
  let ssMode = "normal";     // normal | detecting | thinking | answering
  let ssDetectBuf = "";      // 累積開頭字元來偵測 Thought: 前綴
  let ssHeld = [];
  let ssHeldParsed = [];

  function ssFlushAsThinking(controller) {
    let splitIdx = -1;
    for (let i = 0; i < ssHeldParsed.length; i++) {
      const c = ssHeldParsed[i].choices?.[0]?.delta?.content || "";
      if (c.indexOf("\n\n") >= 0) { splitIdx = i; break; }
    }
    if (splitIdx >= 0) {
      // 分界點之前的行：全部當作 reasoning_content
      for (let i = 0; i < splitIdx; i++) {
        const p = JSON.parse(JSON.stringify(ssHeldParsed[i]));
        const raw = p.choices[0].delta.content;
        p.choices[0].delta.reasoning_content = i === 0 ? raw.replace(/^[Tt]hought[:：]\s*/, '') : raw;
        delete p.choices[0].delta.content;
        controller.enqueue(encoder.encode("data: " + JSON.stringify(p) + "\n\n"));
      }
      // 分界行：拆分 \n\n 前後
      const p = JSON.parse(JSON.stringify(ssHeldParsed[splitIdx]));
      const raw = p.choices[0].delta.content;
      const ci = raw.indexOf("\n\n");
      const thought = (splitIdx === 0 ? raw.slice(0, ci).replace(/^[Tt]hought[:：]\s*/, '') : raw.slice(0, ci));
      const answer = raw.slice(ci + 2);
      p.choices[0].delta.reasoning_content = thought;
      p.choices[0].delta.content = answer || undefined;
      if (!p.choices[0].delta.content) delete p.choices[0].delta.content;
      controller.enqueue(encoder.encode("data: " + JSON.stringify(p) + "\n\n"));
      // 分界點之後的行：當作一般 content 放出
      for (let i = splitIdx + 1; i < ssHeld.length; i++) {
        controller.enqueue(encoder.encode(ssHeld[i] + "\n\n"));
      }
    } else {
      // 完全沒有 \n\n：全部都是思考內容
      for (let i = 0; i < ssHeldParsed.length; i++) {
        const p = JSON.parse(JSON.stringify(ssHeldParsed[i]));
        const raw = p.choices[0].delta.content;
        p.choices[0].delta.reasoning_content = i === 0 ? raw.replace(/^[Tt]hought[:：]\s*/, '') : raw;
        delete p.choices[0].delta.content;
        controller.enqueue(encoder.encode("data: " + JSON.stringify(p) + "\n\n"));
      }
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const line of parts) {
        if (!line.trim()) continue;
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            // 在 [DONE] 前 flush Smart Split 緩衝內容，避免內容遺失
            if (ssHeld.length > 0 && ssMode !== "normal") {
              for (const hl of ssHeld) controller.enqueue(encoder.encode(hl + "\n\n"));
              ssHeld = []; ssHeldParsed = []; ssDetectBuf = ""; ssMode = "normal";
            }
            controller.enqueue(encoder.encode(line + "\n\n"));
            continue;
          }
          try {
            const parsed = JSON.parse(payload);
            let ssSkipped = false; // Smart Split 暫緩主 emit 的旗標
            if (parsed.choices) {
              // 非串流格式（message）自動轉為串流（delta）
              const isNonStreaming = parsed.choices.some(ch => ch.message && !ch.delta);
              if (isNonStreaming) {
                // 若 Smart Split 正在偵測中，先 flush 緩衝內容避免遺失
                if (ssHeld.length > 0) {
                  for (const hl of ssHeld) controller.enqueue(encoder.encode(hl + "\n\n"));
                  ssHeld = []; ssHeldParsed = []; ssDetectBuf = ""; ssMode = "normal";
                }
                for (const ch of parsed.choices) {
                  const msg = ch.message || {};
                  const idx = ch.index || 0;
                  const baseEvent = { id: parsed.id, object: "chat.completion.chunk", created: parsed.created || Math.floor(Date.now() / 1000), model: parsed.model || "unknown" };
                  const emit = (data) => controller.enqueue(encoder.encode("data: " + JSON.stringify({ ...baseEvent, choices: [data] }) + "\n\n"));
                  // role chunk
                  if (msg.role) emit({ index: idx, delta: { role: msg.role }, finish_reason: null });
                  // content chunk
                  if (msg.content) {
                    const content = filters?.length > 0 ? RollingFilter.applyStatic(msg.content, filters) : msg.content;
                    emit({ index: idx, delta: { content }, finish_reason: null });
                  }
                  // tool_calls
                  if (msg.tool_calls) {
                    for (const tc of msg.tool_calls) {
                      emit({ index: idx, delta: { tool_calls: [{ index: tc.index || 0, id: tc.id, type: tc.type || "function", function: { name: tc.function?.name || "", arguments: "" } }] }, finish_reason: null });
                      if (tc.function?.arguments) {
                        const filteredArgs = filters?.length > 0 ? RollingFilter.applyStatic(tc.function.arguments, filters) : tc.function.arguments;
                        emit({ index: idx, delta: { tool_calls: [{ index: tc.index || 0, function: { arguments: filteredArgs } }] }, finish_reason: null });
                      }
                    }
                  }
                  // finish chunk
                  emit({ index: idx, delta: {}, finish_reason: ch.finish_reason || "stop" });
                }
                // usage
                if (parsed.usage) {
                  const baseEvent = { id: parsed.id, object: "chat.completion.chunk", created: parsed.created || Math.floor(Date.now() / 1000), model: parsed.model || "unknown" };
                  controller.enqueue(encoder.encode("data: " + JSON.stringify({ ...baseEvent, choices: [], usage: parsed.usage }) + "\n\n"));
                }
                ssSkipped = true;
              } else {
              for (const choice of parsed.choices) {
                const delta = choice?.delta || {};
                // 套用 filter（空陣列時無作用）
                if (delta.content) delta.content = RollingFilter.applyStatic(delta.content, filters);
                if (delta.refusal) delta.refusal = RollingFilter.applyStatic(delta.refusal, filters);
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.arguments) tc.function.arguments = RollingFilter.applyStatic(tc.function.arguments, filters);
                  }
                }
                // Smart Split：僅在 upstream 未給 reasoning_content 時啟用
                if (delta.content && !delta.reasoning_content) {
                  if (ssMode === "normal") {
                    ssMode = "detecting";
                    ssDetectBuf = delta.content;
                    ssHeld = [line];
                    ssHeldParsed = [JSON.parse(JSON.stringify(parsed))];
                    ssSkipped = true;
                    continue;
                  }
                  if (ssMode === "detecting") {
                    ssDetectBuf += delta.content;
                    ssHeld.push(line);
                    ssHeldParsed.push(JSON.parse(JSON.stringify(parsed)));
                    if (/^[Tt]hought[:：]/.test(ssDetectBuf)) {
                      ssMode = "thinking";
                      ssFlushAsThinking(controller);
                      ssHeld = []; ssHeldParsed = []; ssDetectBuf = "";
                      ssSkipped = true;
                      continue;
                    }
                    if (ssDetectBuf.length >= 25) {
                      ssMode = "answering";
                      for (const hl of ssHeld) controller.enqueue(encoder.encode(hl + "\n\n"));
                      ssHeld = []; ssHeldParsed = []; ssDetectBuf = "";
                      ssSkipped = true; // held 已 flush，不重複 emit
                      continue;
                    }
                    ssSkipped = true;
                    continue; // 繼續偵測
                  }
                  if (ssMode === "thinking") {
                    const idx = delta.content.indexOf("\n\n");
                    if (idx >= 0) {
                      if (idx > 0) delta.reasoning_content = delta.content.slice(0, idx);
                      delta.content = delta.content.slice(idx + 2) || undefined;
                      if (!delta.content) delete delta.content;
                      ssMode = "answering";
                    } else {
                      delta.reasoning_content = delta.content;
                      delete delta.content;
                    }
                  }
                }
              }
              }
            }
            if (!ssSkipped) controller.enqueue(encoder.encode("data: " + JSON.stringify(parsed) + "\n\n"));
          } catch { controller.enqueue(encoder.encode(line + "\n\n")); }
        } else if (/^\{/.test(line)) {
          // 裸 JSON（無 data: 前綴）→ 補上 data: 前綴
          controller.enqueue(encoder.encode("data: " + line + "\n\n"));
        } else if (/^\[DONE\]/.test(line) || /^\[ERROR\]/.test(line)) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } else {
          controller.enqueue(encoder.encode(line + "\n"));
        }
      }
    },
    flush(controller) {
      // 若串流結束時仍在偵測 mode，放出緩衝內容
      if (ssHeld.length > 0) {
        for (const hl of ssHeld) controller.enqueue(encoder.encode(hl + "\n\n"));
      }
      if (buf) controller.enqueue(encoder.encode(buf + "\n\n"));
    },
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
    } catch (e) { /* idle timeout or client disconnect — safe to close */ try { await writer.close(); } catch (_) {} }
    finally { clearTimeout(idleTimer); reader.releaseLock(); }
  })().catch(e => logStructured("error", "idle-timeout-stream internal error", { error: e.message }));
  return out;
}

// ---- Relay Plugin（HTTP 轉發代理）----

// 解析 relay 回應格式：第一行為 {"_relay":{"status":200,"headers":{...}}} metadata
// 其餘為實際 upstream body（以 ReadableStream 回傳）
async function parseRelayResponse(relayRes) {
  if (!relayRes.ok || !relayRes.body) {
    const text = await relayRes.text().catch(() => "relay unavailable");
    const fake = new Response(text, { status: relayRes.status || 502, headers: relayRes.headers });
    fake.headers.set("X-Relay-Error", "1");
    return { relayError: true, response: fake };
  }
  const reader = relayRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const MAX_META = 65536;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      reader.cancel().catch(() => {});
      const fake = new Response(JSON.stringify({ error: "relay response truncated" }), { status: 502, headers: { "content-type": "application/json" } });
      fake.headers.set("X-Relay-Error", "1");
      return { relayError: true, response: fake };
    }
    buf += decoder.decode(value, { stream: true });
    if (buf.length > MAX_META) {
      reader.cancel().catch(() => {});
      const fake = new Response(JSON.stringify({ error: "relay metadata too large" }), { status: 502, headers: { "content-type": "application/json" } });
      fake.headers.set("X-Relay-Error", "1");
      return { relayError: true, response: fake };
    }
    const nl = buf.indexOf("\n");
    if (nl === -1) continue;
    const metaLine = buf.slice(0, nl);
    const remainder = buf.slice(nl + 1);
    let meta;
    try { meta = JSON.parse(metaLine); } catch {
      reader.cancel().catch(() => {});
      const fake = new Response(JSON.stringify({ error: "invalid relay metadata" }), { status: 502, headers: { "content-type": "application/json" } });
      fake.headers.set("X-Relay-Error", "1");
      return { relayError: true, response: fake };
    }
    if (meta._relay?.error) {
      reader.cancel().catch(() => {});
      const fake = new Response(JSON.stringify({ error: meta._relay.error }), { status: 502, headers: { "content-type": "application/json" } });
      fake.headers.set("X-Relay-Error", "1");
      return { relayError: true, response: fake };
    }
    const upstreamStatus = meta._relay?.status || 502;
    const upstreamHeaders = new Headers(meta._relay?.headers || {});
    const bodyStream = new ReadableStream({
      start(controller) {
        if (remainder) controller.enqueue(new TextEncoder().encode(remainder));
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { controller.close(); return; }
              controller.enqueue(value);
            }
          } catch (e) { controller.error(e); }
        })();
      },
      cancel() { reader.cancel(); },
    });
    return { response: new Response(bodyStream, { status: upstreamStatus, headers: upstreamHeaders }) };
  }
}

// Global relay: 使用 env.RELAY_BASE_URL 全局設定（所有類型皆可使用）
async function upstreamFetch(url, opts, env, rid, noRelay) {
  if (noRelay || !env.RELAY_BASE_URL) {
    return fetch(url, opts);
  }
  const { relay_token: dbRelayToken } = await resolveGlobalConfig(env);
  const relayToken = dbRelayToken || env.RELAY_SECRET || "";
  const relayHeaders = new Headers(opts.headers);
  relayHeaders.set("x-target-url", url);
  if (relayToken) relayHeaders.set("x-relay-token", relayToken);
  const relayRes = await fetch(env.RELAY_BASE_URL, {
    method: opts.method, headers: relayHeaders, body: opts.body, signal: opts.signal,
  });
  const parsed = await parseRelayResponse(relayRes);
  if (parsed.relayError) {
    logStructured("warn", "relay error", { relay: env.RELAY_BASE_URL, status: parsed.response.status, rid });
    return parsed.response;
  }
  return parsed.response;
}

// Per-channel relay: 使用 channel.relay_url 逐一設定
async function fetchViaRelay(relayBase, targetUrl, method, baseHeaders, body, signal, relaySecret) {
  const h = new Headers(baseHeaders);
  h.set("x-target-url", targetUrl);
  if (relaySecret) h.set("x-relay-token", relaySecret);
  const relayRes = await fetch(relayBase, { method, headers: h, body, signal });
  if (relayRes.headers.get("x-relay") !== "1") return relayRes;
  const reader = relayRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const MAX_META = 65536;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.length > MAX_META) {
      reader.cancel();
      return new Response(JSON.stringify({ error: "relay metadata too large" }), { status: 502, headers: { "content-type": "application/json", "x-relay-error": "1" } });
    }
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      const metaLine = buf.slice(0, nl);
      const rest = buf.slice(nl + 1);
      try {
        const meta = JSON.parse(metaLine);
        if (meta._relay) {
          const upstreamStatus = meta._relay.status || relayRes.status;
          const upstreamHeaders = new Headers(meta._relay.headers || {});
          const fwd = createForwardStream(rest, reader);
          return new Response(fwd, { status: upstreamStatus, headers: upstreamHeaders });
        }
      } catch (e) { /* invalid metadata — passthrough */ }
      const fallback = createForwardStream(buf, reader);
      return new Response(fallback, { status: relayRes.status, headers: relayRes.headers });
    }
  }
  return new Response("", { status: relayRes.status, headers: relayRes.headers });
}

function createForwardStream(initial, reader) {
  return new ReadableStream({
    start(controller) {
      (async () => {
        try {
          if (initial) controller.enqueue(new TextEncoder().encode(initial));
          while (true) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); return; }
            controller.enqueue(value);
          }
        } catch (e) { controller.error(e); }
      })();
    },
    cancel() { reader.cancel(); },
  });
}

// ---- Function Calling Simulation ----
function injectToolDescriptions(messages, tools) {
  const msgs = Array.isArray(messages) ? [...messages] : [];
  let prompt = "You are a helpful assistant. You have access to the following tools:\n";
  for (const t of tools) {
    if (t.type === 'function' && t.function) {
      prompt += `- ${t.function.name}: ${t.function.description || ''}\n  Parameters: ${JSON.stringify(t.function.parameters || {})}\n`;
    }
  }
  prompt += "\nIf you decide to use a tool, you MUST respond ONLY with a JSON object matching this exact format:\n";
  prompt += `{"tool": "tool_name", "args": {"arg1": "value1"}}\n`;
  prompt += "Do not include any other text, markdown, or explanations before or after the JSON.\n";

  if (msgs.length > 0 && msgs[0].role === 'system') {
    msgs[0].content = prompt + "\n" + (msgs[0].content || "");
  } else {
    msgs.unshift({ role: 'system', content: prompt.trim() });
  }
  return msgs;
}

function processToolCallResponse(rawBody) {
  if (!rawBody) return { modifiedBody: null };
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return { modifiedBody: null }; }
  const choice = parsed?.choices?.[0];
  if (!choice) return { modifiedBody: null };
  if (choice.finish_reason !== 'stop') return { modifiedBody: null };

  const content = choice.message?.content || '';
  if (!content) return { modifiedBody: null };

  const re = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\})\s*\}/s;
  const m = content.match(re);
  if (!m) return { modifiedBody: null };

  const toolName = m[1];
  let toolArgs;
  try { toolArgs = JSON.parse(m[2]); } catch { return { modifiedBody: null }; }

  const toolCallId = 'call_' + Math.random().toString(36).slice(2, 12);
  const remainingContent = content.replace(re, '').trim();

  const modified = {
    ...parsed,
    choices: [{
      index: choice.index || 0,
      message: {
        role: 'assistant',
        content: remainingContent || null,
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(toolArgs) }
        }],
      },
      finish_reason: 'tool_calls',
    }],
  };
  return { modifiedBody: JSON.stringify(modified) };
}

function fakeSseStream(modifiedBodyStr) {
  const parsed = JSON.parse(modifiedBodyStr);
  const choice = parsed.choices[0];
  const tc = choice.message.tool_calls[0];
  
  const chunk1 = {
    id: parsed.id || 'chatcmpl-' + Date.now(),
    object: 'chat.completion.chunk',
    created: parsed.created || Math.floor(Date.now() / 1000),
    model: parsed.model || 'unknown',
    choices: [{ index: choice.index || 0, delta: { role: 'assistant' }, finish_reason: null }]
  };
  const chunk2 = {
    id: chunk1.id, object: 'chat.completion.chunk', created: chunk1.created, model: chunk1.model,
    choices: [{ index: choice.index || 0, delta: { tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }]
  };
  const chunk3 = {
    id: chunk1.id, object: 'chat.completion.chunk', created: chunk1.created, model: chunk1.model,
    choices: [{ index: choice.index || 0, delta: {}, finish_reason: 'tool_calls' }]
  };
  
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: ' + JSON.stringify(chunk1) + '\n\n'));
      controller.enqueue(enc.encode('data: ' + JSON.stringify(chunk2) + '\n\n'));
      controller.enqueue(enc.encode('data: ' + JSON.stringify(chunk3) + '\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

// ---- Reasoning → Content fallback ----
async function patchReasoningToContent(res) {
  try {
    const ct = (res.headers.get("Content-Type") || "").toLowerCase();
    if (!ct.includes("application/json")) return res;
    const cloned = res.clone();
    const text = await cloned.text();
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.choices)) {
      let changed = false;
      for (const ch of parsed.choices) {
        const msg = ch.message || ch.delta || {};
        if (!msg.content) {
          const fallback = msg.reasoning_content || msg.reasoning || "";
          if (fallback) { msg.content = fallback; changed = true; }
        }
      }
      if (changed) {
        logStructured("info", "patched reasoning→content fallback");
        return new Response(JSON.stringify(parsed), { status: res.status, statusText: res.statusText, headers: res.headers });
      }
    }
  } catch (e) { /* not JSON or no reasoning fields — pass through */ }
  return res;
}

async function tryForward(env, path, method, baseHeaders, body, rid, streamType, clientSignal) {
  const { relay_url: globalRelayUrl, relay_token: dbRelayToken } = await resolveGlobalConfig(env);
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
  let eligible = channels;
  if (streamType !== "stream" && body && (requiredType === "embed" || requiredType === "moderate")) {
    const ck = getCacheKey(requiredType, body);
    if (ck) {
      const cached = cacheGet(ck);
      if (cached) return { response: new Response(cached.body, { status: 200, headers: new Headers(cached.headers) }) };
    }
  }
  let bodyStr = null;
  let needsVision = false, needsTools = false;
  let estimatedContextTokens = 0;
  let clientRequestModel = "";
  if (body) {
    bodyStr = body instanceof ArrayBuffer ? new TextDecoder().decode(body) : (typeof body === "string" ? body : null);
  }
  // 提取客戶端原始請求的 model 名稱，用於後續回射
  if (bodyStr) {
    try { clientRequestModel = JSON.parse(bodyStr)?.model || ""; } catch {}
  }
  // 優先選用模型名稱符合的渠道，不符合則全部渠道也可被選用
  if (clientRequestModel && requiredType === "chat") {
    const matching = eligible.filter(c => c.model === clientRequestModel || c.fallback_model === clientRequestModel);
    if (matching.length > 0) {
      // 將相符渠道提至陣列前方，不匹配的提至後方
      const nonMatching = eligible.filter(c => c.model !== clientRequestModel && c.fallback_model !== clientRequestModel);
      eligible = [...matching, ...nonMatching];
    }
    // 否則保持全部渠道（不限制模型名稱）
  }
  let originalStreamType = streamType;
  let forceNonStream = false;
  if (bodyStr && requiredType === "chat") {
    try {
      const parsed = JSON.parse(bodyStr);
      let sanitized = false;
      const promptTokens = Math.ceil(bodyStr.length / 3);
      const maxTokens = parsed.max_tokens || parsed.max_completion_tokens || 0;
      estimatedContextTokens = promptTokens + maxTokens;

      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          // 清除非標準欄位避免上游報錯
          if (msg.reasoning_content !== undefined) { delete msg.reasoning_content; sanitized = true; }
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "image_url") needsVision = true;
            }
          } else if (typeof msg.content === "string") {
            if (/data:image\//.test(msg.content)) needsVision = true;
          }
          if (msg.tool_calls || msg.tool_call_id) needsTools = true;
        }
      }
      if (parsed.tools || parsed.tool_choice) needsTools = true;

      // Function Calling 模擬攔截
      if (parsed.tools && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        parsed.messages = injectToolDescriptions(parsed.messages, parsed.tools);
        delete parsed.tools;
        delete parsed.tool_choice;
        parsed.stream = false;
        forceNonStream = true;
        sanitized = true;
        logStructured("info", "tools injected, forcing non-stream", { rid });
      }

      if (sanitized) {
        bodyStr = JSON.stringify(parsed);
        estimatedContextTokens = Math.ceil(bodyStr.length / 3);
      }
    } catch (e) {}
  }
  
  if (estimatedContextTokens > 0) {
    eligible = eligible.filter(c => {
      const configured = c.max_context_length;
      const overflow = contextOverflowAt.get(c.id);
      const effectiveMax = configured > 0
        ? (overflow !== undefined ? Math.min(configured, overflow) : configured)
        : (overflow !== undefined ? overflow : Infinity);
      return estimatedContextTokens < effectiveMax;
    });
  }
  
  if (needsVision) eligible = eligible.filter(c => c.support_vision && !channelNoVision.has(c.id));
  // relay 全局模擬 function calling，不受自動學習標記影響
  if (needsTools && !globalRelayUrl?.trim()) {
    eligible = eligible.filter(c => c.support_tools && !channelNoTools.has(c.id));
  } else if (needsTools) {
    // relay 模式下只檢查 DB 標記（避開記憶體內的自動學習 Set）
    eligible = eligible.filter(c => c.support_tools);
  }
  if (eligible.length === 0) {
    logStructured("warn", "no channels match capability or context length", { vision: needsVision, tools: needsTools, tokens: estimatedContextTokens, path, rid });
    return { error: { message: `No enabled channels support the requested capabilities (vision=${needsVision}, tools=${needsTools}, tokens=${estimatedContextTokens})`, status: 503 } };
  }
  const attempted = new Set();
  const fallbackModelsTried = new Set();
  const maxAttempts = Math.min(Math.max(eligible.length, 1) * 3, 15);
  let attempts = 0;
  let reqBody = bodyStr;
  let retryAsNonStream = false;
  while (attempts < maxAttempts && attempted.size < eligible.length) {
    attempts++;
    if (clientSignal?.aborted) return { error: { message: "Client disconnected", status: 499 } };
    const channel = selectChannel(eligible, attempted, estimatedContextTokens);
    if (!channel) break;
    // 非重試時重置 reqBody 為原始值，重試時保留修改後的 reqBody（stream: false）
    if (!retryAsNonStream) reqBody = bodyStr;
    retryAsNonStream = false;
    // rate limit 檢查
    const rl = checkRateLimit(channel);
    if (!rl.ok) {
      attempted.add(channel.id);
      logStructured("warn", "rate limit exceeded, try next", { channel: channel.name, reason: rl.reason, rid });
      continue;
    }
    consumeRateLimit(channel);
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
    // 使用已在外面統一解析的 body 字串
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
          let parsed = JSON.parse(reqBody);
          // 前置提示訊息：強制插入到最前面，但檢查所有 system message 避免重複
          const pms = opts.rewrite.request.body._prepend_messages;
          if (pms && Array.isArray(pms) && pms.length > 0 && Array.isArray(parsed.messages)) {
            const pmContent = pms[0]?.content;
            const exists = pmContent && parsed.messages.some(m => m.role === "system" && m.content === pmContent);
            if (!exists) {
              parsed.messages.unshift(...pms);
            }
          }
          for (const [path, val] of Object.entries(opts.rewrite.request.body)) {
            if (path === "_prepend_messages") continue;
            if (path === "model") parsed.model = val;
            else if (path === "max_tokens") parsed.max_tokens = val;
            else if (path === "temperature") parsed.temperature = val;
            else if (path === "top_p") parsed.top_p = val;
            else { parsed[path] = val; }
          }
          reqBody = JSON.stringify(parsed);
        }
        // model_map 獨立於 rewrite.request.body 之外，即使無 body rewrite 仍可生效
        if (opts.model_map && reqBody) {
          let parsed = JSON.parse(reqBody);
          if (parsed.model && opts.model_map[parsed.model]) {
            parsed.model = opts.model_map[parsed.model];
            reqBody = JSON.stringify(parsed);
          }
        }
      } catch (e) {}
    }
    // 使用渠道 model 取代請求中的 model（若渠道 model 有設定）
    // 若已嘗試過 fallback，則改用 fallback_model
    let effectiveModel = "";
    if (requiredType === "chat") {
      if (fallbackModelsTried.has(channel.id)) {
        effectiveModel = channel.fallback_model || "";
      } else {
        effectiveModel = channel.model || "";
      }
    }
    if (effectiveModel && reqBody) {
      try {
        const parsed = JSON.parse(reqBody);
        if (parsed.model && parsed.model !== effectiveModel) {
          parsed.model = effectiveModel;
        }
        // 套用渠道自訂的 max_tokens 上限
        const chMaxTokens = channel.max_tokens || 0;
        if (chMaxTokens > 0) {
          if (parsed.max_tokens !== undefined) {
            parsed.max_tokens = Math.min(parsed.max_tokens, chMaxTokens);
          } else if (parsed.max_completion_tokens !== undefined) {
            parsed.max_completion_tokens = Math.min(parsed.max_completion_tokens, chMaxTokens);
          } else {
            parsed.max_tokens = chMaxTokens;
          }
        }
        reqBody = JSON.stringify(parsed);
      } catch (e) {}
    }

    let timer;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (clientSignal) {
      // 先檢查再註冊 listener，消除註冊與檢查間的 race
      if (clientSignal.aborted) return { error: { message: "Client disconnected", status: 499 } };
      clientSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const isChat = requiredType === "chat";
      timer = setTimeout(onAbort, isChat ? UPSTREAM_TIMEOUT_MS : LONG_TIMEOUT_MS);
      let res;
      if (requiredType === "realtime") {
        // WebSocket upgrade 無法透過 HTTP relay，必須直連
        res = await upstreamFetch(url, { method, headers, body: reqBody, signal: controller.signal }, env, rid, true);
      } else if (globalRelayUrl?.trim()) {
        const relayBase = globalRelayUrl.trim().replace(/\/+$/, '');
        // relay server 即回 meta 架構，避免 CF 邊緣網路 100s 無回應觸發 524
        res = await fetchViaRelay(relayBase, url, method, headers, reqBody, controller.signal, dbRelayToken || env.RELAY_SECRET);
      } else {
        res = await upstreamFetch(url, { method, headers, body: reqBody, signal: controller.signal }, env, rid, false);
      }
      clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onAbort);
      // relay 本身錯誤（配額滿、斷線等）→ 標記 attempted 避免空轉同一渠道
      if (res.headers.get("X-Relay-Error") === "1") {
        res.body?.cancel().catch(() => {});
        attempted.add(channel.id);
        logStructured("warn", "relay error, retrying", { relay: globalRelayUrl, status: res.status, rid });
        continue;
      }
      if (res.ok) {
        markHealthy(channel.id, env);
        if (channel.provider_options) {
          try {
            const opts = typeof channel.provider_options === "string" ? JSON.parse(channel.provider_options) : channel.provider_options;
            // 驗證僅 log 不阻斷請求：log-only, 無論驗證成功與否都不影響回傳內容
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
        if (streamType !== "stream" && !(bodyStr && bodyStr.includes('"stream":true'))) {
          const ct = res.headers.get("Content-Type") || "";
          if (ct.includes("application/json") && (requiredType === "embed" || requiredType === "moderate")) {
            res.clone().text().then(text => {
              const ck = getCacheKey(channel.model || requiredType, bodyStr);
              if (ck) cacheSet(ck, { body: text, headers: { "Content-Type": ct } }, channel.cache_ttl || 3600);
            }).catch(() => {});
          }
        }
        if (estimatedContextTokens > 0) successContextObserved(channel.id, estimatedContextTokens);
        // 空內容學習：串流回應且請求含 tools/vision → 監控是否有實際內容
        // relay 模式跳過自動學習（relay 模擬 FC，SSE 不含 delta.tool_calls 為正常行為）
        if ((needsTools || needsVision) && res.body && !globalRelayUrl?.trim() && (res.headers.get("Content-Type") || "").includes("text/event-stream")) {
          const origBody = res.body;
          let hasToolCalls = false, hasContent = false;
          const monitoredBody = origBody.pipeThrough(new TransformStream({
            transform(chunk, controller) {
              const text = new TextDecoder().decode(chunk, { stream: true });
              for (const line of text.split('\n')) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                  try {
                    const p = JSON.parse(line.slice(6));
                    if (p.choices?.[0]) {
                      if (p.choices[0].delta?.tool_calls) hasToolCalls = true;
                      if (p.choices[0].delta?.content) hasContent = true;
                    }
                  } catch {}
                }
              }
              controller.enqueue(chunk);
            },
            flush() {
              if (needsTools && !hasToolCalls) {
                learnChannelNoTools(channel.id, env);
                logStructured("warn", "learned: channel does not support tools", { channel: channel.name, rid });
              }
              if (needsVision && !hasContent) {
                learnChannelNoVision(channel.id, env);
                logStructured("warn", "learned: channel does not support vision", { channel: channel.name, rid });
              }
            }
          }));
          res = new Response(monitoredBody, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        if (forceNonStream && res.headers.get("Content-Type")?.includes("application/json")) {
          const rawText = await res.clone().text().catch(() => "");
          const { modifiedBody } = processToolCallResponse(rawText);
          if (modifiedBody) {
            logStructured("info", "tool calls reformatted via CF", { rid });
            if (originalStreamType === "stream") {
              res = fakeSseStream(modifiedBody);
            } else {
              res = new Response(modifiedBody, { status: res.status, statusText: res.statusText, headers: res.headers });
            }
          }
        }
        return { response: await patchReasoningToContent(res), channel, clientRequestModel };
      }
      if (res.status >= 500 || res.status === 429) {
        res.body?.cancel().catch(() => {});
        markDegraded(channel.id, env);
        logStructured("warn", "upstream error, retrying", { channel: channel.name, status: res.status, rid });
        continue;
      }
      // 偵測 context overflow → 學習該渠道實際上限，跳過 model fallback
      if ((res.status === 400 || res.status === 413) && estimatedContextTokens > 0) {
        const text = await res.clone().text().catch(() => "");
        if (isContextLengthError(text)) {
          res.body?.cancel().catch(() => {});
          learnContextLimit(channel.id, estimatedContextTokens);
          attempted.add(channel.id);
          logStructured("warn", "context length exceeded, learned limit", { channel: channel.name, tokens: estimatedContextTokens, overflow: contextOverflowAt.get(channel.id), rid });
          continue;
        }
      }
      // 4xx + 原始請求為串流 → 上游可能不支援串流，改用非串流重試同一渠道 (安全性：限定 reqBody 有 stream 屬性時)
      if (res.status >= 400 && res.status < 500 && streamType === "stream" && reqBody) {
        try {
          const parsed = JSON.parse(reqBody);
          if (parsed.stream === true) {
            parsed.stream = false;
            reqBody = JSON.stringify(parsed);
            retryAsNonStream = true;
            refundRateLimit(channel);  // 退還 rate limit 配額，避免重試同一渠道時雙重計算
            logStructured("warn", "4xx with stream=true, retrying same channel with stream=false", { channel: channel.name, status: res.status, rid });
            continue;
          }
        } catch (e) {}
      }
      // 所有非 2xx → 先嘗試備用 model，再換下一個渠道
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        if (channel.fallback_model && !fallbackModelsTried.has(channel.id)) {
          fallbackModelsTried.add(channel.id);
          logStructured("warn", "non-2xx, retrying with fallback model", { channel: channel.name, model: channel.fallback_model, status: res.status, rid });
          continue;
        }
        attempted.add(channel.id);
        logStructured("warn", "non-2xx upstream, trying next channel", { channel: channel.name, status: res.status, rid });
        continue;
      }
      return { response: res };
    } catch (err) {
      clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onAbort);
      refundRateLimit(channel);
      if (clientSignal?.aborted) return { error: { message: "Client disconnected", status: 499 } };
      markDegraded(channel.id, env);
      logStructured("warn", "upstream fetch failed", { channel: channel.name, error: err.message, rid });
      attempted.add(channel.id);
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
  const { response: upstream, clientRequestModel } = result;
  const resHeaders = cleanResponseHeaders(upstream.headers);
  resHeaders.set("X-Request-Id", rid);
  if (isStream) {
    const ct = upstream.headers.get("Content-Type") || "";
    resHeaders.set("X-Debug-Ct", ct);
    if (!ct.includes("text/event-stream")) {
      resHeaders.set("X-Debug-Route", "wrap");
      // 診斷：複製 body 看前 300 chars
      const preview = await upstream.clone().text().catch(() => "(clone failed)");
      resHeaders.set("X-Debug-Body-Preview", preview.slice(0, 300).replace(/[\r\n]/g, '↵'));
      return wrapNonStreamToStream(c, upstream, resHeaders);
    }
    resHeaders.set("X-Debug-Route", "filter");
    let sseBody = createIdleTimeoutStream(upstream.body, STREAM_IDLE_TIMEOUT_MS);
    const filters = await loadFilters(c.env);
    sseBody = sseBody.pipeThrough(createFilterTransform(filters));
    // 將上游模型名稱覆寫為客戶端原始 model 名稱
    if (clientRequestModel) {
      sseBody = sseBody.pipeThrough(createModelRewriteTransform(clientRequestModel));
    }
    resHeaders.set("Cache-Control", "no-cache");
    resHeaders.set("X-Accel-Buffering", "no");
    return new Response(sseBody, { status: upstream.status, headers: resHeaders });
  }
  // 非串流：直接改寫 JSON 中的 model 欄位
  if (clientRequestModel && upstream.headers.get("Content-Type")?.includes("application/json")) {
    const text = await upstream.text().catch(() => "");
    const rewritten = rewriteModelInJson(text, clientRequestModel);
    return new Response(rewritten, { status: upstream.status, headers: resHeaders });
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
      let p;
      try {
        p = JSON.parse(bodyText);
      } catch (e) {
        // 非標準 SSE（多行裸 JSON，無 data: 前綴）→ 逐行加上前綴
        for (const line of bodyText.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (/^\[DONE\]/.test(trimmed) || /^\[ERROR\]/.test(trimmed)) {
            await w.write(enc.encode("data: [DONE]\n\n"));
          } else if (trimmed.startsWith('{')) {
            await w.write(enc.encode("data: " + trimmed + "\n\n"));
          } else if (trimmed.startsWith('data: ')) {
            await w.write(enc.encode(trimmed + "\n\n"));
          }
        }
        await w.close();
        return;
      }
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
        const msgContent = msg.content || "";
        if (msgContent) {
          const content = filters?.length > 0 ? RollingFilter.applyStatic(msgContent, filters) : msgContent;
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
  })().catch(e => logStructured("error", "non-stream-to-stream internal error", { error: e.message }));
  return readable;
}

async function wrapNonStreamToStream(c, upstream, headers) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let keepAlive = true;

  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("X-Accel-Buffering", "no");

  // 每 5 秒送 keepalive，避免 client timeout
  // keepAlive 由下游非同步任務設為 false 終止迴圈；JS 單執行緒保證可見性
  const keepTask = (async () => {
    while (keepAlive) {
      try { await writer.write(enc.encode(": keepalive\n\n")); } catch { break; }
      await sleep(5000);
    }
  })();

  // 非同步等待 upstream 回應，轉 SSE
  (async () => {
    try {
      const text = await upstream.text();
      keepAlive = false;
      if (upstream.status !== 200) {
        // 非 200 → 送 error chunk 再關閉
        try {
          const errObj = JSON.parse(text);
          await writer.write(enc.encode("data: " + JSON.stringify({
            id: "error", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown",
            choices: [{ index: 0, delta: {}, finish_reason: "error" }],
            error: errObj.error || { message: text }
          }) + "\n\n"));
        } catch { /* non-JSON error body — skip */ }
        await writer.write(enc.encode("data: [DONE]\n\n"));
        await writer.close();
        return;
      }
      const filters = await loadFilters(c.env);
      const sseStream = nonStreamToStream(text, filters);
      const reader = sseStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      reader.releaseLock();
    } catch (e) {
      logStructured("error", "wrapNonStreamToStream failed", { error: e.message });
      try {
        await writer.write(enc.encode("data: " + JSON.stringify({
          id: "error", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown",
          choices: [{ index: 0, delta: {}, finish_reason: "error" }]
        }) + "\n\n"));
        await writer.write(enc.encode("data: [DONE]\n\n"));
      } catch {}
    }
    try { await writer.close(); } catch {}
  })();

  return new Response(readable, { status: 200, headers });
}

async function handleModels(c) {
  // 從 channel config 直接聚合模型列表，不依賴各 upstream /v1/models
  // 確保所有渠道類型（含 image_gen / tts / stt 等）都能正確顯示
  const channels = await loadChannels(c.env);
  const data = [];
  const seen = new Set();
  for (const channel of channels) {
    if (isDegraded(channel.id)) continue;
    if (!channel.model) continue;
    const modelId = channel.model.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    data.push({
      id: modelId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: channel.channel_type || "chat",
    });
  }
  return c.json({ object: "list", data });
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
    sseBody = sseBody.pipeThrough(createFilterTransform(filters));
    resHeaders.set("Cache-Control", "no-cache");
    resHeaders.set("X-Accel-Buffering", "no");
    return new Response(sseBody, { status: upstream.status, headers: resHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

async function authMiddleware(c, next) {
  // 跳過非 API 路由（admin portal、login 等）
  const path = c.req.path;
  if (path.startsWith("/admin") || path === "/login" || path === "/" || path === "/api") return next();
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
  // 有前綴路徑 /v1, /v1beta, /v2, /v3, /v4
  for (const p of API_PREFIXES) {
    app.use(p + "/*", authMiddleware);
    app.post(p + "/chat/completions", handleChatCompletions);
    app.post(p + "/completions", handleChatCompletions);
    app.get(p + "/models", handleModels);
    app.all(p + "/*", handleGenericProxy);
  }
  // 無前綴路徑（相容 OpenCode/Claude Code 等不含 /v1 的 client）
  app.post("/chat/completions", authMiddleware, handleChatCompletions);
  app.post("/completions", authMiddleware, handleChatCompletions);
  app.get("/models", authMiddleware, handleModels);
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
          if (h.value === undefined || h.value === null || (typeof h.value === "string" && h.value.trim().length === 0))
            errors.push(`[${i}] headers[${j}]: value is required`);
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
      const { relay_url: _relay, ...chClean } = ch; // 移除已廢棄的 per-channel relay_url
      return { ...chClean, api_key: chClean.api_key || '', headers, provider_options };
    });
    return c.json({ channels, filters: fl.results || [], config: { token: cf?.client_token || "", relay_url: cf?.relay_url || "", relay_token: cf?.relay_token || "" } });
  });

  // 完整匯出（含 unmasked API Key），用作全設定手動備份
  api.get("/export", async (c) => {
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
      // 匯出不遮罩 api_key
      const { relay_url: _relay, ...chClean } = ch; // 移除已廢棄的 per-channel relay_url
      return { ...chClean, headers, provider_options };
    });
    return c.json({ version: 1, channels, filters: fl.results || [], config: { token: cf?.client_token || "", relay_url: cf?.relay_url || "", relay_token: cf?.relay_token || "" } });
  });

  api.post("/batch-channels", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body)) return c.json({ ok: false, error: "Expected array" }, 400);
    const errs = validateChannelData(body);
    if (errs.length > 0) return c.json({ ok: false, error: "Validation failed", details: errs }, 400);
    // D1 batch transactions have a 100-statement limit (D1_BATCH_LIMIT = 100).
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
    const cols = "id, name, base_url, api_key, model, weight, is_enabled, stream_type, channel_type, headers, provider, provider_options, max_tokens, fallback_model, health_check_enabled, health_check_interval, health_check_timeout, cache_enabled, cache_ttl, rate_limit_algorithm, rate_limit_capacity, rate_limit_rate, rpm_limit, rpd_limit, consecutive_errors, last_error_msg, last_error_at, support_stream, support_image_gen, support_audio_tts, support_audio_stt, support_image_edit, support_embeddings, absolute_url, response_time, support_tools, support_vision, max_context_length";
    const ph = cols.split(",").map(() => "?").join(",");
    const batch = [c.env.DB.prepare("DELETE FROM channels")];
    for (const ch of body) {
      const apiKey = (!ch.api_key || isMasked(ch.api_key)) ? (allKeys[ch.id] || "") : ch.api_key;
      batch.push(
        c.env.DB.prepare(`INSERT INTO channels (${cols}) VALUES (${ph})`).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey, ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0,
          ch.stream_type || "both", ch.channel_type || "chat", JSON.stringify(ch.headers || []),
          ch.provider || "", (ch.provider_options && typeof ch.provider_options === "object" && !Array.isArray(ch.provider_options) ? JSON.stringify(ch.provider_options) : (typeof ch.provider_options === "string" ? ch.provider_options : "[]")), ch.max_tokens || 0, ch.fallback_model || "",
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
          ch.absolute_url ? 1 : 0, ch.response_time || 0, ch.support_tools != null ? (ch.support_tools ? 1 : 0) : 1,
          ch.support_vision != null ? (ch.support_vision ? 1 : 0) : 0,
          ch.max_context_length || 0
        )
      );
    }
    for (let i = 0; i < batch.length; i += D1_BATCH_LIMIT) {
      const chunk = batch.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length > 0) await retry(() => c.env.DB.batch(chunk));
    }
    clearGatewayCache();
    // 在後台預熱常用快取，降低 D1 eventual consistency 影響
    loadChannels(c.env).catch(() => {});
    loadChannels(c.env, "chat").catch(() => {});
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
    const ex = await c.env.DB.prepare("SELECT client_token, relay_url, relay_token FROM config WHERE id=1").first();
    const existingToken = ex?.client_token || "";
    try {
      const token = b.token !== undefined ? b.token : (existingToken || getDefaults().token);
      let updates = [];
      let bindings = [];
      updates.push("client_token=?"); bindings.push(token);
      if (b.relay_url !== undefined) {
        updates.push("relay_url=?"); bindings.push(b.relay_url);
      }
      if (b.relay_token !== undefined) {
        updates.push("relay_token=?"); bindings.push(b.relay_token);
      }
      if (ex) {
        await c.env.DB.prepare(`UPDATE config SET ${updates.join(",")} WHERE id=1`).bind(...bindings).run();
      } else {
        const rUrl = b.relay_url || "";
        const rToken = b.relay_token || "";
        await c.env.DB.prepare("INSERT INTO config (id, client_token, admin_password, relay_url, relay_token) VALUES (1, ?, '', ?, ?)").bind(token, rUrl, rToken).run();
      }
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
    const relayUrl = ch.relay_url?.trim();
    const { relay_token: dbRelayToken } = await resolveGlobalConfig(c.env);
    const relayToken = dbRelayToken || c.env.RELAY_SECRET;
    const start = Date.now();
    try {
      const testHeaders = { Authorization: "Bearer " + (ch.api_key || ""), "Content-Type": "application/json" };
      const testBody = JSON.stringify({ model: ch.model || "test", messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
      const TEST_TIMEOUT_MS = 10000;
      const startFetch = Date.now();
      let res;
      if (relayUrl) {
        // fetchViaRelay 的 body 讀取不在初始 signal 範圍內，用 race 強制總 timeout
        const fetchPromise = fetchViaRelay(relayUrl.replace(/\/+$/, ""), testUrl, "POST", testHeaders, testBody, AbortSignal.timeout(TEST_TIMEOUT_MS), relayToken);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("relay test timeout")), TEST_TIMEOUT_MS)
        );
        res = await Promise.race([fetchPromise, timeoutPromise]);
      } else {
        res = await fetch(testUrl, {
          method: "POST",
          headers: testHeaders,
          body: testBody,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
      }
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
  exposeHeaders: ["Content-Length", "X-Session-Token"],
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
