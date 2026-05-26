import { pruneSetupRateLimit } from "../dashboard/resources.js";
import { pruneLoginState } from "../dashboard/index.js";
import { retry } from "../lib/retry.js";

const rateBuffer = new Map();
const RATE_BUF_MAX = 200;
const usageBuffer = new Map();
const USAGE_BUF_MAX = 500;
// Rate & ResponseTime buffers are in-memory only (no D1 flush).
// This keeps D1 writes under 100k/month free tier limit.
// Only usage_stats and health state are persisted to D1 (~67k/month worst case with 100 channels).
const FLUSH_MIN_INTERVAL_MS = 300_000; // 5 分鐘（原 2 分鐘），減少 D1 write units

export function bufferRate(chId, rpmCount, rpmResetAt, rpdCount, rpdResetAt) {
  if (rateBuffer.size >= RATE_BUF_MAX) {
    const entries = [...rateBuffer.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const remove = Math.ceil(RATE_BUF_MAX * 0.2);
    for (let i = 0; i < remove; i++) rateBuffer.delete(entries[i][0]);
  }
  rateBuffer.set(chId, { rpmCount, rpmResetAt, rpdCount, rpdResetAt, ts: Date.now() });
}

export function getBufferedRate(chId) {
  return rateBuffer.get(chId) || null;
}

// flushResponseTime, bufferResponseTime, and flushRateBuffer removed intentionally.
// Rate counters and response times are kept in-memory only.
// On worker restart, they rebuild automatically within seconds.
// See: coder-agent.md session summary for the D1 write budget decision.

function usageDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function compactModelName(model) {
  const value = String(model || "").trim();
  return value.length > 120 ? value.slice(0, 120) : value;
}

export function bufferUsage(model, tokensIn, tokensOut, durationMs, status) {
  if (usageBuffer.size >= USAGE_BUF_MAX) {
    const firstKey = usageBuffer.keys().next().value;
    if (firstKey) usageBuffer.delete(firstKey);
  }
  const key = [usageDay(), compactModelName(model), status || 0].join("|");
  const cur = usageBuffer.get(key) || {
    day: usageDay(),
    model: compactModelName(model),
    status: status || 0,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
  };
  cur.requests += 1;
  cur.tokensIn += tokensIn || 0;
  cur.tokensOut += tokensOut || 0;
  cur.durationMs += durationMs || 0;
  usageBuffer.set(key, cur);
}

let lastUsageFlush = 0;

export async function flushUsageBuffer(DB, force = false) {
  if (usageBuffer.size === 0) return 0;
  const nowMs = Date.now();
  if (!force && nowMs - lastUsageFlush < FLUSH_MIN_INTERVAL_MS) return 0;
  const rows = [...usageBuffer.values()];
  usageBuffer.clear();
  const stmts = rows.map((r) =>
    DB.prepare(
      `INSERT INTO usage_stats (day, model, status, requests, tokens_in, tokens_out, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, model, status) DO UPDATE SET
         requests = requests + excluded.requests,
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         duration_ms = duration_ms + excluded.duration_ms`
    ).bind(r.day, r.model, r.status, r.requests, r.tokensIn, r.tokensOut, r.durationMs)
  );
  if (stmts.length > 0) await retry(() => DB.batch(stmts));
  lastUsageFlush = nowMs;
  return stmts.length;
}

let lastHealthRun = 0;
const HEALTH_MIN_INTERVAL = 600_000; // 10 分鐘：cron 每 5 分打一次，隔次拿 cached；full check D1 reads 從 1.9M/month → 0.2M/month
let lastChannelsQuery = 0;
const CHANNELS_QUERY_INTERVAL = 600_000; // 10 分鐘：與 health interval 同步

let lastUrlHealthCheck = 0;
const URL_HEALTH_INTERVAL_MS = 600_000; // 10 分鐘（原 5 分鐘）

async function performUrlHealthCheck(DB) {
  const now = Math.floor(Date.now() / 1000);
  const { results: channels } = await DB.prepare(
    `SELECT id, base_url FROM channels
      WHERE is_enabled=1
      AND (cooldown_until=0 OR cooldown_until<?)`
  ).bind(now).all();

  if (!channels || channels.length === 0) return { checked: 0, ok: 0, fail: 0 };

  const urlSet = new Set();
  for (const ch of channels) {
    const url = (ch.base_url || '').trim();
    if (url) urlSet.add(url);
  }

  const timeoutMs = 3000;
  let ok = 0, fail = 0;
  const updateStmts = [];

  // Process URLs in batches to avoid exceeding Cloudflare Workers subrequest limit
  const urlArray = [...urlSet];
  const BATCH_SIZE = 8; // Process 8 URLs concurrently to stay well under 50 limit
  
  for (let i = 0; i < urlArray.length; i += BATCH_SIZE) {
    const batch = urlArray.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (url) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        await fetch(url, { method: 'HEAD', signal: ac.signal });
        ok++;
        updateStmts.push(
          DB.prepare(
            `UPDATE channels SET cooldown_until=0, last_error_msg='', last_error_at=0
             WHERE base_url=? AND last_error_msg LIKE '[health]%'`
          ).bind(url)
        );
      } catch (e) {
        fail++;
        const reason = e.name === 'AbortError' ? 'timeout' : (e.message || 'unreachable').slice(0, 60);
        updateStmts.push(
          DB.prepare(
            `UPDATE channels SET cooldown_until=?, last_error_msg=?, last_error_at=?
             WHERE base_url=? AND is_enabled=1`
          ).bind(now + 300, '[health] ' + reason, now, url)
        );
      } finally {
        clearTimeout(timer);
      }
    }));
  }

  // Execute all D1 updates in a single batch
  if (updateStmts.length > 0) {
    await retry(() => DB.batch(updateStmts));
  }

  return { checked: urlSet.size, ok, fail };
}

