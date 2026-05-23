import { buildUrl, buildEndpointUrl } from "./lib/providers/openai.js";
import {
  BACKOFF_ERROR_THRESHOLD, BACKOFF_429_SECONDS, BACKOFF_MAX_SECONDS,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
  getRequestTimeout, getGlobalTimeout,
} from "./lib/constants.js";
import { bufferRate, getBufferedRate, logRequest } from "./routes/maintenance.js";
import { SSE_CHUNK_HEADERS, RollingFilter, sseEvent, sseComment, writeStreamError, writeSimulatedStream } from "./lib/sse.js";
import { requestId, logStructured, errResponse, hasVisionContent, estimateInputTokens, tryRepairChatJson } from "./lib/request.js";
import { shouldSimulateTools, prepareRequestBody, processXmlToolCallStream, extractXmlToolCallsFromContent } from "./lib/tool-sim.js";

let cache = { data: null, ts: 0 };
let cacheFlight = null;
let cacheGen = 0;

const lastPersistedState = new Map();

// C3: 批次健康寫入 — 累積後在一次 batch 中寫入 D1，而非每次變更都寫
const pendingHealth = new Map();

const EWMA_ALPHA = 0.3;
const ewmaLatency = new Map();

/** Phase-in recovery constant: on first success after cooldown, set errors here */
const PHASE_IN_ERRORS = 2;

function applySuccess(ch) {
  const prev = ch.consecutive_errors || 0;
  // Half-open / cooldown zone: don't jump to full health, phase-in gradually
  if (prev >= BACKOFF_ERROR_THRESHOLD) {
    ch.consecutive_errors = PHASE_IN_ERRORS;
    return;
  }
  ch.consecutive_errors = Math.max(0, prev - 1);
}

function updateEwma(chId, rt) {
  const prev = ewmaLatency.get(chId);
  const smoothed = prev !== undefined ? EWMA_ALPHA * rt + (1 - EWMA_ALPHA) * prev : rt;
  ewmaLatency.set(chId, smoothed);
  return smoothed;
}

function getEwmaLatency(chId) {
  return ewmaLatency.get(chId);
}

async function retry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, i)));
    }
  }
}

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
        logStructured("error", "cache load failed", { error: e.message });
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
  ewmaLatency.clear();
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

function normalizeRateWindow(count, resetAt, windowSeconds, now) {
  const reset = Number(resetAt || 0);
  const value = Number(count || 0);
  if (!reset || reset > now + windowSeconds) return { count: 0, resetAt: now, active: false };
  if (now - reset >= windowSeconds) return { count: 0, resetAt: now, active: false };
  return { count: value, resetAt: reset, active: true };
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
  ].join('|');
}

async function flushHealthWrites(env) {
  if (pendingHealth.size === 0) return;
  const batch = [];
  for (const [id, ch] of pendingHealth) {
    const key = persistStateKey(ch);
    if (lastPersistedState.get(id) === key) continue;
    batch.push(
      env.DB.prepare(
        "UPDATE channels SET consecutive_errors=?, last_error_msg=?, last_error_at=?, last_429=?, cooldown_until=?, support_tools=?, support_stream=?, is_vision=? WHERE id=?"
      ).bind(
        ch.consecutive_errors || 0,
        ch.last_error_msg || '', ch.last_error_at || 0,
        ch.last_429 || 0, ch.cooldown_until || 0,
        ch.support_tools ? 1 : 0,
        ch.support_stream === 0 ? 0 : 1,
        ch.is_vision ? 1 : 0,
        id
      )
    );
    lastPersistedState.set(id, key);
  }
  pendingHealth.clear();
  if (batch.length > 0) await retry(() => env.DB.batch(batch));
}

function deferPersist(c, ch) {
  if (!ch || !ch.id) return;
  pendingHealth.set(ch.id, { ...ch });
}

