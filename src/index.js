'use strict';

process.env.TZ = process.env.TZ || 'Asia/Taipei';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- timestamped logger ---
const _ts = () => {
  const n = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
};
function log(...a) { console.log(`[${_ts()}]`, ...a); }
function elog(...a) { console.error(`[${_ts()}]`, ...a); }

// --- JSONC parser (strip comments + trailing commas before JSON.parse) ---
function parseJsonc(str) {
  if (!str) return null;
  // Pass 1: strip // and /* */ comments
  let out = '', inStr = false, lineCom = false, blockCom = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i], n = str[i + 1];
    if (lineCom) { if (c === '\n') lineCom = false; continue; }
    if (blockCom) { if (c === '*' && n === '/') { i++; blockCom = false; } continue; }
    if (inStr) {
      if (esc) { esc = false; out += c; continue; }
      if (c === '\\') { esc = true; out += c; continue; }
      if (c === '"') inStr = false;
      out += c; continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { lineCom = true; i++; continue; }
    if (c === '/' && n === '*') { blockCom = true; i++; continue; }
    out += c;
  }
  // Pass 2: strip trailing commas before ] or } (valid in JSONC editors)
  let clean = '', inStr2 = false, esc2 = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr2) {
      if (esc2) { esc2 = false; clean += c; continue; }
      if (c === '\\') { esc2 = true; clean += c; continue; }
      if (c === '"') inStr2 = false;
      clean += c; continue;
    }
    if (c === '"') { inStr2 = true; clean += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && (out[j] === ' ' || out[j] === '\t' || out[j] === '\n' || out[j] === '\r')) j++;
      if (out[j] === ']' || out[j] === '}') continue;
    }
    clean += c;
  }
  const t = clean.trim();
  return t ? JSON.parse(t) : null;
}

// --- error log file ---
function _errMsg(body) {
  if (!body) return '-';
  const raw = typeof body === 'string' ? body : body.toString();
  if (raw.length > 10000) return raw.replace(/\n/g, ' ').slice(0, 10000);
  const clean = raw.replace(/^\ufeff/, '').trim();
  // Try to extract a clean error message from JSON
  try {
    const p = JSON.parse(clean);
    const r = Array.isArray(p) ? p[0] : p;
    const msg = r?.error?.message || r?.error?.type || r?.message;
    if (msg && typeof msg === 'string') return msg.replace(/\n/g, ' ').slice(0, 500);
  } catch {
    // Raw newlines inside JSON string values make parse fail.
    // Escape literal newlines inside strings, then retry parse.
    try {
      const escaped = clean.replace(/("(?:[^"\\]|\\.)*")/g, s => s.replace(/\n/g, '\\n'));
      const p = JSON.parse(escaped);
      const r = Array.isArray(p) ? p[0] : p;
      const msg = r?.error?.message || r?.error?.type || r?.message;
      if (msg && typeof msg === 'string') return msg.replace(/\n/g, ' ').slice(0, 500);
    } catch {}
  }
  // Fallback: strip newlines, limit length
  return clean.replace(/\n/g, ' ').slice(0, 500);
}
function getErrorLogPath() {
  const ec = cfg.error_log;
  if (ec?.path) return ec.path;
  const j = path.join(__dirname, 'error.json');
  if (fs.existsSync(j)) return j;
  const jc = path.join(__dirname, 'error.jsonc');
  return fs.existsSync(jc) ? jc : j;
}
let _errLogCount = 0, _errCleaning = false;
function errorLog({ logId, provider, model, key, status, body }) {
  const ec = cfg.error_log;
  if (ec?.enabled === false) return;
  const p = getErrorLogPath();
  const msg = _errMsg(body);
  const entry = JSON.stringify({ ts: _ts(), id: logId || '-', provider, model, key: key && key !== '-' ? logKey(key) : '-', status, error: msg });
  fs.appendFile(p, entry + '\n', (err) => { if (err) elog(`[errorLog] write ${p}: ${err.message}`); });
  _errLogCount = (_errLogCount + 1) % 1000000007;
  if (_errLogCount % 50 === 1 && !_errCleaning) {
    _errCleaning = true;
    const days = (ec?.retention_days || 7);
    const cutoff = Date.now() - days * 86400000;
    const old = p + '.old';
    fs.rename(p, old, (err) => {
      if (err) { _errCleaning = false; return; }
      fs.readFile(old, 'utf8', (_, c) => {
        fs.unlink(old, () => {});
        if (!c) { _errCleaning = false; return; }
        const kept = c.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).filter(l => {
          try { return new Date(JSON.parse(l).ts).getTime() > cutoff; } catch { return false; }
        });
        if (kept.length > 0) {
          const header = '# ' + path.basename(p) + ' — auto-generated, each line is JSON';
          kept.unshift(header);
          fs.appendFile(p, kept.join('\n') + '\n', (e2) => { if (e2) elog(`[errorLog] cleanup write: ${e2.message}`); _errCleaning = false; });
        } else {
          _errCleaning = false;
        }
      });
    });
  }
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
    elog(`[config] failed to load ${path.basename(CONFIG_PATH)}:`, e.message);
  }
} else {
  elog(`[config] no config.json or config.jsonc found in ${__dirname} or ${process.cwd()}`);
}
if (cfg.timezone) process.env.TZ = cfg.timezone;

const ACCOUNT_ID   = process.env.ACCOUNT_ID   || cfg.account_id   || '';
const GATEWAY_NAME = process.env.GATEWAY_NAME || cfg.gateway_name || '';
const CF_CONFIGURED = !!(ACCOUNT_ID && GATEWAY_NAME);
if (!CF_CONFIGURED) {
  log('[config] ACCOUNT_ID / GATEWAY_NAME not set — running degraded (chat will 502)');
}

const CLIENT_TOKEN = process.env.CLIENT_TOKEN || cfg.client_token || '';

const PROVIDER_KEYS = Object.fromEntries(
  Object.entries(cfg.providers || {}).filter(([k]) => !k.startsWith('_'))
);

const ENV_MAP = {
  GEMINI_KEYS:'google-ai-studio', MISTRAL_KEYS:'mistral', CEREBRAS_KEYS:'cerebras',
  OPENAI_KEYS:'openai', ANTHROPIC_KEYS:'anthropic', DEEPSEEK_KEYS:'deepseek',
  XAI_KEYS:'xai', GROQ_KEYS:'groq', TOGETHER_KEYS:'together', OPENROUTER_KEYS:'openrouter',
  POLLINATIONS_KEYS:'pollinations', LITEROUTER_KEYS:'literouter', LLM7_KEYS:'llm7', GITHUB_MODELS_KEYS:'github-models', COPILOT_KEYS:'github-models', NVIDIA_KEYS:'nvidia', G4F_KEYS:'gpt4free',
};

// Direct providers bypass Cloudflare AI Gateway (ponytail: add base URL + path prefix when adding new direct provider)
const   DIRECT_PROVIDERS = { mistral: 'https://api.mistral.ai', pollinations: 'https://gen.pollinations.ai', literouter: 'https://api.literouter.com', llm7: 'https://api.llm7.io', 'github-models': 'https://models.github.ai', nvidia: 'https://integrate.api.nvidia.com', gpt4free: 'https://g4f.space' };
const DIRECT_PATH_PREFIX = { 'github-models': '/inference' };

