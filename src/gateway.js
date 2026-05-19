import { getProvider, detectProvider } from "./lib/providers/index.js";
import {
  BACKOFF_ERROR_THRESHOLD, BACKOFF_429_SECONDS, BACKOFF_MAX_SECONDS,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  GLOBAL_TIMEOUT_MS,
} from "./lib/constants.js";
import { bufferRate, getBufferedRate } from "./routes/maintenance.js";

const SSE_CHUNK_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

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

let cache = { data: null, ts: 0 };
let cacheFlight = null;

async function loadCache(env) {
  const TTL = 60_000;
  if (cache.data && Date.now() - cache.ts < TTL) return cache.data;
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
              client_token: cf?.client_token || "",
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

function exponentialCooldown(consecutiveErrors) {
  if (consecutiveErrors <= BACKOFF_ERROR_THRESHOLD) return 0;
  const exponent = Math.min(consecutiveErrors - BACKOFF_ERROR_THRESHOLD, 4);
  return Math.min(BACKOFF_429_SECONDS * Math.pow(2, exponent), BACKOFF_MAX_SECONDS);
}

// Pick the first (fastest) available channel that passes health checks
function selectChannel(channels) {
  const now = Math.floor(Date.now() / 1000);
  for (const ch of channels) {
    if (!ch.is_enabled) continue;
    if (ch.consecutive_errors >= BACKOFF_ERROR_THRESHOLD &&
        now - (ch.last_error_at || 0) <= exponentialCooldown(ch.consecutive_errors)) continue;
    if (ch.last_429 > 0 && ch.last_429 > now) continue;
    const buf = getBufferedRate(ch.id);
    const rpmCount = buf ? buf.rpmCount : (ch.rpm_count || 0);
    const rpmResetAt = buf ? buf.rpmResetAt : (ch.rpm_reset_at || 0);
    const rpdCount = buf ? buf.rpdCount : (ch.rpd_count || 0);
    const rpdResetAt = buf ? buf.rpdResetAt : (ch.rpd_reset_at || 0);
    if (ch.rpm_limit > 0 &&
        now - rpmResetAt < RPM_WINDOW_SECONDS &&
        rpmCount >= ch.rpm_limit) continue;
    if (ch.rpd_limit > 0 &&
        now - rpdResetAt < RPD_WINDOW_SECONDS &&
        rpdCount >= ch.rpd_limit) continue;
    return ch;
  }
  return null;
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
  bufferRate(cachedCh.id, cachedCh.rpm_count || 0, cachedCh.rpm_reset_at || 0, cachedCh.rpd_count || 0, cachedCh.rpd_reset_at || 0);
}

async function persistHealth(db, ch) {
  if (!ch || !ch.id) return;
  if (!ch.response_time && !ch.consecutive_errors && !ch.last_429 && !ch.cooldown_until) return;
  try {
    await db.prepare(
      "UPDATE channels SET response_time=?, consecutive_errors=?, last_error_msg=?, last_error_at=?, last_429=?, cooldown_until=? WHERE id=?"
    ).bind(
      ch.response_time || 0, ch.consecutive_errors || 0,
      ch.last_error_msg || '', ch.last_error_at || 0,
      ch.last_429 || 0, ch.cooldown_until || 0,
      ch.id
    ).run();
  } catch (e) { console.error("[persist] health:", ch.id, e.message); }
}

function truncateErrorBody(text) {
  if (!text || typeof text !== "string") return text || "";
  if (text.length <= 8192) return text;
  return text.slice(0, 8192) + "... [truncated]";
}

// Rolling filter for streaming content keyword filtering
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
    const enabled = filters.filter(f => f.is_enabled && f.text && f.text.length >= 1);
    let out = text;
    for (const f of enabled) {
      if (f.mode === 1) { const idx = out.indexOf(f.text); if (idx !== -1) out = out.substring(0, idx); }
      else { out = out.split(f.text).join(""); }
    }
    return out;
  }
}

