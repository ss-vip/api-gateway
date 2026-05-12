// ============================================================
// API Gateway — Core Proxy Logic
// Route selection, stream transform, content filtering,
// circuit breaker, rate limiting.
// ============================================================
import { log } from "./lib/logger.js";
import { getProvider, SKIP, DONE } from "./lib/providers/index.js";
import {
  parseRetryAfter, record429, record503, recordError, recordSuccess, computeCooldown,
  parseErrorForLearning, extractBlockedParam, learnFromError,
  isVisionExcluded, isToolsExcluded, requiresMaxTokens, getBlockedParams,
} from "./lib/adaptive.js";
import {
  TOOL_NAME_MAX_LENGTH, MAX_JSON_REPAIR_SIZE, FILTER_TEXT_MAX_LENGTH,
  COOLDOWN_ERROR_THRESHOLD, COOLDOWN_WINDOW_SECONDS,
  COOLDOWN_429_DEFAULT_SECONDS, COOLDOWN_503_SECONDS, COOLDOWN_MAX_SECONDS,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
  REQUEST_TIMEOUT_SECONDS, TOTAL_TIMEOUT_SECONDS, MAX_RETRIES,
  RETRY_DELAY_BASE_MS, RETRY_DELAY_VARIANCE_MS,
  CACHE_TTL_RATE_MS, CACHE_TTL_NORMAL_MS,
  RATE_PERSIST_THRESHOLD, STREAM_IDLE_TIMEOUT_MS,
  D1_BATCH_MAX, STREAM_BUF_MAX_BYTES,
} from "./lib/constants.js";

// ============================================================
// Cache State
// ============================================================
let cache = { data: null, ts: 0 };
let cacheFlight = null;
let dirtyChannels = new Set(); // channel IDs with un-persisted rate counters
let lastDirtyFlush = 0; // timestamp of last flush, for throttling

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

// Persist dirty rate counters to D1 (throttled by threshold)
async function flushDirtyRateCounters(env) {
  if (dirtyChannels.size === 0 || !cache.data?.channels) return;
  const nowSec = Math.floor(Date.now() / 1000);

  // Filter: only persist counters that need it
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
      ch.rpm_count || 0,
      ch.rpm_reset_at || nowSec,
      ch.rpd_count || 0,
      ch.rpd_reset_at || nowSec,
      ch.id
    )
  );

  await safeBatch(env.DB, updates).catch((e) =>
    log("WARN", "rate", "flush failed", { error: e.message, count: updates.length })
  );
  lastDirtyFlush = Date.now();
}

// D1 batch safety: chunk into max 100 statements
async function safeBatch(db, statements) {
  if (statements.length === 0) return;
  for (let i = 0; i < statements.length; i += D1_BATCH_MAX) {
    await db.batch(statements.slice(i, i + D1_BATCH_MAX));
  }
}

// ============================================================
// Helpers
// ============================================================

function sanitizeToolName(n) {
  return (n || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, TOOL_NAME_MAX_LENGTH) || "unknown_tool";
}

function normalizeOpenAIMessages(messages) {
  if (!messages || messages.length === 0) return messages;
  // Single-pass: build ID→Name map while normalizing
  const idToNameMap = {};
  const result = [];
  // First pass: build name map
  for (const m of messages) {
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) {
          idToNameMap[tc.id] = sanitizeToolName(tc.function.name);
        }
      }
    }
  }
  // Second pass: normalize
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

function attemptRepairJson(str) {
  if (!str || str.length > MAX_JSON_REPAIR_SIZE) return null;
  try { return JSON.parse(str); } catch (e) { /* fall through */ }
  let s = str.trim();
  if (s.startsWith("```json")) s = s.replace(/^```json\n?/, "").replace(/\n?```$/, "");
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  try {
    let inString = false, output = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' && (i === 0 || s[i - 1] !== "\\")) inString = !inString;
      output += inString && (ch === "\n" || ch === "\r") ? (ch === "\n" ? "\\n" : "\\r") : ch;
    }
    return JSON.parse(output);
  } catch (e) { /* fall through */ }
  return null;
}

