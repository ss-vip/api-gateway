import { pruneSetupRateLimit } from "../dashboard/resources.js";
import { pruneLoginState } from "../dashboard/index.js";

const rateBuffer = new Map();
const RATE_BUF_MAX = 200;
const responseTimeBuffer = new Map();
const RESP_BUF_MAX = 500;

async function retry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, i)));
    }
  }
}

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

export function bufferResponseTime(chId, responseTime) {
  if (responseTimeBuffer.size >= RESP_BUF_MAX) {
    const entries = [...responseTimeBuffer.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const remove = Math.ceil(RESP_BUF_MAX * 0.2);
    for (let i = 0; i < remove; i++) responseTimeBuffer.delete(entries[i][0]);
  }
  responseTimeBuffer.set(chId, { responseTime, ts: Date.now() });
}

export async function flushResponseTime(DB) {
  if (responseTimeBuffer.size === 0) return 0;
  const stmts = [];
  for (const [id, data] of responseTimeBuffer) {
    stmts.push(
      DB.prepare("UPDATE channels SET response_time=? WHERE id=?").bind(data.responseTime, id)
    );
  }
  if (stmts.length === 0) return 0;
  await retry(() => DB.batch(stmts));
  responseTimeBuffer.clear();
  return stmts.length;
}

async function flushRateBuffer(DB) {
  if (rateBuffer.size === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const stmts = [];
  for (const [id, data] of rateBuffer) {
    if (now - Math.floor(data.ts / 1000) < 120) {
      stmts.push(
        DB.prepare(
          "UPDATE channels SET rpm_count=?, rpm_reset_at=?, rpd_count=?, rpd_reset_at=? WHERE id=?"
        ).bind(data.rpmCount, data.rpmResetAt, data.rpdCount, data.rpdResetAt, id)
      );
    }
  }
  if (stmts.length === 0) return 0;
  await retry(() => DB.batch(stmts));
  rateBuffer.clear();
  return stmts.length;
}

let lastHealthRun = 0;
const HEALTH_MIN_INTERVAL = 10_000;

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

    pruneSetupRateLimit();
    pruneLoginState();

    // 恢復兩種渠道：
    // 1. 有 cooldown_until 且已到期
    // 2. 無 cooldown_until 但 last_error_at 超過 1h（backoff max = 3600s）
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

    // request_logs TTL 7 天，逐批清理控制寫入成本
    try {
      const purge = await DB.prepare("DELETE FROM request_logs WHERE created_at < unixepoch() - 604800 LIMIT 5000").run();
      actions.logs_purged = purge?.meta?.changes || 0;
    } catch (e) { actions.logs_purged = -1; }

    actions.rate_flushed = await flushRateBuffer(DB);
    actions.rt_flushed = await flushResponseTime(DB);

    const { results: allChs } = await DB.prepare(
      "SELECT id, name, model, is_enabled, consecutive_errors, cooldown_until, response_time, last_429 FROM channels ORDER BY id"
    ).all();
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

export async function logRequest(DB, channelId, model, tokensIn, tokensOut, durationMs, status, errorMsg) {
  try {
    await DB.prepare(
      "INSERT INTO request_logs (channel_id, model, tokens_in, tokens_out, duration_ms, status, error_msg) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(channelId || 0, model || "", tokensIn || 0, tokensOut || 0, durationMs || 0, status || 0, errorMsg || "").run();
  } catch (e) {
    console.error("[log] failed:", e.message);
  }
}