function selectChannel(channels, originalModel, isStream, body) {
  const now = Math.floor(Date.now() / 1000);
  const model = (originalModel || '').trim();

  const inputTokens = estimateInputTokens(body);

  const healthy = channels.filter(ch => {
    if (!ch.is_enabled) return false;
    if (isStream && ch.support_stream === 0) return false;
    if (ch.max_tokens > 0 && inputTokens >= ch.max_tokens) return false;
    const errs = ch.consecutive_errors || 0;

    if (errs >= BACKOFF_ERROR_THRESHOLD &&
        now - (ch.last_error_at || 0) <= exponentialCooldown(errs)) return false;

    if (ch.last_429 > 0 && ch.last_429 > now) return false;
    if (ch.cooldown_until > 0 && ch.cooldown_until > now) return false;
    const buf = getBufferedRate(ch.id);
    const rpm = normalizeRateWindow(buf ? buf.rpmCount : ch.rpm_count, buf ? buf.rpmResetAt : ch.rpm_reset_at, RPM_WINDOW_SECONDS, now);
    const rpd = normalizeRateWindow(buf ? buf.rpdCount : ch.rpd_count, buf ? buf.rpdResetAt : ch.rpd_reset_at, RPD_WINDOW_SECONDS, now);
    if (ch.rpd_limit > 0 && rpd.active && rpd.count >= ch.rpd_limit) return false;
    if (ch.rpm_limit > 0) {
      const effectiveRpm = getEffectiveRpm(ch);
      if (rpm.active && rpm.count >= effectiveRpm) return false;
      const usage = rpm.active ? rpm.count / effectiveRpm : 0;
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
    const rpm = normalizeRateWindow(buf ? buf.rpmCount : ch.rpm_count, buf ? buf.rpmResetAt : ch.rpm_reset_at, RPM_WINDOW_SECONDS, now);
    if (!rpm.active) return false;
    return rpm.count / effectiveRpm > 0.5;
  });
  if (highLoad && healthy.length > 1) {
    return healthy.reduce((best, ch) => {
      const load = (getBufferedRate(ch.id)?.rpmCount || 0) / (ch.weight || 50);
      return load < best.load ? { ch, load } : best;
    }, { ch: null, load: Infinity }).ch;
  }

  const rtValues = healthy.map(ch => getEwmaLatency(ch.id) || ch.response_time || 0).filter(v => v > 0);
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
    // Half-open: cooldown expired but still high error count → probe with minimal weight
    if (err >= BACKOFF_ERROR_THRESHOLD) {
      w *= 0.05;
    } else if (err >= 4) w *= 0.2;
    else if (err === 3) w *= 0.4;
    else if (err === 2) w *= 0.6;
    else if (err === 1) w *= 0.8;

    if (body && shouldSimulateTools(body) && ch.support_tools) w *= 5;

    const buf = getBufferedRate(ch.id);
    const rpm = normalizeRateWindow(buf ? buf.rpmCount : ch.rpm_count, buf ? buf.rpmResetAt : ch.rpm_reset_at, RPM_WINDOW_SECONDS, now);
    const rpd = normalizeRateWindow(buf ? buf.rpdCount : ch.rpd_count, buf ? buf.rpdResetAt : ch.rpd_reset_at, RPD_WINDOW_SECONDS, now);
    const effectiveRpm = getEffectiveRpm(ch);
    if (ch.rpm_limit > 0 && effectiveRpm > 0 && rpm.active && rpm.count / effectiveRpm > 0.8) w *= 0.5;
    if (ch.rpd_limit > 0 && rpd.active && rpd.count / ch.rpd_limit > 0.8) w *= 0.5;

    const rt = getEwmaLatency(ch.id) || ch.response_time || 0;
    if (rt > 0 && avgRt > 0) {
      if (rt > avgRt * 2) w *= 0.3;
      else if (rt > avgRt * 1.5) w *= 0.5;
      else if (rt > avgRt * 1.2) w *= 0.75;
    }

    w = Math.max(1, Math.min(1000, Math.round(w)));
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

let lastRRIdx = -1;

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

    const modelMap = {};
    data.channels.filter(ch => ch.is_enabled).forEach(ch => {
      if (ch.model) ch.model.split(',').map(m => m.trim()).filter(Boolean).forEach(m => {
        if (!modelMap[m]) modelMap[m] = { vision: false, tools: false, stream: false };
        if (ch.is_vision) modelMap[m].vision = true;
        if (ch.support_tools) modelMap[m].tools = true;
        if (ch.support_stream) modelMap[m].stream = true;
      });
    });

    const list = Object.entries(modelMap).map(([id, caps]) => ({
      id, object: "model", created: 1686935002, owned_by: "api-gateway",
      capabilities: { vision: caps.vision, function_calling: caps.tools, streaming: caps.stream },
    }));

    return c.json({ object: "list", data: list });
  } catch (e) {
    logStructured("error", "models unhandled", { error: e.message, stack: e.stack?.slice(0, 500) });
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
    ...channelHeaders,
  };
  if (ch.api_key) requestHeaders.Authorization = "Bearer " + ch.api_key;

  const remainingMs = Math.max(2000, deadline - Date.now());
  const chTimeout = Math.min(remainingMs, getRequestTimeout() * 1000);
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



async function streamChannelResponse(c, winner, data, w, enc, hasVision, originalModel) {
  const { ch, res, responseTime } = winner;
  logStructured("info", "stream start", { channelId: ch.id, model: ch.model, responseTime });

  updateRateCounters(ch, Math.floor(Date.now() / 1000));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let streamHadContent = false;
  let bytesWritten = false;
  let hasWrittenInit = false;
  let streamFinishedNormally = false;
  let streamError = null;
  const contentFilter = new RollingFilter(data.filters || []);
  const clientSignal = c.req.raw.signal;
  const tcState = { buffering: false, buf: '' };
  let emittedToolCalls = false;

  try {
    let lastLine = "";
    let streamDone = false;
    while (!streamDone && !clientSignal.aborted) {
      const { done, value } = await reader.read();
      if (done) { streamDone = true; break; }
      sseBuf += decoder.decode(value, { stream: true });
      const lines = sseBuf.split("\n");
      sseBuf = lines.pop() || "";
      for (const rawLine of lines) {
        if (rawLine.startsWith(":")) continue;
        const trimmed = rawLine.trimStart();
        if (!trimmed.startsWith("data:")) continue;
        const line = rawLine;
        lastLine = line;

        if (line.trim() === "data: [DONE]") {
          streamFinishedNormally = true;
          const tail = contentFilter.flush();
          if (tail) {
            await sseEvent(w, enc, {
              id: "chatcmpl-" + Date.now(), object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              choices: [{ index: 0, delta: { content: tail }, finish_reason: "stop" }],
            });
            bytesWritten = true;
          }
          try { await w.write(enc.encode(line + "\n\n")); bytesWritten = true; } catch (e) {}
          streamDone = true; break;
        }

        try {
          const colonIdx = line.indexOf(":");
          const jsonStr = line.slice(colonIdx + 1).trim();
          const chunk = JSON.parse(jsonStr);
          const choice = chunk?.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content || delta?.tool_calls || delta?.reasoning_content) streamHadContent = true;
          if (choice?.finish_reason) streamFinishedNormally = true;

          // Normalize reasoning_content for LobeChat compatibility:
          // Some upstream providers send reasoning_content (empty/null/whitespace)
          // in every chunk even after thinking is done. LobeChat's transformOpenAIStream
          // checks typeof reasoning_content === 'string' and returns { type: 'reasoning' },
          // causing the "深度思考中" indicator to persist indefinitely.
          //
          // Fix: nullify reasoning_content when it carries no actual thinking text.
          // refs: https://github.com/lobehub/lobe-chat/issues/5681 (siliconflow)
          if (delta && 'reasoning_content' in delta) {
            const rc = delta.reasoning_content;
            if (rc === null || rc === '' || (typeof rc === 'string' && rc.trim() === '')) {
              delta.reasoning_content = null;
            }
          }

          if (!hasWrittenInit) {
            logStructured("info", "stream first chunk", { channelId: ch.id, responseTime });
            await sseEvent(w, enc, {
              id: chunk.id || ("chatcmpl-" + Date.now()),
              object: "chat.completion.chunk",
              created: chunk.created || Math.floor(Date.now() / 1000),
              model: originalModel || chunk.model || "unknown",
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            });
            bytesWritten = true;
            hasWrittenInit = true;
          }

          // Some upstreams lack proper function calling support and return
          // tool invocations as XML in the content field (<tool_call>...).
          // Detect and convert to OpenAI tool_calls chunks for MCP dispatch.
          if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
            const tcResult = processXmlToolCallStream(delta.content, tcState);

            if (tcResult) {
              if (tcResult.action === 'buffer') {
                bytesWritten = true;
                if (choice?.finish_reason) streamFinishedNormally = true;
                continue;
              }

              if (tcResult.action === 'emit' && tcResult.toolCalls) {
                streamHadContent = true;
                if (!hasWrittenInit) {
                  await sseEvent(w, enc, {
                    id: chunk.id || ("chatcmpl-" + Date.now()),
                    object: "chat.completion.chunk",
                    created: chunk.created || Math.floor(Date.now() / 1000),
                    model: originalModel || chunk.model || "unknown",
                    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                  });
                  bytesWritten = true;
                  hasWrittenInit = true;
                }
                if (tcResult.textBefore) {
                  await sseEvent(w, enc, {
                    ...chunk,
                    choices: [{ index: 0, delta: { content: tcResult.textBefore }, finish_reason: null }],
                  });
                  bytesWritten = true;
                }
                for (const tc of tcResult.toolCalls) {
                  await sseEvent(w, enc, {
                    ...chunk,
                    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
                  });
                  bytesWritten = true;
                }
                await sseEvent(w, enc, {
                  ...chunk,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                });
                bytesWritten = true;
                emittedToolCalls = true;
                streamFinishedNormally = true;
                if (tcResult.afterText) {
                  // Support multiple <tool_call> blocks in a single stream:
                  // if afterText contains another <tool_call>, continue buffering
                  if (tcResult.afterText.includes('<tool_call>')) {
                    tcState.buffering = true;
                    tcState.buf = tcResult.afterText;
                    continue;
                  }
                  delta.content = tcResult.afterText;
                } else {
                  continue;
                }
              }

              if (tcResult.action === 'text_before') {
                delta.content = tcResult.text;
                if (delta.content.length === 0) {
                  bytesWritten = true;
                  continue;
                }
              }
            }
          }

          if (delta && typeof delta.content === "string") {
            if (delta.content.length > 0) {
              const filtered = contentFilter.transform(delta.content);
              if (filtered) {
                delta.content = filtered;
                if (choice?.finish_reason) {
                  const tail = contentFilter.flush();
                  if (tail) {
                    delta.content = filtered + tail;
                  }
                }
                await sseEvent(w, enc, chunk);
                bytesWritten = true;
              } else if (choice?.finish_reason) {
                const tail = contentFilter.flush();
                if (tail) {
                  delta.content = tail;
                  await sseEvent(w, enc, chunk);
                  bytesWritten = true;
                } else {
                  await sseEvent(w, enc, chunk);
                  bytesWritten = true;
                }
              } else {
                await sseEvent(w, enc, chunk);
                bytesWritten = true;
              }
            } else {
              await sseEvent(w, enc, chunk);
              bytesWritten = true;
            }
            if (contentFilter.truncated) {
              try { await w.write(enc.encode("data: [DONE]\n\n")); bytesWritten = true; } catch (e) {}
              streamDone = true; break;
            }
          } else {
              if (emittedToolCalls) {
                if (choice?.finish_reason) {
                  streamFinishedNormally = true;
                }
              } else if (choice?.finish_reason) {
                const tail = contentFilter.flush();
                if (tail) {
                  choice.delta = choice.delta || {};
                  choice.delta.content = tail;
                  await sseEvent(w, enc, chunk);
                  bytesWritten = true;
                } else {
                  await sseEvent(w, enc, chunk);
                  bytesWritten = true;
                }
              } else {
                await sseEvent(w, enc, chunk);
                bytesWritten = true;
              }
          }

          // Ensure a finish_reason-only stop signal is emitted when the upstream
          // sends finish_reason bundled with content. LobeChat's transformOpenAIStream
          // returns { type: 'text' } instead of { type: 'stop' } for such chunks,
          // so the reasoning block ("深度思考中") never receives the collapse signal.
          // Sending a separate stop-only chunk ensures event: stop reaches the client.
          // refs: https://github.com/lobehub/lobe-chat/issues/5681 (siliconflow / reasoning block collapse)
          if (!emittedToolCalls && choice?.finish_reason === "stop" && !streamDone) {
            if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
              const stopChunk = {
                ...chunk,
                choices: [{ ...choice, delta: {}, finish_reason: "stop" }],
              };
              await sseEvent(w, enc, stopChunk);
              bytesWritten = true;
            }
          }
        } catch (e) {
          try { await w.write(enc.encode(line + "\n\n")); bytesWritten = true; } catch (e) {}
        }

      }
    }


    if (!streamHadContent && !streamFinishedNormally) {
      if (clientSignal.aborted) {
        logStructured("warn", "stream client disconnect", { channelId: ch.id });
      } else {
        ch.last_error_msg = "Empty response (no content)";
        ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
        ch.last_error_at = Math.floor(Date.now() / 1000);
        deferPersist(c, ch);
        if (!bytesWritten) {
          return false;
        }
        await writeStreamError(w, enc, "The upstream service returned an empty response — no content was generated");
        return true;
      }
    }

    if (!lastLine.includes("[DONE]")) {
      try { await w.write(enc.encode("data: [DONE]\n\n")); bytesWritten = true; } catch (e) {}
    }
  } catch (e) {
    streamError = e;
    logStructured("error", "stream read error", { channelId: ch.id, error: e.message.slice(0, 120) });
    ch.last_error_msg = "Stream error: " + e.message.slice(0, 120);
    ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
    ch.last_error_at = Math.floor(Date.now() / 1000);
    deferPersist(c, ch);
    if (!bytesWritten) {
      return false;
    }
    try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e2) {}
  }

  if (streamHadContent && !streamError) {
    logStructured("info", "stream completed", { channelId: ch.id, responseTime });
    applySuccess(ch);
    ch.last_error_msg = "";
    ch.last_error_at = 0;
    ch.response_time = responseTime;
    updateEwma(ch.id, responseTime);
    if (hasVision && !ch.is_vision) ch.is_vision = 1;
    deferPersist(c, ch);
  }
  return true;
}


