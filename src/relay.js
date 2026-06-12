/**
 * HTTP 轉發代理
 *
 * 設計要點:
 *   1. 零緩衝串流
 *   2. 連線上限 + 佇列
 *   3. Per-Channel 速率限制
 *   4. Upstream 錯誤退避
 *   5. 30MB body 上限
 *   6. Client 斷線自動 abort upstream
 *   7. /health 自我健檢
 *   8. SIGTERM 緩衝關機
 */

'use strict';

const http  = require('http');
const https = require('https');
const os    = require('os');

const PORT     = parseInt(process.env.PORT            || '3000',   10);
const TIMEOUT  = parseInt(process.env.RELAY_TIMEOUT   || '600000', 10); // 10 min (某些上游 thinking 較久)
const MAX_REQS = parseInt(process.env.MAX_CONCURRENT  || '50',     10);
const QUEUE_MAX = parseInt(process.env.RELAY_QUEUE    || '100',    10);
const QUEUE_TIMEOUT = parseInt(process.env.RELAY_QUEUE_TIMEOUT || '15000', 10); // queue 最長等待 15s（快速 failover）
const MAX_BODY = 31_457_280;
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const CHANNEL_MIN_INTERVAL_MS = parseInt(process.env.CHANNEL_MIN_INTERVAL_MS || '2000', 10);

const startTime = Date.now();
let active      = 0;
let totalReqs   = 0;
let totalErrors = 0;

const rpmCounters = new Map();
const rpdCounters = new Map();
const channelLastUsed = new Map();

setInterval(() => {
  const now = Date.now();
  const currMin = Math.floor(now / 60000);
  const currDay = Math.floor(now / 86400000);
  for (const key of rpmCounters.keys()) {
    const parts = key.split(':');
    if (parseInt(parts[parts.length - 1], 10) < currMin - 1) rpmCounters.delete(key);
  }
  for (const key of rpdCounters.keys()) {
    const parts = key.split(':');
    if (parseInt(parts[parts.length - 1], 10) < currDay - 1) rpdCounters.delete(key);
  }
  for (const [host, entry] of upstreamErrors) {
    if (now - entry.firstErrAt > 60000) upstreamErrors.delete(host);
  }
  if (upstreamErrors.size > 500) upstreamErrors.clear();
}, 60000);

function guardCounterMaps() {
  if (rpmCounters.size > 10000 || rpdCounters.size > 10000) {
    rpmCounters.clear();
    rpdCounters.clear();
  }
}

function checkChannelRateLimit(channelId, rpmLimit, rpdLimit) {
  // 渠道調用間隔檢查（即使無 RPM/RPD 設定也生效）
  if (CHANNEL_MIN_INTERVAL_MS > 0 && channelId) {
    const now = Date.now();
    const lastUsed = channelLastUsed.get(channelId) || 0;
    if (now - lastUsed < CHANNEL_MIN_INTERVAL_MS) {
      return { ok: false, reason: 'min_interval' };
    }
  }
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
      upstreamErrors.set(hostname, { count: 1, firstErrAt: now });
    } else {
      entry.count++;
    }
  }
}

function recordUpstreamSuccess(hostname) {
  if (!hostname) return;
  const entry = upstreamErrors.get(hostname);
  if (entry && Date.now() - entry.firstErrAt <= 60000 && entry.count > 0) {
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) upstreamErrors.delete(hostname);
  }
}

const waitQueue = [];

function tryDequeue() {
  while (waitQueue.length > 0 && active < MAX_REQS) {
    const entry = waitQueue.shift();
    clearTimeout(entry.qTimer); // 已取出的 entry 不再需要 timeout
    active++;
    const dec = () => {
      if (dec.called) return;
      dec.called = true;
      active = Math.max(0, active - 1);
      tryDequeue();
    };
    entry.res.on('finish', dec);
    entry.res.on('close',  dec);
    try { processRequest(entry.req, entry.res); } catch (e) { dec(); throw e; }
  }
}

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

