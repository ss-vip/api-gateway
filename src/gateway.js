import { buildUrl, buildEndpointUrl } from "./lib/providers/openai.js";
import {
  BACKOFF_ERROR_THRESHOLD, BACKOFF_429_SECONDS, BACKOFF_MAX_SECONDS,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
  REQUEST_TIMEOUT_SECONDS,
  GLOBAL_TIMEOUT_MS,
} from "./lib/constants.js";
import { bufferRate, getBufferedRate, bufferResponseTime } from "./routes/maintenance.js";

const RACE_TIMEOUT_MS = 5000;
const RACE_MAX_CONCURRENT = 3;
let lastRRIdx = -1;

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

const ENDPOINT_COLUMNS = {
  image_gen: "support_image_gen",
  image_edit: "support_image_edit",
  audio_stt: "support_audio_stt",
  audio_tts: "support_audio_tts",
  embeddings: "support_embeddings",
};

function errResponse(c, message, type, status, code) {
  return c.json({ error: { message, type, param: null, code: code || ERROR_CODE_MAP[type] || type } }, status);
}

let cache = { data: null, ts: 0 };
let cacheFlight = null;
let cacheGen = 0;

// 僅在狀態變更時寫入 D1，跳過 routine 更新
const lastPersistedState = new Map();

