import { getProvider, detectProvider, SKIP, DONE } from "./lib/providers/index.js";
import {
  parseRetryAfter, record429, recordError, recordSuccess,
  isVisionExcluded, isToolsExcluded, getBlockedParams,
  parseErrorForLearning, learnFromError, extractBlockedParam,
} from "./lib/adaptive.js";
import {
  TOOL_NAME_MAX_LENGTH, FILTER_TEXT_MIN_LENGTH, FILTER_TEXT_MAX_LENGTH,
  BACKOFF_ERROR_THRESHOLD, BACKOFF_429_SECONDS, BACKOFF_MAX_SECONDS,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  CACHE_TTL_RATE_MS, CACHE_TTL_NORMAL_MS,
  RATE_PERSIST_THRESHOLD, STREAM_IDLE_TIMEOUT_MS,
  D1_BATCH_MAX, STREAM_BUF_MAX_BYTES, MAX_IMAGE_BASE64_BYTES,
  STREAM_MAX_DURATION_MS, HEALTH_PERSIST_INTERVAL_MS,
} from "./lib/constants.js";

let cache = { data: null, ts: 0 };
let cacheFlight = null;

let dirtyChannels = new Set();
let lastDirtyFlush = 0;
let healthDirtyChannels = new Set();
let lastHealthFlush = 0;

function markDirty(chId) {
  if (chId != null) dirtyChannels.add(chId);
}

function shouldPersistCounter(ch, nowSec) {
  if (ch.rpm_limit > 0) {
    const ratio = (ch.rpm_count || 0) / ch.rpm_limit;
    const windowEnd = (ch.rpm_reset_at || 0) + RPM_WINDOW_SECONDS;
    if (ratio >= RATE_PERSIST_THRESHOLD || windowEnd - nowSec < 10) return true;
  }
  if (ch.rpd_limit > 0) {
    const ratio = (ch.rpd_count || 0) / ch.rpd_limit;
    const windowEnd = (ch.rpd_reset_at || 0) + RPD_WINDOW_SECONDS;
    if (ratio >= RATE_PERSIST_THRESHOLD || windowEnd - nowSec < 60) return true;
  }
  return false;
}

async function flushDirtyRateCounters(env) {
  if (dirtyChannels.size === 0 || !cache.data?.channels) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const toPersist = [];
  for (const ch of cache.data.channels) {
    if (dirtyChannels.has(ch.id) && shouldPersistCounter(ch, nowSec)) {
      toPersist.push(ch);
    }
  }
  dirtyChannels.clear();
  if (toPersist.length === 0) return;
  const updates = toPersist.map((ch) =>
    env.DB.prepare(
      "UPDATE channels SET rpm_count=?, rpm_reset_at=?, rpd_count=?, rpd_reset_at=? WHERE id=?"
    ).bind(
      ch.rpm_count || 0, ch.rpm_reset_at || nowSec,
      ch.rpd_count || 0, ch.rpd_reset_at || nowSec, ch.id
    )
  );
  await safeBatch(env.DB, updates).catch((e) =>
    console.error("[rate] flush failed:", e.message, "count:", updates.length)
  );
  lastDirtyFlush = Date.now();
}

async function flushDirtyHealth(env) {
  if (healthDirtyChannels.size === 0 || !cache.data?.channels) return;
  const now = Date.now();
  if (now - lastHealthFlush < HEALTH_PERSIST_INTERVAL_MS) return;
  const toPersist = [];
  for (const ch of cache.data.channels) {
    if (healthDirtyChannels.has(ch.id)) toPersist.push(ch);
  }
  healthDirtyChannels.clear();
  lastHealthFlush = now;
  if (toPersist.length === 0) return;
  const updates = toPersist.map((ch) =>
    env.DB.prepare(
      "UPDATE channels SET consecutive_errors=?, last_error_msg=?, last_error_at=?, response_time=?, last_429=? WHERE id=?"
    ).bind(
      ch.consecutive_errors || 0, ch.last_error_msg || "",
      ch.last_error_at || 0, ch.response_time || 0, ch.last_429 || 0, ch.id
    )
  );
  await safeBatch(env.DB, updates).catch((e) =>
    console.error("[health] flush failed:", e.message, "count:", updates.length)
  );
}

