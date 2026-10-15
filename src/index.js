'use strict';

process.env.TZ = process.env.TZ || 'Asia/Taipei';

const lib = require('./lib');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// shared keep-alive agents — Node 18 globalAgent defaults keepAlive off (TLS handshake per request); pin it on for all runtimes
const _httpAgent = new http.Agent({ keepAlive: true });
const _httpsAgent = new https.Agent({ keepAlive: true });

// --- timestamped logger ---
const _ts = (ts) => {
  const n = ts ? new Date(ts) : new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
};
function log(...a) { a[0]==='─' ? console.log('─'.repeat(60)) : console.log(`[${_ts()}]`, ...a); }
function _timingEqual(a,b){ try{ const ab=Buffer.from(String(a)), bb=Buffer.from(String(b)); if(ab.length!==bb.length) return false; return crypto.timingSafeEqual(ab,bb);}catch{return false;} }
function _sanLog(v){ return String(v??'-').replace(/[\r\n\u001b]/g,' ').slice(0,300); }
function elog(...a) { a[0]==='─' ? console.error('─'.repeat(60)) : console.error(`[${_ts()}]`, ...a); }

// note: custom JSONC parser — handles //, /* */, trailing commas. Edge cases in string values (// inside strings) may produce wrong output. No known issues in 6+ months of production. Add json5 dependency if/when this breaks.
function parseJsonc(str) { return lib.parseJsonc(str); }
function ifJsonParses(s) { try { JSON.parse(s); return true; } catch { return false; } }
function _jsonValid(s) { return lib._jsonValid(s); }
function _ndjsonValid(s) { return lib._ndjsonValid(s); }
function _autoFixJson(s) { return lib._autoFixJson(s); }

// --- error log file ---
// Error bodies need opt-in (see lib); lazy because cfg loads below.
let _logCaptureBody = null;
function _captureErrorBody() {
  if (_logCaptureBody === null) {
    _logCaptureBody = (process.env.LOG_CAPTURE_ERROR_BODY === '1') || (cfg.log?.capture_error_body === true);
    if (_logCaptureBody) {
      elog('─');
      elog('⚠️ [log] capture_error_body is ON — upstream error text (which can echo prompts/PII) will be written to disk and pushed to the console');
    }
  }
  return _logCaptureBody;
}
function _errMsg(body) { return lib._errMsg(body, LOG_BODY_MAX, _captureErrorBody()); }
function _atomicWrite(p, data) {
  const tmp = p + '.tmp';
  // Preserve the target's mode: a fresh 0666&umask tmp resets a 0600
  // key-bearing config back to 0644 on every console save.
  let mode;
  try { mode = fs.statSync(p).mode & 0o777; } catch {}
  fs.writeFileSync(tmp, data, mode !== undefined ? { encoding: 'utf-8', mode } : 'utf-8');
  fs.renameSync(tmp, p);
}
// absolute → as-is; relative → config file's directory; traversal → rejected.
let _cfgDirCache = null;
function _cfgDir() {
  if (!_cfgDirCache) _cfgDirCache = path.dirname(path.resolve(typeof CONFIG_PATH !== 'undefined' && CONFIG_PATH ? CONFIG_PATH : path.join(__dirname, 'config.json')));
  return _cfgDirCache;
}
function getLogPath() {
  const dir = _cfgDir();
  const ec = cfg.log;
  if (ec?.path) {
    const lp = String(ec.path);
    const abs = path.isAbsolute(lp) ? lp : path.resolve(dir, lp);
    const rel = path.relative(dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      elog('─'); elog(`[log] path "${lp}" escapes the config directory — using ${path.join(dir, 'log.json')}`);
      return path.join(dir, 'log.json');
    }
    return abs;
  }
  return path.join(dir, 'log.json');
}
let _logBuf = [], _logFlushTimer = null, _logFlushFast = false;
const LOG_FLUSH_INTERVAL_MS = 5000, LOG_FLUSH_BATCH = 50;
// Serialize appends vs cleanup renames, or in-flight lines get silently dropped.
let _logIoChain = Promise.resolve();
function _logIo(fn) { _logIoChain = _logIoChain.then(fn).catch(() => {}); return _logIoChain; }
function _flushLog() {
  if (_logBuf.length === 0) return;
  const p = getLogPath(), data = _logBuf.join('\n') + '\n'; _logBuf = [];
  if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; _logFlushFast = false; }
  _logIo(() => new Promise((done) => {
    fs.appendFile(p, data, (err) => { if (err) { elog('─'); elog(`[log] flush ${p}: ${err.message}`); } done(); });
  }));
}
function _flushLogSync() {
  if (_logBuf.length === 0) return;
  const p = getLogPath(), data = _logBuf.join('\n') + '\n'; _logBuf = [];
  if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; _logFlushFast = false; }
  try { fs.appendFileSync(p, data, 'utf-8'); }
  catch (e) { elog('─'); elog(`[log] sync flush ${p}: ${e.message}`); }
}
function _cleanupLog() {
  if (_logCleaning.has(getLogPath())) return;
  const ec = cfg.log;
  if (ec?.enabled === false) return;
  const p = getLogPath();
  if (!fs.existsSync(p)) return;
  // Fast path: nothing to do unless we are past BOTH the age and size limits.
  // Without this check every /health hit (5-min cron) rewrote the whole file.
  try {
    const st = fs.statSync(p);
    const maxBytes = _logMaxBytes();
    if (st.size <= maxBytes) {
      const cutoff = Date.now() - _logRetentionDays() * 86400000;
      let needAge = true;
      // cheap age probe: read only the first line; it is the oldest entry
      try {
        const fd = fs.openSync(p, 'r');
        try {
          const buf = Buffer.alloc(512);
          const n = fs.readSync(fd, buf, 0, 512, 0);
          const first = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]);
          if (first?.ts) { const t = new Date(String(first.ts).replace(' ', 'T')).getTime(); if (t > cutoff) needAge = false; }
        } finally { fs.closeSync(fd); }
      } catch { /* unparseable head → fall through to a full pass */ }
      if (!needAge) return;
    }
  } catch { /* stat failed → just try the rewrite */ }
  _logCleaning.add(p);
  // drain pending appends first so we never rename over an in-flight write
  _logIo(() => new Promise((done) => {
    try { _runCleanup(p, ec, done); } catch { done(); }
  }));
}
// Cap by ROTATION (rename, O(1) memory), not truncation — truncation would keep
// the oldest entries and drop the newest. One previous generation retained.
const LOG_MAX_MB_DEFAULT = 100;
function _logMaxBytes() {
  const mb = Number(cfg.log?.max_size_mb ?? LOG_MAX_MB_DEFAULT);
  return (Number.isFinite(mb) && mb > 0 ? mb : LOG_MAX_MB_DEFAULT) * 1024 * 1024;
}
// A NaN/negative cutoff makes `ts > cutoff` false for every line — cleanup
// would silently wipe the whole file; invalid values fall back to 7 days.
function _logRetentionDays() {
  const d = Number(cfg.log?.retention_days);
  return Number.isFinite(d) && d > 0 ? d : 7;
}
function _rotateLog(p, done) {
  const prev = p + '.1';
  fs.unlink(prev, () => {
    fs.rename(p, prev, (e) => {
      if (e) { elog('─'); elog(`[log] rotate failed: ${e.message}`); done(); return; }
      fs.writeFile(p, '', (e2) => {
        if (e2) elog('─'); elog(`[log] rotate create failed: ${e2?.message}`);
        log('─'); log(`🔄 [log] rotated at max_size_mb — previous generation kept as ${path.basename(prev)}`);
        done();
      });
    });
  });
}
function _runCleanup(p, ec, done) {
  try {
    const cutoff = Date.now() - _logRetentionDays() * 86400000, tmp = p + '.cleanup.tmp';
    // NOTE: deliberately NOT p+'.tmp' — _atomicWrite (config/log saves) uses
    // that name, and a save racing a cleanup would clobber each other's file.
    const rs = fs.createReadStream(p, { encoding: 'utf8' });
    const ws = fs.createWriteStream(tmp, { encoding: 'utf8' });
    let tail = '', kept = 0, skipped = 0;
    rs.on('data', (chunk) => {
      const lines = (tail + chunk).split('\n');
      tail = lines.pop();
      for (const l of lines) {
        if (!l.trim()) { ws.write(l + '\n'); kept++; continue; }
        try {
          if (new Date(JSON.parse(l).ts).getTime() > cutoff) { ws.write(l + '\n'); kept++; } else skipped++;
        } catch { ws.write(l + '\n'); kept++; }
      }
    });
    rs.on('end', () => {
      if (tail.trim()) {
        try {
          if (new Date(JSON.parse(tail).ts).getTime() > cutoff) { ws.write(tail + '\n'); kept++; } else skipped++;
        } catch { ws.write(tail + '\n'); kept++; }
      }
      ws.end();
    });
    let finished = false;
    const finish = () => { if (finished) return; finished = true; _logCleaning.delete(p); _lastCleanup = Date.now(); done(); };
// Must run in both branches: trim and size-budget are independent.
    const afterTrim = () => {
      try {
        if (fs.statSync(p).size > _logMaxBytes()) { _rotateLog(p, finish); return; }
      } catch { /* stat failed — nothing to rotate */ }
      finish();
    };
    ws.on('finish', () => {
      if (skipped > 0) {
        fs.rename(tmp, p, (e) => {
          if (e) { elog('─'); elog(`[log] cleanup rename: ${e.message}`); try { fs.unlinkSync(tmp); } catch {} finish(); return; }
          // Deletion leaves a trace — silent drops were indistinguishable from a wipe.
          log('─'); log(`🧹 [log] cleanup removed ${skipped} expired line(s), kept ${kept}`);
          afterTrim();
        });
      } else {
        try { fs.unlinkSync(tmp); } catch {}
        afterTrim();
      }
    });
    ws.on('error', (e) => { elog('─'); elog(`[log] cleanup write: ${e.message}`); try { fs.unlinkSync(tmp); } catch {} finish(); });
    rs.on('error', (e) => { elog('─'); elog(`[log] cleanup read: ${e.message}`); try { fs.unlinkSync(tmp); } catch {} finish(); });
  } catch (e) { elog('─'); elog(`[log] cleanup: ${e.message}`); _logCleaning.delete(p); done(); }
}
function _triggerCleanup() { _cleanupLog(); }
let _logWriteCount = 0, _logCleaning = new Set(), _lastCleanup = 0;
const stats = { success: 0, error: 0, latSum: 0, latN: 0, httpCodes: {} };
const _sseClients = new Set();
let _sseTimer = null;
// write() buffers when the peer is slow: skip events past the soft cap, hang up
// past the hard cap — otherwise one stalled tab eats the process.
const SSE_SOFT_BACKLOG = 256 * 1024;
const SSE_HARD_BACKLOG = 4 * 1024 * 1024;
function _pushSSE(event, data) {
  if (_sseClients.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of _sseClients) {
    try {
      if (c.writableEnded || c.destroyed) { _sseClients.delete(c); continue; }
      const queued = c.writableLength || 0;
      if (queued > SSE_HARD_BACKLOG) {
        _sseClients.delete(c);
        try { c.destroy(); } catch {}
        continue;
      }
      if (queued > SSE_SOFT_BACKLOG) continue;   // skip this event, stay connected
      c.write(msg);
    } catch { _sseClients.delete(c); try { c.destroy(); } catch {} }
  }
}
function _buildStatusJSON() {
  const mem = process.memoryUsage();
  const totalKeys = Object.values(PROVIDER_KEYS).reduce((s, ks) => s + ks.length, 0);
  const now = Date.now();
  const providers = {};
    const provSet = new Set([...PROVIDERS_WITH_KEYS, ...keyPool.keys()]);
  for (const p of provSet) {
    const m = keyPool.get(p);
    if (!m) {
      providers[p] = { keys: (PROVIDER_KEYS[p] || []).length, degraded: 0, last_success: 'never', latency_ms: 0, cbOpen: false };
      continue;
    }
    const vals = [...m.values()];
    const lastSuccess = vals.reduce((mx, s) => Math.max(mx, s.lastSuccess || 0), 0);
    const lat = vals.filter(s => s.lastLatency > 0).map(s => s.lastLatency);
    providers[p] = {
      keys: m.size,
      degraded: vals.filter(s => s.degradedUntil > now).length,
      last_success: lastSuccess ? Math.round((now - lastSuccess) / 1000) + 's' : 'never',
      latency_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      cbOpen: _isCircuitOpen(p),
    };
  }
  const totalReq = stats.success + stats.error;
  return {
    active: _activeRequests, rss_mb: Math.round(mem.rss / 1024 / 1024), totalmem_mb: Math.round(os.totalmem() / 1024 / 1024), heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
    uptime: formatUptime(process.uptime()), keys: totalKeys, providers,
    success_total: stats.success, error_total: stats.error,
    avg_latency_ms: stats.latN ? Math.round((stats.latSum / stats.latN) * 1000) : 0,
    error_rate: totalReq ? (stats.error / totalReq * 100).toFixed(1) + '%' : '0%',
    http_codes: { ...stats.httpCodes },
    cls_memo: CLS_MEMO_ON ? _clsMemo.stats() : { disabled: true },
    recent401: [..._recent401.values()].map(e => ({ provider: e.provider, model: e.model, key: logKey(e.key), ts: _ts(e.ts) })),
  };
}
const MAX_LOG_LINES = 10000;
const IN_FLIGHT_TIMEOUT_MS = 300000; // 5 min — purge stuck in-flight key entries
const FLIGHT_CLEAN_EVERY = 50; // full-scan cleanup every N selectKey calls
const LOG_CLEANUP_EVERY = 200; // trigger cleanup every N log writes
const LOG_CLEANUP_COOLDOWN_MS = 600000; // 10 min — min interval between cleanups
const MEM_CHECK_INTERVAL = 100; // check memory every N requests
const RESEED_MAX_LINES = 10000; // reseed last N log lines on startup — higher = more accurate stats, more startup time
// logId is an explicit parameter: the audio success paths run outside the
// request closure that owns it, and a bare `logId` shorthand here threw
// ReferenceError AFTER the upstream had already answered 200 — the client saw
// 502 while the key and model were charged for a failure.
function recordSuccess(logId, provider, model, key, latency, tokens, startedAt) {
  markKeySuccess(provider, key, latency);
  _recordProviderSuccess(provider, startedAt);
  _recordModelSuccess(provider, model, startedAt);
  logEvent({ logId, provider, model, key, latency: latency/1000, tokens: tokens || 0 });
}
function recordFailure(logId, provider, model, key, status, body) {
  _markKeyFailed(provider, key, status, body);
  if (status >= 500) _recordProviderFailure(provider);
  if (status !== 429) _recordModelFailure(provider, model);
  if (status === 401) markKey401(provider, key, model);
  logEvent({ logId, provider, model, key, status, body });
}
function logEvent({ logId, provider, model, key, status, latency, tokens, body }) {
  const ec = cfg.log;
  if (ec?.enabled === false) return;
  const entry = { ts: _ts(), id: logId || '-', provider, model, key: key && key !== '-' ? logKey(key) : '-' };
  if (body !== undefined) {
    entry.status = status || 0;
    entry.error = _errMsg(body);
    entry.type = 'error';
  } else {
    entry.latency = Math.round(latency || 0);
    entry.tokens = tokens || 0;
    entry.type = 'success';
  }
  _logBuf.push(JSON.stringify(entry));
  // The flush timer is shared. A success entry arms it at 5s; without this
  // fast-path an error arriving behind that timer would wait 5s on disk too,
  // defeating the 500ms error-flush intent (E2E-verified race).
  if (entry.type === 'error') {
    stats.error++;
    if (!_logFlushTimer || !_logFlushFast) {
      if (_logFlushTimer) clearTimeout(_logFlushTimer);
      _logFlushTimer = setTimeout(_flushLog, 500);
      _logFlushFast = true;
    }
    if (status) stats.httpCodes[status] = (stats.httpCodes[status] || 0) + 1;
  }
  else { stats.success++; stats.httpCodes[200] = (stats.httpCodes[200] || 0) + 1; if (latency) { stats.latSum += latency; stats.latN++; } }
  _pushSSE('log', entry);
  _logWriteCount = (_logWriteCount + 1) % 1000000007;
  if (_logBuf.length >= LOG_FLUSH_BATCH) _flushLog();
  else if (!_logFlushTimer) _logFlushTimer = setTimeout(_flushLog, LOG_FLUSH_INTERVAL_MS);
  if (_logWriteCount % LOG_CLEANUP_EVERY === 1 && Date.now() - _lastCleanup > LOG_CLEANUP_COOLDOWN_MS) _triggerCleanup();
}

function _reseedStats() {
  try {
    const p = getLogPath(); let lines = [];
    // Read only the TAIL of both generations. readFileSync of a 100MB log
    // blocked the event loop for seconds on every restart and doubled RSS.
    const tailOf = (f) => {
      try {
        const st = fs.statSync(f);
        if (!st.size) return '';
        const max = Math.min(st.size, 4 * 1024 * 1024);
        const fd = fs.openSync(f, 'r');
        try {
          const buf = Buffer.alloc(max);
          const n = fs.readSync(fd, buf, 0, max, st.size - max);
          let text = buf.toString('utf8', 0, n);
          if (max < st.size) text = text.slice(text.indexOf('\n') + 1);
          return text;
        } finally { fs.closeSync(fd); }
      } catch { return ''; }
    };
    try {
      const text = [tailOf(p + '.1'), tailOf(p)].filter(Boolean).join('\n');
      lines = text.split('\n').slice(-RESEED_MAX_LINES);
    } catch {}
    const all = lines.filter(l => l.trim() && !l.trim().startsWith('#'))
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    stats.httpCodes = {};
    for (const e of all) {
      if (e.type === 'success') stats.httpCodes[200] = (stats.httpCodes[200] || 0) + 1;
      else if (e.status) stats.httpCodes[e.status] = (stats.httpCodes[e.status] || 0) + 1;
    }
    stats.success = all.filter(e => e.type === 'success').length;
    stats.error = all.filter(e => e.type === 'error').length;
    if (stats.success || stats.error) { log('─'); log(`✅ [stats] reseeded: success=${stats.success} error=${stats.error}`); }
  } catch (e) { elog('─'); elog(`[stats] reseed error: ${e.message}`); }
}
// --- config loading (JSONC with comments support) ---
function _findConfig() {
  const dirs = [__dirname, process.cwd()];
  for (const d of dirs) {
    const j = path.join(d, 'config.json');
    if (fs.existsSync(j)) {
      // .json silently wins — say so, or edits to .jsonc never take effect
      if (fs.existsSync(path.join(d, 'config.jsonc'))) elog(`⚠️ [config] both config.json and config.jsonc exist in ${d} — using config.json, config.jsonc is ignored`);
      return j;
    }
    const jc = path.join(d, 'config.jsonc');
    if (fs.existsSync(jc)) return jc;
  }
  return null;
}
const CONFIG_PATH = process.env.CONFIG_PATH || _findConfig();
let cfg = {};
let _cfgBroken = false; // config exists but could not be parsed even after auto-fix
if (CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    cfg = CONFIG_PATH.endsWith('.jsonc') ? parseJsonc(raw) : JSON.parse(raw);
  } catch (e) {
    const fixed = _autoFixJson(fs.readFileSync(CONFIG_PATH, 'utf-8'));
// Strict `.json` path: the fix must itself be plain JSON.
    const acceptable = fixed !== null
      && (CONFIG_PATH.endsWith('.jsonc') || ifJsonParses(fixed));
    if (acceptable) {
      elog('─'); elog(`[config] ${path.basename(CONFIG_PATH)} had missing closing brackets — auto-fixed and saved`);
      try { _atomicWrite(CONFIG_PATH, fixed); } catch {}
      cfg = parseJsonc(fixed);
    } else {
      _cfgBroken = true;
      elog('─'); elog(`[config] failed to load ${path.basename(CONFIG_PATH)}:`, e.message);
      elog('⚠️ [config] console is locked until the config parses (or CLIENT_TOKEN is provided via env)');
    }
  }
} else {
  elog('─'); elog(`[config] no config.json or config.jsonc found — running with env vars and defaults only`);
}
// parseJsonc returns null for an empty/comment-only file — normalize so the
// `cfg.timezone` / `cfg.client_token` reads below cannot throw on null.
if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
// --- config schema validation ---
if (cfg && typeof cfg === 'object') {
  const KNOWN_CONFIG_KEYS = new Set([
    // _note is accepted for backwards compatibility: older configs carried
    // their documentation as a `_note` field; the example now uses comments.
    '_note', 'client_token', 'timezone', 'port', 'timeout', 'key_cooldown', 'max_key_backoff', 'max_body_size', 'quota_backoff',
    'upstream_timeout', 'upstream_max_body',
    'model_lockout', 'circuit_breaker', 'provider_concurrency', 'log', 'providers', 'rate_limit', 'tpm_limit', 'model_limits', 'endpoint_fallbacks', 'models', 'models_aliases',
    'allowed_image_origins', 'smart_route', 'classifier'
  ]);
  for (const k of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(k)) elog(`⚠️ [config] unknown top-level key: "${k}"`);
  }
}
if (cfg.timezone) process.env.TZ = cfg.timezone;

// Built-in anonymous fallback: keep available unless config explicitly defines these entries.
// This lets a fresh install route `model: openai` to gpt4free/auto without a key.
if (!CONFIG_PATH && (!cfg.providers || !Object.prototype.hasOwnProperty.call(cfg.providers, 'gpt4free'))) {
  cfg.providers = { ...(cfg.providers || {}), gpt4free: [''] };
}
if (!CONFIG_PATH && (!cfg.models || !Object.prototype.hasOwnProperty.call(cfg.models, 'openai'))) {
  cfg.models = { ...(cfg.models || {}), openai: [{ provider: 'gpt4free', model: 'auto' }] };
}

const CLIENT_TOKEN = process.env.CLIENT_TOKEN || cfg.client_token || '';
if (!CLIENT_TOKEN) { elog('─'); elog('⚠️ [config] no client_token set — all endpoints unprotected'); }

const PROVIDER_KEYS = Object.fromEntries(
  Object.entries(cfg.providers || {}).filter(([k]) => !k.startsWith('_'))
);

// Normalize provider values → flat key arrays + optional metadata (support ["key"], "key", or {apiKeys, baseUrl, pathPrefix, rpm})
const _norm = {};
const provMeta = {};
for (const [p, v] of Object.entries(PROVIDER_KEYS)) {
  if (Array.isArray(v)) { _norm[p] = v; }
  else if (typeof v === 'string') { _norm[p] = [v]; }
  else if (v && typeof v === 'object') {
    _norm[p] = Array.isArray(v.apiKeys) ? v.apiKeys : [];
    if (v.baseUrl || v.pathPrefix || v.rpm != null) provMeta[p] = { baseUrl: v.baseUrl, pathPrefix: v.pathPrefix, rpm: v.rpm };
  }
  else { _norm[p] = []; }
}
for (const [p, ks] of Object.entries(_norm)) PROVIDER_KEYS[p] = ks;

