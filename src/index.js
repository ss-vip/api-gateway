import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import portalHtml from "./dashboard/portal.html";

const UPSTREAM_TIMEOUT_MS = 120_000;
const CHANNEL_COOLDOWN_MS = UPSTREAM_TIMEOUT_MS;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const TOKEN_TTL = 60_000;
const FILTER_TTL = 180_000;
const REFRESH_MS = 60_000;
const D1_BATCH_LIMIT = 99;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_BAN_MS = 15 * 60 * 1000;
const SETUP_MAX_ATTEMPTS = 5;
const SETUP_BAN_MS = 10 * 60 * 1000;
const API_PREFIXES = ["/v1", "/v1beta", "/v2", "/v3", "/v4"];
const STREAM_TYPES = ["both", "stream", "nonstream"];

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = new Uint32Array(30);
  crypto.getRandomValues(rand);
  let t = "sk-";
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
  stream_type TEXT    NOT NULL DEFAULT 'both'
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

const ALL_DDLS = [CHANNELS_DDL, FILTERS_DDL, CONFIG_DDL];
const ALL_TABLES = ["channels", "filters", "config"];

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
  try { await env.DB.prepare(`ALTER TABLE channels ADD COLUMN stream_type TEXT NOT NULL DEFAULT 'both'`).run(); } catch (e) {}
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

async function loadChannels(env) {
  const now = Date.now();
  if (cachedChannels && now - lastLoad < REFRESH_MS) return cachedChannels;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, name, base_url, api_key, weight, stream_type FROM channels WHERE is_enabled = 1 ORDER BY weight DESC"
      ).all();
      cachedChannels = results || [];
    } catch (e) {
      console.error("[channel] load error:", e.message);
      cachedChannels = cachedChannels || [];
    }
    lastLoad = Date.now();
    loadPromise = null;
    return cachedChannels;
  })();
  return loadPromise;
}

function clearChannelCache() {
  cachedChannels = null;
  lastLoad = 0;
}

function selectChannel(channels, exclude = new Set()) {
  const healthy = channels.filter(c => !exclude.has(c.id) && !isDegraded(c.id));
  if (healthy.length === 0) return null;
  const totalWeight = healthy.reduce((s, c) => s + Math.max(c.weight, 1), 0);
  let r = Math.random() * totalWeight;
  for (const c of healthy) {
    r -= Math.max(c.weight, 1);
    if (r <= 0) return c;
  }
  return healthy[healthy.length - 1];
}

function markDegraded(channelId) {
  degradedUntil.set(channelId, Date.now() + CHANNEL_COOLDOWN_MS);
}

function markHealthy(channelId) {
  degradedUntil.delete(channelId);
}

function isDegraded(channelId) {
  const until = degradedUntil.get(channelId);
  if (!until) return false;
  if (Date.now() < until) return true;
  degradedUntil.delete(channelId);
  return false;
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
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) delta.content = RollingFilter.applyStatic(delta.content, filters);
            controller.enqueue(encoder.encode("data: " + JSON.stringify(parsed) + "\n"));
          } catch { controller.enqueue(encoder.encode(line + "\n")); }
        } else { controller.enqueue(encoder.encode(line + "\n")); }
      }
    },
    flush(controller) { if (buf) controller.enqueue(encoder.encode(buf)); },
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

async function tryForward(env, path, method, baseHeaders, body, rid, streamType) {
  const channels = await loadChannels(env);
  if (channels.length === 0) return { error: { message: "No upstream channels available", status: 503 } };
  let eligible = streamType ? channels.filter(c => c.stream_type === "both" || c.stream_type === streamType) : channels;
  if (eligible.length === 0) eligible = channels;
  const matched = API_PREFIXES.find(p => path === p || path.startsWith(p + "/"));
  const suffix = matched ? path.slice(matched.length) : path;
  const attempted = new Set();
  for (let i = 0; i < Math.min(3, eligible.length); i++) {
    const channel = selectChannel(eligible, attempted);
    if (!channel) break;
    attempted.add(channel.id);
    const upstreamPath = suffix;
    const url = channel.base_url.replace(/\/+$/, "") + upstreamPath;
    const headers = new Headers(baseHeaders);
    headers.set("Authorization", `Bearer ${channel.api_key}`);
    try {
      let reqBody = body;
      if (method === "POST" && body && channel.stream_type === "nonstream") {
        try {
          const parsed = JSON.parse(body);
          if (parsed.stream === true) {
            const { stream, ...rest } = parsed;
            reqBody = JSON.stringify(rest);
          }
        } catch (e) {}
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      const res = await fetch(url, { method, headers, body: reqBody, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) { markHealthy(channel.id); return { response: res, channel }; }
      if (res.status >= 500 || res.status === 429) {
        markDegraded(channel.id);
        logStructured("warn", "upstream error, retrying", { channel: channel.name, status: res.status, rid });
        continue;
      }
      return { response: res };
    } catch (err) {
      markDegraded(channel.id);
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
  const result = await tryForward(c.env, c.req.path, "POST", baseHeaders, rawBody, rid, isStream ? "stream" : "nonstream");
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
      return new Response(nonStreamToStream(text, filters), { status: 200, headers: { ...resHeaders, "Content-Type": "text/event-stream" } });
    }
    let sseBody = createIdleTimeoutStream(upstream.body, STREAM_IDLE_TIMEOUT_MS);
    const filters = await loadFilters(c.env);
    if (filters.length > 0) sseBody = sseBody.pipeThrough(createFilterTransform(filters));
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
      for (const ch of p.choices || []) {
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
              await sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: idx, delta: { tool_calls: [{ index: tc.index || 0, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] });
            }
          }
        }
        await sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: idx, delta: {}, finish_reason: finish }] });
      }
      if (p.usage) {
        await sse({ id, object: "chat.completion.chunk", created, model, choices: [], usage: p.usage });
      }
      await w.write(enc.encode("data: [DONE]\n\n"));
    } catch (e) { logStructured("error", "non-stream to stream conversion failed", { error: e.message }); }
    await w.close();
  })();
  return readable;
}