async function loadCache(env) {
  const TTL = 60_000;
  if (cache.data && Date.now() - cache.ts < TTL) return cache.data;
  if (!cacheFlight) {
    const gen = cacheGen;
    cacheFlight = (async () => {
      try {
        const [ch, fl, cf] = await Promise.all([
          env.DB.prepare("SELECT * FROM channels WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM filters WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM config WHERE id=1").first(),
        ]);
        if (cacheGen !== gen) return;
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

export function clearCache() {
  cacheGen++;
  cache.data = null;
  cache.ts = 0;
  lastPersistedState.clear();
}

function exponentialCooldown(consecutiveErrors) {
  if (consecutiveErrors <= BACKOFF_ERROR_THRESHOLD) return 0;
  const exponent = Math.min(consecutiveErrors - BACKOFF_ERROR_THRESHOLD, 4);
  return Math.min(BACKOFF_429_SECONDS * Math.pow(2, exponent), BACKOFF_MAX_SECONDS);
}


function getEffectiveRpm(ch) {
  if (!ch.rpm_limit || ch.rpm_limit <= 0) return 0;
  return Math.max(1, Math.round(ch.rpm_limit * (ch.weight || 50) / 50));
}

function selectChannel(channels, originalModel, isStream) {
  const now = Math.floor(Date.now() / 1000);
  const model = (originalModel || '').trim();

  const healthy = channels.filter(ch => {
    if (!ch.is_enabled) return false;
    if (isStream && ch.support_stream === 0) return false;
    if (ch.consecutive_errors >= BACKOFF_ERROR_THRESHOLD &&
        now - (ch.last_error_at || 0) <= exponentialCooldown(ch.consecutive_errors)) return false;
    if (ch.last_429 > 0 && ch.last_429 > now) return false;
    if (ch.cooldown_until > 0 && ch.cooldown_until > now) return false;
    const buf = getBufferedRate(ch.id);
    const rpmCount = buf ? buf.rpmCount : (ch.rpm_count || 0);
    const rpmResetAt = buf ? buf.rpmResetAt : (ch.rpm_reset_at || 0);
    const rpdCount = buf ? buf.rpdCount : (ch.rpd_count || 0);
    const rpdResetAt = buf ? buf.rpdResetAt : (ch.rpd_reset_at || 0);
    if (ch.rpd_limit > 0 && now - rpdResetAt < RPD_WINDOW_SECONDS && rpdCount >= ch.rpd_limit) return false;
    if (ch.rpm_limit > 0) {
      const effectiveRpm = getEffectiveRpm(ch);
      if (now - rpmResetAt < RPM_WINDOW_SECONDS && rpmCount >= effectiveRpm) return false;
      const usage = rpmCount / effectiveRpm;
      if (usage > 0.7 && Math.random() < (usage - 0.7) * 3) return false;
    }
    return true;
  });
  if (healthy.length === 0) return null;

  const allRpm1 = healthy.every(ch => ch.rpm_limit === 1);
  if (allRpm1 && healthy.length > 1) {
    healthy.sort((a, b) => (b.weight || 50) - (a.weight || 50));
    lastRRIdx = (lastRRIdx + 1) % healthy.length;
    return healthy[lastRRIdx];
  }

  const highLoad = healthy.every(ch => {
    if (!ch.rpm_limit) return false;
    const effectiveRpm = getEffectiveRpm(ch);
    if (!effectiveRpm) return false;
    const buf = getBufferedRate(ch.id);
    const cnt = buf ? buf.rpmCount : (ch.rpm_count || 0);
    return cnt / effectiveRpm > 0.5;
  });
  if (highLoad && healthy.length > 1) {
    return healthy.reduce((best, ch) => {
      const load = (getBufferedRate(ch.id)?.rpmCount || 0) / (ch.weight || 50);
      return load < best.load ? { ch, load } : best;
    }, { ch: null, load: Infinity }).ch;
  }

  const rtValues = healthy.map(ch => ch.response_time || 0).filter(v => v > 0);
  const avgRt = rtValues.length > 0 ? rtValues.reduce((s, v) => s + v, 0) / rtValues.length : 0;

  let totalW = 0;
  const weights = [];
  for (const ch of healthy) {
    let w = ch.weight || 50;

    const models = (ch.model || '').split(',').map(s => s.trim()).filter(Boolean);
    const fallbacks = (ch.fallback_model || '').split(',').map(s => s.trim()).filter(Boolean);
    if (models.includes(model)) w *= 10;
    else if (fallbacks.includes(model)) w *= 5;
    else w *= 0.1;

    const err = ch.consecutive_errors || 0;
    if (err >= 4) w *= 0.2;
    else if (err === 3) w *= 0.4;
    else if (err === 2) w *= 0.6;
    else if (err === 1) w *= 0.8;

    const buf = getBufferedRate(ch.id);
    const rpmCount = buf ? buf.rpmCount : (ch.rpm_count || 0);
    const rpdCount = buf ? buf.rpdCount : (ch.rpd_count || 0);
    const effectiveRpm = getEffectiveRpm(ch);
    if (ch.rpm_limit > 0 && effectiveRpm > 0 && rpmCount / effectiveRpm > 0.8) w *= 0.5;
    if (ch.rpd_limit > 0 && rpdCount / ch.rpd_limit > 0.8) w *= 0.5;

    const rt = ch.response_time || 0;
    if (rt > 0 && avgRt > 0) {
      if (rt > avgRt * 2) w *= 0.3;
      else if (rt > avgRt * 1.5) w *= 0.5;
      else if (rt > avgRt * 1.2) w *= 0.75;
    }

    w = Math.max(1, Math.round(w));
    weights.push(w);
    totalW += w;
  }

  let r = Math.random() * totalW;
  for (let i = 0; i < healthy.length; i++) {
    r -= weights[i];
    if (r <= 0) return healthy[i];
  }
  return healthy[healthy.length - 1];
}


function updateRateCounters(ch, nowSec) {
  if (!ch) return;
  if (nowSec - (ch.rpm_reset_at || 0) >= RPM_WINDOW_SECONDS) {
    ch.rpm_count = 0;
    ch.rpm_reset_at = nowSec;
  }
  ch.rpm_count = (ch.rpm_count || 0) + 1;

  if (nowSec - (ch.rpd_reset_at || 0) >= RPD_WINDOW_SECONDS) {
    ch.rpd_count = 0;
    ch.rpd_reset_at = nowSec;
  }
  ch.rpd_count = (ch.rpd_count || 0) + 1;

  bufferRate(ch.id, ch.rpm_count, ch.rpm_reset_at, ch.rpd_count, ch.rpd_reset_at);
}


function persistStateKey(ch) {
  return [
    ch.consecutive_errors || 0,
    ch.last_error_msg || '',
    ch.last_error_at || 0,
    ch.last_429 || 0,
    ch.cooldown_until || 0,
    ch.support_tools ? 1 : 0,
    ch.support_stream === 0 ? 0 : 1,
    ch.is_vision ? 1 : 0,
    ch.support_image_gen ? 1 : 0,
    ch.support_audio_tts ? 1 : 0,
    ch.support_audio_stt ? 1 : 0,
    ch.support_image_edit ? 1 : 0,
  ].join('|');
}

async function persistHealth(db, ch) {
  if (!ch || !ch.id) return;
  const key = persistStateKey(ch);
  if (lastPersistedState.get(ch.id) === key) return;
  try {
    await db.prepare(
      "UPDATE channels SET consecutive_errors=?, last_error_msg=?, last_error_at=?, last_429=?, cooldown_until=?, support_tools=?, support_stream=?, is_vision=?, support_image_gen=?, support_audio_tts=?, support_audio_stt=?, support_image_edit=? WHERE id=?"
    ).bind(
      ch.consecutive_errors || 0,
      ch.last_error_msg || '', ch.last_error_at || 0,
      ch.last_429 || 0, ch.cooldown_until || 0,
      ch.support_tools ? 1 : 0,
      ch.support_stream === 0 ? 0 : 1,
      ch.is_vision ? 1 : 0,
      ch.support_image_gen ? 1 : 0,
      ch.support_audio_tts ? 1 : 0,
      ch.support_audio_stt ? 1 : 0,
      ch.support_image_edit ? 1 : 0,
      ch.id
    ).run();
    lastPersistedState.set(ch.id, key);
  } catch (e) { console.error("[persist] health:", ch.id, e.message); }
}

function deferPersist(c, ch) {
  persistHealth(c.env, ch);
}

// ─── 模型列表端點 ───────────────────────────────────────────────────

async function handleModels(c) {
  try {
    let data;
    try { data = await loadCache(c.env); } catch (e) { data = cache.data; }
    if (!data) data = await loadCache(c.env).catch(() => null);
    if (!data) return errResponse(c, "Unable to load configuration", "server_error", 500);

    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Incorrect API key provided", "invalid_request_error", 401, "invalid_api_key");
    }

    const models = new Set();
    data.channels.filter(ch => ch.is_enabled).forEach(ch => {
      if (ch.model) ch.model.split(',').map(m => m.trim()).filter(Boolean).forEach(m => models.add(m));
    });

    const list = Array.from(models).map(m => ({
      id: m,
      object: "model",
      created: 1686935002,
      owned_by: "api-gateway"
    }));

    return c.json({ object: "list", data: list });
  } catch (e) {
    return errResponse(c, "Server error", "server_error", 500);
  }
}


function removePoolItem(pool, ch) {
  const idx = pool.indexOf(ch);
  if (idx !== -1) pool.splice(idx, 1);
}

function truncateErrorBody(text) {
  if (!text || typeof text !== "string") return text || "";
  if (text.length <= 8192) return text;
  return text.slice(0, 8192) + "... [truncated]";
}

function hasVisionContent(body) {
  if (!body?.messages) return false;
  for (const msg of body.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "image_url") return true;
      }
    }
    if (msg?.content && typeof msg.content === "string" && msg.content.includes("data:image/")) return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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


function hasTools(body) {
  return body.tools && Array.isArray(body.tools) && body.tools.length > 0;
}

function shouldSimulateTools(body) {
  // tool_choice:"none" = client opts out
  return hasTools(body) && body.tool_choice !== "none";
}

let idCounter = 0;
function nextToolCallId() {
  const ts = Date.now().toString(36);
  const counter = (++idCounter % 1e6).toString(36).padStart(4, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return "call_" + ts + counter + rand;
}

function formatToolSchema(tool) {
  const fn = tool.function || {};
  let desc = `- ${fn.name}: ${fn.description || 'No description'}`;
  if (fn.parameters) {
    try {
      const params = typeof fn.parameters === "string" ? JSON.parse(fn.parameters) : fn.parameters;
      const props = params.properties || {};
      const required = params.required || [];
      const propLines = Object.entries(props).map(([k, v]) => {
        const req = required.includes(k) ? " (required)" : "";
        const typeDesc = (v.type === "object" && v.properties)
          ? "object (" + Object.keys(v.properties).join(", ") + ")"
          : v.description || v.type || "any";
        return `    ${k}${req}: ${typeDesc}`;
      });
      desc += "\n  Parameters:\n" + propLines.join("\n");
    } catch (e) { /* skip if unparseable */ }
  }
  return desc;
}

function extractJsonFromContent(content) {
  if (!content) return null;
  const trimmed = content.trim();

  // Fast path: pure JSON
  try { return JSON.parse(trimmed); } catch (e) {}

  // Markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (e) {}
  }

  // Depth-match first { or [ across string-aware scan
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const start = (firstBrace === -1 && firstBracket === -1) ? -1
    : (firstBrace === -1) ? firstBracket
    : (firstBracket === -1) ? firstBrace
    : Math.min(firstBrace, firstBracket);
  if (start === -1) return null;

  const endChar = trimmed[start] === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function prepareRequestBody(body, ch, originalModel) {
  const reqBody = { ...body, model: ch.model || originalModel };

  if (shouldSimulateTools(body) && !ch.support_tools) {
    delete reqBody.tools;
    const toolDesc = (body.tools || []).map(formatToolSchema).join('\n');
    const toolInstruction =
      `You have access to these tools:\n${toolDesc}\n\n` +
      `When you need to call a tool, respond ONLY with JSON: {"tool":"name","arguments":{...}} or ` +
      `an array [{"tool":"name","arguments":{...}}] for multiple tools. ` +
      `"name" is the tool name and "arguments" is an object with the required parameters. ` +
      `Otherwise respond normally.`;

    const msgs = body.messages || [];
    if (msgs.length > 0 && msgs[0].role === "system") {
      reqBody.messages = [
        { role: "system", content: msgs[0].content + "\n\n" + toolInstruction },
        ...msgs.slice(1),
      ];
    } else {
      reqBody.messages = [
        { role: "system", content: toolInstruction },
        ...msgs,
      ];
    }
  }

  if (ch.max_tokens > 0) {
    reqBody.max_tokens = ch.max_tokens;
  }

  return reqBody;
}

function wrapToolResponse(json, ch, body) {
  if (!hasTools(body) || ch.support_tools) return json;
  const msg = json?.choices?.[0]?.message;
  if (!msg?.content) return json;

  const parsed = extractJsonFromContent(msg.content);
  if (!parsed) return json;

  const toolCalls = [];
  const items = Array.isArray(parsed) ? parsed : [parsed];

  for (const item of items) {
    if (item && typeof item === 'object' && item.tool && item.arguments) {
      toolCalls.push({
        id: nextToolCallId(),
        type: "function",
        function: { name: item.tool, arguments: JSON.stringify(item.arguments) },
      });
    }
  }

  if (toolCalls.length > 0) {
    json.choices[0].message = {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    };
    json.choices[0].finish_reason = "tool_calls";
    const origContent = msg.content || "";
    if (json.usage) {
      json.usage.completion_tokens = (json.usage.completion_tokens || 0) + origContent.length;
    }
  }

  return json;
}


function buildChannelConfig(ch, body, originalModel, deadline, stream) {
  const effectiveModel = ch.model || originalModel || "gpt-4o";
  const url = ch.absolute_url ? ch.base_url : buildUrl(ch.base_url, effectiveModel, stream);
  if (!url) return null;

  const reqBody = prepareRequestBody(body, ch, originalModel);

  let channelHeaders = {};
  if (ch.headers && typeof ch.headers === "object") channelHeaders = ch.headers;
  else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch (e) {}

  const requestHeaders = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + ch.api_key,
    ...channelHeaders,
  };
  if (!requestHeaders.Authorization) delete requestHeaders.Authorization;

  const remainingMs = Math.max(2000, deadline - Date.now());
  const chTimeout = Math.min(remainingMs, REQUEST_TIMEOUT_SECONDS * 1000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), chTimeout);

  return { effectiveModel, url, reqBody, requestHeaders, controller, timeoutId };
}

function markChannelError(ch, status, errMsg, responseTime, data) {
  ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
  ch.last_error_at = Math.floor(Date.now() / 1000);
  ch.last_error_msg = truncateErrorBody(errMsg || ("HTTP " + status));
  ch.response_time = responseTime || 0;
  if (status === 429) {
    ch.last_429 = Math.floor(Date.now() / 1000) + (data?.config?.recovery_period || 300);
  }
}


function pickChannels(pool, originalModel, maxCount, isStream) {
  const picked = [];
  for (let i = 0; i < maxCount && pool.length > 0; i++) {
    const ch = selectChannel(pool, originalModel, isStream);
    if (!ch) break;
    removePoolItem(pool, ch);
    picked.push(ch);
  }
  return picked;
}


function sseEvent(w, enc, data) {
  return w.write(enc.encode("data: " + JSON.stringify(data) + "\n\n"));
}

function buildErrorChunk(msg) {
  return {
    id: "chatcmpl-" + Date.now(), object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { content: "\n\n" + msg }, finish_reason: "stop" }],
  };
}