const ENV_MAP = {
  MISTRAL_KEYS:'mistral', CEREBRAS_KEYS:'cerebras',
  OPENAI_KEYS:'openai', DEEPSEEK_KEYS:'deepseek',
  XAI_KEYS:'xai', GROQ_KEYS:'groq', TOGETHER_KEYS:'together', OPENROUTER_KEYS:'openrouter',
  POLLINATIONS_KEYS:'pollinations', LITEROUTER_KEYS:'literouter', LLM7_KEYS:'llm7', NVIDIA_KEYS:'nvidia', G4F_KEYS:'gpt4free', AGNES_AI_KEYS:'agnes-ai', SEA_LION_KEYS:'sea-lion', KILO_KEYS:'kilo', OPENCODE_KEYS:'opencode', ANTHROPIC_API_KEY:'anthropic', ANTHROPIC_KEYS:'anthropic', AIHORDE_KEYS:'aihorde', NAVY_KEYS:'navy', OLLAMA_KEYS:'ollama', AMD_KEYS:'amd', BAZAARLINK_KEYS:'bazaarlink', FLATKEY_KEYS:'flatkey', TOKENROUTER_KEYS:'tokenrouter', APINEX_KEYS:'apinex',
};

// Direct upstream connection (no CF AI Gateway). All providers are OpenAI-compatible.
const   DIRECT_PROVIDERS = {
  mistral: 'https://api.mistral.ai', pollinations: 'https://gen.pollinations.ai',
  literouter: 'https://api.literouter.com', llm7: 'https://api.llm7.io',
  nvidia: 'https://integrate.api.nvidia.com',
  gpt4free: 'https://g4f.space', 'agnes-ai': 'https://apihub.agnes-ai.com',
  'sea-lion': 'https://api.sea-lion.ai', kilo: 'https://api.kilo.ai',
  openai: 'https://api.openai.com', cerebras: 'https://api.cerebras.ai',
  deepseek: 'https://api.deepseek.com', xai: 'https://api.x.ai',
  groq: 'https://api.groq.com', together: 'https://api.together.xyz',
  openrouter: 'https://openrouter.ai', cohere: 'https://api.cohere.ai',
  perplexity: 'https://api.perplexity.ai', huggingface: 'https://router.huggingface.co',
  // --- Bearer-compatible additions ---
  replicate: 'https://api.replicate.com', baseten: 'https://inference.baseten.co', parallel: 'https://api.parallel.ai',
  opencode: 'https://opencode.ai/zen',
  anthropic: 'https://api.anthropic.com',
  aihorde: 'https://oai.aihorde.net',
  navy: 'https://api.navy',
  vyceai: 'https://vyceai.com',
  ollama: 'https://ollama.com',
  orcarouter: 'https://api.orcarouter.ai',
  hermes: 'https://inference-api.nousresearch.com',
  tokenharbor: 'https://tokenharbor.ai',
  cartesia: 'https://api.cartesia.ai', elevenlabs: 'https://api.elevenlabs.io',
  morph: 'https://api.morphllm.com', aihubmix: 'https://aihubmix.com',
  amd: 'https://developer.amd.com.cn/radeon',
  bazaarlink: 'https://api.bazaarlink.ai',
  flatkey: 'https://router.flatkey.ai',
  tokenrouter: 'https://api.tokenrouter.com',
  apinex: 'https://api.apinex.bond',
};

// Overlay config-defined base URLs — code defaults stay as fallback.
// (SSRF validation lives in lib.js so the matrix is unit-tested.)
const _isBlockedEgressUrl = lib.isBlockedEgressUrl;
for (const [p, m] of Object.entries(provMeta)) {
  if (m.baseUrl && /^https?:\/\//i.test(m.baseUrl)) { const blk=_isBlockedEgressUrl(m.baseUrl); if(blk){ elog('─'); elog(`[config] provider "${p}" baseUrl blocked (${blk}): ${m.baseUrl}`); } else DIRECT_PROVIDERS[p] = m.baseUrl.replace(/\/+$/, ''); }
  else if (m.baseUrl) { elog('─'); elog(`[config] provider "${p}" has invalid baseUrl (ignored): ${m.baseUrl}`); }
}
const DIRECT_PATH_PREFIX = {
  kilo: '/api/gateway',
  groq: '/openai/v1', openrouter: '/api/v1', cohere: '/compatibility/v1',
  perplexity: '/v1/sonar',
};
// Overlay config-defined path prefixes (manual providers)
for (const [p, m] of Object.entries(provMeta)) {
  if (m.pathPrefix) DIRECT_PATH_PREFIX[p] = m.pathPrefix;
}

// Provider-specific adapters: centralize fields/paths/tokens/auth quirks
const ADAPTERS = {
  groq:       { maxTokens: 8192 },
  vyceai:     { banned: new Set(['parallel_tool_calls','user']) },
  nvidia:     { banned: new Set(['parallel_tool_calls']) },
  cohere:     { banned: new Set(['n','logit_bias','top_logprobs','parallel_tool_calls']) },
  mistral:    { banned: new Set(['user','n','logit_bias','top_logprobs','store']) },
  huggingface:{ banned: new Set(['user']) },
  gpt4free:   { banned: new Set(['top_p']) },
  ollama:     { banned: new Set(['tool_choice','logit_bias','user','n']) },
  llm7:       { banned: new Set(['response_format','quality','style','output_format']) },
  amd:        { banned: new Set([]) },
  kilo:       { banned: new Set([]) },
};

// Fields known to cause 4xx for specific providers (strip before forwarding)
const PROVIDER_BANNED_FIELDS = {};
for (const [k,v] of Object.entries(ADAPTERS)) { if (v.banned) PROVIDER_BANNED_FIELDS[k] = v.banned; }

const PROVIDER_REASONING_SPEC = {
  deepseek:   'keep',
  opencode:   'keep',
  nvidia:     'keep',
  amd:        'strip',
  kilo:       'strip',
  mistral:    'effort',
  'ag-llm':   'strip',
};

function _adjustReasoningFields(body, provider) {
  const spec = PROVIDER_REASONING_SPEC[provider] || 'strip';
  if (!body.reasoning && !body.reasoning_content) return;
  if (spec === 'keep') return;
  if (spec === 'strip') {
    delete body.reasoning;
    delete body.reasoning_content;
    delete body.reasoning_effort;
    return;
  }
  if (spec === 'effort') {
    if (typeof body.reasoning === 'object' && body.reasoning.enabled !== undefined) {
      const fromEffort = typeof body.reasoning.effort === 'number' ? body.reasoning.effort : (body.reasoning.enabled ? 3 : 1);
      body.reasoning_effort = fromEffort;
      delete body.reasoning;
      delete body.reasoning_content;
    } else if (body.reasoning?.effort !== undefined) {
      body.reasoning_effort = body.reasoning.effort;
      delete body.reasoning;
    }
    return;
  }
}

const PROVIDER_MAX_TOKENS = {};
for (const [k,v] of Object.entries(ADAPTERS)) { if (v.maxTokens) PROVIDER_MAX_TOKENS[k] = v.maxTokens; }
const RETRY_MAX_ROUNDS = 3;
const RETRY_BASE_DELAY = 5000;
const RETRY_MAX_DELAY = 30000;
const RETRY_TRANSIENT_WAIT = 1500;

// Env vars REPLACE (not append) config keys for the same provider.
for (const [ev, p] of Object.entries(ENV_MAP)) {
  const v = process.env[ev];
  if (v) PROVIDER_KEYS[p] = v.split(',').map(s => s.trim()).filter(Boolean);
}

const MODELS = cfg.models || {};
const ENDPOINT_FALLBACKS = cfg.endpoint_fallbacks || {};
const MODEL_ENTRIES = Object.entries(MODELS).sort((a, b) => b[0].length - a[0].length);
const PROVIDERS_WITH_KEYS = new Set(
  Object.entries(PROVIDER_KEYS).filter(([, ks]) => ks.length > 0).map(([p]) => p)
);

// Common second-level public suffixes: collapsing api.foo.co.uk to "co.uk"
// would put the whole TLD in the image allowlist (endsWith('.co.uk') matches
// any *.co.uk host).
const _SECOND_LEVEL_SUFFIX = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.sg',
]);
function _rootForAllowlist(hostname) {
  const p = hostname.split('.');
  if (p.length > 2 && _SECOND_LEVEL_SUFFIX.has(p.slice(-2).join('.'))) return p.slice(-3).join('.');
  return p.length > 2 ? p.slice(-2).join('.') : hostname;
}
const _autoImageOrigins = [...new Set(
  Object.values(DIRECT_PROVIDERS).flatMap(u => {
    try { const h = new URL(u).hostname; return ['https://' + h, 'https://' + _rootForAllowlist(h)]; } catch { return []; }
  })
)];
lib.setAllowedImageOrigins(cfg.allowed_image_origins || _autoImageOrigins);

const _resolveModelImpl = lib.createModelResolver(MODEL_ENTRIES);
function resolveModel(clientModel) { return _resolveModelImpl(clientModel); }
const _resolveEndpointImpl = lib.createEndpointResolver(MODEL_ENTRIES, ENDPOINT_FALLBACKS);
function resolveModelForEndpoint(clientModel, endpointPath) { return _resolveEndpointImpl(clientModel, endpointPath); }

// env overrides config (empty env falls through); 0 is a valid value, unlike `x || default`
const _cfgNum = (envV, cfgV, dflt) => {
  const pick = (v) => { const n = Number(v); if (!Number.isFinite(n)) { elog('─'); elog(`[config] non-numeric value ${JSON.stringify(v)} — using default ${dflt}`); return dflt; } return Math.trunc(n); };
  if (envV !== undefined && envV !== '') return pick(envV);
  if (cfgV !== undefined && cfgV !== null && cfgV !== '') return pick(cfgV);
  if (cfgV !== undefined) { elog('─'); elog(`[config] empty value for numeric field — using default ${dflt}`); }
  return dflt;
};
const PORT             = _cfgNum(process.env.PORT, cfg.port, 3000);
const TIMEOUT_MS       = _cfgNum(process.env.TIMEOUT, cfg.timeout, 600000);
const KEY_COOLDOWN_MS  = _cfgNum(process.env.KEY_COOLDOWN, cfg.key_cooldown, 30000);
const MAX_KEY_BACKOFF  = _cfgNum(process.env.MAX_KEY_BACKOFF, cfg.max_key_backoff, 300000);
const MAX_BODY_SIZE    = _cfgNum(process.env.MAX_BODY_SIZE, cfg.max_body_size, 10 * 1024 * 1024); // 10MB
const UPSTREAM_TIMEOUT_MS = _cfgNum(process.env.UPSTREAM_TIMEOUT, cfg.upstream_timeout, 120000);
const UPSTREAM_MAX_BODY = _cfgNum(process.env.UPSTREAM_MAX_BODY, cfg.upstream_max_body, 20 * 1024 * 1024);
const QUOTA_BACKOFF_MS = _cfgNum(process.env.QUOTA_BACKOFF, cfg.quota_backoff, 3600000); // quota/credit exhausted → long key cooldown

// --- key pool ---
const keyPool = new Map();

// --- degraded-key state, survives a restart ---
// Records only "key unusable until <epoch>" keyed by salted hash — no prompts,
// bodies, or PII. Independent of log.json so it works when logging is off.
const KEY_STATE_FILE = 'gw-state.json';
let _restoredKeys = new Map();   // "provider:keyId" → degradedUntil
let _keyStateDirty = false, _keyStateTimer = null;
const _STATE_SAVE_DEBOUNCE = 5000;

// A high-entropy API key cannot be recovered from a 12-hex-char digest, and a
// digest matches exactly where a masked "...abcd" suffix could collide.
function _keyId(key, provider) {
  return crypto.createHash('sha256').update(`${provider}\0${key}`).digest('hex').slice(0, 12);
}
function getKeyStatePath() { return path.join(_cfgDir(), KEY_STATE_FILE); }

function _loadKeyState() {
  try {
    const raw = JSON.parse(fs.readFileSync(getKeyStatePath(), 'utf8'));
    if (raw?.v !== 1 || typeof raw.keys !== 'object' || !raw.keys) return;
    const now = Date.now();
    let restored = 0;
    for (const [p, m] of Object.entries(raw.keys)) {
      for (const [id, until] of Object.entries(m || {})) {
        if (typeof until !== 'number' || until <= now) continue;  // drop expired
        _restoredKeys.set(`${p}:${id}`, until);
        restored++;
      }
    }
    if (restored) log('─'); log(`🔑 [state] restored ${restored} degraded key cooldown(s) from ${KEY_STATE_FILE}`);
  } catch { /* no state file yet, or unreadable — start clean */ }
}
function _saveKeyStateSync() {
  if (!_keyStateDirty) return;
  _keyStateDirty = false;
  if (_keyStateTimer) { clearTimeout(_keyStateTimer); _keyStateTimer = null; }
  const now = Date.now(), out = { v: 1, saved: now, keys: {} };
  for (const [combo, until] of _restoredKeys) {
    if (until <= now) { _restoredKeys.delete(combo); continue; }   // self-pruning
    const i = combo.indexOf(':');
    const p = combo.slice(0, i), id = combo.slice(i + 1);
    (out.keys[p] ||= {})[id] = until;
  }
  try { _atomicWrite(getKeyStatePath(), JSON.stringify(out)); }
  catch (e) { elog('─'); elog(`[state] save failed: ${e.message}`); }
}
function _noteDegraded(p, key) {
  const s = keyPool.get(p)?.get(key);
  if (!s || !s.degradedUntil) return;
  const id = _keyId(key, p);
  const combo = `${p}:${id}`;
  if ((_restoredKeys.get(combo) || 0) >= s.degradedUntil) return;
  _restoredKeys.set(combo, s.degradedUntil);
  _keyStateDirty = true;
  // debounced: a failure storm must not turn into a write storm
  if (!_keyStateTimer) _keyStateTimer = setTimeout(() => { _keyStateTimer = null; _saveKeyStateSync(); }, _STATE_SAVE_DEBOUNCE).unref();
}
function _noteRecovered(p, key) {
  const combo = `${p}:${_keyId(key, p)}`;
  if (_restoredKeys.delete(combo)) {
    _keyStateDirty = true;
    if (!_keyStateTimer) _keyStateTimer = setTimeout(() => { _keyStateTimer = null; _saveKeyStateSync(); }, _STATE_SAVE_DEBOUNCE).unref();
  }
}

function initProvider(p) {
  if (!keyPool.has(p)) {
    keyPool.set(p, new Map());
    for (const k of (PROVIDER_KEYS[p] || [])) {
      const until = _restoredKeys.get(`${p}:${_keyId(k, p)}`) || 0;
      keyPool.get(p).set(k, { degradedUntil: until, errorCount: until ? 1 : 0, successCount: 0, lastSuccess: 0, lastLatency: 0 });
    }
  }
}

function getHealthyKeys(p) {
  initProvider(p);
  const now = Date.now();
  const out = [];
  for (const [k, s] of keyPool.get(p)) {
    if (now < s.degradedUntil) continue;
    if (s.degradedUntil > 0 && now >= s.degradedUntil) { s.degradedUntil = 0; s.errorCount = 0; }
    out.push(k);
  }
  return out;
}

function markKeyError(p, key) {
  initProvider(p);
  const s = keyPool.get(p)?.get(key);
  if (!s) return;
  // Never shorten an existing backoff: quota/401 set 1h, a later blip must not rescue it.
  s.degradedUntil = Math.max(s.degradedUntil, Date.now() + Math.min(KEY_COOLDOWN_MS * Math.pow(2, s.errorCount), MAX_KEY_BACKOFF));
  s.errorCount++;
  _noteDegraded(p, key);
}

const QUOTA_RE = lib.QUOTA_RE;
function _isQuotaError(status, body) { return lib._isQuotaError(status, body); }
// note: opencode free-tier models only work inside OpenCode — case-insensitive, no circuit penalty (model-level only)
const FREE_TIER_RE = /free\s*tier\s*can\s*only\s*be\s*used\s*in\s*opencode/i;
function _isFreeTierError(body) { return typeof body === 'string' && FREE_TIER_RE.test(body); }
function _parseRetryAfter(res) {
  const h = res?.headers?.['retry-after'] || res?.headers?.['Retry-After'];
  if (!h) return 0;
  const n = parseInt(h, 10);
  if (!isNaN(n)) return n * 1000;
  const t = Date.parse(h);
  return isNaN(t) ? 0 : Math.max(0, t - Date.now());
}
async function _handleUpstream429(provider, key, upstreamRes, body, logId, res) {
  _markKeyFailed(provider, key, upstreamRes.statusCode || 429, body);
  _adjustRpm(provider, false);
  const retryAfter = _parseRetryAfter(upstreamRes);
  _applyRateLimitSignal(res, provider, upstreamRes, retryAfter);
  if (retryAfter) {
// Separate map: _keyLastUsed is dispatch time, this is usable-after.
    if (!_keyRetryUntil.has(provider)) _keyRetryUntil.set(provider, new Map());
    _keyRetryUntil.get(provider).set(key, Date.now() + retryAfter);
  }
  return retryAfter;
}
function markKeyQuotaExhausted(p, key) {
  initProvider(p);
  const st = keyPool.get(p)?.get(key);
  if (!st) return;
  st.degradedUntil = Date.now() + QUOTA_BACKOFF_MS;
  st.errorCount = Math.max(st.errorCount, 8);
  _noteDegraded(p, key);
    log('─'); log(`⚠️ [quota] ${p} key ${logKey(key)} degraded ${QUOTA_BACKOFF_MS}ms (quota/credit exhausted)`);
}
// Health-affecting statuses. A 4xx that is not a credential/quota problem is a
// request/config error and must NOT degrade a key or open a circuit.
function _isHealthFailure(sc) { return sc === 401 || sc === 403 || sc === 429 || sc >= 500; }
function _markKeyFailed(p, key, status, body) {
  if (_isQuotaError(status, body)) markKeyQuotaExhausted(p, key);
  else markKeyError(p, key);
}

function markKeySuccess(p, key, latency) {
  const s = keyPool.get(p)?.get(key);
  if (!s) return;
// Success clears cooldown and consecutive-error count outright.
  if (s.errorCount > 0 || s.degradedUntil > 0) { s.errorCount = 0; s.degradedUntil = 0; }
  _noteRecovered(p, key);
  const ru = _keyRetryUntil.get(p); if (ru) ru.delete(key);
  s.successCount++;
  s.lastSuccess = Date.now();
  if (latency != null) s.lastLatency = Math.round(latency);
    const _k = `${p}:${key}`;
  if (_recent401.has(_k)) {
    const e = _recent401.get(_k);
    if (e.retryAfter && Date.now() > e.retryAfter) _recent401.delete(_k);
  }
}

const _recent401 = new Map();
function markKey401(p, key, model) {
  const _k = `${p}:${key}`;
  _recent401.set(_k, { provider: p, key, model, ts: Date.now(), retryAfter: Date.now() + 3600000 });
  const now = Date.now();
  for (const [k, v] of _recent401) { if (now > v.retryAfter) _recent401.delete(k); }
  // a 401 means the credential itself is rejected; keep it out of rotation for
  // the same hour after a restart, otherwise every boot re-hits dead keys
  initProvider(p);
  const s = keyPool.get(p)?.get(key);
  if (s) { s.degradedUntil = now + 3600000; s.errorCount = Math.max(s.errorCount, 4); _noteDegraded(p, key); }
}

const keyInFlight = new Map(); // key -> timestamp
const rrCursor = new Map();
const modelCursor = new Map();
let _flightCleanTick = 0;
const _providerActive = new Map();
function addActive(p) { _providerActive.set(p, (_providerActive.get(p) || 0) + 1); }
function decActive(p) {
  const c = (_providerActive.get(p) || 0) - 1;
  if (c <= 0) _providerActive.delete(p); else _providerActive.set(p, c);
}

function rotateTargets(targets, clientModel) {
  if (targets.length <= 1) return targets;
  let idx = modelCursor.get(clientModel) ?? 0;
  idx = idx % targets.length;
  modelCursor.set(clientModel, (idx + 1) % targets.length);
  return [...targets.slice(idx), ...targets.slice(0, idx)];
}

async function selectKey(p, signal) {
  const healthy = getHealthyKeys(p);
  if (healthy.length === 0) return null;
  const now = Date.now();
  _flightCleanTick = (_flightCleanTick + 1) % FLIGHT_CLEAN_EVERY;
  if (_flightCleanTick === 0) for (const [k, ts] of keyInFlight) if (now - ts > IN_FLIGHT_TIMEOUT_MS) keyInFlight.delete(k);
  const free = healthy.filter(k => {
    const v = keyInFlight.get(`${p}:${k}`);
    if (!v) return true;
    if (now - v > IN_FLIGHT_TIMEOUT_MS) { keyInFlight.delete(`${p}:${k}`); return true; }
    return false;
  });
  if (free.length > 0) {
    // note: fewest-error keys share traffic round-robin; worse keys are failover-only
    let best = Infinity;
    for (const k of free) { const e = keyPool.get(p).get(k).errorCount; if (e < best) best = e; }
    const top = free.filter(k => keyPool.get(p).get(k).errorCount === best).sort();
    const n = rrCursor.get(p) ?? 0;
    // note: bound cursor to avoid unbounded growth; modulo top.length at use keeps RR deterministic
    rrCursor.set(p, (n + 1) % 1000000);
    const key = top[n % top.length];
    keyInFlight.set(`${p}:${key}`, Date.now());
// Reservation held across the wait, released if the wait is interrupted.
    try {
      await waitRateLimit(p, key, signal);
    } catch (e) {
      releaseKey(p, key);
      throw e;
    }
    if (signal?.aborted) { releaseKey(p, key); return null; }
    // The wait above can exceed IN_FLIGHT_TIMEOUT_MS (Retry-After quota
    // backoff); refresh the stamp so the stale sweep doesn't free a key we are
    // about to use.
    keyInFlight.set(`${p}:${key}`, Date.now());
    return key;
  }
  return null;
}

function releaseKey(p, key) {
  if (p && key) keyInFlight.delete(`${p}:${key}`);
}

