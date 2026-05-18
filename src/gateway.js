import { getProvider, detectProvider, SKIP, DONE } from "./lib/providers/index.js";
import {
  parseRetryAfter, record429, recordError, recordSuccess,
  isVisionExcluded, isToolsExcluded, isContextExceeded, requiresMaxTokens, getBlockedParams,
  parseErrorForLearning, learnFromError, extractBlockedParam,
} from "./lib/adaptive.js";
import {
  TOOL_NAME_MAX_LENGTH, FILTER_TEXT_MIN_LENGTH, FILTER_TEXT_MAX_LENGTH,
  BACKOFF_ERROR_THRESHOLD, BACKOFF_429_SECONDS, BACKOFF_MAX_SECONDS,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  CACHE_TTL_RATE_MS, CACHE_TTL_NORMAL_MS,
  STREAM_BUF_MAX_BYTES, MAX_IMAGE_BASE64_BYTES,
  STREAM_MAX_DURATION_MS,
  MAX_SUBREQUESTS, GLOBAL_TIMEOUT_MS,
} from "./lib/constants.js";
import { quickHash } from "./lib/db.js";
import { bufferRate, getBufferedRate } from "./routes/maintenance.js";

function parseModelList(s) {
  if (!s) return null;
  const parts = s.split(",").map(x => x.trim()).filter(Boolean);
  return parts.length > 0 ? new Set(parts) : null;
}
function modelMatches(ch, reqModel) {
  if (ch.model === reqModel || ch.fallback_model === reqModel) return true;
  const a = ch._modelSet || (ch._modelSet = parseModelList(ch.model));
  const b = ch._fallbackSet || (ch._fallbackSet = parseModelList(ch.fallback_model));
  return (a && a.has(reqModel)) || (b && b.has(reqModel));
}

function createSubrequestLimiter() {
  let count = 0;
  return {
    countSubrequest() {
      count++;
      if (count >= MAX_SUBREQUESTS) throw new Error("Subrequest limit: " + count);
    },
    async safeFetch(url, options) { this.countSubrequest(); return fetch(url, options); },
  };
}

async function persistHealth(db, ch) {
  if (!ch || !ch.id) return;
  if (!ch.response_time && !ch.consecutive_errors && !ch.last_429 && !ch.cooldown_until) return;
  try {
    await db.prepare(
      "UPDATE channels SET response_time=?, consecutive_errors=?, last_error_msg=?, last_error_at=?, last_429=?, cooldown_until=?, is_vision=? WHERE id=?"
    ).bind(
      ch.response_time || 0, ch.consecutive_errors || 0,
      ch.last_error_msg || '', ch.last_error_at || 0,
      ch.last_429 || 0, ch.cooldown_until || 0,
      ch.is_vision ? 1 : 0, ch.id
    ).run();
  } catch (e) { console.error("[persist] health:", ch.id, e.message); }
}

const OPENAI_ONLY_PARAMS = new Set([
  "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs",
  "n", "logit_bias", "best_of", "echo", "suffix",
]);

const RESP_CACHE = new Map();
const CACHE_MAX = 200;
const CACHE_TTL_MS = 45_000;
async function cacheKey(body) {
  return quickHash([
    body.model, body.messages, body.stream, body.temperature, body.top_p,
    body.max_tokens, body.tools, body.tool_choice,
  ]);
}
function cacheGet(key) {
  const e = RESP_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { RESP_CACHE.delete(key); return null; }
  RESP_CACHE.delete(key); RESP_CACHE.set(key, e);
  return e.data;
}
function cacheSet(key, data) {
  if (RESP_CACHE.size >= CACHE_MAX) { const k = RESP_CACHE.keys().next().value; if (k) RESP_CACHE.delete(k); }
  RESP_CACHE.set(key, { data, ts: Date.now() });
}

const DAILY_STATS = { date: "", requests: 0, tokens: 0, channels: {} };
function recordUsage(model, ch, tokens) {
  const today = new Date().toISOString().slice(0, 10);
  if (DAILY_STATS.date !== today) { DAILY_STATS.date = today; DAILY_STATS.requests = 0; DAILY_STATS.tokens = 0; DAILY_STATS.channels = {}; }
  DAILY_STATS.requests++;
  DAILY_STATS.tokens += tokens || 0;
  const k = (ch || "?") + "@" + (model || "?");
  if (!DAILY_STATS.channels[k]) DAILY_STATS.channels[k] = { requests: 0, tokens: 0 };
  DAILY_STATS.channels[k].requests++;
  DAILY_STATS.channels[k].tokens += tokens || 0;
}
function getStats() { return { ...DAILY_STATS, channels: { ...DAILY_STATS.channels } }; }

const RT_HISTORY = new Map();
function recordRt(chId, ms) {
  let a = RT_HISTORY.get(chId);
  if (!a) { a = []; RT_HISTORY.set(chId, a); }
  a.push(ms);
  if (a.length > 20) a.shift();
}
function getRt(chId) { return RT_HISTORY.get(chId) || []; }
function getAvgRt(chId) {
  const a = RT_HISTORY.get(chId);
  if (!a || a.length === 0) return 0;
  return Math.round(a.reduce((s, v) => s + v, 0) / a.length);
}