// ============================================================
// RollingFilter — streaming content filter
// ============================================================
class RollingFilter {
  constructor(filters) {
    this.filters = filters.filter(
      (f) => f.is_enabled && f.text && f.text.length > 0 && f.text.length <= FILTER_TEXT_MAX_LENGTH
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
    const enabled = filters.filter((f) => f.is_enabled && f.text);
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

// ============================================================
// Channel Selection & Rate Limiting
// ============================================================

function exponentialCooldown(consecutiveErrors) {
  if (consecutiveErrors <= COOLDOWN_ERROR_THRESHOLD) return 0;
  const exponent = Math.min(consecutiveErrors - COOLDOWN_ERROR_THRESHOLD, 4);
  return Math.min(
    COOLDOWN_429_DEFAULT_SECONDS * Math.pow(2, exponent),
    COOLDOWN_MAX_SECONDS
  );
}

function selectChannel(channels) {
  const now = Math.floor(Date.now() / 1000);
  const available = channels.filter((c) => {
    if (!c.is_enabled) return false;
    if (c.consecutive_errors >= COOLDOWN_ERROR_THRESHOLD &&
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

// ============================================================
// Stream Transform — 3-tier optimization
// ============================================================

const mkChunk = (delta, finish_reason = null, model = undefined) =>
  JSON.stringify({
    id: "chat_id-" + Math.random().toString(36).slice(2),
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

// ---- Tier 0: Pure passthrough (no filters, no model override) ---- //
// Zero CPU cost — just pipes raw bytes
function tier0Passthrough(readable, encoder, writer) {
  const initialChunk = `data: ${mkChunk({ content: "" })}\n\n`;
  writer.write(encoder.encode(initialChunk));
  readable.pipeTo(new WritableStream({ write: (chunk) => writer.write(chunk) })).catch(() => {});
  return Promise.resolve();
}

// ---- Tier 1: Lightweight regex model replacement ---- //
function fastReplaceModel(line, newModel) {
  if (!line.startsWith("data:")) return line;
  const trimmed = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
  if (trimmed === "[DONE]" || trimmed.startsWith("[DONE]")) return line;
  // Replace "model":"..." — much faster than JSON parse+stringify
  return line.replace(/"model"\s*:\s*"[^"]*"/, `"model":"${newModel}"`);
}

async function tier1ModelReplace(readable, encoder, writer, responseModel) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastActivity = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > STREAM_IDLE_TIMEOUT_MS) {
      reader.cancel("Stream idle timeout").catch(() => {});
    }
  }, 5000);

  try {
    await writer.write(encoder.encode(`data: ${mkChunk({ content: "" }, null, responseModel)}\n\n`));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      buf += decoder.decode(value, { stream: true });
      // Safety cap
      if (buf.length > STREAM_BUF_MAX_BYTES) {
        buf = buf.slice(buf.length - STREAM_BUF_MAX_BYTES);
      }
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.length === 0) { await writer.write(encoder.encode("\n")); continue; }
        const modified = fastReplaceModel(line, responseModel);
        await writer.write(encoder.encode(modified + "\n"));
      }
    }
  } finally {
    clearInterval(idleTimer);
    try { writer.close(); } catch (e) { /* ignore */ }
  }
}

// ---- Tier 2: Full parse + filter ---- //
const buildChunk = (delta, finishReason, json, usage) => ({
  id: json.id || "chatcmpl-" + Math.random().toString(36).slice(2),
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
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > STREAM_IDLE_TIMEOUT_MS) {
      reader.cancel("Stream idle timeout").catch(() => {});
    }
  }, 5000);

  const send = async (data) => {
    if (typeof data === "object") data = JSON.stringify(data);
    await writer.write(encoder.encode(`data: ${data}\n\n`));
  };