// --- low-level helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const logKey = lib.logKey;
const _safeSlice = lib._safeSlice;
const _statusIcon = (sc) => (sc === 200 ? '✅' : sc === 401 ? '⚠️' : '❌');
const LOG_BODY_MAX = parseInt(process.env.LOG_BODY_MAX || '2000', 10);

let _ridSeq = 0;
function rid() {
  return Date.now().toString(36) + (++_ridSeq).toString(36) + Math.random().toString(36).slice(2, 4);
}

function formatUptime(sec) { return lib.formatUptime(sec); }

function rewriteModelInSse(chunk, toModel) { return lib.rewriteModelInSse(chunk, toModel); }

// Hold slot/key/accounting until the transfer finishes — headers are not success.
function _pipeWithAccounting(up, res, o) {
  const { provider, model, key, t0, logId } = o;
  const settleFail = (msg) => {
    try { markKeyError(provider, key); } catch {}
    _recordProviderFailure(provider, t0);
    if (model) _recordModelFailure(provider, model);
    logEvent({ logId, provider, model: model || '-', key: key || '-', status: 502, body: msg || 'upstream stream aborted' });
  };
  const settleOk = () => {
    markKeySuccess(provider, key, Date.now() - t0);
    _recordProviderSuccess(provider, t0);
    if (model) _recordModelSuccess(provider, model, t0);
    _adjustRpm(provider, true);
    logEvent({ logId, provider, model: model || '-', key, latency: (Date.now() - t0) / 1000, tokens: o.tokens || 0 });
  };
  let settled = false;
  const done = (how, msg) => {
    if (settled) return; settled = true;
    decActive(provider); releaseKey(provider, key);
    if (how === 'ok') settleOk();
    else if (how === 'fail') settleFail(msg);
    // 'cancel': client hung up mid-transfer — release resources only. The old
    // done(false, null) went through settleFail, so a few client cancels could
    // degrade the key, lock the model and open the provider circuit.
  };
  up.on('end', () => done('ok'));
  up.on('error', (e) => { try { res.end(); } catch {} done('fail', e?.message || 'upstream stream error'); });
  up.on('aborted', () => { try { res.end(); } catch {} done('fail', 'upstream aborted'); });
  res.on('close', () => { if (!res.writableEnded) { try { up.destroy(); } catch {} done('cancel'); } });
  up.pipe(res);
}

// '' only on clean empty end; null on abort (cap/timeout/error). Never treat
// null as empty — chunked stalls have no content-length to cross-check.
function collectBody(res, maxBytes) {
  const cap = maxBytes || (typeof UPSTREAM_MAX_BODY!=='undefined'?UPSTREAM_MAX_BODY:20*1024*1024);
// Socket timeout covers headers only; bound the body phase with its own timer.
  const idleMs = (typeof UPSTREAM_TIMEOUT_MS!=='undefined'?UPSTREAM_TIMEOUT_MS:120000);
  return new Promise((res2) => {
    const c = []; let n = 0; let done=false; let timer=null;
    const finish = (v) => { if (done) return; done=true; if (timer) { clearTimeout(timer); timer=null; } for (const [ev, fn] of [['data', onData], ['end', onEnd], ['error', onErr], ['aborted', onErr], ['close', onErr]]) { try { res.removeListener(ev, fn); } catch{} } res2(v); };
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { try{res.destroy();}catch{} finish(null); }, idleMs).unref(); };
    const onData = (d) => { if(done) return; n += d.length; if (n > cap) { try{res.destroy();}catch{} finish(null); return; } c.push(d); arm(); };
    const onEnd = () => { if(done) return; let out=''; try { out = Buffer.concat(c).toString(); } catch { out=''; } finish(out); };
    const onErr = () => finish(null);
    res.on('data', onData); res.on('end', onEnd); res.on('error', onErr);
    // Premature close fires neither 'end' nor 'error': without these listeners
    // the promise waits out the whole idle timer with key + slot still held.
    res.on('aborted', onErr); res.on('close', onErr);
    arm();
  });
}

// --- token-based alias routing ---
const PROVIDER_DEFAULT_LIMITS = {};
const USER_MODEL_LIMITS = new Map(Object.entries(cfg.model_limits || {}).map(([k, v]) => [k.toLowerCase(), v]));
// Coerce to number: a JSON typo like "60000" (string) would otherwise become
// string concatenation in the interval math and wedge isRateLimited forever.
const RATE_LIMITS = new Map(Object.entries(cfg.rate_limit || {})
  .map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v) && v > 0));
const PROVIDER_RPM = {
  literouter: 1,
  pollinations: 10,
  gpt4free: 10,
  mistral: 10,
  llm7: 15,
  nvidia: 15,
  openrouter: 10,
  groq: 12,
  cerebras: 5,
  deepseek: 12,
  'agnes-ai': 10,
  navy: 10,
  ollama: 10,
  'sea-lion': 5,
  kilo: 1,
  openai: 10,
  xai: 10,
  together: 10,
  cohere: 10,
  perplexity: 10,
  huggingface: 10,
  replicate: 10,
  baseten: 10,
  parallel: 10,
  orcarouter: 10,
  morph: 10,
  vyceai: 10,
  apinex: 10,
  // 下修容易觸發 429 的 provider，降低自動計算的速率限制間隔
  amd: 1,
};

const DEFAULT_MANUAL_RPM = 10;
// Providers whose interval was AUTO-derived here. _adjustRpm may retune only
// these: an explicit cfg.rate_limit entry is operator policy, and letting the
// adaptive logic rewrite it turned one 429 into a permanently stretched
// interval (a configured 60ms became max(100, 60000/(cur/keys)) ≈ seconds).
const _autoRpmProviders = new Set();
for (const [p, keys] of Object.entries(PROVIDER_KEYS)) {
  if (keys.length === 0) continue;
  const manual = provMeta[p] && provMeta[p].baseUrl;
  const rpm = PROVIDER_RPM[p] || (provMeta[p] && provMeta[p].rpm) || (manual ? DEFAULT_MANUAL_RPM : undefined);
  if (rpm && !RATE_LIMITS.has(p)) {
    RATE_LIMITS.set(p, Math.max(100, Math.round(60000 / (rpm / keys.length))));
    _autoRpmProviders.add(p);
  }
}

const _referencedProviders = new Set(
  [...Object.values(MODELS).flatMap(v => Array.isArray(v) ? v.map(t => t.provider) : []),
   ...Object.values(ENDPOINT_FALLBACKS).flatMap(a => {
     const v = MODELS[a];
     return (Array.isArray(v) ? v : (typeof v === 'string' ? [{ provider: v }] : [])).map(t => t.provider);
   })]
);
for (const [p, keys] of Object.entries(PROVIDER_KEYS)) {
  if (keys.length === 0) continue;
  if (!_referencedProviders.has(p)) continue;
  if (!PROVIDER_RPM[p] && !provMeta[p]?.rpm && !provMeta[p]?.baseUrl) {
    log('─');
    log(`⚠️  [config] provider "${p}" has keys but no explicit RPM (will use DEFAULT_MANUAL_RPM=${DEFAULT_MANUAL_RPM})`);
  }
}
const _effectiveRPM = new Map(Object.entries(PROVIDER_RPM));
const _successStreak = new Map();
function _adjustRpm(provider, success) {
  // only retune auto-derived intervals — explicit cfg.rate_limit is policy
  if (!_autoRpmProviders.has(provider)) return;
  const orig = PROVIDER_RPM[provider] ?? provMeta[provider]?.rpm ?? DEFAULT_MANUAL_RPM;
  if (!orig) return;
  let cur = _effectiveRPM.get(provider) ?? orig;
  if (success) {
    const streak = (_successStreak.get(provider) || 0) + 1;
    _successStreak.set(provider, streak);
    if (streak >= 10 && cur < orig) {
      cur = Math.min(orig, cur + 1);
      _effectiveRPM.set(provider, cur);
      const keys = PROVIDER_KEYS[provider]?.length || 1;
      RATE_LIMITS.set(provider, Math.max(100, Math.round(60000 / (cur / keys))));
      _successStreak.set(provider, 0);
    }
  } else {
    _successStreak.set(provider, 0);
    cur = Math.max(1, Math.floor(cur * 0.7));
    _effectiveRPM.set(provider, cur);
    const keys = PROVIDER_KEYS[provider]?.length || 1;
    RATE_LIMITS.set(provider, Math.max(100, Math.round(60000 / (cur / keys))));
  }
}
const _keyLastUsed = new Map(); // provider → Map(key → last timestamp)
const _keyRetryUntil = new Map(); // provider → Map(key → Retry-After deadline, separate from dispatch time)
async function waitRateLimit(provider, key, signal) {
  const interval = RATE_LIMITS.get(provider);
  const retryAt = _keyRetryUntil.get(provider)?.get(key) || 0;
  if (!interval && !retryAt) return;
  if (!_keyLastUsed.has(provider)) _keyLastUsed.set(provider, new Map());
  const byProv = _keyLastUsed.get(provider);
// Reserve BEFORE awaiting, or N callers sleep the same interval and stampede.
  const now = Date.now();
  const next = Math.max(now, (byProv.get(key) || 0) + (interval || 0), retryAt);
  byProv.set(key, next);
  _noteRpmRequest(provider);
  if (next > now) await new Promise((r) => {
    const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); r(); };
    const onAbort = done;
    const t = setTimeout(done, next - now);
    if (signal) {
      if (signal.aborted) { done(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
function isRateLimited(provider) {
  // No healthy key available (all in error-cooldown) → effectively limited
  if (getHealthyKeys(provider).length === 0) return true;
  const interval = RATE_LIMITS.get(provider);
  if (!interval) return false;
  const byProv = _keyLastUsed.get(provider);
  if (!byProv) return false;
  const keys = PROVIDER_KEYS[provider] || [];
  for (const k of keys) {
    const last = byProv.get(k);
    if (!last || (Date.now() - last) >= interval) return false;
  }
  return true;
}

// --- circuit breaker ---
const _circuitBreaker = new Map();

// --- model lockout (per-provider/model circuit: a broken model ID or saturated free tier) ---
// Coerce via _cfgNum: `now + "30000"` concatenates into a huge number and the
// breaker/lockout would never close.
const MODEL_LOCKOUT_THRESHOLD = _cfgNum(undefined, cfg.model_lockout?.threshold, 3);
const MODEL_LOCKOUT_MS = _cfgNum(undefined, cfg.model_lockout?.cooldown_ms ?? cfg.model_lockout?.cooldown, 60000);

// --- circuit breaker ---
const CB_THRESHOLD = _cfgNum(undefined, cfg.circuit_breaker?.threshold, 5);
const CB_COOLDOWN_MS = _cfgNum(undefined, cfg.circuit_breaker?.cooldown_ms, 30000);

// --- provider concurrency ---
const PROVIDER_MAX_CONCURRENT = _cfgNum(undefined, cfg.provider_concurrency?.max_concurrent, 4) || 4;

// A success only clears failure state older than the request that produced it.
const _modelFails = new Map(); // "provider/model" → { count, until, lastFailAt }
function _modelKey(provider, model) { return `${provider}/${model}`; }
function _recordModelFailure(provider, model, startedAt) {
  if (!model) return;
  const k = _modelKey(provider, model);
  const now = Date.now();
  const e = _modelFails.get(k) || { count: 0, until: 0, lastFailAt: 0 };
  e.count++;
  // Record the REQUEST start, not the report time: successClearsFailure
  // compares request starts, so a later-started success must win.
  e.lastFailAt = startedAt || now;
  if (e.count >= MODEL_LOCKOUT_THRESHOLD && !e.until) {
    e.until = now + MODEL_LOCKOUT_MS;
    log('─'); log(`⚠️ [lockout] ${k} locked (${e.count}/${MODEL_LOCKOUT_THRESHOLD} failures, cooldown ${MODEL_LOCKOUT_MS}ms)`);
  }
  _modelFails.set(k, e);
}
function _recordModelSuccess(provider, model, startedAt) {
  if (!model) return;
  const k = _modelKey(provider, model);
  const before = _modelFails.get(k);
  if (!before) return;
  // success belongs to a request that began before these failures → stale
  if (!lib.successClearsFailure(before.lastFailAt, startedAt)) return;
  log('─'); log(`✅ [lockout] ${k} cleared (after ${before.count} failures)`);
  _modelFails.delete(k);
}
function _isModelLocked(provider, model) {
  const e = _modelFails.get(_modelKey(provider, model));
  if (!e || !e.until) return false;
  if (Date.now() >= e.until) { _modelFails.delete(_modelKey(provider, model)); return false; }
  return true;
}

function _recordProviderFailure(provider) {
  const now = Date.now();
  const entry = _circuitBreaker.get(provider) || { count: 0, openUntil: 0, lastFailAt: 0 };
  entry.count++;
  entry.lastFailAt = now;
  if (entry.count >= CB_THRESHOLD && !entry.openUntil) {
    entry.openUntil = now + CB_COOLDOWN_MS;
    log('─'); log(`⚠️ [circuit] ${provider} opened (${entry.count}/${CB_THRESHOLD} failures, cooldown ${CB_COOLDOWN_MS}ms)`);
  }
  _circuitBreaker.set(provider, entry);
}
function _recordProviderSuccess(provider, startedAt) {
  const before = _circuitBreaker.get(provider);
  if (!before) return;
  if (!lib.successClearsFailure(before.lastFailAt, startedAt)) return; // newer failures win
  log('─'); log(`✅ [circuit] ${provider} closed (after ${before.count} failures)`);
  _circuitBreaker.delete(provider);
}
function _isCircuitOpen(provider) {
  const entry = _circuitBreaker.get(provider);
  if (!entry || !entry.openUntil) return false;
  if (Date.now() >= entry.openUntil) { _circuitBreaker.delete(provider); return false; }
  return true;
}

const TPM_LIMITS = new Map(Object.entries(cfg.tpm_limit || {})
  .map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v) && v > 0));
const _tpmLog = new Map(); // provider → Map(key → [{ts, tokens}])
function _tpmClean(entries) {
  const cutoff = Date.now() - 60000; let i = 0;
  while (i < entries.length && entries[i].ts < cutoff) i++;
  if (i > 0) entries.splice(0, i);
  if (entries.length > 1000) entries.splice(0, entries.length - 1000);
}
function _tpmSum(entries) { return entries.reduce((s, e) => s + e.tokens, 0); }
async function waitTpmLimit(provider, key, tokens, signal) {
  const limit = TPM_LIMITS.get(provider);
  if (!limit || !tokens) return;
  if (!_tpmLog.has(provider)) _tpmLog.set(provider, new Map());
  const byProv = _tpmLog.get(provider);
  if (!byProv.has(key)) byProv.set(key, []);
  const entries = byProv.get(key);
// Reserve BEFORE waiting (same stampede fix); removed if the wait aborts.
  const reserved = { ts: Date.now(), tokens, reserved: true };
  const unreserve = () => { const i = entries.indexOf(reserved); if (i >= 0) entries.splice(i, 1); };
  entries.push(reserved);
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      _tpmClean(entries);
      // budget consumed by everyone else (our own reservation excluded)
      const sum = _tpmSum(entries.filter((e) => e !== reserved));
      if (sum + tokens <= limit) break;
      // wait on the oldest entry that is not ours — ours must never become
      // the wait baseline, or a lone waiter sleeps a full window needlessly
      const head = entries.find((e) => e !== reserved);
      if (!head) break;
      const wait = head.ts + 60000 - Date.now() + 50;
      if (wait <= 0) continue;          // clean advanced past it; re-evaluate
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, wait);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
    }
    reserved.ts = Date.now();
    delete reserved.reserved;
  } catch (e) {
    unreserve();
    throw e;
  }
}
function getAliasLimit(alias) {
  const t = resolveModel(alias)?.[0];
  if (!t) return 999999;
  const aliasProv = t.provider;
  const key = `${aliasProv}/${t.model || alias}`.toLowerCase();
  return USER_MODEL_LIMITS.get(key) || PROVIDER_DEFAULT_LIMITS[t.provider] || 999999;
}
let TOKEN_ORDER = [];
function rebuildTokenOrder() {
  const aliases = Object.keys(cfg.models || {});
  TOKEN_ORDER = aliases.map(a => [a, getAliasLimit(a)]).sort((a, b) => a[1] - b[1]).map(([a]) => a);
}
rebuildTokenOrder();

// note: smart_route families pin overflow inside an explicit tier chain (lite→heavy),
// so a big chat prompt can no longer land on audio/image aliases via global overflow.
// shape: "alias": [{alias, max_tokens}]  or  "alias": {tiers: [...], classify: {labels, pin, threshold, min_chars}}
const SMART_ROUTE = new Map();
for (const [name, raw] of Object.entries(cfg.smart_route || {})) {
  if (name.startsWith('_')) continue;
  const tiers = Array.isArray(raw) ? raw : raw?.tiers;
  if (typeof name !== 'string' || !Array.isArray(tiers)) { elog(`⚠️ [config] smart_route "${name}" must map to a tier array or {tiers, classify} — ignored`); continue; }
  const clean = tiers
    .filter(t => t && typeof t.alias === 'string' && typeof t.max_tokens === 'number' && t.max_tokens > 0)
    .sort((a, b) => a.max_tokens - b.max_tokens);
  if (clean.length === 0) { elog(`⚠️ [config] smart_route "${name}" has no valid tiers — ignored`); continue; }
  for (const t of clean) {
    if (!MODELS[t.alias] && !Object.keys(MODELS).some(k => k.toLowerCase() === t.alias.toLowerCase())) {
      elog(`⚠️ [config] smart_route "${name}" tier alias "${t.alias}" not found in models`);
    }
  }
  if (!Array.isArray(raw) && raw && typeof raw.classify === 'object') {
    elog(`⚠️ [config] smart_route "${name}".classify was removed — use POST /v1/classifier instead`);
  }
  SMART_ROUTE.set(name.toLowerCase(), { tiers: clean });
}
// note: legacy overflow skips aliases claimed by non-chat endpoint_fallbacks (tts/stt/image/…)
const NON_CHAT_ALIASES = lib.buildNonChatAliases(ENDPOINT_FALLBACKS);

// --- classifier.dev as a passive upstream (POST /v1/classifier relay, /v1/classify alias; key optional) ---
// note: the gateway never calls it on its own — clients/agents decide when to classify
const CLASSIFIER = cfg.classifier || {};
// note: memoizer budget defaults (2000 entries / 8MB / 1h TTL), overridable via classifier.cache.
const _clsMemo = lib.createMemoCache({
  maxEntries: CLASSIFIER.cache?.max_entries ?? 2000,
  maxBytes: CLASSIFIER.cache?.max_bytes ?? 8 * 1024 * 1024,
  ttlMs: CLASSIFIER.cache?.ttl_ms ?? 3600000,
});
const CLS_MEMO_ON = CLASSIFIER.cache?.enabled !== false;
if (CLASSIFIER.enabled === true || CLASSIFIER.moderation) {
  elog('⚠️ [config] classifier.enabled/moderation were removed — in-request classification is gone; use POST /v1/classifier instead');
}

function estimateStrTokens(str) { return lib.estimateStrTokens(str); }
function estimateTokens(messages) { return lib.estimateTokens(messages); }


// --- context sanitization ---
const REASONING_PROVIDERS = new Set(['deepseek', 'opencode', 'nvidia']);
const STRICT_ORDER_PROVIDERS = new Set(['nvidia']);
// non-text (vision) content unsupported — log-verified 400s ("does not support vision input")
const NO_NON_TEXT_TARGETS = new Set(['llm7/codestral-latest', 'llm7/gpt-oss:20b'].map(s => s.toLowerCase()));

// Voice ID defaults — OpenAI voice name → provider voice ID
const VOICE_MAP_CARTESIA = { alloy: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', echo: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', fable: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', onyx: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', nova: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', shimmer: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4' };
const VOICE_MAP_ELEVENLABS = { alloy: 'JBFqnCBsd6RMkjVDRZzb', echo: 'JBFqnCBsd6RMkjVDRZzb', fable: 'JBFqnCBsd6RMkjVDRZzb', onyx: 'JBFqnCBsd6RMkjVDRZzb', nova: 'JBFqnCBsd6RMkjVDRZzb', shimmer: 'JBFqnCBsd6RMkjVDRZzb' };

function buildTTSRequest(provider, body, upstreamModel, base) {
  if (_isCFBase(base)) {
    return {
      path: _cfRunPath(upstreamModel),
      headers: {},
      contentType: 'application/json',
      body: JSON.stringify({ prompt: String(body.input || '') })
    };
  }
  if (provider === 'cartesia') {
    const voiceId = VOICE_MAP_CARTESIA[body.voice] || body.voice || 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
    return {
      path: '/tts/bytes',
      headers: { 'Cartesia-Version': '2026-03-01' },
      contentType: 'application/json',
      body: JSON.stringify({
        model_id: upstreamModel, transcript: body.input,
        voice: { mode: 'id', id: voiceId },
        output_format: { container: body.response_format || 'mp3', sample_rate: 44100 }
      })
    };
  }
  if (provider === 'elevenlabs') {
    const voiceId = VOICE_MAP_ELEVENLABS[body.voice] || body.voice || 'JBFqnCBsd6RMkjVDRZzb';
    const fmt = body.response_format || 'mp3';
    return {
      path: `/v1/text-to-speech/${voiceId}?output_format=${fmt}_44100_128`,
      headers: {},
      contentType: 'application/json',
      body: JSON.stringify({ text: body.input, model_id: upstreamModel })
    };
  }
  return null; // OpenAI-compatible, use default proxy flow
}

function _sanitizeToolIds(msg, idMap) { return lib._sanitizeToolIds(msg, idMap); }
function normalizeMessageOrder(messages) { return lib.normalizeMessageOrder(messages); }

// --- shared audio request handler (TTS/STT) ---
function patchMultipartField(raw, fieldName, newValue) {
  const needle = Buffer.from(`name="${fieldName}"`);
  const idx = raw.indexOf(needle);
  if (idx === -1) return raw;
  const probe = raw.toString('utf8', Math.max(0, idx - 200), idx);
  if (!probe.includes('Content-Disposition')) return raw;
  const start = raw.indexOf(Buffer.from('\r\n\r\n'), idx);
  if (start === -1) return raw;
  const dataStart = start + 4;
  const end = raw.indexOf(Buffer.from('\r\n'), dataStart);
  if (end === -1) return raw;
  const oldVal = raw.toString('utf8', dataStart, end);
  if (oldVal === newValue) return raw;
  // dataStart/end are BYTE offsets — sizing by UTF-16 string length pads or
  // overlaps the tail whenever the value contains multi-byte characters.
  const newBytes = Buffer.byteLength(newValue, 'utf8');
  const out = Buffer.alloc(raw.length - (end - dataStart) + newBytes);
  raw.copy(out, 0, 0, dataStart);
  out.write(newValue, dataStart);
  raw.copy(out, dataStart + newBytes, end);
  return out;
}