async function writeStreamError(w, enc, msg) {
  try {
    await sseEvent(w, enc, buildErrorChunk(msg));
  } catch (e) {}
  try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e) {}
}


function abortAll(infos) {
  for (const info of infos) {
    clearTimeout(info.timeoutId);
    info.controller.abort();
  }
}


async function writeSimulatedStream(w, enc, json) {
  try {
    const msg = json?.choices?.[0]?.message;
    const finishReason = json?.choices?.[0]?.finish_reason || "stop";
    const id = json.id || ("chatcmpl-" + Date.now());
    const created = json.created || Math.floor(Date.now() / 1000);
    const model = json.model || "";

    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: { tool_calls: msg.tool_calls.map(tc => ({
            index: 0, id: tc.id, type: tc.type,
            function: tc.function,
          }))},
          finish_reason: "tool_calls",
        }],
      });
    } else if (msg?.content) {
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: msg.content }, finish_reason }],
      });
    }

    if (json.usage) {
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [],
        usage: json.usage,
      });
    }

    await w.write(enc.encode("data: [DONE]\n\n"));
  } catch (e) {
    try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e2) {}
  }
}


async function raceStream(c, pool, body, originalModel, data, w, enc, requestDeadline) {
  const hasVision = hasVisionContent(body);
  const picked = pickChannels(pool, originalModel, RACE_MAX_CONCURRENT, true);
  if (picked.length === 0) {
    await writeStreamError(w, enc, "No available channels — all upstream services are in cooldown, rate-limited, or disabled");
    return;
  }

  let resolveWinner;
  const winnerOrFail = new Promise((resolve) => { resolveWinner = resolve; });

  const allInfos = [];
  let settled = false;

  function settle(winner) {
    if (settled) return;
    settled = true;
    abortAll(allInfos);
    resolveWinner(winner);
  }

  // Client disconnect → abort all in-flight
  const clientSignal = c.req.raw.signal;
  if (clientSignal.aborted) {
    settled = true;
    abortAll(allInfos);
    resolveWinner(null);
  } else {
    clientSignal.addEventListener('abort', () => {
      if (!settled) { settled = true; abortAll(allInfos); resolveWinner(null); }
    }, { once: true });
  }

  const needToolSim = shouldSimulateTools(body);

  function startChannel(ch, delay) {
    return (async () => {
      if (delay > 0) await sleep(delay);
      if (settled) return null;

      const cfg = buildChannelConfig(ch, body, originalModel, requestDeadline, true);
      if (!cfg) { removePoolItem(pool, ch); return null; }
      allInfos.push({ controller: cfg.controller, timeoutId: cfg.timeoutId });
      if (settled) { resolve(null); return; }

      // Force non-stream for tool simulation
      const needSim = needToolSim && !ch.support_tools;
      if (needSim) {
        cfg.reqBody.stream = false;
      }

      const startTime = Date.now();
      try {
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: cfg.requestHeaders,
          body: JSON.stringify(cfg.reqBody),
          signal: cfg.controller.signal,
        });
        clearTimeout(cfg.timeoutId);
        const rt = Date.now() - startTime;

        if (settled) return null;

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          markChannelError(ch, res.status, errBody, rt, data);
          deferPersist(c, ch);
          return null;
        }

        // ── 工具模擬路徑：全量讀取 → 包裝 → 模擬串流 ──
        if (needSim) {
          const resText = await res.text();
          if (resText.length > 4 * 1024 * 1024) return null;
          let json;
          try { json = JSON.parse(resText); } catch (e) { return null; }
          json = wrapToolResponse(json, ch, body);
          updateRateCounters(ch, Math.floor(Date.now() / 1000));
          ch.consecutive_errors = 0;
          ch.last_error_msg = "";
          ch.last_error_at = 0;
          ch.response_time = rt;
          bufferResponseTime(ch.id, rt);
          if (hasVision && !ch.is_vision) ch.is_vision = 1;
          deferPersist(c, ch);
          settle({ ch, simulatedJson: json, responseTime: rt, isSimulated: true });
          return { isSimulated: true, json };
        }

        settle({ ch, res, cfg, responseTime: rt, isSimulated: false });
        return { isSimulated: false, res, cfg };
      } catch (e) {
        clearTimeout(cfg.timeoutId);
        if (settled) return null;
        markChannelError(ch, null, e.message, Date.now() - startTime, data);
        if (e.name === 'AbortError') {
          ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors || 0), 60);
        }
        deferPersist(c, ch);
        return null;
      }
    })();
  }

  // Phase 1: 主渠道立即開始
  const primaryPromise = startChannel(picked[0], 0);

  // Phase 2: RACE_TIMEOUT 後啟動次要
  let backupStarted = false;
  const raceTimer = sleep(RACE_TIMEOUT_MS).then(() => {
    if (settled) return;
    backupStarted = true;
    const backups = [];
    for (let i = 1; i < picked.length; i++) {
      backups.push(startChannel(picked[i], 0));
    }
    return Promise.all(backups);
  });

  const primaryResult = await primaryPromise;

  if (primaryResult) {
    if (primaryResult.isSimulated) {
      await writeSimulatedStream(w, enc, primaryResult.json);
      return;
    }
    const winner = await winnerOrFail;
    await streamChannelResponse(c, winner, data, w, enc, hasVision);
    return;
  }

  if (!backupStarted) await raceTimer;

  const winner = await Promise.race([
    winnerOrFail,
    new Promise(r => setTimeout(r, 30000)).then(() => null),
  ]);

  if (winner) {
    if (winner.isSimulated) {
      await writeSimulatedStream(w, enc, winner.simulatedJson);
      return;
    }
    await streamChannelResponse(c, winner, data, w, enc, hasVision);
    return;
  }

  await fallbackSequential(c, pool, body, originalModel, data, w, enc, requestDeadline, hasVision);
}