  try {
    await send(mkChunk({ content: "" }, null, responseModel));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();

      buf += decoder.decode(value, { stream: true });
      if (buf.length > STREAM_BUF_MAX_BYTES) {
        buf = buf.slice(buf.length - STREAM_BUF_MAX_BYTES);
      }

      const lines = buf.split("\n");
      buf = lines.pop();

      for (const rawLine of lines) {
        // Use provider to process the raw SSE line into canonical format
        const event = provider.processStreamLine(rawLine);

        // Skip: ping / safety-only / empty events
        if (event === SKIP) continue;

        // Done: stream complete
        if (event === DONE) {
          const tail = filter.flush();
          if (tail) await send(mkChunk({ content: tail }, null, responseModel));
          await send("[DONE]");
          continue;
        }

        // Error event from upstream
        if (event._error) {
          const errMsg = event.message || "Unknown stream error";
          await send(mkChunk({ content: `\n\n[Upstream Error: ${errMsg}]` }, "stop", responseModel));
          await send("[DONE]");
          continue;
        }

        // Normal chunk — event is in canonical OpenAI format
        // Override model name to original request's model
        if (responseModel) event.model = responseModel;

        const choice = event.choices?.[0];
        if (!choice) {
          if (event.usage) await send(buildChunk({}, "stop", event, event.usage));
          continue;
        }

        const finishReason = choice.finish_reason;
        const toolCalls = choice.delta?.tool_calls;
        const delta = { ...(choice.delta || {}) };

        // Apply content filter
        if (delta.content) {
          delta.content = filter.transform(delta.content);
          if (finishReason) delta.content += filter.flush();
        }
        if (delta.thought) {
          delta.thought = thoughtFilter.transform(delta.thought);
          if (finishReason) delta.thought += thoughtFilter.flush();
        }
        if (toolCalls) delta.tool_calls = toolCalls;

        if (delta.content || delta.thought || delta.tool_calls || finishReason || event.usage) {
          const chunk = buildChunk(delta, finishReason || null, event, event.usage);
          await send(chunk);
        }
      }
    }
  } finally {
    clearInterval(idleTimer);
    try { writer.close(); } catch (e) { /* ignore */ }
  }
}