function patchMultipartFieldName(raw, oldName, newName) {
  const needle = Buffer.from(`name="${oldName}"`);
  const idx = raw.indexOf(needle);
  if (idx === -1) return raw;
  const probe = raw.toString('utf8', Math.max(0, idx - 200), idx);
  if (!probe.includes('Content-Disposition')) return raw;
  const repl = Buffer.from(`name="${newName}"`);
  if (repl.length === needle.length) {
    repl.copy(raw, idx);
    return raw;
  }
  const out = Buffer.alloc(raw.length - needle.length + repl.length);
  raw.copy(out, 0, 0, idx);
  repl.copy(out, idx);
  raw.copy(out, idx + repl.length, idx + needle.length);
  return out;
}

function _extractMultipartFile(rawBody, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = m ? (m[1] || m[2]).trim() : '';
  const fileIdx = rawBody.indexOf(Buffer.from('name="file"'));
  if (fileIdx === -1) return null;
  const headEnd = rawBody.indexOf(Buffer.from('\r\n\r\n'), fileIdx);
  if (headEnd === -1) return null;
  const ctM = rawBody.toString('latin1', fileIdx, headEnd).match(/content-type:\s*([^\r\n]+)/i);
  const marker = boundary ? Buffer.from('\r\n--' + boundary) : Buffer.from('\r\n--');
  const start = headEnd + 4;
  const end = rawBody.indexOf(marker, start);
  return { buf: rawBody.slice(start, end === -1 ? rawBody.length : end), ctype: ctM ? ctM[1].trim() : 'audio/wav' };
}

async function handleAudioRequest(req, res, logId, { clientModel, endpointPath, rawBody, contentType, buildBody, handleSuccess, failLabel }) {
  const t0 = Date.now();
  log('─');
  let targets = resolveModelForEndpoint(clientModel, endpointPath);
  if (!targets) targets = [{ provider: 'openai', upstreamModel: clientModel || '' }];
  log(`[${logId}] ⚡ ${clientModel}  ${endpointPath}`);
  const activeTargets = targets.filter(t => PROVIDERS_WITH_KEYS.has(t.provider) && DIRECT_PROVIDERS[t.provider]);
  if (activeTargets.length === 0) {
    sendError(res, 400, 'no keys available for this model', { code: 'no_available_providers' });
    return;
  }
  let lastErr = null;
  const skippedProviders = new Set();
  let clientGone = false;
  const ac = new AbortController(), sig = ac.signal;
  res.on('close', () => { if (res.writableEnded) return; clientGone = true; if (!sig.aborted) ac.abort(); });
  let retryRound = 0;
  let transientSkipped = false;
  while (!clientGone && Date.now() - t0 < TIMEOUT_MS && (retryRound < RETRY_MAX_ROUNDS || transientSkipped)) {
    if (retryRound > 0) {
      const wait = (transientSkipped && !lastErr) ? RETRY_TRANSIENT_WAIT : Math.min(retryRound * RETRY_BASE_DELAY, RETRY_MAX_DELAY);
      log(`[${logId}] 🔄 retry ${retryRound} — wait ${wait}ms${transientSkipped && !lastErr ? ' (transient)' : ''}`);
      await sleep(wait);
    }
    retryRound++;
    transientSkipped = false;
    const rotatedTargets = rotateTargets(activeTargets, clientModel);
    for (const target of rotatedTargets) {
      if (clientGone) return;
      const { provider, upstreamModel } = target;
      if (skippedProviders.has(provider)) continue;
      if (_isModelLocked(provider, upstreamModel)) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (model lockout)`); continue; }
      if (isRateLimited(provider)) { transientSkipped = true; continue; }
      if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) { transientSkipped = true; continue; }
      if (_isCircuitOpen(provider)) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (circuit breaker)`); transientSkipped = true; continue; }
      const key = await selectKey(provider, sig);
      if (!key) { if (clientGone) return; transientSkipped = true; continue; }
      const base = DIRECT_PROVIDERS[provider];
      const built = buildBody(provider, upstreamModel, base, key);
      try {
        addActive(provider);
        const up = await forwardToDirect(key, built.body, base, built.path, '*/*', built.contentType, built.extraHeaders, sig);
        const sc = up.statusCode;
        if (sc >= 200 && sc < 300) {
          const handled = await handleSuccess(up, provider, upstreamModel, key, base, sc);
          if (handled) return;
          continue;
        }
        decActive(provider); releaseKey(provider, key);
        const errBody = await collectBody(up);
        if (_isHealthFailure(sc)) _markKeyFailed(provider, key, sc, errBody);
        if (sc === 429) await _handleUpstream429(provider, key, up, errBody, logId, res);
        lastErr = { status: sc, body: errBody };
        if (sc >= 500) _recordProviderFailure(provider);
        // same policy as chat: only credential/429/5xx failures lock the model
        if (sc === 401 || sc === 403 || sc === 429 || sc >= 500) _recordModelFailure(provider, upstreamModel, t0);
        if (sc === 401) markKey401(provider, key, upstreamModel);
        if (sc !== 429) skippedProviders.add(provider);
      } catch (e) {
        decActive(provider);
        // A client cancel rejects 'aborted' — not an upstream fault.
        const aborted = clientGone || (e.message || '').startsWith('aborted');
        if (!aborted) markKeyError(provider, key);
        releaseKey(provider, key);
        if (!aborted) { _recordProviderFailure(provider); _recordModelFailure(provider, upstreamModel, t0); }
        lastErr = { status: 502, body: e.message };
      }
    }
    const anyRetryable = rotatedTargets.some(t => !skippedProviders.has(t.provider) && !_isModelLocked(t.provider, t.upstreamModel));
    if (!transientSkipped && (!lastErr || !anyRetryable)) break;
  }
  const errMsg = lastErr ? (typeof lastErr.body === 'string' ? lastErr.body : JSON.stringify(lastErr.body)) : 'no upstream';
  log(`[${logId}] ${_statusIcon(lastErr?.status || 502)} ${lastErr?.status||502} ${failLabel} failed ${_errMsg(errMsg)}`);
  // HTTP stays 502 (same policy as chat): an upstream 400/401 must not
  // masquerade as the client's own credential/request error.
  sendError(res, 502, `${failLabel} failed: ${_safeSlice(errMsg, 300)}`, { code: 'upstream_unavailable', logId });
}

function buildTTSBody(bodyJson) {
  return (provider, upstreamModel, base) => {
    const adapter = buildTTSRequest(provider, bodyJson, upstreamModel, base);
    return {
      body: adapter ? adapter.body : JSON.stringify({ ...bodyJson, model: upstreamModel }),
      path: adapter ? adapter.path : (DIRECT_PATH_PREFIX[provider] || '/v1') + '/audio/speech',
      contentType: adapter ? adapter.contentType : 'application/json',
      extraHeaders: adapter ? adapter.headers : {},
    };
  };
}

function ttsHandleSuccess(res, logId, t0) {
  return async (up, provider, upstreamModel, key, base, sc) => {
    if (_isCFBase(base)) {
      const raw = (await collectBody(up)) ?? '';
      let audio = '';
      try { audio = JSON.parse(raw.toString()).result?.audio || ''; } catch {}
      decActive(provider); releaseKey(provider, key);
      if (!audio) {
        _markKeyFailed(provider, key, 502, raw.toString());
        log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] cf tts bad response ${_errMsg(raw.toString())}`);
        return false;
      }
      recordSuccess(logId, provider, upstreamModel, key, Date.now()-t0, 0, t0); _adjustRpm(provider, true);
      log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
      _clearUpstream429Signal(res);
      res.writeHead(sc, { 'Content-Type': 'audio/wav', 'X-Request-Id': logId, 'X-Provider': provider });
      res.end(Buffer.from(audio, 'base64'));
      return true;
    }
    log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
    _clearUpstream429Signal(res);
    res.writeHead(sc, { 'Content-Type': up.headers['content-type'] || 'audio/mpeg', 'X-Request-Id': logId, 'X-Provider': provider, ..._rlHeaders(provider, up) });
    _pipeWithAccounting(up, res, { provider, model: upstreamModel, key, t0, logId, tokens: 0 });
    return true;
  };
}

async function handleTTS(req, res, bodyJson, logId) {
  if (!bodyJson || !bodyJson.input) {
    sendError(res, 400, 'input required', { type: 'invalid_request_error' });
    return;
  }
  const t0 = Date.now();
  await handleAudioRequest(req, res, logId, {
    clientModel: bodyJson?.model || '',
    endpointPath: '/v1/audio/speech',
    buildBody: buildTTSBody(bodyJson),
    handleSuccess: ttsHandleSuccess(res, logId, t0),
    failLabel: 'tts',
  });
}

function buildSTTBody(rawBody, contentType) {
  return (provider, upstreamModel, base, key) => {
    let body = rawBody;
    let ep, extraHdrs = {};
    const cfBase = _isCFBase(base);
    if (cfBase) {
      const file = _extractMultipartFile(rawBody, contentType);
      body = file ? file.buf : rawBody;
      ep = _cfRunPath(upstreamModel);
      extraHdrs = { 'Content-Type': file ? file.ctype : 'audio/wav' };
    } else if (provider === 'cartesia') {
      body = patchMultipartField(rawBody, 'model', upstreamModel);
      ep = '/stt';
      extraHdrs = { 'Cartesia-Version': '2026-03-01' };
    } else if (provider === 'elevenlabs') {
      body = patchMultipartFieldName(rawBody, 'model', 'model_id');
      body = patchMultipartField(body, 'model_id', upstreamModel);
      ep = '/v1/speech-to-text';
      extraHdrs = { 'xi-api-key': key };
    } else {
      // OpenAI-compatible STT is multipart too — the upstream must receive the
      // mapped upstream model, not the client's alias (cartesia/elevenlabs
      // patch above; this branch used to forward the alias verbatim).
      body = upstreamModel ? patchMultipartField(rawBody, 'model', upstreamModel) : rawBody;
      ep = (DIRECT_PATH_PREFIX[provider] || '/v1') + '/audio/transcriptions';
    }
    const ctype = cfBase ? undefined : (provider === 'cartesia' || provider === 'elevenlabs' ? (contentType || 'multipart/form-data') : (contentType || 'application/octet-stream'));
    return { body, path: ep, contentType: ctype, extraHeaders: extraHdrs };
  };
}

function sttHandleSuccess(res, logId, t0) {
  return async (up, provider, upstreamModel, key, base, sc) => {
    const cfBase = _isCFBase(base);
    const raw = await collectBody(up);
    if (raw === null) {
      // aborted/oversize/idle — never answer 200 with an empty body
      decActive(provider); releaseKey(provider, key);
      if (res.writableEnded || res.destroyed) return true; // client gone, nothing to answer
      _markKeyFailed(provider, key, 502, 'upstream body collection aborted');
      log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] upstream body aborted`);
      return false;
    }
    if (cfBase) {
      let text = '';
      try { text = JSON.parse(raw.toString()).result?.text || ''; } catch {}
      decActive(provider); releaseKey(provider, key);
      if (!text) {
        _markKeyFailed(provider, key, 502, raw.toString());
        log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] cf stt bad response ${_errMsg(raw.toString())}`);
        return false;
      }
      recordSuccess(logId, provider, upstreamModel, key, Date.now()-t0, 0, t0); _adjustRpm(provider, true);
      log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
      _clearUpstream429Signal(res);
      res.writeHead(sc, { 'Content-Type': 'application/json', 'X-Request-Id': logId, 'X-Provider': provider });
      res.end(JSON.stringify({ text }));
      return true;
    }
    decActive(provider); releaseKey(provider, key); recordSuccess(logId, provider, upstreamModel, key, Date.now()-t0, 0, t0); _adjustRpm(provider, true);
    log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
    _clearUpstream429Signal(res);
    res.writeHead(sc, { 'Content-Type': 'application/json', 'X-Request-Id': logId, 'X-Provider': provider });
    res.end(raw);
    return true;
  };
}

async function handleSTT(req, res, rawBody, logId, contentType) {
  let clientModel = '';
  const modelNeedle = Buffer.from('name="model"');
  const mi = rawBody.indexOf(modelNeedle);
  if (mi !== -1) {
    const valStart = rawBody.indexOf(Buffer.from('\r\n\r\n'), mi);
    if (valStart !== -1) {
      const dataStart = valStart + 4;
      const valEnd = rawBody.indexOf(Buffer.from('\r\n'), dataStart);
      if (valEnd !== -1) clientModel = rawBody.toString('utf8', dataStart, valEnd).trim();
    }
  }
  const t0 = Date.now();
  await handleAudioRequest(req, res, logId, {
    clientModel,
    endpointPath: '/v1/audio/transcriptions',
    rawBody, contentType,
    buildBody: buildSTTBody(rawBody, contentType),
    handleSuccess: sttHandleSuccess(res, logId, t0),
    failLabel: 'stt',
  });
}

function supportsReasoningContent(provider, model) {
  if (REASONING_PROVIDERS.has(provider)) {
    return true;
  }
  return false;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (msg && typeof msg === 'object' && msg.role === 'assistant') {
      const clean = { ...msg };
      if (!clean.content && clean.reasoning_content) clean.content = clean.reasoning_content;
      delete clean.reasoning_content;
      delete clean.reasoning;
      return clean;
    }
    return msg;
  });
}

function _hasNonTextContent(msgs) { return lib._hasNonTextContent(msgs); }

// drop invalid image parts (empty/non-http/non-data image_url) before routing — they would 400 upstream or misfire vision auto-route
function _dropInvalidImageParts(msgs) { return lib._dropInvalidImageParts(msgs); }
async function _fetchAndConvertImages(msgs) { return lib._fetchAndConvertImages(msgs); }
const _NVIDIA_ASSISTANT_CONTENT = '.\n';

// Cloudflare Workers AI: /ai/v1/{chat,embeddings} are OpenAI-compatible, but images/tts/stt only exist as /ai/run/{model} with non-OpenAI request/response shapes
const _isCFBase = (base) => /api\.cloudflare\.com/i.test(base);
const _cfRunPath = (model) => 'run/' + String(model).replace(/[^a-zA-Z0-9@._\-/]/g, (c) => encodeURIComponent(c));

function _opencodeExtraHeaders(req, provider) {
  const isOpencode = provider === 'opencode' || provider === 'opencode-go';
  if (!isOpencode) return undefined;
  const h = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (k.toLowerCase().startsWith('x-opencode-')) h[k] = v;
  }
  // note: Zen free tier enforces the full request contract (versioned UA + ses_shape session + stream + accepted tools) — imitate the official CLI; client-sent values always win
  if (!h['x-opencode-client'] && !h['X-Opencode-Client']) h['x-opencode-client'] = 'tui';
  const s0 = h['x-opencode-session'] || h['X-Opencode-Session'];
  if (!s0 || !lib.isCanonOpencodeSession(s0)) {
    // note: hash only auth tail + UA to avoid holding full token in a temp string; foreign sessions are translated deterministically
    const auth = req.headers['authorization'] || '';
    const ua = req.headers['user-agent'] || '';
    delete h['x-opencode-session']; delete h['X-Opencode-Session'];
    h['x-opencode-session'] = lib.canonOpencodeSession(s0 || `${auth.slice(-12)}|${ua}|${provider}`);
  }
  if (!h['x-opencode-request'] && !h['X-Opencode-Request']) h['x-opencode-request'] = `req-${rid()}`;
  h['User-Agent'] = OPENCODE_UA;
  return h;
}
// note: free-tier floor moves fast (1.17 → 1.18 in a day) — override via OPENCODE_UA env on 426 UpgradeRequired
const OPENCODE_UA = process.env.OPENCODE_UA || 'opencode/latest/1.18.31';
function _chatToResponses(bodyObj) { return lib.chatToResponses(bodyObj); }

function forwardToDirect(apiKey, bodyStr, baseUrl, endpointPath, accept, contentType, extraHeaders, signal, method) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const joined = baseUrl.replace(/\/+$/, '') + '/' + endpointPath.replace(/^\/+/, '');
    const url = new URL(joined);
    const isHttps = url.protocol === 'https:';
    const isOpencode = baseUrl.includes('opencode.ai');
    let isAnthropic = false;
try { isAnthropic = new URL(baseUrl).hostname === 'api.anthropic.com'; } catch {}
    const headers = {
      'Content-Type': contentType || 'application/json',
      'Accept': accept || 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      ...(extraHeaders || {}),
    };
    if (isAnthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      delete headers['Authorization'];
    }
    if (isOpencode && !headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = 'api-gateway';
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method || 'POST',
      headers,
      timeout: (typeof UPSTREAM_TIMEOUT_MS!=='undefined'?UPSTREAM_TIMEOUT_MS:120000),
    };
    const mod = isHttps ? https : http;
// Settle once and always detach the abort listener (it used to leak per retry).
    let settled = false, onAbort = null;
    const detach = () => { if (signal && onAbort) { signal.removeEventListener('abort', onAbort); onAbort = null; } };
    const settle = (fn, arg) => { if (settled) return; settled = true; detach(); fn(arg); };
    const req = mod.request({ ...opts, agent: isHttps ? _httpsAgent : _httpAgent }, (r) => {
      if (settled) { try { r.destroy(); } catch {} return; }
      // headers are in: the abort duty moves from the request to the response
      // stream (client disconnect must still tear down a streaming body)
      detach();
      if (signal) {
        onAbort = () => { try { r.destroy(); } catch {} };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      r.on('close', () => detach());
      resolve(r);
    });
    req.on('error', (e) => settle(reject, e.name === 'AbortError' ? new Error('aborted') : e));
    req.on('timeout', () => { try { req.destroy(); } catch {} settle(reject, new Error('upstream timeout')); });
    if (signal) {
      onAbort = () => { try { req.destroy(); } catch {} settle(reject, new Error('aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (bodyStr != null && bodyStr !== '') req.write(bodyStr);
    req.end();
  });
}

// --- x-ratelimit-* response headers ---
//
// Relay upstream x-ratelimit-* verbatim when present; else advertise gateway
// limits only if configured (never invent numbers). Gateway capacity, not quota.
const _RATELIMIT_PREFIX = 'x-ratelimit-';
const _rpmWindow = new Map(); // provider → timestamps (ms) in the trailing 60s
const RPM_WINDOW_MS = 60000;
function _rpmUsed(provider) {
  const now = Date.now(), cutoff = now - RPM_WINDOW_MS;
  let arr = _rpmWindow.get(provider);
  if (!arr) { arr = []; _rpmWindow.set(provider, arr); }
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr;
}
function _noteRpmRequest(provider) { _rpmUsed(provider).push(Date.now()); }
function _resetDurations(ms) {
  if (ms == null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 1000 ? `${s}s` : `${s * 1000}ms`;
}
function _providerRpm(provider) {
  const interval = RATE_LIMITS.get(provider);
  if (!interval || interval <= 0) return null;
  return Math.max(1, Math.round(60000 / interval));
}
function _setRateLimitHeaders(res, provider, upstreamRes) {
  if (res.headersSent) return;
  // 1. relay what the upstream told us
  if (upstreamRes?.headers) {
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      const lk = String(k).toLowerCase();
      if (lk.startsWith(_RATELIMIT_PREFIX) || lk === 'retry-after') {
        try { res.setHeader(lk, v); } catch {}
      }
    }
  }
  // 2. otherwise describe the gateway's own admission control
  const rpm = _providerRpm(provider);
  if (rpm != null) {
    const arr = _rpmUsed(provider);
    const remaining = Math.max(0, rpm - arr.length);
    if (!res.getHeader('x-ratelimit-limit-requests')) res.setHeader('x-ratelimit-limit-requests', String(rpm));
    if (!res.getHeader('x-ratelimit-remaining-requests')) res.setHeader('x-ratelimit-remaining-requests', String(remaining));
    if (!res.getHeader('x-ratelimit-reset-requests')) {
      const interval = RATE_LIMITS.get(provider) || 0;
      const next = arr.length ? Math.max(0, arr[0] + interval - Date.now()) : interval;
      res.setHeader('x-ratelimit-reset-requests', _resetDurations(next) || '0ms');
    }
  }
  const tpm = TPM_LIMITS.get(provider);
  if (tpm != null && !res.getHeader('x-ratelimit-limit-tokens')) {
    const byProv = _tpmLog.get(provider);
    let used = 0, oldest = 0;
    if (byProv) {
      const cutoff = Date.now() - 60000;
      for (const entries of byProv.values()) {
        for (const e of entries) { if (e.ts >= cutoff) { used += e.tokens; if (!oldest || e.ts < oldest) oldest = e.ts; } }
      }
    }
    res.setHeader('x-ratelimit-limit-tokens', String(tpm));
    res.setHeader('x-ratelimit-remaining-tokens', String(Math.max(0, tpm - used)));
    res.setHeader('x-ratelimit-reset-tokens', _resetDurations(oldest ? oldest + 60000 - Date.now() : 0) || '0ms');
  }
}
// A 429 is the single most useful place to emit these: the client needs to know
// how long to back off, and that is exactly what it is asking us.
function _applyRateLimitSignal(res, provider, upstreamRes, retryAfterMs) {
  try {
    if (!res.headersSent) {
      const rpm = _providerRpm(provider);
      if (rpm != null) res.setHeader('x-ratelimit-limit-requests', String(rpm));
      res.setHeader('x-ratelimit-remaining-requests', '0');
      if (retryAfterMs != null) {
        res.setHeader('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        if (!res.getHeader('x-ratelimit-reset-requests')) res.setHeader('x-ratelimit-reset-requests', _resetDurations(retryAfterMs) || '0ms');
      }
    }
  } catch {}
}
// A mid-flight 429 attempt stamped these on res; writeHead merges (never
// replaces) setHeader values, so a later successful attempt would answer 200
// with a stale retry-after and a zeroed rate-limit budget.
function _clearUpstream429Signal(res) {
  for (const h of ['retry-after', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
    try { res.removeHeader(h); } catch {}
  }
}

// --- OpenAI-compatible error envelope ---
//
// OpenAI error shape with a closed `type` set; ad-hoc types broke client branching.
const ERR_TYPE_BY_STATUS = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
  404: 'not_found_error', 408: 'invalid_request_error', 409: 'invalid_request_error',
  413: 'invalid_request_error', 422: 'invalid_request_error', 429: 'rate_limit_error',
  499: 'invalid_request_error',
};
function _errType(status) { return ERR_TYPE_BY_STATUS[status] || (status >= 500 ? 'api_error' : 'invalid_request_error'); }
function _errorBody(message, { status = 400, type, param, code } = {}) {
  const e = { message: String(message ?? 'error'), type: type || _errType(status) };
  if (param) e.param = param;
  if (code) e.code = code;
  return { error: e };
}
// writeHead() takes a plain object, so expose the rate-limit set the same way
function _rlHeaders(provider, upstreamRes) {
  const o = {};
  _setRateLimitHeaders({ headersSent: false, setHeader: (k, v) => { o[k] = v; }, getHeader: (k) => o[k] }, provider, upstreamRes);
  return o;
}
function sendError(res, status, message, opts = {}) {
  if (res.headersSent || res.writableEnded) return;
  const headers = { 'Content-Type': 'application/json' };
// Never set a header to undefined: Node destroys the socket (connection reset).
  if (opts.logId) headers['X-Request-Id'] = opts.logId;
  res.writeHead(status, headers);
  res.end(JSON.stringify(_errorBody(message, { ...opts, status })));
}
// In-stream failures must stay inside the SSE contract: a JSON body mid-stream
// breaks clients that already committed to text/event-stream.
function sendSSEError(res, message, opts = {}) {
  try { res.write(`data: ${JSON.stringify(_errorBody(message, opts))}\n\n`); } catch {}
  try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
}

// --- payload validation ---
function validateChatBody(body) { return lib.validateChatBody(body); }

async function handleChatCompletion(req, res, bodyJson, logId) {
  const t0 = Date.now();
  log('─');
  const validationErr = validateChatBody(bodyJson);
  if (validationErr) {
    log(`[${logId}] ❌ 400  ${validationErr}`);
    sendError(res, 400, validationErr, { type: 'invalid_request_error' });
    return;
  }

  const clientModel = bodyJson.model || 'unknown';
  const dropped = _dropInvalidImageParts(bodyJson.messages);
  if (dropped) log(`[${logId}] ➡️ dropped ${dropped} invalid image part(s)`);
    const converted = await _fetchAndConvertImages(bodyJson.messages);
  if (converted) log(`[${logId}] ➡️ fetched & converted ${converted} remote image(s) to base64`);
  let targets = resolveModelForEndpoint(clientModel, '/v1/chat/completions');
  if (!targets) {
    log(`[${logId}] ❌ 400  unsupported model: ${clientModel}`);
    // OpenAI returns 404/model_not_found for an unknown model, and clients branch
    // on that code to offer a model list rather than showing a generic error.
    sendError(res, 404, `The model \`${clientModel}\` does not exist`, { param: 'model', code: 'model_not_found', logId });
    return;
  }
  // note: vision-switched requests never leave the vision family (overflow used to drop images onto text aliases)
  let visionRouted = false;
  if (_hasNonTextContent(bodyJson.messages) && targets && String(clientModel || '').toLowerCase() !== 'vision') {
    const vt = resolveModel('vision');
    if (vt) { log(`[${logId}] ➡️ ${clientModel} → vision  (non-text content detected)`); targets = vt; visionRouted = true; }
  }

  const est = estimateTokens(bodyJson.messages);
  const maxOut = bodyJson.max_tokens || 4096;
  const totalEst = est + maxOut;
  const routeKey = (visionRouted ? 'vision' : clientModel).toLowerCase();
  const fam = SMART_ROUTE.get(routeKey);
  if (fam && fam.tiers.length > 0) {
    const tier = lib.pickTier(fam.tiers, totalEst);
    if (tier && tier.alias.toLowerCase() !== routeKey) {
      const nt = resolveModel(tier.alias);
      if (nt) {
        log(`[${logId}] ➡️ ${clientModel} → ${tier.alias}  (prompt=${est}, max_out=${maxOut}, total=${totalEst}, tier≤${tier.max_tokens})`);
        targets = nt;
      }
    }
  } else if (!visionRouted && TOKEN_ORDER.length > 0) {
    const clientLimit = getAliasLimit(clientModel);
    if (totalEst > clientLimit) {
      for (const alias of TOKEN_ORDER) {
        // note: never overflow onto audio/image aliases — explicit request for them still works, wandering does not
        if (alias.toLowerCase() !== clientModel.toLowerCase() && NON_CHAT_ALIASES.has(alias.toLowerCase())) continue;
        const newTargets = resolveModel(alias);
        if (!newTargets) continue;
        const limit = getAliasLimit(alias);
        if (limit > 0 && totalEst > limit) continue;
        if (alias !== clientModel) {
          log(`[${logId}] ➡️ ${clientModel} → ${alias}  (prompt=${est}, max_out=${maxOut}, total=${totalEst}, ctx=${limit})`);
          targets = newTargets;
        }
        break;
      }
    }
  }

  let activeTargets = targets.filter(t => {
    if (!PROVIDERS_WITH_KEYS.has(t.provider)) return false;
    if (!DIRECT_PROVIDERS[t.provider]) return false;
    return true;
  });
  if (activeTargets.length === 0) {
    log(`[${logId}] ❌ 400  no keys for ${clientModel || '(no model)'}`);
    sendError(res, 400, 'no keys available for this model', { code: 'no_available_providers' });
    return;
  }

  const isStream = bodyJson.stream === true; // note: OpenAI-standard default — omitted stream means JSON, not SSE