function processRequest(req, res) {
  const targetUrlRaw = req.headers['x-target-url'];
  const rid   = (Math.random() * 0xffffff | 0).toString(36);
  const clientIp = req.socket?.remoteAddress || '?';
  console.log(`[${rid}] <- ${req.method} ${targetUrlRaw} url=${req.url} from ${clientIp}`);

  if (!targetUrlRaw) {
    totalErrors++;
    console.log(`[${rid}] -> 400 missing x-target-url`);
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-Relay': '1' });
    return res.end(JSON.stringify({ error: { message: 'missing x-target-url' }, _relay: { status: 400, headers: {} } }) + '\n');
  }

  let upstreamUrl;
  try   { upstreamUrl = new URL(targetUrlRaw); }
  catch {
    totalErrors++;
    console.log(`[${rid}] -> 400 invalid x-target-url`);
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-Relay': '1' });
    return res.end(JSON.stringify({ error: { message: 'invalid x-target-url' }, _relay: { status: 400, headers: {} } }) + '\n');
  }
  if (!['http:', 'https:'].includes(upstreamUrl.protocol)) {
    totalErrors++;
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-Relay': '1' });
    return res.end(JSON.stringify({ error: { message: 'unsupported protocol' }, _relay: { status: 400, headers: {} } }) + '\n');
  }

  if (CHANNEL_MIN_INTERVAL_MS > 0) {
    const channelId = req.headers['x-channel-id'];
    if (channelId) channelLastUsed.set(channelId, Date.now());
  }

  // Phase 1: 立即回傳 headers（發送端 fetch() 快速 resolve）
  res.writeHead(200, {
    'Content-Type':     'application/json',
    'Transfer-Encoding': 'chunked',
    'X-Relay':          '1',
    'Cache-Control':    'no-cache',
  });

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
    'x-channel-id', 'x-channel-rpm', 'x-channel-rpd', 'x-relay-token',
    'accept-encoding']); // 不轉發 Accept-Encoding，避免上游回 gzip
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k)) opts.headers[k] = v;
  }

  let aborted = false;
  let proxyReq = null;
  let proxyResRef = null;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    if (proxyResRef) try { proxyResRef.unpipe(res); proxyResRef.destroy(); } catch {}
    if (proxyReq) try { proxyReq.destroy(); } catch {}
    try { res.end(); } catch {}
  };

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

    try {
      const safeHeaders = {};
      if (proxyRes.headers) {
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (typeof v === 'string' || typeof v === 'number') safeHeaders[k] = v;
          else if (Array.isArray(v)) safeHeaders[k] = v.join(', ');
        }
      }
      res.write(JSON.stringify({ _relay: { status: sc, headers: safeHeaders } }) + '\n');
    } catch { abort(); return; }

    if (aborted) return;
    if (sc >= 400) {
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
      proxyResRef = proxyRes;
      proxyRes.pipe(res, { end: true });
      proxyRes.on('error', (e) => {
        console.log(`[${rid}] upstream stream error: ${e.message}`);
        if (!aborted) abort();
      });
    }
  });

  proxyReq.on('error', (e) => {
    console.log(`[${rid}] upstream ERROR: ${e.message}`);
    if (aborted) return;
    totalErrors++;
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
      aborted = true;
      if (proxyReq) proxyReq.destroy();
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

function handleRequest(req, res) {
  totalReqs++;

  if (req.url === '/health' || req.url === '/health/') {
    return handleHealth(res);
  }
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('api server is working');
  }
  if (req.url === '/favicon.ico') {
    res.writeHead(204); return res.end();
  }

  // 認證檢查：若 RELAY_SECRET 有設定，所有請求（含 rate limit 前）都需驗證
  if (RELAY_SECRET) {
    const token = req.headers['x-relay-token'];
    if (token !== RELAY_SECRET) {
      totalErrors++;
      console.log(`[relay] rejected request without valid token`);
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Relay': '1' });
      return res.end(JSON.stringify({ error: 'invalid relay token', _relay: { status: 403, headers: {} } }) + '\n');
    }
  }

  // Per-Channel 速率限制（需在 writeHead 之前檢查）
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
    }) + '\n');
  }

  // Upstream 錯誤退避檢查
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
        }) + '\n');
      }
    } catch {}
  }

  // 併發 + 佇列
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
      }) + '\n');
    }
    console.log(`[queue] enqueued (${waitQueue.length + 1}/${QUEUE_MAX})`);
    const entry = { req, res };
    let qTimer = setTimeout(() => {
      const idx = waitQueue.indexOf(entry);
      if (idx >= 0) {
        waitQueue.splice(idx, 1);
        totalErrors++;
        console.log(`[queue] timeout, rejecting`);
        try {
          res.writeHead(503, { 'Content-Type': 'application/json', 'X-Relay': '1' });
          res.end(JSON.stringify({ error: { message: 'queue timeout' }, _relay: { status: 503, headers: {} } }) + '\n');
        } catch (e) { /* client 可能已斷線 */ }
      }
    }, QUEUE_TIMEOUT);
    entry.qTimer = qTimer;
    res.on('close', () => {
      const idx = waitQueue.indexOf(entry);
      if (idx >= 0) {
        waitQueue.splice(idx, 1);
        clearTimeout(entry.qTimer);
      }
    });
    waitQueue.push(entry);
    return;
  }
  active++;
  const dec = () => {
    if (dec.called) return;
    dec.called = true;
    active = Math.max(0, active - 1);
    tryDequeue();
  };
  res.on('finish', dec);
  res.on('close',  dec);

  processRequest(req, res);
}

process.on('uncaughtException', (err) => {
  console.error('[relay] UNCAUGHT EXCEPTION:', err.stack || err.message || err);
  process.exit(1); // PM2 會自動重啟
});
process.on('unhandledRejection', (reason) => {
  console.error('[relay] UNHANDLED REJECTION:', reason instanceof Error ? reason.stack : reason);
});

const server = http.createServer(handleRequest);
server.timeout         = TIMEOUT;
server.maxHeadersCount = 200;
server.on('connection', (socket) => {
  socket.setNoDelay(true); // 禁用 Nagle，確保 metadata 不因 TCP 延遲被緩衝
});
server.listen(PORT, () => {
  console.log(`[relay] ready port=${PORT} timeout=${TIMEOUT}ms concurrent=${MAX_REQS} queue=${QUEUE_MAX}`);
});

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

// 伺服器自 ping 防止 serv00 閒置殺行程（每 5 分鐘）
const SELF_PING_URL = `http://127.0.0.1:${PORT}/health`;
setInterval(() => {
  const req = http.get(SELF_PING_URL, (res) => res.resume());
  req.setTimeout(10_000, () => req.destroy());
  req.on('error', () => {});
}, 300_000).unref();