async function fallbackSequential(c, pool, body, originalModel, data, w, enc, requestDeadline, hasVision) {
  let lastError = "";
  let lastWinnerId = 0;
  const clientSignal = c.req.raw.signal;

  while (pool.length > 0 && Date.now() < requestDeadline && !clientSignal.aborted) {
    const ch = selectChannel(pool, originalModel, true, body);
    if (!ch) { lastError = "all channels in cooldown or rate-limited"; break; }
    removePoolItem(pool, ch);
    logStructured("info", "stream fallback attempt", { channelId: ch.id, model: ch.model, remaining: pool.length });

    const cfg = buildChannelConfig(ch, body, originalModel, requestDeadline, true);
    if (!cfg) continue;

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

      const contentType = res.headers.get("Content-Type") || "";
      let jsonResponse = null;

      if (contentType.includes("application/json")) {
        const resText = await res.text();
        if (resText.length > 4 * 1024 * 1024) continue;
        try { jsonResponse = JSON.parse(resText); } catch (e) { continue; }
      } else if (!contentType || contentType.includes("text/plain")) {
        // Content sniffing: some upstreams set no/wrong Content-Type
        const peekText = await res.text();
        if (peekText.length > 4 * 1024 * 1024) continue;
        const trimmed = peekText.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            const sniffed = JSON.parse(peekText);
            if (sniffed?.choices) jsonResponse = sniffed;
          } catch (e) {}
        }
        if (!jsonResponse) {
          // Not JSON — reconstruct response for SSE parsing
          const reconstructedRes = new Response(peekText, {
            status: res.status, statusText: res.statusText, headers: res.headers,
          });
          const winner = { ch, res: reconstructedRes, cfg, responseTime: rt };
          const streamOk = await streamChannelResponse(c, winner, data, w, enc, hasVision, originalModel);
          if (streamOk) {
            lastWinnerId = ch.id;
            return { ok: true, channelId: lastWinnerId };
          }
          lastError = ch.last_error_msg || "Stream failed early (no content)";
          continue;
        }
      }

      if (jsonResponse) {
        if (jsonResponse?.choices?.[0]?.message?.content) {
          const msg = jsonResponse.choices[0].message;
          const extracted = extractXmlToolCallsFromContent(msg.content);
          if (extracted) {
            msg.content = extracted.content;
            msg.tool_calls = extracted.tool_calls;
            jsonResponse.choices[0].finish_reason = 'tool_calls';
          }
        }
        updateRateCounters(ch, Math.floor(Date.now() / 1000));
        applySuccess(ch);
        ch.response_time = rt;
        updateEwma(ch.id, rt);
        if (hasVision && !ch.is_vision) ch.is_vision = 1;
        deferPersist(c, ch);
        await writeSimulatedStream(w, enc, jsonResponse);
        return { ok: true, channelId: ch.id };
      }

      const winner = { ch, res, cfg, responseTime: rt };
      const streamOk = await streamChannelResponse(c, winner, data, w, enc, hasVision, originalModel);
      if (streamOk) {
        lastWinnerId = ch.id;
        return { ok: true, channelId: lastWinnerId };
      }
      lastError = ch.last_error_msg || "Stream failed early (no content)";
      continue;
    } catch (e) {
      clearTimeout(cfg.timeoutId);
      const rt = Date.now() - fetchStart;
      logStructured("error", "stream fetch error", { channelId: ch.id, error: e.message, stack: e.stack?.slice(0, 300) });
      markChannelError(ch, null, e.message, rt, data);
      deferPersist(c, ch);
      continue;
    }
  }
  return { ok: false, channelId: lastWinnerId };
}