// Most upstreams ignore include_usage; synthesise the usage chunk when absent.
  const wantStreamUsage = isStream && bodyJson.stream_options?.include_usage === true;
  const pkCount = Object.entries(PROVIDER_KEYS).reduce((s, [, ks]) => s + ks.length, 0);
  log(`[${logId}] ⚡ ${clientModel}  msgs=${bodyJson.messages.length}  stream=${isStream}  keys=${pkCount}`);

  const rotated = rotateTargets(activeTargets, clientModel);
  if (rotated.length) {
    const shown = rotated.length > 1
      ? `[${rotated[0].provider}/${rotated[0].upstreamModel}] > [${rotated[1].provider}/${rotated[1].upstreamModel}]`
      : `[${rotated[0].provider}/${rotated[0].upstreamModel}]`;
    log(`[${logId}] ➡️ fallback chain: ${shown}`);
  }
  // note: cross-alias fallback — expanded lazily only when no primary target is viable
  const visitedAliases = new Set([(clientModel || '').toLowerCase()]);
  const pendingFallbacks = [];
  let justExpanded = false;
  let responsesMaxOverride = 0;
  let responsesMaxTarget = '';
  const queueFallbacks = (list) => {
    for (const t of list || []) {
      const fbs = Array.isArray(t.fallback) ? t.fallback : (t.fallback ? [t.fallback] : []);
      for (const fb of fbs) {
        if (typeof fb !== 'string' || !fb) continue;
        const k = fb.toLowerCase();
        if (!visitedAliases.has(k)) { visitedAliases.add(k); pendingFallbacks.push(fb); }
      }
    }
  };
  queueFallbacks(rotated);

  const bodyTemplate = { ...bodyJson, stream: isStream };
  delete bodyTemplate.model;

  let lastErr = null, upstreamRes = null, usedProvider = null, usedKey = null;
  const hasNonText = _hasNonTextContent(bodyJson.messages); // image/audio parts present → filter non-vision targets
  const skippedProviders = new Set(); // providers that returned non-429 non-200 this request → skip channel
  let usedModel = null;
  let curProvider = null, curUpstream = null, curKey = null; // active upstream for leak-safe cleanup on client disconnect
  let clientGone = false;
  let retryRound = 0;
  let transientSkipped = false;
  let sseStarted = false;
  let sseRetryTargets = [];
  // Deferred success accounting for the stream currently being piped. Set when
  // upstream headers arrive, committed exactly once by the stream watcher.
  let streamState = null, streamSettled = false;
  const commitSuccess = (p, m, k, tStart, tokens) => {
    markKeySuccess(p, k, Date.now() - tStart);
    _recordProviderSuccess(p, tStart);
    _recordModelSuccess(p, m, tStart);
    _adjustRpm(p, true);
    logEvent({ logId, provider: p, model: m, key: k, latency: (Date.now() - tStart) / 1000, tokens: tokens || 0 });
  };
  const commitStreamFailure = (p, m, k, tStart, reason) => {
    if (streamSettled || clientGone) return;   // client-cancelled is not an upstream failure
    streamSettled = true;
    if (k) markKeyError(p, k);
    // provider failure is stamped at report time (the error event just fired),
    // so no startedAt is passed; only model lockout needs the ordering guard.
    _recordProviderFailure(p);
    _recordModelFailure(p, m, tStart);
    logEvent({ logId, provider: p, model: m, key: k || '-', status: 502, body: reason || 'upstream stream ended before completion' });
  };
  const commitStreamSuccess = () => {
    if (streamSettled || !streamState) return;
    streamSettled = true;
    const s = streamState;
    commitSuccess(s.provider, s.model, s.key, s.t0, totalEst || 0);
  };
  const ac = new AbortController();
  const sig = ac.signal;
  res.on('close', () => { if (!res.writableEnded) { clientGone = true; if (!sig.aborted) ac.abort(); } });

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': logId,
// No x-ratelimit-* here: routing hasn't picked a provider yet.
    });
    sseStarted = true;
  }

  while (!upstreamRes && !clientGone && Date.now() - t0 < TIMEOUT_MS && (retryRound < RETRY_MAX_ROUNDS || transientSkipped)) {
    if (retryRound > 0) {
      // all targets transiently skipped (concurrency/rate/TPM) and nothing reached an upstream: poll for a free slot before the next round
      const wait = (transientSkipped && !lastErr) ? RETRY_TRANSIENT_WAIT : Math.min(retryRound * RETRY_BASE_DELAY, RETRY_MAX_DELAY);
      log(`[${logId}] 🔄 retry ${retryRound} — wait ${wait}ms${transientSkipped && !lastErr ? ' (all targets transiently skipped, keeping client connection)' : ' for key recovery'}`);
      await sleep(wait);
    }
    retryRound++;
    transientSkipped = false;
    justExpanded = false;
    for (let ti = 0; ti < rotated.length; ti++) {
      const target = rotated[ti];
      if (skippedProviders.has(target.provider)) continue;
      if (_isModelLocked(target.provider, target.upstreamModel)) { log(`[${logId}] ➡️ [${target.provider}/${target.upstreamModel}] skip (model lockout)`); continue; }
      if (upstreamRes) break;
      try {
        const provider = target.provider;
        const upstreamModel = target.upstreamModel;
        const maxAttempts = Math.max(1, (PROVIDER_KEYS[provider] || []).length);

        if (lastErr) await sleep(Math.random() * 300);

                const targetLimitKey = `${provider}/${upstreamModel}`.toLowerCase();
        const targetCtx = USER_MODEL_LIMITS.get(targetLimitKey) || PROVIDER_DEFAULT_LIMITS[provider] || 999999;
        if (totalEst > targetCtx) {
          log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (${totalEst} > ${targetCtx})`);
          continue;
        }
        if (isRateLimited(provider)) {
          log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (rate limited)`);
          transientSkipped = true;
          continue;
        }
        if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) {
          log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (concurrency ${_providerActive.get(provider)})`);
          transientSkipped = true;
          continue;
        }
        if (_isCircuitOpen(provider)) {
          log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (circuit breaker)`);
          transientSkipped = true;
          continue;
        }

        if (hasNonText && NO_NON_TEXT_TARGETS.has(`${provider}/${upstreamModel}`.toLowerCase())) {
          log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (no vision support)`);
          continue;
        }

        const bodyObj = { ...bodyTemplate, model: upstreamModel };
                const maxCap = PROVIDER_MAX_TOKENS[provider];
                if (maxCap && (bodyObj.max_tokens || 4096) > maxCap) bodyObj.max_tokens = maxCap;
                const banned = PROVIDER_BANNED_FIELDS[provider];
                if (banned) for (const f of banned) delete bodyObj[f];
                _adjustReasoningFields(bodyObj, provider); // strip/rewrite unsupported reasoning params for this upstream
                if (Array.isArray(bodyObj.tools)) bodyObj.tools = bodyObj.tools.map(t => { const c = { ...t }; delete c.strict; if (c.function) { c.function = { ...c.function }; delete c.function.strict; } return c; });
         if (Array.isArray(bodyObj.messages)) {
            if (!supportsReasoningContent(provider, upstreamModel)) {
              bodyObj.messages = sanitizeMessages(bodyObj.messages);
            }
            if (STRICT_ORDER_PROVIDERS.has(provider)) {
              try {
                bodyObj.messages = normalizeMessageOrder(bodyObj.messages);
              } catch (e) {
                if (e.message.startsWith('400 ')) {
                  if ((_providerActive.get(provider) || 0) > 0) decActive(provider);
                  log(`[${logId}] ❌ 400 [${provider}/${upstreamModel}] ${e.message.substring(4)}`);
                  sendError(res, 400, e.message.substring(4), { type: 'invalid_request_error' });
                  return;
                }
                throw e;
              }
            }
          }
        const bodyStr = JSON.stringify(bodyObj);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (upstreamRes) break;
          if (attempt > 0) await sleep(Math.random() * 300);
          usedKey = await selectKey(provider, sig);
          if (!usedKey) { if (clientGone) break; log(`[${logId}] ➡️ [${provider}/${upstreamModel}] no key available`); logEvent({ logId, provider, model: upstreamModel, key: '-', status: 503, body: 'no healthy key' }); if (getHealthyKeys(provider).length > 0) transientSkipped = true; break; }   // busy ≠ broken: poll instead of instant 502

          let slotHeld = false;   // waitTpmLimit can throw BEFORE addActive
          try {
            await waitTpmLimit(provider, usedKey, totalEst, sig);
            if (clientGone) { releaseKey(provider, usedKey); usedKey = null; break; }
            if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) {
              log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (concurrency ${_providerActive.get(provider)})`);
              releaseKey(provider, usedKey); transientSkipped = true; break;
            }
            addActive(provider); slotHeld = true;
            let targetPath = target.endpoint || (DIRECT_PATH_PREFIX[provider] || '/v1') + '/chat/completions';
            let targetBodyStr = bodyStr;
            // note: /v1/responses is always streamed upstream (free-tier contract) then converted back to chat JSON / replayed SSE
            let acceptHdr = isStream ? 'text/event-stream' : 'application/json';
            if (target.endpoint === '/v1/responses') {
              const rBody = _chatToResponses(bodyObj);
              rBody.model = upstreamModel;
              rBody.stream = true;
              if ((provider === 'opencode' || provider === 'opencode-go') && /free/i.test(upstreamModel) && !rBody.tools) {
                rBody.tools = lib.PLACEHOLDER_TOOLS;
                rBody.tool_choice = 'auto';
                log(`[${logId}] ➡️ [${provider}/${upstreamModel}] free-tier gate: injected ${lib.PLACEHOLDER_TOOLS.length} placeholder tools`);
              }
              if (responsesMaxOverride > 0 && responsesMaxTarget === `${provider}/${upstreamModel}`) rBody.max_output_tokens = responsesMaxOverride;
              targetBodyStr = JSON.stringify(rBody);
              acceptHdr = 'text/event-stream';
            } else if (target.endpoint === '/v1/messages') {
              const mBody = lib.chatToAnthropic({ ...bodyObj, model: upstreamModel });
              targetBodyStr = JSON.stringify(mBody);
            }
            upstreamRes = await forwardToDirect(usedKey, targetBodyStr, DIRECT_PROVIDERS[provider], targetPath, acceptHdr, 'application/json', _opencodeExtraHeaders(req, provider), sig);
            usedProvider = provider;
            usedModel = upstreamModel;
            curProvider = provider; curUpstream = upstreamRes; curKey = usedKey;
            const sc = upstreamRes.statusCode;

            if (sc === 429) {
              decActive(provider); slotHeld = false;
              const body = await collectBody(upstreamRes);
              // Mark BEFORE releasing: a slow error body must not leave the key
              // selectable while we know it just failed.
              releaseKey(provider, usedKey);
              const retryAfter = await _handleUpstream429(provider, usedKey, upstreamRes, body, logId, res);
              const isQuota = _isQuotaError(sc, body);
              if (retryAfter) log(`[${logId}] ⏳ Retry-After ${Math.ceil(retryAfter/1000)}s [${provider}]${isQuota ? ' quota' : ''}`);
              log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} attempt=${attempt+1}/${maxAttempts}${isQuota ? ' quota' : ''}`);
              logEvent({ logId, provider, model: upstreamModel, key: usedKey, status: sc, body });
              lastErr = { status: sc, body };
              upstreamRes = null;
              if (retryAfter) await sleep(Math.min(retryAfter, 5000));
              continue;
            }

            if (target.endpoint === '/v1/responses' && sc >= 200 && sc < 300) {
              decActive(provider); slotHeld = false;
              releaseKey(provider, usedKey);
              const raw = await collectBody(upstreamRes);
              if (raw === null) {
                _recordModelFailure(provider, upstreamModel);
                lastErr = { status: 502, body: 'upstream body collection aborted' };
                upstreamRes = null;
                continue;
              }
              const ctype = String(upstreamRes.headers?.['content-type'] || '');
              let rj = null;
              try {
                rj = ctype.includes('text/event-stream') ? lib.assembleResponsesSSE(raw) : JSON.parse(raw);
              } catch (e) {
                _recordModelFailure(provider, upstreamModel);
                lastErr = { status: 502, body: raw };
                upstreamRes = null;
                continue;
              }
              const conv = lib.responsesOutputToChat(rj, clientModel);
              if (rj.status === 'failed') {
                _recordModelFailure(provider, upstreamModel);
                lastErr = { status: 502, body: _safeSlice(raw, 2000) };
                upstreamRes = null;
                continue;
              }
              if (!conv.text && conv.toolCalls.length === 0 && rj.status === 'incomplete' && !responsesMaxOverride) {
                // note: starved by reasoning budget — retry once with doubled budget instead of answering empty
                const curMax = lib.chatToResponses(bodyObj).max_output_tokens || 1024;
                responsesMaxOverride = Math.min(curMax * 2, 16384);
                responsesMaxTarget = `${provider}/${upstreamModel}`;
                log(`[${logId}] ➡️ empty incomplete output — bump max_output_tokens to ${responsesMaxOverride} and retry (keeping client connection)`);
                justExpanded = true;
                retryRound = -1;
                upstreamRes = null;
                continue;
              }
              markKeySuccess(provider, usedKey, Date.now()-t0);
              _recordProviderSuccess(provider, t0);
              _recordModelSuccess(provider, upstreamModel, t0);
              _adjustRpm(provider, true);
              logEvent({ logId, provider, model: upstreamModel, key: usedKey, latency: (Date.now()-t0)/1000, tokens: conv.usage.total_tokens || totalEst || 0 });
              log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] via responses → chat (${conv.text.length} chars${conv.toolCalls.length ? ` +${conv.toolCalls.length} tools` : ''})`);
              const message = { role: 'assistant', content: conv.text };
              if (conv.toolCalls.length > 0) message.tool_calls = conv.toolCalls;
              if (isStream) {
                // note: upstream was streamed; replay the converted result as a single SSE chunk so OpenAI clients stay compatible
                const cid = rj.id || `chatcmpl-${Date.now()}`;
                const ts = Math.floor(Date.now() / 1000);
                try {
                  const delta = { role: 'assistant' };
                  if (conv.text) delta.content = conv.text;
                  if (conv.toolCalls.length > 0) delta.tool_calls = conv.toolCalls.map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }));
                  res.write(`data: ${JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: ts, model: clientModel, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
                  res.write(`data: ${JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: ts, model: clientModel, choices: [{ index: 0, delta: {}, finish_reason: conv.finish }] })}\n\n`);
                  // include_usage contract holds on converted paths too
                  if (wantStreamUsage && conv.usage && conv.usage.total_tokens != null) res.write(`data: ${JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: ts, model: clientModel, choices: [], usage: conv.usage })}\n\n`);
                  res.write('data: [DONE]\n\n');
                  try { res.end(); } catch {}
                } catch {}
                upstreamRes = { statusCode: 200, headers: {} };
                usedProvider = provider; usedModel = upstreamModel;
                return;
              }
              const chatResp = { id: rj.id || `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: clientModel, choices: [{ index: 0, message, finish_reason: conv.finish }], usage: conv.usage };
              _clearUpstream429Signal(res);
              res.writeHead(200, { 'Content-Type': 'application/json', 'X-Provider': provider });
              res.end(JSON.stringify(chatResp));
              upstreamRes = { statusCode: 200, headers: {} };
              usedProvider = provider; usedModel = upstreamModel;
              return;
            }

            if (sc < 200 || sc >= 300) {
              decActive(provider); slotHeld = false;
              const body = await collectBody(upstreamRes);
              releaseKey(provider, usedKey);   // release AFTER marking (same ordering as the 429 branch)
// Non-credential 4xx is a request/config error: never degrade key or circuit.
// 3xx lands here too — a redirect must never be streamed to the client as a
// successful chat completion.
              const credProblem = (sc === 401 || sc === 403);
              if (credProblem || sc === 429 || sc >= 500) _markKeyFailed(provider, usedKey, sc, body);
              log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} ${_errMsg(body)}`);   // stdout honours the disk redaction policy
              logEvent({ logId, provider, model: upstreamModel, key: usedKey, status: sc, body });
              if (typeof body === 'string' && /or newer is required/.test(body)) log(`[${logId}] ⚠️ Zen demands a newer client — bump OPENCODE_UA (${_safeSlice(body, 120)})`);
              if (_isFreeTierError(body)) {
                // note: model-level only — skip channel for fallback, lock model, no provider circuit
                _recordModelFailure(provider, upstreamModel);
                skippedProviders.add(provider);
                lastErr = { status: sc, body };
                upstreamRes = null;
                break;
              }
              if (sc >= 500) _recordProviderFailure(provider);
              // lock the MODEL for a permanently unavailable model, but only
              // penalise the channel for failures that indicate channel health
              if (credProblem || sc === 429 || sc >= 500) _recordModelFailure(provider, upstreamModel);
              lastErr = { status: sc, body };
              if (sc !== 429) skippedProviders.add(provider);
              if (sc === 401) markKey401(provider, usedKey, upstreamModel);
              upstreamRes = null;
              break;
            }

            // Headers prove acceptance, not success: the stream path releases the key
            // now but defers success to the watcher; the non-stream path holds key
            // and success accounting until collectBody returns the full body below.
            if (isStream) {
              releaseKey(provider, usedKey);
              streamState = { provider, model: upstreamModel, key: usedKey, t0 };
            }
            log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} (${((Date.now()-t0)/1000).toFixed(1)}s${isStream ? ', stream open' : ''})`);
            if (isStream) sseRetryTargets = rotated.slice(ti + 1);
            break;

          } catch (e) {
            if (slotHeld) decActive(provider);   // else we'd steal another request's slot
            releaseKey(provider, usedKey);
// Aborted wait (client gone) is not an upstream failure: no health penalty.
            if (clientGone || (e.message || '').startsWith('aborted')) { upstreamRes = null; break; }
            markKeyError(provider, usedKey);
            _recordProviderFailure(provider);
            _recordModelFailure(provider, upstreamModel);
            log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] key=${logKey(usedKey)} attempt=${attempt+1}/${maxAttempts} ${e.message}`);
            logEvent({ logId, provider, model: upstreamModel, key: usedKey, status: 502, body: e.message });
            lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
            upstreamRes = null;
          }
        }
      } catch (e) { if (target?.provider) { _recordProviderFailure(target.provider); if (target?.upstreamModel) _recordModelFailure(target.provider, target.upstreamModel); } log(`[${logId}] ❌ 502 [${target?.provider}/${target?.upstreamModel}] fatal ${e.message}`); logEvent({ logId, provider: target?.provider || '?', model: target?.upstreamModel || '?', key: '-', status: 502, body: e.message }); }
    }
    if (!upstreamRes && !clientGone && pendingFallbacks.length > 0) {
      // note: expand the next fallback alias only when nothing primary is viable — transient skips keep polling primaries
      const viable = rotated.some(t => !skippedProviders.has(t.provider) && !_isModelLocked(t.provider, t.upstreamModel));
      if (!viable) {
        const fbName = pendingFallbacks.shift();
        let fbTargets = null;
        try { fbTargets = resolveModelForEndpoint(fbName, '/v1/chat/completions') || resolveModel(fbName); } catch {}
        fbTargets = (fbTargets || []).filter(t => PROVIDERS_WITH_KEYS.has(t.provider) && DIRECT_PROVIDERS[t.provider]);
        if (fbTargets.length > 0) {
          log(`[${logId}] ➡️ fallback ${clientModel} → ${fbName} (${fbTargets.length} targets, keeping client connection)`);
          for (const t of fbTargets) rotated.push(t);
          queueFallbacks(fbTargets);
          justExpanded = true;
          retryRound = -1; // note: attempt fallback immediately (fresh keys), then normal pacing; still bounded by TIMEOUT_MS
        } else {
          log(`[${logId}] ➡️ fallback ${fbName} resolved no targets, skipped`);
        }
      }
    }
    // The old `!lastErr` guard never fired for real failures (they always set
    // lastErr), so rounds 2/3 slept 5s+10s with every target already skipped.
    const anyRetryable = rotated.some(t => !skippedProviders.has(t.provider) && !_isModelLocked(t.provider, t.upstreamModel));
    if (!upstreamRes && !transientSkipped && !justExpanded && (!lastErr || !anyRetryable)) { log(`[${logId}] ➡️ all targets skipped (permanent) — no retry`); break; }
  }

  if (!upstreamRes || !usedProvider) {
    const errMsg = lastErr ? (typeof lastErr.body === 'string' ? lastErr.body : JSON.stringify(lastErr.body)) : 'no upstream';
    const errCode = lastErr?.status || 502;
    log(`[${logId}] ${_statusIcon(errCode)} ${errCode} all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
    logEvent({ logId, provider: usedProvider || '-', model: usedModel || clientModel, key: usedKey || '-', status: errCode, body: lastErr?.body || errMsg });
    const clientMsg = _safeSlice(errMsg, 300);
    // HTTP stays 502 — the gateway's own verdict (an upstream 400/404 must not
    // masquerade as our client error). The envelope keeps the upstream `code`;
    // the SSE path additionally relays the upstream class via `status` (type),
    // since mid-stream frames carry no HTTP status of their own.
    const upstreamCode = (() => { try { return JSON.parse(errMsg)?.error?.code || undefined; } catch { return undefined; } })();
    const errOpts = { code: upstreamCode || 'upstream_unavailable', logId, status: errCode };
    if (sseStarted) {
      sendSSEError(res, `all failed: ${clientMsg}`, errOpts);
    } else {
      sendError(res, 502, `all failed: ${clientMsg}`, errOpts);
    }
    return;
  }

  if (sseStarted) {
    let sseUpstream = upstreamRes;
    let sseProvider = usedProvider;
    let sseModel = usedModel;
    let committed = false; // any token already forwarded to client → cannot switch upstream transparently
    let prevOnClose = null;
    // declared OUTSIDE the retry loop so terminal-marker state is not silently
    // reset when a retry switches to another upstream
    let sawTerminal = false, tailBuf = '';
    let sawDoneFrame = false;
    let sseRetries = 0, lastSseErr = null;
    // Per-request sanitized-message cache for SSE retries. Request-scoped by
    // construction — the old module-level provider/model map let a later
    // request's retry reuse a different conversation's messages.
    const sseSanCache = new Map();
    // Pick the next usable retry target and connect. Returns true when a 2xx
    // stream is ready to pipe, false when no target remains. Three invariants:
    // (1) never re-attach handlers to a dead stream — its 'end' fires only once
    // and the request would hang until the server timeout; (2) a failed target
    // attempt (non-2xx / connect error) must fall through to the NEXT target,
    // not end the loop; (3) sseProvider/sseModel/curKey keep pointing at the
    // last PIPED stream until a new one connects, so the give-up path charges
    // exactly one stream and never re-charges an already-penalized target.
    const sseSelectAndConnect = async () => {
      while (sseRetryTargets.length > 0) {
        const t = sseRetryTargets.shift();
        // Custom endpoints need the main loop's path/body conversion — a chat
        // body POSTed there would 404/400 and lock a healthy model.
        if (t.endpoint) continue;
        if (skippedProviders.has(t.provider)) continue;
        if (_isModelLocked(t.provider, t.upstreamModel)) continue;
        if (_isCircuitOpen(t.provider)) continue;
        if (isRateLimited(t.provider)) continue;
        if ((_providerActive.get(t.provider) || 0) >= PROVIDER_MAX_CONCURRENT) continue;
        const nk = await selectKey(t.provider, sig);
        if (!nk) { log(`[${logId}] ➡️ sse retry [${t.provider}/${t.upstreamModel}] no key`); continue; }
        const tp = t.provider, tm = t.upstreamModel;
        const bodyObj2 = { ...bodyTemplate, model: tm };
        const banned2 = PROVIDER_BANNED_FIELDS[tp];
        if (banned2) for (const f of banned2) delete bodyObj2[f];
        _adjustReasoningFields(bodyObj2, tp); // strip/rewrite unsupported reasoning params for this upstream
        if (Array.isArray(bodyObj2.tools)) bodyObj2.tools = bodyObj2.tools.map(tc => { const c = { ...tc }; delete c.strict; if (c.function) { c.function = { ...c.function }; delete c.function.strict; } return c; });
        const sseSanKey = `${tp}/${tm}`;
        if (!sseSanCache.has(sseSanKey)) {
          sseSanCache.set(sseSanKey, !supportsReasoningContent(tp, tm) ? sanitizeMessages(JSON.parse(JSON.stringify(bodyObj2.messages))) : bodyObj2.messages);
        }
        bodyObj2.messages = JSON.parse(JSON.stringify(sseSanCache.get(sseSanKey)));
        if (STRICT_ORDER_PROVIDERS.has(tp) && Array.isArray(bodyObj2.messages)) {
          // a normalize throw must not escape the helper — it would hang the
          // request after 200/SSE headers were already sent
          try { bodyObj2.messages = normalizeMessageOrder(bodyObj2.messages); }
          catch (e3) { log(`[${logId}] ➡️ sse retry [${tp}/${tm}] skip (bad messages: ${e3.message})`); releaseKey(tp, nk); continue; }
        }
        const maxCap2 = PROVIDER_MAX_TOKENS[tp];
        if (maxCap2 && (bodyObj2.max_tokens || 4096) > maxCap2) bodyObj2.max_tokens = maxCap2;
        const b2 = JSON.stringify(bodyObj2);
        try {
          addActive(tp);
          const base = DIRECT_PROVIDERS[tp];
          const ep = (DIRECT_PATH_PREFIX[tp] || '/v1') + '/chat/completions';
          const up = await forwardToDirect(nk, b2, base, ep, 'text/event-stream', undefined, _opencodeExtraHeaders(req, tp), sig);
          if (up.statusCode >= 200 && up.statusCode < 300) {
            sseUpstream = up; sseProvider = tp; sseModel = tm;
            curProvider = tp; curUpstream = up; curKey = nk;
            log(`[${logId}] ➡️ sse retry → [${tp}/${tm}]`);
            // the retry target becomes the account target: a later failure must
            // be charged to the provider/key that actually served the stream
            streamState = { provider: tp, model: tm, key: nk, t0: t0 };
            sawTerminal = false; sawDoneFrame = false; tailBuf = '';
            releaseKey(tp, nk);
            return true;
          }
          decActive(tp);
          const sseErrBody = await collectBody(up);
          if (_isHealthFailure(up.statusCode)) _markKeyFailed(tp, nk, up.statusCode, sseErrBody);
          releaseKey(tp, nk);
          if (up.statusCode >= 500) _recordProviderFailure(tp);
          // same policy as chat: only credential/429/5xx failures lock the model
          if (up.statusCode === 401 || up.statusCode === 403 || up.statusCode === 429 || up.statusCode >= 500) _recordModelFailure(tp, tm, t0);
          log(`[${logId}] ➡️ sse retry [${tp}/${tm}] ${up.statusCode} ${_errMsg(sseErrBody)}`);
        } catch (e2) {
          decActive(tp);
          // A client cancel rejects 'aborted' — not an upstream fault.
          if (clientGone || (e2.message || '').startsWith('aborted')) { releaseKey(tp, nk); log(`[${logId}] ➡️ sse retry [${tp}/${tm}] cancelled by client`); continue; }
          markKeyError(tp, nk); releaseKey(tp, nk);
          _recordProviderFailure(tp); _recordModelFailure(tp, tm, t0);
          log(`[${logId}] ➡️ sse retry [${tp}/${tm}] ${e2.message}`);
        }
      }
      return false;
    };
    for (;;) {
      if (clientGone) {
        if (curUpstream && !curUpstream.destroyed) curUpstream.destroy();
        if (curProvider) { decActive(curProvider); curProvider = null; }
        break;
      }
      if (!sseUpstream) {
        // previous attempt produced no stream — pick another target
        sseRetries++;
        if (sseRetries > 2 || !(await sseSelectAndConnect())) {
          const reason = lastSseErr || 'no usable retry target';
          commitStreamFailure(sseProvider, sseModel, curKey, streamState?.t0 || t0, reason);
          if (!committed) sendSSEError(res, `upstream stream failed before first token: ${_safeSlice(reason, 200)}`, { code: 'upstream_unavailable', logId, status: 502 });
          curKey = null;
          break;
        }
        continue; // fresh stream — go pipe it
      }
      const needModelRewrite = sseModel !== clientModel;
// Require a real terminal marker; parse frames structurally (chunk-split UTF-8
// and `"stop":` inside content must not count as termination).
      sawTerminal = false; sawDoneFrame = false; tailBuf = '';
      const _sseDec2 = new TextDecoder('utf-8');
      const isTerminalFrame = (frame) => {
        let evName = null; const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (evName === 'message_stop' || evName === 'response.completed') return true;
        for (const d of dataLines) {
          if (d === '[DONE]') { sawDoneFrame = true; return true; }
          if (!d || d[0] !== '{') continue;
          let j; try { j = JSON.parse(d); } catch { continue; }
          if (j?.type === 'response.completed' || j?.type === 'response.failed' || j?.type === 'response.incomplete') return true;
          const fr = j?.choices?.[0]?.finish_reason;
          if (fr != null) return true;                 // OpenAI: terminal chunk
          if (j?.stop === true || typeof j?.stop === 'string') return true; // Anthropic
        }
        return false;
      };
// Single write path, frame granularity: raw-chunk writes would duplicate tokens;
// frame order is also required to inject the usage chunk before [DONE].
      let sawUsageChunk = false, streamId = '', outText = '';
// Track upstream [DONE] so the gateway doesn't emit a second terminator.
      const forwardFrame = (frame) => {
        try { res.write(needModelRewrite ? rewriteModelInSse(frame + '\n\n', clientModel) : frame + '\n\n'); committed = true; } catch {}
      };
      const noteFrame = (frame) => {
        if (isTerminalFrame(frame)) sawTerminal = true;
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d || d[0] !== '{') continue;
          let j; try { j = JSON.parse(d); } catch { continue; }
          if (j.id && !streamId) streamId = j.id;
          if (j.usage && typeof j.usage === 'object' && j.usage.total_tokens != null) sawUsageChunk = true;
          const c = j.choices?.[0]?.delta?.content;
          if (typeof c === 'string') outText += c;
        }
      };
      const isDoneFrame = (frame) => /(^|\n)data:\s*\[DONE\]\s*(\n|$)/.test(frame);
      const feedSSE = (c) => {
        tailBuf += _sseDec2.decode(c, { stream: true });
        let m;
        // \r?\n\r?\n: a CRLF upstream never matches a literal '\n\n', so the
        // whole stream would sit unsplit until 'end' (no realtime streaming).
        while ((m = /\r?\n\r?\n/.exec(tailBuf)) !== null) {
          const frame = tailBuf.slice(0, m.index);
          tailBuf = tailBuf.slice(m.index + m[0].length);
          noteFrame(frame);
          // committed=true on hold: an only-[DONE] stream must still commit,
          // or 'end' treats it as empty and the client gets a silent 200.
          if (wantStreamUsage && isDoneFrame(frame)) { committed = true; continue; }   // re-emit after usage
          forwardFrame(frame);
        }
      };
      const flushTail = () => {
        tailBuf += _sseDec2.decode();   // flush a buffered partial UTF-8 tail before finalizing
        if (!tailBuf.trim()) { tailBuf = ''; return; }
        noteFrame(tailBuf);
        if (!(wantStreamUsage && isDoneFrame(tailBuf))) forwardFrame(tailBuf);
        tailBuf = '';
      };
      const emitUsageChunk = () => {
        if (!wantStreamUsage || sawUsageChunk || clientGone) return;
        const promptTokens = est || estimateTokens(bodyJson.messages) || 0;
        const completionTokens = outText ? estimateStrTokens(outText) : 0;
        const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
        const payload = { id: streamId || `chatcmpl-${rid()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: clientModel, choices: [], usage };
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
        log(`[${logId}] ℹ️ include_usage → usage chunk (prompt=${promptTokens} completion=${completionTokens})`);
      };
      // Single write path: feedSSE scans AND forwards each complete frame.
      const pipe = (c) => { feedSSE(c); };
      try {
        let sseDone = false;
        // also clear curProvider: the loop-top clientGone cleanup would otherwise
        // decActive the same slot a second time after a pipe failure
        const _sseDec = () => { if (!sseDone) { sseDone = true; decActive(sseProvider); curProvider = null; } };
        await new Promise((resolve, reject) => {
          sseUpstream.on('data', (c) => pipe(c));
          sseUpstream.on('end', () => {
            _sseDec();
            flushTail();
            if (clientGone) { resolve(); return; }
            // 200 + zero bytes: surface as a stream failure (retry/502 envelope),
            // not a silent empty stream the client must guess about.
            if (!committed) { reject(new Error('upstream returned an empty stream')); return; }
            if (!sawTerminal) { reject(new Error('upstream stream closed before terminal event')); return; }
            emitUsageChunk();
// Usage path held [DONE] back: re-emit after injecting the usage chunk.
            if (wantStreamUsage || !sawDoneFrame) { try { res.write('data: [DONE]\n\n'); } catch {} }
            commitStreamSuccess();
            resolve();
          });
          sseUpstream.on('error', (e) => { _sseDec(); reject(e); });
          const onClose = () => { res.removeListener('close', onClose); if (res.writableEnded) return; if (!sig.aborted) ac.abort(); if (sseUpstream && !sseUpstream.destroyed) sseUpstream.destroy(); _sseDec(); resolve(); };
          if (prevOnClose) res.removeListener('close', prevOnClose);
          prevOnClose = onClose;
          res.on('close', onClose);
        });
        break; // stream ended cleanly (or client cancelled — not an upstream fault)
      } catch (e) {
        if (committed) {
          if (!clientGone && sawTerminal) {
            // The terminal frame already reached the client — a late socket reset
            // after [DONE] must not append an error frame or log a failure.
            emitUsageChunk();
            if (wantStreamUsage || !sawDoneFrame) { try { res.write('data: [DONE]\n\n'); } catch {} }
            commitStreamSuccess();
            break;
          }
          // Tokens already sent to client — a transparent upstream switch would duplicate/garble output. Signal the failure, then end the stream.
          log(`[${logId}] ❌ sse failed after tokens sent [${sseProvider}/${sseModel}]: ${e.message} — cannot fallback, ending stream`);
          commitStreamFailure(sseProvider, sseModel, curKey, streamState?.t0 || t0, e.message);
          try { res.write(`data: ${JSON.stringify(_errorBody(`upstream stream failed after output started: ${_safeSlice(e.message, 200)}`, { code: 'upstream_unavailable' }))}\n\n`); } catch {}
          try { res.write('data: [DONE]\n\n'); } catch {}
          break;
        }
        lastSseErr = e.message;
        log(`[${logId}] ➡️ sse stream error before first token (retry ${sseRetries + 1}): ${e.message}`);
        sseUpstream = null;   // dead stream — loop top picks the next target
        continue;
      }
    }
    try { res.end(); } catch {}
  } else {
// Cross-check declared length: truncation converts to a recorded failure.
    const declared = Number(upstreamRes.headers['content-length'] || 0);
    const body = await collectBody(upstreamRes);
    releaseKey(usedProvider, usedKey);
    // A client hangup aborts collectBody (null): that is not upstream truncation
    // and must not degrade the key or open the provider circuit.
    if (body === null && clientGone) { decActive(usedProvider); if (!sig.aborted) ac.abort(); return; }
    if (body === null || (body === '' && declared > 0)) {
      log(`[${logId}] ❌ 502 [${usedProvider}/${usedModel}] upstream body truncated (expected ${declared} bytes)`);
      markKeyError(usedProvider, usedKey); _recordProviderFailure(usedProvider, t0);
      logEvent({ logId, provider: usedProvider, model: usedModel, key: usedKey, status: 502, body: `upstream body truncated (expected ${declared} bytes)` });
      sendError(res, 502, 'upstream response truncated', { code: 'upstream_truncated', logId });
      decActive(usedProvider);
      if (!sig.aborted) ac.abort();
      return;
    }
    // A client that hung up mid-download is not an upstream failure, but it is
    // not a success either — free the key without crediting health.
    // Real usage from the response beats the est+max_tokens guess.
    let okTokens = totalEst || 0, outBody = body;
    try {
      const j = JSON.parse(body);
      const u = j?.usage?.total_tokens; if (Number.isFinite(u) && u >= 0) okTokens = u;
      // Echo the client-facing model name (alias), same contract as the SSE
      // path's rewriteModelInSse — clients match response.model against their
      // own model tables, and upstream names must not leak the routing.
      if (j && typeof j === 'object' && j.model && j.model !== clientModel) { j.model = clientModel; outBody = JSON.stringify(j); }
    } catch {}   // non-JSON upstream body stays untouched
    if (!clientGone) commitSuccess(usedProvider, usedModel, usedKey, t0, okTokens);
    _clearUpstream429Signal(res);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Request-Id': logId, 'X-Provider': usedProvider, 'X-Upstream-Model': usedModel, ..._rlHeaders(usedProvider, upstreamRes),
    });
    res.end(outBody);
    decActive(usedProvider);
  }
  if (!sig.aborted) ac.abort();
}

async function handleProxy(req, res, bodyJson, logId, endpointPath, jsonBody, contentType) {
  const t0 = Date.now();
  log('─');
  if (jsonBody !== false) {
    if (!bodyJson || typeof bodyJson !== 'object') {
      log(`[${logId}] ❌ 400  invalid request body`);
      sendError(res, 400, 'invalid request body', { type: 'invalid_request_error' });
      return;
    }
  }

  const clientModel = jsonBody !== false ? (bodyJson?.model || '') : '';
  // endpointPath has no /v1 prefix; config endpoint_fallbacks keys are /v1/...
  let targets = resolveModelForEndpoint(clientModel, '/v1' + endpointPath);
  if (!targets) {
    targets = [{ provider: 'openai', upstreamModel: clientModel || '' }];
    log(`[${logId}] ⚡ ${clientModel || '(raw body)'} ${endpointPath}  (→ openai)`);
  } else {
    log(`[${logId}] ⚡ ${clientModel}  ${endpointPath}`);
  }

  const activeTargets = targets.filter(t => {
    if (!PROVIDERS_WITH_KEYS.has(t.provider)) return false;
    if (!DIRECT_PROVIDERS[t.provider]) return false;
    return true;
  });
  if (activeTargets.length === 0) {
    log(`[${logId}] ❌ 400  no keys for ${clientModel || '(no model)'}`);
    sendError(res, 400, 'no keys available for this model', { code: 'no_available_providers' });
    return;
  }

  let lastErr = null;
  const skippedProviders = new Set(); // providers that returned non-429 non-200 this request → skip channel
  let clientGone = false;
  let bodyStr = '';
  let upstreamContentType = '';
  const ac = new AbortController();
  const sig = ac.signal;
  let pipeRes = null;
  res.on('close', () => { if (res.writableEnded) return; clientGone = true; if (!sig.aborted) ac.abort(); if (pipeRes && !pipeRes.destroyed) pipeRes.destroy(); });
  const processResponse = async (upstreamRes, provider, upstreamModel, key) => {
    if (clientGone) { if (upstreamRes && !upstreamRes.destroyed) upstreamRes.destroy(); decActive(provider); releaseKey(provider, key); return 'done'; }
    const sc = upstreamRes.statusCode;
    if (sc >= 200 && sc < 300) {
      log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
      const ctype = upstreamRes.headers['content-type'] || 'application/json';
      _clearUpstream429Signal(res);
      res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider, ..._rlHeaders(provider, upstreamRes) });
      pipeRes = upstreamRes;
      // slot/key/health are settled by the pipe watcher on real completion
      _pipeWithAccounting(upstreamRes, res, { provider, model: upstreamModel, key, t0, logId, tokens: 0 });
      return 'done';
    }
    decActive(provider);
    const body = await collectBody(upstreamRes);
    // Mark BEFORE releasing: a slow error body must not leave the key
    // selectable while we know it just failed.
    releaseKey(provider, key);
    if (_isHealthFailure(sc)) _markKeyFailed(provider, key, sc, body);
    if (sc === 429) await _handleUpstream429(provider, key, upstreamRes, body, logId, res);
    const isFreeTier = _isFreeTierError(body);
    log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} ${_errMsg(body)}${isFreeTier ? ' free-tier' : ''}`);   // stdout honours the disk redaction policy
    logEvent({ logId, provider, model: upstreamModel, key, status: sc, body });
    lastErr = { status: sc, body };
    if (isFreeTier) {
      _recordModelFailure(provider, upstreamModel, t0);
      skippedProviders.add(provider);
    } else {
      if (sc >= 500) _recordProviderFailure(provider);
      // same policy as chat: only credential/429/5xx failures lock the model
      if (sc === 401 || sc === 403 || sc === 429 || sc >= 500) _recordModelFailure(provider, upstreamModel, t0);
      if (sc !== 429) skippedProviders.add(provider);
    }
    if (sc === 401) markKey401(provider, key, upstreamModel);
    return 'retry';
  };

  let retryRound = 0;
  let transientSkipped = false; // a target was skipped for a recoverable reason (concurrency/rate/TPM)
  while (!clientGone && Date.now() - t0 < TIMEOUT_MS && (retryRound < RETRY_MAX_ROUNDS || transientSkipped)) {
    if (retryRound > 0) {
      const wait = (transientSkipped && !lastErr) ? RETRY_TRANSIENT_WAIT : Math.min(retryRound * RETRY_BASE_DELAY, RETRY_MAX_DELAY);
      log(`[${logId}] 🔄 retry ${retryRound} — wait ${wait}ms${transientSkipped && !lastErr ? ' (all targets transiently skipped, keeping client connection)' : ' for key recovery'}`);
      await sleep(wait);
    }
    retryRound++;
    transientSkipped = false;
    const rotatedTargets = rotateTargets(activeTargets, clientModel);
    for (const target of rotatedTargets) {
      const { provider, upstreamModel } = target;
      if (skippedProviders.has(provider)) continue;
      if (_isModelLocked(provider, upstreamModel)) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (model lockout)`); continue; }
      const directBase = DIRECT_PROVIDERS[provider];
      let proxyEst = 0;
      if (jsonBody !== false && bodyJson) {
        const text = bodyJson.input || bodyJson.prompt || '';
        const inputText = typeof text === 'string' ? text : Array.isArray(text) ? text.join('') : '';
        proxyEst = estimateStrTokens(inputText);
      }
      const pLimitKey = `${provider}/${upstreamModel}`.toLowerCase();
      const pCtx = USER_MODEL_LIMITS.get(pLimitKey) || PROVIDER_DEFAULT_LIMITS[provider] || 999999;
      if (proxyEst > pCtx) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (${proxyEst} > ${pCtx})`); continue; }
      if (isRateLimited(provider)) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (rate limited)`); transientSkipped = true; continue; }
      if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (concurrency ${_providerActive.get(provider)})`); transientSkipped = true; continue; }
      if (_isCircuitOpen(provider)) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (circuit breaker)`); transientSkipped = true; continue; }
      const key = await selectKey(provider, sig);
      if (!key) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] no key available`); if (getHealthyKeys(provider).length > 0) transientSkipped = true; continue; }   // busy ≠ broken: poll instead of instant 502
      if (lastErr) await sleep(Math.random() * 300);

      if (directBase) {
        const cfImage = _isCFBase(directBase) && endpointPath === '/images/generations' && jsonBody !== false;
        if (cfImage) {
          const cfBody = { prompt: String(bodyJson.prompt || '') };
          if (bodyJson.size) cfBody.size = bodyJson.size;
          const cfEp = _cfRunPath(upstreamModel);
          try {
            addActive(provider);
            const upstreamRes = await forwardToDirect(key, JSON.stringify(cfBody), directBase, cfEp, 'application/json', 'application/json', _opencodeExtraHeaders(req, provider), sig);
            const sc = upstreamRes.statusCode;
            if (sc >= 200 && sc < 300 && !clientGone) {
              const raw = (await collectBody(upstreamRes)) ?? '';
              let img = '';
              try { img = JSON.parse(raw.toString()).result?.image || ''; } catch {}
              if (img) {
                decActive(provider); releaseKey(provider, key); markKeySuccess(provider, key, Date.now()-t0);
                _recordProviderSuccess(provider, t0);
                _recordModelSuccess(provider, upstreamModel, t0);
                logEvent({ logId, provider, model: upstreamModel, key, latency: (Date.now()-t0)/1000 });
                if (!sig.aborted) ac.abort();
                log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
                _clearUpstream429Signal(res);
                res.writeHead(sc, { 'Content-Type': 'application/json', 'X-Request-Id': logId, 'X-Provider': provider });
                res.end(JSON.stringify({ data: [{ b64_json: img }] }));
                return;
              }
              decActive(provider); releaseKey(provider, key);
              _markKeyFailed(provider, key, 502, raw.toString());
              log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] cf image bad response ${_errMsg(raw.toString())}`);
              logEvent({ logId, provider, model: upstreamModel, key, status: 502, body: raw.toString() });
              lastErr = { status: 502, body: raw.toString() };
              _recordProviderFailure(provider);
              _recordModelFailure(provider, upstreamModel);
              skippedProviders.add(provider);
              continue;
            }
            if (await processResponse(upstreamRes, provider, upstreamModel, key) === 'done') return;
            continue;
          } catch (e) {
            decActive(provider);
            const aborted = clientGone || (e.message || '').startsWith('aborted');
            if (!aborted) markKeyError(provider, key);
            releaseKey(provider, key);
            // A client cancel rejects 'aborted' — not an upstream fault.
            if (!aborted) { _recordProviderFailure(provider); _recordModelFailure(provider, upstreamModel, t0); }
            log(`[${logId}] ${aborted ? '➡️' : '❌'} 502 [${provider}/${upstreamModel}] key=${logKey(key)} ${aborted ? 'client cancelled' : e.message}`);
            if (!aborted) logEvent({ logId, provider, model: upstreamModel, key, status: 502, body: e.message });
            lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
            continue;
          }
        }
        if (jsonBody !== false) {
                  const proxyBody = { ...bodyJson, model: upstreamModel };
                  const banned = PROVIDER_BANNED_FIELDS[provider];
                  if (banned) for (const f of banned) delete proxyBody[f];
                  _adjustReasoningFields(proxyBody, provider); // strip/rewrite unsupported reasoning params for this upstream
                  if (Array.isArray(proxyBody.tools)) proxyBody.tools = proxyBody.tools.map(t => { const c = { ...t }; delete c.strict; return c; });
                  bodyStr = JSON.stringify(proxyBody);
                } else {
          bodyStr = upstreamModel ? patchMultipartField(bodyJson, 'model', upstreamModel) : bodyJson;
        }
        upstreamContentType = jsonBody !== false ? 'application/json' : (contentType || 'application/octet-stream');
        try {
          addActive(provider);
          const upstreamRes = await forwardToDirect(key, bodyStr, directBase, (DIRECT_PATH_PREFIX[provider] || '/v1') + endpointPath, 'application/json', upstreamContentType, _opencodeExtraHeaders(req, provider), sig);
          if (await processResponse(upstreamRes, provider, upstreamModel, key) === 'done') return;
          continue;
        } catch (e) {
          decActive(provider);
          markKeyError(provider, key);
          releaseKey(provider, key);
          _recordProviderFailure(provider);
          _recordModelFailure(provider, upstreamModel);
          log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] key=${logKey(key)} ${e.message}`);
          logEvent({ logId, provider, model: upstreamModel, key, status: 502, body: e.message });
          lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
          continue;
        }
      }
    }
    const anyRetryable = rotatedTargets.some(t => !skippedProviders.has(t.provider) && !_isModelLocked(t.provider, t.upstreamModel));
    if (!transientSkipped && (!lastErr || !anyRetryable)) { log(`[${logId}] ➡️ all targets skipped (permanent)`); break; }
  }

  if (!sig.aborted) ac.abort();
  if (!lastErr) lastErr = { status: 502, body: JSON.stringify({ error: { message: 'no key succeeded' } }) };

  const errCode = lastErr?.status || 502;
  log(`[${logId}] ${_statusIcon(errCode)} ${errCode} all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
  logEvent({ logId, provider: '-', model: clientModel, key: '-', status: errCode, body: lastErr?.body });
  // surface WHY (sanitised) — "all failed" with no detail is undiagnosable
  const detail = lastErr?.body ? (typeof lastErr.body === 'string' ? lastErr.body : JSON.stringify(lastErr.body)) : '';
  sendError(res, 502, 'all upstream providers failed' + (detail ? `: ${_safeSlice(detail, 200)}` : ''), { code: 'upstream_unavailable' });
}

async function handleFiles(req, res, rawBody, logId, contentType) {
  const t0 = Date.now();
  const method = (req.method || 'POST').toUpperCase();
  log('─'); log(`[${logId}] ${method} /v1/files${req.url.replace(/^\/v1\/files\/?/i, '') ? '/' + req.url.replace(/^\/v1\/files\/?/i, '') : ''}`);
  if (method === 'POST' && (!rawBody || rawBody.length === 0)) {
    sendError(res, 400, 'empty body', { type: 'invalid_request_error' });
    return;
  }
  // Pin to upstream file path (extract sub-path like /:id or /:id/content)
  const suffix = req.url.startsWith('/v1/files/') ? req.url.slice(10) : '';
  const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';   // /v1/files?x — keep upstream query params
  let targets = resolveModelForEndpoint('', '/v1/files');
  if (!targets) targets = [{ provider: 'openai', upstreamModel: '' }];
  const activeTargets = targets.filter(t => PROVIDERS_WITH_KEYS.has(t.provider) && DIRECT_PROVIDERS[t.provider]);
  if (activeTargets.length === 0) {
    sendError(res, 400, 'no provider available', { code: 'no_available_providers' });
    return;
  }
  let lastErr = null;
  for (const { provider, upstreamModel } of activeTargets) {
    if (_isCircuitOpen(provider)) { log(`[${logId}] ➡️ [${provider}] skip (circuit breaker)`); lastErr = { status: 502, body: 'circuit open' }; continue; }
    const key = await selectKey(provider);
    if (!key) { lastErr = { status: 502, body: 'no key' }; continue; }
    const base = DIRECT_PROVIDERS[provider];
    if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) { releaseKey(provider, key); lastErr = { status: 429 }; continue; }
    addActive(provider);
    const ep = (DIRECT_PATH_PREFIX[provider] || '/v1') + '/files' + (suffix ? '/' + suffix : '') + (suffix.includes('?') ? '' : rawQuery);
    try {
      const up = await forwardToDirect(key, method === 'POST' ? rawBody : null, base, ep, 'application/json', method === 'POST' ? contentType : undefined, null, null, method);
        const sc = up.statusCode;
        if (sc >= 200 && sc < 300) {
        log(`[${logId}] ✅ ${sc} [${provider}/files] (${((Date.now()-t0)/1000).toFixed(1)}s)`);
        const ctype = up.headers['content-type'] || 'application/json';
        res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider, ..._rlHeaders(provider, up) });
        _pipeWithAccounting(up, res, { provider, model: upstreamModel || 'files', key, t0, logId, tokens: 0 });
        return;
      }
        decActive(provider); releaseKey(provider, key);
        const fileBody = await collectBody(up);
        if (_isHealthFailure(sc)) _markKeyFailed(provider, key, sc, fileBody);
        lastErr = { status: sc, body: fileBody };
      if (sc >= 500) _recordProviderFailure(provider);
      log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/files] ${_errMsg(lastErr.body)}`);   // stdout honours the disk redaction policy
      logEvent({ logId, provider, model: upstreamModel || 'files', key, status: sc, body: lastErr.body });
      } catch (e) {
        decActive(provider); markKeyError(provider, key); releaseKey(provider, key);
        _recordProviderFailure(provider);
        lastErr = { status: 502, body: e.message };
      }
  }
  const fdetail = lastErr?.body ? (typeof lastErr.body === 'string' ? lastErr.body : JSON.stringify(lastErr.body)) : 'no upstream';
  log(`[${logId}] ${_statusIcon(lastErr?.status || 502)} ${lastErr?.status || 502} files failed ${_errMsg(fdetail)}`);
  // HTTP stays 502 (same policy as chat): upstream status may be a credential
  // error, and its raw body may not even be JSON.
  sendError(res, 502, `file operation failed: ${_safeSlice(fdetail, 200)}`, { code: 'upstream_unavailable', logId });
}

