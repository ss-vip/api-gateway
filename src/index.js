import { Hono } from "hono";
import { cors } from "hono/cors";
import dashboard from "./dashboard";

const app = new Hono();
app.use("*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: false,
}));

let cache = { data: null, ts: 0 };
let cacheFlight = null;
const clearCache = () => { cache.data = null; cache.ts = 0; cacheFlight = null; };

app.route("/", dashboard(clearCache));

function sanitizeToolName(n) {
  return (n || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown_tool";
}

function normalizeOpenAIMessages(messages, currentTools = []) {
  if (!messages || messages.length === 0) return messages;

  // 1. Pre-scan the entire history to build a complete ID-to-Name map
  const idToNameMap = {};
  for (const m of messages) {
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) idToNameMap[tc.id] = sanitizeToolName(tc.function.name);
      }
    }
  }

  // 2. Normalize while preserving signature fields
  return messages.map(m => {
    let role = m.role;
    if (role === "developer") role = "system";

    // Start with a copy of all original fields (preserving thought_signature etc)
    const newMsg = { ...m, role };

    if (newMsg.content === undefined) newMsg.content = null;

    // Handle tool definitions (assistant role)
    if (newMsg.tool_calls && Array.isArray(newMsg.tool_calls)) {
      newMsg.tool_calls = newMsg.tool_calls.map(tc => {
        if (tc.function?.name) {
          return { ...tc, function: { ...tc.function, name: sanitizeToolName(tc.function.name) } };
        }
        return tc;
      });
    }

    // Handle tool responses (tool/function role)
    if (role === "tool" || role === "function") {
      newMsg.name = sanitizeToolName(m.name || idToNameMap[m.tool_call_id] || m.tool_call_id || "unknown_tool");
    } else {
      // Stripping name from user/assistant roles to prevent Google translator confusion
      if (newMsg.name) delete newMsg.name;
    }

    return newMsg;
  });
}

function attemptRepairJson(str) {
  if (!str || str.length > 2_000_000) return null;
  try { return JSON.parse(str); } catch (e) { }
  let s = str.trim();
  if (s.startsWith("```json")) s = s.replace(/^```json\n?/, "").replace(/\n?```$/, "");
  try { return JSON.parse(s); } catch (e) { }
  try {
    let inString = false, output = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' && (i === 0 || s[i - 1] !== "\\")) inString = !inString;
      if (inString && (ch === "\n" || ch === "\r")) { output += ch === "\n" ? "\\n" : "\\r"; }
      else { output += ch; }
    }
    return JSON.parse(output);
  } catch (e) { }
  return null;
}