async function safeBatch(db, statements) {
  if (statements.length === 0) return;
  for (let i = 0; i < statements.length; i += D1_BATCH_MAX) {
    await db.batch(statements.slice(i, i + D1_BATCH_MAX));
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
    if (c.last_429 > now) return false;
    if (c.rpm_limit > 0 &&
        now - (c.rpm_reset_at || 0) < RPM_WINDOW_SECONDS &&
        (c.rpm_count || 0) >= c.rpm_limit) return false;
    if (c.rpd_limit > 0 &&
        now - (c.rpd_reset_at || 0) < RPD_WINDOW_SECONDS &&
        (c.rpd_count || 0) >= c.rpd_limit) return false;
    return true;
  });
  if (available.length === 0) return null;
  let totalW = 0;
  for (const c of available) totalW += Math.max(1, c.weight || 1);
  let r = Math.random() * totalW;
  for (const c of available) {
    r -= Math.max(1, c.weight || 1);
    if (r <= 0) return c;
  }
  return available[0];
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
  markDirty(cachedCh.id);
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

async function tier0Passthrough(readable, encoder, writer) {
  const initialChunk = `data: ${mkChunk({ content: "" })}\n\n`;
  const doneChunk = encoder.encode("data: [DONE]\n\n");
  try {
    await writer.write(encoder.encode(initialChunk));
    const reader = readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { try { await writer.write(doneChunk); } catch {} break; }
      await writer.write(value);
    }
  } catch (e) {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ _error: true, message: "Upstream stream error" })}\n\n`));
    } catch (e2) {}
  } finally {
    try { writer.close(); } catch (e) {}
  }
}

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
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > STREAM_IDLE_TIMEOUT_MS) {
      reader.cancel("Stream idle timeout").catch(() => {});
    }
  }, 5000);
  let doneSent = false;
  const send = async (data) => {
    try { await writer.write(encoder.encode("data: " + data + "\n\n")); } catch (e) {}
  };
  const sendDone = async () => {
    if (doneSent) return;
    doneSent = true;
    await send("[DONE]");
  };
  try {
    await send(mkChunk({ content: "" }, null, responseModel));
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
        if (!choice) { if (event.usage) await send(buildChunk({}, "stop", event, event.usage)); continue; }
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
    clearInterval(idleTimer);
    try { writer.close(); } catch (e) {}
  }
}

function transformStream(readable, filters, responseModel, provider) {
  const { readable: out, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const hasFilters = filters && filters.length > 0;
  const needsConversion = provider && provider.name !== "openai";
  const closeWriter = () => { try { writer.close(); } catch (e) {} };
  try {
    if (!hasFilters && !responseModel && !needsConversion) {
      tier0Passthrough(readable, encoder, writer).catch((e) => { console.error("[stream] tier0:", e.message); closeWriter(); });
    } else {
      tier2FullFilter(readable, filters || [], responseModel, encoder, writer, provider).catch((e) => { console.error("[stream] tier2:", e.message); closeWriter(); });
    }
  } catch (e) {
    console.error("[stream] setup error:", e.message);
    closeWriter();
  }
  return out;
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

let rateLimitCache = { data: {}, ts: 0 };
async function loadCache(env) {
  const hasRL = cache.data?.channels?.some((ch) => ch.rpm_limit > 0 || ch.rpd_limit > 0);
  const ttl = hasRL ? CACHE_TTL_RATE_MS : CACHE_TTL_NORMAL_MS;
  if (cache.data && Date.now() - cache.ts < ttl) return cache.data;
  if (!cacheFlight) {
    cacheFlight = (async () => {
      if (dirtyChannels.size > 0) await flushDirtyRateCounters(env).catch(() => {});
      if (healthDirtyChannels.size > 0) await flushDirtyHealth(env).catch(() => {});
      try {
        const [ch, fl, cf] = await Promise.all([
          env.DB.prepare("SELECT * FROM channels WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM filters WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM config WHERE id=1").first(),
        ]);
        const nowSec = Math.floor(Date.now() / 1000);
        const channels = ch.results || [];
        for (const c of channels) {
          const saved = rateLimitCache.data[c.id];
          if (saved) {
            if (nowSec - saved.rpm_reset_at < RPM_WINDOW_SECONDS) {
              c.rpm_count = saved.rpm_count; c.rpm_reset_at = saved.rpm_reset_at;
            }
            if (nowSec - saved.rpd_reset_at < RPD_WINDOW_SECONDS) {
              c.rpd_count = saved.rpd_count; c.rpd_reset_at = saved.rpd_reset_at;
            }
          }
        }
        cache = {
          data: {
            channels,
            filters: fl.results || [],
            config: {
              client_token: cf?.client_token || (() => "sk-" + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14))(),
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

function errResponse(c, message, type, status) {
  return c.json({ error: { message, type } }, status);
}

async function handleChatRequest(c) {
  try {
    let data;
    try { data = await loadCache(c.env); } catch (e) {
      if (!cache.data) return errResponse(c, "DB Error", "server_error", 500);
      data = cache.data;
    }
    const token = (c.req.header("Authorization") || "").replace("Bearer ", "");
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
    pool = pool.filter((ch) => !isVisionExcluded(ch.id) && !(body.tools && body.tools.length > 0 && (isToolsExcluded(ch.id) || ch.support_tools === 0)));
    if (body.max_tokens) pool = pool.filter((ch) => ch.max_tokens <= 0 || body.max_tokens <= ch.max_tokens);
    if (pool.length === 0) return errResponse(c, "No filtered channels", "server_error", 503);
    pool.sort((a, b) => ((b.model === originalModel || b.fallback_model === originalModel) ? 1 : 0) - ((a.model === originalModel || a.fallback_model === originalModel) ? 1 : 0));
    const requestDeadline = Date.now() + REQUEST_TIMEOUT_SECONDS * 3000;
    if (isStream) {
      const { readable: out, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      const keepalive = setInterval(() => { try { w.write(enc.encode("data: [KEEPALIVE]\n\n")); } catch { clearInterval(keepalive); } }, 8000);
      setImmediate(async () => {
        try {
          let ok = false;
          while (pool.length > 0 && !ok && Date.now() <= requestDeadline) {
            const ch = selectChannel(pool);
            if (!ch) break;
            const providerName = ch.provider || detectProvider(ch.base_url);
            const provider = getProvider(providerName);
            const effectiveModel = (ch.model === originalModel || ch.fallback_model === originalModel) ? originalModel : ch.model;
            const url = provider.buildUrl(ch.base_url, effectiveModel, true);
            if (!url) { pool = pool.filter(p => p.id !== ch.id); continue; }
            let reqBody = { ...body, model: effectiveModel, messages: normalizeOpenAIMessages(body.messages) };
            const blocked = getBlockedParams(ch.id);
            if (blocked && blocked.size > 0) { for (const param of blocked) { delete reqBody[param]; } }
            let channelHeaders = {};
            if (ch.headers && typeof ch.headers === "object") channelHeaders = { ...ch.headers };
            else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch {}
            if (ch.provider_options && typeof ch.provider_options === "object") Object.assign(reqBody, ch.provider_options);
            else if (ch.provider_options && typeof ch.provider_options === "string") try { Object.assign(reqBody, JSON.parse(ch.provider_options)); } catch {}
            const { body: pBody, headers: pHeaders } = provider.prepareRequest(reqBody, ch);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SECONDS * 1000);
            try {
              const startTime = Date.now();
              const requestHeaders = {
                "Content-Type": "application/json", "User-Agent": "api-gateway/1.0", "Accept": "application/json",
                Authorization: "Bearer " + ch.api_key, ...pHeaders, ...channelHeaders,
              };
              if (requestHeaders.Authorization === "") delete requestHeaders.Authorization;
              if (requestHeaders["x-api-key"] === "") delete requestHeaders["x-api-key"];
              const res = await fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(pBody), signal: controller.signal });
              const responseTime = Date.now() - startTime;
              clearTimeout(timeoutId);
              if (!res.ok) {
                const errBody = await res.text().catch(() => "");
                const errText = errBody || ("HTTP " + res.status);
                pool = pool.filter(p => p.id !== ch.id);
                if (res.status === 429) {
                  record429(ch.id, parseRetryAfter(res));
                  ch.last_429 = Math.floor(Date.now() / 1000) + (data.config.recovery_period || 300); markDirty(ch.id); healthDirtyChannels.add(ch.id);
                } else {
                  recordError(ch.id);
                  const errPattern = parseErrorForLearning(errText, res.status);
                  if (errPattern) learnFromError(ch.id, errPattern, errPattern === "unknownParam" ? extractBlockedParam(errText) : null);
                  ch.consecutive_errors = (ch.consecutive_errors || 0) + 1; ch.last_error_at = Math.floor(Date.now() / 1000);
                  ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(errText), url, request: pBody, response: truncateErrorBody(errBody) });
                  ch.response_time = responseTime; healthDirtyChannels.add(ch.id);
                }
                continue;
              }
              ok = true;
              clearInterval(keepalive);
              updateRateCounters(ch, Math.floor(Date.now() / 1000)); recordSuccess(ch.id);
              ch.consecutive_errors = 0; ch.last_error_msg = ""; ch.last_error_at = 0; ch.response_time = responseTime; healthDirtyChannels.add(ch.id);
              await tier2FullFilter(res.body, data.filters || [], originalModel, enc, w, provider);
            } catch (e) {
              clearTimeout(timeoutId);
              recordError(ch.id); ch.consecutive_errors = (ch.consecutive_errors || 0) + 1; ch.last_error_at = Math.floor(Date.now() / 1000);
              ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(e.message || "Request timeout"), url, request: pBody, response: "" });
              ch.response_time = responseTime || 0; healthDirtyChannels.add(ch.id); pool = pool.filter(p => p.id !== ch.id);
            }
          }
          if (!ok) {
            const bye = { id: "chatcmpl-" + (++chunkIdCounter), object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: originalModel || "unknown", choices: [{ index: 0, delta: { content: "\n\nService temporarily unavailable, please try again later." }, finish_reason: "stop" }] };
            try { await w.write(enc.encode("data: " + JSON.stringify(bye) + "\n\ndata: [DONE]\n\n")); } catch {}
          }
        } catch (e) { console.error("[stream] retry error:", e.message); }
        clearInterval(keepalive);
        try { await w.close(); } catch {}
      });
      return new Response(out, { headers: SSE_CHUNK_HEADERS });
    }
    while (pool.length > 0) {
      if (Date.now() > requestDeadline) return errResponse(c, "Request deadline exceeded", "server_error", 504);
      const ch = selectChannel(pool);
      if (!ch) return errResponse(c, "Rate limited or cooldown", "rate_limit_error", 429);
      const providerName = ch.provider || detectProvider(ch.base_url);
      const provider = getProvider(providerName);
      const effectiveModel = (ch.model === originalModel || ch.fallback_model === originalModel) ? originalModel : ch.model;
      const url = provider.buildUrl(ch.base_url, effectiveModel, false);
      if (!url) { pool = pool.filter(p => p.id !== ch.id); continue; }
      let reqBody = { ...body, model: effectiveModel, messages: normalizeOpenAIMessages(body.messages) };
      const blocked = getBlockedParams(ch.id);
      if (blocked && blocked.size > 0) { for (const param of blocked) { delete reqBody[param]; } }
      let channelHeaders = {};
      if (ch.headers && typeof ch.headers === "object") channelHeaders = { ...ch.headers };
      else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch {}
      if (ch.provider_options && typeof ch.provider_options === "object") Object.assign(reqBody, ch.provider_options);
      else if (ch.provider_options && typeof ch.provider_options === "string") try { Object.assign(reqBody, JSON.parse(ch.provider_options)); } catch {}
      const { body: pBody, headers: pHeaders } = provider.prepareRequest(reqBody, ch);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SECONDS * 1000);
      let responseTime = 0;
      try {
        const startTime = Date.now();
        const requestHeaders = {
          "Content-Type": "application/json", "User-Agent": "api-gateway/1.0", "Accept": "application/json",
          Authorization: "Bearer " + ch.api_key, ...pHeaders, ...channelHeaders,
        };
        if (requestHeaders.Authorization === "") delete requestHeaders.Authorization;
        if (requestHeaders["x-api-key"] === "") delete requestHeaders["x-api-key"];
        const res = await fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(pBody), signal: controller.signal });
        responseTime = Date.now() - startTime;
        clearTimeout(timeoutId);
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          const errText = errBody || ("HTTP " + res.status);
          if (res.status !== 429 && errBody) console.log("[diag]", res.status, url.replace(/\/\/[^@]+@/, "//***@"), errBody.replace(/\n/g," ").slice(0,200));
          if (res.status === 429) {
            record429(ch.id, parseRetryAfter(res)); ch.last_429 = Math.floor(Date.now()/1000) + (data.config.recovery_period||300);
            markDirty(ch.id); healthDirtyChannels.add(ch.id); pool = pool.filter(p=>p.id!==ch.id); continue;
          }
          recordError(ch.id);
          const errPattern = parseErrorForLearning(errText, res.status);
          if (errPattern) learnFromError(ch.id, errPattern, errPattern === "unknownParam" ? extractBlockedParam(errText) : null);
          ch.consecutive_errors = (ch.consecutive_errors||0)+1; ch.last_error_at = Math.floor(Date.now()/1000);
          ch.last_error_msg = JSON.stringify({message:truncateErrorBody(errText),url,request:pBody,response:truncateErrorBody(errBody)});
          ch.response_time = responseTime; healthDirtyChannels.add(ch.id); pool = pool.filter(p=>p.id!==ch.id); continue;
        }
        updateRateCounters(ch, Math.floor(Date.now()/1000)); recordSuccess(ch.id);
        ch.consecutive_errors = 0; ch.last_error_msg = ""; ch.last_error_at = 0; ch.response_time = responseTime; healthDirtyChannels.add(ch.id);
        const resText = await res.text();
        const json = provider.parseResponse(resText);
        if (originalModel) json.model = originalModel;
        return c.json(json);
      } catch (e) {
        clearTimeout(timeoutId); recordError(ch.id);
        ch.consecutive_errors = (ch.consecutive_errors||0)+1; ch.last_error_at = Math.floor(Date.now()/1000);
        ch.last_error_msg = JSON.stringify({message:truncateErrorBody(e.message||"Request timeout or network error"),url,request:pBody,response:""});
        ch.response_time = responseTime||0; healthDirtyChannels.add(ch.id); pool = pool.filter(p=>p.id!==ch.id);
      }
    }
    return errResponse(c, "All upstream channels exhausted or failed", "server_error", 503);
  } catch (e) {
    console.error("[gateway] unhandled:", e.message);
    return errResponse(c, "Internal Error", "server_error", 500);
  }
}

async function handleEmbeddings(c) {
  try {
    const data = await loadCache(c.env);
    const token = (c.req.header("Authorization") || "").replace("Bearer ", "");
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
    if (!base.endsWith("/embeddings")) {
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
      const res = await fetch(base, {
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
        healthDirtyChannels.add(ch.id);
        return errResponse(c, "Upstream error: " + (errText || res.status), "upstream_error", res.status);
      }
      updateRateCounters(ch, Math.floor(Date.now() / 1000));
      recordSuccess(ch.id);
      ch.consecutive_errors = 0;
      ch.last_error_msg = "";
      healthDirtyChannels.add(ch.id);
      const resText = await res.text();
      return c.json(JSON.parse(resText));
    } catch (e) {
      clearTimeout(timeoutId);
      recordError(ch.id);
      ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
      ch.last_error_at = Math.floor(Date.now() / 1000);
      ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(e.message || "Request timeout"), url: base });
      healthDirtyChannels.add(ch.id);
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
  rateLimitCache = { data: {}, ts: 0 };
  console.log("[gateway] cache cleared");
}

async function handleImageGeneration(c) {
  try {
    const data = await loadCache(c.env);
    const token = (c.req.header("Authorization") || "").replace("Bearer ", "");
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
    if (base.endsWith("/chat/completions")) base = base.replace("/chat/completions", "/images/generations");
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
      const res = await fetch(base, {
        method: "POST", headers: requestHeaders, body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        recordError(ch.id);
        ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
        ch.last_error_at = Math.floor(Date.now() / 1000);
        ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(errText), url: base });
        healthDirtyChannels.add(ch.id);
        return errResponse(c, "Upstream error: " + (errText || res.status), "upstream_error", res.status);
      }
      updateRateCounters(ch, Math.floor(Date.now() / 1000));
      recordSuccess(ch.id);
      ch.consecutive_errors = 0; ch.last_error_msg = "";
      healthDirtyChannels.add(ch.id);
      return c.json(await res.json());
    } catch (e) {
      clearTimeout(timeoutId);
      recordError(ch.id);
      ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
      ch.last_error_at = Math.floor(Date.now() / 1000);
      ch.last_error_msg = JSON.stringify({ message: truncateErrorBody(e.message || "Request timeout"), url: base });
      healthDirtyChannels.add(ch.id);
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
      if (enabled.length === 0) return c.json({ error: "no_available_channels", message: "No channels available" }, 503);
      const models = enabled.map((ch) => ({
        id: ch.model || "unknown", object: "model", created: 1735689600, owned_by: ch.name || "api-gateway",
      }));
      const fallbacks = enabled.filter((ch) => ch.fallback_model)
        .map((ch) => ({ id: ch.fallback_model, object: "model", created: 1735689600, owned_by: ch.name || "api-gateway" }));
      return c.json({ object: "list", data: [{ id: "openai", object: "model", created: 1735689600, owned_by: "api-gateway" }, ...models, ...fallbacks] });
    } catch (e) {
      return c.json({ error: "server_error", message: "Failed to load models" }, 503);
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