function stripOpenAIOnlyParams(body, baseUrl) {
  const upstream = detectProvider(baseUrl);
  if (upstream === "openai") return;
  for (const param of OPENAI_ONLY_PARAMS) {
    delete body[param];
  }
}

let cache = { data: null, ts: 0 };
let cacheFlight = null;

function safeParseResponse(text, provider) {
  try {
    const json = provider.parseResponse(text);
    if (json && json.error) return json;
    if (!json.choices || !Array.isArray(json.choices)) {
      json.choices = [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }];
    }
    for (const c of json.choices) {
      if (c.message && typeof c.message.content !== "string" && c.message.content !== null) {
        c.message.content = String(c.message.content || "");
      }
    }
    return json;
  } catch (e) {
    return { error: { message: "Response parse failed: " + e.message, type: "server_error" } };
  }
}

function bufferRateCounters(ch) {
  if (ch && ch.id) {
    bufferRate(ch.id, ch.rpm_count || 0, ch.rpm_reset_at || 0, ch.rpd_count || 0, ch.rpd_reset_at || 0);
  }
}

function sanitizeToolName(n) {
  return (n || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, TOOL_NAME_MAX_LENGTH) || "unknown_tool";
}

function normalizeOpenAIMessages(messages) {
  if (!messages || messages.length === 0) return messages;
  const idToNameMap = {};
  const result = [];
  for (const m of messages) {
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) {
          idToNameMap[tc.id] = sanitizeToolName(tc.function.name);
        }
      }
    }
  }
  for (const m of messages) {
    let role = m.role;
    if (role === "developer") role = "system";
    const newMsg = { ...m, role };
    if (newMsg.content === undefined) newMsg.content = null;
    if (newMsg.tool_calls && Array.isArray(newMsg.tool_calls)) {
      newMsg.tool_calls = newMsg.tool_calls.map((tc) =>
        tc.function?.name
          ? { ...tc, function: { ...tc.function, name: sanitizeToolName(tc.function.name) } }
          : tc
      );
    }
    if (role === "tool" || role === "function") {
      newMsg.name = sanitizeToolName(
        m.name || idToNameMap[m.tool_call_id] || m.tool_call_id || "unknown_tool"
      );
    } else {
      delete newMsg.name;
    }
    result.push(newMsg);
  }
  return result;
}

class RollingFilter {
  constructor(filters) {
    this.filters = filters.filter(
      (f) => f.is_enabled && f.text && f.text.length >= FILTER_TEXT_MIN_LENGTH && f.text.length <= FILTER_TEXT_MAX_LENGTH
    );
    this.safeLen = this.filters.reduce((m, f) => Math.max(m, f.text.length - 1), 0);
    this.buffer = "";
    this.truncated = false;
  }
  transform(chunk) {
    if (this.filters.length === 0) return chunk;
    if (this.truncated) return "";
    this.buffer += chunk;
    for (const f of this.filters) {
      if (f.mode === 1) {
        const idx = this.buffer.indexOf(f.text);
        if (idx !== -1) { this.buffer = this.buffer.substring(0, idx); this.truncated = true; break; }
      } else {
        this.buffer = this.buffer.split(f.text).join("");
      }
    }
    if (this.truncated) { const out = this.buffer; this.buffer = ""; return out; }
    const flushLen = Math.max(0, this.buffer.length - this.safeLen);
    const out = this.buffer.slice(0, flushLen);
    this.buffer = this.buffer.slice(flushLen);
    return out;
  }
  flush() {
    if (this.truncated) return "";
    const out = this.buffer; this.buffer = ""; return out;
  }
  static applyStatic(text, filters) {
    if (!text || !filters || filters.length === 0) return text;
    let out = text;
    const enabled = filters.filter((f) => f.is_enabled && f.text && f.text.length >= FILTER_TEXT_MIN_LENGTH);
    for (const f of enabled) {
      if (f.mode === 1) {
        const idx = out.indexOf(f.text);
        if (idx !== -1) out = out.substring(0, idx);
      } else {
        out = out.split(f.text).join("");
      }
    }
    return out;
  }
}

function exponentialCooldown(consecutiveErrors) {
  if (consecutiveErrors <= BACKOFF_ERROR_THRESHOLD) return 0;
  const exponent = Math.min(consecutiveErrors - BACKOFF_ERROR_THRESHOLD, 4);
  return Math.min(BACKOFF_429_SECONDS * Math.pow(2, exponent), BACKOFF_MAX_SECONDS);
}