async function handleChatRequest(c) {
  try {
    let data;
    try { data = await loadCache(c.env); } catch (e) {
      if (!cache.data) return errResponse(c, "DB Error", "server_error", 500);
      data = cache.data;
    }

    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Unauthorized", "auth_error", 401);
    }

    let body;
    try { body = await c.req.json(); } catch (e) {
      return errResponse(c, "Invalid JSON", "invalid_request_error", 400);
    }

    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return errResponse(c, "Invalid messages", "invalid_request_error", 400);
    }

    const originalModel = body.model;
    const isStream = body.stream !== false;

    // Only use OpenAI-compatible channels (the only provider we support)
    let pool = data.channels.filter((ch) => {
      if (!ch.is_enabled) return false;
      const pn = ch.provider || detectProvider(ch.base_url);
      return pn === "openai";
    });
    if (pool.length === 0) return errResponse(c, "No available channels", "server_error", 503);

    // Sort: model match first, then response_time
    function modelMatches(ch) {
      if (!originalModel) return false;
      if (ch.model === originalModel || ch.fallback_model === originalModel) return true;
      const models = (ch.model || "").split(",").map(x => x.trim()).filter(Boolean);
      const fallbacks = (ch.fallback_model || "").split(",").map(x => x.trim()).filter(Boolean);
      return models.includes(originalModel) || fallbacks.includes(originalModel);
    }
    pool.sort((a, b) => {
      const ma = modelMatches(a) ? 1 : 0;
      const mb = modelMatches(b) ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return (a.response_time || 999999) - (b.response_time || 999999);
    });

    const requestDeadline = Date.now() + GLOBAL_TIMEOUT_MS;

    if (isStream) {
      const { readable: out, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();

      // Send initial chunk immediately so client knows response started
      const initChunk = {
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: originalModel || "unknown",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      };
      w.write(enc.encode("data: " + JSON.stringify(initChunk) + "\n\n")).catch(() => {});

      c.executionCtx.waitUntil((async () => {
        let ok = false;
        let lastError = "";

        while (pool.length > 0 && !ok && Date.now() < requestDeadline) {
          const ch = selectChannel(pool);
          if (!ch) { lastError = "all channels in cooldown or rate-limited"; break; }

          const providerName = ch.provider || detectProvider(ch.base_url);
          if (providerName !== "openai") { pool.splice(pool.indexOf(ch), 1); continue; }
          const p = getProvider(providerName);
          const effectiveModel = ch.model || originalModel || "gpt-4o";
          const url = ch.absolute_url ? ch.base_url.replace(/\/+$/, "") + "/" : p.buildUrl(ch.base_url, effectiveModel, true);
          if (!url) continue;

          // Forward the request AS-IS with minimal modification
          const reqBody = { ...body, model: effectiveModel, stream: true };

          let channelHeaders = {};
          if (ch.headers && typeof ch.headers === "object") channelHeaders = ch.headers;
          else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch (e) {}

          const remainingMs = Math.max(2000, requestDeadline - Date.now());
          const chTimeout = Math.min(remainingMs, 25000);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), chTimeout);

          let responseTime = 0;
          try {
            const requestHeaders = {
              "Content-Type": "application/json",
              Authorization: "Bearer " + ch.api_key,
              ...channelHeaders,
            };
            if (!requestHeaders.Authorization) delete requestHeaders.Authorization;

            const startTime = Date.now();
            const res = await fetch(url, {
              method: "POST",
              headers: requestHeaders,
              body: JSON.stringify(reqBody),
              signal: controller.signal,
            });
            responseTime = Date.now() - startTime;
            clearTimeout(timeoutId);

            if (!res.ok) {
              const errBody = await res.text().catch(() => "");
              const errText = errBody || ("HTTP " + res.status);
              lastError = errText.slice(0, 200);
              ch.response_time = responseTime;

              if (res.status === 429) {
                ch.last_429 = Math.floor(Date.now() / 1000) + (data.config.recovery_period || 300);
                ch.last_error_at = Math.floor(Date.now() / 1000);
                ch.last_error_msg = errText;
                ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
              } else {
                ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
                ch.last_error_at = Math.floor(Date.now() / 1000);
                ch.last_error_msg = errText;
              }
              continue;
            }

            // Success: update health and start streaming
            updateRateCounters(ch, Math.floor(Date.now() / 1000));
            ch.consecutive_errors = 0;
            ch.last_error_msg = "";
            ch.last_error_at = 0;
            ch.response_time = responseTime;
            c.executionCtx.waitUntil(persistHealth(c.env.DB, ch));
            ok = true;

            // Stream the upstream response directly to the client
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let sseBuf = "";
            let streamHadContent = false;
            const contentFilter = new RollingFilter(data.filters || []);

            try {
              let lastLine = "";
              let streamDone = false;
              while (!streamDone) {
                const { done, value } = await reader.read();
                if (done) { streamDone = true; break; }
                sseBuf += decoder.decode(value, { stream: true });
                const lines = sseBuf.split("\n");
                sseBuf = lines.pop() || "";
                for (const line of lines) {
                  if (!line.startsWith("data:")) continue;
                  lastLine = line;

                  if (line.includes("[DONE]")) {
                    const tail = contentFilter.flush();
                    if (tail) {
                      try { await w.write(enc.encode("data: " + JSON.stringify({
                        id: "chatcmpl-" + Date.now(), object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        choices: [{ index: 0, delta: { content: tail }, finish_reason: "stop" }]
                      }) + "\n\n")); } catch (e) {}
                    }
                    try { await w.write(enc.encode(line + "\n\n")); } catch (e) {}
                    streamDone = true; break;
                  }

                  try {
                    const jsonStr = line.replace(/^data:?\s?/, "");
                    const chunk = JSON.parse(jsonStr);
                    const delta = chunk?.choices?.[0]?.delta;
                    if (delta?.content || delta?.tool_calls) streamHadContent = true;

                    if (delta?.content) {
                      const filtered = contentFilter.transform(delta.content);
                      if (filtered) {
                        delta.content = filtered;
                        try { await w.write(enc.encode("data: " + JSON.stringify(chunk) + "\n\n")); } catch (e) {}
                      }
                      if (contentFilter.truncated) {
                        try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e) {}
                        streamDone = true; break;
                      }
                    } else {
                      try { await w.write(enc.encode(line + "\n\n")); } catch (e) {}
                    }
                  } catch (e) {
                    try { await w.write(enc.encode(line + "\n\n")); } catch (e) {}
                  }
                }
              }
              // Check if stream was empty (no content or tool_calls)
              if (!streamHadContent) {
                ch.last_error_msg = "Empty response (no content)";
                ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
                ch.last_error_at = Math.floor(Date.now() / 1000);
                try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e) {}
                await w.close();
                pool.splice(pool.indexOf(ch), 1);
                continue;
              }
              // Send [DONE] only if upstream didn't already
              if (!lastLine.includes("[DONE]") && !streamDone) {
                try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e) {}
              }
            } catch (e) {
              // Stream reading error - channel failed mid-stream
              pool.splice(pool.indexOf(ch), 1);
              continue;
            }
            return; // Successfully completed

          } catch (e) {
            clearTimeout(timeoutId);
            ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
            ch.last_error_at = Math.floor(Date.now() / 1000);
            ch.last_error_msg = truncateErrorBody(e.message || "");
            ch.response_time = responseTime || 0;
            if (e.name === 'AbortError') {
              ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors), 60);
            }
            lastError = (e.message || "Request failed").slice(0, 200);
            pool.splice(pool.indexOf(ch), 1);
          }
        }

        // All channels failed
        if (!ok) {
          const errMsg = "All upstream channels failed" + (lastError ? ": " + lastError : "");
          const bye = {
            id: "chatcmpl-" + Date.now(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: originalModel || "unknown",
            choices: [{ index: 0, delta: { content: "\n\n" + errMsg }, finish_reason: "stop" }],
          };
          try { await w.write(enc.encode("data: " + JSON.stringify(bye) + "\n\ndata: [DONE]\n\n")); } catch (e) {}
        }

        try { await w.close(); } catch (e) {}
      })());

      return new Response(out, { headers: SSE_CHUNK_HEADERS });
    }

    // Non-streaming: simple forward with cache bypass
    while (Date.now() < requestDeadline) {
      const ch = selectChannel(pool);
      if (!ch) return errResponse(c, "Rate limited or all channels unavailable", "rate_limit_error", 429);

      const p = getProvider("openai");
      const effectiveModel = ch.model || originalModel || "gpt-4o";
      const url = ch.absolute_url ? ch.base_url.replace(/\/+$/, "") + "/" : p.buildUrl(ch.base_url, effectiveModel, false);
      if (!url) { pool.splice(pool.indexOf(ch), 1); continue; }

      const reqBody = { ...body, model: effectiveModel };
      let channelHeaders = {};
      if (ch.headers && typeof ch.headers === "object") channelHeaders = ch.headers;
      else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch (e) {}

      const chTimeout = Math.min(Math.max(2000, requestDeadline - Date.now()), 25000);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), chTimeout);

      let responseTime = 0;
      try {
        const requestHeaders = {
          "Content-Type": "application/json",
          Authorization: "Bearer " + ch.api_key,
          ...channelHeaders,
        };
        if (!requestHeaders.Authorization) delete requestHeaders.Authorization;

        const startTime = Date.now();
        const res = await fetch(url, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });
        responseTime = Date.now() - startTime;
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
          ch.last_error_at = Math.floor(Date.now() / 1000);
          ch.last_error_msg = truncateErrorBody(errText);
          ch.response_time = responseTime;
          if (res.status === 429) {
            ch.last_429 = Math.floor(Date.now() / 1000) + (data.config.recovery_period || 300);
          }
          pool.splice(pool.indexOf(ch), 1);
          continue;
        }

        updateRateCounters(ch, Math.floor(Date.now() / 1000));
        ch.consecutive_errors = 0;
        ch.last_error_msg = "";
        ch.last_error_at = 0;
        ch.response_time = responseTime;
        c.executionCtx.waitUntil(persistHealth(c.env.DB, ch));

        const resText = await res.text();
        if (resText.length > 4 * 1024 * 1024) {
          return errResponse(c, "Response too large", "server_error", 502);
        }
        const json = JSON.parse(resText);
        // Detect empty 200 response and retry with next channel
        const choice = json?.choices?.[0];
        if (choice && !choice.message?.content && !choice.message?.tool_calls && choice.finish_reason === "stop") {
          ch.last_error_msg = "Empty response (no content)";
          ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
          ch.last_error_at = Math.floor(Date.now() / 1000);
          ch.response_time = responseTime;
          pool.splice(pool.indexOf(ch), 1);
          continue;
        }
        // Apply content filters for non-streaming
        if (json?.choices?.[0]?.message?.content && data.filters?.length > 0) {
          json.choices[0].message.content = RollingFilter.applyStatic(json.choices[0].message.content, data.filters);
        }
        return c.json(json);

      } catch (e) {
        clearTimeout(timeoutId);
        ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
        ch.last_error_at = Math.floor(Date.now() / 1000);
        ch.last_error_msg = truncateErrorBody(e.message || "");
        ch.response_time = responseTime || 0;
        if (e.name === 'AbortError') {
          ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors), 60);
        }
        pool.splice(pool.indexOf(ch), 1);
      }
    }
    return errResponse(c, "All channels failed or request timed out", "server_error", 504);

  } catch (e) {
    console.error("[gateway] unhandled:", e.message);
    return errResponse(c, "Internal Error", "server_error", 500);
  }
}

export function clearCache() {
  cache.data = null;
  cache.ts = 0;
}

export default function registerGateway(app) {
  app.post("/chat/completions", async (c) => handleChatRequest(c));
  app.post("/v1/chat/completions", async (c) => handleChatRequest(c));
}
