/**
 * HTTP 轉發代理 + SSE Reasoning Capture + Function Calling Simulation
 *
 * 設計要點:
 *   1. 零緩存串流 — request body 邊收邊轉送 upstream，不佔 RAM
 *   2. 連線上限 MAX_CONCURRENT — 超過回 503，避免 OS socket 耗盡
 *   3. MAX_BODY 上限 — 防止惡意大 body 撐爆記憶體
 *   4. Client 斷線自動 abort upstream — 不浪費 upstream 處理
 *   5. Reasoning Cache (response-only) — 截取 SSE 串流，累積 reasoning_content + tool_call_ids
 *   6. 自動記憶體監控 — 超過 MEMORY_LIMIT_MB 自動重啟程序
 *   7. 健康檢查端點 GET /health — 供外部監控
 *   8. Function Calling 模擬 — 對 /v1/chat/completions 請求，自動將 tools 參數
 *      注入 system prompt，並從回應中解析 tool call 轉為標準 OpenAI tool_calls 格式
 *
 * Request injection（補回 reasoning_content）由 CF Worker 端處理。
 *
 * 部署方式（擇一）:
 *   PM2（建議）:
 *     npm install pm2 -g
 *     pm2 start src/relay.js --name relay --watch --max-memory-restart 150M --kill-timeout 10000
 *     pm2 save
 *
 *   背景執行:
 *     nohup node src/relay.js > relay.log 2>&1 &
 *
 *  環境變數:
 *    PORT             預設 3000
 *    RELAY_TIMEOUT    預設 300000（5 分）
 *    MAX_CONCURRENT   預設 15
 *    MEMORY_LIMIT_MB  預設 150（超過自動 exit，由監控重啟）
 *    RELAY_TOKEN      非空時啟用 x-relay-token 驗證（避免被濫用）
 */

// crontab watchdog（每 5 分鐘檢查，不在背景就重啟）:
//   crontab -e
//   */5 * * * * pgrep -f "node.*relay" || nohup node ${HOME}/relay.js > relay.log 2>&1 &

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TIMEOUT = parseInt(process.env.RELAY_TIMEOUT || '300000', 10);   // 5 min
const MAX_REQS = parseInt(process.env.MAX_CONCURRENT || '15', 10);     // 並行上限
const MAX_BODY = 31_457_280;  // 30MB（多模態多圖約 5-15MB，30MB 安全緩衝）
const MEMORY_LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB || '150', 10);
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';

let active = 0;
let startedAt = Date.now();
let totalRequests = 0;

// ---- 記憶體監控：超過上限自動 exit（由外部 watchdog/cron 重啟）----
function checkMemory() {
  const usage = process.memoryUsage();
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
  if (rssMB > MEMORY_LIMIT_MB) {
    console.error(`[relay] MEMORY LIMIT EXCEEDED: RSS=${rssMB}MB > ${MEMORY_LIMIT_MB}MB, exiting`);
    process.exit(1);
  }
  return { rssMB, heapMB };
}
setInterval(checkMemory, 30000).unref();

// ---- 全域錯誤兜底，避免未捕捉錯誤導致程序 crash ----
process.on('uncaughtException', (err) => {
  console.error('[relay] UNCAUGHT EXCEPTION:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[relay] UNHANDLED REJECTION:', reason);
});

// ---- Reasoning Replay Cache（in-memory，僅 response side capture）----
const reasonCache = new Map();
const MAX_CACHE = 500;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分鐘

function cacheKey(toolCallIds) {
  return [...new Set(toolCallIds.filter(Boolean))].sort().join('|');
}
function cacheSet(key, content) {
  if (!key) return;
  reasonCache.set(key, content);
  if (reasonCache.size > MAX_CACHE) {
    const first = reasonCache.keys().next().value;
    if (first) reasonCache.delete(first);
  }
  setTimeout(() => reasonCache.delete(key), CACHE_TTL_MS).unref();
}
function cacheGet(key) {
  return key ? reasonCache.get(key) : undefined;
}
// 開放外部存取 reasoning cache（供 PM2 介面、除錯工具等使用）
function getReasoningCache() { return { get: cacheGet, keys: () => [...reasonCache.keys()] }; }