async function streamChannelResponse(c, winner, data, w, enc, hasVision) {
  const { ch, res, responseTime } = winner;

  updateRateCounters(ch, Math.floor(Date.now() / 1000));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let streamHadContent = false;
  let streamError = null;
  const contentFilter = new RollingFilter(data.filters || []);
  const clientSignal = c.req.raw.signal;

  try {
    let lastLine = "";
    let streamDone = false;
    while (!streamDone && !clientSignal.aborted) {
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
            await sseEvent(w, enc, {
              id: "chatcmpl-" + Date.now(), object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              choices: [{ index: 0, delta: { content: tail }, finish_reason: "stop" }],
            });
          }
          try { await w.write(enc.encode(line + "\n\n")); } catch (e) {}
          streamDone = true; break;
        }

        try {
          const colonIdx = line.indexOf(":");
          const jsonStr = line.slice(colonIdx + 1).trim();
          const chunk = JSON.parse(jsonStr);
          const delta = chunk?.choices?.[0]?.delta;
          if (delta?.content || delta?.tool_calls) streamHadContent = true;

          if (delta?.content) {
            const filtered = contentFilter.transform(delta.content);
            if (filtered) {
              delta.content = filtered;
              await sseEvent(w, enc, chunk);
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

    if (!streamHadContent) {
      ch.last_error_msg = "Empty response (no content)";
      ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
      ch.last_error_at = Math.floor(Date.now() / 1000);
      deferPersist(c, ch);
      await writeStreamError(w, enc, "The upstream service returned an empty response — no content was generated");
      return;
    }

    if (!lastLine.includes("[DONE]")) {
      try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e) {}
    }
  } catch (e) {
    streamError = e;
    console.error("[stream] read error:", ch.id, e.message);
    ch.last_error_msg = "Stream error: " + e.message.slice(0, 120);
    ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
    ch.last_error_at = Math.floor(Date.now() / 1000);
    deferPersist(c, ch);
    try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e2) {}
  }

  if (streamHadContent && !streamError) {
    ch.consecutive_errors = 0;
    ch.last_error_msg = "";
    ch.last_error_at = 0;
    ch.response_time = responseTime;
    bufferResponseTime(ch.id, responseTime);
    if (hasVision && !ch.is_vision) ch.is_vision = 1;
    deferPersist(c, ch);
  }
}


