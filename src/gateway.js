import { buildUrl, buildEndpointUrl } from "./lib/providers/openai.js";
import {
  BACKOFF_ERROR_THRESHOLD, BACKOFF_429_SECONDS, BACKOFF_MAX_SECONDS,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
  getRequestTimeout, getGlobalTimeout,
} from "./lib/constants.js";
import { selectChannel, lockModel, isModelLocked, updateEwma, clearEwma } from "./lib/router.js";
import { bufferRate, getBufferedRate, logRequest } from "./routes/maintenance.js";
import { SSE_CHUNK_HEADERS, RollingFilter, sseEvent, writeStreamError, writeSimulatedStream } from "./lib/sse.js";
import { requestId, logStructured, errResponse, hasVisionContent, estimateInputTokens, tryRepairChatJson } from "./lib/request.js";
import { processXmlToolCallStream, extractXmlToolCallsFromContent, normalizeToolCallNames, stripToolXmlTags, buildToolSimPrompt } from "./lib/tool-sim.js";
import { classifyError, cooldownFor } from "./lib/errors.js";
import { maskApiKey } from "./lib/logger.js";
import { retry } from "./lib/retry.js";

let cache = { data: null, ts: 0 };
let cacheFlight = null;
let cacheGen = 0;

const lastPersistedState = new Map();
let lastHealthFlush = 0;
const HEALTH_FLUSH_INTERVAL_MS = 30_000; // 30 seconds

// C3: 批次健康寫入 — 累積後在一次 batch 中寫入 D1，而非每次變更都寫
const pendingHealth = new Map();

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

async function loadCache(env) {
  const TTL = 180_000; // 3 分鐘快取，減少 D1 reads（100 channels × 3 tables × 480 reloads/day = ~53k reads/day）
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
  clearEwma();
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
  // Throttle health writes to prevent D1 write exhaustion
  const nowMs = Date.now();
  if (!pendingHealth.size || nowMs - lastHealthFlush < HEALTH_FLUSH_INTERVAL_MS) {
    return;
  }
  
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
  lastHealthFlush = nowMs;
}