// ---- 截取 SSE 串流：累積 reasoning_content + tool_call_ids ----
function attachSseCapture(proxyRes, res, rid) {
  let reasoningContent = '';
  const toolCallIds = [];
  let sseBuf = '';

  proxyRes.on('data', (chunk) => {
    sseBuf += chunk.toString();
    const lines = sseBuf.split('\n');
    sseBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.choices) {
            for (const choice of parsed.choices) {
              const delta = choice.delta || {};
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.id && !toolCallIds.includes(tc.id)) toolCallIds.push(tc.id);
                }
              }
            }
          }
        } catch {}
      }
    }
    res.write(chunk);
  });

  proxyRes.on('end', () => {
    if (toolCallIds.length > 0 && reasoningContent) {
      const key = cacheKey(toolCallIds);
      cacheSet(key, reasoningContent);
      console.log(`[${rid}] [cache] STORE reasoning(${reasoningContent.length}B) key=${key}`);
    }
    res.end();
  });
}

// ============================================================
//  Function Calling 模擬 — tools injection + response parsing
// ============================================================

/**
 * 將 OpenAI tools 定義注入 system prompt，轉為文字描述。
 * 上游模型收到後會以 JSON 格式回傳 tool call。
 *
 * 針對 8B 模型，使用具體函數名稱的完整範例（而非 <placeholder>），
 * 讓模型能直接套用模式輸出。
 */
function injectToolDescriptions(messages, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return messages;

  // 用第一個 function 做 demo（讓模型有具體樣本可參考）
  const firstFn = tools[0]?.function || {};
  const firstName = firstFn.name || 'function_name';
  const firstParams = firstFn.parameters?.properties || {};
  const firstRequired = Array.isArray(firstFn.parameters?.required) ? firstFn.parameters.required : [];
  const firstKeys = Object.keys(firstParams);
  const demoArgs = firstKeys.length > 0
    ? '{' + firstKeys.slice(0, 3).map(k => `"${k}": "${firstParams[k]?.type === 'number' ? '0' : '...'}"`).join(', ') + '}'
    : '{}';

  // 精簡工具描述（對 8B 模型，長描述反而干擾）
  const desc = tools.map(t => {
    const fn = t.function || {};
    const p = fn.parameters?.properties || {};
    const r = Array.isArray(fn.parameters?.required) ? fn.parameters.required : [];
    const paramStr = Object.entries(p).map(([k, v]) =>
      k + (r.includes(k) ? '*' : '') + ':' + (v.type || 'any')
    ).join(', ');
    return `  - ${fn.name}(${paramStr}): ${(fn.description || '').slice(0, 120)}`;
  }).join('\n');

  const prompt =
    `\n\n## Available Functions\n${desc}\n\n` +
    `## How to respond\n` +
    `When user's request needs a function, answer with EXACTLY one JSON line (no other text):\n` +
    `  {"tool": "${firstName}", "args": ${demoArgs}}\n` +
    `(Replace function name and arguments as needed.)\n` +
    `When no function is needed, answer normally in plain text.\n` +
    `Never describe or list the available functions.`;

  const msgs = Array.isArray(messages) ? [...messages] : [];
  const sysIdx = msgs.findIndex(m => m && m.role === 'system');
  if (sysIdx >= 0) {
    msgs[sysIdx] = { ...msgs[sysIdx], content: (msgs[sysIdx].content || '') + prompt };
  } else {
    msgs.unshift({ role: 'system', content: prompt.trim() });
  }
  return msgs;
}

/**
 * 從非串流 upstream 回應的 content 中，偵測 tool call JSON 格式。
 * 比對成功則重構為標準 OpenAI tool_calls 格式。
 *
 * 回傳 { modifiedBody: string|null, toolCallId: string|null }
 *  - modifiedBody: 若找到 tool call，回傳重構後的 JSON body
 *  - toolCallId:   tool call id（做 reasoning cache key）
 */
