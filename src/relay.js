/**
 * HTTP 轉發代理
 *
 * 設計要點:
 *   1. 零緩衝串流 — request body 邊收邊轉送 upstream，不佔 RAM
 *   2. 連線上限 MAX_REQS — 超過回 503，避免 OS socket 耗盡
 *   3. 30MB body 上限 — 防止大 body 撐爆記憶體
 *   4. Client 斷線自動 abort upstream — 不浪費 upstream 處理
 *   5. 無 async/await — 純事件驅動，無 Promise 鏈開銷
 *   6. /health 自我健檢 — 回傳 uptime、記憶體、活躍連線數，供保活監控
 *   7. SIGTERM 緩衝關機 — 等待現有連線完成，最多 30s
 *
 *  部署方式（擇一）:
 *   PM2（建議）:
 *     npm install pm2 -g
 *     pm2 start src/relay.js --name relay --watch --max-memory-restart 200M --kill-timeout 10000
 *     pm2 save
 *
 *   背景執行:
 *     nohup node src/relay.js > relay.log 2>&1 &
 *
 */

'use strict';

const http  = require('http');
const https = require('https');
const os    = require('os');

const PORT     = parseInt(process.env.PORT            || '3000',   10);
const TIMEOUT  = parseInt(process.env.RELAY_TIMEOUT   || '300000', 10); // 5 min
const MAX_REQS = parseInt(process.env.MAX_CONCURRENT  || '100',    10); // 並行上限
const MAX_BODY = 31_457_280; // 30MB

const startTime = Date.now();
let active      = 0;
let totalReqs   = 0;
let totalErrors = 0;

