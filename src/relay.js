/**
 * HTTP 轉發代理
 *
 * 設計要點:
 *   1. 零緩衝串流 — request body 邊收邊轉送 upstream，不佔 RAM
 *   2. 連線上限 + 佇列 — MAX_REQS 超過時自動排隊等待
 *   3. Per-Channel 速率限制 — 單一行程精確計數（取代 D1 跨 isolate 版本）
 *   4. Upstream 錯誤退避 — 自動記錄上游 502 頻率，暫時繞過問題上游
 *   5. 30MB body 上限 — 防止大 body 撐爆記憶體
 *   6. Client 斷線自動 abort upstream — 不浪費 upstream 處理
 *   7. /health 自我健檢 — 回傳 uptime、記憶體、活躍連線數、佇列長度
 *   8. SIGTERM 緩衝關機 — 等待現有連線完成，最多 30s
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
const MAX_REQS = parseInt(process.env.MAX_CONCURRENT  || '10',     10); // 並行上限 (預設 10)
const QUEUE_MAX = parseInt(process.env.RELAY_QUEUE    || '20',     10); // 最大排隊數
const MAX_BODY = 31_457_280; // 30MB

const startTime = Date.now();
let active      = 0;
let totalReqs   = 0;
let totalErrors = 0;

// ---- Per-Channel 速率限制 (in-memory，單一行程精確) ----
const rpmCounters = new Map(); // key: "channel_{id}_{minute}" → count
const rpdCounters = new Map(); // key: "channel_{id}_{day}" → count

// 每分鐘清除過期計數器，防止記憶體洩漏
setInterval(() => {
  const now = Date.now();
  const currMin = Math.floor(now / 60000);
  const currDay = Math.floor(now / 86400000);
  for (const key of rpmCounters.keys()) {
    if (parseInt(key.split(':')[2]) < currMin - 1) rpmCounters.delete(key);
  }
  for (const key of rpdCounters.keys()) {
    if (parseInt(key.split(':')[2]) < currDay - 1) rpdCounters.delete(key);
  }
  // 清除過期的 upstream error entries
  for (const [host, entry] of upstreamErrors) {
    if (now - entry.firstErrAt > 60000) upstreamErrors.delete(host);
  }
}, 60000);

// 若總 entries 過多 (異常狀況)，強制清空
function guardCounterMaps() {
  if (rpmCounters.size > 10000 || rpdCounters.size > 10000) {
    rpmCounters.clear();
    rpdCounters.clear();
  }
}

/**
 * 檢查並消耗 rate limit 配額
 * 回傳 { ok: boolean, reason?: string }
 * 此函式同步執行，無 async/await，利用 Node.js 單執行緒避免 race condition
 */
function checkChannelRateLimit(channelId, rpmLimit, rpdLimit) {
  if (!channelId || (!rpmLimit && !rpdLimit)) return { ok: true };
  const now = Date.now();
  guardCounterMaps();

  if (rpmLimit > 0) {
    const minute = Math.floor(now / 60000);
    const key = channelId + ':rpm:' + minute;
    const count = (rpmCounters.get(key) || 0) + 1;
    rpmCounters.set(key, count);
    if (count > rpmLimit) return { ok: false, reason: 'rpm_limit' };
  }
  if (rpdLimit > 0) {
    const day = Math.floor(now / 86400000);
    const key = channelId + ':rpd:' + day;
    const count = (rpdCounters.get(key) || 0) + 1;
    rpdCounters.set(key, count);
    if (count > rpdLimit) return { ok: false, reason: 'rpd_limit' };
  }
  return { ok: true };
}

// ---- Upstream 錯誤退避 ----
const upstreamErrors = new Map(); // key: hostname → { count, firstErrAt }

function isUpstreamDegraded(hostname) {
  if (!hostname) return false;
  const entry = upstreamErrors.get(hostname);
  if (!entry) return false;
  // 60 秒內錯誤 >= 3 次 → 判定 degraded
  if (Date.now() - entry.firstErrAt > 60000) {
    upstreamErrors.delete(hostname);
    return false;
  }
  if (entry.count >= 3) return true;
  return false;
}

function recordUpstreamError(hostname) {
  if (!hostname) return;
  const now = Date.now();
  const entry = upstreamErrors.get(hostname);
  if (!entry) {
    upstreamErrors.set(hostname, { count: 1, firstErrAt: now });
  } else {
    if (now - entry.firstErrAt > 60000) {
      // 過期重置
      upstreamErrors.set(hostname, { count: 1, firstErrAt: now });
    } else {
      entry.count++;
    }
  }
}

