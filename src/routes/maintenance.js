import { pruneSetupRateLimit } from "../dashboard/resources.js";
import { pruneLoginState } from "../dashboard/index.js";

const rateBuffer = new Map();
const RATE_BUF_MAX = 200;
const responseTimeBuffer = new Map();

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
  responseTimeBuffer.set(chId, { responseTime, ts: Date.now() });
}

async function flushResponseTime(DB) {
  if (responseTimeBuffer.size === 0) return 0;
  const stmts = [];
  for (const [id, data] of responseTimeBuffer) {
    stmts.push(
      DB.prepare("UPDATE channels SET response_time=? WHERE id=?").bind(data.responseTime, id)
    );
  }
  if (stmts.length === 0) return 0;
  await DB.batch(stmts);
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
  await DB.batch(stmts);
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

    const { results: recovered } = await DB.prepare(
      `SELECT id FROM channels 
       WHERE consecutive_errors > 0 
       AND cooldown_until > 0 
       AND cooldown_until < ?`
    ).bind(nowUnix).all();

    if (recovered && recovered.length > 0) {
      await DB.batch(
        recovered.map(r =>
          DB.prepare(
            "UPDATE channels SET consecutive_errors=0, last_error_msg='', cooldown_until=0 WHERE id=?"
          ).bind(r.id)
        )
      );
    }
    actions.channels_recovered = (recovered || []).length;

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