async function fallbackSequential(c, pool, body, originalModel, data, w, enc, requestDeadline, hasVision) {
  let lastError = "";
  const clientSignal = c.req.raw.signal;
  const needToolSim = shouldSimulateTools(body);

  while (pool.length > 0 && Date.now() < requestDeadline && !clientSignal.aborted) {
    const ch = selectChannel(pool, originalModel, true);
    if (!ch) { lastError = "all channels in cooldown or rate-limited"; break; }
    removePoolItem(pool, ch);

    const cfg = buildChannelConfig(ch, body, originalModel, requestDeadline, true);
    if (!cfg) continue;

    // Force non-stream for tool simulation
    const needSim = needToolSim && !ch.support_tools;
    if (needSim) {
      cfg.reqBody.stream = false;
    }

    const fetchStart = Date.now();
    try {
      const res = await fetch(cfg.url, {
        method: "POST", headers: cfg.requestHeaders,
        body: JSON.stringify(cfg.reqBody), signal: cfg.controller.signal,
      });
      clearTimeout(cfg.timeoutId);
      const rt = Date.now() - fetchStart;

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        markChannelError(ch, res.status, errBody, rt, data);
        deferPersist(c, ch);
        continue;
      }

      if (needSim) {
        const resText = await res.text();
        if (resText.length > 4 * 1024 * 1024) continue;
        let json;
        try { json = JSON.parse(resText); } catch (e) { continue; }
        json = wrapToolResponse(json, ch, body);
        updateRateCounters(ch, Math.floor(Date.now() / 1000));
        ch.consecutive_errors = 0;
        ch.response_time = rt;
        bufferResponseTime(ch.id, rt);
        if (hasVision && !ch.is_vision) ch.is_vision = 1;
        deferPersist(c, ch);
        await writeSimulatedStream(w, enc, json);
        return;
      }

      const winner = { ch, res, cfg, responseTime: rt };
      await streamChannelResponse(c, winner, data, w, enc, hasVision);
      return;
    } catch (e) {
      clearTimeout(cfg.timeoutId);
      const rt = Date.now() - fetchStart;
      markChannelError(ch, null, e.message, rt, data);
      if (e.name === 'AbortError') {
        ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors || 0), 60);
      }
      deferPersist(c, ch);
      lastError = (e.message || "Request failed").slice(0, 200);
    }
  }

  await writeStreamError(w, enc, "All upstream channels failed" + (lastError ? ": " + lastError : ""));
}