// ---- 自我健檢端點 (/health) ----
// 回傳診斷資訊供監控讀取
function handleHealth(res) {
  const mem = process.memoryUsage();
  const payload = JSON.stringify({
    status:       'ok',
    uptime_sec:   Math.floor((Date.now() - startTime) / 1000),
    active_conns: active,
    total_reqs:   totalReqs,
    total_errors: totalErrors,
    mem_rss_mb:   (mem.rss        / 1024 / 1024).toFixed(1),
    mem_heap_mb:  (mem.heapUsed   / 1024 / 1024).toFixed(1),
    load_avg:     os.loadavg().map(v => v.toFixed(2)),
    node_version: process.version,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// ---- 核心轉發（無 async/await，純事件串流）----
function handleRequest(req, res) {
  totalReqs++;

  // /health 保活端點
  if (req.url === '/health' || req.url === '/health/') {
    return handleHealth(res);
  }

  // 根路徑 GET 請求，回傳伺服器狀態
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('api server is working');
  }

  // 連線配額檢查
  if (active >= MAX_REQS) {
    totalErrors++;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'too many concurrent requests' } }));
  }
  active++;
  const dec = () => { active = Math.max(0, active - 1); };
  res.on('finish', dec);
  res.on('close',  dec);

  // 驗證 x-target-url
  const targetUrl = req.headers['x-target-url'];
  const rid       = (Math.random() * 0xffffff | 0).toString(36);
  const clientIp  = req.socket?.remoteAddress || '?';
  console.log(`[${rid}] <- ${req.method} ${targetUrl} from ${clientIp}`);

  if (!targetUrl) {
    totalErrors++;
    console.log(`[${rid}] -> 400 missing x-target-url`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing x-target-url' }));
  }

  let upstreamUrl;
  try   { upstreamUrl = new URL(targetUrl); }
  catch {
    totalErrors++;
    console.log(`[${rid}] -> 400 invalid x-target-url`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid x-target-url' }));
  }
  if (!['http:', 'https:'].includes(upstreamUrl.protocol)) {
    totalErrors++;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unsupported protocol' }));
  }

  // Phase 1: 立即回傳 headers，讓 CF Worker fetch() 快速 resolve，不佔 CF CPU Time
  res.writeHead(200, {
    'Content-Type':     'application/json',
    'Transfer-Encoding': 'chunked',
    'X-Relay':          '1',
    'Cache-Control':    'no-cache',
  });

  // Phase 2: 建立 upstream 連線
  const isHttps = upstreamUrl.protocol === 'https:';
  const opts = {
    hostname: upstreamUrl.hostname,
    port:     upstreamUrl.port || (isHttps ? 443 : 80),
    path:     upstreamUrl.pathname + upstreamUrl.search,
    method:   req.method || 'POST',
    timeout:  TIMEOUT,
    headers:  {},
  };
  // 過濾掉 hop-by-hop headers；保留 content-length 讓上游知道大小
  const HOP_HEADERS = new Set(['host', 'x-target-url', 'connection', 'transfer-encoding']);
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k)) opts.headers[k] = v;
  }

  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    proxyReq.destroy();
    try { res.end(); } catch {}
  };

  // Client 斷線 → 放棄 upstream（避免浪費上游 token 用量）
  res.on('close', () => {
    if (!res.writableFinished) {
      console.log(`[${rid}] client disconnected early`);
      abort();
    }
  });

  const proto    = isHttps ? https : http;
  const proxyReq = proto.request(opts, (proxyRes) => {
    if (aborted) return;
    const sc = proxyRes.statusCode;
    console.log(`[${rid}] upstream -> ${sc}`);
    if (sc >= 400) totalErrors++;

    // 先寫 metadata 行（CF Worker 端的 fetchViaRelay 讀取這一行取得真實 status / headers）
    try {
      res.write(JSON.stringify({ _relay: { status: sc, headers: proxyRes.headers } }) + '\n');
    } catch { abort(); return; }

    if (aborted) return;
    if (sc >= 400) {
      // 錯誤回應：緩衝完整 Body，印出 Log 以利排查，再回傳給客戶端
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        console.log(`[${rid}] upstream error body: ${body.slice(0, 1000)}`);
        try { res.write(body); } catch {}
        try { res.end(); } catch {}
      });
      proxyRes.on('error', (e) => {
        console.log(`[${rid}] upstream error body stream error: ${e.message}`);
        try { res.end(); } catch {}
      });
    } else {
      // 正常回應：零緩衝直通
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    totalErrors++;
    console.log(`[${rid}] upstream ERROR: ${e.message}`);
    if (aborted) return;
    try { res.write(JSON.stringify({ _relay: { error: 'upstream error: ' + e.message } }) + '\n'); } catch {}
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

  // Phase 3: 串流 request body（零緩衝，邊收邊轉，不佔 RAM）
  let bodyBytes    = 0;
  let bodyLogTimer = Date.now();
  req.on('data', (chunk) => {
    bodyBytes += chunk.length;
    if (Date.now() - bodyLogTimer > 5000) {
      console.log(`[${rid}] receiving body... ${(bodyBytes / 1024).toFixed(0)} KB`);
      bodyLogTimer = Date.now();
    }
    if (bodyBytes > MAX_BODY) {
      totalErrors++;
      console.log(`[${rid}] body too large (${bodyBytes}), aborting`);
      proxyReq.destroy(new Error('body too large'));
      try { res.end(JSON.stringify({ error: { message: `request body exceeds ${MAX_BODY / 1024 / 1024}MB` } })); } catch {}
      return;
    }
    proxyReq.write(chunk);
  });
  req.on('end', () => {
    console.log(`[${rid}] body complete (${(bodyBytes / 1024).toFixed(0)} KB)`);
    if (bodyBytes <= MAX_BODY) proxyReq.end();
  });
}

// ---- Server ----
const server = http.createServer(handleRequest);
server.timeout         = TIMEOUT;
server.maxHeadersCount = 200;
server.listen(PORT, () => {
  console.log(`[relay] ready port=${PORT} timeout=${TIMEOUT}ms max_concurrent=${MAX_REQS} max_body=${MAX_BODY / 1024 / 1024}MB`);
});

// ---- SIGTERM 緩衝關機 ----
process.on('SIGTERM', () => {
  console.log(`[relay] SIGTERM — draining ${active} active connections...`);
  server.close(() => {
    console.log('[relay] all connections drained, exiting cleanly');
    process.exit(0);
  });
  // 最多等 30s 強制退出
  setTimeout(() => {
    console.error('[relay] forced exit after 30s drain timeout');
    process.exit(1);
  }, 30_000).unref();
});