class RollingFilter {
  constructor(filters) {
    this.filters = filters.filter(f => f.is_enabled && f.text && f.text.length > 0 && f.text.length <= 30);
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
      } else { this.buffer = this.buffer.split(f.text).join(""); }
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
    let enabled = filters.filter(f => f.is_enabled && f.text);
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

function selectChannel(channels) {
  const now = Math.floor(Date.now() / 1000);
  const available = channels.filter(c => {
    if (!c.is_enabled) return false;
    if (c.consecutive_errors >= 5 && now - (c.last_error_at || 0) <= 1800) return false;
    if (c.last_429 > now) return false;
    if (c.rpm_limit > 0 && now - (c.rpm_reset_at || 0) < 60 && (c.rpm_count || 0) >= c.rpm_limit) return false;
    if (c.rpd_limit > 0 && now - (c.rpd_reset_at || 0) < 86400 && (c.rpd_count || 0) >= c.rpd_limit) return false;
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
  if (nowSec - (cachedCh.rpm_reset_at || 0) >= 60) { cachedCh.rpm_count = 1; cachedCh.rpm_reset_at = nowSec; }
  else cachedCh.rpm_count = (cachedCh.rpm_count || 0) + 1;
  if (nowSec - (cachedCh.rpd_reset_at || 0) >= 86400) { cachedCh.rpd_count = 1; cachedCh.rpd_reset_at = nowSec; }
  else cachedCh.rpd_count = (cachedCh.rpd_count || 0) + 1;
}

const mkChunk = (delta, finish_reason = null, model = undefined) => JSON.stringify({
  id: "chat_id-" + Math.random().toString(36).slice(2),
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason }],
});

function hasImage(messages) {
  if (!messages || !Array.isArray(messages)) return false;
  return messages.some(m => {
    if (typeof m.content === "string") return false;
    if (Array.isArray(m.content)) return m.content.some(c => c.type === "image_url");
    return false;
  });
}

function transformStream(readable, filters, responseModel) {
  const { readable: r, writable: w } = new TransformStream();
  const writer = w.getWriter(), reader = readable.getReader();
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const filter = new RollingFilter(filters);
  const thoughtFilter = new RollingFilter(filters);
  let buf = "";

  const send = async (data) => {
    if (typeof data === "object") data = JSON.stringify(data);
    await writer.write(encoder.encode(`data: ${data}\n\n`));
  };

  (async () => {
    try {
      await send(mkChunk({ content: "" }, null, responseModel));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let lines = buf.split("\n");
        buf = lines.pop();
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            const tail = filter.flush();
            if (tail) await send(mkChunk({ content: tail }, null, responseModel));
            await send("[DONE]");
            continue;
          }
          try {
            const json = JSON.parse(dataStr);
            if (json.type === "ping") continue;
            if (json.type === "error" || json.error) {
              const errMsg = json.error?.message || json.message || "Unknown stream error";
              await send(mkChunk({ content: `\n\n[Upstream Error: ${errMsg}]` }, "stop", responseModel));
              await send("[DONE]");
              continue;
            }
            const choice = json.choices?.[0];
            const finishReason = choice?.finish_reason;
            let toolCalls = choice?.delta?.tool_calls;

            if (!filters.length) {
              if (responseModel) json.model = responseModel;
              await send(json);
            } else {
              const delta = { ...json.choices[0].delta };
              if (delta.content) {
                delta.content = filter.transform(delta.content);
                if (finishReason) delta.content += filter.flush();
              }
              if (delta.thought) {
                delta.thought = thoughtFilter.transform(delta.thought);
                if (finishReason) delta.thought += thoughtFilter.flush();
              }
              if (toolCalls) delta.tool_calls = toolCalls;
              if (delta.content || delta.thought || delta.tool_calls || finishReason || json.usage) {
                const chunk = {
                  id: json.id || "chatcmpl-" + Math.random().toString(36).slice(2),
                  object: "chat.completion.chunk",
                  created: json.created || Math.floor(Date.now() / 1000),
                  model: responseModel,
                  choices: [{ index: 0, delta, finish_reason: finishReason }]
                };
                if (json.usage) chunk.usage = json.usage;
                await send(chunk);
              }
            }
          } catch (e) { console.warn("Stream chunk parse error:", e.message); }
        }
      }
    } finally {
      try { writer.close(); } catch (e) { console.warn("Stream writer close error:", e.message); }
    }
  })();
  return r;
}

let rateLimitCache = { data: {}, ts: 0 };

async function loadCache(env) {
  const ttl = cache.data?.channels?.some(ch => ch.rpm_limit > 0 || ch.rpd_limit > 0) ? 10000 : 30000;
  const needsSave = cache.data && Date.now() - cache.ts >= ttl;
  if (cache.data && !needsSave) return cache.data;
  if (!cacheFlight) {
    cacheFlight = (async () => {
      if (needsSave) await saveRateLimits(env).catch(e => console.warn("saveRateLimits preload failed:", e.message));
      try {
        const [ch, fl, cf] = await Promise.all([
          env.DB.prepare("SELECT id, name, base_url, api_key, provider, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, rpm_count, rpm_reset_at, rpd_count, rpd_reset_at, max_tokens, support_tools, response_time, fallback_model FROM channels WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM config WHERE id=1").first(),
        ]);
        const nowSec = Math.floor(Date.now() / 1000);
        const channels = ch.results || [];
        for (const c of channels) {
          const saved = rateLimitCache.data[c.id];
          if (saved) {
            if (nowSec - saved.rpm_reset_at < 60) { c.rpm_count = saved.rpm_count; c.rpm_reset_at = saved.rpm_reset_at; }
            if (nowSec - saved.rpd_reset_at < 86400) { c.rpd_count = saved.rpd_count; c.rpd_reset_at = saved.rpd_reset_at; }
          }
        }
        const config = cf || {};
        cache = {
          data: {
            channels,
            filters: fl.results || [],
            config: {
              client_token: config.client_token || "sk-test123456",
              recovery_period: parseInt(config.recovery_period) || 300
            }
          },
          ts: Date.now()
        };
        return cache.data;
      } catch (e) { throw e; }
    })().finally(() => { cacheFlight = null; });
  }
  return cacheFlight;
}