// ---- Main stream entry point (routes to correct tier) ---- //
function transformStream(readable, filters, responseModel, provider) {
  const { readable: out, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const hasFilters = filters && filters.length > 0;
  const hasModelOverride = !!responseModel;

  if (!hasFilters && !hasModelOverride) {
    // Tier 0: Pure passthrough — zero CPU
    tier0Passthrough(readable, encoder, writer);
  } else if (!hasFilters && hasModelOverride) {
    // Tier 1: Regex model replacement — ~0.005ms/chunk
    tier1ModelReplace(readable, encoder, writer, responseModel).catch((e) =>
      log("WARN", "stream", "tier1 error", { error: e.message })
    );
  } else {
    // Tier 2: Full parse + filter — provider-aware — ~0.1ms/chunk
    tier2FullFilter(readable, filters, responseModel, encoder, writer, provider).catch((e) =>
      log("WARN", "stream", "tier2 error", { error: e.message })
    );
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

// ============================================================
// Cache Loader
// ============================================================
let rateLimitCache = { data: {}, ts: 0 };

async function loadCache(env) {
  const hasRL = cache.data?.channels?.some((ch) => ch.rpm_limit > 0 || ch.rpd_limit > 0);
  const ttl = hasRL ? CACHE_TTL_RATE_MS : CACHE_TTL_NORMAL_MS;

  if (cache.data && Date.now() - cache.ts < ttl) return cache.data;

  if (!cacheFlight) {
    cacheFlight = (async () => {
      // Pre-save any dirty counters before DB reload
      if (dirtyChannels.size > 0) {
        await flushDirtyRateCounters(env).catch((e) =>
          log("WARN", "cache", "pre-flush failed", { error: e.message })
        );
      }
      try {
        const [ch, fl, cf] = await Promise.all([
          env.DB.prepare(
            `SELECT id, name, base_url, api_key, provider, model, weight,
                    is_enabled, is_vision, last_429, consecutive_errors,
                    last_error_msg, last_error_at,
                    rpm_limit, rpd_limit, rpm_count, rpm_reset_at,
                    rpd_count, rpd_reset_at, max_tokens, support_tools,
                    response_time, fallback_model
             FROM channels WHERE is_enabled=1`
          ).all(),
          env.DB.prepare(
            "SELECT id, text, mode, is_enabled FROM filters WHERE is_enabled=1"
          ).all(),
          env.DB.prepare("SELECT * FROM config WHERE id=1").first(),
        ]);

        const nowSec = Math.floor(Date.now() / 1000);
        const channels = ch.results || [];
        for (const c of channels) {
          const saved = rateLimitCache.data[c.id];
          if (saved) {
            if (nowSec - saved.rpm_reset_at < RPM_WINDOW_SECONDS) {
              c.rpm_count = saved.rpm_count;
              c.rpm_reset_at = saved.rpm_reset_at;
            }
            if (nowSec - saved.rpd_reset_at < RPD_WINDOW_SECONDS) {
              c.rpd_count = saved.rpd_count;
              c.rpd_reset_at = saved.rpd_reset_at;
            }
          }
        }
        const config = cf || {};
        cache = {
          data: {
            channels,
            filters: fl.results || [],
            config: {
              client_token: config.client_token || "sk-test123456",
              recovery_period: parseInt(config.recovery_period) || COOLDOWN_429_DEFAULT_SECONDS,
            },
          },
          ts: Date.now(),
        };
        return cache.data;
      } catch (e) {
        // Graceful degradation: return stale cache on DB failure
        log("WARN", "cache", "load failed, using stale", { error: e.message });
        if (cache.data) return cache.data;
        throw e; // No cache at all — propagate
      }
    })().finally(() => {
      cacheFlight = null;
    });
  }
  return cacheFlight;
}

async function saveRateLimits(env) {
  if (!cache.data?.channels) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const updates = [];
  for (const ch of cache.data.channels) {
    if (ch.rpm_limit > 0 || ch.rpd_limit > 0) {
      rateLimitCache.data[ch.id] = {
        rpm_count: ch.rpm_count || 0,
        rpm_reset_at: ch.rpm_reset_at || nowSec,
        rpd_count: ch.rpd_count || 0,
        rpd_reset_at: ch.rpd_reset_at || nowSec,
      };
      updates.push(
        env.DB.prepare(
          "UPDATE channels SET rpm_count=?, rpm_reset_at=?, rpd_count=?, rpd_reset_at=? WHERE id=?"
        ).bind(
          ch.rpm_count || 0,
          ch.rpm_reset_at || nowSec,
          ch.rpd_count || 0,
          ch.rpd_reset_at || nowSec,
          ch.id
        )
      );
    }
  }
  if (updates.length > 0) {
    await safeBatch(env.DB, updates).catch((e) =>
      log("WARN", "rate", "periodic save failed", { error: e.message })
    );
  }
}

// ============================================================
// Request Validation
// ============================================================

function validateChatBody(body) {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  if (!Array.isArray(body.messages)) return "Field 'messages' must be an array";
  if (body.messages.length === 0) return "Field 'messages' cannot be empty";
  for (const m of body.messages) {
    if (!m.role) return "Each message must have a 'role'";
  }
  return null;
}

function errResponse(c, message, type, status) {
  return c.json({ error: { message, type } }, status);
}

function buildUpstreamUrl(baseUrl) {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (base.endsWith("/chat/completions")) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// ============================================================
// Main Request Handler
// ============================================================
async function handleChatRequest(c) {
  const requestStart = Math.floor(Date.now() / 1000);

  try {
    let data;
    try {
      data = await loadCache(c.env);
    } catch (e) {
      if (!cache.data) return errResponse(c, "Database not initialized", "server_error", 500);
      data = cache.data;
    }

    // Auth
    const token = (c.req.header("Authorization") || "").replace("Bearer ", "");
    if (data.config.client_token && token !== data.config.client_token)
      return errResponse(c, "Unauthorized", "authentication_error", 401);

    // Parse body
    const rawBodyText = await c.req.text();
    let body;
    try {
      body = JSON.parse(rawBodyText);
    } catch (e) {
      return errResponse(c, "Invalid JSON body", "invalid_request_error", 400);
    }

    const validationErr = validateChatBody(body);
    if (validationErr) return errResponse(c, validationErr, "invalid_request_error", 400);

    const originalModel = body.model;
    const isStream = body.stream === true || body.stream === "true" || body.stream === 1;

    // Build channel pool
    let pool = data.channels.filter((ch) => {
      if (ch.is_enabled !== 1) return false;
      if (hasImage(body.messages) && ch.is_vision !== 1) return false;
      return true;
    });
    if (pool.length === 0)
      return errResponse(c, "No enabled channels found", "server_error", 503);

    // ---- Feature-Based Pool Filtering (adaptive) ---- //
    // Exclude channels known to lack vision or tool support
    const hasTools = body.tools && Array.isArray(body.tools) && body.tools.length > 0;
    const hasVisionContent = hasImage(body.messages);
    if (hasVisionContent) {
      pool = pool.filter((ch) => !isVisionExcluded(ch.id));
    }
    if (hasTools) {
      pool = pool.filter((ch) => !isToolsExcluded(ch.id));
    }
    if (pool.length === 0)
      return errResponse(c, "No channels available for this request type after adaptive filtering", "server_error", 503);

    // ---- Model-Aware Pool Sorting ---- //
    // Priority: exact model match → fallback model match → any
    function modelPriority(ch) {
      if (ch.model === originalModel) return 2;
      if (ch.fallback_model === originalModel) return 1;
      return 0;
    }
    pool.sort((a, b) => modelPriority(b) - modelPriority(a));

    // Determine the effective model to use for upstream
    function getEffectiveModel(ch) {
      if (ch.model === originalModel) return originalModel;
      if (ch.fallback_model === originalModel) return ch.fallback_model;
      return ch.model || originalModel;
    }

    const dbUpdates = [];
    const maxTries = Math.min(pool.length, MAX_RETRIES);

    for (let attempt = 0; attempt < maxTries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(r, RETRY_DELAY_BASE_MS + Math.random() * RETRY_DELAY_VARIANCE_MS)
        );
      }

      const ch = selectChannel(pool);
      if (!ch) break;

      // Provider-aware routing
      const provider = getProvider(ch.provider || "openai");
      const effectiveModel = getEffectiveModel(ch);
      const url = provider.buildUrl(ch.base_url, effectiveModel);
      if (!url) { pool = pool.filter((p) => p.id !== ch.id); continue; }

      // Build request (canonical → provider-specific)
      let reqBody = { ...body };
      reqBody.model = effectiveModel;
      reqBody.messages = normalizeOpenAIMessages(reqBody.messages);

      // Adaptive: auto-add max_tokens if channel requires it
      if (reqBody.max_tokens === undefined && requiresMaxTokens(ch.id)) {
        reqBody.max_tokens = 4096;
      }

      // Adaptive: strip blocked params (params that previously caused 400)
      const blockedParams = getBlockedParams(ch.id);
      if (blockedParams && blockedParams.size > 0) {
        for (const key of blockedParams) {
          delete reqBody[key];
        }
      }

      const { body: providerBody, headers: extraHeaders } = provider.prepareRequest(reqBody, ch);

      const elapsed = Date.now() / 1000 - requestStart;
      const remaining = TOTAL_TIMEOUT_SECONDS - elapsed;
      if (remaining <= 2) break;

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(remaining, REQUEST_TIMEOUT_SECONDS) * 1000
      );
      const abortHandler = () => controller.abort();
      c.req.raw.signal?.addEventListener("abort", abortHandler);

      try {
        const startTime = Date.now();
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ch.api_key}`,
            ...extraHeaders,
          },
          body: JSON.stringify(providerBody),
          signal: controller.signal,
        });
        const latency = Date.now() - startTime;
        clearTimeout(timeoutId);
        c.req.raw.signal?.removeEventListener("abort", abortHandler);

        const ts = Math.floor(Date.now() / 1000);
        const cachedCh = data.channels.find((x) => x.id === ch.id);

        // ---- Error ---- //
        if (!res.ok || !res.body) {
          const errText = res.body ? await res.text().catch(() => "Body unreadable") : "No body";
          const isRetryable = res.status === 429 || res.status >= 500;

          // Adaptive learning: parse Retry-After, update state
          const retryAfter = parseRetryAfter(res);

          if (cachedCh) {
            cachedCh.consecutive_errors = (cachedCh.consecutive_errors || 0) + 1;
            cachedCh.last_error_at = ts;
            cachedCh.last_error_msg = `HTTP ${res.status}: ${errText.slice(0, 300)}`;

            if (isRetryable) {
              // Record the error type for adaptive learning
              if (res.status === 429) {
                record429(ch.id, retryAfter);
              } else if (res.status === 503) {
                record503(ch.id, retryAfter);
              } else {
                recordError(ch.id);
              }
              // Adaptive cooldown: blends Retry-After, observed recovery, backoff
              const errorLabel = res.status === 429 ? "429" : res.status === 503 ? "503" : "generic";
              const delay = computeCooldown(ch.id, errorLabel);
              cachedCh.last_429 = ts + delay;
            }
          }
          dbUpdates.push(
            c.env.DB.prepare(
              "UPDATE channels SET consecutive_errors=consecutive_errors+1, last_error_msg=?, last_error_at=? WHERE id=?"
            ).bind(`HTTP ${res.status}: ${errText.slice(0, 300)}`, ts, ch.id)
          );

          if (isRetryable && attempt < maxTries - 1) {
            pool = pool.filter((p) => p.id !== ch.id);
            continue;
          }
          return errResponse(c, `Upstream error (${res.status}): ${errText.slice(0, 500)}`, "upstream_error", res.status);
        }

        // ---- Success ---- //
        updateRateCounters(cachedCh, Math.floor(Date.now() / 1000));
        recordSuccess(ch.id); // Adaptive: learn recovery time
        if (cachedCh) {
          cachedCh.consecutive_errors = 0;
          cachedCh.response_time = latency;
          dbUpdates.push(
            c.env.DB.prepare("UPDATE channels SET consecutive_errors=0, response_time=? WHERE id=?").bind(latency, ch.id)
          );
        }

        // ---- Stream response ---- //
        if (isStream) {
          if (dbUpdates.length > 0) {
            c.executionCtx.waitUntil(
              safeBatch(c.env.DB, dbUpdates).catch((e) =>
                log("WARN", "db", "stream batch error", { error: e.message })
              )
            );
          }
          c.executionCtx.waitUntil(
            flushDirtyRateCounters(c.env).catch((e) =>
              log("WARN", "rate", "stream flush error", { error: e.message })
            )
          );
          return new Response(
            transformStream(res.body, data.filters, originalModel || effectiveModel, provider),
            { headers: SSE_CHUNK_HEADERS }
          );
        }

        // ---- Non-stream ---- //
        const resText = await res.text();
        let json;
        try {
          json = provider.parseResponse(resText);
        } catch (e) {
          json = null;
        }
        if (!json) {
          recordError(ch.id);
          if (cachedCh) {
            cachedCh.consecutive_errors = (cachedCh.consecutive_errors || 0) + 1;
            cachedCh.last_error_at = ts;
            cachedCh.last_error_msg = "JSON parse error on HTTP 200 response";
          }
          dbUpdates.push(
            c.env.DB.prepare(
              "UPDATE channels SET consecutive_errors=consecutive_errors+1, last_error_msg=?, last_error_at=? WHERE id=?"
            ).bind("JSON parse error on HTTP 200 response", ts, ch.id)
          );
          pool = pool.filter((p) => p.id !== ch.id);
          continue;
        }

        // Check for provider-level errors in response body
        if (provider.isErrorResponse?.(json)) {
          const errMsg = json.error?.message || json.error || "Upstream returned error";
          recordError(ch.id);
          if (cachedCh) {
            cachedCh.consecutive_errors = (cachedCh.consecutive_errors || 0) + 1;
            cachedCh.last_error_at = ts;
            cachedCh.last_error_msg = errMsg;
          }
          dbUpdates.push(
            c.env.DB.prepare(
              "UPDATE channels SET consecutive_errors=consecutive_errors+1, last_error_msg=?, last_error_at=? WHERE id=?"
            ).bind(String(errMsg).slice(0, 300), ts, ch.id)
          );
          pool = pool.filter((p) => p.id !== ch.id);
          continue;
        }

        if (originalModel) json.model = originalModel;
        if (json.choices?.[0]?.message) {
          const msg = json.choices[0].message;
          if (msg.content) msg.content = RollingFilter.applyStatic(msg.content, data.filters);
          if (msg.thought) msg.thought = RollingFilter.applyStatic(msg.thought, data.filters);
        }
        if (dbUpdates.length > 0) {
          c.executionCtx.waitUntil(
            safeBatch(c.env.DB, dbUpdates).catch((e) =>
              log("WARN", "db", "non-stream batch error", { error: e.message })
            )
          );
        }
        c.executionCtx.waitUntil(
          flushDirtyRateCounters(c.env).catch((e) =>
            log("WARN", "rate", "non-stream flush error", { error: e.message })
          )
        );
        return c.json(json);
      } catch (e) {
        clearTimeout(timeoutId);
        c.req.raw.signal?.removeEventListener("abort", abortHandler);
        const ts = Math.floor(Date.now() / 1000);
        const errDesc = e.name === "AbortError"
          ? `Upstream Timeout (>${REQUEST_TIMEOUT_SECONDS}s)`
          : e.message || "Network error";
        const cachedCh = data.channels.find((x) => x.id === ch.id);
        recordError(ch.id); // Adaptive: track network/timeout errors
        if (cachedCh) {
          cachedCh.consecutive_errors = (cachedCh.consecutive_errors || 0) + 1;
          cachedCh.last_error_at = ts;
          cachedCh.last_error_msg = errDesc;
        }
        dbUpdates.push(
          c.env.DB.prepare(
            "UPDATE channels SET consecutive_errors=consecutive_errors+1, last_error_msg=?, last_error_at=? WHERE id=?"
          ).bind(errDesc, ts, ch.id)
        );
        pool = pool.filter((p) => p.id !== ch.id);
        const timeLeft = TOTAL_TIMEOUT_SECONDS - (Date.now() / 1000 - requestStart);
        if (attempt < maxTries - 1 && timeLeft > 5) continue;
        break;
      }
    }

    // All attempts exhausted
    if (dbUpdates.length > 0) {
      c.executionCtx.waitUntil(
        safeBatch(c.env.DB, dbUpdates).catch((e) =>
          log("WARN", "db", "final batch error", { error: e.message })
        )
      );
    }
    return errResponse(c, "All attempts failed or timed out", "server_error", 502);
  } catch (e) {
    log("ERROR", "gateway", "unhandled", { error: e.message });
    return errResponse(c, `Gateway Error: ${e.message}`, "server_error", 500);
  }
}

// ============================================================
// Route Registration
// ============================================================
export default function registerGateway(app) {
  app.get("/v1/models", async (c) =>
    c.json({
      object: "list",
      data: [{ id: "openai", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "gateway" }],
    })
  );
  app.post("/v1/chat/completions", async (c) => handleChatRequest(c));
}