function finalizeNonStream(c, winner, data, hasVision) {
  const { ch, json, responseTime } = winner;
  updateRateCounters(ch, Math.floor(Date.now() / 1000));
  applySuccess(ch);
  ch.last_error_msg = "";
  ch.last_error_at = 0;
  ch.response_time = responseTime;
  updateEwma(ch.id, responseTime);
  if (hasVision && !ch.is_vision) ch.is_vision = 1;
  deferPersist(c, ch);

  if (json?.choices?.[0]?.message?.content) {
    const msg = json.choices[0].message;
    const extracted = extractXmlToolCallsFromContent(msg.content);
    if (extracted) {
      msg.content = extracted.content;
      msg.tool_calls = extracted.tool_calls;
      json.choices[0].finish_reason = 'tool_calls';
    }
  }

  if (json?.choices?.[0]?.message?.content && data.filters?.length > 0) {
    json.choices[0].message.content = RollingFilter.applyStatic(
      json.choices[0].message.content, data.filters
    );
  }

  const tokensIn = json?.usage?.prompt_tokens || 0;
  const tokensOut = json?.usage?.completion_tokens || 0;
  c.executionCtx.waitUntil(logRequest(c.env.DB, ch.id, json.model || ch.model, tokensIn, tokensOut, responseTime, 200, ""));

  const nowSec = Math.floor(Date.now() / 1000);
  c.header("X-RateLimit-Limit", ch.rpm_limit > 0 ? String(ch.rpm_limit) : "inf");
  if (ch.rpm_limit > 0) {
    const remaining = Math.max(0, ch.rpm_limit - (ch.rpm_count || 0));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String((ch.rpm_reset_at || nowSec) + RPM_WINDOW_SECONDS));
  }
  return c.json(json);
}