async function raceNonStream(c, pool, body, originalModel, data, requestDeadline) {
  const hasVision = hasVisionContent(body);
  const picked = pickChannels(pool, originalModel, RACE_MAX_CONCURRENT, false);
  if (picked.length === 0) {
    return errResponse(c, "No available channels — all upstream services are in cooldown, rate-limited, or disabled", "server_error", 503);
  }

  let resolveWinner;
  const winnerOrFail = new Promise((resolve) => { resolveWinner = resolve; });

  const allInfos = [];
  let settled = false;

  function settle(winner) {
    if (settled) return;
    settled = true;
    abortAll(allInfos);
    resolveWinner(winner);
  }

  // Client disconnect → abort all in-flight
  const clientSignal = c.req.raw.signal;
  if (clientSignal.aborted) {
    settled = true;
    abortAll(allInfos);
    resolveWinner(null);
  } else {
    clientSignal.addEventListener('abort', () => {
      if (!settled) { settled = true; abortAll(allInfos); resolveWinner(null); }
    }, { once: true });
  }

  function tryChannel(ch, delay) {
    return (async () => {
      if (delay > 0) await sleep(delay);
      if (settled) return null;

      const cfg = buildChannelConfig(ch, body, originalModel, requestDeadline, false);
      if (!cfg) return null;
      allInfos.push({ controller: cfg.controller, timeoutId: cfg.timeoutId });
      if (settled) { resolve(null); return; }

      const startTime = Date.now();
      try {
        const res = await fetch(cfg.url, {
          method: "POST", headers: cfg.requestHeaders,
          body: JSON.stringify(cfg.reqBody), signal: cfg.controller.signal,
        });
        clearTimeout(cfg.timeoutId);
        const rt = Date.now() - startTime;

        if (settled) return null;

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          markChannelError(ch, res.status, errBody, rt, data);
          deferPersist(c, ch);
          return null;
        }

        const resText = await res.text();
        if (resText.length > 4 * 1024 * 1024) return null;

        let json = JSON.parse(resText);
        json = wrapToolResponse(json, ch, body);

        const choice = json?.choices?.[0];
        if (choice && !choice.message?.content && !choice.message?.tool_calls && choice.finish_reason === "stop") {
          ch.last_error_msg = "Empty response (no content)";
          ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
          ch.last_error_at = Math.floor(Date.now() / 1000);
          deferPersist(c, ch);
          return null;
        }

        settle({ ch, json, responseTime: rt });
        return { ch, json, responseTime: rt };
      } catch (e) {
        clearTimeout(cfg.timeoutId);
        if (settled) return null;
        markChannelError(ch, null, e.message, Date.now() - startTime, data);
        if (e.name === 'AbortError') {
          ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors || 0), 60);
        }
        deferPersist(c, ch);
        return null;
      }
    })();
  }

  // Phase 1: 主渠道立即
  const primaryPromise = tryChannel(picked[0], 0);

  // Phase 2: RACE_TIMEOUT 後啟動次要
  let backupStarted = false;
  const raceTimer = sleep(RACE_TIMEOUT_MS).then(() => {
    if (settled) return;
    backupStarted = true;
    const backups = [];
    for (let i = 1; i < picked.length; i++) {
      backups.push(tryChannel(picked[i], 0));
    }
    return Promise.all(backups);
  });

  const primaryResult = await primaryPromise;
  if (primaryResult) {
    return finalizeNonStream(c, primaryResult, data, hasVision);
  }

  if (!backupStarted) await raceTimer;

  const winner = await Promise.race([
    winnerOrFail,
    new Promise(r => setTimeout(r, 30000)).then(() => null),
  ]);

  if (winner) {
    return finalizeNonStream(c, winner, data, hasVision);
  }

  return fallbackNonStreamSequential(c, pool, body, originalModel, data, requestDeadline, hasVision);
}

