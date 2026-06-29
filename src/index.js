'use strict';

process.env.TZ = process.env.TZ || 'Asia/Taipei';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- timestamped logger ---
const _ts = () => {
  const n = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
};
function log(...a) { console.log(`[${_ts()}]`, ...a); }
function elog(...a) { console.error(`[${_ts()}]`, ...a); }

// --- error log file ---
function _errMsg(body) {
  if (!body) return '-';
  const raw = typeof body === 'string' ? body : body.toString();
  // Strip BOM, trim whitespace
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
let _errLogCount = 0;
function errorLog({ provider, model, key, status, body }) {
  const ec = cfg.error_log;
  if (ec?.enabled === false) return;
  const p = ec?.path || './error.log';
  const k = key ? `...${key.slice(-4)}` : '-';
  fs.appendFile(p, `${_ts()} | ${String(status||'-').padStart(3)} | ${(provider||'-').padEnd(18)} | ${(model||'-').padEnd(24)} | ${k} | ${_errMsg(body)}\n`, (err) => { if (err) elog(`[errorLog] write ${p}: ${err.message}`); });
  _errLogCount++;
  // Cleanup once per ~50 writes
  if (_errLogCount % 50 === 1) {
    const days = (ec?.retention_days || 7);
    const cutoff = Date.now() - days * 86400000;
    fs.readFile(p, 'utf8', (err, c) => {
      if (err) return;
      const lines = c.split('\n').filter(l => {
        try { return new Date(l.slice(0, 19)).getTime() > cutoff; } catch { return false; }
      });
      if (lines.length > 0) fs.writeFile(p, lines.join('\n') + '\n', () => {});
    });
  }
}

// ponytail: 5 safe text-level transforms, no PAKT system prompt injection needed
function compressContent(str) {
  if (!str || typeof str !== 'string' || str.length < 200) return str;

  str = str.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
           .replace(/[\u2013\u2014]/g, '--').replace(/\u2026/g, '...');

  str = str.replace(/[ \t]+$/gm, '');

  str = str.replace(/\n{3,}/g, '\n\n');

  const trimmed = str.trimStart();
  if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && str.length > 4000) {
    try {
      const p = JSON.parse(trimmed);
      if (Array.isArray(p) && p.length > 30) {
        str = JSON.stringify([...p.slice(0, 10), { _omitted: p.length - 20 }, ...p.slice(-10)]);
      }
    } catch {}
  }

  const lines = str.split('\n');
  if (lines.length > 8) {
    const out = [];
    let run = 1;
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && lines[i] === lines[i - 1] && lines[i].length > 5) {
        run++;
      } else {
        if (run > 2) out[out.length - 1] += ` (\u00d7${run})`;
        run = 1;
        out.push(lines[i]);
      }
    }
    if (run > 2) out[out.length - 1] += ` (\u00d7${run})`;
    str = out.join('\n');
  }

  return str;
}
// --- config loading ---
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let cfg = {};
try {
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  elog('[config] failed to load config.json:', e.message);
}
if (cfg.timezone) process.env.TZ = cfg.timezone;

const ACCOUNT_ID   = process.env.ACCOUNT_ID   || cfg.account_id   || '';
const GATEWAY_NAME = process.env.GATEWAY_NAME || cfg.gateway_name || '';
const CF_CONFIGURED = !!(ACCOUNT_ID && GATEWAY_NAME);
if (!CF_CONFIGURED) {
  log('[config] ACCOUNT_ID / GATEWAY_NAME not set — running degraded (chat will 502)');
}

const CLIENT_TOKEN = process.env.CLIENT_TOKEN || cfg.client_token || '';

const PROVIDER_KEYS = { ...(cfg.providers || {}) };

const ENV_MAP = {
  GEMINI_KEYS:'google-ai-studio', MISTRAL_KEYS:'mistral', CEREBRAS_KEYS:'cerebras',
  OPENAI_KEYS:'openai', ANTHROPIC_KEYS:'anthropic', DEEPSEEK_KEYS:'deepseek',
  XAI_KEYS:'xai', GROQ_KEYS:'groq', TOGETHER_KEYS:'together', OPENROUTER_KEYS:'openrouter',
  POLLINATIONS_KEYS:'pollinations', LITEROUTER_KEYS:'literouter', LLM7_KEYS:'llm7',
};

// Direct providers bypass Cloudflare AI Gateway (ponytail: add base URL when adding new direct provider)
const   DIRECT_PROVIDERS = { mistral: 'https://api.mistral.ai', pollinations: 'https://gen.pollinations.ai', literouter: 'https://api.literouter.com', llm7: 'https://api.llm7.io' };

// Fields known to cause 4xx for specific providers (strip before forwarding)
const PROVIDER_BANNED_FIELDS = {
  mistral:       new Set(['user','n','logit_bias','top_logprobs']),
  cohere:        new Set(['n','logit_bias','top_logprobs','parallel_tool_calls']),
  huggingface:   new Set(['user']),
  'freekeys':    new Set(['user']),
};
for (const [ev, p] of Object.entries(ENV_MAP)) {
  const v = process.env[ev];
  if (v) PROVIDER_KEYS[p] = v.split(',').map(s => s.trim()).filter(Boolean);
}