async function fallbackNonStreamSequential(c, pool, body, originalModel, data, requestDeadline, hasVision) {
  const clientSignal = c.req.raw.signal;
  let lastError = "";
  while (pool.length > 0 && Date.now() < requestDeadline && !clientSignal.aborted) {
    const ch = selectChannel(pool, originalModel, false, body);
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
        lastError = "HTTP " + res.status + (errText ? ": " + errText.slice(0, 300) : "");
        continue;
      }

      const resText = await res.text();
      if (resText.length > 4 * 1024 * 1024) {
        return errResponse(c, "The response from the upstream server exceeded the maximum allowed size", "server_error", 502);
      }
      let json;
      try {
        json = JSON.parse(resText);
      } catch (e) {
        markChannelError(ch, null, "Invalid JSON from upstream: " + e.message, rt, data);
        deferPersist(c, ch);
        lastError = "Invalid JSON from upstream: " + e.message;
        continue;
      }

      // Tools-ignored detection: if tools were in the request but the response
      // has no tool_calls and no XML <tool_call> pattern, the upstream likely
      // doesn't support function calling. Mark support_tools=0 and retry.
      const msg = json?.choices?.[0]?.message;
      if (shouldSimulateTools(body) && msg && !msg.tool_calls) {
        const content = msg.content || '';
        if (!content.includes('<tool_call>')) {
          ch.support_tools = 0;
          markChannelError(ch, null, "Channel ignored tool calls", rt, data);
          deferPersist(c, ch);
          continue;
        }
      }

      return finalizeNonStream(c, { ch, json, responseTime: rt }, data, hasVision);
    } catch (e) {
      clearTimeout(cfg.timeoutId);
      markChannelError(ch, null, e.message, Date.now() - startTime, data);
      if (e.name === 'AbortError') {
        ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors || 0), 60);
      }
      deferPersist(c, ch);
      lastError = (e.name === 'AbortError' ? "Upstream request timed out" : (e.message || "Request failed")).slice(0, 300);
    }
  }
  return errResponse(c, "All upstream channels failed or the request timed out after " + (getGlobalTimeout() / 1000) + "s" + (lastError ? ": " + lastError : ""), "server_error", 504);
}