function deferPersist(c, ch) {
  if (!ch || !ch.id) return;
  pendingHealth.set(ch.id, { ...ch });
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


async function handleModels(c) {
  try {
    let data;
    try { data = await loadCache(c.env); } catch (e) { data = cache.data; }
    if (!data) data = await loadCache(c.env).catch(() => null);
    if (!data) return errResponse(c, "Unable to load configuration", "server_error", 500);

    const authHeader = (c.req.header("Authorization") || "");
    const token = authHeader.replace(/^[Bb]earer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Incorrect API key provided", "invalid_request_error", 401, "invalid_api_key");
    }

    const modelMap = {};
    data.channels.filter(ch => ch.is_enabled && (!ch.channel_type || ch.channel_type === "chat")).forEach(ch => {
      if (ch.model) ch.model.split(',').map(m => m.trim()).filter(Boolean).forEach(m => {
        if (!modelMap[m]) modelMap[m] = { vision: false, stream: false };
        if (ch.is_vision) modelMap[m].vision = true;
        if (ch.support_stream) modelMap[m].stream = true;
      });
    });

    const list = Object.entries(modelMap).map(([id, caps]) => ({
      id, object: "model", created: 1686935002, owned_by: "api-gateway",
      capabilities: { vision: caps.vision, function_calling: true, streaming: caps.stream },
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
  // 遮罩可能包含在錯誤訊息中的 API key（不影響轉發，僅限日誌/UI）
  const masked = maskApiKey(text);
  if (masked.length <= 8192) return masked;
  return masked.slice(0, 8192) + "... [truncated]";
}

function buildChannelConfig(ch, body, originalModel, deadline, stream) {
  const effectiveModel = ch.model || originalModel || "gpt-4o";
  const url = ch.absolute_url ? ch.base_url : buildUrl(ch.base_url, effectiveModel, stream);
  if (!url) return null;

  const reqBody = { ...body, model: ch.model || originalModel };

  // 輔助模擬：當上游不支援原生 tool_calls 時，附加 XML 模擬指令至 system message，
  // 但保留原生 tools 陣列（上游若支援仍可使用原生）。這樣兩條路都通。
  if (ch.support_tools === 0) {
    const bodyTools = body?.tools;
    if (bodyTools && Array.isArray(bodyTools) && bodyTools.length > 0) {
      const simPrompt = buildToolSimPrompt(bodyTools);
      if (simPrompt) {
        const msgs = [...(reqBody.messages || [])];
        const sysIdx = msgs.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
          msgs[sysIdx] = { ...msgs[sysIdx], content: (msgs[sysIdx].content || '') + simPrompt };
        } else {
          msgs.unshift({ role: 'system', content: simPrompt });
        }
        reqBody.messages = msgs;
      }
    }
  }

  const requestHeaders = {
    "Content-Type": "application/json",
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

  // 使用 9Router-inspired 錯誤分類引擎決定 cooldown 策略
  const classified = classifyError(status, errMsg || '');
  if (classified.type === 'rate_limit' || status === 429) {
    ch.last_429 = Math.floor(Date.now() / 1000) + (data?.config?.recovery_period || 300);
  }

  // 永久性錯誤 (auth/permanent) → 停用渠道
  if (classified.action === 'disable' && ch.is_enabled) {
    ch.is_enabled = 0;
  }

  // Model-level lock：丟棄整類錯誤到特定模型上
  if (classified.type === 'quota') {
    const chModel = (ch.model || '').trim();
    if (chModel) lockModel(chModel, cooldownFor('quota', ch.consecutive_errors) * 1000);
  }
}



function normalizeToolCallNameInStream(rawName, tools) {
  if (!rawName || !tools) return rawName;
  for (const t of tools) {
    const fn = t.function || t;
    const orig = fn?.name;
    if (!orig) continue;
    if (rawName === orig) return orig;
    if (rawName.replace(/_+/g, '_') === orig.replace(/_+/g, '_')) return orig;
    if (orig.includes(rawName)) return orig;
  }
  return rawName;
}

async function streamChannelResponse(c, winner, data, w, enc, hasVision, originalModel, requestDeadline, body) {
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
  const tcState = { buffering: false, buf: '', toolCallIndex: 0 };
  let emittedToolCalls = false;

  let streamUsage = null;
  let usageEmitted = false;

  try {
    let lastLine = "";
    let streamDone = false;
    while (!streamDone && !clientSignal.aborted && Date.now() < requestDeadline) {
      const { done, value } = await reader.read();
      if (done) { streamDone = true; break; }
      sseBuf += decoder.decode(value, { stream: true });
      const lines = sseBuf.split("\n");
      sseBuf = lines.pop() || "";
      for (const rawLine of lines) {
        if (rawLine.startsWith(":")) continue;
        const trimmed = rawLine.trimStart();
        if (!trimmed.startsWith("data:")) continue;
        lastLine = rawLine;

        if (rawLine.trim() === "data: [DONE]") {
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
          try { await w.write(enc.encode(rawLine + "\n\n")); bytesWritten = true; } catch (e) {}
          streamDone = true; break;
        }

        try {
          const colonIdx = rawLine.indexOf(":");
          const jsonStr = rawLine.slice(colonIdx + 1).trim();
          const chunk = JSON.parse(jsonStr);
          const choice = chunk?.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content || delta?.tool_calls || delta?.reasoning_content) streamHadContent = true;
          if (delta?.tool_calls) {
            const tools = body?.tools;
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) {
                tc.function.name = normalizeToolCallNameInStream(tc.function.name, tools);
              }
            }
          }
          if (choice?.finish_reason) streamFinishedNormally = true;
          // 追蹤串流用量（OpenAI 最後一個 chunk 會附 usage）
          if (chunk && typeof chunk.usage === 'object' && chunk.usage !== null && chunk.usage.prompt_tokens !== undefined) {
            streamUsage = chunk.usage;
          }

          // 追蹤是否已送出 usage chunk（避免重複注入）
          if (chunk?.usage) usageEmitted = true;

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

          // Detect XML tool calls in streaming content, convert to OpenAI tool_calls chunks
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
                    choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index ?? 0, id: tc.id, type: tc.type, function: { name: tc.function.name } }] }, finish_reason: null }],
                  });
                  bytesWritten = true;
                  await sseEvent(w, enc, {
                    ...chunk,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index ?? 0, function: { arguments: tc.function.arguments } }] }, finish_reason: null }],
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
            if (emittedToolCalls) {
              if (choice?.finish_reason) streamFinishedNormally = true;
            } else if (delta.content.length > 0) {
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
            } else if (choice?.finish_reason === 'tool_calls') {
              // upstream claims tool_calls without real TC delta - skip
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
            if (contentFilter.truncated) {
              streamFinishedNormally = true;
              try { await w.write(enc.encode("data: [DONE]\n\n")); bytesWritten = true; } catch (e) {}
              streamDone = true; break;
            }
          } else {
            if (emittedToolCalls) {
              if (choice?.finish_reason) {
                await sseEvent(w, enc, chunk);
                bytesWritten = true;
                streamFinishedNormally = true;
              }
            } else if (delta?.tool_calls) {
              const cleanDelta = { ...delta };
              delete cleanDelta.role;
              await sseEvent(w, enc, {
                ...chunk,
                choices: [{ ...choice, delta: cleanDelta }],
              });
              bytesWritten = true;
              emittedToolCalls = true;
              streamFinishedNormally = true;
            } else if (choice?.finish_reason === 'tool_calls') {
              // upstream claims tool_calls without real TC delta - skip
            } else if (choice?.finish_reason) {
              await sseEvent(w, enc, chunk);
              bytesWritten = true;
            }
          }

          // Ensure a finish_reason-only stop signal is emitted when the upstream
          // sends finish_reason bundled with content. Some clients need a clean
          // { finish_reason } chunk to correctly trigger completion logic
          // (e.g. LobeChat reasoning block collapse).
          // refs: https://github.com/lobehub/lobe-chat/issues/5681
          if (!emittedToolCalls && choice?.finish_reason && !streamDone) {
            if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
              const cleanChunk = {
                ...chunk,
                choices: [{ ...choice, delta: {}, finish_reason: choice.finish_reason }],
              };
              await sseEvent(w, enc, cleanChunk);
              bytesWritten = true;
            }
          }
        } catch (e) {
          try { await w.write(enc.encode(rawLine + "\n\n")); bytesWritten = true; } catch (e) {}
        }

      }
    }


    // 注入 usage chunk（OpenCode/Vercel AI SDK 在串流結束前需要 usage 來正確關閉）
    if (streamUsage && !usageEmitted) {
      try {
        await sseEvent(w, enc, {
          id: "chatcmpl-" + Date.now(),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: originalModel || "unknown",
          choices: [],
          usage: streamUsage,
        });
      } catch (e) {}
    }

    if (!streamHadContent && !streamFinishedNormally) {
      if (clientSignal.aborted) {
        logStructured("warn", "stream client disconnect", { channelId: ch.id });
        if (!bytesWritten) return false; // 無任何資料送出 → 允許 fallback
      } else {
        ch.last_error_msg = "Empty response (no content)";
        ch.consecutive_errors = (ch.consecutive_errors || 0) + 1;
        ch.last_error_at = Math.floor(Date.now() / 1000);
        deferPersist(c, ch);
        if (!bytesWritten) {
          return false;
        }
        await writeStreamError(w, enc, "The upstream service returned an empty response — no content was generated");
        return { usage: null };
      }
    }

    if (!streamFinishedNormally && !lastLine.includes("[DONE]")) {
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
    // 有寫入部分資料但發生錯誤 → 回傳無用量
    return { usage: null };
  }

  if ((streamHadContent || streamFinishedNormally) && !streamError) {
    logStructured("info", "stream completed", { channelId: ch.id, responseTime });
    applySuccess(ch);
    ch.last_error_msg = "";
    ch.last_error_at = 0;
    ch.response_time = responseTime;
    updateEwma(ch.id, responseTime);
    if (hasVision && !ch.is_vision) ch.is_vision = 1;

    // 串流 tools-ignored 偵測：簡單標記，不做請求體修改
    const bodyTools = body?.tools;
    if (bodyTools && Array.isArray(bodyTools) && bodyTools.length > 0 && !emittedToolCalls) {
      ch.support_tools = 0;
    } else if (bodyTools && emittedToolCalls) {
      ch.support_tools = 1;
    }

    deferPersist(c, ch);
    return { usage: streamUsage };
  }
  // 完全無內容 → 回傳 false 讓外層進行 fallback
  return false;
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
          const streamResult = await streamChannelResponse(c, winner, data, w, enc, hasVision, originalModel, requestDeadline, body);
          if (streamResult) {
            lastWinnerId = ch.id;
            return { ok: true, channelId: lastWinnerId, usage: streamResult.usage || null };
          }
          lastError = ch.last_error_msg || "Stream failed early (no content)";
          continue;
        }
      }

      // Non-streaming fallback: json path
      if (jsonResponse) {
        if (jsonResponse?.choices?.[0]?.message?.content) {
          const msg = jsonResponse.choices[0].message;
          const isFollowUp = (body?.messages || []).some(m => m.role === 'tool');
          const extracted = extractXmlToolCallsFromContent(msg.content);
          if (extracted) {
            if (isFollowUp) {
              // 跟進輪次：只清理 XML 標籤，不產生新的 tool_calls
              // 若提取後 content 為空則保留原始內容
              msg.content = extracted.content || msg.content;
            } else {
              msg.content = extracted.content;
              msg.tool_calls = extracted.tool_calls;
              jsonResponse.choices[0].finish_reason = 'tool_calls';
              normalizeToolCallNames(msg.tool_calls, body);
            }
          }
          msg.content = stripToolXmlTags(msg.content);
        }
        updateRateCounters(ch, Math.floor(Date.now() / 1000));
        applySuccess(ch);
        ch.response_time = rt;
        updateEwma(ch.id, rt);
        if (hasVision && !ch.is_vision) ch.is_vision = 1;

        deferPersist(c, ch);
        await writeSimulatedStream(w, enc, jsonResponse);
        return { ok: true, channelId: ch.id, usage: jsonResponse.usage || null };
      }

      const winner = { ch, res, cfg, responseTime: rt };
      const streamResult = await streamChannelResponse(c, winner, data, w, enc, hasVision, originalModel, requestDeadline, body);
      if (streamResult) {
        lastWinnerId = ch.id;
        return { ok: true, channelId: lastWinnerId, usage: streamResult.usage || null };
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
  return { ok: false, channelId: lastWinnerId, lastError };
}