const MODELS = cfg.models || {};
const MODEL_ENTRIES = Object.entries(MODELS).sort((a, b) => b[0].length - a[0].length);
const PROVIDERS_WITH_KEYS = new Set(
  Object.entries(PROVIDER_KEYS).filter(([, ks]) => ks.length > 0).map(([p]) => p)
);

// --- free keys (scraped from GitHub README) ---
const FREE_KEYS_DEFAULT_URL = 'https://raw.githubusercontent.com/alistaitsacle/free-llm-api-keys/refs/heads/main/README.md';
let freeKeyModels = new Map();    // model → string[] (keys), reassigned atomically
let freeKeysHash = '';           // JSON.stringify(pairs) cache, skip swap when unchanged
let freeKeysLastFetch = 0;

function resolveModel(clientModel) {
  const m = (clientModel || '').toLowerCase();
  for (const [key, value] of MODEL_ENTRIES) {
    if (m === key || m.startsWith(key)) {
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

const keyInFlight = new Set();
const rrCursor = new Map();
const modelCursor = new Map();

function rotateTargets(targets, clientModel) {
  if (targets.length <= 1) return targets;
  let idx = modelCursor.get(clientModel) ?? 0;
  idx = idx % targets.length;
  modelCursor.set(clientModel, idx + 1);
  return [...targets.slice(idx), ...targets.slice(0, idx)];
}

function selectKey(p) {
  const healthy = getHealthyKeys(p);
  if (healthy.length === 0) return null;
  const free = healthy.filter(k => !keyInFlight.has(`${p}:${k}`));
  const keys = free.length > 0 ? free : healthy;
  let idx = rrCursor.get(p) ?? -1;
  idx = (idx + 1) % keys.length;
  rrCursor.set(p, idx);
  const key = keys[idx];
  keyInFlight.add(`${p}:${key}`);
  return key;
}

function releaseKey(p, key) {
  if (p && key) keyInFlight.delete(`${p}:${key}`);
}

// --- low-level helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function rid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (n, u) => n > 0 ? `${n}${u}` : '';
  return [p(d, 'd'), p(h, 'h'), p(m, 'm'), p(s, 's')].filter(Boolean).join(' ') || '0s';
}

function rewriteModelInSse(chunk, toModel) {
  if (!toModel) return chunk;
  return chunk.toString().split('\n').map(line => {
    if (!line.startsWith('data: ')) return line;
    try { const p = JSON.parse(line.slice(6)); if (p.model) p.model = toModel; return 'data: ' + JSON.stringify(p); }
    catch { return line; }
  }).join('\n');
}

function collectBody(res) {
  return new Promise(r => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => r(Buffer.concat(c).toString()));
    res.on('error', () => r(''));
  });
}

// --- token-based alias routing ---
// ponytail: all model aliases participate, sorted by models.dev context limit. Unknown models get large default (last fallback).
let MODELS_DEV_LIMITS = new Map();
function getAliasLimit(alias) {
  const t = resolveModel(alias)?.[0];
  if (!t) return 999999;
  const aliasProv = ({ 'google-ai-studio': 'google', 'workers-ai': 'cloudflare-workers-ai' })[t.provider] || t.provider;
  return MODELS_DEV_LIMITS.get(`${aliasProv}/${t.model || alias}`.toLowerCase()) || 999999;
}
let TOKEN_ORDER = [];
function rebuildTokenOrder() {
  const aliases = Object.keys(cfg.models || {});
  TOKEN_ORDER = aliases.map(a => [a, getAliasLimit(a)]).sort((a, b) => a[1] - b[1]).map(([a]) => a);
}
rebuildTokenOrder();

function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (c && typeof c === 'object') {
      const parts = Array.isArray(c) ? c : [c];
      for (const p of parts) { if (p.text) chars += p.text.length; }
    }
  }
  return Math.ceil(chars / 1.5 * 1.2);
}

// --- models.dev auto-lookup for model context limits ---
const MODELS_DEV_URL = 'https://models.dev/api.json';

function fetchModelsDev() {
  return new Promise(resolve => {
    https.get(MODELS_DEV_URL, (res) => {
      if (res.statusCode !== 200) { elog(`[models.dev] fetch ${res.statusCode}`); resolve(); return; }
      let body = '';
      res.on('data', c => { body += c.toString(); if (body.length > 5e6) { res.destroy(); } });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const m = new Map();
          for (const [pid, prov] of Object.entries(data)) {
            if (!prov?.models) continue;
            for (const [mid, model] of Object.entries(prov.models)) {
              const ctx = model?.limit?.context;
              if (ctx && typeof ctx === 'number' && ctx > 0) {
                m.set(`${pid}/${mid}`.toLowerCase(), ctx);
              }
            }
          }
          MODELS_DEV_LIMITS = m;
          rebuildTokenOrder();
          log(`[models.dev] ${m.size} model context limits loaded`);
        } catch (e) { elog(`[models.dev] parse error: ${e.message}`); }
        resolve();
      });
      res.on('error', () => resolve());
    }).on('error', (e) => { elog(`[models.dev] fetch error: ${e.message}`); resolve(); });
  });
}
// --- free keys scraping ---
const FREE_KEY_RE = /^\|\s*`(sk-[a-zA-Z0-9]+)`\s*\|\s*([a-zA-Z0-9_\/.\-:]+)\s*\|/gm;