// Fields known to cause 4xx for specific providers (strip before forwarding)
const PROVIDER_BANNED_FIELDS = {
  mistral:       new Set(['user','n','logit_bias','top_logprobs']),
  cohere:        new Set(['n','logit_bias','top_logprobs','parallel_tool_calls']),
  huggingface:   new Set(['user']),
  gpt4free:      new Set(['top_p']),
};
const PROVIDER_MAX_TOKENS = { groq: 8192 };
const NO_TOOLS_TARGETS = new Set();
for (const [ev, p] of Object.entries(ENV_MAP)) {
  const v = process.env[ev];
  if (v) PROVIDER_KEYS[p] = v.split(',').map(s => s.trim()).filter(Boolean);
}

const MODELS = cfg.models || {};
const MODEL_ENTRIES = Object.entries(MODELS).sort((a, b) => b[0].length - a[0].length);
const PROVIDERS_WITH_KEYS = new Set(
  Object.entries(PROVIDER_KEYS).filter(([, ks]) => ks.length > 0).map(([p]) => p)
);

function resolveModel(clientModel) {
  const m = (clientModel || '').toLowerCase();
  for (const [key, value] of MODEL_ENTRIES) {
    const kl = key.toLowerCase();
    if (m === kl || m.startsWith(kl + '/')) {
      if (typeof value === 'string') {
        return [{ provider: value, upstreamModel: clientModel }];
      }
      if (Array.isArray(value) && value.length > 0) {
        return value.map(t => ({ provider: t.provider, upstreamModel: t.model || clientModel }));
      }
    }
  }
  return null;
}

const PORT             = parseInt(process.env.PORT      || cfg.port            || '3000', 10);
const TIMEOUT_MS       = parseInt(process.env.TIMEOUT   || cfg.timeout         || '600000', 10);
const KEY_COOLDOWN_MS  = parseInt(process.env.KEY_COOLDOWN  || cfg.key_cooldown  || '30000', 10);
const MAX_KEY_BACKOFF  = parseInt(process.env.MAX_KEY_BACKOFF || cfg.max_key_backoff || '300000', 10);
const MAX_BODY_SIZE    = parseInt(process.env.MAX_BODY_SIZE || cfg.max_body_size || (10 * 1024 * 1024), 10); // 10MB
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || cfg.log_retention_days || '0', 10);
const CF_API_TOKEN = process.env.CF_API_TOKEN || cfg.cf_api_token || '';

// --- key pool ---
const keyPool = new Map();

function initProvider(p) {
  if (!keyPool.has(p)) {
    keyPool.set(p, new Map());
    for (const k of (PROVIDER_KEYS[p] || [])) {
      keyPool.get(p).set(k, { degradedUntil: 0, errorCount: 0, successCount: 0 });
    }
  }
}

function getHealthyKeys(p) {
  initProvider(p);
  const now = Date.now();
  return [...keyPool.get(p).entries()]
    .filter(([, s]) => {
      if (now < s.degradedUntil) return false;
      if (s.degradedUntil > 0 && now >= s.degradedUntil) { s.degradedUntil = 0; s.errorCount = 0; }
      return true;
    })
    .map(([k]) => k);
}

function markKeyError(p, key) {
  initProvider(p);
  const s = keyPool.get(p)?.get(key);
  if (!s) return;
  s.degradedUntil = Date.now() + Math.min(KEY_COOLDOWN_MS * Math.pow(2, s.errorCount), MAX_KEY_BACKOFF);
  s.errorCount++;
}

function markKeySuccess(p, key) {
  const s = keyPool.get(p)?.get(key);
  if (!s) return;
  if (s.errorCount > 0) {
    s.errorCount = Math.max(0, s.errorCount - 1);
    if (s.errorCount === 0) s.degradedUntil = 0;
  }
  s.successCount++;
}

const keyInFlight = new Map(); // key -> timestamp
const rrCursor = new Map();
const modelCursor = new Map();
let _flightCleanTick = 0;
const _providerActive = new Map(); // provider → concurrent request count
const PROVIDER_MAX_CONCURRENT = 1;
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

async function selectKey(p, needRateLimit) {
  const healthy = getHealthyKeys(p);
  if (healthy.length === 0) return null;
  const now = Date.now();
  // Periodic full-scan cleanup (every 50 calls) for orphaned entries
  _flightCleanTick = (_flightCleanTick + 1) % 50;
  if (_flightCleanTick === 0) for (const [k, ts] of keyInFlight) if (now - ts > 300000) keyInFlight.delete(k);
  // Lazy cleanup: purge stale entries when encountered in healthy list
  const free = healthy.filter(k => {
    const v = keyInFlight.get(`${p}:${k}`);
    if (!v) return true;
    if (now - v > 300000) { keyInFlight.delete(`${p}:${k}`); return true; }
    return false;
  });
  if (free.length > 0) {
    let idx = ((rrCursor.get(p) ?? -1) + 1) % free.length;
    rrCursor.set(p, idx);
    const key = free[idx];
    if (needRateLimit) await waitRateLimit(p, key);
    keyInFlight.set(`${p}:${key}`, now);
    return key;
  }
  // All keys in-flight — return null instead of double-booking a key
  return null;
}

function releaseKey(p, key) {
  if (p && key) keyInFlight.delete(`${p}:${key}`);
}

// --- low-level helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const logKey = (k) => k ? `...${k.slice(-4)}` : '-';

let _ridSeq = 0;
function rid() {
  return Date.now().toString(36) + (++_ridSeq).toString(36) + Math.random().toString(36).slice(2, 4);
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (n, u) => n > 0 ? `${n}${u}` : '';
  return [p(d, 'd'), p(h, 'h'), p(m, 'm'), p(s, 's')].filter(Boolean).join(' ') || '0s';
}

function rewriteModelInSse(chunk, toModel) {
  if (!toModel) return chunk;
  const s = chunk.toString();
  if (/^\s*data:\s*\{[^}]*"error"\s*:/.test(s)) return s;
  return s.replace(/"model"\s*:\s*"[^"]+"/g, `"model":"${toModel}"`);
}

function collectBody(res) {
  return new Promise(r => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => r(Buffer.concat(c).toString()));
    res.on('error', () => r(''));
  });
}