async function saveRateLimits(env) {
  if (!cache.data?.channels) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const updates = [];
  for (const ch of cache.data.channels) {
    if (ch.rpm_limit > 0 || ch.rpd_limit > 0) {
      rateLimitCache.data[ch.id] = { rpm_count: ch.rpm_count || 0, rpm_reset_at: ch.rpm_reset_at || nowSec, rpd_count: ch.rpd_count || 0, rpd_reset_at: ch.rpd_reset_at || nowSec };
      updates.push(env.DB.prepare("UPDATE channels SET rpm_count=?, rpm_reset_at=?, rpd_count=?, rpd_reset_at=? WHERE id=?").bind(ch.rpm_count || 0, ch.rpm_reset_at || nowSec, ch.rpd_count || 0, ch.rpd_reset_at || nowSec, ch.id));
    }
  }
  if (updates.length > 0) await env.DB.batch(updates).catch(e => console.warn("saveRateLimits batch error:", e.message));
}

app.get("/v1/models", async (c) => {
  return c.json({ object: "list", data: [{ id: "openai", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "gateway" }] });
});

function validateChatBody(body) {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  if (!Array.isArray(body.messages)) return "Field 'messages' must be an array";
  if (body.messages.length === 0) return "Field 'messages' cannot be empty";
  for (const m of body.messages) { if (!m.role) return "Each message must have a 'role'"; }
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

async function handleChatRequest(c) {
  const now = Math.floor(Date.now() / 1000);
  try {
    let data;
    try {
      data = await loadCache(c.env);
    } catch (e) {
      if (!cache.data) return errResponse(c, "Database not initialized", "server_error", 500);
      data = cache.data;
    }

    const token = (c.req.header("Authorization") || "").replace("Bearer ", "");
    if (data.config.client_token && token !== data.config.client_token)
      return errResponse(c, "Unauthorized", "authentication_error", 401);

    const rawBodyText = await c.req.text();
    let body;
    try {
      body = JSON.parse(rawBodyText);
    } catch (e) {
      return errResponse(c, "Invalid JSON body", "invalid_request_error", 400);
    }

    const originalModel = body.model;
    const isStream = body.stream === true || body.stream === "true" || body.stream === 1;

    let pool = data.channels.filter(ch => {
      if (ch.is_enabled !== 1) return false;
      if (hasImage(body.messages) && ch.is_vision !== 1) return false;
      return true;
    });

    if (pool.length === 0) return errResponse(c, "No enabled channels found", "server_error", 503);

    const dbUpdates = [];
    for (let i = 0, maxTries = Math.min(pool.length, 5); i < maxTries; i++) {
      if (i > 0) {
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      }

      const ch = selectChannel(pool);
      if (!ch) break;

      const url = buildUpstreamUrl(ch.base_url);
      if (!url) { pool = pool.filter(p => p.id !== ch.id); continue; }

      let reqBody = { ...body };
      if (ch.model) reqBody.model = ch.model;
      reqBody.messages = normalizeOpenAIMessages(reqBody.messages);

      const timeElapsed = Date.now() / 1000 - now;
      const totalRemaining = 25 - timeElapsed;
      if (totalRemaining <= 2) break;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.min(totalRemaining, 15) * 1000);
      const abortHandler = () => controller.abort();
      c.req.raw.signal?.addEventListener("abort", abortHandler);

      try {
        const startTime = Date.now();
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ch.api_key}` },
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });
        const latency = Date.now() - startTime;
        clearTimeout(timeoutId);
        c.req.raw.signal?.removeEventListener("abort", abortHandler);

        if (!res.ok || !res.body) {
          const errText = res.body ? await res.text().catch(() => "Body unreadable") : "No body";
          const ts = Math.floor(Date.now() / 1000);
          const cachedCh = data.channels.find(x => x.id === ch.id);
          const isRetryable = res.status === 429 || res.status >= 500;

          if (cachedCh) {
            cachedCh.consecutive_errors = (cachedCh.consecutive_errors || 0) + 1;
            cachedCh.last_error_at = ts;
            cachedCh.last_error_msg = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
            if (isRetryable) cachedCh.last_429 = ts + (res.status === 503 ? 60 : (data.config.recovery_period || 300));
          }
          dbUpdates.push(c.env.DB.prepare("UPDATE channels SET consecutive_errors=consecutive_errors+1, last_error_msg=?, last_error_at=? WHERE id=?").bind(`HTTP ${res.status}: ${errText.slice(0, 300)}`, ts, ch.id));

          if (isRetryable && i < maxTries - 1) {
            pool = pool.filter(p => p.id !== ch.id);
            continue;
          }
          return errResponse(c, `Upstream error (${res.status}): ${errText.slice(0, 500)}`, "upstream_error", res.status);
        }

        const cachedCh = data.channels.find(x => x.id === ch.id);
        updateRateCounters(cachedCh, Math.floor(Date.now() / 1000));
        if (cachedCh) {
          cachedCh.consecutive_errors = 0;
          cachedCh.response_time = latency;
          dbUpdates.push(c.env.DB.prepare("UPDATE channels SET consecutive_errors=0, response_time=? WHERE id=?").bind(latency, ch.id));
        }

        if (isStream) {
          if (dbUpdates.length > 0) c.executionCtx.waitUntil(c.env.DB.batch(dbUpdates).catch(e => console.warn("Stream DB batch error:", e.message)));
          return new Response(
            transformStream(res.body, data.filters, originalModel || ch.model || undefined),
            { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } }
          );
        }

        const resText = await res.text();
        const json = attemptRepairJson(resText);
        if (!json) continue;

        if (originalModel) json.model = originalModel;
        if (json.choices?.[0]?.message) {
          const msg = json.choices[0].message;
          if (msg.content) msg.content = RollingFilter.applyStatic(msg.content, data.filters);
          if (msg.thought) msg.thought = RollingFilter.applyStatic(msg.thought, data.filters);
        }
        if (dbUpdates.length > 0) c.executionCtx.waitUntil(c.env.DB.batch(dbUpdates).catch(e => console.warn("Non-stream DB batch error:", e.message)));
        return c.json(json);

      } catch (e) {
        clearTimeout(timeoutId);
        c.req.raw.signal?.removeEventListener("abort", abortHandler);
        const ts = Math.floor(Date.now() / 1000);
        const errDesc = e.name === "AbortError" ? "Upstream Timeout (>15s)" : (e.message || "Network error");
        const cachedCh = data.channels.find(x => x.id === ch.id);
        if (cachedCh) { cachedCh.consecutive_errors = (cachedCh.consecutive_errors || 0) + 1; cachedCh.last_error_at = ts; cachedCh.last_error_msg = errDesc; }
        dbUpdates.push(c.env.DB.prepare("UPDATE channels SET consecutive_errors=consecutive_errors+1, last_error_msg=?, last_error_at=? WHERE id=?").bind(errDesc, ts, ch.id));
        pool = pool.filter(p => p.id !== ch.id);
        if (i < maxTries - 1 && (25 - (Date.now() / 1000 - now)) > 5) continue;
        break;
      }
    }
    if (dbUpdates.length > 0) c.executionCtx.waitUntil(c.env.DB.batch(dbUpdates).catch(e => console.warn("Final DB batch error:", e.message)));
    return errResponse(c, "All attempts failed or timed out", "server_error", 502);
  } catch (e) {
    return errResponse(c, `Gateway Error: ${e.message}`, "server_error", 500);
  }
}

app.post("/v1/chat/completions", async (c) => handleChatRequest(c));

export default app;