function parseFreeKeys(md) {
  const pairs = []; // [key, model][]
  FREE_KEY_RE.lastIndex = 0;
  let m;
  while ((m = FREE_KEY_RE.exec(md)) !== null) {
    pairs.push([m[1], m[2].trim()]);
  }
  return pairs;
}

function fetchFreeKeys() {
  const fk = cfg.free_keys;
  if (!fk?.enabled) return Promise.resolve();
  const now = Date.now();
  if (now - freeKeysLastFetch < (fk.interval_ms || 300000)) return Promise.resolve();
  const url = fk.url || FREE_KEYS_DEFAULT_URL;
  return new Promise(resolve => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { elog(`[freekeys] fetch ${res.statusCode}`); resolve(); return; }
      const MAX_LINES = 500;
      const END_MARKER = '## 🚀 How to Use';
      let body = '', lines = 0, parsed = false;
      const parse = () => {
        if (parsed) return;
        parsed = true;
        const pairs = parseFreeKeys(body);
        if (pairs.length === 0) { elog('[freekeys] parsed 0 keys'); resolve(); return; }
        const newHash = JSON.stringify(pairs);
        if (newHash === freeKeysHash) { freeKeysLastFetch = Date.now(); resolve(); return; }
        freeKeysHash = newHash;
        freeKeysLastFetch = Date.now();
        const allKeys = [...new Set(pairs.map(p => p[0]))];
        PROVIDER_KEYS['freekeys'] = allKeys;
        PROVIDERS_WITH_KEYS.add('freekeys');
        keyPool.set('freekeys', new Map(allKeys.map(k => [k, { degradedUntil: 0, errorCount: 0, successCount: 0 }])));
        const newModelMap = new Map();
        for (const [key, model] of pairs) {
          if (!newModelMap.has(model)) newModelMap.set(model, []);
          newModelMap.get(model).push(key);
        }
        freeKeyModels = newModelMap;
        log(`[freekeys] ${allKeys.length} keys across ${freeKeyModels.size} models`);
        resolve();
      };
      res.on('data', (c) => {
        const s = c.toString();
        body += s;
        const markerIdx = body.indexOf(END_MARKER);
        if (markerIdx !== -1) { body = body.slice(0, markerIdx); res.destroy(); parse(); return; }
        lines += s.split('\n').length - 1;
        if (lines >= MAX_LINES) { res.destroy(); parse(); }
      });
      res.on('end', () => { if (!parsed) parse(); resolve(); });
      res.on('close', () => { resolve(); });
    }).on('error', (e) => { elog(`[freekeys] fetch error: ${e.message}`); resolve(); });
  });
}