// --- console management page & API ---
// note: re-read on change (watcher below) so console.html deploys take effect without restart
let CONSOLE_HTML = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf-8');
function _reloadConsoleHtml() {
  try {
    CONSOLE_HTML = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf-8');
    log('─'); log('🔄 [console] console.html reloaded');
  } catch (e) { elog('─'); elog(`[console] reload failed: ${e.message}`); }
}

function checkConsoleAuth(req, res) {
  const deny = () => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  };
  // A config we failed to parse may hold the real token — never treat it as
  // "no token = open": that would expose provider keys and the save endpoint.
  if (_cfgBroken && !process.env.CLIENT_TOKEN) return deny();
  // REQUIRE_TOKEN with no configured token is a locked install, not an open one
  // (returning false without a response left the request hanging).
  if (!CLIENT_TOKEN) return process.env.REQUIRE_TOKEN === '1' ? deny() : true;
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ') || !_timingEqual(auth.slice(7), CLIENT_TOKEN)) return deny();
  return true;
}

function serveConsolePage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(CONSOLE_HTML);
}

function handleConsoleValidate(req, res, logId) {
  log('─'); log(`[${logId}] /api/console/validate`);
  if (!checkConsoleAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleConsoleLoad(req, res, logId) {
  log('─'); log(`[${logId}] /api/console/load`);
  if (!checkConsoleAuth(req, res)) return;
  const readAll = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
  // Tail-read instead of readFileSync+split. A capped 100MB log would otherwise
  // be loaded into memory and shipped to the browser on every dashboard open.
  // Save ships this view back verbatim — logCut makes truncation visible to the UI.
  let logCut = false;
  const tailOf = (p) => {
    try {
      const st = fs.statSync(p);
      if (!st.size) return '';
      const max = Math.min(st.size, 8 * 1024 * 1024);
      if (max < st.size) logCut = true;
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(max);
        const n = fs.readSync(fd, buf, 0, max, st.size - max);
        let text = buf.toString('utf8', 0, n);
        if (max < st.size) text = text.slice(text.indexOf('\n') + 1);
        return text;
      } finally { fs.closeSync(fd); }
    } catch { return ''; }
  };
  // After a size rotation the newest entries live in the `.1` generation, so a
  // console that only read the live file would show an empty log. Merge
  // oldest-generation-first and cap the combined line count.
  const readTail = (p) => {
    const text = [tailOf(p + '.1'), tailOf(p)].filter(Boolean).join('\n');
    if (!text) return '';
    const lines = text.split('\n');
    if (lines.length > MAX_LOG_LINES) logCut = true;
    return lines.slice(-MAX_LOG_LINES).join('\n');
  };
  const cfgContent = readAll(CONFIG_PATH), logContent = readTail(getLogPath());
  const cfgVal = _jsonValid(cfgContent), logVal = _ndjsonValid(logContent);
  let cfgOut = cfgContent, cfgFixed = false;
  if (!cfgVal.ok) {
    const fixed = _autoFixJson(cfgContent);
    if (fixed !== null) { cfgOut = fixed; cfgFixed = true; }
  }
  let logOut = logContent, logFixed = false;
  if (!logVal.ok) {
    const lines = logContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith('#')) continue;
      if (_jsonValid(lines[i]).ok) continue;
      const f = _autoFixJson(lines[i]);
      if (f !== null) { lines[i] = f; logFixed = true; }
    }
    if (logFixed) logOut = lines.join('\n');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    // actual filenames — the UI must label editors with what is really read/written
    config_file: path.basename(CONFIG_PATH || 'config.json'),
    log_file: path.basename(getLogPath()),
    config: cfgOut, config_valid: cfgVal.ok || cfgFixed, config_error: cfgVal.error || null, config_fixed: cfgFixed,
    log: logOut, log_valid: logVal.ok || logFixed, log_error: logVal.error || null, log_fixed: logFixed,
    log_truncated: logCut,
  }));
}

