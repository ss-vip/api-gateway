/**
 * HTTP 轉發代理（低資源環境優化版）
 *
 * 設計要點:
 *   1. 零緩存串流 — request body 邊收邊轉送 upstream，不佔 RAM
 *   2. 連線上限 50 — 超過回 503，避免 OS socket 耗盡
 *   3. 10MB body 上限 — 防止惡意大 body 撐爆記憶體
 *   4. Client 斷線自動 abort upstream — 不浪費 upstream 處理
 *   5. 無 async/await — 純事件驅動，無 Promise 鏈開銷
 *   6. PM2 記憶體自癒 — 超過 200MB 自動重啟
 *
 * 部署方式:
 *   npm install pm2 -g
 *   pm2 start src/relay.js --name relay --max-memory-restart 200M
 *   pm2 save
 *   Panel 開啟 TCP port 3000（或自訂 PORT 環境變數）
 */

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TIMEOUT = parseInt(process.env.RELAY_TIMEOUT || '300000', 10);   // 5 min
const MAX_REQS = parseInt(process.env.MAX_CONCURRENT || '50', 10);     // 並行上限
const MAX_BODY = 10_485_760;  // 10MB（多模態 base64 圖約 2-5MB/張，10MB 應付一般場景）

let active = 0;

// ---- 核心轉發（無 async/await，純事件串流）----
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

  // === Phase 1: 立即回傳 headers，讓 Worker fetch() resolve ===
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Transfer-Encoding': 'chunked',
    'X-Relay': '1',
    'Cache-Control': 'no-cache',
  });

  // === Phase 2: 串流 request body 到 upstream，不收滿 ===
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
    if (!['host', 'x-target-url', 'connection', 'transfer-encoding', 'content-length'].includes(k)) {
      opts.headers[k] = v;
    }
  }
  delete opts.headers['content-length'];  // 改用 chunked

  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    proxyReq.destroy();
    try { res.end(); } catch {}
  };

  // Client 斷線（未完整傳完 body 或提早關閉）→ 放棄 upstream
  res.on('close', () => {
    if (!res.writableFinished) {
      console.log(`[${rid}] client disconnected`);
      abort();
    }
  });

  const proto = isHttps ? https : http;
  const proxyReq = proto.request(opts, (proxyRes) => {
    if (aborted) return;
    console.log(`[${rid}] upstream → ${proxyRes.statusCode}`);
    let sentMeta = false;
    // 寫 upstream 狀態 metadata（第一行 JSON）
    try {
      const meta = JSON.stringify({
        _relay: {
          status: proxyRes.statusCode,
          headers: proxyRes.headers,
        },
      });
      res.write(meta + '\n');
      sentMeta = true;
    } catch {
      abort();
      return;
    }
    if (!sentMeta || aborted) return;
    // 串流 upstream body → res（零緩存）
    proxyRes.pipe(res);
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

  // 串流 body（限制大小、不收滿、直接寫入 proxyReq）
  let bodyBytes = 0;
  let bodyLogTimer = Date.now();
  req.on('data', (chunk) => {
    bodyBytes += chunk.length;
    if (Date.now() - bodyLogTimer > 5000) {
      console.log(`[${rid}] receiving body... ${bodyBytes} bytes`);
      bodyLogTimer = Date.now();
    }
    if (bodyBytes > MAX_BODY) {
      console.log(`[${rid}] body too large (${bodyBytes}), aborting`);
      proxyReq.destroy(new Error('body too large'));
      try { res.end(JSON.stringify({ error: { message: 'request body exceeds 10MB' } })); } catch {}
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
  console.log(`[relay] ready port=${PORT} timeout=${TIMEOUT}ms max_concurent=${MAX_REQS}`);
});