function getFreeKeyTargets(clientModel) {
  if (freeKeyModels.size === 0) return [];
  const baseUrl = cfg.free_keys?.base_url;
  if (!baseUrl) return [];
  const m = clientModel.toLowerCase();
  const exact = [];
  for (const [model] of freeKeyModels) {
    const ml = model.toLowerCase();
    if (m === ml || m.startsWith(ml) || ml.startsWith(m)) {
      exact.push(model);
    }
  }
  if (exact.length > 0) return exact.slice(0, 5).map(model => ({ provider: 'freekeys', upstreamModel: model, keys: freeKeyModels.get(model), base_url: baseUrl }));
  // Fallback: smart-chat (auto-routing) then first 2 models
  const fallback = [];
  if (freeKeyModels.has('smart-chat')) fallback.push('smart-chat');
  let idx = 0;
  for (const model of freeKeyModels.keys()) {
    if (model === 'smart-chat') continue;
    if (idx >= 2) break;
    fallback.push(model); idx++;
  }
  return fallback.map(model => ({ provider: 'freekeys', upstreamModel: model, keys: freeKeyModels.get(model), base_url: baseUrl }));
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
    if (msg && typeof msg === 'object' && msg.role === 'assistant' && 'reasoning_content' in msg) {
      const { reasoning_content, ...rest } = msg;
      return rest;
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

function forwardToGateway(apiKey, bodyStr, routePath, accept, contentType) {
  return new Promise((resolve, reject) => {
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
    req.write(bodyStr);
    req.end();
  });
}

function forwardToDirect(apiKey, bodyStr, baseUrl, endpointPath, accept, contentType) {
  return new Promise((resolve, reject) => {
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
      },
      timeout: TIMEOUT_MS,
    };
    const mod = isHttps ? https : http;
    const req = mod.request(opts, resolve);
    req.on('error', (e) => reject(e.name === 'AbortError' ? new Error('aborted') : e));
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
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

  // Validate payload
  const validationErr = validateChatBody(bodyJson);
  if (validationErr) {
    log(`[${logId}] ← 400  ${validationErr}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: validationErr, type: 'invalid_request' } }));
    return;
  }

  const hasFreeKeys = cfg.free_keys?.enabled && freeKeyModels.size > 0;
  if (!CF_CONFIGURED && !hasFreeKeys) {
    log(`[${logId}] ← 502  gateway not configured`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'gateway not configured — set ACCOUNT_ID and GATEWAY_NAME', type: 'not_configured' } }));
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

  // Format-preserving content compression (before token routing for accurate sizing)
  if (Array.isArray(bodyJson.messages)) {
    bodyJson.messages = bodyJson.messages.map(m => {
      if (typeof m.content === 'string' && m.content.length > 200) {
        return { ...m, content: compressContent(m.content) };
      }
      return m;
    });
  }

  // Token-based alias routing — only when client model can't handle the request
  if (TOKEN_ORDER.length > 0) {
    const est = estimateTokens(bodyJson.messages);
    const clientTargets = resolveModel(clientModel);
    const clientLimit = getAliasLimit(clientModel);
    if (!clientTargets || (clientLimit > 0 && est > clientLimit)) {
      for (const alias of TOKEN_ORDER) {
        const newTargets = resolveModel(alias);
        if (!newTargets) continue;
        const limit = getAliasLimit(alias);
        if (limit > 0 && est > limit) continue;
        if (alias !== clientModel) {
          log(`[${logId}] token routing: ${clientModel} → ${alias} (est=${est}, limit=${limit})`);
          targets = newTargets;
        }
        break;
      }
    }
  }

  // Fast-skip targets whose provider has no keys configured
  let activeTargets = CF_CONFIGURED ? targets.filter(t => t.provider !== 'freekeys' && PROVIDERS_WITH_KEYS.has(t.provider)) : [];
  if (activeTargets.length === 0 && !hasFreeKeys) {
    log(`[${logId}] ← 400  no keys available for ${clientModel}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no keys available for model '${clientModel}'`, type: 'no_keys' } }));
    return;
  }

  // Determine streaming mode (default true for backward compat)
  const isStream = bodyJson.stream !== false;
  const providerKeyCount = Object.keys(PROVIDER_KEYS).filter(k => k !== 'freekeys').reduce((s, k) => s + (PROVIDER_KEYS[k] || []).length, 0);
  log(`[${logId}] → ${clientModel}  msgs=${bodyJson.messages.length}  stream=${isStream}  keys=${providerKeyCount}  free=${freeKeyModels.size}`);


  const rotated = rotateTargets(activeTargets, clientModel);
  if (rotated.length > 1) log(`[${logId}] fallback: ${rotated.map(t => `${t.provider}/${t.upstreamModel}`).join(' > ')}`);

  // Prepare body template once — model is set per-target below
  const bodyTemplate = { ...bodyJson, stream: isStream };
  delete bodyTemplate.model;

  let lastErr = null, upstreamRes = null, usedProvider = null, usedKey = null;
  let usedModel = null;
  let clientGone = false;
  let retryRound = 0;
  let sseStarted = false;
  req.on('close', () => { clientGone = true; });

  // SSE mode: respond immediately with 200 + SSE headers, then try upstreams in background
  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': logId,
    });
    sseStarted = true;
  }

  while (!upstreamRes && !clientGone && Date.now() - t0 < TIMEOUT_MS) {
    if (retryRound > 0) {
      // Progressive wait: 5s, 10s, 15s, 20s, 25s, 30s...
      const wait = Math.min(retryRound * 5000, 30000);
      log(`[${logId}] retry ${retryRound} — waiting ${wait}ms for key recovery...`);
      await sleep(wait);
    }
    retryRound++;
  for (let ti = 0; ti < rotated.length; ti++) {
    const target = rotated[ti];
    if (upstreamRes) break; // only success stops the chain
    try {
    const provider = target.provider;
    const upstreamModel = target.upstreamModel;
    const maxAttempts = Math.max(1, (PROVIDER_KEYS[provider] || []).length);

    if (lastErr) await sleep(Math.random() * 300); // jitter between provider targets

    // Serialise body once per provider target
    const isDirect = DIRECT_PROVIDERS[provider];
    const bodyObj = { ...bodyTemplate, model: isDirect ? upstreamModel : `${provider}/${upstreamModel}` };
    const banned = PROVIDER_BANNED_FIELDS[provider];
    if (banned) for (const f of banned) delete bodyObj[f];
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
      if (attempt > 0) await sleep(Math.random() * 300); // jitter to spread concurrent retries
      usedKey = selectKey(provider);
      if (!usedKey) { log(`[${logId}] ${provider}/${upstreamModel} → no key`); errorLog({ provider, model: upstreamModel, key: '-', status: 503, body: 'no healthy key' }); break; }

      try {
        const acceptHdr = isStream ? 'text/event-stream' : 'application/json';
        upstreamRes = isDirect ? await forwardToDirect(usedKey, bodyStr, DIRECT_PROVIDERS[provider], '/v1/chat/completions', acceptHdr) : await forwardToGateway(usedKey, bodyStr, '/compat/chat/completions', acceptHdr);
        usedProvider = provider;
        usedModel = upstreamModel;
        const sc = upstreamRes.statusCode;

        if (sc === 429 || sc >= 500) {
          markKeyError(provider, usedKey);
          releaseKey(provider, usedKey);
          const body = await collectBody(upstreamRes);
          log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  attempt=${attempt+1}/${maxAttempts}  key=...${usedKey.slice(-4)}`);
          errorLog({ provider, model: upstreamModel, key: usedKey, status: sc, body });
          lastErr = { status: sc, body };
          upstreamRes = null;
          continue;
        }

        if (sc >= 400) {
          markKeyError(provider, usedKey);
          releaseKey(provider, usedKey);
          const body = await collectBody(upstreamRes);
          log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${usedKey.slice(-4)}  ${body.slice(0, 100)}`);
          errorLog({ provider, model: upstreamModel, key: usedKey, status: sc, body });
          lastErr = { status: sc, body };
          upstreamRes = null;
          continue;
        }

        // Success
        releaseKey(provider, usedKey);
        markKeySuccess(provider, usedKey);
        log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${usedKey.slice(-4)}`);
        break;

      } catch (e) {
        markKeyError(provider, usedKey);
        releaseKey(provider, usedKey);
        log(`[${logId}] ${provider}/${upstreamModel} → error  attempt=${attempt+1}/${maxAttempts}  ${e.message}`);
        errorLog({ provider, model: upstreamModel, key: usedKey, status: 502, body: e.message });
        lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
        upstreamRes = null;
      }
    }
    } catch (e) { log(`[${logId}] ${target?.provider}/${target?.upstreamModel} → fatal ${e.message}`); errorLog({ provider: target?.provider || '?', model: target?.upstreamModel || '?', key: '-', status: 502, body: e.message }); }
  }
  }

  // --- CF all failed → try free keys as last resort ---
  if (!upstreamRes && cfg.free_keys?.enabled && !clientGone) {
    const baseUrl = cfg.free_keys?.base_url;
    if (baseUrl) {
      const fkMap = freeKeyModels;
      const matchedModels = getFreeKeyTargets(clientModel).map(t => t.upstreamModel);
      const matchedSet = new Set(matchedModels);
      const allModels = [...fkMap.keys()];
      const orderedModels = matchedModels.concat(allModels.filter(m => !matchedSet.has(m)));
      if (orderedModels.length > 0) log(`[${logId}] freekeys try ${orderedModels.length} models (${matchedModels.length} matched)`);
      for (const model of orderedModels) {
        if (clientGone || upstreamRes) break;
        const keys = fkMap.get(model) || [];
        const fbBody = { ...bodyTemplate, model };
        const fkBanned = PROVIDER_BANNED_FIELDS['freekeys'];
        if (fkBanned) for (const f of fkBanned) delete fbBody[f];
        if (Array.isArray(fbBody.messages)) {
          if (!supportsReasoningContent('freekeys', model)) fbBody.messages = sanitizeMessages(fbBody.messages);
          fbBody.messages = normalizeContent(fbBody.messages);
        }
        const bodyStr = JSON.stringify(fbBody);
        for (const key of keys) {
          if (clientGone || upstreamRes) break;
          await sleep(Math.random() * 200);
          const kp = keyPool.get('freekeys');
          const ks = kp?.get(key);
          if (ks && Date.now() < ks.degradedUntil) continue;
          try {
            const acceptHdr = isStream ? 'text/event-stream' : 'application/json';
            upstreamRes = await forwardToDirect(key, bodyStr, baseUrl, 'chat/completions', acceptHdr);
            usedProvider = 'freekeys';
            usedModel = model;
            const sc = upstreamRes.statusCode;
            if (sc === 429 || sc >= 500 || sc === 402 || sc === 401) {
              markKeyError('freekeys', key);
              releaseKey('freekeys', key);
              const bd = await collectBody(upstreamRes);
              log(`[${logId}] freekeys/${model} → ${sc}  key=...${key.slice(-4)}`);
              errorLog({ provider: 'freekeys', model, key, status: sc, body: bd });
              lastErr = { status: sc, body: bd }; upstreamRes = null;
              continue;
            }
            if (sc >= 400) {
              markKeyError('freekeys', key);
              releaseKey('freekeys', key);
              const bd = await collectBody(upstreamRes);
              log(`[${logId}] freekeys/${model} → ${sc}  key=...${key.slice(-4)}  ${bd.slice(0,100)}`);
              errorLog({ provider: 'freekeys', model, key, status: sc, body: bd });
              lastErr = { status: sc, body: bd }; upstreamRes = null;
              break;
            }
            releaseKey('freekeys', key);
            log(`[${logId}] freekeys/${model} → ${sc}  key=...${key.slice(-4)}`);
            break;
          } catch (e) {
            markKeyError('freekeys', key);
            releaseKey('freekeys', key);
            log(`[${logId}] freekeys/${model} → error  ${e.message}`);
            errorLog({ provider: 'freekeys', model, key, status: 502, body: e.message });
            lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
            upstreamRes = null;
            continue;
          }
        }
        if (!upstreamRes && keys.length > 0) {
          if (lastErr?.status === 403) {
            log(`[${logId}] freekeys/${model} → blocked (403), skip to next model`);
          } else {
            log(`[${logId}] freekeys/${model} → all ${keys.length} keys exhausted`);
          }
        }
      }
    }
  }

  if (!upstreamRes || !usedProvider) {
    const errMsg = lastErr ? (typeof lastErr.body === 'string' ? lastErr.body.slice(0, 300) : JSON.stringify(lastErr.body).slice(0, 300)) : 'no upstream';
    const errCode = lastErr?.status || 502;
    log(`[${logId}] ← ${sseStarted ? 'SSE' : '502'}  all failed (upstream=${errCode})  ${((Date.now()-t0)/1000).toFixed(1)}s`);
    errorLog({ provider: usedProvider || '-', model: usedModel || clientModel, key: usedKey || '-', status: errCode, body: errMsg });
    if (sseStarted) {
      // SSE already 200'd — send error event then close
      const sseErr = { error: { message: `all failed: ${errMsg}`, type: 'proxy_error' } };
      try { res.write(`data: ${JSON.stringify(sseErr)}\n\n`); } catch {}
      try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `all failed: ${errMsg}` } }));
    }
    return;
  }

  // --- success path ---
  log(`[${logId}] ← 200  ${((Date.now()-t0)/1000).toFixed(1)}s  ${usedProvider}/${usedModel}`);

  if (sseStarted) {
    // SSE headers already sent — pipe upstream directly
    const needModelRewrite = usedModel !== clientModel;
    const pipe = needModelRewrite
      ? (c) => { try { res.write(rewriteModelInSse(c, clientModel)); } catch {} }
      : (c) => { try { res.write(c); } catch {} };
    upstreamRes.on('data', pipe);
    upstreamRes.on('end',   () => { try { res.end(); } catch {} });
    upstreamRes.on('error', (e) => { log(`[${logId}] stream: ${e.message}`); try { res.end(); } catch {} });
    req.on('close', () => { if (upstreamRes && !upstreamRes.destroyed) upstreamRes.destroy(); });
  } else {
    // Non-streaming JSON response
    const body = await collectBody(upstreamRes);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Request-Id': logId,
      'X-Provider': usedProvider,
      'X-Upstream-Model': usedModel,
    });
    res.end(body);
  }
}

