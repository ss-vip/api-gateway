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
function elog(...a) { a[0]==='─' ? console.error('─'.repeat(60)) : console.error(`[${_ts()}]`, ...a); }

// note: custom JSONC parser — handles //, /* */, trailing commas. Edge cases in string values (// inside strings) may produce wrong output. No known issues in 6+ months of production. Add json5 dependency if/when this breaks.
function parseJsonc(str) { return lib.parseJsonc(str); }
function _jsonValid(s) { return lib._jsonValid(s); }
function _ndjsonValid(s) { return lib._ndjsonValid(s); }
function _autoFixJson(s) { return lib._autoFixJson(s); }

// --- error log file ---
function _errMsg(body) { return lib._errMsg(body, LOG_BODY_MAX); }
function getLogPath() {
  const ec = cfg.log;
  if (ec?.path) return ec.path;
  return path.join(__dirname, 'log.json');
}
let _logWriteCount = 0, _logCleaning = new Set(), _lastCleanup = 0;
const stats = { success: 0, error: 0, latSum: 0, latN: 0, httpCodes: {} };
const _sseClients = new Set();
let _sseTimer = null;
function _pushSSE(event, data) {
  if (_sseClients.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of _sseClients) {
    try { c.write(msg); } catch { _sseClients.delete(c); }
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
    avg_latency_ms: stats.latN ? Math.round(stats.latSum / stats.latN) : 0,
    error_rate: totalReq ? (stats.error / totalReq * 100).toFixed(1) + '%' : '0%',
    http_codes: { ...stats.httpCodes },
    recent401: [..._recent401.values()].map(e => ({ provider: e.provider, model: e.model, key: logKey(e.key), ts: _ts(e.ts) })),
  };
}
const MAX_LOG_LINES = 10000;
const MAX_CLEANUP_BYTES = 50 * 1024 * 1024;
const IN_FLIGHT_TIMEOUT_MS = 300000; // 5 min — purge stuck in-flight key entries
const FLIGHT_CLEAN_EVERY = 50; // full-scan cleanup every N selectKey calls
const LOG_CLEANUP_EVERY = 200; // trigger cleanup every N log writes
const LOG_CLEANUP_COOLDOWN_MS = 600000; // 10 min — min interval between cleanups
const MEM_CHECK_INTERVAL = 100; // check memory every N requests
const RESEED_MAX_LINES = 5000;
function _cleanupLog(p, cutoffOverride) {
  if (_logCleaning.has(p)) return;
  const ec = cfg.log;
  if (ec?.enabled === false) return;
  if (!fs.existsSync(p)) return;
  _logCleaning.add(p);
  try { if (fs.statSync(p).size > MAX_CLEANUP_BYTES) { elog('─'); elog(`[log] cleanup skip: ${path.basename(p)} > ${MAX_CLEANUP_BYTES/1024/1024}MB`); _logCleaning.delete(p); return; } } catch {}
  const cutoff = cutoffOverride || (Date.now() - (ec?.retention_days || 7) * 86400000);
  const old = p + '.old';
  const tmp = p + '.tmp';
  fs.rename(p, old, (err) => {
    if (err) { _logCleaning.delete(p); return; }
    fs.readFile(old, 'utf8', (_, c) => {
      if (!c) { fs.unlink(old, () => {}); _logCleaning.delete(p); _lastCleanup = Date.now(); return; }
      const kept = c.split('\n').filter(l => l.trim()).filter(l => {
        try { return new Date(JSON.parse(l).ts).getTime() > cutoff; } catch { return false; }
      });
            if (kept.length > 0) {
        fs.writeFile(tmp, kept.join('\n') + '\n', (e2) => {
          if (e2) { elog('─'); elog(`[log] cleanup write: ${e2.message}`); fs.unlink(old, () => {}); fs.unlink(tmp, () => {}); _logCleaning.delete(p); return; }
          fs.rename(tmp, p, (e3) => { if (e3) { elog('─'); elog(`[log] cleanup rename: ${e3.message}`); } fs.unlink(old, () => {}); _logCleaning.delete(p); _lastCleanup = Date.now(); });
        });
      } else {
        fs.unlink(old, () => {});
        _logCleaning.delete(p);
        _lastCleanup = Date.now();
      }
    });
  });
}
function _triggerCleanup() { _cleanupLog(getLogPath()); }
function logEvent({ logId, provider, model, key, status, latency, tokens, body }) {
  const ec = cfg.log;
  if (ec?.enabled === false) return;
  const p = getLogPath();
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
  fs.appendFile(p, JSON.stringify(entry) + '\n', (err) => { if (err) { elog('─'); elog(`[log] write ${p}: ${err.message}`); } });
  if (entry.type === 'error') { stats.error++; if (status) stats.httpCodes[status] = (stats.httpCodes[status] || 0) + 1; }
  else { stats.success++; stats.httpCodes[200] = (stats.httpCodes[200] || 0) + 1; if (latency) { stats.latSum += latency; stats.latN++; } }
  _pushSSE('log', entry);
  _logWriteCount = (_logWriteCount + 1) % 1000000007;
    if (_logWriteCount % LOG_CLEANUP_EVERY === 1 && Date.now() - _lastCleanup > LOG_CLEANUP_COOLDOWN_MS) _triggerCleanup();
}