export function registerMaintenance(app) {
  app.get("/health", async (c) => {
    const now = Date.now();
    if (now - lastHealthRun < HEALTH_MIN_INTERVAL) {
      return c.json({ ok: true, cached: true, ts: Math.floor(now / 1000) });
    }
    lastHealthRun = now;
    const start = Date.now();
    const DB = c.env.DB;
    const actions = {};
    const nowUnix = Math.floor(now / 1000);

    if (now - lastUrlHealthCheck >= URL_HEALTH_INTERVAL_MS) {
      lastUrlHealthCheck = now;
      actions.url_health = await performUrlHealthCheck(DB);
    }

    pruneSetupRateLimit();
    pruneLoginState();

    const { results: recovered } = await DB.prepare(
      `SELECT id FROM channels 
       WHERE consecutive_errors > 0 
       AND (
         (cooldown_until > 0 AND cooldown_until < ?)
         OR
         (cooldown_until = 0 AND last_error_at > 0 AND ? - last_error_at > 3600)
       )`
    ).bind(nowUnix, nowUnix).all();

    if (recovered && recovered.length > 0) {
      await retry(() => DB.batch(
        recovered.map(r =>
          DB.prepare(
            "UPDATE channels SET consecutive_errors=0, last_error_msg='', cooldown_until=0 WHERE id=?"
          ).bind(r.id)
        )
      ));
    }
    actions.channels_recovered = (recovered || []).length;

    actions.usage_flushed = await flushUsageBuffer(DB);

    let allChs = null;
    const nowMs = Date.now();
    if (nowMs - lastChannelsQuery > CHANNELS_QUERY_INTERVAL) {
      const { results } = await DB.prepare(
        "SELECT id, name, model, is_enabled, consecutive_errors, cooldown_until, response_time, last_429 FROM channels ORDER BY id"
      ).all();
      allChs = results || [];
      lastChannelsQuery = nowMs;
    }
    actions.channel_count = (allChs || []).length;

    const summary = {
      total: (allChs || []).length,
      enabled: (allChs || []).filter(c => c.is_enabled).length,
      in_cooldown: (allChs || []).filter(c => c.cooldown_until > nowUnix).length,
      error: (allChs || []).filter(c => c.consecutive_errors > 0).length,
      last_429: (allChs || []).filter(c => c.last_429 > nowUnix).length,
    };

    let dbOk = false;
    try { await DB.prepare("SELECT 1").first(); dbOk = true; } catch (e) {}

    return c.json({
      ok: true, ts: nowUnix, version: "2.0.0",
      runtime: "cloudflare-workers",
      db: dbOk ? "connected" : "error",
      channels: summary,
      actions,
      duration_ms: Date.now() - start,
    });
  });
}

export async function logRequest(DB, channelId, model, tokensIn, tokensOut, durationMs, status, errorMsg, requestId) {
  bufferUsage(model, tokensIn, tokensOut, durationMs, status);
}