function finalizeNonStream(c, winner, data, hasVision) {
  const { ch, json, responseTime } = winner;
  updateRateCounters(ch, Math.floor(Date.now() / 1000));
  ch.consecutive_errors = 0;
  ch.last_error_msg = "";
  ch.last_error_at = 0;
  ch.response_time = responseTime;
  bufferResponseTime(ch.id, responseTime);
  if (hasVision && !ch.is_vision) ch.is_vision = 1;
  deferPersist(c, ch);

  if (json?.choices?.[0]?.message?.content && data.filters?.length > 0) {
    json.choices[0].message.content = RollingFilter.applyStatic(
      json.choices[0].message.content, data.filters
    );
  }
  return c.json(json);
}


async function fallbackNonStreamSequential(c, pool, body, originalModel, data, requestDeadline, hasVision) {
  const clientSignal = c.req.raw.signal;
  while (pool.length > 0 && Date.now() < requestDeadline && !clientSignal.aborted) {
    const ch = selectChannel(pool, originalModel, false);
    if (!ch) return errResponse(c, "All channels are rate-limited or temporarily unavailable — please wait before retrying", "rate_limit_error", 429);
    removePoolItem(pool, ch);

    const cfg = buildChannelConfig(ch, body, originalModel, requestDeadline, false);
    if (!cfg) continue;

    const startTime = Date.now();
    try {
      const res = await fetch(cfg.url, {
        method: "POST", headers: cfg.requestHeaders,
        body: JSON.stringify(cfg.reqBody), signal: cfg.controller.signal,
      });
      clearTimeout(cfg.timeoutId);
      const rt = Date.now() - startTime;

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        markChannelError(ch, res.status, errText, rt, data);
        deferPersist(c, ch);
        continue;
      }

      const resText = await res.text();
      if (resText.length > 4 * 1024 * 1024) {
        return errResponse(c, "The response from the upstream server exceeded the maximum allowed size", "server_error", 502);
      }
      let json = JSON.parse(resText);
      json = wrapToolResponse(json, ch, body);

      const choice = json?.choices?.[0];
      if (choice && !choice.message?.content && !choice.message?.tool_calls && choice.finish_reason === "stop") {
        ch.last_error_msg = "Empty response (no content)";
        ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
        ch.last_error_at = Math.floor(Date.now() / 1000);
        deferPersist(c, ch);
        continue;
      }

      return finalizeNonStream(c, { ch, json, responseTime: rt }, data, hasVision);
    } catch (e) {
      clearTimeout(cfg.timeoutId);
      markChannelError(ch, null, e.message, Date.now() - startTime, data);
      if (e.name === 'AbortError') {
        ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors || 0), 60);
      }
      deferPersist(c, ch);
    }
  }
  return errResponse(c, "All upstream channels failed or the request timed out after " + (GLOBAL_TIMEOUT_MS / 1000) + "s", "server_error", 504);
}


async function handleChatRequest(c) {
  try {
    const data = await loadCache(c.env).catch(() => null);
    if (!data) return errResponse(c, "Unable to load configuration — the database is temporarily unavailable", "server_error", 500);

    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Incorrect API key provided", "invalid_request_error", 401, "invalid_api_key");
    }

    let body;
    try { body = await c.req.json(); } catch (e) {
      return errResponse(c, "We could not parse the JSON body of your request", "invalid_request_error", 400);
    }

    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return errResponse(c, "'messages' is required and must contain at least one message", "invalid_request_error", 400);
    }

    const originalModel = body.model;
    const isStream = body.stream !== false;

    // 淺拷貝 pool 隔離各 request 的 channel mutation，避免併發汙染快取
    let pool = data.channels.filter((ch) => ch.is_enabled).map(ch => ({ ...ch }));
    if (pool.length === 0) return errResponse(c, "No available channels — all upstream services are in cooldown, rate-limited, or disabled", "server_error", 503);

    const requestDeadline = Date.now() + GLOBAL_TIMEOUT_MS;

    if (isStream) {
      const { readable: out, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();

      // 立即送出初始 chunk，表示連線存活
      const initChunk = {
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: originalModel || "unknown",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      };
      w.write(enc.encode("data: " + JSON.stringify(initChunk) + "\n\n")).catch(() => {});

      c.executionCtx.waitUntil((async () => {
        await raceStream(c, pool, body, originalModel, data, w, enc, requestDeadline);
        try { await w.close(); } catch (e) {}
      })());

      return new Response(out, { headers: SSE_CHUNK_HEADERS });
    }

    return await raceNonStream(c, pool, body, originalModel, data, requestDeadline);

  } catch (e) {
    console.error("[gateway] unhandled:", e.message);
    return errResponse(c, "The server had an error processing your request", "server_error", 500);
  }
}