/**
 * LobeChat compatibility: some versions emit JSON with a bare array at position 0
 * instead of {"messages": [...]}. This scans on JSON parse failure (~0.5ms/100KB,
 * Free Tier CPU), inserts "messages": before the array, and retries.
 *
 * Decision: KEPT per P7 architecture — transport gateway must tolerate
 * client-side quirks. Cost is negligible (single-pass char scan, only on parse error).
 * Not needed once LobeChat fixes the client, but zero-risk to retain.
 */

async function handleChatRequest(c) {
  const rid = requestId();
  try {
    const data = await loadCache(c.env).catch(() => null);
    if (!data) return errResponse(c, "Unable to load configuration — the database is temporarily unavailable", "server_error", 500);

    if (!data.channels || !Array.isArray(data.channels)) {
      logStructured("error", "invalid cache data", { rid, channels: typeof data.channels });
      return errResponse(c, "The server had an error processing your request", "server_error", 500);
    }

    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Incorrect API key provided", "invalid_request_error", 401, "invalid_api_key");
    }

    let body;
    let bodyText = "";
    try {
      bodyText = await c.req.text();
      body = JSON.parse(bodyText);
    } catch (e) {
      const repaired = tryRepairChatJson(bodyText);
      if (repaired) {
        logStructured("info", "Auto-repaired malformed JSON", { rid, length: bodyText?.length });
        body = repaired;
      } else {
        logStructured("error", "JSON parse error", { rid, error: e.message, length: bodyText?.length });
        return errResponse(c, "We could not parse the JSON body of your request: " + e.message, "invalid_request_error", 400);
      }
    }

    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return errResponse(c, "'messages' is required and must contain at least one message", "invalid_request_error", 400);
    }

    const originalModel = body.model;
    const isStream = body.stream !== false;
    const hasVision = hasVisionContent(body);

    logStructured("info", "chat request", { rid, model: originalModel, stream: isStream });

    let pool = data.channels.filter((ch) => ch.is_enabled && (!ch.channel_type || ch.channel_type === "chat")).map(ch => ({ ...ch }));
    if (pool.length === 0) {
      const hasChatChannels = data.channels.some(ch => !ch.channel_type || ch.channel_type === "chat");
      return errResponse(c, hasChatChannels
        ? "All chat channels are in cooldown, rate-limited, or disabled"
        : "No chat-configured channels available — add a channel with type Chat to handle this request",
        "server_error", 503);
    }

    const requestDeadline = Date.now() + getGlobalTimeout();

    if (isStream) {
      const { readable: out, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();

      c.executionCtx.waitUntil((async () => {
        try {
          await sseComment(w, enc, "connected");
          const streamResult = await fallbackSequential(c, pool, body, originalModel, data, w, enc, requestDeadline, hasVision);
          const streamOk = streamResult.ok;
          // Close stream immediately so client (LobeChat) does not hang waiting for end-of-stream
          try { await w.close(); } catch (e) {}
          await logRequest(c.env.DB, streamResult.channelId || 0, originalModel || "", 0, 0, 0, streamOk ? 200 : 502, "", rid);
          await flushHealthWrites(c.env);
        } catch (e) {
          logStructured("error", "stream worker error", { rid, error: e.message });
          await writeStreamError(w, enc, "Gateway stream failed: " + (e.message || "unknown error"));
          try { await w.close(); } catch (e2) {}
        }
      })());

      return new Response(out, { headers: { ...SSE_CHUNK_HEADERS, "X-Request-Id": rid } });
    }

    const result = await fallbackNonStreamSequential(c, pool, body, originalModel, data, requestDeadline, hasVision);
    result.headers.set("X-Request-Id", rid);
    c.executionCtx.waitUntil((async () => {
      if (result.status !== 200) {
        await logRequest(c.env.DB, 0, originalModel || "", 0, 0, 0, result?.status || 0, "", rid);
      }
      await flushHealthWrites(c.env);
    })());
    return result;

  } catch (e) {
    logStructured("error", "chat request unhandled", { rid, error: e.message, stack: e.stack?.slice(0, 500) });
    return errResponse(c, "The server had an error processing your request", "server_error", 500);
  }
}