function processToolCallResponse(rawBody, rid) {
  if (!rawBody) return { modifiedBody: null, toolCallId: null };

  let parsed;
  try { parsed = JSON.parse(rawBody); } catch {
    return { modifiedBody: null, toolCallId: null };
  }

  const choice = parsed?.choices?.[0];
  if (!choice) return { modifiedBody: null, toolCallId: null };

  // 只處理 finish_reason === "stop" 且 content 含 JSON tool call 的模式
  if (choice.finish_reason !== 'stop') return { modifiedBody: null, toolCallId: null };

  const content = choice.message?.content || '';
  if (!content) return { modifiedBody: null, toolCallId: null };

  // 用正則尋找 {"tool": "...", "args": {...}}
  // 支援多行 JSON，使用 [\s\S] 匹配跨行
  const re = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\})\s*\}/s;
  const m = content.match(re);
  if (!m) return { modifiedBody: null, toolCallId: null };

  const toolName = m[1];
  let toolArgs;
  try { toolArgs = JSON.parse(m[2]); } catch {
    console.log(`[${rid}] [fc] failed to parse tool args JSON: ${m[2].slice(0, 100)}`);
    return { modifiedBody: null, toolCallId: null };
  }

  const toolCallId = 'call_' + Math.random().toString(36).slice(2, 12);
  console.log(`[${rid}] [fc] DETECT tool=${toolName} args=${JSON.stringify(toolArgs)}`);

  // 重構 response：移除 content 中的 JSON，改為標準 tool_calls 格式
  const remainingContent = content.replace(re, '').trim();

  const modified = {
    ...parsed,
    choices: [{
      index: choice.index || 0,
      message: {
        role: 'assistant',
        content: remainingContent || null,
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(toolArgs),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  };

  return { modifiedBody: JSON.stringify(modified), toolCallId };
}

// ---- 核心轉發（純事件驅動，無 async/await）----
function handleRequest(req, res) {
  totalRequests++;

  // 健康檢查端點（供外部監控工具定期檢查）
  if (req.url === '/health') {
    const mem = checkMemory();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000),
      active, total: totalRequests, rssMB: mem.rssMB, heapMB: mem.heapMB,
    }));
  }

  // RELAY_TOKEN 驗證（非空時啟用，避免共用網路下被濫用）
  if (RELAY_TOKEN && req.headers['x-relay-token'] !== RELAY_TOKEN) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid or missing x-relay-token' }));
  }

  // 連線配額檢查
  if (active >= MAX_REQS) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'too many concurrent requests' } }));
  }
  active++;
  const dec = () => { active--; };
  res.on('finish', dec);
  res.on('close', dec);

  // 驗證 target URL
  const targetUrl = req.headers['x-target-url'];
  const rid = (Math.random() * 999999 | 0).toString(36);
  const clientIp = req.socket?.remoteAddress || '?';
  console.log(`[${rid}] <- ${req.method} ${targetUrl} from ${clientIp}`);
  if (!targetUrl) {
    console.log(`[${rid}] -> 400 missing x-target-url`);
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'missing x-target-url' }));
  }
  let upstreamUrl;
  try { upstreamUrl = new URL(targetUrl); } catch {
    console.log(`[${rid}] -> 400 invalid x-target-url: ${targetUrl}`);
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'invalid x-target-url' }));
  }
  if (!['http:', 'https:'].includes(upstreamUrl.protocol)) {
    console.log(`[${rid}] -> 400 unsupported protocol: ${upstreamUrl.protocol}`);
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'unsupported protocol' }));
  }

  const isChat = req.url && req.url.includes('/v1/chat/completions');

  // === Phase 1: 立即回傳 headers，讓 Worker fetch() resolve ===
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Transfer-Encoding': 'chunked',
    'X-Relay': '1',
    'Cache-Control': 'no-cache',
  });

  // === Phase 2: 準備 upstream options ===
  const isHttps = upstreamUrl.protocol === 'https:';
  const opts = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: req.method || 'POST',
    timeout: TIMEOUT,
    headers: {},
  };
  for (const [k, v] of Object.entries(req.headers)) {
    if (!['host', 'x-target-url', 'connection', 'transfer-encoding', 'accept-encoding', 'x-relay-token'].includes(k)) {
      opts.headers[k] = v;
    }
  }

  let aborted = false;
  let proxyReq;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    if (proxyReq) proxyReq.destroy();
    try { res.end(); } catch {}
  };

  // Client 斷線 → 放棄 upstream
  res.on('close', () => {
    if (!res.writableFinished) {
      console.log(`[${rid}] client disconnected`);
      abort();
    }
  });

  // ---- Function Calling 旗標：工具注入後需處理回應 ----
  let hasTools = false;
  let fcToolCallId = null;  // 用於 reasoning cache

  const proto = isHttps ? https : http;
  proxyReq = proto.request(opts, (proxyRes) => {
    if (aborted) return;
    const sc = proxyRes.statusCode;
    console.log(`[${rid}] upstream -> ${sc}`);

    // 先寫 meta 行（與 relay 協議相容）
    let sentMeta = false;
    try {
      const meta = JSON.stringify({
        _relay: {
          status: sc,
          headers: proxyRes.headers,
        },
      });
      res.write(meta + '\n');
      sentMeta = true;
    } catch { abort(); return; }
    if (!sentMeta || aborted) return;

    if (sc >= 400) {
      // error response：緩衝完整 body，log 後再寫入 res
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        console.log(`[${rid}] upstream error body: ${body.slice(0, 800)}`);
        try { res.write(body); } catch {}
        try { res.end(); } catch {}
      });
    } else if (hasTools && isChat && sc < 400) {
      // === Function Calling 模式：緩衝非串流回應，偵測 tool call ===
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const { modifiedBody, toolCallId } = processToolCallResponse(body, rid);
        if (modifiedBody) {
          console.log(`[${rid}] [fc] tool call reformatted, returning to client`);
          fcToolCallId = toolCallId;
          try { res.write(modifiedBody); } catch {}
        } else {
          // 無 tool call → 原樣寫回
          try { res.write(body); } catch {}
        }
        try { res.end(); } catch {}
      });
      // 錯誤處理：upstream 串流中斷
      proxyRes.on('error', (e) => {
        console.log(`[${rid}] upstream stream error: ${e.message}`);
        try { res.end(); } catch {}
      });
    } else if (isChat && proxyRes.headers['content-type'] && proxyRes.headers['content-type'].includes('text/event-stream')) {
      attachSseCapture(proxyRes, res, rid);
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    console.log(`[${rid}] upstream ERROR: ${e.message}`);
    if (aborted) return;
    try { res.write(JSON.stringify({ _relay: { error: 'upstream connection failed: ' + e.message } }) + '\n'); } catch {}
    try { res.end(); } catch {}
  });
  proxyReq.on('timeout', () => {
    console.log(`[${rid}] upstream TIMEOUT after ${TIMEOUT}ms`);
    proxyReq.destroy(new Error('upstream timeout'));
    if (!aborted) {
      try { res.write(JSON.stringify({ _relay: { error: 'upstream timeout' } }) + '\n'); } catch {}
      try { res.end(); } catch {}
    }
  });

  // === Phase 3: 處理 request body ===
  if (isChat) {
    // 聊天請求：緩衝完整 body 以便檢測 tools 參數
    const bodyChunks = [];
    let bodyBytes = 0;

    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY) {
        console.log(`[${rid}] body too large (${bodyBytes}), aborting`);
        proxyReq.destroy(new Error('body too large'));
        try { res.end(JSON.stringify({ error: { message: 'request body exceeds 30MB' } })); } catch {}
        return;
      }
      bodyChunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const rawBody = Buffer.concat(bodyChunks).toString();
      console.log(`[${rid}] body complete (${rawBody.length} bytes)`);

      let bodyToSend = rawBody;

      try {
        const parsed = JSON.parse(rawBody);
        if (parsed.tools && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
          // 工具注入：強制 upstream 以非串流回應（stream=false）
          // 避免 Gateway 的自動學習機制因 SSE 中無 delta.tool_calls
          // 而誤判渠道不支援 tools
          hasTools = true;
          parsed.stream = false;
          parsed.messages = injectToolDescriptions(parsed.messages, parsed.tools);
          delete parsed.tools;
          delete parsed.tool_choice;
          bodyToSend = JSON.stringify(parsed);
          console.log(`[${rid}] [fc] tools injected (stream forced=false, body=${bodyToSend.length} bytes)`);
        }
      } catch (e) {
        // JSON 解析失敗 → 原樣轉發
        console.log(`[${rid}] body parse error (non-json or empty): ${e.message}`);
      }

      proxyReq.write(bodyToSend);
      if (bodyBytes <= MAX_BODY) proxyReq.end();
    });
  } else {
    // 非聊天請求：串流轉送（原有行為）
    let bodyBytes = 0;
    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY) {
        console.log(`[${rid}] body too large (${bodyBytes}), aborting`);
        proxyReq.destroy(new Error('body too large'));
        try { res.end(JSON.stringify({ error: { message: 'request body exceeds 30MB' } })); } catch {}
        return;
      }
      proxyReq.write(chunk);
    });
    req.on('end', () => {
      console.log(`[${rid}] body complete (${bodyBytes} bytes), forwarding to upstream`);
      if (bodyBytes <= MAX_BODY) proxyReq.end();
    });
  }
}

// ---- Server ----
const server = http.createServer(handleRequest);
server.timeout = TIMEOUT;
server.maxHeadersCount = 200;
server.listen(PORT, () => {
  console.log(`[relay] ready port=${PORT} timeout=${TIMEOUT}ms max_concurent=${MAX_REQS} max_body=${MAX_BODY}`);
});

// 緩衝關機
process.on('SIGTERM', () => {
  console.log(`[relay] SIGTERM received, draining ${active} active connections...`);
  server.close(() => {
    console.log('[relay] server closed, exiting');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[relay] forced exit after drain timeout');
    process.exit(1);
  }, 30000).unref();
});

module.exports = { getReasoningCache, handleRequest };
