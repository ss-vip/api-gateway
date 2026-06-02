/**
 * HTTP 轉發代理 + SSE Reasoning Capture
 *
 * 設計要點:
 *   1. 零緩存串流 — request body 邊收邊轉送 upstream，不佔 RAM
 *   2. 連線上限 MAX_CONCURRENT — 超過回 503，避免 OS socket 耗盡
 *   3. MAX_BODY 上限 — 防止惡意大 body 撐爆記憶體
 *   4. Client 斷線自動 abort upstream — 不浪費 upstream 處理
 *   5. Reasoning Cache (response-only) — 截取 SSE 串流，累積 reasoning_content + tool_call_ids
 *   6. PM2 記憶體自癒 — 超過 150MB 自動重啟
 *
 * Request injection（補回 reasoning_content）由 CF Worker 端處理。
 *
 * 部署方式:
 *   npm install pm2 -g
 *   pm2 start src/relay.js --name relay --watch --max-memory-restart 150M --kill-timeout 10000
 *   pm2 save
 *   Server 開啟 TCP port 3000（或自訂 PORT 環境變數）
 */

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TIMEOUT = parseInt(process.env.RELAY_TIMEOUT || '300000', 10);   // 5 min
const MAX_REQS = parseInt(process.env.MAX_CONCURRENT || '15', 10);     // 並行上限
const MAX_BODY = 31_457_280;  // 30MB（多模態多圖約 5-15MB，30MB 安全緩衝）

let active = 0;

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
// 公開讓 CF Worker 可查
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

// ---- 核心轉發（純事件驅動，無 async/await）----
function handleRequest(req, res) {
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
    if (!['host', 'x-target-url', 'connection', 'transfer-encoding', 'accept-encoding'].includes(k)) {
      opts.headers[k] = v;
    }
  }
  // 保留 content-length：多數上游需要明確長度而非 chunked
  // 若原始請求沒 content-length （少見）則由 Node.js 自動 chunked

  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    proxyReq.destroy();
    try { res.end(); } catch {}
  };

  // Client 斷線 → 放棄 upstream
  res.on('close', () => {
    if (!res.writableFinished) {
      console.log(`[${rid}] client disconnected`);
      abort();
    }
  });

  const proto = isHttps ? https : http;
  const proxyReq = proto.request(opts, (proxyRes) => {
    if (aborted) return;
    const sc = proxyRes.statusCode;
    console.log(`[${rid}] upstream -> ${sc}`);

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

  // === Phase 3: 串流 request body（零緩衝，同原始 relay）===
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