function _reseedStats() {
  try {
    const _lines = p => { try { const all = fs.readFileSync(p, 'utf8').split('\n'); return all.slice(-RESEED_MAX_LINES).filter(l => l.trim() && !l.trim().startsWith('#')); } catch { return []; } };
    const all = _lines(getLogPath()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
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
    if (fs.existsSync(j)) return j;
    const jc = path.join(d, 'config.jsonc');
    if (fs.existsSync(jc)) return jc;
  }
  return null;
}
const CONFIG_PATH = process.env.CONFIG_PATH || _findConfig();
let cfg = {};
if (CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    cfg = CONFIG_PATH.endsWith('.jsonc') ? parseJsonc(raw) : JSON.parse(raw);
  } catch (e) {
    const fixed = _autoFixJson(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (fixed !== null) {
      elog('─'); elog(`[config] ${path.basename(CONFIG_PATH)} had missing closing brackets — auto-fixed and saved`);
      try { fs.writeFileSync(CONFIG_PATH, fixed); } catch {}
      cfg = parseJsonc(fixed);
    } else {
      elog('─'); elog(`[config] failed to load ${path.basename(CONFIG_PATH)}:`, e.message);
    }
  }
} else {
  elog('─'); elog(`[config] no config.json or config.jsonc found — running with env vars and defaults only`);
}
// --- config schema validation ---
if (cfg && typeof cfg === 'object') {
  const KNOWN_CONFIG_KEYS = new Set([
    '_note', 'client_token', 'timezone', 'port', 'timeout', 'key_cooldown', 'max_key_backoff', 'max_body_size', 'quota_backoff',
    'model_lockout', 'log', 'providers', 'rate_limit', 'tpm_limit', 'model_limits', 'endpoint_fallbacks', 'models', 'models_aliases'
  ]);
  for (const k of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(k)) elog(`⚠️ [config] unknown top-level key: "${k}"`);
  }
}
if (cfg.timezone) process.env.TZ = cfg.timezone;

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
  POLLINATIONS_KEYS:'pollinations', LITEROUTER_KEYS:'literouter', LLM7_KEYS:'llm7', NVIDIA_KEYS:'nvidia', G4F_KEYS:'gpt4free', AGNES_AI_KEYS:'agnes-ai', SEA_LION_KEYS:'sea-lion', KILO_KEYS:'kilo', OPENCODE_KEYS:'opencode', AIHORDE_KEYS:'aihorde', NAVY_KEYS:'navy', OLLAMA_KEYS:'ollama',
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
  aihorde: 'https://oai.aihorde.net',
  navy: 'https://api.navy',
  ollama: 'https://ollama.com',
  orcarouter: 'https://api.orcarouter.ai',
  hermes: 'https://inference-api.nousresearch.com',
  tokenharbor: 'https://tokenharbor.ai',
  cartesia: 'https://api.cartesia.ai', elevenlabs: 'https://api.elevenlabs.io',
  morph: 'https://api.morphllm.com', aihubmix: 'https://aihubmix.com',
};
// Overlay config-defined base URLs (manual providers) — code defaults stay as fallback
for (const [p, m] of Object.entries(provMeta)) {
  if (m.baseUrl && /^https?:\/\//i.test(m.baseUrl)) DIRECT_PROVIDERS[p] = m.baseUrl.replace(/\/+$/, '');
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

// Fields known to cause 4xx for specific providers (strip before forwarding)
const PROVIDER_BANNED_FIELDS = {
  mistral:       new Set(['user','n','logit_bias','top_logprobs']),
  cohere:        new Set(['n','logit_bias','top_logprobs','parallel_tool_calls']),
  huggingface:   new Set(['user']),
  gpt4free:      new Set(['top_p']),
  ollama:        new Set(['tool_choice','logit_bias','user','n']), // docs.ollama.com — unsupported fields
  llm7:          new Set(['response_format','quality','style','output_format']),
  nvidia:        new Set(['parallel_tool_calls']),
};
const PROVIDER_MAX_TOKENS = { groq: 8192 };

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

const _resolveModelImpl = lib.createModelResolver(MODEL_ENTRIES);
function resolveModel(clientModel) { return _resolveModelImpl(clientModel); }
const _resolveEndpointImpl = lib.createEndpointResolver(MODEL_ENTRIES, ENDPOINT_FALLBACKS);
function resolveModelForEndpoint(clientModel, endpointPath) { return _resolveEndpointImpl(clientModel, endpointPath); }

// env overrides config (empty env falls through); 0 is a valid value, unlike `x || default`
const _cfgNum = (envV, cfgV, dflt) => {
  const pick = (v) => { const n = parseInt(v, 10); if (isNaN(n)) { elog('─'); elog(`[config] non-numeric value ${JSON.stringify(v)} — using default ${dflt}`); return dflt; } return n; };
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
const QUOTA_BACKOFF_MS = _cfgNum(process.env.QUOTA_BACKOFF, cfg.quota_backoff, 3600000); // quota/credit exhausted → long key cooldown

// --- key pool ---
const keyPool = new Map();

function initProvider(p) {
  if (!keyPool.has(p)) {
    keyPool.set(p, new Map());
    for (const k of (PROVIDER_KEYS[p] || [])) {
      keyPool.get(p).set(k, { degradedUntil: 0, errorCount: 0, successCount: 0, lastSuccess: 0, lastLatency: 0 });
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
  s.degradedUntil = Date.now() + Math.min(KEY_COOLDOWN_MS * Math.pow(2, s.errorCount), MAX_KEY_BACKOFF);
  s.errorCount++;
}

const QUOTA_RE = lib.QUOTA_RE;
function _isQuotaError(status, body) { return lib._isQuotaError(status, body); }
function markKeyQuotaExhausted(p, key) {
  initProvider(p);
  const st = keyPool.get(p)?.get(key);
  if (!st) return;
  st.degradedUntil = Date.now() + QUOTA_BACKOFF_MS;
  st.errorCount = Math.max(st.errorCount, 8);
    log('─'); log(`⚠️ [quota] ${p} key ${logKey(key)} degraded ${QUOTA_BACKOFF_MS}ms (quota/credit exhausted)`);
}
function _markKeyFailed(p, key, status, body) {
  if (_isQuotaError(status, body)) markKeyQuotaExhausted(p, key);
  else markKeyError(p, key);
}

function markKeySuccess(p, key, latency) {
  const s = keyPool.get(p)?.get(key);
  if (!s) return;
  if (s.errorCount > 0) {
    s.errorCount = Math.max(0, s.errorCount - 1);
    if (s.errorCount === 0) s.degradedUntil = 0;
  }
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
    for (const [k, v] of _recent401) if (Date.now() > v.retryAfter) _recent401.delete(k);
}

const keyInFlight = new Map(); // key -> timestamp
const rrCursor = new Map();
const modelCursor = new Map();
let _flightCleanTick = 0;
const _providerActive = new Map(); // provider → concurrent request count
const PROVIDER_MAX_CONCURRENT = 4;
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

async function selectKey(p) {
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
    let idx = ((rrCursor.get(p) ?? -1) + 1) % free.length;
    rrCursor.set(p, idx);
    const key = free[idx];
    keyInFlight.set(`${p}:${key}`, now);
    await waitRateLimit(p, key);
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

function collectBody(res) {
  return new Promise(r => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => r(Buffer.concat(c).toString()));
    res.on('error', () => r(''));
  });
}

// --- token-based alias routing ---
const PROVIDER_DEFAULT_LIMITS = {};
const USER_MODEL_LIMITS = new Map(Object.entries(cfg.model_limits || {}).map(([k, v]) => [k.toLowerCase(), v]));
const RATE_LIMITS = new Map(Object.entries(cfg.rate_limit || {}).map(([k, v]) => [k, v]));
// note: known provider RPM (account-level), auto-calc per-key interval when not manually set
// note: known free-plan RPM per provider, auto-calc per-key rate_limit = 60000 / (rpm / numKeys)
// Keys are per-account, so each key's limit is independent. Manual rate_limit in config overrides auto-calc.
const PROVIDER_RPM = {
  literouter: 1,        // per-key ~1 RPM (5 keys → ~5 RPM)
  pollinations: 60,     // no published limits
  gpt4free: 60,         // no published limits
  mistral: 30,          // free plan: large=0.07, small=0.83-5, ministral-8b=3.13 RPS. 30 RPM (~0.5 RPS) is a safe middle; very slow models (0.03-0.08 RPS) self-throttle via generation time
  llm7: 40,             // ~40 RPM
  nvidia: 40,           // NIM free: ~40 RPM
  openrouter: 20,       // free models: 20 RPM
  groq: 30,             // free tier: 30 RPM (org-level, per-model)
  cerebras: 5,          // free tier: 5 RPM (gpt-oss-120b), others up to 30
  deepseek: 30,         // conservative; actual: concurrency-based (500/2500)
  'agnes-ai': 20,       // 20 RPM
  navy: 20,             // paid gateway, safe middle
  ollama: 30,           // Ollama Cloud, no published limits — conservative
  'sea-lion': 10,       // 10 RPM per user
  'kilo': 3,            // free :free models 200/hr/IP (~3.3/min); paid models have no gateway limit — raise via config rate_limit if only using paid
  // Providers without published RPM — conservative defaults; tune via config rate_limit if needed
  openai: 60,           // paid tiers high; free tier 3 RPM — conservative middle
  xai: 60,             // grok: decent free RPM, higher paid
  together: 60,         // varies by model, free ~60 RPM
  cohere: 60,          // command-r-plus, reasonable
  perplexity: 20,       // sonar online: ~20 RPM
  huggingface: 30,      // router, varies by model
  replicate: 60,        // prediction API, not strictly RPM-limited
  baseten: 60,         // inference, safe middle
  parallel: 60,         // speed/base, safe middle
  orcarouter: 20,       // OpenAI-compatible router gateway — conservative middle (no published RPM)
  morph: 30,            // YC-backed, conservative
};
// Conservative default for manual (config-defined) providers that have no RPM source, so they are never unthrottled (ban risk)
const DEFAULT_MANUAL_RPM = 10;
for (const [p, keys] of Object.entries(PROVIDER_KEYS)) {
  if (keys.length === 0) continue;
  const manual = provMeta[p] && provMeta[p].baseUrl;
  const rpm = PROVIDER_RPM[p] || (provMeta[p] && provMeta[p].rpm) || (manual ? DEFAULT_MANUAL_RPM : undefined);
  if (rpm && !RATE_LIMITS.has(p)) {
    RATE_LIMITS.set(p, Math.max(100, Math.round(60000 / (rpm / keys.length))));
  }
}
const _keyLastUsed = new Map(); // provider → Map(key → last timestamp)
function _rlMaybeReset() {}
async function waitRateLimit(provider, key) {
  _rlMaybeReset();
  const interval = RATE_LIMITS.get(provider);
  if (!interval) return;
  if (!_keyLastUsed.has(provider)) _keyLastUsed.set(provider, new Map());
  const byProv = _keyLastUsed.get(provider);
  const last = byProv.get(key);
  if (last) { const elapsed = Date.now() - last; if (elapsed < interval) await new Promise(r => setTimeout(r, interval - elapsed)); }
  byProv.set(key, Date.now());
}
function isRateLimited(provider) {
  _rlMaybeReset();
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
const CB_THRESHOLD = 5;
const CB_COOLDOWN_MS = 30000;
function _recordProviderFailure(provider) {
  const entry = _circuitBreaker.get(provider) || { count: 0, openUntil: 0 };
  entry.count++;
  if (entry.count >= CB_THRESHOLD && !entry.openUntil) {
    entry.openUntil = Date.now() + CB_COOLDOWN_MS;
    log('─'); log(`⚠️ [circuit] ${provider} opened (${entry.count}/${CB_THRESHOLD} failures, cooldown ${CB_COOLDOWN_MS}ms)`);
  }
  _circuitBreaker.set(provider, entry);
}
function _recordProviderSuccess(provider) {
  const before = _circuitBreaker.get(provider);
  if (before) { log('─'); log(`✅ [circuit] ${provider} closed (after ${before.count} failures)`); _circuitBreaker.delete(provider); }
}
function _isCircuitOpen(provider) {
  const entry = _circuitBreaker.get(provider);
  if (!entry || !entry.openUntil) return false;
  if (Date.now() >= entry.openUntil) { _circuitBreaker.delete(provider); return false; }
  return true;
}

// --- model lockout (per-provider/model circuit: a broken model ID or saturated free tier) ---
const MODEL_LOCKOUT_THRESHOLD = cfg.model_lockout?.threshold ?? 3;
const MODEL_LOCKOUT_MS = cfg.model_lockout?.cooldown ?? 60000;
const _modelFails = new Map(); // "provider/model" → { count, until }
function _modelKey(provider, model) { return `${provider}/${model}`; }
function _recordModelFailure(provider, model) {
  if (!model) return;
  const k = _modelKey(provider, model);
  const e = _modelFails.get(k) || { count: 0, until: 0 };
  e.count++;
  if (e.count >= MODEL_LOCKOUT_THRESHOLD && !e.until) {
    e.until = Date.now() + MODEL_LOCKOUT_MS;
    log('─'); log(`⚠️ [lockout] ${k} locked (${e.count}/${MODEL_LOCKOUT_THRESHOLD} failures, cooldown ${MODEL_LOCKOUT_MS}ms)`);
  }
  _modelFails.set(k, e);
}
function _recordModelSuccess(provider, model) {
  if (!model) return;
  const k = _modelKey(provider, model);
  const before = _modelFails.get(k);
  if (before) { log('─'); log(`✅ [lockout] ${k} cleared (after ${before.count} failures)`); _modelFails.delete(k); }
}
function _isModelLocked(provider, model) {
  const e = _modelFails.get(_modelKey(provider, model));
  if (!e || !e.until) return false;
  if (Date.now() >= e.until) { _modelFails.delete(_modelKey(provider, model)); return false; }
  return true;
}

const TPM_LIMITS = new Map(Object.entries(cfg.tpm_limit || {}).map(([k, v]) => [k, v]));
const _tpmLog = new Map(); // provider → Map(key → [{ts, tokens}])
function _tpmClean(entries) {
  const cutoff = Date.now() - 60000; let i = 0;
  while (i < entries.length && entries[i].ts < cutoff) i++;
  if (i > 0) entries.splice(0, i);
  if (entries.length > 1000) entries.splice(0, entries.length - 1000);
}
function _tpmSum(entries) { return entries.reduce((s, e) => s + e.tokens, 0); }
async function waitTpmLimit(provider, key, tokens) {
  const limit = TPM_LIMITS.get(provider);
  if (!limit || !tokens) return;
  if (!_tpmLog.has(provider)) _tpmLog.set(provider, new Map());
  const byProv = _tpmLog.get(provider);
  if (!byProv.has(key)) byProv.set(key, []);
  const entries = byProv.get(key);
  _tpmClean(entries);
  let sum = _tpmSum(entries);
  while (sum + tokens > limit) {
    if (!entries.length) break;
    const wait = entries[0].ts + 60000 - Date.now() + 50;
    if (wait <= 0) { _tpmClean(entries); sum = _tpmSum(entries); continue; }
    await new Promise(r => setTimeout(r, wait));
    _tpmClean(entries); sum = _tpmSum(entries);
  }
  entries.push({ ts: Date.now(), tokens });
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

function estimateStrTokens(str) { return lib.estimateStrTokens(str); }
function estimateTokens(messages) { return lib.estimateTokens(messages); }


// --- context sanitization ---
const REASONING_PROVIDERS = new Set(['deepseek', 'opencode', 'nvidia']);
const STRICT_ORDER_PROVIDERS = new Set(['nvidia']);
// non-text (vision) content unsupported — log-verified 400s ("does not support vision input")
const NO_NON_TEXT_TARGETS = new Set(['llm7/codestral-latest', 'llm7/gpt-oss:20b']);

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

async function handleTTS(req, res, bodyJson, logId) {
  const t0 = Date.now();
  log('─');
  const clientModel = bodyJson?.model || '';
  if (!bodyJson || !bodyJson.input) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'input required', type: 'invalid_request' } }));
    return;
  }
  let targets = resolveModelForEndpoint(clientModel, '/v1/audio/speech');
  if (!targets) targets = [{ provider: 'openai', upstreamModel: clientModel || '' }];
  log(`[${logId}] ⚡ ${clientModel}  /v1/audio/speech`);
  const activeTargets = targets.filter(t => PROVIDERS_WITH_KEYS.has(t.provider) && DIRECT_PROVIDERS[t.provider]);
  if (activeTargets.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no keys', type: 'no_keys' } }));
    return;
  }
  let lastErr = null;
  const skippedProviders = new Set();
  let clientGone = false;
  const ac = new AbortController(), sig = ac.signal;
  res.on('close', () => { if (res.writableEnded) return; clientGone = true; if (!sig.aborted) ac.abort(); });
  let retryRound = 0;
  let transientSkipped = false;
  while (!clientGone && Date.now() - t0 < TIMEOUT_MS && (retryRound < 3 || transientSkipped)) {
    if (retryRound > 0) {
      const wait = (transientSkipped && !lastErr) ? 1500 : Math.min(retryRound * 5000, 30000);
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
      const key = await selectKey(provider);
      if (!key) { transientSkipped = true; continue; }
      const base = DIRECT_PROVIDERS[provider];
      const adapter = buildTTSRequest(provider, bodyJson, upstreamModel, base);
      const bodyStr = adapter ? adapter.body : JSON.stringify({ ...bodyJson, model: upstreamModel });
      const ep = adapter ? adapter.path : (DIRECT_PATH_PREFIX[provider] || '/v1') + '/audio/speech';
      const extraHdrs = adapter ? adapter.headers : {};
      const ctype = adapter ? adapter.contentType : 'application/json';
      try {
        addActive(provider);
        const up = await forwardToDirect(key, bodyStr, base, ep, 'application/octet-stream', ctype, extraHdrs, sig);
        const sc = up.statusCode;
        if (sc >= 200 && sc < 300) {
          if (_isCFBase(base)) {
            const raw = await collectBody(up);
            let audio = '';
            try { audio = JSON.parse(raw.toString()).result?.audio || ''; } catch {}
            decActive(provider); releaseKey(provider, key);
            if (!audio) {
              _markKeyFailed(provider, key, 502, raw.toString());
              lastErr = { status: 502, body: raw.toString() };
              skippedProviders.add(provider);
              log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] cf tts bad response ${_safeSlice(raw.toString(), 100)}`);
              continue;
            }
            markKeySuccess(provider, key, Date.now()-t0);
            _recordProviderSuccess(provider);
            _recordModelSuccess(provider, upstreamModel);
            logEvent({ logId, provider, model: upstreamModel, key, latency: (Date.now()-t0)/1000 });
            log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
            res.writeHead(sc, { 'Content-Type': 'audio/wav', 'X-Request-Id': logId, 'X-Provider': provider });
            res.end(Buffer.from(audio, 'base64')); return;
          }
          decActive(provider); releaseKey(provider, key); markKeySuccess(provider, key, Date.now()-t0);
          _recordProviderSuccess(provider);
          _recordModelSuccess(provider, upstreamModel);
          logEvent({ logId, provider, model: upstreamModel, key, latency: (Date.now()-t0)/1000 });
          log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
          res.writeHead(sc, { 'Content-Type': up.headers['content-type'] || 'audio/mpeg', 'X-Request-Id': logId, 'X-Provider': provider });
          up.on('error', () => { try { res.end(); } catch {} });
          up.pipe(res); return;
        }
        decActive(provider); releaseKey(provider, key);
        const fileBody = await collectBody(up);
        _markKeyFailed(provider, key, sc, fileBody);
        lastErr = { status: sc, body: fileBody };
        if (sc >= 500) _recordProviderFailure(provider);
        if (sc !== 429) _recordModelFailure(provider, upstreamModel);
        if (sc === 401) markKey401(provider, key, upstreamModel);
        if (sc !== 429) skippedProviders.add(provider);
      } catch (e) {
        decActive(provider); markKeyError(provider, key); releaseKey(provider, key);
        _recordProviderFailure(provider);
        _recordModelFailure(provider, upstreamModel);
        lastErr = { status: 502, body: e.message };
      }
    }
    if (!lastErr && !transientSkipped) break;
  }
  const errMsg = lastErr ? (typeof lastErr.body === 'string' ? _safeSlice(lastErr.body, 300) : _safeSlice(JSON.stringify(lastErr.body), 300)) : 'no upstream';
  log(`[${logId}] ${_statusIcon(lastErr?.status || 502)} ${lastErr?.status||502} tts failed ${errMsg}`);
  res.writeHead(lastErr?.status||502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `tts failed: ${errMsg}` } }));
}

function patchMultipartField(raw, fieldName, newValue) {
  const needle = Buffer.from(`name="${fieldName}"`);
  const idx = raw.indexOf(needle);
  if (idx === -1) return raw;
  const start = raw.indexOf(Buffer.from('\r\n\r\n'), idx) + 4;
  if (start < 4) return raw;
  const end = raw.indexOf(Buffer.from('\r\n'), start);
  if (end === -1) return raw;
  const oldVal = raw.toString('utf8', start, end);
  if (oldVal === newValue) return raw;
  const out = Buffer.alloc(raw.length - oldVal.length + newValue.length);
  raw.copy(out, 0, 0, start);
  out.write(newValue, start);
  raw.copy(out, start + newValue.length, end);
  return out;
}

function patchMultipartFieldName(raw, oldName, newName) {
  const needle = Buffer.from(`name="${oldName}"`);
  const idx = raw.indexOf(needle);
  if (idx === -1) return raw;
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

async function handleSTT(req, res, rawBody, logId, contentType) {
  const t0 = Date.now();
  log('─');
    let clientModel = '';
  const modelNeedle = Buffer.from('name="model"');
  const mi = rawBody.indexOf(modelNeedle);
  if (mi !== -1) {
    const valStart = rawBody.indexOf(Buffer.from('\r\n\r\n'), mi) + 4;
    const valEnd = rawBody.indexOf(Buffer.from('\r\n'), valStart);
    if (valEnd !== -1) clientModel = rawBody.toString('utf8', valStart, valEnd).trim();
  }
  let targets = resolveModelForEndpoint(clientModel, '/v1/audio/transcriptions');
  if (!targets) targets = [{ provider: 'openai', upstreamModel: clientModel || '' }];
  log(`[${logId}] ⚡ ${clientModel}  /v1/audio/transcriptions`);
  const activeTargets = targets.filter(t => PROVIDERS_WITH_KEYS.has(t.provider) && DIRECT_PROVIDERS[t.provider]);
  if (activeTargets.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no keys', type: 'no_keys' } }));
    return;
  }
  let lastErr = null;
  const skippedProviders = new Set();
  let clientGone = false;
  const ac = new AbortController(), sig = ac.signal;
  res.on('close', () => { if (res.writableEnded) return; clientGone = true; if (!sig.aborted) ac.abort(); });
  let retryRound = 0;
  let transientSkipped = false;
  while (!clientGone && Date.now() - t0 < TIMEOUT_MS && (retryRound < 3 || transientSkipped)) {
    if (retryRound > 0) {
      const wait = (transientSkipped && !lastErr) ? 1500 : Math.min(retryRound * 5000, 30000);
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
      const key = await selectKey(provider);
      if (!key) { transientSkipped = true; continue; }
      const base = DIRECT_PROVIDERS[provider];
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
        ep = (DIRECT_PATH_PREFIX[provider] || '/v1') + '/audio/transcriptions';
      }
      const ctype = cfBase ? undefined : (provider === 'cartesia' || provider === 'elevenlabs' ? (contentType || 'multipart/form-data') : (contentType || 'application/octet-stream'));
      try {
        addActive(provider);
        const up = await forwardToDirect(key, body, base, ep, 'application/json', ctype, extraHdrs, sig);
        const sc = up.statusCode;
        if (sc >= 200 && sc < 300) {
          const raw = await collectBody(up);
          if (cfBase) {
            let text = '';
            try { text = JSON.parse(raw.toString()).result?.text || ''; } catch {}
            decActive(provider); releaseKey(provider, key);
            if (!text) {
              _markKeyFailed(provider, key, 502, raw.toString());
              lastErr = { status: 502, body: raw.toString() };
              skippedProviders.add(provider);
              log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] cf stt bad response ${_safeSlice(raw.toString(), 100)}`);
              continue;
            }
            markKeySuccess(provider, key, Date.now()-t0);
            _recordProviderSuccess(provider);
            _recordModelSuccess(provider, upstreamModel);
            logEvent({ logId, provider, model: upstreamModel, key, latency: (Date.now()-t0)/1000 });
            log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
            res.writeHead(sc, { 'Content-Type': 'application/json', 'X-Request-Id': logId, 'X-Provider': provider });
            res.end(JSON.stringify({ text })); return;
          }
          decActive(provider); releaseKey(provider, key); markKeySuccess(provider, key, Date.now()-t0);
          _recordProviderSuccess(provider);
          _recordModelSuccess(provider, upstreamModel);
          logEvent({ logId, provider, model: upstreamModel, key, latency: (Date.now()-t0)/1000 });
          log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
          res.writeHead(sc, { 'Content-Type': 'application/json', 'X-Request-Id': logId, 'X-Provider': provider });
          res.end(raw); return;
        }
        decActive(provider); releaseKey(provider, key);
        const sttBody = await collectBody(up);
        _markKeyFailed(provider, key, sc, sttBody);
        lastErr = { status: sc, body: sttBody };
        if (sc >= 500) _recordProviderFailure(provider);
        if (sc !== 429) _recordModelFailure(provider, upstreamModel);
        if (sc === 401) markKey401(provider, key, upstreamModel);
        if (sc !== 429) skippedProviders.add(provider);
      } catch (e) {
        decActive(provider); markKeyError(provider, key); releaseKey(provider, key);
        _recordProviderFailure(provider);
        _recordModelFailure(provider, upstreamModel);
        lastErr = { status: 502, body: e.message };
      }
    }
    if (!lastErr && !transientSkipped) break;
  }
  const errMsg = lastErr ? (typeof lastErr.body === 'string' ? _safeSlice(lastErr.body, 300) : _safeSlice(JSON.stringify(lastErr.body), 300)) : 'no upstream';
  log(`[${logId}] ${_statusIcon(lastErr?.status || 502)} ${lastErr?.status||502} stt failed ${errMsg}`);
  res.writeHead(lastErr?.status||502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `stt failed: ${errMsg}` } }));
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