async function proxyEndpoint(c, endpointType) {
  const rid = requestId();
  try {
    const data = await loadCache(c.env).catch(() => null);
    if (!data) return errResponse(c, "Unable to load configuration — the database is temporarily unavailable", "server_error", 500);
    if (!data.channels || !Array.isArray(data.channels)) {
      logStructured("error", "invalid cache data", { rid, endpoint: endpointType, channels: typeof data.channels });
      return errResponse(c, "The server had an error processing your request", "server_error", 500);
    }

    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Incorrect API key provided", "invalid_request_error", 401, "invalid_api_key");
    }

    let pool = data.channels.filter(ch => ch.is_enabled).map(ch => ({ ...ch }));
    if (pool.length === 0) {
      return errResponse(c, "No available channels — all upstream services are in cooldown, rate-limited, or disabled", "server_error", 503);
    }

    pool = pool.filter(ch => ch.channel_type === endpointType);
    if (pool.length === 0) {
      return errResponse(c, "No available channels support this endpoint type", "invalid_request_error", 400, "unsupported_endpoint");
    }

    const requestDeadline = Date.now() + getGlobalTimeout();
    const reqBodyBuffer = await c.req.arrayBuffer();

    const clientSignal = c.req.raw.signal;
    let clientGone = clientSignal.aborted;

    let lastError = "";

    while (pool.length > 0 && Date.now() < requestDeadline && !clientGone) {
      const ch = selectChannel(pool, "", false);
      if (!ch) break;

      const url = buildEndpointUrl(ch.base_url, endpointType);
      if (!url) {
        removePoolItem(pool, ch);
        continue;
      }

      const remainingMs = Math.max(2000, requestDeadline - Date.now());
      const chTimeout = Math.min(remainingMs, getRequestTimeout() * 1000);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), chTimeout);
      if (!clientSignal.aborted) {
        clientSignal.addEventListener('abort', () => { controller.abort(); clientGone = true; }, { once: true });
      }

      let channelHeaders = {};
      if (ch.headers && typeof ch.headers === "object") channelHeaders = ch.headers;
      else if (ch.headers && typeof ch.headers === "string") try { channelHeaders = JSON.parse(ch.headers); } catch (e) {}
      const reqHeaders = { ...channelHeaders };
      if (ch.api_key) reqHeaders.Authorization = "Bearer " + ch.api_key;
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
        applySuccess(ch);
        ch.last_error_msg = "";
        ch.last_error_at = 0;
        ch.response_time = rt;
        updateEwma(ch.id, rt);
        deferPersist(c, ch);

        const responseHeaders = { "Content-Type": res.headers.get("Content-Type") || "application/json" };
        for (const h of ["cache-control", "x-request-id", "openai-version", "openai-organization"]) {
          const v = res.headers.get(h);
          if (v) responseHeaders[h] = v;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        responseHeaders["X-RateLimit-Limit"] = ch.rpm_limit > 0 ? String(ch.rpm_limit) : "inf";
        if (ch.rpm_limit > 0) {
          const remaining = Math.max(0, ch.rpm_limit - (ch.rpm_count || 0));
          responseHeaders["X-RateLimit-Remaining"] = String(remaining);
          responseHeaders["X-RateLimit-Reset"] = String((ch.rpm_reset_at || nowSec) + RPM_WINDOW_SECONDS);
        }
        c.executionCtx.waitUntil((async () => {
          await logRequest(c.env.DB, ch.id, ch.model || "", 0, 0, rt, 200, "");
          await flushHealthWrites(c.env);
        })());
        return new Response(res.body, { status: 200, headers: { ...responseHeaders, "X-Request-Id": rid } });
      } catch (e) {
        clearTimeout(timeoutId);
        markChannelError(ch, null, e.message, Date.now() - startTime, data);
        if (e.name === 'AbortError') {
          ch.cooldown_until = Math.floor(Date.now() / 1000) + Math.min(5 * Math.pow(2, ch.consecutive_errors || 0), 60);
        }
        deferPersist(c, ch);
        removePoolItem(pool, ch);
        lastError = e.message;
      }
    }

    c.executionCtx.waitUntil((async () => { await flushHealthWrites(c.env); })());

    if (lastError) {
      return errResponse(c, "All available channels failed: " + lastError, "server_error", 502);
    }
    return errResponse(c, "All channels are rate-limited or temporarily unavailable", "rate_limit_error", 429);
  } catch (e) {
    logStructured("error", "proxy unhandled", { rid, endpoint: endpointType, error: e.message, stack: e.stack?.slice(0, 500) });
    return errResponse(c, "The server had an error processing your request", "server_error", 500);
  }
}

export default function registerGateway(app) {
  const V = ["", "/v1", "/api/v1"];
  for (const v of V) {
    app.post(v + "/chat/completions", async (c) => handleChatRequest(c));
    app.get(v + "/models", async (c) => handleModels(c));
    app.post(v + "/images/generations", async (c) => proxyEndpoint(c, "image_gen"));
    app.post(v + "/audio/speech", async (c) => proxyEndpoint(c, "audio_tts"));
    app.post(v + "/audio/transcriptions", async (c) => proxyEndpoint(c, "audio_stt"));
    app.post(v + "/images/edits", async (c) => proxyEndpoint(c, "image_edit"));
    app.post(v + "/embeddings", async (c) => proxyEndpoint(c, "embeddings"));
  }
}