async function proxyEndpoint(c, endpointType) {
  try {
    const data = await loadCache(c.env).catch(() => null);
    if (!data) return errResponse(c, "Unable to load configuration — the database is temporarily unavailable", "server_error", 500);

    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Incorrect API key provided", "invalid_request_error", 401, "invalid_api_key");
    }

    let pool = data.channels.filter(ch => ch.is_enabled).map(ch => ({ ...ch }));
    if (pool.length === 0) {
      return errResponse(c, "No available channels — all upstream services are in cooldown, rate-limited, or disabled", "server_error", 503);
    }

    const col = ENDPOINT_COLUMNS[endpointType];
    if (col) {
      pool = pool.filter(ch => ch[col] === 1);
    }
    if (pool.length === 0) {
      return errResponse(c, "No available channels support this endpoint type", "invalid_request_error", 400, "unsupported_endpoint");
    }

    const requestDeadline = Date.now() + GLOBAL_TIMEOUT_MS;
    
    // Buffer body for retries
    const reqBodyBuffer = await c.req.arrayBuffer();
    
    let lastError = "";
    
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const ch = selectChannel(pool, "", false);
      if (!ch) break;

      const url = buildEndpointUrl(ch.base_url, endpointType);
      if (!url) {
        removePoolItem(pool, ch);
        continue;
      }

      const remainingMs = Math.max(2000, requestDeadline - Date.now());
      const chTimeout = Math.min(remainingMs, REQUEST_TIMEOUT_SECONDS * 1000);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), chTimeout);

      let channelHeaders = {};
      if (ch.headers && typeof ch.headers === "object") channelHeaders = ch.headers;
      else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch (e) {}
      const reqHeaders = { Authorization: "Bearer " + ch.api_key, ...channelHeaders };
      const ct = c.req.header("Content-Type");
      if (ct) {
        reqHeaders["Content-Type"] = ct;
      } else if (endpointType === "image_gen" || endpointType === "audio_tts" || endpointType === "embeddings") {
        reqHeaders["Content-Type"] = "application/json";
      }

      const startTime = Date.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: reqHeaders,
          body: reqBodyBuffer,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const rt = Date.now() - startTime;

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          markChannelError(ch, res.status, errBody, rt, data);
          deferPersist(c, ch);
          removePoolItem(pool, ch);
          lastError = errBody.slice(0, 200);
          continue;
        }

        updateRateCounters(ch, Math.floor(Date.now() / 1000));
        ch.consecutive_errors = 0;
        ch.last_error_msg = "";
        ch.last_error_at = 0;
        ch.response_time = rt;
        bufferResponseTime(ch.id, rt);
        deferPersist(c, ch);

        const responseHeaders = { "Content-Type": res.headers.get("Content-Type") || "application/json" };
        for (const h of ["cache-control", "x-request-id", "openai-version", "openai-organization"]) {
          const v = res.headers.get(h);
          if (v) responseHeaders[h] = v;
        }
        return new Response(res.body, { status: 200, headers: responseHeaders });
      } catch (e) {
        clearTimeout(timeoutId);
        markChannelError(ch, null, e.message, Date.now() - startTime, data);
        if (e.name === 'AbortError') {
          ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors || 0), 60);
        }
        deferPersist(c, ch);
        removePoolItem(pool, ch);
        lastError = e.message;
        continue;
      }
    }

    if (lastError) {
      return errResponse(c, "All available channels failed: " + lastError, "server_error", 502);
    }
    return errResponse(c, "All channels are rate-limited or temporarily unavailable", "rate_limit_error", 429);
  } catch (e) {
    console.error("[proxy] unhandled:", e.message);
    return errResponse(c, "The server had an error processing your request", "server_error", 500);
  }
}

export default function registerGateway(app) {
  app.post("/chat/completions", async (c) => handleChatRequest(c));
  app.post("/v1/chat/completions", async (c) => handleChatRequest(c));
  for (const p of ["/models", "/v1/models"]) app.get(p, async (c) => handleModels(c));
  for (const p of ["/images/generations", "/v1/images/generations"]) app.post(p, async (c) => proxyEndpoint(c, "image_gen"));
  for (const p of ["/audio/speech", "/v1/audio/speech"]) app.post(p, async (c) => proxyEndpoint(c, "audio_tts"));
  for (const p of ["/audio/transcriptions", "/v1/audio/transcriptions"]) app.post(p, async (c) => proxyEndpoint(c, "audio_stt"));
  for (const p of ["/images/edits", "/v1/images/edits"]) app.post(p, async (c) => proxyEndpoint(c, "image_edit"));
  for (const p of ["/embeddings", "/v1/embeddings"]) app.post(p, async (c) => proxyEndpoint(c, "embeddings"));
}