function selectChannel(channels) {
  const now = Math.floor(Date.now() / 1000);
  const available = channels.filter((c) => {
    if (!c.is_enabled) return false;
    if (c.consecutive_errors >= BACKOFF_ERROR_THRESHOLD &&
        now - (c.last_error_at || 0) <= exponentialCooldown(c.consecutive_errors)) return false;
    if (c.cooldown_until > now) return false;
    if (c.last_429 > 0 && c.last_429 > now) return false;
    const buf = getBufferedRate(c.id);
    const rpmCount = buf ? buf.rpmCount : (c.rpm_count || 0);
    const rpmResetAt = buf ? buf.rpmResetAt : (c.rpm_reset_at || 0);
    const rpdCount = buf ? buf.rpdCount : (c.rpd_count || 0);
    const rpdResetAt = buf ? buf.rpdResetAt : (c.rpd_reset_at || 0);
    if (c.rpm_limit > 0 &&
        now - rpmResetAt < RPM_WINDOW_SECONDS &&
        rpmCount >= c.rpm_limit) return false;
    if (c.rpd_limit > 0 &&
        now - rpdResetAt < RPD_WINDOW_SECONDS &&
        rpdCount >= c.rpd_limit) return false;
    return true;
  });
  if (available.length === 0) return null;

  const withRt = available.filter(c => c.response_time > 0);

  if (withRt.length > 0) {
    let totalW = 0;
    const weights = withRt.map((c) => {
      const base = Math.max(1, c.weight || 1);
      const speedFactor = 1 / (1 + c.response_time / 10000);
      const w = Math.round(base * speedFactor * 10) + 1;
      totalW += w;
      return w;
    });
    let r = Math.random() * totalW;
    for (let i = 0; i < withRt.length; i++) {
      r -= weights[i];
      if (r <= 0) return withRt[i];
    }
    return withRt[withRt.length - 1];
  }

  const pickFrom = available.slice(0, Math.min(3, available.length));
  return pickFrom[Math.floor(Math.random() * pickFrom.length)];
}

function updateRateCounters(cachedCh, nowSec) {
  if (!cachedCh) return;
  if (nowSec - (cachedCh.rpm_reset_at || 0) >= RPM_WINDOW_SECONDS) {
    cachedCh.rpm_count = 1;
    cachedCh.rpm_reset_at = nowSec;
  } else {
    cachedCh.rpm_count = (cachedCh.rpm_count || 0) + 1;
  }
  if (nowSec - (cachedCh.rpd_reset_at || 0) >= RPD_WINDOW_SECONDS) {
    cachedCh.rpd_count = 1;
    cachedCh.rpd_reset_at = nowSec;
  } else {
    cachedCh.rpd_count = (cachedCh.rpd_count || 0) + 1;
  }
  bufferRateCounters(cachedCh);
}

const MAX_ERROR_BODY_BYTES = 8192;
function truncateErrorBody(text) {
  if (!text || typeof text !== "string") return text || "";
  if (text.length <= MAX_ERROR_BODY_BYTES) return text;
  return text.slice(0, MAX_ERROR_BODY_BYTES) + "... [truncated " + (text.length - MAX_ERROR_BODY_BYTES) + " bytes]";
}

let chunkIdCounter = 0;
const mkChunk = (delta, finish_reason = null, model = undefined) =>
  JSON.stringify({
    id: "chat_id-" + (++chunkIdCounter),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });

const SSE_CHUNK_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

const buildChunk = (delta, finishReason, json, usage) => ({
  id: json.id || "chatcmpl-" + (++chunkIdCounter),
  object: "chat.completion.chunk",
  created: json.created || Math.floor(Date.now() / 1000),
  model: json.model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});

async function tier2FullFilter(readable, filters, responseModel, encoder, writer, provider) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const filter = new RollingFilter(filters);
  const thoughtFilter = new RollingFilter(filters);
  let buf = "";
  let lastActivity = Date.now();
  const streamStart = Date.now();
  const streamState = provider.createStreamState ? provider.createStreamState() : null;
  let doneSent = false;
  const send = async (data) => {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    try { await writer.write(encoder.encode("data: " + payload + "\n\n")); } catch (e) {}
  };
  const sendDone = async () => {
    if (doneSent) return;
    doneSent = true;
    await send("[DONE]");
  };
  try {
    while (true) {
      if (doneSent) break;
      if (Date.now() - streamStart > STREAM_MAX_DURATION_MS) {
        await send(mkChunk({ content: "\n\n[Stream duration limit exceeded]" }, "stop", responseModel));
        await sendDone();
        break;
      }
      let result;
      try {
        result = await reader.read();
        if (result.done) { await sendDone(); break; }
      } catch (e) {
        await send(mkChunk({ content: "\n\n[Upstream Connection Lost]" }, "stop", responseModel));
        await sendDone();
        break;
      }
      if (Date.now() - lastActivity > 60_000) {
        await send(mkChunk({ content: "\n\n[Stream idle timeout]" }, "stop", responseModel));
        await sendDone();
        break;
      }
      lastActivity = Date.now();
      buf += decoder.decode(result.value, { stream: true });
      if (buf.length > STREAM_BUF_MAX_BYTES) buf = buf.slice(buf.length - STREAM_BUF_MAX_BYTES);
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const rawLine of lines) {
        const event = provider.processStreamLine(rawLine, streamState);
        if (event === SKIP) continue;
        if (event === DONE) {
          const tail = filter.flush();
          if (tail) await send(mkChunk({ content: tail }, null, responseModel));
          await sendDone();
          break;
        }
        if (event._error) {
          await send(mkChunk({ content: `\n\n[Upstream Error: ${event.message || "Unknown"}]` }, "stop", responseModel));
          await sendDone();
          break;
        }
        if (responseModel) event.model = responseModel;
        const choice = event.choices?.[0];
        if (!choice) { if (event.usage) await send(JSON.stringify({ id: event.id || "chatcmpl-" + (++chunkIdCounter), object: "chat.completion.chunk", created: event.created || Math.floor(Date.now() / 1000), model: event.model, choices: [], usage: event.usage })); continue; }
        const delta = { ...(choice.delta || {}) };
        if (delta.content) {
          delta.content = filter.transform(delta.content);
          if (choice.finish_reason) delta.content += filter.flush();
        }
        if (delta.thought) {
          delta.thought = thoughtFilter.transform(delta.thought);
          if (choice.finish_reason) delta.thought += thoughtFilter.flush();
        }
        if (delta.content || delta.thought || delta.tool_calls || choice.finish_reason || event.usage) {
          await send(buildChunk(delta, choice.finish_reason || null, event, event.usage));
        }
      }
    }
  } finally {
    try { writer.close(); } catch (e) {}
  }
}