function forwardToDirect(apiKey, bodyStr, baseUrl, endpointPath, accept, contentType, extraHeaders, signal, method) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const joined = baseUrl.replace(/\/+$/, '') + '/' + endpointPath.replace(/^\/+/, '');
    const url = new URL(joined);
    const isHttps = url.protocol === 'https:';
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method || 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': accept || 'application/json',
        ...(extraHeaders || {}),
      },
      timeout: TIMEOUT_MS,
    };
    const mod = isHttps ? https : http;
    const req = mod.request({ ...opts, agent: isHttps ? _httpsAgent : _httpAgent }, resolve);
    req.on('error', (e) => reject(e.name === 'AbortError' ? new Error('aborted') : e));
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    if (signal) signal.addEventListener('abort', () => { req.destroy(); reject(new Error('aborted')); }, { once: true });
    if (bodyStr != null && bodyStr !== '') req.write(bodyStr);
    req.end();
  });
}

// --- payload validation ---
function validateChatBody(body) { return lib.validateChatBody(body); }

async function handleChatCompletion(req, res, bodyJson, logId) {
  const t0 = Date.now();
  log('─');
  const validationErr = validateChatBody(bodyJson);
  if (validationErr) {
    log(`[${logId}] ❌ 400  ${validationErr}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: validationErr, type: 'invalid_request' } }));
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
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `model '${clientModel}' not supported`, type: 'unsupported_model' } }));
    return;
  }
    if (_hasNonTextContent(bodyJson.messages) && targets && 'vision' !== clientModel) {
    const vt = resolveModel('vision');
    if (vt) { log(`[${logId}] ➡️ ${clientModel} → vision  (non-text content detected)`); targets = vt; }
  }

  const est = estimateTokens(bodyJson.messages);
  const maxOut = bodyJson.max_tokens || 4096;
  const totalEst = est + maxOut;
  if (TOKEN_ORDER.length > 0) {
    const clientLimit = getAliasLimit(clientModel);
    if (totalEst > clientLimit) {
      for (const alias of TOKEN_ORDER) {
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
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no keys available', type: 'no_keys' } }));
    return;
  }

  const isStream = bodyJson.stream !== false;
  const pkCount = Object.entries(PROVIDER_KEYS).reduce((s, [, ks]) => s + ks.length, 0);
  log(`[${logId}] ⚡ ${clientModel}  msgs=${bodyJson.messages.length}  stream=${isStream}  keys=${pkCount}`);

  const rotated = rotateTargets(activeTargets, clientModel);
  if (rotated.length) {
    const shown = rotated.length > 1
      ? `[${rotated[0].provider}/${rotated[0].upstreamModel}] > [${rotated[1].provider}/${rotated[1].upstreamModel}]`
      : `[${rotated[0].provider}/${rotated[0].upstreamModel}]`;
    log(`[${logId}] ➡️ fallback chain: ${shown}`);
  }

  const bodyTemplate = { ...bodyJson, stream: isStream };
  delete bodyTemplate.model;

  let lastErr = null, upstreamRes = null, usedProvider = null, usedKey = null;
  const hasNonText = _hasNonTextContent(bodyJson.messages); // image/audio parts present → filter non-vision targets
  const skippedProviders = new Set(); // providers that returned non-429 non-200 this request → skip channel
  let usedModel = null;
  let curProvider = null, curUpstream = null, curKey = null; // active upstream for leak-safe cleanup on client disconnect
  let clientGone = false;
  let retryRound = 0;
  let transientSkipped = false; // a target was skipped for a recoverable reason (concurrency/rate/TPM)
  let sseStarted = false;
  let sseRetryTargets = [];
  const ac = new AbortController();
  const sig = ac.signal;
  res.on('close', () => { if (!res.writableEnded) { clientGone = true; if (!sig.aborted) ac.abort(); } });

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': logId,
    });
    sseStarted = true;
  }

  while (!upstreamRes && !clientGone && Date.now() - t0 < TIMEOUT_MS && (retryRound < 3 || transientSkipped)) {
    if (retryRound > 0) {
      // all targets transiently skipped (concurrency/rate/TPM) and nothing reached an upstream: poll for a free slot before the next round
      const wait = (transientSkipped && !lastErr) ? 1500 : Math.min(retryRound * 5000, 30000);
      log(`[${logId}] 🔄 retry ${retryRound} — wait ${wait}ms${transientSkipped && !lastErr ? ' (all targets transiently skipped, keeping client connection)' : ' for key recovery'}`);
      await sleep(wait);
    }
    retryRound++;
    transientSkipped = false;
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
                 decActive(provider);
                 log(`[${logId}] ❌ 400 [${provider}/${upstreamModel}] ${e.message.substring(4)}`);
                 res.writeHead(400, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ error: { message: e.message.substring(4), type: 'invalid_request' } }));
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
          usedKey = await selectKey(provider);
          if (!usedKey) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] no key available`); logEvent({ logId, provider, model: upstreamModel, key: '-', status: 503, body: 'no healthy key' }); break; }

          try {
            const acceptHdr = isStream ? 'text/event-stream' : 'application/json';
            await waitTpmLimit(provider, usedKey, totalEst);
            if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) {
              log(`[${logId}] ➡️ [${provider}/${upstreamModel}] skip (concurrency ${_providerActive.get(provider)})`);
              releaseKey(provider, usedKey); transientSkipped = true; break;
            }
            addActive(provider);
            const chatPath = (DIRECT_PATH_PREFIX[provider] || '/v1') + '/chat/completions';
            upstreamRes = await forwardToDirect(usedKey, bodyStr, DIRECT_PROVIDERS[provider], chatPath, acceptHdr, 'application/json', undefined, sig);
            usedProvider = provider;
            usedModel = upstreamModel;
            curProvider = provider; curUpstream = upstreamRes; curKey = usedKey;
            const sc = upstreamRes.statusCode;

            if (sc === 429) {
              decActive(provider);
              releaseKey(provider, usedKey);
              const body = await collectBody(upstreamRes);
              _markKeyFailed(provider, usedKey, sc, body);
              log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} attempt=${attempt+1}/${maxAttempts}`);
              logEvent({ logId, provider, model: upstreamModel, key: usedKey, status: sc, body });
              lastErr = { status: sc, body };
              upstreamRes = null;
              continue;
            }

            if (sc >= 400) {
              decActive(provider);
              releaseKey(provider, usedKey);
              const body = await collectBody(upstreamRes);
              _markKeyFailed(provider, usedKey, sc, body);
              log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} ${_safeSlice(body, 100)}`);
              logEvent({ logId, provider, model: upstreamModel, key: usedKey, status: sc, body });
              if (sc >= 500) _recordProviderFailure(provider);
              _recordModelFailure(provider, upstreamModel);
              lastErr = { status: sc, body };
              if (sc !== 429) skippedProviders.add(provider); // upstream/server issue → skip this channel
              if (sc === 401) markKey401(provider, usedKey, upstreamModel);
              upstreamRes = null;
              break;
            }

            releaseKey(provider, usedKey);
            markKeySuccess(provider, usedKey, Date.now()-t0);
            _recordProviderSuccess(provider);
            _recordModelSuccess(provider, upstreamModel);
            logEvent({ logId, provider, model: upstreamModel, key: usedKey, latency: (Date.now()-t0)/1000, tokens: totalEst || 0 });
            log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
            if (isStream) sseRetryTargets = rotated.slice(ti + 1);
            break;

          } catch (e) {
            decActive(provider);
            markKeyError(provider, usedKey);
            releaseKey(provider, usedKey);
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
    if (!upstreamRes && !lastErr && !transientSkipped) { log(`[${logId}] ➡️ all targets skipped (permanent) — no retry`); break; }
  }

  if (!upstreamRes || !usedProvider) {
    const errMsg = lastErr ? (typeof lastErr.body === 'string' ? lastErr.body : JSON.stringify(lastErr.body)) : 'no upstream';
    const errCode = lastErr?.status || 502;
    log(`[${logId}] ${_statusIcon(errCode)} ${errCode} all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
    logEvent({ logId, provider: usedProvider || '-', model: usedModel || clientModel, key: usedKey || '-', status: errCode, body: lastErr?.body || errMsg });
    const clientMsg = _safeSlice(errMsg, 300);
    if (sseStarted) {
      const sseErr = { error: { message: `all failed: ${clientMsg}`, type: 'proxy_error' } };
      try { res.write(`data: ${JSON.stringify(sseErr)}\n\n`); } catch {}
      try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `all failed: ${clientMsg}` } }));
    }
    return;
  }

  if (sseStarted) {
    let sseUpstream = upstreamRes;
    let sseProvider = usedProvider;
    let sseModel = usedModel;
    let committed = false; // any token already forwarded to client → cannot switch upstream transparently
    for (let r = 0; r < 3; r++) {
      if (clientGone) {
        if (curUpstream && !curUpstream.destroyed) curUpstream.destroy();
        if (curProvider) { decActive(curProvider); curProvider = null; }
        break;
      }
      if (!sseUpstream) break; // no stream to pipe (last retry failed)
      const needModelRewrite = sseModel !== clientModel;
      const pipe = needModelRewrite
        ? (c) => { try { res.write(rewriteModelInSse(c, clientModel)); committed = true; } catch {} }
        : (c) => { try { res.write(c); committed = true; } catch {} };
      try {
        let sseDone = false;
        const _sseDec = () => { if (!sseDone) { sseDone = true; decActive(sseProvider); } };
        await new Promise((resolve, reject) => {
          sseUpstream.on('data', pipe);
          sseUpstream.on('end', () => { _sseDec(); resolve(); });
          sseUpstream.on('error', (e) => { _sseDec(); reject(e); });
          const onClose = () => { res.removeListener('close', onClose); if (res.writableEnded) return; if (!sig.aborted) ac.abort(); if (sseUpstream && !sseUpstream.destroyed) sseUpstream.destroy(); _sseDec(); resolve(); };
          res.on('close', onClose);
        });
        break; // stream ended cleanly
      } catch (e) {
        if (committed) {
          // Tokens already sent to client — a transparent upstream switch would duplicate/garble output. End the stream instead.
          log(`[${logId}] ❌ sse failed after tokens sent [${sseProvider}/${sseModel}]: ${e.message} — cannot fallback, ending stream`);
          break;
        }
        if (curKey) {
          markKeyError(sseProvider, curKey);
          _recordProviderFailure(sseProvider);
          _recordModelFailure(sseProvider, sseModel);
          curKey = null;
        }
        log(`[${logId}] ➡️ sse stream error before first token (retry ${r+1}): ${e.message}`);
        if (sseRetryTargets.length === 0) break;
                const t = sseRetryTargets.shift();
        if (skippedProviders.has(t.provider)) continue;
        if (_isModelLocked(t.provider, t.upstreamModel)) continue;
        if (isRateLimited(t.provider)) continue;
        if ((_providerActive.get(t.provider) || 0) >= PROVIDER_MAX_CONCURRENT) continue;
        sseProvider = t.provider;
        sseModel = t.upstreamModel;
        const nk = await selectKey(sseProvider);
        if (!nk) { log(`[${logId}] ➡️ sse retry [${sseProvider}/${sseModel}] no key`); continue; }
        const bodyObj2 = { ...bodyTemplate, model: sseModel };
        const banned2 = PROVIDER_BANNED_FIELDS[sseProvider];
        if (banned2) for (const f of banned2) delete bodyObj2[f];
        if (Array.isArray(bodyObj2.tools)) bodyObj2.tools = bodyObj2.tools.map(t => { const c = { ...t }; delete c.strict; if (c.function) { c.function = { ...c.function }; delete c.function.strict; } return c; });
        if (!supportsReasoningContent(sseProvider, sseModel) && Array.isArray(bodyObj2.messages)) bodyObj2.messages = sanitizeMessages(bodyObj2.messages);
        if (STRICT_ORDER_PROVIDERS.has(sseProvider) && Array.isArray(bodyObj2.messages)) bodyObj2.messages = normalizeMessageOrder(bodyObj2.messages);
        const maxCap2 = PROVIDER_MAX_TOKENS[sseProvider];
        if (maxCap2 && (bodyObj2.max_tokens || 4096) > maxCap2) bodyObj2.max_tokens = maxCap2;
        const b2 = JSON.stringify(bodyObj2);
        try {
          addActive(sseProvider);
          const base = DIRECT_PROVIDERS[sseProvider];
          const ep = (DIRECT_PATH_PREFIX[sseProvider] || '/v1') + '/chat/completions';
          sseUpstream = await forwardToDirect(nk, b2, base, ep, 'text/event-stream', undefined, undefined, sig);
          curProvider = sseProvider; curUpstream = sseUpstream; curKey = nk;
          if (sseUpstream.statusCode >= 200 && sseUpstream.statusCode < 300) {
            log(`[${logId}] ➡️ sse retry → [${sseProvider}/${sseModel}]`);
            releaseKey(sseProvider, nk);
            continue; // go back to pipe the new stream
          }
          decActive(sseProvider);
          releaseKey(sseProvider, nk);
          const sseErrBody = await collectBody(sseUpstream);
          _markKeyFailed(sseProvider, nk, sseUpstream.statusCode, sseErrBody);
          if (sseUpstream.statusCode >= 500) _recordProviderFailure(sseProvider);
          if (sseUpstream.statusCode !== 429) _recordModelFailure(sseProvider, sseModel);
          log(`[${logId}] ➡️ sse retry [${sseProvider}/${sseModel}] ${sseUpstream.statusCode} ${_safeSlice(sseErrBody, 100)}`);
          sseUpstream = null; curKey = null; // don't pipe the error response; try remaining targets
        } catch (e2) { decActive(sseProvider); markKeyError(sseProvider, nk); releaseKey(sseProvider, nk); _recordProviderFailure(sseProvider); _recordModelFailure(sseProvider, sseModel); log(`[${logId}] ➡️ sse retry [${sseProvider}/${sseModel}] ${e2.message}`); }
      }
    }
    try { res.end(); } catch {}
  } else {
    const body = await collectBody(upstreamRes);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Request-Id': logId, 'X-Provider': usedProvider, 'X-Upstream-Model': usedModel,
    });
    res.end(body);
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
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid request body', type: 'invalid_request' } }));
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
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no keys available', type: 'no_keys' } }));
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
      decActive(provider); releaseKey(provider, key); markKeySuccess(provider, key, Date.now()-t0);
      _recordProviderSuccess(provider);
      _recordModelSuccess(provider, upstreamModel);
      logEvent({ logId, provider, model: upstreamModel, key, latency: (Date.now()-t0)/1000, tokens: 0 });
      if (!sig.aborted) ac.abort();
      log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
      const ctype = upstreamRes.headers['content-type'] || 'application/json';
      res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider });
      pipeRes = upstreamRes; upstreamRes.on('error', () => { try { res.end(); } catch {} });
      upstreamRes.pipe(res);
      return 'done';
    }
    decActive(provider); releaseKey(provider, key);
    const body = await collectBody(upstreamRes);
    _markKeyFailed(provider, key, sc, body);
    log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} ${_safeSlice(body, 100)}`);
    logEvent({ logId, provider, model: upstreamModel, key, status: sc, body });
    lastErr = { status: sc, body };
    if (sc >= 500) _recordProviderFailure(provider);
    if (sc !== 429) _recordModelFailure(provider, upstreamModel);
    if (sc === 401) markKey401(provider, key, upstreamModel);
    if (sc !== 429) skippedProviders.add(provider); // upstream/server issue → skip this channel
    return 'retry';
  };

  let retryRound = 0;
  let transientSkipped = false; // a target was skipped for a recoverable reason (concurrency/rate/TPM)
  while (!clientGone && Date.now() - t0 < TIMEOUT_MS && (retryRound < 3 || transientSkipped)) {
    if (retryRound > 0) {
      const wait = (transientSkipped && !lastErr) ? 1500 : Math.min(retryRound * 5000, 30000);
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
      const key = await selectKey(provider);
      if (!key) { log(`[${logId}] ➡️ [${provider}/${upstreamModel}] no key available`); continue; }
      if (lastErr) await sleep(Math.random() * 300);

      if (directBase) {
        const cfImage = _isCFBase(directBase) && endpointPath === '/images/generations' && jsonBody !== false;
        if (cfImage) {
          const cfBody = { prompt: String(bodyJson.prompt || '') };
          if (bodyJson.size) cfBody.size = bodyJson.size;
          const cfEp = _cfRunPath(upstreamModel);
          try {
            addActive(provider);
            const upstreamRes = await forwardToDirect(key, JSON.stringify(cfBody), directBase, cfEp, 'application/json', 'application/json', undefined, sig);
            const sc = upstreamRes.statusCode;
            if (sc >= 200 && sc < 300 && !clientGone) {
              const raw = await collectBody(upstreamRes);
              let img = '';
              try { img = JSON.parse(raw.toString()).result?.image || ''; } catch {}
              if (img) {
                decActive(provider); releaseKey(provider, key); markKeySuccess(provider, key, Date.now()-t0);
                _recordProviderSuccess(provider);
                _recordModelSuccess(provider, upstreamModel);
                logEvent({ logId, provider, model: upstreamModel, key, latency: (Date.now()-t0)/1000 });
                if (!sig.aborted) ac.abort();
                log(`[${logId}] ✅ ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
                res.writeHead(sc, { 'Content-Type': 'application/json', 'X-Request-Id': logId, 'X-Provider': provider });
                res.end(JSON.stringify({ data: [{ b64_json: img }] }));
                return;
              }
              decActive(provider); releaseKey(provider, key);
              _markKeyFailed(provider, key, 502, raw.toString());
              log(`[${logId}] ❌ 502 [${provider}/${upstreamModel}] cf image bad response ${_safeSlice(raw.toString(), 100)}`);
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
        if (jsonBody !== false) {
          const proxyBody = { ...bodyJson, model: upstreamModel };
          const banned = PROVIDER_BANNED_FIELDS[provider];
          if (banned) for (const f of banned) delete proxyBody[f];
          if (Array.isArray(proxyBody.tools)) proxyBody.tools = proxyBody.tools.map(t => { const c = { ...t }; delete c.strict; return c; });
          bodyStr = JSON.stringify(proxyBody);
        } else {
          bodyStr = upstreamModel ? patchMultipartField(bodyJson, 'model', upstreamModel) : bodyJson;
        }
        upstreamContentType = jsonBody !== false ? 'application/json' : (contentType || 'application/octet-stream');
        try {
          addActive(provider);
          const upstreamRes = await forwardToDirect(key, bodyStr, directBase, (DIRECT_PATH_PREFIX[provider] || '/v1') + endpointPath, 'application/json', upstreamContentType, undefined, sig);
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
    if (!lastErr && !transientSkipped) { log(`[${logId}] ➡️ all targets skipped (permanent)`); break; }
  }

  if (!sig.aborted) ac.abort();
  if (!lastErr) { lastErr = { status: 502, body: JSON.stringify({ error: { message: 'no key succeeded' } }) }; logEvent({ logId, provider: '-', model: clientModel, key: '-', status: 502, body: 'no key succeeded' }); }

  const errCode = lastErr?.status || 502;
  log(`[${logId}] ${_statusIcon(errCode)} ${errCode} all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
  logEvent({ logId, provider: '-', model: clientModel, key: '-', status: errCode, body: lastErr?.body });
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `all upstream providers failed`, type: 'proxy_error' } }));
}

async function handleFiles(req, res, rawBody, logId, contentType) {
  const t0 = Date.now();
  const method = (req.method || 'POST').toUpperCase();
  log('─'); log(`[${logId}] ${method} /v1/files${req.url.replace(/^\/v1\/files\/?/i, '') ? '/' + req.url.replace(/^\/v1\/files\/?/i, '') : ''}`);
  if (method === 'POST' && (!rawBody || rawBody.length === 0)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'empty body', type: 'invalid_request' } }));
    return;
  }
  // Pin to upstream file path (extract sub-path like /:id or /:id/content)
  const suffix = req.url.startsWith('/v1/files/') ? req.url.slice(10) : '';
  let targets = resolveModelForEndpoint('', '/v1/files');
  if (!targets) targets = [{ provider: 'openai', upstreamModel: '' }];
  const activeTargets = targets.filter(t => PROVIDERS_WITH_KEYS.has(t.provider) && DIRECT_PROVIDERS[t.provider]);
  if (activeTargets.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no provider available', type: 'no_keys' } }));
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
    const ep = (DIRECT_PATH_PREFIX[provider] || '/v1') + '/files' + (suffix ? '/' + suffix : '');
    try {
      const up = await forwardToDirect(key, method === 'POST' ? rawBody : null, base, ep, 'application/json', method === 'POST' ? contentType : undefined, null, null, method);
        const sc = up.statusCode;
        if (sc >= 200 && sc < 300) {
          decActive(provider); releaseKey(provider, key); markKeySuccess(provider, key, Date.now()-t0);
        _recordProviderSuccess(provider);
        logEvent({ logId, provider, model: upstreamModel || 'files', key, latency: (Date.now()-t0)/1000 });
        log(`[${logId}] ✅ ${sc} [${provider}/files] (${((Date.now()-t0)/1000).toFixed(1)}s)`);
        const ctype = up.headers['content-type'] || 'application/json';
        res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider });
        up.pipe(res); return;
      }
        decActive(provider); releaseKey(provider, key);
        const fileBody = await collectBody(up);
        _markKeyFailed(provider, key, sc, fileBody);
        lastErr = { status: sc, body: fileBody };
      if (sc >= 500) _recordProviderFailure(provider);
      log(`[${logId}] ${_statusIcon(sc)} ${sc} [${provider}/files] ${_safeSlice(lastErr.body, 100)}`);
      logEvent({ logId, provider, model: upstreamModel || 'files', key, status: sc, body: lastErr.body });
      } catch (e) {
        decActive(provider); markKeyError(provider, key); releaseKey(provider, key);
        _recordProviderFailure(provider);
        lastErr = { status: 502, body: e.message };
      }
  }
  const code = lastErr?.status || 502;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(typeof lastErr?.body === 'string' ? lastErr.body : JSON.stringify({ error: { message: 'file operation failed' } }));
}