function handleConsoleStatus(req, res, logId) {
  log('─'); log(`[${logId}] /api/console/status`);
  if (!checkConsoleAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(_buildStatusJSON()));
}

async function handleConsoleSave(req, res, body, logId) {
  log('─'); log(`[${logId}] /api/console/save`);
  if (!checkConsoleAuth(req, res)) return;
  if (!body || !body.file || body.content === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file and content required' }));
    return;
  }
  if (body.file !== 'config' && body.file !== 'log') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid file type' }));
    return;
  }
  const target = body.file === 'config' ? (CONFIG_PATH || path.join(__dirname, 'config.json')) : getLogPath();
  log(`[${logId}] save ${body.file} → ${target}  contentLen=${(body.content||'').length}`);
  try {
    if (body.file === 'log' && !body.content.trim()) {
      // Empty view + Save would wipe the file (the .1 generation dies too) —
      // count .1 as well: right after a rotation the live file is empty but .1 isn't.
      let sz = 0;
      for (const f of [target, target + '.1']) { try { sz += fs.statSync(f).size; } catch {} }
      if (sz > 0) {
        log(`[${logId}] ❌ save rejected: refusing to overwrite a non-empty log with empty content`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'log content is empty — refusing to overwrite a non-empty log file' }));
        return;
      }
    }
    if (body.file === 'config') {
      const isJsonc = CONFIG_PATH ? CONFIG_PATH.endsWith('.jsonc') : false;
      if (isJsonc) {
        const v = _jsonValid(body.content);
        if (!v.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid config content: ' + v.error }));
          return;
        }
      } else {
        try { JSON.parse(body.content); }
        catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'config is .json but content is not valid JSON: ' + e.message }));
          return;
        }
      }
    } else if (body.content.trim()) {
      let lineNo = 0;
      for (const rawLine of body.content.split('\n')) {
        const l = rawLine.trim();
        if (!l || l.startsWith('#')) continue;
        lineNo++;
        try { JSON.parse(l); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `log line ${lineNo} is not valid JSON: ${e.message}` }));
          return;
        }
      }
    }