function hasImage(messages) {
  if (!messages || !Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (typeof m.content === "string") return false;
    if (Array.isArray(m.content)) return m.content.some((c) => c.type === "image_url");
    return false;
  });
}

function validateImages(messages) {
  if (!messages || !Array.isArray(messages)) return null;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "image_url") {
        const url = c.image_url?.url || "";
        if (url.startsWith("data:")) {
          const commaIdx = url.indexOf(",");
          if (commaIdx === -1) return "Invalid data URI";
          const base64Data = url.slice(commaIdx + 1);
          if (base64Data.length > MAX_IMAGE_BASE64_BYTES) return "Image too large";
        }
      }
    }
  }
  return null;
}

async function loadCache(env) {
  const hasRL = cache.data?.channels?.some((ch) => ch.rpm_limit > 0 || ch.rpd_limit > 0);
  const ttl = hasRL ? CACHE_TTL_RATE_MS : CACHE_TTL_NORMAL_MS;
  if (cache.data && Date.now() - cache.ts < ttl) return cache.data;
  if (!cacheFlight) {
    cacheFlight = (async () => {
      try {
        const [ch, fl, cf] = await Promise.all([
          env.DB.prepare("SELECT * FROM channels WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM filters WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM config WHERE id=1").first(),
        ]);
        cache = {
          data: {
            channels: ch.results || [],
            filters: fl.results || [],
            config: {
              client_token: cf?.client_token || (() => {
                const bytes = new Uint8Array(22);
                crypto.getRandomValues(bytes);
                const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
                let t = "sk-";
                for (let i = 0; i < 30; i++) t += chars[bytes[i] % chars.length];
                return t;
              })(),
              recovery_period: parseInt(cf?.recovery_period) || BACKOFF_429_SECONDS,
            },
          },
          ts: Date.now(),
        };
        return cache.data;
      } catch (e) {
        console.error("[cache] load failed:", e.message);
        if (cache.data) return cache.data;
        throw e;
      }
    })().finally(() => { cacheFlight = null; });
  }
  return cacheFlight;
}

function validateChatBody(body) {
  if (!body || typeof body !== "object") return "Invalid body";
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "Invalid messages";
  return null;
}

const ERROR_CODE_MAP = {
  auth_error: "invalid_api_key",
  invalid_request_error: "invalid_request_error",
  server_error: "api_error",
  rate_limit_error: "rate_limit_exceeded",
  upstream_error: "upstream_error",
};

function errResponse(c, message, type, status) {
  return c.json({ error: { message, type, code: ERROR_CODE_MAP[type] || type } }, status);
}