// --- token-based alias routing ---
const PROVIDER_DEFAULT_LIMITS = { 'github-models': 8000 };
const USER_MODEL_LIMITS = new Map(Object.entries(cfg.model_limits || {}).map(([k, v]) => [k.toLowerCase(), v]));
const RATE_LIMITS = new Map(Object.entries(cfg.rate_limit || {}).map(([k, v]) => [k, v]));
// ponytail: known provider RPM (account-level), auto-calc per-key interval when not manually set
// ponytail: known free-plan RPM per provider, auto-calc per-key rate_limit = 60000 / (rpm / numKeys)
// Manual rate_limit in config overrides auto-calculation. Missing providers = no auto-limit (set manually if needed).
const PROVIDER_RPM = {
  'github-models': 15,  // 10–15 RPM
  literouter: 1,        // per-key ~1 RPM (5 keys → ~5 RPM)
  pollinations: 60,     // no published limits
  gpt4free: 60,         // no published limits
  mistral: 60,          // free plan: 1 RPS (~60 RPM), covers ≥1 RPS models; slower models (0.03-0.83 RPS) have long gen time, naturally self-throttle
  llm7: 40,             // ~40 RPM
  nvidia: 40,           // NIM free: ~40 RPM
  openrouter: 20,       // free models: 20 RPM
  groq: 30,             // free tier: 30 RPM (org-level, per-model)
  cerebras: 5,          // free tier: 5 RPM (gpt-oss-120b), others up to 30
  deepseek: 30,         // conservative; actual: concurrency-based (500/2500)
  'google-ai-studio': 10, // free: 10 RPM (Flash), 15 RPM (Flash-Lite)
  'workers-ai': 30,     // 10K neurons/day — soft limit
};
for (const [p, keys] of Object.entries(PROVIDER_KEYS)) {
  const rpm = PROVIDER_RPM[p];
  if (rpm && keys.length > 0 && !RATE_LIMITS.has(p)) {
    RATE_LIMITS.set(p, Math.max(100, Math.round(60000 / (rpm / keys.length))));
  }
}
const _keyLastUsed = new Map(); // provider → Map(key → last timestamp)
let _rlDate = new Date().toDateString();
async function waitRateLimit(provider, key) {
  const now = new Date().toDateString();
  if (now !== _rlDate) { _rlDate = now; _keyLastUsed.clear(); }
  const interval = RATE_LIMITS.get(provider);
  if (!interval) return;
  if (!_keyLastUsed.has(provider)) _keyLastUsed.set(provider, new Map());
  const byProv = _keyLastUsed.get(provider);
  const last = byProv.get(key);
  if (last) { const elapsed = Date.now() - last; if (elapsed < interval) await new Promise(r => setTimeout(r, interval - elapsed)); }
  byProv.set(key, Date.now());
}
function isRateLimited(provider) {
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
const TPM_LIMITS = new Map(Object.entries(cfg.tpm_limit || {}).map(([k, v]) => [k, v]));
const _tpmLog = new Map(); // provider → [{ts, tokens}]
function _tpmClean(entries) { const cutoff = Date.now() - 60000; let i = 0, removed = 0; while (i < entries.length && entries[i].ts < cutoff) { removed += entries[i].tokens; i++; } if (i > 0) entries.splice(0, i); if (entries.length > 1000) { const excess = entries.length - 1000; for (let j = 0; j < excess; j++) removed += entries[j].tokens; entries.splice(0, excess); } return removed; }
async function waitTpmLimit(provider, tokens) {
  const limit = TPM_LIMITS.get(provider);
  if (!limit || !tokens) return;
  if (!_tpmLog.has(provider)) _tpmLog.set(provider, []);
  const entries = _tpmLog.get(provider);
  let sum = entries.reduce((s, e) => s + e.tokens, 0);
  sum -= _tpmClean(entries);
  while (sum + tokens > limit) {
    if (!entries.length) break;
    const wait = entries[0].ts + 60000 - Date.now() + 50;
    if (wait <= 0) { sum -= _tpmClean(entries); continue; }
    await new Promise(r => setTimeout(r, wait));
    sum -= _tpmClean(entries);
  }
  entries.push({ ts: Date.now(), tokens });
}
function getAliasLimit(alias) {
  const t = resolveModel(alias)?.[0];
  if (!t) return 999999;
  const aliasProv = ({ 'google-ai-studio': 'google', 'workers-ai': 'cloudflare-workers-ai' })[t.provider] || t.provider;
  const key = `${aliasProv}/${t.model || alias}`.toLowerCase();
  return USER_MODEL_LIMITS.get(key) || PROVIDER_DEFAULT_LIMITS[t.provider] || 999999;
}
let TOKEN_ORDER = [];
function rebuildTokenOrder() {
  const aliases = Object.keys(cfg.models || {});
  TOKEN_ORDER = aliases.map(a => [a, getAliasLimit(a)]).sort((a, b) => a[1] - b[1]).map(([a]) => a);
}
rebuildTokenOrder();

function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0, images = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (c && typeof c === 'object') {
      const parts = Array.isArray(c) ? c : [c];
      for (const p of parts) {
        if (p.text) chars += p.text.length;
        if (p.type === 'image_url') images++;
      }
    }
  }
  return Math.ceil(chars / 3 * 1.2) + images * 1000;
}


// --- context sanitization ---
const REASONING_PROVIDERS = new Set(['deepseek']);

function supportsReasoningContent(provider, model) {
  if (REASONING_PROVIDERS.has(provider)) {
    const m = (model || '').toLowerCase();
    return m.includes('reasoner') || m.includes('r1');
  }
  return false;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (msg && typeof msg === 'object' && msg.role === 'assistant') {
      const clean = { ...msg };
      delete clean.reasoning_content;
      delete clean.reasoning;
      return clean;
    }
    return msg;
  });
}

// CF AI Gateway Issue #547: Gemini translation layer rejects assistant messages
// with content:null + tool_calls in multi-turn conversations. Normalize to "".
function normalizeContent(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (msg && typeof msg === 'object' && msg.content === null && Array.isArray(msg.tool_calls)) {
      return { ...msg, content: '' };
    }
    return msg;
  });
}

// --- gateway proxy ---

function forwardToGateway(apiKey, bodyStr, routePath, accept, contentType, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const opts = {
      hostname: 'gateway.ai.cloudflare.com',
      port: 443,
      path: `/v1/${ACCOUNT_ID}/${GATEWAY_NAME}${routePath}`,
      method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': accept || 'application/json',
      },
      timeout: TIMEOUT_MS,
    };
    const req = https.request(opts, resolve);
    req.on('error', (e) => reject(e.name === 'AbortError' ? new Error('aborted') : e));
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    if (signal) signal.addEventListener('abort', () => { req.destroy(); reject(new Error('aborted')); }, { once: true });
    req.write(bodyStr);
    req.end();
  });
}

function forwardToDirect(apiKey, bodyStr, baseUrl, endpointPath, accept, contentType, extraHeaders, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const joined = baseUrl.replace(/\/+$/, '') + '/' + endpointPath.replace(/^\/+/, '');
    const url = new URL(joined);
    const isHttps = url.protocol === 'https:';
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': accept || 'application/json',
        ...(extraHeaders || {}),
      },
      timeout: TIMEOUT_MS,
    };
    const mod = isHttps ? https : http;
    const req = mod.request(opts, resolve);
    req.on('error', (e) => reject(e.name === 'AbortError' ? new Error('aborted') : e));
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    if (signal) signal.addEventListener('abort', () => { req.destroy(); reject(new Error('aborted')); }, { once: true });
    req.write(bodyStr);
    req.end();
  });
}

// --- log cleanup ---
let lastLogCleanup = 0;
let cleanupAuthFailed = false;