// --- console management page & API ---
const CONSOLE_HTML = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf-8');

function checkConsoleAuth(req, res) {
  if (!CLIENT_TOKEN) return true;
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== CLIENT_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

function serveConsolePage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
  const readTail = (p) => { try { const lines = fs.readFileSync(p, 'utf-8').split('\n'); return lines.slice(-MAX_LOG_LINES).join('\n'); } catch { return ''; } };
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
    config: cfgOut, config_valid: cfgVal.ok || cfgFixed, config_error: cfgVal.error || null, config_fixed: cfgFixed,
    log: logOut, log_valid: logVal.ok || logFixed, log_error: logVal.error || null, log_fixed: logFixed,
  }));
}

function handleConsoleStatus(req, res, logId) {
  log('─'); log(`[${logId}] /api/console/status`);
  if (!checkConsoleAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(_buildStatusJSON()));
}

function handleConsoleSave(req, res, body, logId) {
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
    fs.writeFileSync(target, body.content, 'utf-8');
    log(`[${logId}] saved ${path.basename(target)}`);
    if (body.file === 'log') { stats.latSum = 0; stats.latN = 0; _reseedStats(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    if (body.file === 'config' && !CONFIG_PATH) {
      setTimeout(() => {
        log('─'); log(`🔄 [config] first config file created — restarting...`);
        _gracefulRestart();
      }, 500).unref();
    }
  } catch (e) {
    log('─'); log(`❌ [${logId}] save error: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
function handleConsoleStream(req, res, logId) {
  log('─'); log(`[${logId}] /api/console/stream`);
  // EventSource cannot set custom headers — accept token via ?token= query param
  const qToken = new URL(req.url, 'http://x').searchParams.get('token');
  if (qToken && (!CLIENT_TOKEN || qToken === CLIENT_TOKEN)) {
    // token from query param is valid, skip header check
  } else if (!checkConsoleAuth(req, res)) { return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  _sseClients.add(res);
  _ensureSSETimer();
  // push initial status
  res.write(`event: status\ndata: ${JSON.stringify(_buildStatusJSON())}\n\n`);
  req.on('close', () => { _sseClients.delete(res); });
}
function handleConsoleRetry401(req, res, body, logId) {
  log('─'); log(`[${logId}] /api/console/retry401`);
  if (!checkConsoleAuth(req, res)) return;
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
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { signal: controller.signal, method: 'GET' });
    clearTimeout(t);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: r.status, latency: 'live' }));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, status: 0, error: e.message }));
  }
}
function _ensureSSETimer() {
  if (_sseTimer) return;
  _sseTimer = setInterval(() => {
    if (_sseClients.size === 0) return;
    _pushSSE('status', _buildStatusJSON());
  }, 3000).unref();
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
    if (MEM_LIMIT_MB > 0 && mem > MEM_LIMIT_MB * 1024 * 1024) { elog('─'); elog(`🚨 [mem] RSS ${(mem/1024/1024).toFixed(0)}MB > ${MEM_LIMIT_MB}MB — exiting`); process.exit(1); }
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
  req.on('close', () => { if (!_reqClosed) { _reqClosed = true; _activeRequests--; } });
  // Body idle timeout — destroy if no data for 30s
  let _bodyTimer = null;
  const _resetBodyTimer = () => { if (_bodyTimer) clearTimeout(_bodyTimer); _bodyTimer = setTimeout(() => { if (!req.destroyed) req.destroy(new Error('request body idle timeout')); }, 30000).unref(); };
  req.on('data', _resetBodyTimer);
  _resetBodyTimer();

  const urlPath = req.url.split('?')[0].replace(/\/\/+/g, '/').replace(/\/+$/, '') || '/';
  const isHealth = urlPath === '/health' || urlPath === '/v1/health';

  // CORS: wildcard for API endpoints, restricted for console management endpoints
  const isConsoleCors = urlPath === '/console' || urlPath.startsWith('/api/console/');
  res.setHeader('Access-Control-Allow-Origin', isConsoleCors ? (req.headers['origin'] || '*') : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const isConsolePath = urlPath === '/console' || urlPath.startsWith('/api/console/');
  const needsAuth = !isConsolePath && !isHealth && urlPath !== '/';
  if (needsAuth && CLIENT_TOKEN) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'auth_error' } }));
      return;
    }
    const token = auth.slice(7);
    const tBuf = Buffer.from(token), cBuf = Buffer.from(CLIENT_TOKEN);
    if (tBuf.length !== cBuf.length || !crypto.timingSafeEqual(tBuf, cBuf)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'auth_error' } }));
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
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `model '${modelId}' not found`, type: 'invalid_request' } }));
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
  // use startsWith because EventSource passes ?token=xxx query param
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
    const chunks = [];
    let bodySize = 0;

    req.on('data', (c) => {
      bodySize += c.length;
      if (bodySize > MAX_BODY_SIZE) {
        req.destroy(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
  if (req.destroyed) return;
  if (_bodyTimer) clearTimeout(_bodyTimer);

      const rawBody = Buffer.concat(chunks);
      let json, rawStr;

      if (isJsonEndpoint(req.url)) {
        const s = rawBody.toString('utf8').trim();
        if (s) { try { json = JSON.parse(s); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid JSON', type: 'invalid_request' } })); return; } }
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
      } else if (req.url.startsWith('/v1/rerank')) {
        handleProxy(req, res, json, logId, '/rerank', true);
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
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'request body too large', type: 'payload_too_large' } }));
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
  Object.keys(PROVIDER_KEYS).forEach(initProvider);
  log('─');
  log(`🚀 [config] started port=${PORT} — direct upstream mode`);
  const summary = Object.entries(PROVIDER_KEYS).map(([p, ks]) => `${p}:${ks.length}`).join(' ');
  log(`[config] keys ${summary}`);
  log(`[config] timeout=${(TIMEOUT_MS/1000).toFixed(0)}s cooldown=${(KEY_COOLDOWN_MS/1000).toFixed(0)}s maxBody=${(MAX_BODY_SIZE/1024/1024).toFixed(1)}MB`);
  const elCfg = cfg.log;
  if (elCfg?.enabled !== false) log(`[config] log=${getLogPath()} retention=${elCfg?.retention_days || 7}d`);
    _reseedStats();
};
server.listen(PORT, onListening);

// --- graceful config reload ---
const watchPaths = [];
if (CONFIG_PATH) {
  watchPaths.push(CONFIG_PATH);
  // Watch both json/jsonc in the same directory as CONFIG_PATH (not env override, both may exist)
  if (!process.env.CONFIG_PATH) {
    const dir = path.dirname(CONFIG_PATH);
    const alt = path.join(dir, CONFIG_PATH.endsWith('.jsonc') ? 'config.json' : 'config.jsonc');
    if (fs.existsSync(alt)) watchPaths.push(alt);
  }
}
let reloadTimer = null;
watchPaths.forEach(wp => {
  fs.watch(wp, (event) => {
    if ((event === 'change' || event === 'rename') && !reloadTimer) {
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        log('─'); log(`🔄 [config] change detected — graceful restart...`);
        _gracefulRestart();
      }, 1000).unref();
    }
  });
});

// --- graceful restart ---
function _gracefulRestart() {
  if (_activeRequests <= 0) { log(`🔄 [config] no active requests — immediate restart`); process.exit(0); }
  log(`🔄 [config] waiting for ${_activeRequests} active request(s)...`);
  server.close(() => process.exit(0));
  const drain = setInterval(() => {
    if (_activeRequests <= 0) { clearInterval(drain); log(`🔄 [config] drained — restart`); process.exit(0); }
  }, 1000).unref();
  setTimeout(() => process.exit(1), 15000).unref();
}

// --- shutdown handlers ---
function shutdown(signal) {
  log('─');
  log(`[config] ${signal} — closing...`);
  server.close(() => {
    if (_activeRequests <= 0) { log('[config] done'); process.exit(0); }
    const drain = setInterval(() => {
      if (_activeRequests <= 0) { clearInterval(drain); log('[config] done'); process.exit(0); }
    }, 500).unref();
  });
  setTimeout(() => { elog('─'); elog(`[config] force exit (${_activeRequests} active)`); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { elog('─'); elog('[config] FATAL:', e.stack); process.exit(1); });
process.on('unhandledRejection', (r) => { elog('─'); elog('[config] REJECTION:', r instanceof Error ? r.stack : r); });