async function handleChatRequest(c) {
  const limiter = createSubrequestLimiter();
  try {
    let data;
    try { data = await loadCache(c.env); } catch (e) {
      if (!cache.data) return errResponse(c, "DB Error", "server_error", 500);
      data = cache.data;
    }
    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) return errResponse(c, "Unauthorized", "auth_error", 401);
    let body;
    try { body = await c.req.json(); } catch (e) { return errResponse(c, "Invalid JSON", "invalid_request_error", 400); }
    const vErr = validateChatBody(body);
    if (vErr) return errResponse(c, vErr, "invalid_request_error", 400);
    const imgErr = validateImages(body.messages);
    if (imgErr) return errResponse(c, imgErr, "invalid_request_error", 400);
    const originalModel = body.model;
    const isStream = !!body.stream;
    const hasVisionContent = hasImage(body.messages);
    let pool = data.channels.filter((ch) => ch.is_enabled && (!hasVisionContent || ch.is_vision));
    if (pool.length === 0) return errResponse(c, "No channels", "server_error", 503);
    pool = pool.filter((ch) => !isVisionExcluded(ch.id) && !isContextExceeded(ch.id) && !(body.tools && body.tools.length > 0 && (isToolsExcluded(ch.id) || ch.support_tools === 0)));
    if (body.max_tokens) pool = pool.filter((ch) => ch.max_tokens <= 0 || body.max_tokens <= ch.max_tokens);
    if (!body.max_tokens) pool = pool.filter((ch) => !requiresMaxTokens(ch.id));
    if (pool.length === 0) return errResponse(c, "No filtered channels", "server_error", 503);
    pool.sort((a, b) => {
      const ma = modelMatches(a, originalModel) ? 1 : 0;
      const mb = modelMatches(b, originalModel) ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return (a.response_time || 999999) - (b.response_time || 999999);
    });
    const requestDeadline = Date.now() + GLOBAL_TIMEOUT_MS;
    if (isStream) {
      const { readable: out, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      w.write(enc.encode("data: " + mkChunk({ role: "assistant", content: "" }) + "\n\n")).catch(() => {});
      const keepalive = setInterval(() => { try { w.write(enc.encode(": keepalive\n\n")); } catch { clearInterval(keepalive); } }, 8000);
      c.executionCtx.waitUntil((async () => {
        try {
          let ok = false;
          while (pool.length > 0 && !ok && Date.now() <= requestDeadline) {
            const ch = selectChannel(pool);
            if (!ch) break;
            const providerName = ch.provider || detectProvider(ch.base_url);
            const provider = getProvider(providerName);
            const effectiveModel = ch._fallbackModel || (modelMatches(ch, originalModel) ? originalModel : ch.model);
            const url = ch.absolute_url ? ch.base_url.replace(/\/+$/, "") + "/" : provider.buildUrl(ch.base_url, effectiveModel, true);
            if (!url) { pool = pool.filter(p => p.id !== ch.id); continue; }
            let reqBody = { ...body, model: effectiveModel, messages: normalizeOpenAIMessages(body.messages) };
            stripOpenAIOnlyParams(reqBody, ch.base_url);
            const blocked = getBlockedParams(ch.id);
            if (blocked && blocked.size > 0) { for (const param of blocked) { delete reqBody[param]; } }
            let channelHeaders = {};
            if (ch.headers && typeof ch.headers === "object") channelHeaders = { ...ch.headers };
            else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch (e) { console.warn("[gw] headers parse:", e.message); }
            if (ch.provider_options && typeof ch.provider_options === "object") Object.assign(reqBody, ch.provider_options);
            else if (ch.provider_options && typeof ch.provider_options === "string") try { Object.assign(reqBody, JSON.parse(ch.provider_options)); } catch (e) { console.warn("[gw] provider_options parse:", e.message); }
            const { body: pBody, headers: pHeaders } = provider.prepareRequest(reqBody, ch);
            const remainingMs = requestDeadline - Date.now();
            const historicalTimeout = ch.response_time > 0
              ? Math.max(5000, Math.min(20000, ch.response_time * 3))
              : 15000;
            const chTimeout = remainingMs < 15000
              ? Math.max(3000, Math.min(historicalTimeout, Math.floor(remainingMs * 0.6)))
              : historicalTimeout;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), chTimeout);
            try {
              const startTime = Date.now();
              const requestHeaders = {
                "Content-Type": "application/json", "User-Agent": "api-gateway/1.0", "Accept": "application/json",
                Authorization: "Bearer " + ch.api_key, ...pHeaders, ...channelHeaders,
              };
              if (requestHeaders.Authorization === "") delete requestHeaders.Authorization;
              if (requestHeaders["x-api-key"] === "") delete requestHeaders["x-api-key"];
              const res = await limiter.safeFetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(pBody), signal: controller.signal });
              const responseTime = Date.now() - startTime;
              clearTimeout(timeoutId);
              if (!res.ok) {
                const errBody = await res.text().catch(() => "");
                const errText = errBody || ("HTTP " + res.status);
                pool = pool.filter(p => p.id !== ch.id);
                if (res.status === 429) {
                  record429(ch.id, parseRetryAfter(res));
                  ch.last_429 = Math.floor(Date.now() / 1000) + (data.config.recovery_period || 300);
                  ch.last_error_msg = JSON.stringify({ message: "Rate limited (429) — recovery period: " + (data.config.recovery_period || 300) + "s", url, request: pBody, response: errBody });
                  ch.last_error_at = Math.floor(Date.now() / 1000);
                  bufferRateCounters(ch);
                } else {
                  recordError(ch.id);
                  const errPattern = parseErrorForLearning(errText, res.status);
                  if (errPattern) {
                    learnFromError(ch.id, errPattern, errPattern === "unknownParam" ? extractBlockedParam(errText) : null);
                    if (errPattern === "noVision" && ch.is_vision) { ch.is_vision = 0; bufferRateCounters(ch); }
                    if (errPattern === "noTools" && ch.support_tools !== 0) { ch.support_tools = 0; bufferRateCounters(ch); }
                  }
                  ch.consecutive_errors = (ch.consecutive_errors || 0) + 1; ch.last_error_at = Math.floor(Date.now() / 1000);
                  ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(errText), url, request: pBody, response: truncateErrorBody(errBody) });
                  ch.response_time = responseTime;
                  if (!ch._fallbackModel && ch.model !== effectiveModel) {
                    ch._fallbackModel = ch.model;
                    continue;
                  }
                }
                continue;
              }
              ok = true;
              updateRateCounters(ch, Math.floor(Date.now() / 1000)); recordSuccess(ch.id);
              ch.consecutive_errors = 0; ch.last_error_msg = ""; ch.last_error_at = 0; ch.response_time = responseTime;
              recordRt(ch.id, responseTime);
              c.executionCtx.waitUntil(persistHealth(c.env.DB, ch));
              clearInterval(keepalive);
              await tier2FullFilter(res.body, data.filters || [], originalModel, enc, w, provider);
              recordUsage(originalModel || ch.model, ch.name, 0);
            } catch (e) {
              clearTimeout(timeoutId);
              recordError(ch.id); ch.consecutive_errors = (ch.consecutive_errors || 0) + 1; ch.last_error_at = Math.floor(Date.now() / 1000);
              ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(e.message || "Request timeout"), url, request: pBody, response: "" });
              ch.response_time = responseTime || 0;
              if (e.name === 'AbortError') {
                ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(60 * Math.pow(2, ch.consecutive_errors), 600);
                c.executionCtx.waitUntil(persistHealth(c.env.DB, ch));
              }
              if (!ch._fallbackModel && ch.model !== effectiveModel) {
                ch._fallbackModel = ch.model;
              } else {
                pool = pool.filter(p => p.id !== ch.id);
              }
            }
          }
          if (!ok) {
            const bye = { id: "chatcmpl-" + (++chunkIdCounter), object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: originalModel || "unknown", choices: [{ index: 0, delta: { content: "\n\nService temporarily unavailable, please try again later." }, finish_reason: "stop" }] };
            try { await w.write(enc.encode("data: " + JSON.stringify(bye) + "\n\ndata: [DONE]\n\n")); } catch {}
          }
        } catch (e) { console.error("[stream] retry error:", e.message); }
        clearInterval(keepalive);
        try { await w.close(); } catch {}
      })());
      return new Response(out, { headers: SSE_CHUNK_HEADERS });
    }
    if (!isStream) {
      const ck = await cacheKey(body);
      const cached = cacheGet(ck);
      if (cached) {
        try { return c.json(JSON.parse(cached)); } catch (e) {}
      }
    }
    while (pool.length > 0) {
      if (Date.now() > requestDeadline) return errResponse(c, "Request deadline exceeded", "server_error", 504);
      const ch = selectChannel(pool);
      if (!ch) return errResponse(c, "Rate limited or cooldown", "rate_limit_error", 429);
      const providerName = ch.provider || detectProvider(ch.base_url);
      const provider = getProvider(providerName);
      const effectiveModel = modelMatches(ch, originalModel) ? originalModel : ch.model;
      const url = ch.absolute_url ? ch.base_url.replace(/\/+$/, "") + "/" : provider.buildUrl(ch.base_url, effectiveModel, false);
      if (!url) { pool = pool.filter(p => p.id !== ch.id); continue; }
      let reqBody = { ...body, model: effectiveModel, messages: normalizeOpenAIMessages(body.messages) };
      stripOpenAIOnlyParams(reqBody, ch.base_url);
      const blocked = getBlockedParams(ch.id);
      if (blocked && blocked.size > 0) { for (const param of blocked) { delete reqBody[param]; } }
      let channelHeaders = {};
      if (ch.headers && typeof ch.headers === "object") channelHeaders = { ...ch.headers };
      else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch (e) { console.warn("[gw] headers parse:", e.message); }
      if (ch.provider_options && typeof ch.provider_options === "object") Object.assign(reqBody, ch.provider_options);
      else if (ch.provider_options && typeof ch.provider_options === "string") try { Object.assign(reqBody, JSON.parse(ch.provider_options)); } catch (e) { console.warn("[gw] provider_options parse:", e.message); }
      const { body: pBody, headers: pHeaders } = provider.prepareRequest(reqBody, ch);
      const remainingMs = requestDeadline - Date.now();
      const historicalTimeout = ch.response_time > 0
        ? Math.max(5000, Math.min(20000, ch.response_time * 3))
        : 15000;
      const chTimeout = remainingMs < 15000
        ? Math.max(3000, Math.min(historicalTimeout, Math.floor(remainingMs * 0.6)))
        : historicalTimeout;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), chTimeout);
      let responseTime = 0;
      try {
        const startTime = Date.now();
        const requestHeaders = {
          "Content-Type": "application/json", "User-Agent": "api-gateway/1.0", "Accept": "application/json",
          Authorization: "Bearer " + ch.api_key, ...pHeaders, ...channelHeaders,
        };
        if (requestHeaders.Authorization === "") delete requestHeaders.Authorization;
        if (requestHeaders["x-api-key"] === "") delete requestHeaders["x-api-key"];
        const res = await limiter.safeFetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(pBody), signal: controller.signal });
        responseTime = Date.now() - startTime;
        clearTimeout(timeoutId);
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          const errText = errBody || ("HTTP " + res.status);
          if (res.status === 429) {
            record429(ch.id, parseRetryAfter(res)); ch.last_429 = Math.floor(Date.now()/1000) + (data.config.recovery_period||300);
            ch.last_error_msg = JSON.stringify({ message: "Rate limited (429) — recovery period: " + (data.config.recovery_period || 300) + "s", url, request: pBody, response: errBody });
            ch.last_error_at = Math.floor(Date.now()/1000);
            bufferRateCounters(ch); pool = pool.filter(p=>p.id!==ch.id); continue;
          }
          recordError(ch.id);
          const errPattern = parseErrorForLearning(errText, res.status);
          if (errPattern) {
            learnFromError(ch.id, errPattern, errPattern === "unknownParam" ? extractBlockedParam(errText) : null);
            if (errPattern === "noVision" && ch.is_vision) { ch.is_vision = 0; bufferRateCounters(ch); }
            if (errPattern === "noTools" && ch.support_tools !== 0) { ch.support_tools = 0; bufferRateCounters(ch); }
          }
          ch.consecutive_errors = (ch.consecutive_errors||0)+1; ch.last_error_at = Math.floor(Date.now()/1000);
          ch.last_error_msg = JSON.stringify({message:truncateErrorBody(errText),url,request:pBody,response:truncateErrorBody(errBody)});
          ch.response_time = responseTime; pool = pool.filter(p=>p.id!==ch.id); continue;
        }
        updateRateCounters(ch, Math.floor(Date.now()/1000)); recordSuccess(ch.id);
        ch.consecutive_errors = 0; ch.last_error_msg = ""; ch.last_error_at = 0; ch.response_time = responseTime;
        c.executionCtx.waitUntil(persistHealth(c.env.DB, ch));
        const resText = await res.text();
        const MAX_RESP_BYTES = 4 * 1024 * 1024;
        if (resText.length > MAX_RESP_BYTES) {
          return errResponse(c, "Upstream response too large (" + resText.length + " bytes)", "server_error", 502);
        }
        const json = safeParseResponse(resText, provider);
        if (json.error) return errResponse(c, json.error.message, "upstream_error", 502);
        if (originalModel) json.model = originalModel;
        if (json.choices?.[0]?.message?.content && data.filters?.length > 0) {
          json.choices[0].message.content = RollingFilter.applyStatic(json.choices[0].message.content, data.filters);
        }
        cacheSet(await cacheKey(body), resText);
        recordUsage(originalModel || ch.model, ch.name, json.usage?.total_tokens || 0);
        recordRt(ch.id, responseTime);
        return c.json(json);
      } catch (e) {
        clearTimeout(timeoutId); recordError(ch.id);
        ch.consecutive_errors = (ch.consecutive_errors||0)+1; ch.last_error_at = Math.floor(Date.now()/1000);
        ch.last_error_msg = JSON.stringify({message:truncateErrorBody(e.message||"Request timeout or network error"),url,request:pBody,response:""});
        ch.response_time = responseTime||0;
        if (e.name === 'AbortError') {
          ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(60 * Math.pow(2, ch.consecutive_errors), 600);
        }
        if (!ch._fallbackModel && ch.model !== effectiveModel) {
          ch._fallbackModel = ch.model;
        } else {
          pool = pool.filter(p=>p.id!==ch.id);
        }
      }
    }
    return errResponse(c, "All upstream channels exhausted or failed", "server_error", 503);
  } catch (e) {
    console.error("[gateway] unhandled:", e.message);
    return errResponse(c, "Internal Error", "server_error", 500);
  }
}