function cleanupOldLogs() {
  if (LOG_RETENTION_DAYS <= 0 || !CF_API_TOKEN || !CF_CONFIGURED) return;
  const now = Date.now();
  if (now - lastLogCleanup < 3600000) return;
  const cutoff = new Date(now - LOG_RETENTION_DAYS * 86400000).toISOString();
  const filter = JSON.stringify([{ key: 'created_at', operator: 'lt', value: cutoff }]);
  const req = https.request({
    hostname: 'api.cloudflare.com',
    path: `/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_NAME}/logs?filters=${encodeURIComponent(filter)}`,
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      if (ok) { lastLogCleanup = now; return; }
      if (res.statusCode === 401) {
        if (!cleanupAuthFailed) {
          cleanupAuthFailed = true;
          elog(`[cleanup] 401 — cf_api_token missing AI Gateway Edit permission, disable log_retention_days or fix token`);
        }
        return;
      }
      elog(`[cleanup] ${res.statusCode} ${body.slice(0, 200)}`);
    });
  });
  req.on('error', (e) => elog(`[cleanup] ${e.message}`));
  req.on('timeout', () => { req.destroy(); elog(`[cleanup] request timed out`); });
  req.end();
}

// --- payload validation ---
function validateChatBody(body) {
  if (!body || typeof body !== 'object') return 'invalid request body';
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) return 'messages must be a non-empty array';
  if (!body.model || typeof body.model !== 'string') return 'model is required';
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!msg || typeof msg !== 'object') return `messages[${i}] must be an object`;
    if (typeof msg.role !== 'string' || !msg.role) return `messages[${i}].role is required`;
    if (msg.role === 'assistant') {
      if ((msg.content === undefined || msg.content === null) && (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0))
        return `messages[${i}].content or tool_calls required for assistant`;
    } else if (msg.role === 'tool') {
      if (!msg.tool_call_id) return `messages[${i}].tool_call_id required`;
      if (msg.content === undefined || msg.content === null) return `messages[${i}].content is required for tool message`;
    } else {
      if (msg.content === undefined || msg.content === null) return `messages[${i}].content is required`;
    }
  }
  return null;
}