// Enforcement point for Raw/direct saves: valid JSON can still be a dead gateway.
    if (body.file === 'config') {
      let obj = null;
      try { obj = parseJsonc(body.content); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'config is not valid JSONC: ' + e.message }));
        return;
      }
      const problem = lib.validateConfigObject(obj);
      if (problem) {
        log(`[${logId}] ❌ save rejected: ${problem}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid config: ' + problem }));
        return;
      }
    }
    if (body.file === 'log') {
      // Join the log IO chain: an in-flight fs.appendFile holds the old inode,
      // and renaming over it mid-write silently drops that batch.
      let writeErr = null;
      await _logIo(() => {
        try {
          _atomicWrite(target, body.content);
// Saved file supersedes the rotated .1 generation: delete it or deleted rows resurrect.
          const prev = target + '.1';
          if (fs.existsSync(prev)) {
            fs.unlinkSync(prev);
            log(`[${logId}] removed stale rotated generation ${path.basename(prev)} (log was saved as a single file)`);
          }
          stats.latSum = 0; stats.latN = 0; _reseedStats();
        } catch (e) { writeErr = e; }
      });
      if (writeErr) throw writeErr;
    } else {
      _atomicWrite(target, body.content);
    }
    log(`[${logId}] saved ${body.file}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    if (body.file === 'config' && !CONFIG_PATH) {
      setTimeout(() => {
        log('─'); log(`🔄 [config] first config file created — restarting...`);
        _gracefulRestart();
      }, 500).unref();
    } else if (body.file === 'config') {
// Don't rely solely on the watcher (network FS can swallow events).
      _scheduleConfigReload();
    }
  } catch (e) {
    log('─'); log(`❌ [${logId}] save error: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
function handleConsoleStream(req, res, logId) {
  log('─'); log(`[${logId}] /api/console/stream`);
// Header-only auth: ?token= put credentials in history/proxy logs.
  if (!checkConsoleAuth(req, res)) return;
  if (new URL(req.url, 'http://x').searchParams.has('token')) {
    elog('─'); elog(`[${logId}] ⚠️ /api/console/stream rejected a ?token= credential — use the Authorization header`);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
// no-transform: stops proxies buffering the endless stream (HTTP/2 resets).
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  _sseClients.add(res);
  _ensureSSETimer();
  res.write(`event: status\ndata: ${JSON.stringify(_buildStatusJSON())}\n\n`);
  req.on('close', () => { _sseClients.delete(res); });
}
function handleConsoleRetry401(req, res, body, logId) {
  log('─'); log(`[${logId}] /api/console/retry401`);
  if (!checkConsoleAuth(req, res)) return;
  // Clearing the list alone leaves keys degraded 1h — a degraded key is never
  // selected, so success could never clear it either. Operator says: retry.
  for (const e of _recent401.values()) {
    initProvider(e.provider);
    const s = keyPool.get(e.provider)?.get(e.key);
    if (s) { s.degradedUntil = 0; s.errorCount = 0; }
    _noteRecovered(e.provider, e.key);
  }
  _recent401.clear();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
async function handleConsoleProbe(req, res, body, logId) {
  log('─'); log(`[${logId}] /api/console/probe`);
  if (!checkConsoleAuth(req, res)) return;
  const { provider } = body || {};
  if (!provider || !DIRECT_PROVIDERS[provider]) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid provider' }));
    return;
  }
  const url = (DIRECT_PROVIDERS[provider] || '').replace(/\/+$/, '');
// Re-validate: this endpoint fetches URLs, so a poisoned baseUrl = intranet scan.
  const blk = _isBlockedEgressUrl(url);
  if (blk) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, status: 0, error: 'blocked: ' + blk }));
    return;
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { signal: controller.signal, method: 'GET', redirect: 'error' });
    clearTimeout(t);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: r.status, latency: 'live' }));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, status: 0, error: e.message }));
  }
}
// note: decision-model relay — the gateway only relays; `model` selects upstream.
// note: tier is a pass-through label; unknown values fall back to 'fast'.
const _CLS_TIERS = new Set(['fast', 'balanced', 'smart']);
function _normalizeClassifierTier(t) { const v = String(t || 'fast').toLowerCase(); return _CLS_TIERS.has(v) ? v : 'fast'; }
async function handleClassifyRelay(req, res, body, logId) {
  log('─'); log(`[${logId}] /v1/classifier`);
  const texts = Array.isArray(body?.texts) ? body.texts : (Array.isArray(body?.inputs) ? body.inputs : (body?.input ? [body.input] : null));
  const labels = Array.isArray(body?.labels) ? body.labels : null;
  if (!texts || texts.length === 0 || !labels || labels.length < 2) {
    sendError(res, 400, 'texts[] (1-1000) and labels[] (2+) required', { type: 'invalid_request_error' });
    return;
  }
  if (texts.length > 1000) {
    sendError(res, 400, 'max 1000 texts per call', { type: 'invalid_request_error' });
    return;
  }
  let baseUrl = CLASSIFIER.base_url, apiKey = CLASSIFIER.api_key, upDesc = 'classifier';
  if (apiKey === 'unused' || apiKey === '') apiKey = '';
  if (body?.model) {
    const t = resolveModelForEndpoint(body.model, '/v1/classifier')?.[0];
    if (!t || !DIRECT_PROVIDERS[t.provider]) {
      sendError(res, 400, `model '${body.model}' not supported`, { type: 'invalid_request_error' });
      return;
    }
    baseUrl = DIRECT_PROVIDERS[t.provider];
    apiKey = (PROVIDER_KEYS[t.provider] || [])[0] || '';
    upDesc = `${t.provider}/${t.upstreamModel}`;
  } else {
    const t = resolveModelForEndpoint(null, '/v1/classifier')?.[0]
      || resolveModelForEndpoint(null, '/v1/classify')?.[0];
    if (t && DIRECT_PROVIDERS[t.provider]) {
      baseUrl = DIRECT_PROVIDERS[t.provider];
      apiKey = (PROVIDER_KEYS[t.provider] || [])[0] || '';
      upDesc = `${t.provider}/${t.upstreamModel}`;
    }
  }
  const maxChars = CLASSIFIER.max_chars || 32000;
  const clipped = texts.map((t) => String(t ?? '').slice(0, maxChars));
  // tier belongs in the fingerprint: full vs non-full models answer differently
  const clsTier = _normalizeClassifierTier(body.tier);
  const fp = CLS_MEMO_ON
    ? crypto.createHash('sha256').update(JSON.stringify({ u: upDesc, l: labels.map(String), t: clipped, r: clsTier })).digest('hex')
    : null;
  if (fp) {
    const hit = _clsMemo.get(fp);
    if (hit !== undefined) {
      log(`[${logId}] ✅ 200 /v1/classifier [${upDesc}] (${texts.length} texts, memo hit)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...hit, cached: true }));
      return;
    }
  }
  try {
    const out = await lib.classifyTexts(
      { baseUrl, apiKey, tier: clsTier, timeoutMs: CLASSIFIER.timeout_ms || 15000, maxChars },
      { labels, inputs: clipped }
    );
    if (fp) _clsMemo.set(fp, out);
    log(`[${logId}] ✅ 200 /v1/classifier [${upDesc}] (${texts.length} texts)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...out, cached: false }));
    return;
  } catch (e) {
    const sc = e && e.code === 'classifier_429' ? 429 : 502;
    log(`[${logId}] ${_statusIcon(sc)} ${sc} /v1/classifier ${e.message}`);
    sendError(res, sc, e.message, { code: e.upstreamCode || e.code || 'classifier_error', logId });
  }
}
// Push cadence: log realtime; health 10s (rss/heap/active/uptime); status 60s.
const STATUS_PUSH_MS = 60000;
const HEALTH_PUSH_MS = 10000;
function _buildHealthJSON() {
  const mem = process.memoryUsage();
  return {
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
    active: _activeRequests,
    uptime: formatUptime(process.uptime()),
  };
}
function _ensureSSETimer() {
  if (_sseTimer) return;
  let tick = 0;
  _sseTimer = setInterval(() => {
    if (_sseClients.size === 0) return;
    _pushSSE('health', _buildHealthJSON());
    // Pre-increment: the first status after connect goes out at STATUS_PUSH_MS,
    // not on the first tick (connect already pushes an immediate snapshot).
    if (++tick % Math.round(STATUS_PUSH_MS / HEALTH_PUSH_MS) === 0) {
      _pushSSE('status', _buildStatusJSON());
    }
  }, HEALTH_PUSH_MS).unref();
}
function handleConsoleProviderDetail(req, res, logId, url) {
  log('─'); log(`[${logId}] /api/console/provider-detail`);
  if (!checkConsoleAuth(req, res)) return;
  const p = new URL(url, 'http://x').searchParams.get('provider');
  if (!p || (!keyPool.has(p) && !PROVIDERS_WITH_KEYS.has(p))) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid provider' }));
    return;
  }
  if (!keyPool.has(p)) initProvider(p);
  const now = Date.now();
  const keys = [];
  for (const [k, v] of keyPool.get(p)) {
    keys.push({
      key: logKey(k),
      latency_ms: v.lastLatency,
      successCount: v.successCount,
      errorCount: v.errorCount,
      degraded: now < v.degradedUntil,
      lastSuccess: v.lastSuccess ? Math.round((now - v.lastSuccess) / 1000) + 's' : 'never',
    });
  }
  const cbEntry = _circuitBreaker.get(p);
  const cbOpen = cbEntry ? _isCircuitOpen(p) : false;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    provider: p,
    keys,
    circuitBreaker: { open: cbOpen, count: cbEntry ? cbEntry.count : 0, openUntil: cbEntry ? cbEntry.openUntil : 0 },
    recent401: [..._recent401.values()].filter(e => e.provider === p).map(e => ({ model: e.model, key: logKey(e.key), ts: _ts(e.ts) })),
  }));
}
function isJsonEndpoint(url) {
  return url.startsWith('/v1/chat/completions') ||
         url.startsWith('/v1/embeddings') ||
         url.startsWith('/v1/images/generations') ||
         url.startsWith('/v1/audio/speech') ||
         url.startsWith('/v1/moderations') ||
         url.startsWith('/v1/rerank') ||
         url.startsWith('/v1/responses') ||
         url.startsWith('/v1/messages') ||
         url.startsWith('/v1/classify') ||
         url.startsWith('/v1/classifier') ||
            url === '/api/console/validate' ||
            url === '/api/console/save' ||
            url === '/api/console/retry401' ||
            url === '/api/console/probe';
}

let _activeRequests = 0;
let _reqCount = 0;
const MEM_LIMIT_MB = parseInt(process.env.MEM_LIMIT_MB || '300', 10);
function _memGuard() {
  _reqCount++;
  if (_reqCount % MEM_CHECK_INTERVAL === 0) {
    const mem = process.memoryUsage().rss;
    if (MEM_LIMIT_MB > 0 && mem > MEM_LIMIT_MB * 1024 * 1024) {
      elog('─'); elog(`🚨 [mem] RSS ${(mem/1024/1024).toFixed(0)}MB > ${MEM_LIMIT_MB}MB — exiting`);
      try { _saveKeyStateSync(); } catch {}
      try { _flushLogSync(); } catch {}
      process.exit(1);
    }
  }
}

const server = http.createServer((req, res) => {
  const logId = rid();
  _activeRequests++;
  _memGuard();
  req.on('error', () => {});
  res.on('error', () => {});

  // Safe response helpers — silently no-op if client already disconnected
  const _wh = res.writeHead.bind(res), _end = res.end.bind(res);
  let _reqClosed = false;
  res.writeHead = (...a) => { try { return _wh(...a); } catch {} };
  res.end = (...a) => { try { if (!_reqClosed) { _reqClosed = true; _activeRequests--; } return _end(...a); } catch {} };
  // res 'close' = response completed or connection terminated. req 'close' is
  // the request MESSAGE completing (Node ≥16) — for POST that fires before the
  // handler finishes, so drain always saw zero and exited mid-request.
  res.on('close', () => { if (!_reqClosed) { _reqClosed = true; _activeRequests--; } });
// Body idle timeout (POST/PUT/PATCH only — arming it on GET killed SSE streams).
  let _bodyTimer = null;
  const _clearBodyTimer = () => { if (_bodyTimer) { clearTimeout(_bodyTimer); _bodyTimer = null; } };
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const _resetBodyTimer = () => { _clearBodyTimer(); _bodyTimer = setTimeout(() => { if (!req.destroyed) req.destroy(new Error('request body idle timeout')); }, 30000).unref(); };
    req.on('data', _resetBodyTimer);
    _resetBodyTimer();
    req.on('end', _clearBodyTimer);
    req.on('close', _clearBodyTimer);
  }

  const urlPath = req.url.split('?')[0].replace(/\/\/+/g, '/').replace(/\/+$/, '') || '/';
  const isHealth = urlPath === '/health' || urlPath === '/v1/health';

  // CORS: wildcard for API endpoints; console management endpoints are
  // same-origin only. Reflecting any Origin would let an arbitrary webpage
  // read /api/console/load (config with provider keys) from a visitor's
  // browser on an unprotected install.
  const isConsoleCors = urlPath === '/console' || urlPath.startsWith('/api/console/');
  if (isConsoleCors) {
    const _origin = req.headers['origin'];
    if (_origin) {
      try { if (new URL(_origin).host === req.headers.host) res.setHeader('Access-Control-Allow-Origin', _origin); } catch {}
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*'); res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const isConsolePath = urlPath === '/console' || urlPath.startsWith('/api/console/');
  const needsAuth = !isConsolePath && !isHealth && urlPath !== '/';
  if (needsAuth && CLIENT_TOKEN) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      sendError(res, 401, 'invalid or missing client token', { code: 'invalid_api_key' });
      return;
    }
    const token = auth.slice(7);
    const tBuf = Buffer.from(token), cBuf = Buffer.from(CLIENT_TOKEN);
    if (tBuf.length !== cBuf.length || !crypto.timingSafeEqual(tBuf, cBuf)) {
      sendError(res, 401, 'invalid or missing client token', { code: 'invalid_api_key' });
      return;
    }
  }

  // --- GET /health — liveness; also drives hourly error-log retention cleanup (throttled, fire-and-forget) ---
  if (isHealth && req.method === 'GET') {
    if (Date.now() - _lastCleanup > 3600 * 1000) { _triggerCleanup(); }
    res.writeHead(200, { 'Content-Type' : 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: formatUptime(process.uptime()), active: _activeRequests }));
    return;
  }

  // --- GET / ---
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server is working');
    return;
  }

  // --- GET /v1/models ---
  if (req.url === '/v1/models' && req.method === 'GET') {
    const modelList = Object.entries(MODELS).map(([id, targets]) => {
      let owned_by = 'unknown';
      if (typeof targets === 'string') owned_by = targets;
      else if (Array.isArray(targets)) owned_by = targets.map(t => t.provider).join(',');
      return { id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: modelList }));
    return;
  }

  // --- GET /v1/models/{model} ---
  if (req.url.startsWith('/v1/models/') && req.method === 'GET') {
    const modelId = decodeURIComponent(req.url.slice('/v1/models/'.length));
    const targets = MODELS[modelId];
    if (!targets) {
      sendError(res, 404, `model '${modelId}' not found`, { type: 'invalid_request_error' });
      return;
    }
    let owned_by = 'unknown';
    if (typeof targets === 'string') owned_by = targets;
    else if (Array.isArray(targets)) owned_by = targets.map(t => t.provider).join(',');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by }));
    return;
  }

  // --- GET /console — console page ---
  if (req.url === '/console' && req.method === 'GET') {
    serveConsolePage(res);
    return;
  }
  if (req.url === '/api/console/load' && req.method === 'GET') {
    handleConsoleLoad(req, res, logId);
    return;
  }
  if (req.url === '/api/console/status' && req.method === 'GET') {
    handleConsoleStatus(req, res, logId);
    return;
  }
  // startsWith: legacy clients passed ?token=xxx; the console now authenticates via header
  if (req.url.startsWith('/api/console/stream') && req.method === 'GET') {
    handleConsoleStream(req, res, logId);
    return;
  }
  if (req.url.startsWith('/api/console/provider-detail') && req.method === 'GET') {
    handleConsoleProviderDetail(req, res, logId, req.url);
    return;
  }

  // --- GET/DELETE /v1/files* ---
  if ((req.method === 'GET' || req.method === 'DELETE') && req.url.startsWith('/v1/files')) {
    handleFiles(req, res, null, logId, null);
    return;
  }

  // --- POST endpoints: collect body ---
  if (req.method === 'POST') {
    const _cl = parseInt(req.headers['content-length']||'0',10);
    if (_cl && _cl > MAX_BODY_SIZE) { logEvent({ logId, provider: '-', model: '-', key: '-', status: 413, body: 'request body too large' }); sendError(res, 413, 'request body too large', { code: 'payload_too_large', logId }); return; }
    const chunks = [];
    let bodySize = 0;

    req.on('data', (c) => {
      bodySize += c.length;
      if (bodySize > MAX_BODY_SIZE) { chunks.length=0; req.destroy(new Error('request body too large')); return; }
      chunks.push(c);
    });

    req.on('end', () => {
  if (req.destroyed) return;
  _clearBodyTimer();

      const rawBody = Buffer.concat(chunks);
      let json, rawStr;

      if (isJsonEndpoint(req.url)) {
        const s = rawBody.toString('utf8').trim();
        if (s) { try { json = JSON.parse(s); } catch { sendError(res, 400, 'invalid JSON', { type: 'invalid_request_error' }); return; } }
      } else {
        rawStr = rawBody;
      }

      if (req.url.startsWith('/v1/chat/completions')) {
        handleChatCompletion(req, res, json, logId);
      } else if (req.url.startsWith('/v1/embeddings')) {
        handleProxy(req, res, json, logId, '/embeddings', true);
      } else if (req.url.startsWith('/v1/images/generations')) {
        handleProxy(req, res, json, logId, '/images/generations', true);
      } else if (req.url.startsWith('/v1/audio/speech')) {
        handleTTS(req, res, json, logId);
      } else if (req.url.startsWith('/v1/audio/transcriptions')) {
        handleSTT(req, res, rawStr, logId, req.headers['content-type']);
      } else if (req.url.startsWith('/v1/audio/translations')) {
        handleProxy(req, res, rawStr, logId, '/audio/translations', false, req.headers['content-type']);
      } else if (req.url.startsWith('/v1/images/edits')) {
        handleProxy(req, res, rawStr, logId, '/images/edits', false, req.headers['content-type']);
      } else if (req.url.startsWith('/v1/images/variations')) {
        handleProxy(req, res, rawStr, logId, '/images/variations', false, req.headers['content-type']);
      } else if (req.url.startsWith('/v1/moderations')) {
        handleProxy(req, res, json, logId, '/moderations', true);
      } else if (req.url.startsWith('/v1/classifier') || req.url.startsWith('/v1/classify')) {
        handleClassifyRelay(req, res, json, logId);
      } else if (req.url.startsWith('/v1/rerank')) {
        handleProxy(req, res, json, logId, '/rerank', true);
      } else if (req.url.startsWith('/v1/responses')) {
        handleProxy(req, res, json, logId, '/responses', true);
      } else if (req.url.startsWith('/v1/messages')) {
        handleProxy(req, res, json, logId, '/messages', true);
      } else if (req.url.startsWith('/v1/files')) {
        handleFiles(req, res, rawStr, logId, req.headers['content-type']);
      } else if (req.url === '/api/console/validate') {
        handleConsoleValidate(req, res, logId);
      } else if (req.url === '/api/console/save') {
        handleConsoleSave(req, res, json, logId);
      } else if (req.url === '/api/console/retry401') {
        handleConsoleRetry401(req, res, json, logId);
      } else if (req.url === '/api/console/probe') {
        handleConsoleProbe(req, res, json, logId);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
    });

    // Handle oversized body destroy
    req.on('error', (e) => {
      if (e.message === 'request body too large') {
        logEvent({ logId, provider: '-', model: '-', key: '-', status: 413, body: 'request body too large' });
        sendError(res, 413, 'request body too large', { code: 'payload_too_large', logId });
      }
    });

    return;
  }

  // --- 404 ---
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.timeout = TIMEOUT_MS + 30000; // idle-socket cap; must exceed max silent hold (retry waits sleep up to 30s past TIMEOUT_MS) or node RSTs held-open connections. App-level TIMEOUT_MS + upstream timeout bound requests.
server.keepAliveTimeout = 5000;

server.on('error', (e) => {
  elog('─'); elog(`❌ [config] server error: ${e.message}`);
  if (e.code === 'EADDRINUSE') { elog('─'); elog(`❌ [config] port ${PORT} is already in use`); }
  setTimeout(() => process.exit(1), 1000).unref();
});

const onListening = () => {
  // must precede initProvider: restored cooldowns seed the pool
  _loadKeyState();
  Object.keys(PROVIDER_KEYS).forEach(initProvider);
  log('─');
  log(`🚀 [config] started port=${PORT} — direct upstream mode`);
  const summary = Object.entries(PROVIDER_KEYS).map(([p, ks]) => `${p}:${ks.length}`).join(' ');
  log(`[config] keys ${summary}`);
  log(`[config] timeout=${(TIMEOUT_MS/1000).toFixed(0)}s cooldown=${(KEY_COOLDOWN_MS/1000).toFixed(0)}s maxBody=${(MAX_BODY_SIZE/1024/1024).toFixed(1)}MB`);
  const elCfg = cfg.log;
  if (elCfg?.enabled !== false) log(`[config] log=${getLogPath()} retention=${_logRetentionDays()}d`);
    _reseedStats();
};
server.listen(PORT, onListening);

// --- graceful config reload ---
// Watch the directory, not the file: atomic saves detach file watchers.
const _cfgWatchNames = new Set();
if (CONFIG_PATH) {
  _cfgWatchNames.add(path.basename(CONFIG_PATH));
  if (!process.env.CONFIG_PATH) {
    _cfgWatchNames.add(CONFIG_PATH.endsWith('.jsonc') ? 'config.json' : 'config.jsonc');
  }
}
let reloadTimer = null, consoleReloadTimer = null;
function _scheduleConfigReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
// Re-parse before restarting: never boot on a half-written file.
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      // Same parser as boot: a .json file must survive JSON.parse, else the
      // gate approves a change that boot then loads as _cfgBroken (console lockout).
      const parsed = CONFIG_PATH.endsWith('.jsonc') ? parseJsonc(raw) : JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      if (parsed.client_token !== undefined && typeof parsed.client_token !== 'string') throw new Error('client_token must be a string');
      const structural = lib.validateConfigObject(parsed);
      if (structural) throw new Error('structurally invalid: ' + structural);
    } catch (e) {
      elog('─'); elog(`⚠️ [config] change detected but config is not readable/valid (${e.message}) — keeping current process, will retry`);
      reloadTimer = setTimeout(() => { reloadTimer = null; _scheduleConfigReload(); }, 2000).unref();
      return;
    }
    log('─'); log(`🔄 [config] change detected — graceful restart...`);
    _gracefulRestart();
  }, 1000).unref();
}
if (CONFIG_PATH && _cfgWatchNames.size) {
  const dir = path.dirname(path.resolve(CONFIG_PATH));
  try {
    fs.watch(dir, (event, filename) => {
      if (filename && _cfgWatchNames.has(path.basename(String(filename)))) _scheduleConfigReload();
    });
  } catch (e) { elog('─'); elog(`[config] watch failed: ${e.message}`); }
}
// note: console.html hot-reload (no restart needed — page is served from memory)
try {
  const _consoleName = 'console.html';
  fs.watch(__dirname, (event, filename) => {
    if (filename && path.basename(String(filename)) !== _consoleName) return;
    if (consoleReloadTimer) return;
    consoleReloadTimer = setTimeout(() => { consoleReloadTimer = null; _reloadConsoleHtml(); }, 500).unref();
  });
} catch (e) { elog('─'); elog(`[console] watch failed: ${e.message}`); }

// --- graceful restart ---
// Re-entry guard: concurrent restart triggers must not stack.
let _restarting = false, _forceExitTimer = null;
function _forceExit(code, ms) {
  if (_forceExitTimer) return;
  _forceExitTimer = setTimeout(() => {
    // Forced exit still flushes: diagnostics matter most on the stuck path.
    try { _flushLogSync(); } catch {}
    try { _saveKeyStateSync(); } catch {}
    process.exit(code);
  }, ms).unref();
}
function _closeSSEClients() {
  // Console SSE streams are open connections: leaving them alive means
  // server.close() never fires and drain never reaches 0 (restart/shutdown
  // would always end on the force-exit timer, exit code 1). Dashboards
  // auto-reconnect once the gateway is back.
  for (const c of [..._sseClients]) { _sseClients.delete(c); try { c.end(); } catch {} }
}
function _gracefulRestart() {
  if (_restarting) { log('🔄 [config] restart already in progress — ignoring duplicate trigger'); return; }
  _restarting = true;
  // flush synchronously: the debounce window would otherwise be lost on exit,
  // which is exactly the moment the state matters most (config-save restart)
  _saveKeyStateSync();
  _closeSSEClients();
  let exiting = false;
  const exit0 = () => {
    if (exiting) return; exiting = true;
    // Same drain as shutdown(): _flushLogSync alone drops queued async appends.
    Promise.race([_logIoChain.catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
      .then(() => { try { _flushLogSync(); } catch {} try { _saveKeyStateSync(); } catch {} process.exit(0); });
  };
  if (_activeRequests <= 0) { log(`🔄 [config] no active requests — immediate restart`); exit0(); return; }
  log(`🔄 [config] waiting for ${_activeRequests} active request(s)...`);
  server.close(exit0);
  const drain = setInterval(() => {
    if (_activeRequests <= 0) { clearInterval(drain); log(`🔄 [config] drained — restart`); exit0(); }
  }, 1000).unref();
  _forceExit(1, 15000);
}

// --- shutdown handlers ---
function shutdown(signal) {
  if (_restarting) { log(`[config] ${signal} during restart — exiting`); _forceExit(1, 1000); return; }
  _restarting = true;
  _saveKeyStateSync();
// Drain queued appends before exit (bounded); else the last lines are lost.
  const drained = Promise.race([
    _logIoChain.catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  drained.then(() => { try { _flushLogSync(); } catch {} _shutdownContinue(signal); });
}
function _shutdownContinue(signal) {
  _flushLog();
  log('─');
  log(`[config] ${signal} — closing...`);
  _closeSSEClients();
  server.close(() => {
    if (_activeRequests <= 0) { log('[config] done'); try { _saveKeyStateSync(); } catch {} process.exit(0); }
    const drain = setInterval(() => {
      if (_activeRequests <= 0) { clearInterval(drain); log('[config] done'); try { _saveKeyStateSync(); } catch {} process.exit(0); }
    }, 500).unref();
  });
  _forceExit(1, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  _saveKeyStateSync();
  // Same drain as shutdown(): _flushLogSync alone only covers the in-memory
  // buffer, while queued async appends would die with the process.
  Promise.race([
    _logIoChain.catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]).then(() => {
    try { _flushLogSync(); } catch {}
    elog('─'); elog('[config] FATAL:', e.stack); process.exit(1);
  });
});
process.on('unhandledRejection', (r) => { elog('─'); elog('[config] REJECTION:', r instanceof Error ? r.stack : r); });
