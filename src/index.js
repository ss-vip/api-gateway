import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import portalHtml from "./dashboard.html";

const UPSTREAM_TIMEOUT_MS = 120_000;     // 等待 relay 回應 metadata 的上限（串流經 relay + upstream thinking 可能較久）
const LONG_TIMEOUT_MS = 120_000;
const CHANNEL_COOLDOWN_BASE_MS = 30_000; // 指數退避 ×2^n，上限 300s
const CHANNEL_COOLDOWN_MAX_MS = 300_000;
const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 10_000; // 429 無訊息時的預設冷卻
const STREAM_IDLE_TIMEOUT_MS = 90_000;  // 串流中無新 chunk 視為斷流（free tier 上游可能較慢）

const TOKEN_TTL = 60_000;
const FILTER_TTL = 180_000;
const SESSION_TTL = 604800000; // 7 天
const SESSION_PRUNE_INTERVAL = 50;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const adminSessions = new Map();
let sessionPruneCounter = 0;

// 自動學習：渠道實際 context 上限（從 runtime 錯誤回饋）
const contextOverflowAt = new Map();
function isContextLengthError(text) {
  return /context_length|context length|maximum.*(?:context|tokens)|exceeds.*limit|too many tokens|token limit/i.test(text);
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
  await env.DB.prepare("INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expiresAt).run().catch(e => console.error("[session] DB insert failed:", e.message));
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
function setPepper(p) {
  pepper = p || "";
  if (!p) console.warn("[security] PASSWORD_PEPPER not set — using empty pepper; PBKDF2 strength reduced");
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pepper + password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" }, key, 256
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
    { name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" }, key, 256
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
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
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
const SESSIONS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`;

const RATE_LIMITS_DDL = `CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_type  TEXT NOT NULL,
  bucket_key   TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_type, bucket_key, window_start)
)`;

const ALL_DDLS = [CHANNELS_DDL, FILTERS_DDL, CONFIG_DDL, SCHEMA_META_DDL, SESSIONS_DDL, SESSIONS_INDEX_DDL, RATE_LIMITS_DDL];
const ALL_TABLES = ["channels", "filters", "config", "schema_meta", "sessions", "sessions_index", "rate_limits"];

async function ensureSchema(env) {
  if (schemaReady) return;
  let ok = 0;
  // 批次建立全部表格（1 次 subrequest vs 7 次）
  try {
    await env.DB.batch(ALL_DDLS.map(sql => env.DB.prepare(sql)));
    ok = ALL_DDLS.length;
  } catch (e) {
    console.error("[schema] batch DDL failed, retrying individually:", e.message);
    for (let i = 0; i < ALL_DDLS.length; i++) {
      try {
        await env.DB.prepare(ALL_DDLS[i]).run();
        ok++;
      } catch (e2) {
        console.error(`[schema] failed to create table ${ALL_TABLES[i]}:`, e2.message);
      }
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
  // 冷啟動時主動檢查 relay 健康狀態（fire-and-forget 不阻塞啟動）
  // 用 env 參數讀取 relay 位址，避免首次 resolveGlobalConfig 觸發額外 D1 查詢
  const relayUrl = env.RELAY_BASE_URL || env.RELAY_URL;
  if (relayUrl) {
    fetch(relayUrl.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(5000) })
      .then(r => { if (!r.ok) throw new Error('health: ' + r.status); })
      .catch(() => {
        if (relayHealthy) {
          relayHealthy = false;
          relayErrorCount = 5;
          console.warn('[relay] startup health check failed — marking unhealthy');
        }
      });
  }
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
  if (parseInt(schemaVer, 10) < 9) {
    try { await env.DB.prepare(SESSIONS_INDEX_DDL).run(); } catch (e) { /* 索引已存在則略過 */ }
  }
  if (parseInt(schemaVer, 10) < 10) {
    try { await env.DB.prepare(RATE_LIMITS_DDL).run(); } catch (e) { /* 表格已存在則略過 */ }
  }
  // migration 完成後寫入 DB flag，下次冷啟動直接跳過
  await env.DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_ver', '10')").run();
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
const typeLoadPromises = new Map(); // "type" => Promise (去重用)
const TYPE_CACHE_TTL = 30000;
const degradedUntil = new Map();
const degradeCount = new Map(); // channel id → 連續降級次數（用於指數退避）
let relayHealthy = true;        // relay 健康狀態，連續錯誤時標記 false 以繞過 relay
let relayErrorCount = 0;        // relay 連續錯誤計數

// 從上游錯誤訊息中解析建議冷卻時間（如 "7 seconds between messages" → 7000）
function parseRateLimitCooldown(text) {
  if (!text || typeof text !== "string") return 0;
  const m = text.match(/(\d+)\s*(second|sec|s)\b/i);
  if (m) return Math.min(parseInt(m[1], 10) * 1000, 120_000);
  const rm = text.match(/retry[_-]?after[:\s]+(\d+)/i);
  if (rm) return Math.min(parseInt(rm[1], 10) * 1000, 120_000);
  return 0;
}

async function loadChannels(env, channelType) {
  const now = Date.now();
  if (channelType) {
    const cached = typeChannelCache.get(channelType);
    if (cached && now - cached.ts < TYPE_CACHE_TTL) return cached.data;
    // 避免同一 type 的並發請求重複打 DB
    if (typeLoadPromises.has(channelType)) return typeLoadPromises.get(channelType);
    const p = (async () => {
      try {
        const rows = await dbLoadChannels(env, channelType);
        typeChannelCache.set(channelType, { data: rows, ts: Date.now() });
        return rows;
      } catch (e) {
        console.error(`[channel] load error for type ${channelType}:`, e.message);
        const old = typeChannelCache.get(channelType);
        return old?.data || [];
      } finally {
        typeLoadPromises.delete(channelType);
      }
    })();
    typeLoadPromises.set(channelType, p);
    return p;
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
      cooldown_until, rpm_limit, rpd_limit, cache_ttl,
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

function selectChannel(channels, exclude = new Set(), estimatedContextTokens = 0, preferredModel = null) {
  const healthy = channels.filter(c => !exclude.has(c.id) && !isDegraded(c.id));
  if (healthy.length === 0) return null;
  // 優先從 model 相符的渠道中選取；全部失敗後降級到不匹配渠道
  let pool = healthy;
  if (preferredModel) {
    const matching = healthy.filter(c => c.model === preferredModel || c.fallback_model === preferredModel);
    if (matching.length > 0) pool = matching;
  }
  const weights = pool.map(c => {
    let weight = Math.max(c.weight, 1);
    if (estimatedContextTokens > 0) {
      if (+c.max_context_length > 0) {
        const ratio = estimatedContextTokens / +c.max_context_length;
        if (ratio >= 0.9) {
          weight *= 0.7;
        } else if (ratio >= 0.7) {
          weight *= 0.85;
        } else if (ratio < 0.5) {
          // 請求遠小於限制 → 加成，保留無限渠道給真正需要的大請求
          const boost = 1 + (1 - ratio * 2) * 0.5; // ratio 0 → *1.5, ratio 0.25 → *1.25, ratio 0.5 → 無加成
          weight *= boost;
        }
      } else if (estimatedContextTokens < 1000) {
        // max_context_length=0（無限）但請求很小 → 降權，優先讓有限渠道承接
        weight *= 0.7;
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

function markDegraded(channelId, env, customBackoffMs) {
  const currentCount = degradeCount.get(channelId) || 0;
  const backoffMs = customBackoffMs || Math.min(CHANNEL_COOLDOWN_BASE_MS * Math.pow(2, currentCount), CHANNEL_COOLDOWN_MAX_MS);
  const until = Date.now() + backoffMs;
  degradedUntil.set(channelId, until);
  degradeCount.set(channelId, currentCount + 1);
  if (env) {
    env.DB.prepare(`UPDATE channels SET cooldown_until=?, consecutive_errors=consecutive_errors+1, consecutive_successes=0 WHERE id=?`).bind(until, channelId).run().catch(() => {});
  }
}

function markHealthy(channelId, env) {
  degradedUntil.delete(channelId);
  degradeCount.delete(channelId);
  if (env) {
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

const localTokenBuckets = new Map(); // D1 故障時 fallback
let cleanupRlCounter = 0;

// 定期清理過期的 rate_limits 記錄，防止 D1 儲存無限增長
async function tryCleanupRateLimits(env) {
  try {
    const now = Date.now();
    await env.DB.prepare(
      `DELETE FROM rate_limits WHERE
        (bucket_type = 'rpm' AND window_start < ?) OR
        (bucket_type = 'rpd' AND window_start < ?) OR
        (bucket_type = 'client_ip' AND window_start < ?)`
    ).bind(
      Math.floor(now / 60000) - 1,    // RPM：保留最近 1 分鐘
      Math.floor(now / 86400000) - 1,  // RPD：保留最近 1 天
      Math.floor(now / 60000) - 1     // client_ip：保留最近 1 分鐘
    ).run();
  } catch (e) { /* 清理失敗不影響主流程 */ }
}

async function checkRateLimitD1(env, channel) {
  if (!channel.rpm_limit && !channel.rpd_limit) return { ok: true };
  const now = Date.now();
  const stmts = [];
  const rpmWindow = Math.floor(now / 60000);
  const rpdWindow = Math.floor(now / 86400000);

  if (channel.rpm_limit > 0) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO rate_limits (bucket_type, bucket_key, window_start, count)
         VALUES ('rpm', ?, ?, 1)
         ON CONFLICT(bucket_type, bucket_key, window_start)
         DO UPDATE SET count = count + 1
         RETURNING count`
      ).bind(String(channel.id), rpmWindow)
    );
  }
  if (channel.rpd_limit > 0) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO rate_limits (bucket_type, bucket_key, window_start, count)
         VALUES ('rpd', ?, ?, 1)
         ON CONFLICT(bucket_type, bucket_key, window_start)
         DO UPDATE SET count = count + 1
         RETURNING count`
      ).bind(String(channel.id), rpdWindow)
    );
  }

  try {
    const results = await env.DB.batch(stmts);
    let idx = 0;
    if (channel.rpm_limit > 0) {
      const count = results[idx]?.results?.[0]?.count || 0;
      if (count > channel.rpm_limit) return { ok: false, reason: 'rpm_limit', rpmWindow, rpdWindow };
      idx++;
    }
    if (channel.rpd_limit > 0) {
      const count = results[idx]?.results?.[0]?.count || 0;
      if (count > channel.rpd_limit) return { ok: false, reason: 'rpd_limit', rpmWindow, rpdWindow };
    }
  } catch (e) {
    // D1 失敗 → fallback 到本地記憶體
    return localCheckAndConsume(channel);
  }
  // 低成本清理：每 500 次 rate limit 查詢清理一次過期記錄
  if (++cleanupRlCounter % 500 === 0) {
    tryCleanupRateLimits(env);
  }
  return { ok: true, rpmWindow, rpdWindow };
}

// 退還 D1 rate limit 配額（fire-and-forget，不阻塞請求）
// rpmWindow/rpdWindow 使用請求抵達時的視窗值，避免跨分鐘/日退款到錯誤 bucket
function refundRateLimitD1(env, channel, rpmWindow, rpdWindow) {
  if (!channel.rpm_limit && !channel.rpd_limit) return;
  const stmts = [];
  if (channel.rpm_limit > 0) {
    const minute = rpmWindow ?? Math.floor(Date.now() / 60000);
    stmts.push(
      env.DB.prepare(
        `UPDATE rate_limits SET count = MAX(0, count - 1)
         WHERE bucket_type = 'rpm' AND bucket_key = ? AND window_start = ?`
      ).bind(String(channel.id), minute)
    );
  }
  if (channel.rpd_limit > 0) {
    const day = rpdWindow ?? Math.floor(Date.now() / 86400000);
    stmts.push(
      env.DB.prepare(
        `UPDATE rate_limits SET count = MAX(0, count - 1)
         WHERE bucket_type = 'rpd' AND bucket_key = ? AND window_start = ?`
      ).bind(String(channel.id), day)
    );
  }
  if (stmts.length > 0) {
    env.DB.batch(stmts).catch(() => {});
  }
}

// D1 故障時的本地 fallback（check + consume 同步）
function localCheckAndConsume(channel) {
  if (!channel.rpm_limit && !channel.rpd_limit) return { ok: true };
  const now = Date.now();
  const cid = channel.id || 0;
  let bucket = localTokenBuckets.get(cid);
  if (!bucket) {
    bucket = { rpm: channel.rpm_limit || 0, rpmTs: now, rpmCount: 0, rpd: channel.rpd_limit || 0, rpdTs: now, rpdCount: 0 };
    localTokenBuckets.set(cid, bucket);
  }
  if (bucket.rpm > 0) {
    if (now - bucket.rpmTs > 60000) { bucket.rpmCount = 0; bucket.rpmTs = now; }
    if (bucket.rpmCount >= bucket.rpm) return { ok: false, reason: 'rpm_limit' };
  }
  if (bucket.rpd > 0) {
    if (now - bucket.rpdTs > 86400000) { bucket.rpdCount = 0; bucket.rpdTs = now; }
    if (bucket.rpdCount >= bucket.rpd) return { ok: false, reason: 'rpd_limit' };
  }
  bucket.rpmCount++;
  bucket.rpdCount++;
  return { ok: true };
}

const IP_LIMIT_PER_MIN = 60;

async function checkClientIpRateLimit(env, clientIp) {
  if (!clientIp || clientIp === 'unknown') return { ok: true };
  const minute = Math.floor(Date.now() / 60000);
  try {
    const result = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket_type, bucket_key, window_start, count)
       VALUES ('client_ip', ?, ?, 1)
       ON CONFLICT(bucket_type, bucket_key, window_start)
       DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(clientIp, minute).first();
    if (result && result.count > IP_LIMIT_PER_MIN) {
      return { ok: false, reason: 'client_ip_limit' };
    }
  } catch (e) {
    // D1 故障時允許通過
  }
  return { ok: true };
}

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
  localTokenBuckets.clear();
  responseCache.clear();
  contextOverflowAt.clear();
  degradedUntil.clear();
  degradeCount.clear();
  relayHealthy = true;
  relayErrorCount = 0;
  clearChannelCache();
}

let pruneCounter = 0;
function pruneRuntimeMaps() {
  pruneCounter++;
  if (pruneCounter % 50 !== 0) return;
  const now = Date.now();
  // 清理過期的 degradedUntil 與對應的 degradeCount
  for (const [id, until] of degradedUntil) {
    if (until <= now) {
      degradedUntil.delete(id);
      degradeCount.delete(id);
    }
  }
  // contextOverflowAt：只保留最近 100 筆
  if (contextOverflowAt.size > 100) {
    const entries = [...contextOverflowAt.entries()].sort((a, b) => a[1] - b[1]);
    contextOverflowAt.clear();
    for (let i = 0; i < 100; i++) contextOverflowAt.set(entries[i][0], entries[i][1]);
  }
  // channelNoTools/NoVision：上限 500，超過時清理最早的一半
  for (const set of [channelNoTools, channelNoVision]) {
    if (set.size > 500) {
      const arr = [...set];
      set.clear();
      for (let i = arr.length - 250; i < arr.length; i++) set.add(arr[i]);
    }
  }
  // localTokenBuckets：上限 500
  if (localTokenBuckets.size > 500) {
    const entries = [...localTokenBuckets.entries()].slice(0, 500);
    localTokenBuckets.clear();
    for (const [k, v] of entries) localTokenBuckets.set(k, v);
  }
  // responseCache：被動清理（僅清理已過期條目，避免遍歷全部）
  if (responseCache.size > CACHE_MAX_ENTRIES * 1.5) {
    const now2 = Date.now();
    for (const [k, v] of responseCache) {
      if (v.expires && v.expires <= now2) responseCache.delete(k);
    }
  }
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
  headers.delete("cookie");
  headers.delete("set-cookie");
  headers.delete("authorization");
  return headers;
}

function cleanResponseHeaders(headers) {
  const h = new Headers(headers);
  h.delete("transfer-encoding");
  h.delete("cf-ray");
  h.delete("cf-cache-status");
  return h;
}

function createModelRewriteTransform(clientModel) {
  if (!clientModel) return new TransformStream();
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
        if (line.startsWith("data: ") && line.includes("[DONE]")) {
          controller.enqueue(encoder.encode(line + "\n\n"));
          continue;
        }
        if (line) controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      if (buf) controller.enqueue(encoder.encode(buf));
    }
  });
}

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
        } else if (/^\[ERROR\]/.test(line)) {
          controller.enqueue(encoder.encode("data: " + JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "error" }]
          }) + "\n\ndata: [DONE]\n\n"));
        } else if (/^\[DONE\]/.test(line)) {
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
  const enc = new TextEncoder();
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
    } catch (e) {
      // 不論閒置逾時或其他串流錯誤，都送 error chunk 讓 client 知道串流不完整
      const isIdle = e.message === "idle";
      logStructured("warn", isIdle ? "stream idle timeout" : "stream error", { error: e.message?.slice(0, 100) || "unknown" });
      try {
        await writer.write(enc.encode("data: " + JSON.stringify({
          id: "stream_end", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "",
          choices: [{ index: 0, delta: {}, finish_reason: "error" }]
        }) + "\n\ndata: [DONE]\n\n"));
      } catch (_) {}
      try { await writer.close(); } catch (_) {}
    }
    finally { clearTimeout(idleTimer); reader.releaseLock(); }
  })().catch(e => logStructured("error", "idle-timeout-stream internal error", { error: e.message }));
  return out;
}

// 跨 realm 安全的 Uint8Array 檢測
function isUint8Array(v) {
  return Object.prototype.toString.call(v) === '[object Uint8Array]';
}

// 從 relay 回應的 chunk 串流中萃取 _relay 元資料，回傳 { meta, rest, reader }
async function readRelayMeta(reader) {
  const chunks = [];
  let totalLen = 0;
  const MAX_META = 65536;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return null;
    const nlIdx = value.indexOf(0x0a);
    if (nlIdx >= 0) {
      const metaBytes = new Uint8Array(totalLen + nlIdx);
      let off = 0;
      for (const c of chunks) { metaBytes.set(c, off); off += c.length; }
      metaBytes.set(value.subarray(0, nlIdx), off);
      const rest = value.subarray(nlIdx + 1);
      let meta;
      try { meta = JSON.parse(new TextDecoder().decode(metaBytes)); } catch { return null; }
      if (!meta._relay) return null;
      return { meta: meta._relay, rest, reader };
    }
    chunks.push(value);
    totalLen += value.length;
    if (totalLen > MAX_META) return null;
  }
}

// 建立保留剩餘 chunk 的串流（避免跨 realm instanceof 問題）
function createRelayStream(initial, reader) {
  let initialSent = false;
  return new ReadableStream({
    async pull(controller) {
      if (!initialSent) {
        initialSent = true;
        if (isUint8Array(initial) && initial.length > 0) {
          controller.enqueue(new Uint8Array(initial)); // 複製到當前 realm
          return;
        }
        // rest 為空（metadata 與 upstream body 分屬不同 TCP chunk）
        // 不回傳而是繼續往下讀 reader
      }
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) { controller.error(e); }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
}

async function parseRelayResponse(relayRes) {
  if (!relayRes.ok || !relayRes.body) {
    const text = await relayRes.text().catch(() => "relay unavailable");
    const fake = new Response(text, { status: relayRes.status || 502, headers: relayRes.headers });
    fake.headers.set("X-Relay-Error", "1");
    return { relayError: true, response: fake };
  }
  const reader = relayRes.body.getReader();
  const parsed = await readRelayMeta(reader);
  if (!parsed) {
    reader.cancel().catch(() => {});
    const fake = new Response(JSON.stringify({ error: "invalid relay response" }), { status: 502, headers: { "content-type": "application/json" } });
    fake.headers.set("X-Relay-Error", "1");
    return { relayError: true, response: fake };
  }
  if (parsed.meta.error) {
    reader.cancel().catch(() => {});
    const fake = new Response(JSON.stringify({ error: parsed.meta.error }), { status: 502, headers: { "content-type": "application/json" } });
    fake.headers.set("X-Relay-Error", "1");
    return { relayError: true, response: fake };
  }
  const upstreamStatus = parsed.meta.status || relayRes.status;
  const upstreamHeaders = new Headers(parsed.meta.headers || {});
  upstreamHeaders.delete("content-encoding");
  const bodyStream = createRelayStream(parsed.rest, parsed.reader);
  return { response: new Response(bodyStream, { status: upstreamStatus, headers: upstreamHeaders }) };
}

async function upstreamFetch(url, opts, env, rid, noRelay, channel) {
  if (noRelay || !env.RELAY_BASE_URL) {
    return fetch(url, opts);
  }
  const { relay_token: dbRelayToken } = await resolveGlobalConfig(env);
  const relayToken = dbRelayToken || env.RELAY_SECRET || "";
  const relayHeaders = new Headers(opts.headers);
  relayHeaders.set("x-target-url", url);
  if (relayToken) relayHeaders.set("x-relay-token", relayToken);
  // 傳遞 channel 速率限制資訊給 relay
  if (channel) {
    relayHeaders.set("x-channel-id", String(channel.id));
    if (channel.rpm_limit) relayHeaders.set("x-channel-rpm", String(channel.rpm_limit));
    if (channel.rpd_limit) relayHeaders.set("x-channel-rpd", String(channel.rpd_limit));
  }
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

// 透過全域 relay 轉發請求（用於 D1 設定的 relay_url）
async function fetchViaRelay(relayBase, targetUrl, method, baseHeaders, body, signal, relaySecret) {
  const h = new Headers(baseHeaders);
  h.set("x-target-url", targetUrl);
  if (relaySecret) h.set("x-relay-token", relaySecret);
  const relayRes = await fetch(relayBase, { method, headers: h, body, signal });
  if (relayRes.headers.get("x-relay") !== "1") return relayRes;
  const reader = relayRes.body.getReader();
  const parsed = await readRelayMeta(reader);
  if (!parsed) {
    reader.cancel().catch(() => {});
    return new Response(JSON.stringify({ error: "invalid relay response" }), { status: 502, headers: { "content-type": "application/json", "x-relay-error": "1" } });
  }
  if (parsed.meta.error) {
    reader.cancel().catch(() => {});
    return new Response(JSON.stringify({ error: parsed.meta.error }), {
      status: 502,
      headers: { "content-type": "application/json", "x-relay-error": "1" }
    });
  }
  const upstreamStatus = parsed.meta.status || relayRes.status;
  const upstreamHeaders = new Headers(parsed.meta.headers || {});
  // relay 已終止上游傳輸層，移除 Content-Encoding 避免下游 double decoding
  upstreamHeaders.delete("content-encoding");
  const bodyStream = createRelayStream(parsed.rest, parsed.reader);
  return new Response(bodyStream, { status: upstreamStatus, headers: upstreamHeaders });
}

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

async function tryForward(env, path, method, baseHeaders, body, rid, streamType, clientSignal, clientIp) {
  pruneRuntimeMaps();
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
  // 客戶端指定 model 時，相符渠道優先；全部失敗後降級到不匹配渠道
  // （filter 邏輯已移到 selectChannel，改為權重優先）
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
  if (needsTools && !globalRelayUrl?.trim()) {
    eligible = eligible.filter(c => c.support_tools && !channelNoTools.has(c.id));
  } else if (needsTools) {
    // relay 模式只檢查 DB 標記（無自動學習）
    eligible = eligible.filter(c => c.support_tools);
  }
  if (eligible.length === 0) {
    logStructured("warn", "no channels match capability or context length", { vision: needsVision, tools: needsTools, tokens: estimatedContextTokens, path, rid });
    return { error: { message: `No enabled channels support the requested capabilities (vision=${needsVision}, tools=${needsTools}, tokens=${estimatedContextTokens})`, status: 503 } };
  }
  // Client IP 速率限制
  if (clientIp) {
    const ipCheck = await checkClientIpRateLimit(env, clientIp);
    if (!ipCheck.ok) {
      logStructured("warn", "client IP rate limit exceeded", { clientIp, rid });
      return { error: { message: "Too many requests from this IP. Please slow down.", status: 429 } };
    }
  }
  const attempted = new Set();
  const fallbackModelsTried = new Set();
  const maxAttempts = Math.min(Math.max(eligible.length, 1) * 3, 8); // 15→8 減少 CF Free subrequest 超限
  let attempts = 0;
  let reqBody = bodyStr;
  let retryAsNonStream = false;
  // 記錄 rate limit 實際使用的 windows，確保 refund 正確
  let rlRpmWindow = Math.floor(Date.now() / 60000);
  let rlRpdWindow = Math.floor(Date.now() / 86400000);
  while (attempts < maxAttempts && attempted.size < eligible.length) {
    attempts++;
    if (clientSignal?.aborted) return { error: { message: "Client disconnected", status: 499 } };
    const channel = selectChannel(eligible, attempted, estimatedContextTokens, clientRequestModel);
    if (!channel) break;
    // 非重試時重置 reqBody 為原始值，重試時保留修改後的 reqBody（stream: false）
    if (!retryAsNonStream) reqBody = bodyStr;
    retryAsNonStream = false;
    // rate limit 檢查：Relay 啟用時由 Relay 處理（in-memory 更精確），否則走 D1
    const relayActive = !!(globalRelayUrl?.trim() || env.RELAY_BASE_URL);
    if (!relayActive) {
      const rl = await checkRateLimitD1(env, channel);
      if (!rl.ok) {
        attempted.add(channel.id);
        logStructured("warn", "rate limit exceeded, try next", { channel: channel.name, reason: rl.reason, rid });
        continue;
      }
      // 記錄實際使用的 windows（checkRateLimitD1 可能與入口時差跨分鐘邊界）
      if (rl.rpmWindow !== undefined) rlRpmWindow = rl.rpmWindow;
      if (rl.rpdWindow !== undefined) rlRpdWindow = rl.rpdWindow;
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
        res = await upstreamFetch(url, { method, headers, body: reqBody, signal: controller.signal }, env, rid, true);
      } else if (globalRelayUrl?.trim() && relayHealthy) {
        const relayBase = globalRelayUrl.trim().replace(/\/+$/, '');
        if (channel) {
          headers.set("x-channel-id", String(channel.id));
          if (channel.rpm_limit) headers.set("x-channel-rpm", String(channel.rpm_limit));
          if (channel.rpd_limit) headers.set("x-channel-rpd", String(channel.rpd_limit));
        }
        res = await fetchViaRelay(relayBase, url, method, headers, reqBody, controller.signal, dbRelayToken || env.RELAY_SECRET);
      } else {
        // relay 不健康時繞過（relay 降級期間 direct connection 可用性仍高於卡死在 relay）
        const bypassRelay = !relayHealthy;
        res = await upstreamFetch(url, { method, headers, body: reqBody, signal: controller.signal }, env, rid, bypassRelay, channel);
      }
      clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onAbort);
      // relay 本身錯誤（配額滿、斷線等）→ 標記 attempted 避免空轉同一渠道
      if (res.headers.get("X-Relay-Error") === "1") {
        res.body?.cancel().catch(() => {});
        attempted.add(channel.id);
        relayErrorCount++;
        if (relayErrorCount >= 5) {
          relayHealthy = false;
          // 暫停使用 relay 60 秒（防止 relay 徹底掛掉時大量請求持續失敗）
          setTimeout(() => { relayHealthy = true; relayErrorCount = 0; }, 60_000);
          logStructured("warn", "relay repeatedly failing, disabling for 60s", { relay: globalRelayUrl, rid });
        }
        logStructured("warn", "relay error, retrying", { relay: globalRelayUrl, status: res.status, rid });
        continue;
      }
      // relay 請求成功 → 逐漸恢復 relay 信心
      if (globalRelayUrl?.trim() && relayErrorCount > 0) {
        relayErrorCount = Math.max(0, relayErrorCount - 1);
        if (relayErrorCount === 0) relayHealthy = true;
      }
      if (res.ok) {
        markHealthy(channel.id, env);
        // 信任 upstream metadata 的 Content-Type，不再 peek 第一位元組
        // （避免 thinking model 延遲導致 handler 阻塞）
        if (channel.provider_options) {
          try {
            const opts = typeof channel.provider_options === "string" ? JSON.parse(channel.provider_options) : channel.provider_options;
            // 驗證僅 log 不阻斷請求：log-only, 無論驗證成功與否都不影響回傳內容
            if (opts.validate?.response?.required_fields && res.headers.get("Content-Type")?.includes("json")) {
              const text = await res.clone().text().catch(() => "");
              if (text.length > 500_000) {
                logStructured("warn", "response too large, skip validation", { size: text.length });
              } else {
                try {
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
                } catch (e) {}
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
        // relay 模式跳過自動學習（上游原生處理 tools）
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
        return { response: await patchReasoningToContent(res), channel, clientRequestModel };
      }
      // 上游速率限制（429/403）— 優先解析 cooldown，無訊息用預設 10s
      if (res.status === 403 || res.status === 429) {
        const text = await res.clone().text().catch(() => "");
        // 優先取 Retry-After header（上游標準指定），其次解析 body 文字
        const retryAfter = res.headers.get("Retry-After");
        const headerCooldown = retryAfter ? parseInt(retryAfter, 10) * 1000 : 0;
        const bodyCooldown = parseRateLimitCooldown(text);
        const cooldown = headerCooldown || bodyCooldown || (res.status === 429 ? RATE_LIMIT_DEFAULT_COOLDOWN_MS : 0);
        if (cooldown > 0) {
          res.body?.cancel().catch(() => {});
          markDegraded(channel.id, env, cooldown);
          logStructured("warn", "upstream rate limited, cooling", { channel: channel.name, cooldownMs: cooldown, rid });
          attempted.add(channel.id);
          continue;
        }
      }
      // 5xx 錯誤（不含 429）→ 指數退避
      if (res.status >= 500) {
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
            res.body?.cancel().catch(() => {});
            parsed.stream = false;
            reqBody = JSON.stringify(parsed);
            retryAsNonStream = true;
            refundRateLimitD1(env, channel, rlRpmWindow, rlRpdWindow);
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
      refundRateLimitD1(env, channel, rlRpmWindow, rlRpdWindow);
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
  const clientIp = c.req.raw.headers.get("cf-connecting-ip") || "";
  const result = await tryForward(c.env, c.req.path, "POST", baseHeaders, rawBody, rid, isStream ? "stream" : "nonstream", c.req.raw.signal, clientIp);
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
          if (/^\[ERROR\]/.test(trimmed)) {
            await w.write(enc.encode("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }) + "\n\ndata: [DONE]\n\n"));
          } else if (/^\[DONE\]/.test(trimmed)) {
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
  const clientIp = c.req.raw.headers.get("cf-connecting-ip") || "";
  const result = await tryForward(c.env, path, c.req.method, baseHeaders, rawBody, rid, streamType, c.req.raw.signal, clientIp);
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
  for (const p of API_PREFIXES) {
    app.use(p + "/*", authMiddleware);
    app.post(p + "/chat/completions", handleChatCompletions);
    app.post(p + "/completions", handleChatCompletions);
    app.get(p + "/models", handleModels);
    app.all(p + "/*", handleGenericProxy);
  }
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
    if (setupRateLimit.size > 500) {
      // 保留已被 ban 的 IP，移除一般記錄
      for (const [k, v] of setupRateLimit) {
        if (v.banUntil === 0) setupRateLimit.delete(k);
      }
    }
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
          +ch.max_context_length || 0
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

  // 產生最小有效 WAV 檔案（44 bytes header + 8000 samples silence）
  function createMinimalWav() {
    const sr = 8000, ch = 1, bps = 8, dataSz = sr * ch * (bps / 8);
    const buf = new ArrayBuffer(44 + dataSz);
    const dv = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    w(0, "RIFF"); dv.setUint32(4, 36 + dataSz, true); w(8, "WAVE");
    w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * (bps / 8), true);
    dv.setUint16(32, ch * (bps / 8), true); dv.setUint16(34, bps, true);
    w(36, "data"); dv.setUint32(40, dataSz, true);
    return new Uint8Array(buf);
  }
  // 產生測試用 PNG（64x64 純色，CompressionStream API 壓縮）
  async function createTestPng(width = 64, height = 64) {
    const rowBytes = 1 + width * 3;
    const raw = new Uint8Array(height * rowBytes);
    for (let y = 0; y < height; y++) {
      const rs = y * rowBytes;
      raw[rs] = 0;
      for (let x = 0; x < width; x++) {
        const px = rs + 1 + x * 3;
        raw[px] = 255; raw[px + 1] = 0; raw[px + 2] = 0;
      }
    }
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(raw);
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const compressed = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { compressed.set(c, off); off += c.length; }
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width, false); dv.setUint32(4, height, false);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const pieces = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array(0))];
    const totalLen = pieces.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const p of pieces) { result.set(p, pos); pos += p.length; }
    return result;
  }
  function pngChunk(type, data) {
    const t = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
    const ci = new Uint8Array(4 + data.length);
    ci.set(t, 0); ci.set(data, 4);
    const crc = pngCrc32(ci);
    const c = new Uint8Array(4 + 4 + data.length + 4);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length, false);
    c.set(t, 4); c.set(data, 8);
    dv.setUint32(8 + data.length, crc, false);
    return c;
  }
  function pngCrc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      c ^= data[i];
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // 從回應中偵測上游的 max context 限制
  function detectMaxContextFromResult(json, headers, text) {
    if (json?.max_context) return +json.max_context;
    if (json?.max_input_tokens) return json.max_input_tokens;
    if (json?.max_total_tokens) return json.max_total_tokens;
    if (headers) {
      for (const h of ["X-Max-Tokens", "X-Context-Length", "X-Model-Max-Tokens"]) {
        const v = headers.get(h);
        if (v) { const n = parseInt(v, 10); if (n > 0) return n; }
      }
    }
    // 從錯誤/中繼訊息中擷取（如果上游在正常回應中夾帶這類資訊）
    if (text && typeof text === "string") {
      const m = text.match(/(?:max[-_\s]*(?:context|tokens)|context[-_\s]*length).{0,30}[:：]?\s*(\d{3,6})/i);
      if (m) { const n = parseInt(m[1], 10); if (n > 0) return n; }
    }
    return 0;
  }

  const TOOLS_FIXTURE = [{ type: "function", function: { name: "get_weather", description: "Get weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];

  async function runSingleTest(ch, testType, env, opts = {}) {
    const { relay_url: globalRelayUrl, relay_token: dbRelayToken } = await resolveGlobalConfig(env);
    const relayUrl = ch.relay_url?.trim() || globalRelayUrl?.trim();
    const relayToken = dbRelayToken || env.RELAY_SECRET;
    const baseUrl = ch.base_url || "";
    const headers = { Authorization: "Bearer " + (ch.api_key || ""), "Content-Type": "application/json" };
    const TEST_TIMEOUT_MS = 22000; // Workers free handler 30s 限制，留安全餘裕
    let testUrl, body, useFormData = false, isAudioTest = false;

    // 根據 testType 設定 url、body 與 Content-Type
    switch (testType) {
      case "chat":
        testUrl = baseUrl.replace(/\/+$/, "") + "/chat/completions";
        body = JSON.stringify({ model: ch.model || "test", messages: [{ role: "user", content: "Hi! Reply with just 'Hello'." }], max_tokens: 20, temperature: 0, stream: false });
        break;
      case "stream": {
        testUrl = baseUrl.replace(/\/+$/, "") + "/chat/completions";
        const streamPayload = { model: ch.model || "test", messages: [{ role: "user", content: opts.includeTools ? "What's the weather in Tokyo?" : "Count 1 to 5" }], max_tokens: 100, temperature: 0, stream: true };
        if (opts.includeTools) { streamPayload.tools = TOOLS_FIXTURE; streamPayload.tool_choice = "auto"; }
        body = JSON.stringify(streamPayload);
        break;
      }
      case "vision":
        testUrl = baseUrl.replace(/\/+$/, "") + "/chat/completions";
        body = JSON.stringify({ model: ch.model || "test", messages: [{ role: "user", content: [{ type: "text", text: "What color is this image? Reply with just the color name." }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } }] }], max_tokens: 30, temperature: 0, stream: false });
        break;
      case "tools":
        testUrl = baseUrl.replace(/\/+$/, "") + "/chat/completions";
        body = JSON.stringify({ model: ch.model || "test", messages: [{ role: "user", content: "What's the weather in Tokyo?" }], tools: [{ type: "function", function: { name: "get_weather", description: "Get weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }], tool_choice: "auto", max_tokens: 100, temperature: 0, stream: false });
        break;
      case "tts":
        testUrl = baseUrl.replace(/\/+$/, "") + "/audio/speech";
        body = JSON.stringify({ model: ch.model || "tts-1", input: "Hello world", voice: "alloy" });
        isAudioTest = true;
        break;
      case "stt":
        testUrl = baseUrl.replace(/\/+$/, "") + "/audio/transcriptions";
        delete headers["Content-Type"]; // fetch 自動設 boundary
        {
          const wav = createMinimalWav();
          const fd = new FormData();
          fd.append("file", new Blob([wav], { type: "audio/wav" }), "test.wav");
          fd.append("model", ch.model || "whisper-1");
          body = fd;
          useFormData = true;
        }
        isAudioTest = true;
        break;
      case "image_edit":
        testUrl = baseUrl.replace(/\/+$/, "") + "/images/edits";
        delete headers["Content-Type"];
        {
          let png;
          try { png = await createTestPng(); } catch (e) { png = null; }
          if (!png) return { ok: false, status: 0, ms: 0, capOk: false, diagnosis: "無法產生測試圖片（CompressionStream 不可用）", maxContextDetected: 0 };
          const fd = new FormData();
          fd.append("image", new Blob([png], { type: "image/png" }), "test.png");
          fd.append("prompt", "turn the image red");
          if (ch.model) fd.append("model", ch.model);
          body = fd;
          useFormData = true;
        }
        break;
      case "image_gen":
        testUrl = baseUrl.replace(/\/+$/, "") + "/images/generations";
        body = JSON.stringify({ model: ch.model || "dall-e-3", prompt: "a cat", n: 1, size: "256x256" });
        break;
      case "embed":
        testUrl = baseUrl.replace(/\/+$/, "") + "/embeddings";
        body = JSON.stringify({ model: ch.model || "text-embedding-ada-002", input: "test" });
        break;
      case "moderate":
        testUrl = baseUrl.replace(/\/+$/, "") + "/moderations";
        body = JSON.stringify({ model: ch.model || "text-moderation-latest", input: "test content" });
        break;
      default:
        return { ok: false, status: 0, ms: 0, capOk: false, diagnosis: "未知測試類型", maxContextDetected: 0 };
    }

    const start = Date.now();
    try {
      let res;
      if (relayUrl && relayHealthy) {
        const relayHeaders = { Authorization: headers.Authorization };
        if (!useFormData) relayHeaders["Content-Type"] = "application/json";
        const fetchPromise = fetchViaRelay(relayUrl.replace(/\/+$/, ""), testUrl, "POST",
          relayHeaders, body, AbortSignal.timeout(TEST_TIMEOUT_MS), relayToken);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("relay test timeout")), TEST_TIMEOUT_MS));
        res = await Promise.race([fetchPromise, timeoutPromise]);
      } else {
        const fetchOpts = { method: "POST", headers, body, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) };
        if (useFormData) { delete fetchOpts.headers["Content-Type"]; }
        res = await fetch(testUrl, fetchOpts);
      }
      const ms = Date.now() - start;
      const text = await res.text().catch(() => "");

      // 非 200 → 渠道不支援該能力
      if (res.status !== 200) {
        const textPreview = text ? text.replace(/\s+/g, ' ').slice(0, 200) : "";
        const viaRelay = relayUrl ? ` via=${relayUrl.replace(/https?:\/\//,'').slice(0,30)}` : "";
        return { ok: false, status: res.status, ms, capOk: false, diagnosis: `HTTP ${res.status}${viaRelay}`, _body: textPreview || undefined, maxContextDetected: 0 };
      }

      let json, _reconstructedContent = "", _hasToolCalls = false;
      try {
        json = JSON.parse(text);
        if (json?.choices?.[0]?.message?.content) _reconstructedContent = json.choices[0].message.content;
        if (json?.choices?.[0]?.message?.tool_calls) _hasToolCalls = true;
      } catch {
        json = null;
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t.startsWith("data: ") && !t.includes("[DONE]")) {
            try {
              const chunk = JSON.parse(t.slice(6));
              const choice = chunk?.choices?.[0];
              const piece = choice?.delta?.content || choice?.text || "";
              if (piece) _reconstructedContent += piece;
              if (choice?.delta?.tool_calls) _hasToolCalls = true;
              if (!json && (choice?.delta?.content || choice?.text)) { json = chunk; }
              if (!json) json = chunk;
            } catch { /* 繼續 */ }
          }
        }
      }

      let capOk = false, capMsg = "無法驗證", maxCtx = 0;

      if (testType === "tts") {
        const ct = res.headers.get("Content-Type") || "";
        capOk = ct.includes("audio/") || text.length > 100;
        capMsg = capOk ? "語音生成正常" : "非 audio content-type 或內容過短";
      } else if (testType === "stt") {
        capOk = !!json?.text || text.length > 0;
        capMsg = capOk ? "語音辨識正常" : "無文字回傳";
      } else if (testType === "image_gen") {
        capOk = Array.isArray(json?.data) && json.data.length > 0;
        capMsg = capOk ? "圖片生成正常" : "無 data 陣列";
      } else if (testType === "image_edit") {
        capOk = Array.isArray(json?.data) && json.data.length > 0;
        capMsg = capOk ? "圖片編輯正常" : "無 data 陣列";
      } else if (testType === "embed") {
        capOk = Array.isArray(json?.data) && json.data.length > 0;
        capMsg = capOk ? "嵌入向量正常" : "無 data 陣列";
      } else if (testType === "moderate") {
        capOk = Array.isArray(json?.results);
        capMsg = capOk ? "審核正常" : "無 results 陣列";
        } else {
          // chat / stream / vision / tools
          const choice = json?.choices?.[0];
          if (!choice) {
            const keys = json ? Object.keys(json).join(",") : "no json";
            capOk = false; capMsg = `回應格式異常 (keys:${keys})`;
          } else {
            if (testType === "tools") {
              capOk = !!choice.message?.tool_calls;
              capMsg = capOk ? "工具呼叫正常" : "模型未觸發工具呼叫";
            } else if (testType === "vision") {
              capOk = !!choice.message?.content;
              capMsg = capOk ? "圖片辨識正常" : "模型未回應圖片內容";
            } else if (testType === "stream") {
              capOk = !!(choice.delta?.content || choice.message?.content || choice.text || choice.delta?.tool_calls);
              capMsg = capOk ? "串流正常" : "無 delta/content";
            } else {
              capOk = !!choice.message?.content;
              capMsg = capOk ? "連線正常" : "端點正常（無回覆）";
            }
          }
      }

      // 偵測 max context
      maxCtx = detectMaxContextFromResult(json, res.headers, text);

      return { ok: true, status: 200, ms, capOk, diagnosis: capMsg, maxContextDetected: maxCtx, _reconstructedContent: _reconstructedContent || undefined, _hasToolCalls };
    } catch (e) {
      const ms = Date.now() - start;
      const shortMsg = (e.message || "unknown").split('\n')[0].replace(/\s+/g, ' ').slice(0, 30);
      return { ok: false, status: 0, ms, capOk: false, diagnosis: "連線失敗: " + shortMsg, maxContextDetected: 0 };
    }
  }

  api.post("/channels/:id/test", async (c) => {
    const chId = parseInt(c.req.param("id"), 10);
    const reqBody = await c.req.json().catch(() => ({}));
    const { type: testType = "chat", autoFix = false } = reqBody;
    const fromBody = !!reqBody.base_url;
    let ch;
    if (fromBody) {
      const dbRow = (await c.env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(chId).all()).results || [];
      if (!dbRow || dbRow.length === 0) return c.json({ ok: false, error: "Channel not found", diagnosis: "渠道不存在" }, 404);
      ch = { ...dbRow[0], ...reqBody, id: chId };
    } else {
      const rows = (await c.env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(chId).all()).results || [];
      ch = rows[0];
    }
    if (!ch) return c.json({ ok: false, error: "Channel not found", diagnosis: "渠道不存在" }, 404);

    // 根據渠道類型決定 "all" 要跑哪些測試
    const chType = ch.channel_type || "chat";
    const allTypes = chType === "chat"
      ? ["chat", "stream", "vision", "tools"]
      : [chType];

    const typesToRun = testType === "all" ? allTypes : [testType];
    // 合併 chat+stream+tools：一次 stream 請求驗證三者
    const hasChatStream = typesToRun.includes("chat") && typesToRun.includes("stream");
    const hasTools = typesToRun.includes("tools");
    const skipChat = hasChatStream;
    const skipTools = hasChatStream && hasTools;
    const deduped = typesToRun.filter(t => !((t === "chat" && skipChat) || (t === "tools" && skipTools)));
    const results = {};
    const testResults = await Promise.all(deduped.map(async t => {
      const opts = (t === "stream" && skipTools) ? { includeTools: true } : {};
      const r = await runSingleTest(ch, t, c.env, opts);
      // tools 被拒絕（400）時 fallback 到不帶工具的串流測試
      if (t === "stream" && opts.includeTools && !r.ok && r.status === 400) {
        return runSingleTest(ch, t, c.env, {});
      }
      return r;
    }));
    let anyOk = false;
    for (let i = 0; i < deduped.length; i++) {
      results[deduped[i]] = testResults[i];
      if (testResults[i].ok) anyOk = true;
    }
    // stream 的 reconstructedContent 填回 chat 結果
    if (skipChat && results.stream) {
      const sr = results.stream;
      // API 有回應（content 或 tool_calls）都算 chat 正常
      const chatOk = !!(sr._reconstructedContent || sr._hasToolCalls);
      results.chat = { ok: sr.ok, status: sr.status, ms: sr.ms, capOk: chatOk, diagnosis: chatOk ? "連線正常" : "端點正常（無回覆）", maxContextDetected: sr.maxContextDetected };
      if (chatOk) anyOk = true;
    }
    // stream 的 tool_calls 填回 tools 結果
    if (skipTools && results.stream) {
      const sr = results.stream;
      const toolsOk = !!sr._hasToolCalls;
      results.tools = { ok: sr.ok, status: sr.status, ms: sr.ms, capOk: toolsOk, diagnosis: toolsOk ? "工具呼叫正常" : "模型未觸發工具呼叫", maxContextDetected: sr.maxContextDetected };
      if (toolsOk) anyOk = true;
    }

    // 測試結果不自動寫入 DB，由 UI 讓 user 手動存檔

    const capabilities = {};
    if (results.vision) capabilities.vision = results.vision.capOk;
    if (results.tools) capabilities.tools = results.tools.capOk;

    return c.json({
      ok: anyOk,
      type: testType,
      results,
      capabilities: Object.keys(capabilities).length ? capabilities : undefined,
      diagnosis: typesToRun.map(t => `${t}: ${results[t].diagnosis}`).join("; "),
    });
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
    // 保留嘗試次數最多（最惡意）的 500 筆，清除低計數記錄
    const entries = [...loginState.entries()].sort((a, b) => b[1].count - a[1].count);
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
    if (Date.now() < state.banUntil) return c.json({ error: "嘗試過多，請 15 分鐘後重試" }, 429);
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
      try {
        if (!c.env || !c.env.DB) {
          throw new Error("D1 database 'DB' is not bound. Please check your wrangler.toml or Cloudflare bindings.");
        }
        await initConfig(c.env);
        inited = true;
      } catch (e) {
        console.error("[init]", e.message);
        initLock = null;
        throw e;
      }
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
  console.error("[error]", err.message, err.stack?.slice(0, 500));
  return c.json({
    error: { message: "The server had an error processing your request", type: "server_error", param: null, code: "api_error" },
  }, 500);
});

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