async function handleModels(c) {
  const channels = await loadChannels(c.env);
  if (channels.length === 0) return c.json({ object: "list", data: [] });
  for (const channel of channels) {
    try {
      const url = channel.base_url.replace(/\/+$/, "") + "/models";
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${channel.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return c.json(await res.json());
    } catch (e) {
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
    ? await c.req.raw.clone().text() : undefined;
  let streamType;
  if (rawBody) {
    try { const b = JSON.parse(rawBody); streamType = b?.stream === true ? "stream" : "nonstream"; } catch (e) {}
  }
  const result = await tryForward(c.env, path, c.req.method, baseHeaders, rawBody, rid, streamType);
  if (result.error) {
    return c.json({ error: { message: result.error.message, type: "upstream_error", param: null, code: "upstream_error" } }, result.error.status);
  }
  const { response: upstream } = result;
  const resHeaders = cleanResponseHeaders(upstream.headers);
  resHeaders.set("X-Request-Id", rid);
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
    app.get(p + "/models", handleModels);
    app.all(p + "/*", handleGenericProxy);
  }
}

let resCacheGen = 0;

function clearResCache() { resCacheGen++; }

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
    if (!(await verifyPassword(inputToken, storedHash))) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  api.get("/init", async (c) => {
    const [ch, fl] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    const channels = (ch.results || []).map(ch => ({ ...ch, api_key: maskApiKey(ch.api_key || '') }));
    return c.json({ channels, filters: fl.results || [], config: { token: cf?.client_token || "" } });
  });

  api.post("/batch-channels", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body)) return c.json({ ok: false, error: "Expected array" }, 400);
    const errs = validateChannelData(body);
    if (errs.length > 0) return c.json({ ok: false, error: "Validation failed", details: errs }, 400);
    const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
    const allKeys = {};
    for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
    const cols = "id, name, base_url, api_key, model, weight, is_enabled, stream_type";
    const ph = "?, ?, ?, ?, ?, ?, ?, ?";
    const batch = [c.env.DB.prepare("DELETE FROM channels")];
    for (const ch of body) {
      const apiKey = ch.api_key || (allKeys[ch.id] || "");
      batch.push(
        c.env.DB.prepare(`INSERT INTO channels (${cols}) VALUES (${ph})`).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey, ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0,
          ch.stream_type || "both"
        )
      );
    }
    for (let i = 0; i < batch.length; i += D1_BATCH_LIMIT) {
      const chunk = batch.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length > 0) await retry(() => c.env.DB.batch(chunk));
    }
    clearGatewayCache();
    clearResCache();
    return c.json({ ok: true });
  });

  api.post("/filters", async (c) => {
    const filters = await c.req.json();
    const stmts = [
      c.env.DB.prepare("DELETE FROM filters"),
      ...filters.map((f) =>
        c.env.DB.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0)
      ),
    ];
    for (let i = 0; i < stmts.length; i += D1_BATCH_LIMIT) {
      const chunk = stmts.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length > 0) await retry(() => c.env.DB.batch(chunk));
    }
    clearGatewayCache();
    clearResCache();
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
    clearResCache();
    return c.json({ ok: true });
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
    clearResCache();
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
    clearResCache();
    return c.json({ ok: true, new_token: freshToken });
  });

  api.get("/auth-status", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
      return c.json({ needsSetup: !cf?.admin_password });
    } catch (e) { return c.json({ needsSetup: true }); }
  });

  api.post("/verify-token", async (c) => {
    const { token } = await c.req.json();
    if (!token) return c.json({ valid: false }, 400);
    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ valid: false }, 403);
    return c.json({ valid: await verifyPassword(token, storedHash) });
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
    if (await verifyPassword(password, storedHash)) { loginState.delete(ip); return c.json({ ok: true }); }
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