async function handleChatCompletion(req, res, bodyJson, logId) {
  const t0 = Date.now();
  const validationErr = validateChatBody(bodyJson);
  if (validationErr) {
    log(`[${logId}] ← 400  ${validationErr}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: validationErr, type: 'invalid_request' } }));
    return;
  }

  const clientModel = bodyJson.model || 'unknown';
  let targets = resolveModel(clientModel);
  if (!targets) {
    log(`[${logId}] ← 400  unsupported model: ${clientModel}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `model '${clientModel}' not supported`, type: 'unsupported_model' } }));
    return;
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
          log(`[${logId}] ◆ ${clientModel} → ${alias}  (prompt=${est}, max_out=${maxOut}, total=${totalEst}, ctx=${limit})`);
          targets = newTargets;
        }
        break;
      }
    }
  }

  let activeTargets = targets.filter(t => {
    if (!PROVIDERS_WITH_KEYS.has(t.provider)) return false;
    if (!CF_CONFIGURED && !DIRECT_PROVIDERS[t.provider]) return false;
    return true;
  });
  if (activeTargets.length === 0) {
    log(`[${logId}] ← 400  no keys for ${clientModel}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no keys available for model '${clientModel}'`, type: 'no_keys' } }));
    return;
  }

  const isStream = bodyJson.stream === true;
  const pkCount = Object.entries(PROVIDER_KEYS).reduce((s, [, ks]) => s + ks.length, 0);
  log(`[${logId}] → ${clientModel}  msgs=${bodyJson.messages.length}  stream=${isStream}  keys=${pkCount}`);

  const rotated = rotateTargets(activeTargets, clientModel);
  if (rotated.length > 1) {
    log(`[${logId}] ◆ fallback chain: ${rotated.map(t => `[${t.provider}/${t.upstreamModel}]`).join(' > ')}`);
  }

  const bodyTemplate = { ...bodyJson, stream: isStream };
  delete bodyTemplate.model;

  let lastErr = null, upstreamRes = null, usedProvider = null, usedKey = null;
  let usedModel = null;
  let clientGone = false;
  let retryRound = 0;
  let sseStarted = false;
  let sseRetryTargets = [];
  const ac = new AbortController();
  const sig = ac.signal;
  req.on('close', () => { clientGone = true; });

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': logId,
    });
    sseStarted = true;
  }

  while (!upstreamRes && !clientGone && Date.now() - t0 < TIMEOUT_MS && retryRound < 3) {
    if (retryRound > 0) {
      const wait = Math.min(retryRound * 5000, 30000);
      log(`[${logId}] ◆ retry ${retryRound} — wait ${wait}ms for key recovery`);
      await sleep(wait);
    }
    retryRound++;
    for (let ti = 0; ti < rotated.length; ti++) {
      const target = rotated[ti];
      if (upstreamRes) break;
      try {
        const provider = target.provider;
        const upstreamModel = target.upstreamModel;
        const maxAttempts = Math.max(1, (PROVIDER_KEYS[provider] || []).length);

        if (lastErr) await sleep(Math.random() * 300);

        // ponytail: skip targets whose context can't fit the request
        const targetLimitKey = `${provider}/${upstreamModel}`.toLowerCase();
        const targetCtx = USER_MODEL_LIMITS.get(targetLimitKey) || PROVIDER_DEFAULT_LIMITS[provider] || 999999;
        if (totalEst > targetCtx) {
          log(`[${logId}] → [${provider}/${upstreamModel}] skip (${totalEst} > ${targetCtx})`);
          continue;
        }
        if (Array.isArray(bodyTemplate.tools) && NO_TOOLS_TARGETS.has(targetLimitKey)) {
          log(`[${logId}] → [${provider}/${upstreamModel}] skip (tools not supported)`);
          continue;
        }
        const tpmLimit = TPM_LIMITS.get(provider);
        if (tpmLimit && totalEst > tpmLimit) {
          log(`[${logId}] → [${provider}/${upstreamModel}] skip (total=${totalEst} > TPM=${tpmLimit})`);
          continue;
        }
        if (isRateLimited(provider)) {
          log(`[${logId}] → [${provider}/${upstreamModel}] skip (rate limited)`);
          continue;
        }
        if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) {
          log(`[${logId}] → [${provider}/${upstreamModel}] skip (concurrency ${_providerActive.get(provider)})`);
          continue;
        }

        const isDirect = DIRECT_PROVIDERS[provider];
        const bodyObj = { ...bodyTemplate, model: isDirect ? upstreamModel : `${provider}/${upstreamModel}` };
        const maxCap = PROVIDER_MAX_TOKENS[provider];
        if (maxCap && (bodyObj.max_tokens || 4096) > maxCap) bodyObj.max_tokens = maxCap;
        const banned = PROVIDER_BANNED_FIELDS[provider];
        if (banned) for (const f of banned) delete bodyObj[f];
        if (Array.isArray(bodyObj.tools)) bodyObj.tools = bodyObj.tools.map(t => { const c = { ...t }; delete c.strict; if (c.function) { c.function = { ...c.function }; delete c.function.strict; } return c; });
        if (Array.isArray(bodyObj.messages)) {
          if (!supportsReasoningContent(provider, upstreamModel)) {
            bodyObj.messages = sanitizeMessages(bodyObj.messages);
          }
          if (provider === 'google-ai-studio') {
            bodyObj.messages = normalizeContent(bodyObj.messages);
          }
        }
        const bodyStr = JSON.stringify(bodyObj);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (upstreamRes) break;
          if (attempt > 0) await sleep(Math.random() * 300);
          usedKey = await selectKey(provider, isDirect);
          if (!usedKey) { log(`[${logId}] → [${provider}/${upstreamModel}] no key available`); errorLog({ logId, provider, model: upstreamModel, key: '-', status: 503, body: 'no healthy key' }); break; }

          try {
            const acceptHdr = isStream ? 'text/event-stream' : 'application/json';
            const ghHdrs = provider === 'github-models' ? { 'X-GitHub-Api-Version': '2026-03-10' } : undefined;
            await waitTpmLimit(provider, totalEst);
            if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) {
              log(`[${logId}] → [${provider}/${upstreamModel}] skip (concurrency ${_providerActive.get(provider)})`);
              releaseKey(provider, usedKey); break;
            }
            addActive(provider);
            upstreamRes = isDirect ? await forwardToDirect(usedKey, bodyStr, DIRECT_PROVIDERS[provider], (DIRECT_PATH_PREFIX[provider] || '/v1') + '/chat/completions', acceptHdr, 'application/json', ghHdrs, sig) : await forwardToGateway(usedKey, bodyStr, '/compat/chat/completions', acceptHdr, 'application/json', sig);
            usedProvider = provider;
            usedModel = upstreamModel;
            const sc = upstreamRes.statusCode;

            if (sc === 429 || sc >= 500) {
              decActive(provider);
              markKeyError(provider, usedKey);
              releaseKey(provider, usedKey);
              const body = await collectBody(upstreamRes);
              log(`[${logId}] ← ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} attempt=${attempt+1}/${maxAttempts}`);
              errorLog({ logId, provider, model: upstreamModel, key: usedKey, status: sc, body });
              lastErr = { status: sc, body };
              upstreamRes = null;
              continue;
            }

            if (sc >= 400) {
              decActive(provider);
              markKeyError(provider, usedKey);
              releaseKey(provider, usedKey);
              const body = await collectBody(upstreamRes);
              log(`[${logId}] ← ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)} ${body.slice(0, 100)}`);
              errorLog({ logId, provider, model: upstreamModel, key: usedKey, status: sc, body });
              lastErr = { status: sc, body };
              upstreamRes = null;
              continue;
            }

            releaseKey(provider, usedKey);
            markKeySuccess(provider, usedKey);
            log(`[${logId}] ← ${sc} [${provider}/${upstreamModel}] key=${logKey(usedKey)}`);
            if (isStream) sseRetryTargets = rotated.slice(ti + 1);
            break;

          } catch (e) {
            decActive(provider);
            markKeyError(provider, usedKey);
            releaseKey(provider, usedKey);
            log(`[${logId}] ← 502 [${provider}/${upstreamModel}] key=${logKey(usedKey)} attempt=${attempt+1}/${maxAttempts} ${e.message}`);
            errorLog({ logId, provider, model: upstreamModel, key: usedKey, status: 502, body: e.message });
            lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
            upstreamRes = null;
          }
        }
      } catch (e) { log(`[${logId}] ← 502 [${target?.provider}/${target?.upstreamModel}] fatal ${e.message}`); errorLog({ logId, provider: target?.provider || '?', model: target?.upstreamModel || '?', key: '-', status: 502, body: e.message }); }
    }
    if (!upstreamRes && !lastErr) { log(`[${logId}] ◆ all targets skipped — no retry`); break; }
  }

  if (!upstreamRes || !usedProvider) {
    const errMsg = lastErr ? (typeof lastErr.body === 'string' ? lastErr.body.slice(0, 300) : JSON.stringify(lastErr.body).slice(0, 300)) : 'no upstream';
    const errCode = lastErr?.status || 502;
    log(`[${logId}] ← ${errCode} all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
    errorLog({ logId, provider: usedProvider || '-', model: usedModel || clientModel, key: usedKey || '-', status: errCode, body: errMsg });
    if (sseStarted) {
      const sseErr = { error: { message: `all failed: ${errMsg}`, type: 'proxy_error' } };
      try { res.write(`data: ${JSON.stringify(sseErr)}\n\n`); } catch {}
      try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `all failed: ${errMsg}` } }));
    }
    return;
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  log(`[${logId}] ← 200 ${dur}s [${usedProvider}/${usedModel}]`);

  if (sseStarted) {
    let sseUpstream = upstreamRes;
    let sseProvider = usedProvider;
    let sseModel = usedModel;
    for (let r = 0; r < 3; r++) {
      if (clientGone) break;
      const needModelRewrite = sseModel !== clientModel;
      const pipe = needModelRewrite
        ? (c) => { try { res.write(rewriteModelInSse(c, clientModel)); } catch {} }
        : (c) => { try { res.write(c); } catch {} };
      try {
        await new Promise((resolve, reject) => {
          sseUpstream.on('data', pipe);
          sseUpstream.on('end', () => { decActive(sseProvider); resolve(); });
          sseUpstream.on('error', (e) => { decActive(sseProvider); reject(e); });
          const onClose = () => { req.removeListener('close', onClose); if (!sig.aborted) ac.abort(); if (sseUpstream && !sseUpstream.destroyed) sseUpstream.destroy(); decActive(sseProvider); resolve(); };
          req.on('close', onClose);
        });
        break; // stream ended cleanly
      } catch (e) {
        log(`[${logId}] ◆ sse stream error (retry ${r+1}): ${e.message}`);
        if (sseRetryTargets.length === 0) break;
        // Try next target
        const t = sseRetryTargets.shift();
        sseProvider = t.provider;
        sseModel = t.upstreamModel;
        const nk = await selectKey(sseProvider, !!DIRECT_PROVIDERS[sseProvider]);
        if (!nk) { log(`[${logId}] ◆ sse retry [${sseProvider}/${sseModel}] no key`); continue; }
        const bodyObj2 = { ...bodyTemplate, model: DIRECT_PROVIDERS[sseProvider] ? sseModel : `${sseProvider}/${sseModel}` };
        const banned2 = PROVIDER_BANNED_FIELDS[sseProvider];
        if (banned2) for (const f of banned2) delete bodyObj2[f];
        if (Array.isArray(bodyObj2.tools)) bodyObj2.tools = bodyObj2.tools.map(t => { const c = { ...t }; delete c.strict; if (c.function) { c.function = { ...c.function }; delete c.function.strict; } return c; });
        const maxCap2 = PROVIDER_MAX_TOKENS[sseProvider];
        if (maxCap2 && (bodyObj2.max_tokens || 4096) > maxCap2) bodyObj2.max_tokens = maxCap2;
        const b2 = JSON.stringify(bodyObj2);
        try {
          addActive(sseProvider);
          const base = DIRECT_PROVIDERS[sseProvider];
          const ep = (DIRECT_PATH_PREFIX[sseProvider] || '/v1') + '/chat/completions';
          sseUpstream = await (base ? forwardToDirect(nk, b2, base, ep, 'text/event-stream', undefined, undefined, sig) : forwardToGateway(nk, b2, `/${sseProvider}/compat/chat/completions`, 'text/event-stream', undefined, sig));
          if (sseUpstream.statusCode >= 200 && sseUpstream.statusCode < 300) {
            log(`[${logId}] ◆ sse retry → [${sseProvider}/${sseModel}]`);
            releaseKey(sseProvider, nk);
            continue; // go back to pipe the new stream
          }
          decActive(sseProvider);
          releaseKey(sseProvider, nk);
          log(`[${logId}] ◆ sse retry [${sseProvider}/${sseModel}] ${sseUpstream.statusCode}`);
        } catch (e2) { decActive(sseProvider); releaseKey(sseProvider, nk); log(`[${logId}] ◆ sse retry [${sseProvider}/${sseModel}] ${e2.message}`); }
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
  if (jsonBody !== false) {
    if (!bodyJson || typeof bodyJson !== 'object') {
      log(`[${logId}] ← 400  invalid request body`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid request body', type: 'invalid_request' } }));
      return;
    }
  }

  const clientModel = bodyJson?.model || 'unknown';
  let targets = resolveModel(clientModel);
  if (!targets) {
    targets = [{ provider: 'openai', upstreamModel: clientModel }];
    log(`[${logId}] ◆ ${clientModel}  ${endpointPath}  (default openai)`);
  } else {
    log(`[${logId}] ◆ ${clientModel}  ${endpointPath}`);
  }

  const activeTargets = targets.filter(t => {
    if (!PROVIDERS_WITH_KEYS.has(t.provider)) return false;
    if (!CF_CONFIGURED && !DIRECT_PROVIDERS[t.provider]) return false;
    return true;
  });
  if (activeTargets.length === 0) {
    log(`[${logId}] ← 400  no keys for ${clientModel}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no keys available', type: 'no_keys' } }));
    return;
  }

  let lastErr = null;
  let clientGone = false;
  let bodyStr = '';
  let upstreamContentType = '';
  const ac = new AbortController();
  const sig = ac.signal;
  let pipeRes = null;
  req.on('close', () => { clientGone = true; if (pipeRes && !pipeRes.destroyed) pipeRes.destroy(); });
  const processResponse = async (upstreamRes, provider, upstreamModel, key) => {
    if (clientGone) { decActive(provider); releaseKey(provider, key); return 'done'; }
    const sc = upstreamRes.statusCode;
    if (sc >= 200 && sc < 300) {
      decActive(provider); releaseKey(provider, key); markKeySuccess(provider, key);
      log(`[${logId}] ← ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} ${((Date.now()-t0)/1000).toFixed(1)}s`);
      const ctype = upstreamRes.headers['content-type'] || 'application/json';
      res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider });
      pipeRes = upstreamRes; upstreamRes.on('error', () => { try { res.end(); } catch {} });
      upstreamRes.pipe(res);
      return 'done';
    }
    decActive(provider); markKeyError(provider, key); releaseKey(provider, key);
    const body = await collectBody(upstreamRes);
    log(`[${logId}] ← ${sc} [${provider}/${upstreamModel}] key=${logKey(key)} ${body.slice(0,100)}`);
    errorLog({ logId, provider, model: upstreamModel, key, status: sc, body });
    lastErr = { status: sc, body };
    return 'retry';
  };

  let retryRound = 0;
  while (!clientGone && Date.now() - t0 < TIMEOUT_MS && retryRound < 3) {
    if (retryRound > 0) {
      const wait = Math.min(retryRound * 5000, 30000);
      log(`[${logId}] ◆ retry ${retryRound} — wait ${wait}ms for key recovery`);
      await sleep(wait);
    }
    retryRound++;
    for (const target of activeTargets) {
      const { provider, upstreamModel } = target;
      const directBase = DIRECT_PROVIDERS[provider];
      let proxyEst = 0;
      if (jsonBody !== false && bodyJson) {
        const text = bodyJson.input || bodyJson.prompt || '';
        const inputLen = typeof text === 'string' ? text.length : Array.isArray(text) ? text.join('').length : 0;
        proxyEst = Math.ceil(inputLen / 3 * 1.2);
      }
      const pLimitKey = `${provider}/${upstreamModel}`.toLowerCase();
      const pCtx = USER_MODEL_LIMITS.get(pLimitKey) || PROVIDER_DEFAULT_LIMITS[provider] || 999999;
      if (proxyEst > pCtx) { log(`[${logId}] → [${provider}/${upstreamModel}] skip (${proxyEst} > ${pCtx})`); continue; }
      if (isRateLimited(provider)) { log(`[${logId}] → [${provider}/${upstreamModel}] skip (rate limited)`); continue; }
      if ((_providerActive.get(provider) || 0) >= PROVIDER_MAX_CONCURRENT) { log(`[${logId}] → [${provider}/${upstreamModel}] skip (concurrency ${_providerActive.get(provider)})`); continue; }
      const tpmLimit = TPM_LIMITS.get(provider);
      if (tpmLimit && proxyEst > tpmLimit) { log(`[${logId}] → [${provider}/${upstreamModel}] skip (total=${proxyEst} > TPM=${tpmLimit})`); continue; }
      const key = await selectKey(provider, !!directBase);
      if (!key) { log(`[${logId}] → [${provider}/${upstreamModel}] no key available`); continue; }
      if (lastErr) await sleep(Math.random() * 300);

      if (directBase) {
        if (jsonBody !== false) {
          const proxyBody = { ...bodyJson, model: upstreamModel };
          const banned = PROVIDER_BANNED_FIELDS[provider];
          if (banned) for (const f of banned) delete proxyBody[f];
          if (Array.isArray(proxyBody.tools)) proxyBody.tools = proxyBody.tools.map(t => { const c = { ...t }; delete c.strict; return c; });
          bodyStr = JSON.stringify(proxyBody);
        } else {
          bodyStr = bodyJson;
        }
        upstreamContentType = jsonBody !== false ? 'application/json' : (contentType || 'application/octet-stream');
        try {
          const ghHdrs = provider === 'github-models' ? { 'X-GitHub-Api-Version': '2026-03-10' } : undefined;
          addActive(provider);
          const upstreamRes = await forwardToDirect(key, bodyStr, directBase, (DIRECT_PATH_PREFIX[provider] || '/v1') + endpointPath, 'application/json', upstreamContentType, ghHdrs, sig);
          if (await processResponse(upstreamRes, provider, upstreamModel, key) === 'done') return;
          continue;
        } catch (e) {
          decActive(provider);
          markKeyError(provider, key);
          releaseKey(provider, key);
          log(`[${logId}] ← 502 [${provider}/${upstreamModel}] key=${logKey(key)} ${e.message}`);
          errorLog({ logId, provider, model: upstreamModel, key, status: 502, body: e.message });
          lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
          continue;
        }
      }

      const routePath = `/${provider}${endpointPath}`;
      if (jsonBody !== false) {
        const gwBody = { ...bodyJson, model: upstreamModel };
        const banned = PROVIDER_BANNED_FIELDS[provider];
        if (banned) for (const f of banned) delete gwBody[f];
        if (Array.isArray(gwBody.tools)) gwBody.tools = gwBody.tools.map(t => { const c = { ...t }; delete c.strict; return c; });
        bodyStr = JSON.stringify(gwBody);
      } else {
        bodyStr = bodyJson;
      }
      upstreamContentType = jsonBody !== false ? 'application/json' : (contentType || 'application/octet-stream');

      try {
        addActive(provider);
        const upstreamRes = await forwardToGateway(key, bodyStr, routePath, 'application/json', upstreamContentType, sig);
        if (await processResponse(upstreamRes, provider, upstreamModel, key) === 'done') return;
        continue;
      } catch (e) {
        decActive(provider);
        markKeyError(provider, key);
        releaseKey(provider, key);
        log(`[${logId}] ← 502 [${provider}/${upstreamModel}] key=${logKey(key)} ${e.message}`);
        errorLog({ logId, provider, model: upstreamModel, key, status: 502, body: e.message });
        lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
      }
    }
    if (!lastErr) { log(`[${logId}] ◆ all targets skipped`); break; }
  }

  if (!sig.aborted) ac.abort();
  if (!lastErr) { lastErr = { status: 502, body: JSON.stringify({ error: { message: 'no key succeeded' } }) }; errorLog({ logId, provider: '-', model: clientModel, key: '-', status: 502, body: 'no key succeeded' }); }

  const errCode = lastErr?.status || 502;
  log(`[${logId}] ← ${errCode} all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
  errorLog({ logId, provider: '-', model: clientModel, key: '-', status: errCode, body: (lastErr?.body || '').slice(0,200) });
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `all upstream providers failed`, type: 'proxy_error' } }));
}

// --- console management page & API ---
const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API Gateway Console</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/theme/dracula.min.css">
<style>
*{margin:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#eee;padding:20px}
.c{max-width:1000px;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #333;margin-bottom:20px}
.header h2{font-size:20px}
.header button{padding:6px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#eee;cursor:pointer;font-size:13px}
.header button:hover{background:#333}
.login{text-align:center;padding:60px 20px}
.login h2{font-size:24px;margin-bottom:8px}
.login p{margin:12px 0 24px;color:#888}
.login input{padding:10px 14px;width:300px;font-size:16px;border-radius:6px;border:1px solid #333;background:#16213e;color:#eee;outline:none}
.login input:focus{border-color:#0f3460}
.login button,.editor button{padding:10px 24px;font-size:16px;border-radius:6px;border:none;cursor:pointer}
.login button{background:#0f3460;color:#fff}
.login button:hover{background:#1a5276}
.hidden{display:none}
.editor{margin-top:0}
.editor h3{margin:20px 0 8px;display:flex;align-items:center;gap:12px;font-size:16px}
.editor .btn-bar{display:flex;gap:8px;margin-top:8px}
.editor button{background:#0f3460;color:#fff}
.editor button:hover{background:#1a5276}
.editor button.danger{background:#6c2020}
.editor button.danger:hover{background:#8a2a2a}
.status{font-size:14px;margin-top:16px;color:#888}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 24px;border-radius:8px;color:#fff;z-index:999;transition:opacity .3s;font-size:14px}
.toast.ok{background:#27ae60}
.toast.err{background:#e74c3c}
.CodeMirror{height:360px;font-size:13px;border-radius:6px;border:1px solid #333}
.CodeMirror-gutters{background:#16213e;border-right:1px solid #333}
.CodeMirror-cursor{border-color:#eee}
.CodeMirror pre{font-family:Consolas,'Courier New',monospace}
.overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center}
.overlay.hidden{display:none}
.overlay .spinner{width:40px;height:40px;border:4px solid #444;border-top-color:#0f3460;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.overlay p{margin-top:16px;color:#aaa;font-size:14px}
</style></head>
<body>
<div class="c">
<div class="header hidden" id="header"><h2>API Gateway Console</h2><button onclick="logout()">登出</button></div>
<div class="login" id="login">
<h2>API Gateway Console</h2>
<p>請輸入 Client Token 以管理設定檔</p>
<input type="password" id="token" placeholder="Client Token" autofocus onkeydown="if(event.key==='Enter')auth()">
<p><button onclick="auth()">登入</button></p>
<p class="status" id="loginStatus"></p>
</div>
<div class="editor hidden" id="editor">
<div><h3>Config <span class="status" style="color:#888;font-weight:400;font-size:13px">(儲存後伺服器將自動重啟)</span></h3>
<textarea id="configText"></textarea>
<div class="btn-bar"><button onclick="load()">讀取</button><button onclick="save('config')">儲存 Config</button></div></div>
<div><h3>Error Log</h3>
<textarea id="errorText"></textarea>
<div class="btn-bar"><button onclick="load()">讀取</button><button onclick="save('error')">儲存 Error Log</button><button class="danger" onclick="clearError()">清空</button></div></div>
</div>
</div>
<div id="toast"></div>
<div class="overlay hidden" id="overlay"><div class="spinner"></div><p>伺服器重啟中，請稍候...</p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/mode/javascript/javascript.min.js"></script>
<script>
let _token='',_cmInit=false;let cmConfig,cmError;
function logout(){_token='';if(cmConfig)cmConfig.setValue('');if(cmError)cmError.setValue('');document.getElementById('login').classList.remove('hidden');document.getElementById('editor').classList.add('hidden');document.getElementById('header').classList.add('hidden');document.getElementById('token').value='';s('',0)}
function isAscii(v){for(let i=0;i<v.length;i++){if(v.charCodeAt(i)>127)return false}return true}
async function auth(){_token=document.getElementById('token').value;if(!_token){s('請輸入 token',1);return}
if(!isAscii(_token)){s('Token 含有非 ASCII 字元，請檢查',1);return}
try{const r=await fetch('/api/console/validate',{method:'POST',headers:{'Authorization':'Bearer '+_token}});if(!r.ok){s('驗證失敗：token 不正確',1);return}
document.getElementById('header').classList.remove('hidden');
document.getElementById('login').classList.add('hidden');document.getElementById('editor').classList.remove('hidden');
if(!_cmInit){_cmInit=true;
const o={mode:'application/json',theme:'dracula',lineNumbers:true,indentUnit:2,lineWrapping:false};
cmConfig=CodeMirror.fromTextArea(document.getElementById('configText'),o);
cmError=CodeMirror.fromTextArea(document.getElementById('errorText'),o);}else{cmConfig.refresh();cmError.refresh()}
load();}catch(e){s('連線錯誤，請檢查伺服器是否在線',1);toast(e.message,0)}}
async function load(){try{const r=await fetch('/api/console/load',{headers:{'Authorization':'Bearer '+_token}});if(!r.ok){toast('載入失敗',0);return}const d=await r.json();cmConfig.setValue(d.config||'');cmError.setValue(d.error||'')}catch(e){toast('載入錯誤: '+e.message,0)}}
async function save(t){const cm=t==='config'?cmConfig:cmError;const c=cm.getValue()
try{const r=await fetch('/api/console/save',{method:'POST',headers:{'Authorization':'Bearer '+_token,'Content-Type':'application/json'},body:JSON.stringify({file:t,content:c})});if(!r.ok){const d=await r.json().catch(()=>{});toast('儲存失敗: '+(d?.error||r.status),0);return};toast('已儲存',1);if(t==='config'){showOverlay();waitForServer()}}catch(e){toast('儲存錯誤: '+e.message,0)}}
async function clearError(){cmError.setValue('');toast('已清空，請按儲存寫入檔案',1)}
function s(m,e){document.getElementById('loginStatus').textContent=m}
function toast(m,ok){const t=document.getElementById('toast');t.style.opacity='1';t.textContent=m;t.className='toast '+(ok?'ok':'err');clearTimeout(t._t);t._t=setTimeout(()=>t.style.opacity='0',4000)}
function showOverlay(){document.getElementById('overlay').classList.remove('hidden')}
function hideOverlay(){document.getElementById('overlay').classList.add('hidden')}
async function waitForServer(){for(let w=1500;w<=30000;w=Math.min(w*1.5,10000)){await new Promise(r=>setTimeout(r,w+Math.random()*500));try{const r=await fetch('/health',{signal:AbortSignal.timeout(5000)});if(r.ok){hideOverlay();toast('伺服器已重新啟動',1);return}}catch{}}toast('伺服器重啟逾時，請重新整理頁面',0);hideOverlay()}
</script></body></html>`;

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

function handleConsoleValidate(req, res, body, logId) {
  log(`[${logId}] /api/console/validate`);
  if (!checkConsoleAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleConsoleLoad(req, res, logId) {
  log(`[${logId}] /api/console/load`);
  if (!checkConsoleAuth(req, res)) return;
  const read = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ config: read(CONFIG_PATH), error: read(getErrorLogPath()) }));
}