async function handleEmbeddings(c) {
  const limiter = createSubrequestLimiter();
  try {
    const data = await loadCache(c.env);
    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Unauthorized", "auth_error", 401);
    }
    let body;
    try { body = await c.req.json(); } catch (e) {
      return errResponse(c, "Invalid JSON", "invalid_request_error", 400);
    }
    if (!body.model || !body.input) {
      return errResponse(c, "model and input required", "invalid_request_error", 400);
    }
    const pool = data.channels.filter((ch) => {
      if (!ch.is_enabled) return false;
      const pn = ch.provider || detectProvider(ch.base_url);
      return pn === "openai";
    });
    if (pool.length === 0) return errResponse(c, "No embeddings-capable channels", "server_error", 503);
    const ch = selectChannel(pool);
    if (!ch) return errResponse(c, "Rate limited", "rate_limit_error", 429);
    const providerName = ch.provider || detectProvider(ch.base_url);
    const provider = getProvider(providerName);
    let base = (ch.base_url || "").trim().replace(/\/+$/, "");
    if (ch.absolute_url) {
      base += "/";
    } else if (!base.endsWith("/embeddings")) {
      const hasChat = base.includes("/chat/completions");
      if (hasChat) base = base.replace("/chat/completions", "/embeddings");
      else if (/\/v\d+$/.test(base)) base = `${base}/embeddings`;
      else base = `${base}/v1/embeddings`;
    }
    const effectiveModel = ch.model || body.model;
    const reqBody = { ...body, model: effectiveModel };
    if (ch.provider_options && typeof ch.provider_options === "object") {
      Object.assign(reqBody, ch.provider_options);
    } else if (ch.provider_options && typeof ch.provider_options === "string") {
      try { Object.assign(reqBody, JSON.parse(ch.provider_options)); } catch (e) {}
    }
    let channelHeaders = {};
    if (ch.headers && typeof ch.headers === "object") {
      channelHeaders = { ...ch.headers };
    } else if (ch.headers && typeof ch.headers === "string") {
      try { channelHeaders = JSON.parse(ch.headers); } catch (e) {}
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SECONDS * 1000);
    try {
      const requestHeaders = {
        "Content-Type": "application/json",
        "User-Agent": "api-gateway/1.0",
        "Accept": "application/json",
        Authorization: "Bearer " + ch.api_key,
        ...channelHeaders,
      };
      if (requestHeaders.Authorization === "") delete requestHeaders.Authorization;
      const res = await limiter.safeFetch(base, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        recordError(ch.id);
        ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
        ch.last_error_at = Math.floor(Date.now() / 1000);
        ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(errText), url: base });
        return errResponse(c, "Upstream error: " + (errText || res.status), "upstream_error", res.status);
      }
      updateRateCounters(ch, Math.floor(Date.now() / 1000));
      recordSuccess(ch.id);
      ch.consecutive_errors = 0;
      ch.last_error_msg = "";
      const resText = await res.text();
      return c.json(JSON.parse(resText));
    } catch (e) {
      clearTimeout(timeoutId);
      recordError(ch.id);
      ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
      ch.last_error_at = Math.floor(Date.now() / 1000);
      ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(e.message || "Request timeout"), url: base });
      return errResponse(c, "Request failed: " + e.message, "upstream_error", 502);
    }
  } catch (e) {
    console.error("[embeddings] unhandled:", e.message);
    return errResponse(c, "Internal Error", "server_error", 500);
  }
}