function recordUpstreamSuccess(hostname) {
  // 連續成功可降低退避等級
  if (!hostname) return;
  const entry = upstreamErrors.get(hostname);
  if (entry && Date.now() - entry.firstErrAt <= 60000 && entry.count > 0) {
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) upstreamErrors.delete(hostname);
  }
}

// ---- 請求佇列 ----
const waitQueue = [];

function tryDequeue() {
  while (waitQueue.length > 0 && active < MAX_REQS) {
    const entry = waitQueue.shift();
    active++;
    processRequest(entry.req, entry.res);
  }
}

// ---- /health 端點 ----
function handleHealth(res) {
  const mem = process.memoryUsage();
  const payload = JSON.stringify({
    status:        'ok',
    uptime_sec:    Math.floor((Date.now() - startTime) / 1000),
    active_conns:  active,
    queue_length:  waitQueue.length,
    total_reqs:    totalReqs,
    total_errors:  totalErrors,
    rpm_entries:   rpmCounters.size,
    rpd_entries:   rpdCounters.size,
    degraded_hosts: upstreamErrors.size,
    mem_rss_mb:    (mem.rss        / 1024 / 1024).toFixed(1),
    mem_heap_mb:   (mem.heapUsed   / 1024 / 1024).toFixed(1),
    load_avg:      os.loadavg().map(v => v.toFixed(2)),
    node_version:  process.version,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// ---- 核心轉發（純事件串流）----
function processRequest(req, res) {
  const targetUrlRaw = req.headers['x-target-url'];
  const rid   = (Math.random() * 0xffffff | 0).toString(36);
  const clientIp = req.socket?.remoteAddress || '?';
  console.log(`[${rid}] <- ${req.method} ${targetUrlRaw} from ${clientIp}`);

  // 驗證 target URL
  if (!targetUrlRaw) {
    totalErrors++;
    console.log(`[${rid}] -> 400 missing x-target-url`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing x-target-url' }));
  }

  let upstreamUrl;
  try   { upstreamUrl = new URL(targetUrlRaw); }
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

  // Phase 1: 立即回傳 headers（讓 CF Worker fetch() 快速 resolve）
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
  // 過濾 hop-by-hop headers；保留 content-length 讓上游知道大小
  const HOP_HEADERS = new Set(['host', 'x-target-url', 'connection', 'transfer-encoding',
    'x-channel-id', 'x-channel-rpm', 'x-channel-rpd']);
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k)) opts.headers[k] = v;
  }

  let aborted = false;
  let proxyReq = null; // 先宣告，讓 abort closure 可以引用；實際值在下方建立
  const abort = () => {
    if (aborted) return;
    aborted = true;
    if (proxyReq) try { proxyReq.destroy(); } catch {}
    try { res.end(); } catch {}
  };

  // Client 斷線 → 放棄 upstream
  res.on('close', () => {
    if (!res.writableFinished) {
      console.log(`[${rid}] client disconnected early`);
      abort();
    }
  });

  const proto    = isHttps ? https : http;
  proxyReq       = proto.request(opts, (proxyRes) => {
    if (aborted) return;
    const sc = proxyRes.statusCode;
    console.log(`[${rid}] upstream -> ${sc}`);
    if (sc >= 400) {
      totalErrors++;
      recordUpstreamError(upstreamUrl.hostname);
    } else {
      recordUpstreamSuccess(upstreamUrl.hostname);
    }

    // 寫 metadata 行（CF Worker 端讀取這一行取得真實 status / headers）
    try {
      res.write(JSON.stringify({ _relay: { status: sc, headers: proxyRes.headers } }) + '\n');
    } catch { abort(); return; }

    if (aborted) return;
    if (sc >= 400) {
      // 錯誤回應：緩衝 Body 後回傳
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
      proxyRes.on('error', (e) => {
        console.log(`[${rid}] upstream stream error: ${e.message}`);
        if (!aborted) { try { res.end(); } catch {} }
      });
    }
  });

  proxyReq.on('error', (e) => {
    totalErrors++;
    console.log(`[${rid}] upstream ERROR: ${e.message}`);
    if (aborted) return;
    recordUpstreamError(upstreamUrl.hostname);
    try { res.write(JSON.stringify({ _relay: { error: 'upstream error: ' + e.message } }) + '\n'); } catch {}
    try { res.end(); } catch {}
  });

  proxyReq.on('timeout', () => {
    console.log(`[${rid}] upstream TIMEOUT after ${TIMEOUT}ms`);
    proxyReq.destroy(new Error('upstream timeout'));
    if (!aborted) {
      recordUpstreamError(upstreamUrl.hostname);
      try { res.write(JSON.stringify({ _relay: { error: 'upstream timeout' } }) + '\n'); } catch {}
      try { res.end(); } catch {}
    }
  });

  // Phase 3: 串流 request body（零緩衝）
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
    try { proxyReq.write(chunk); } catch (e) {
      console.log(`[${rid}] write error: ${e.message}`);
      abort();
    }
  });
  req.on('end', () => {
    console.log(`[${rid}] body complete (${(bodyBytes / 1024).toFixed(0)} KB)`);
    if (bodyBytes <= MAX_BODY) proxyReq.end();
  });
}