async function handleProxy(req, res, bodyJson, logId, endpointPath, jsonBody, contentType) {
  const t0 = Date.now();
  const hasFreeKeys = cfg.free_keys?.enabled && freeKeyModels.size > 0;
  if (!CF_CONFIGURED && !hasFreeKeys) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'gateway not configured', type: 'not_configured' } }));
    return;
  }

  if (jsonBody !== false) {
    if (!bodyJson || typeof bodyJson !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid request body', type: 'invalid_request' } }));
      return;
    }
  }

  const clientModel = bodyJson?.model || 'unknown';

  // Try configured model mapping first, fall back to openai default
  let targets = resolveModel(clientModel);
  if (!targets) {
    targets = [{ provider: 'openai', upstreamModel: clientModel }];
    log(`[${logId}] → ${clientModel}  ${endpointPath}  (default openai)`);
  } else {
    log(`[${logId}] → ${clientModel}  ${endpointPath}`);
  }

  // Fast-skip targets without configured keys
  const activeTargets = CF_CONFIGURED ? targets.filter(t => t.provider !== 'freekeys' && PROVIDERS_WITH_KEYS.has(t.provider)) : [];
  if (activeTargets.length === 0 && !hasFreeKeys) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no keys available', type: 'no_keys' } }));
    return;
  }

  let lastErr = null;
  let clientGone = false;
  let bodyStr = '';
  let upstreamContentType = '';
  req.on('close', () => { clientGone = true; });

  for (const target of activeTargets) {
    const { provider, upstreamModel } = target;
    const key = selectKey(provider);
    if (!key) { log(`[${logId}] ${provider}/${upstreamModel} → no key`); continue; }
    // jitter before each provider attempt to spread concurrent requests
    if (lastErr) await sleep(Math.random() * 300);

    const directBase = DIRECT_PROVIDERS[provider];

    if (directBase) {
      // Direct provider (e.g. pollinations) — bypass CF gateway
      if (jsonBody !== false) {
        const proxyBody = { ...bodyJson, model: upstreamModel };
        const banned = PROVIDER_BANNED_FIELDS[provider];
        if (banned) for (const f of banned) delete proxyBody[f];
        bodyStr = JSON.stringify(proxyBody);
      } else {
        bodyStr = bodyJson;
      }
      upstreamContentType = jsonBody !== false ? 'application/json' : (contentType || 'application/octet-stream');
      try {
        const upstreamRes = await forwardToDirect(key, bodyStr, directBase, '/v1' + endpointPath, 'application/json', upstreamContentType);
        if (clientGone) { releaseKey(provider, key); return; }
        const sc = upstreamRes.statusCode;
        if (sc >= 200 && sc < 300) {
          releaseKey(provider, key);
          markKeySuccess(provider, key);
          log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${key.slice(-4)}  ${((Date.now()-t0)/1000).toFixed(1)}s`);
          const ctype = upstreamRes.headers['content-type'] || 'application/json';
          const body = await collectBody(upstreamRes);
          res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider });
          res.end(body);
          return;
        }
        markKeyError(provider, key);
        releaseKey(provider, key);
        const body = await collectBody(upstreamRes);
        if (sc === 429 || sc >= 500) {
          log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${key.slice(-4)}`);
          errorLog({ provider, model: upstreamModel, key, status: sc, body });
          lastErr = { status: sc, body };
        } else {
          log(`[${logId}] ${provider}/${upstreamModel} → ${sc} skip  key=...${key.slice(-4)}  ${body.slice(0, 100)}`);
          errorLog({ provider, model: upstreamModel, key, status: sc, body });
          lastErr = { status: sc, body };
        }
        continue;
      } catch (e) {
        markKeyError(provider, key);
        releaseKey(provider, key);
        log(`[${logId}] ${provider}/${upstreamModel} → error  ${e.message}`);
        errorLog({ provider, model: upstreamModel, key, status: 502, body: e.message });
        lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
        continue;
      }
    }

    // Provider-specific route: /{provider}/{endpoint}
    const routePath = `/${provider}${endpointPath}`;

    if (jsonBody !== false) {
      bodyStr = JSON.stringify({ ...bodyJson, model: upstreamModel });
    } else {
      bodyStr = bodyJson;
    }

    upstreamContentType = jsonBody !== false ? 'application/json' : (contentType || 'application/octet-stream');

    try {
      const upstreamRes = await forwardToGateway(key, bodyStr, routePath, 'application/json', upstreamContentType);
      if (clientGone) { releaseKey(provider, key); return; }
      const sc = upstreamRes.statusCode;

      if (sc >= 200 && sc < 300) {
        releaseKey(provider, key);
        markKeySuccess(provider, key);
        log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${key.slice(-4)}  ${((Date.now()-t0)/1000).toFixed(1)}s`);
        const ctype = upstreamRes.headers['content-type'] || 'application/json';
        const body = await collectBody(upstreamRes);
        res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider });
        res.end(body);
        return;
      }

      // degrade before releasing — no race window
      markKeyError(provider, key);
      releaseKey(provider, key);
      const body = await collectBody(upstreamRes);
      if (sc === 429 || sc >= 500) {
        log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${key.slice(-4)}`);
        errorLog({ provider, model: upstreamModel, key, status: sc, body });
        lastErr = { status: sc, body };
      } else {
        log(`[${logId}] ${provider}/${upstreamModel} → ${sc} skip  key=...${key.slice(-4)}  ${body.slice(0, 100)}`);
        errorLog({ provider, model: upstreamModel, key, status: sc, body });
        lastErr = { status: sc, body };
      }
      continue;

    } catch (e) {
      markKeyError(provider, key);
      releaseKey(provider, key);
      log(`[${logId}] ${provider}/${upstreamModel} → error  ${e.message}`);
      errorLog({ provider, model: upstreamModel, key, status: 502, body: e.message });
      lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
    }
  }

  // All attempts exhausted — also triggered when loop ran (activeTargets.length>0)
  // but every key was degraded and no upstream ever returned (lastErr stays null)
  if (!lastErr) { lastErr = { status: 502, body: JSON.stringify({ error: { message: 'no key succeeded' } }) }; errorLog({ provider: '-', model: clientModel, key: '-', status: 502, body: 'no key succeeded' }); }
  if (cfg.free_keys?.enabled && !clientGone) {
    const freeTargets = getFreeKeyTargets(clientModel);
    if (freeTargets.length > 0) log(`[${logId}] freekey fallback: ${freeTargets.map(t => `${t.provider}/${t.upstreamModel}`).join(' > ')}`);
    for (const ft of freeTargets) {
      if (clientGone) break;
      for (const key of ft.keys) {
        if (clientGone) break;
        // Skip degraded keys
        const kp = keyPool.get('freekeys');
        const ks = kp?.get(key);
        if (ks && Date.now() < ks.degradedUntil) continue;
        try {
          const fbBody = jsonBody !== false
            ? JSON.stringify({ ...bodyJson, model: ft.upstreamModel })
            : bodyJson;
          const fbContentType = jsonBody !== false ? 'application/json' : (contentType || 'application/octet-stream');
          const routePath = endpointPath.replace(/^\//, '');
          const upstreamRes = await forwardToDirect(key, fbBody, ft.base_url, routePath, 'application/json', fbContentType);
          if (clientGone) return;
          const sc = upstreamRes.statusCode;
          const body = await collectBody(upstreamRes);
          if (sc >= 200 && sc < 300) {
            log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → ${sc}  key=...${key.slice(-4)}  ${((Date.now()-t0)/1000).toFixed(1)}s`);
            const ctype = upstreamRes.headers['content-type'] || 'application/json';
            res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': ft.provider });
            res.end(body);
            return;
          }
          log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → ${sc} skip  key=...${key.slice(-4)}  ${body.slice(0,100)}`);
          errorLog({ provider: 'freekeys', model: ft.upstreamModel, key, status: sc, body });
          if (sc === 401 || sc === 402 || sc >= 500) markKeyError('freekeys', key);
        } catch (e) {
          log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → error  ${e.message}`);
          errorLog({ provider: 'freekeys', model: ft.upstreamModel, key, status: 502, body: e.message });
          markKeyError('freekeys', key);
        }
      }
    }
  }

  const errCode = lastErr?.status || 502;
  log(`[${logId}] ← 502  all failed (upstream=${errCode})  ${((Date.now()-t0)/1000).toFixed(1)}s`);
  errorLog({ provider: '-', model: clientModel, key: '-', status: errCode, body: (lastErr?.body || '').slice(0,200) });
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `all upstream providers failed`, type: 'proxy_error' } }));
}

function isJsonEndpoint(url) {
  return url.startsWith('/v1/chat/completions') ||
         url.startsWith('/v1/embeddings') ||
         url.startsWith('/v1/images/generations') ||
         url.startsWith('/v1/audio/speech');
}

const server = http.createServer((req, res) => {
  const logId = rid();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth check for protected endpoints
  const needsAuth = (req.method === 'POST' || (req.url !== '/health' && req.url !== '/v1/health' && req.url !== '/'));
  if (needsAuth && CLIENT_TOKEN) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== CLIENT_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'auth_error' } }));
      return;
    }
  }

  // --- GET /health — NO upstream key consumption ---
  if ((req.url === '/health' || req.url === '/v1/health') && req.method === 'GET') {
    cleanupOldLogs();
    fetchFreeKeys();
    const uptime = formatUptime(process.uptime());
    if (CLIENT_TOKEN) {
      const auth = req.headers['authorization'];
      if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== CLIENT_TOKEN) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime }));
        return;
      }
    }
    const s = { status: 'ok', uptime, providers: {}, degraded: [] };
    for (const [p] of keyPool) {
      const healthy = getHealthyKeys(p).length;
      const total = PROVIDER_KEYS[p]?.length || 0;
      s.providers[p] = { healthy, total };
      if (healthy === 0 && total > 0) s.degraded.push(p);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s));
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

      const rawBody = Buffer.concat(chunks);
      let json, rawStr;

      // Try JSON parse for JSON endpoints
      if (isJsonEndpoint(req.url)) {
        try {
          json = JSON.parse(rawBody.toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid JSON', type: 'invalid_request' } }));
          return;
        }
      } else {
        // Raw body for non-JSON endpoints (audio transcriptions, etc.)
        rawStr = rawBody;
      }

      // Route to appropriate handler
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

// --- provider initialisation ---
Object.keys(PROVIDER_KEYS).forEach(initProvider);

server.timeout = 0;
server.keepAliveTimeout = 0;

server.on('error', (e) => {
  elog(`[config] server error: ${e.message}`);
  if (e.code === 'EADDRINUSE') elog(`[config] port ${PORT} is already in use`);
  setTimeout(() => process.exit(1), 1000).unref();
});

const onListening = () => {
  log(`[config] started port=${PORT} account=${ACCOUNT_ID || '(degraded)'} gateway=${GATEWAY_NAME || '(degraded)'}`);
  const summary = Object.entries(PROVIDER_KEYS).map(([p, ks]) => `${p}:${ks.length}`).join(' ');
  log(`[config] keys ${summary}`);
  log(`[config] timeout=${(TIMEOUT_MS/1000).toFixed(0)}s cooldown=${(KEY_COOLDOWN_MS/1000).toFixed(0)}s maxBody=${(MAX_BODY_SIZE/1024/1024).toFixed(1)}MB`);
  const elCfg = cfg.error_log;
  if (elCfg?.enabled !== false) log(`[config] error_log=${elCfg?.path || './error.log'} retention=${elCfg?.retention_days || 7}d`);
};
const startup = [];
startup.push(fetchModelsDev());
if (cfg.free_keys?.enabled) startup.push(fetchFreeKeys());
Promise.all(startup).then(() => server.listen(PORT, onListening));

// --- graceful config reload ---
if (fs.existsSync(CONFIG_PATH)) {
  let reloadTimer = null;
  fs.watch(CONFIG_PATH, (event) => {
    if ((event === 'change' || event === 'rename') && !reloadTimer) {
      reloadTimer = setTimeout(() => {
        log(`[config] ${path.basename(CONFIG_PATH)} changed — graceful restart...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 15000).unref();
      }, 1000).unref();
    }
  });
}

// --- shutdown handlers ---
function shutdown(signal) {
  log(`[config] ${signal} — closing...`);
  server.close(() => { log('[config] done'); process.exit(0); });
  setTimeout(() => { elog('[config] force exit'); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { elog('[config] FATAL:', e.stack); process.exit(1); });
process.on('unhandledRejection', (r) => { elog('[config] REJECTION:', r instanceof Error ? r.stack : r); });