function handleConsoleSave(req, res, body, logId) {
  log(`[${logId}] /api/console/save`);
  if (!checkConsoleAuth(req, res)) return;
  if (!body || !body.file || body.content === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file and content required' }));
    return;
  }
  if (body.file !== 'config' && body.file !== 'error') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid file type' }));
    return;
  }
  const target = body.file === 'config' ? CONFIG_PATH : getErrorLogPath();
  log(`[${logId}] save ${body.file} → ${target}  contentLen=${(body.content||'').length}`);
  try {
    if (body.file === 'config') {
      try { JSON.parse(body.content); } catch {
        try { parseJsonc(body.content); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid config content: ' + e.message }));
          return;
        }
      }
    } else if (body.file === 'error' && body.content.trim()) {
      let lineNo = 0;
      for (const rawLine of body.content.split('\n')) {
        const l = rawLine.trim();
        if (!l || l.startsWith('#')) continue;
        lineNo++;
        try { JSON.parse(l); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `error log line ${lineNo} is not valid JSON: ${e.message}` }));
          return;
        }
      }
    }
    fs.writeFileSync(target, body.content, 'utf-8');
    log(`[${logId}] saved ${path.basename(target)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    log(`[${logId}] save error: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
function isJsonEndpoint(url) {
  return url.startsWith('/v1/chat/completions') ||
         url.startsWith('/v1/embeddings') ||
         url.startsWith('/v1/images/generations') ||
         url.startsWith('/v1/audio/speech') ||
         url === '/api/console/validate' ||
         url === '/api/console/save';
}

let _activeRequests = 0;
let _reqCount = 0;
function _memGuard() {
  _reqCount++;
  if (_reqCount % 100 === 0) {
    const mem = process.memoryUsage().rss;
    if (mem > 420 * 1024 * 1024) { elog(`[mem] RSS ${(mem/1024/1024).toFixed(0)}MB > 420MB — exiting`); process.exit(1); }
  }
}

const server = http.createServer((req, res) => {
  const logId = rid();
  _activeRequests++;
  _memGuard();
  req.on('error', () => {});
  res.on('error', () => {});

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Max-Age', '86400');

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

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth check for protected endpoints
  const isConsolePath = req.url === '/console' || req.url.startsWith('/api/console/');
  const needsAuth = !isConsolePath && (req.method === 'POST' || (req.url !== '/health' && req.url !== '/v1/health' && req.url !== '/'));
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

  // --- GET /health — pure liveness, no overhead ---
  if ((req.url === '/health' || req.url === '/v1/health') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: formatUptime(process.uptime()) }));
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

  // --- GET /console — console page ---
  if (req.url === '/console' && req.method === 'GET') {
    serveConsolePage(res);
    return;
  }
  if (req.url === '/api/console/load' && req.method === 'GET') {
    handleConsoleLoad(req, res, logId);
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
        handleProxy(req, res, json, logId, '/audio/speech', true);
      } else if (req.url.startsWith('/v1/audio/transcriptions')) {
        // Multipart form-data — pass raw body + original Content-Type
        handleProxy(req, res, rawStr, logId, '/audio/transcriptions', false, req.headers['content-type']);
      } else if (req.url === '/api/console/validate') {
        handleConsoleValidate(req, res, json, logId);
      } else if (req.url === '/api/console/save') {
        handleConsoleSave(req, res, json, logId);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
    });

    // Handle oversized body destroy
    req.on('error', (e) => {
      if (e.message === 'request body too large') {
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

server.timeout = 30000;
server.keepAliveTimeout = 5000;

server.on('error', (e) => {
  elog(`[config] server error: ${e.message}`);
  if (e.code === 'EADDRINUSE') elog(`[config] port ${PORT} is already in use`);
  setTimeout(() => process.exit(1), 1000).unref();
});

const onListening = () => {
  Object.keys(PROVIDER_KEYS).forEach(initProvider);
  log(`[config] started port=${PORT} account=${ACCOUNT_ID || '(degraded)'} gateway=${GATEWAY_NAME || '(degraded)'}`);
  const summary = Object.entries(PROVIDER_KEYS).map(([p, ks]) => `${p}:${ks.length}`).join(' ');
  log(`[config] keys ${summary}`);
  log(`[config] timeout=${(TIMEOUT_MS/1000).toFixed(0)}s cooldown=${(KEY_COOLDOWN_MS/1000).toFixed(0)}s maxBody=${(MAX_BODY_SIZE/1024/1024).toFixed(1)}MB`);
  const elCfg = cfg.error_log;
  const defErrPath = './error.json';
  if (elCfg?.enabled !== false) log(`[config] error_log=${elCfg?.path || defErrPath} retention=${elCfg?.retention_days || 7}d`);
};
server.listen(PORT, onListening);

// --- graceful config reload ---
const watchPaths = [CONFIG_PATH];
// Watch both json/jsonc in the same directory as CONFIG_PATH (not env override, both may exist)
if (!process.env.CONFIG_PATH) {
  const dir = path.dirname(CONFIG_PATH);
  const alt = path.join(dir, CONFIG_PATH.endsWith('.jsonc') ? 'config.json' : 'config.jsonc');
  if (fs.existsSync(alt)) watchPaths.push(alt);
}
let reloadTimer = null;
watchPaths.forEach(wp => {
  fs.watch(wp, (event) => {
    if ((event === 'change' || event === 'rename') && !reloadTimer) {
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        log(`[config] change detected — graceful restart...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 15000).unref();
      }, 1000).unref();
    }
  });
});

// --- shutdown handlers ---
function shutdown(signal) {
  log(`[config] ${signal} — closing...`);
  server.close(() => {
    if (_activeRequests <= 0) { log('[config] done'); process.exit(0); }
    const drain = setInterval(() => {
      if (_activeRequests <= 0) { clearInterval(drain); log('[config] done'); process.exit(0); }
    }, 500).unref();
  });
  setTimeout(() => { elog(`[config] force exit (${_activeRequests} active)`); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { elog('[config] FATAL:', e.stack); process.exit(1); });
process.on('unhandledRejection', (r) => { elog('[config] REJECTION:', r instanceof Error ? r.stack : r); process.exit(1); });