export function clearCache() {
  cache.data = null;
  cache.ts = 0;
  console.log("[gateway] cache cleared");
}
export { getStats, getRt, getAvgRt };

async function handleImageGeneration(c) {
  const limiter = createSubrequestLimiter();
  try {
    const data = await loadCache(c.env);
    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token)
      return errResponse(c, "Unauthorized", "auth_error", 401);
    let body;
    try { body = await c.req.json(); } catch (e) {
      return errResponse(c, "Invalid JSON", "invalid_request_error", 400);
    }
    const pool = data.channels.filter((ch) => {
      if (!ch.is_enabled) return false;
      const pn = ch.provider || detectProvider(ch.base_url);
      return pn === "openai";
    });
    if (pool.length === 0) return errResponse(c, "No image-capable channels", "server_error", 503);
    const ch = selectChannel(pool);
    if (!ch) return errResponse(c, "Rate limited", "rate_limit_error", 429);
    const providerName = ch.provider || detectProvider(ch.base_url);
    const provider = getProvider(providerName);
    let base = (ch.base_url || "").trim().replace(/\/+$/, "");
    if (ch.absolute_url) {
      base += "/";
    } else if (base.endsWith("/chat/completions")) base = base.replace("/chat/completions", "/images/generations");
    else if (base.endsWith("/v1")) base = `${base}/images/generations`;
    else base = `${base}/v1/images/generations`;
    let channelHeaders = {};
    if (ch.headers && typeof ch.headers === "object") channelHeaders = { ...ch.headers };
    else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch {}
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SECONDS * 1000);
    try {
      const requestHeaders = {
        "Content-Type": "application/json", "User-Agent": "api-gateway/1.0",
        Authorization: "Bearer " + ch.api_key, ...channelHeaders,
      };
      if (requestHeaders.Authorization === "") delete requestHeaders.Authorization;
      const res = await limiter.safeFetch(base, {
        method: "POST", headers: requestHeaders, body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        recordError(ch.id);
        ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
        ch.last_error_at = Math.floor(Date.now() / 1000);
        ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(errText), url: base });
        return errResponse(c, "Upstream error: " + (errText || res.status), "upstream_error", res.status);
      }
      updateRateCounters(ch, Math.floor(Date.now() / 1000));
      recordSuccess(ch.id);
      ch.consecutive_errors = 0; ch.last_error_msg = "";
      return c.json(await res.json());
    } catch (e) {
      clearTimeout(timeoutId);
      recordError(ch.id);
      ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
      ch.last_error_at = Math.floor(Date.now() / 1000);
      ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(e.message || "Request timeout"), url: base });
      return errResponse(c, "Request failed: " + e.message, "upstream_error", 502);
    }
  } catch (e) {
    console.error("[image] unhandled:", e.message);
    return errResponse(c, "Internal Error", "server_error", 500);
  }
}