function finalizeNonStream(c, winner, data, hasVision, body) {
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
    const isFollowUp = (body?.messages || []).some(m => m.role === 'tool');
    const extracted = extractXmlToolCallsFromContent(msg.content);
      if (extracted) {
        if (isFollowUp) {
          // 跟進輪次：只清理 XML 標籤，不產生新的 tool_calls（避免工具回呼迴圈）
          // 若提取後 content 為空則保留原始內容（原始內容可能不含 XML 而是模型幻覺空白）
          msg.content = extracted.content || msg.content;
        } else {
        msg.content = extracted.content;
        msg.tool_calls = extracted.tool_calls;
        json.choices[0].finish_reason = 'tool_calls';
        normalizeToolCallNames(msg.tool_calls, body);
        // 過濾：只保留工具名稱與原始定義完全匹配的呼叫
        // 避免模型幻覺（hallucination）產生不存在的工具
        if (body?.tools && Array.isArray(body.tools)) {
          const validNames = new Set(body.tools.map(t => {
            const fn = t.function || t;
            return fn?.name;
          }).filter(Boolean));
          msg.tool_calls = msg.tool_calls.filter(tc => validNames.has(tc.function?.name));
          if (msg.tool_calls.length === 0) {
            delete msg.tool_calls;
            json.choices[0].finish_reason = 'stop';
          }
        }
      }
    }
    msg.content = stripToolXmlTags(msg.content);
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length === 0) {
      delete msg.tool_calls;
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

      // Detect if upstream ignored tools: simple mark, no body modification
      if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
        const msg = json?.choices?.[0]?.message;
        if (msg && !msg.tool_calls && !(msg.content || '').includes('<tool_call>')) {
          ch.support_tools = 0;
          deferPersist(c, ch);
        } else {
          ch.support_tools = 1;
        }
      }

      return finalizeNonStream(c, { ch, json, responseTime: rt }, data, hasVision, body);
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

    const authHeader = (c.req.header("Authorization") || "");
    const token = authHeader.replace(/^[Bb]earer\s+/, "");
    if (data.config.client_token && token !== data.config.client_token) {
      return errResponse(c, "Incorrect API key provided", "invalid_request_error", 401, "invalid_api_key");
    }

    let body;
    let bodyText = "";
    // Content-Length 檢查：防止 OOM（Workers 記憶體 128MB）
    const contentLen = parseInt(c.req.header("Content-Length") || "0");
    if (contentLen > 5 * 1024 * 1024) {
      return errResponse(c, "Request body too large — maximum is 5MB", "invalid_request_error", 413);
    }
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
    const isStream = body.stream === true || body.stream === "true";
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
      const reqStart = Date.now();

      c.executionCtx.waitUntil((async () => {
        let streamOk = false;
        try {
          // 立即寫入首 byte 建立連線，避免 client 掛住
          try { await w.write(enc.encode(": connected\n\n")); } catch (e) {}
          const streamResult = await fallbackSequential(c, pool, body, originalModel, data, w, enc, requestDeadline, hasVision);
          streamOk = streamResult.ok;
          const durationMs = Date.now() - reqStart;
          if (!streamOk) {
            try { await writeStreamError(w, enc, streamResult.lastError || "All upstream channels failed — please check channel status"); } catch (e) {}
          }
          try { await w.close(); } catch (e) {}
          const usage = streamResult.usage || {};
          await logRequest(c.env.DB, streamResult.channelId || 0, originalModel || "",
            usage.prompt_tokens || 0, usage.completion_tokens || 0,
            durationMs, streamOk ? 200 : 502, "", rid);
          await flushHealthWrites(c.env);
        } catch (e) {
          logStructured("error", "stream worker error", { rid, error: e.message });
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

    const authHeader = (c.req.header("Authorization") || "");
    const token = authHeader.replace(/^[Bb]earer\s+/, "");
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
    let onAbort = null; // 追蹤上一輪的 abort listener 以便清除

    while (pool.length > 0 && Date.now() < requestDeadline && !clientGone) {
      const ch = selectChannel(pool, "", false);
      if (!ch) break;

      const url = ch.absolute_url ? ch.base_url : buildEndpointUrl(ch.base_url, endpointType);
      if (!url) {
        removePoolItem(pool, ch);
        continue;
      }

      const remainingMs = Math.max(2000, requestDeadline - Date.now());
      const chTimeout = Math.min(remainingMs, getRequestTimeout() * 1000);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), chTimeout);
      if (!clientSignal.aborted) {
        if (onAbort) clientSignal.removeEventListener('abort', onAbort);
        onAbort = () => { controller.abort(); clientGone = true; };
        clientSignal.addEventListener('abort', onAbort, { once: true });
      }

      const reqHeaders = {};
      if (ch.api_key) reqHeaders.Authorization = "Bearer " + ch.api_key;
      const ct = c.req.header("Content-Type");
      if (ct) {
        reqHeaders["Content-Type"] = ct;
      } else if (endpointType === "image_gen" || endpointType === "audio_tts" || endpointType === "embeddings" || endpointType === "video_gen") {
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
    app.post(v + "/video/generations", async (c) => proxyEndpoint(c, "video_gen"));
  }
}