// ---- 請求入口（含速率限制 + 併發 + 佇列）----
function handleRequest(req, res) {
  totalReqs++;

  // 保活 / 健檢端點
  if (req.url === '/health' || req.url === '/health/') {
    return handleHealth(res);
  }
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('api server is working');
  }

  // Step 1: Per-Channel 速率限制（需在 writeHead 之前檢查）
  const channelId  = req.headers['x-channel-id'];
  const rpmLimit   = parseInt(req.headers['x-channel-rpm'] || '0', 10);
  const rpdLimit   = parseInt(req.headers['x-channel-rpd'] || '0', 10);
  const rlResult = checkChannelRateLimit(channelId, rpmLimit, rpdLimit);
  if (!rlResult.ok) {
    totalErrors++;
    console.log(`[rate] channel ${channelId} ${rlResult.reason}`);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'X-Relay': '1',
      'Retry-After': '5',
    });
    return res.end(JSON.stringify({
      error: { message: 'rate limit: ' + rlResult.reason },
      _relay: { status: 429, headers: {} },
    }));
  }

  // Step 2: Upstream 錯誤退避檢查
  const targetUrl = req.headers['x-target-url'];
  if (targetUrl) {
    try {
      const hostname = new URL(targetUrl).hostname;
      if (isUpstreamDegraded(hostname)) {
        totalErrors++;
        console.log(`[degrade] upstream ${hostname} degraded, skipping`);
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'X-Relay': '1',
        });
        return res.end(JSON.stringify({
          error: { message: 'upstream temporarily degraded' },
          _relay: { status: 502, headers: {} },
        }));
      }
    } catch {}
  }

  // Step 3: 併發 + 佇列
  if (active >= MAX_REQS) {
    if (waitQueue.length >= QUEUE_MAX) {
      totalErrors++;
      console.log(`[queue] queue full (${QUEUE_MAX}), rejecting`);
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'X-Relay': '1',
      });
      return res.end(JSON.stringify({
        error: { message: 'too many concurrent requests' },
        _relay: { status: 503, headers: {} },
      }));
    }
    console.log(`[queue] enqueued (${waitQueue.length + 1}/${QUEUE_MAX})`);
    waitQueue.push({ req, res });
    return;
  }
  active++;
  const dec = () => {
    active = Math.max(0, active - 1);
    tryDequeue(); // 有空位時從佇列取下一個
  };
  res.on('finish', dec);
  res.on('close',  dec);

  processRequest(req, res);
}

// ---- 全域例外捕捉（crash 前紀錄）----
process.on('uncaughtException', (err) => {
  console.error('[relay] UNCAUGHT EXCEPTION:', err.stack || err.message || err);
  // 不 exit，讓 process 繼續（Node.js 預設會 exit，但我們希望 PM2 重啟時有 log）
});
process.on('unhandledRejection', (reason) => {
  console.error('[relay] UNHANDLED REJECTION:', reason instanceof Error ? reason.stack : reason);
});

// ---- Server ----
const server = http.createServer(handleRequest);
server.timeout         = TIMEOUT;
server.maxHeadersCount = 200;
server.listen(PORT, () => {
  console.log(`[relay] ready port=${PORT} timeout=${TIMEOUT}ms concurrent=${MAX_REQS} queue=${QUEUE_MAX}`);
});

// ---- SIGTERM 緩衝關機 ----
process.on('SIGTERM', () => {
  console.log(`[relay] SIGTERM — draining ${active} active, ${waitQueue.length} queued...`);
  server.close(() => {
    console.log('[relay] all connections drained, exiting cleanly');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[relay] forced exit after 30s drain timeout');
    process.exit(1);
  }, 30_000).unref();
});