export default function registerGateway(app) {
  const modelsHandler = async (c) => {
    try {
      const data = await loadCache(c.env);
      const enabled = (data.channels || []).filter((ch) => ch.is_enabled);
      const models = enabled.map((ch) => ({
        id: ch.model || "unknown", object: "model", created: 1735689600, owned_by: ch.name || "api-gateway",
        capabilities: {
          vision: !!ch.is_vision,
          tools: ch.support_tools !== 0,
          embeddings: (ch.provider || detectProvider(ch.base_url)) === "openai",
        },
      }));
      const fallbacks = enabled.filter((ch) => ch.fallback_model)
        .map((ch) => ({ id: ch.fallback_model, object: "model", created: 1735689600, owned_by: ch.name || "api-gateway",
          capabilities: { vision: false, tools: true, embeddings: false },
        }));
      return c.json({ object: "list", data: [...models, ...fallbacks] });
    } catch (e) {
      return c.json({ object: "list", data: [] });
    }
  };
  app.get("/models", modelsHandler);
  app.get("/v1/models", modelsHandler);
  app.post("/chat/completions", async (c) => handleChatRequest(c));
  app.post("/v1/chat/completions", async (c) => handleChatRequest(c));
  app.post("/embeddings", async (c) => handleEmbeddings(c));
  app.post("/v1/embeddings", async (c) => handleEmbeddings(c));
  app.post("/images/generations", async (c) => handleImageGeneration(c));
  app.post("/v1/images/generations", async (c) => handleImageGeneration(c));
}
