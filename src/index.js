'use strict';

process.env.TZ = 'Asia/Taipei';

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
// --- end logger ---

// --- config loading ---
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let cfg = {};
try {
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  elog('[config] failed to load config.json:', e.message);
}

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
const freeKeyModels = new Map();    // model → string[] (keys)
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
  const keys = getHealthyKeys(p);
  if (keys.length === 0) return null;
  let idx = rrCursor.get(p) ?? -1;
  idx = (idx + 1) % keys.length;
  rrCursor.set(p, idx);
  return keys[idx];
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
  return chunk.toString().replace(/"model"\s*:\s*"[^"]+"/g, `"model":"${toModel}"`);
}

function collectBody(res) {
  return new Promise(r => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => r(Buffer.concat(c).toString()));
    res.on('error', () => r(''));
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
  if (!fk?.enabled) return;
  const now = Date.now();
  if (now - freeKeysLastFetch < (fk.interval_ms || 300000)) return;
  const url = fk.url || FREE_KEYS_DEFAULT_URL;
  https.get(url, (res) => {
    if (res.statusCode !== 200) { elog(`[freekeys] fetch ${res.statusCode}`); return; }
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      const pairs = parseFreeKeys(body);
      if (pairs.length === 0) { elog('[freekeys] parsed 0 keys'); return; }
      freeKeysLastFetch = Date.now();
      const allKeys = [...new Set(pairs.map(p => p[0]))];
      PROVIDER_KEYS['freekeys'] = allKeys;
      PROVIDERS_WITH_KEYS.add('freekeys');
      // Replace entire key pool (expired keys are removed)
      keyPool.set('freekeys', new Map(allKeys.map(k => [k, { degradedUntil: 0, errorCount: 0, successCount: 0 }])));

      freeKeyModels.clear();
      for (const [key, model] of pairs) {
        if (!freeKeyModels.has(model)) freeKeyModels.set(model, []);
        freeKeyModels.get(model).push(key);
      }
      log(`[freekeys] ${allKeys.length} keys across ${freeKeyModels.size} models`);
    });
  }).on('error', (e) => elog(`[freekeys] fetch error: ${e.message}`));
}

function getFreeKeyTargets(clientModel) {
  if (freeKeyModels.size === 0) return [];
  const baseUrl = cfg.free_keys?.base_url;
  if (!baseUrl) return [];
  const m = clientModel.toLowerCase();
  // First try exact/prefix match
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

// --- gateway proxy ---

/**
 * Forward a request to Cloudflare AI Gateway.
 * @param {string} apiKey         - Provider API key
 * @param {string} bodyStr        - Serialised JSON body
 * @param {string} routePath      - Gateway path (e.g. '/compat/chat/completions' or '/openai/embeddings')
 * @param {string} [accept]       - Accept header value
 * @param {string} [contentType]  - Content-Type header value
 * @returns {Promise<IncomingMessage>}
 */
function forwardToGateway(apiKey, bodyStr, routePath, accept, contentType) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: cfg.gateway_base_url || 'gateway.ai.cloudflare.com',
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

/**
 * Forward a request directly to a custom base URL (bypass CF AI Gateway).
 * Used for free keys (aiapiv2.pekpik.com) and other direct endpoints.
 */
function forwardToDirect(apiKey, bodyStr, baseUrl, endpointPath, accept, contentType) {
  return new Promise((resolve, reject) => {
    const joined = baseUrl.replace(/\/+$/, '') + '/' + endpointPath.replace(/^\/+/, '');
    const url = new URL(joined);
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
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

// --- log cleanup ---
let lastLogCleanup = 0;

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
      if (ok) lastLogCleanup = now;
      if (!ok) elog(`[cleanup] ${res.statusCode} ${body.slice(0, 200)}`);
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
    if (msg.content === undefined || msg.content === null) return `messages[${i}].content is required`;
  }
  return null;
}

// ============================================================
//  CHAT COMPLETIONS  (/v1/chat/completions)
// ============================================================

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
  const targets = resolveModel(clientModel);

  if (!targets) {
    log(`[${logId}] ← 400  unsupported model: ${clientModel}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `model '${clientModel}' not supported`, type: 'unsupported_model' } }));
    return;
  }

  // Fast-skip targets whose provider has no keys configured
  const activeTargets = CF_CONFIGURED ? targets.filter(t => PROVIDERS_WITH_KEYS.has(t.provider)) : [];
  if (activeTargets.length === 0 && !hasFreeKeys) {
    log(`[${logId}] ← 400  no keys available for ${clientModel}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no keys available for model '${clientModel}'`, type: 'no_keys' } }));
    return;
  }

  // Determine streaming mode (default true for backward compat)
  const isStream = bodyJson.stream !== false;
  log(`[${logId}] → ${clientModel}  msgs=${bodyJson.messages.length}  stream=${isStream}`);

  const rotated = rotateTargets(activeTargets, clientModel);
  if (rotated.length > 1) log(`[${logId}] fallback: ${rotated.map(t => `${t.provider}/${t.upstreamModel}`).join(' > ')}`);

  // Prepare body template once — model is set per-target below
  const bodyTemplate = { ...bodyJson, stream: isStream };
  delete bodyTemplate.model;

  let lastErr = null, upstreamRes = null, usedProvider = null, usedKey = null;
  let usedModel = null;
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  outer: for (const target of rotated) {
    if (clientGone) break;
    const provider = target.provider;
    const upstreamModel = target.upstreamModel;
    const maxAttempts = Math.max(1, (PROVIDER_KEYS[provider] || []).length);

    // Serialise body once per provider target
    const bodyObj = { ...bodyTemplate, model: `${provider}/${upstreamModel}` };
    if (!supportsReasoningContent(provider, upstreamModel) && Array.isArray(bodyObj.messages)) {
      bodyObj.messages = sanitizeMessages(bodyObj.messages);
    }
    const bodyStr = JSON.stringify(bodyObj);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (clientGone) break outer;
      usedKey = selectKey(provider);
      if (!usedKey) { log(`[${logId}] ${provider}/${upstreamModel} → no key`); break; }

      try {
        const acceptHdr = isStream ? 'text/event-stream' : 'application/json';
        upstreamRes = await forwardToGateway(usedKey, bodyStr, '/compat/chat/completions', acceptHdr);
        usedProvider = provider;
        usedModel = upstreamModel;
        const sc = upstreamRes.statusCode;

        if (sc === 429 || sc >= 500) {
          const body = await collectBody(upstreamRes);
          log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  attempt=${attempt+1}/${maxAttempts}  key=...${usedKey.slice(-4)}`);
          markKeyError(provider, usedKey);
          lastErr = { status: sc, body };
          upstreamRes = null;
          if (sc === 429) await sleep(1000);
          continue;
        }

        if (sc >= 400) {
          const body = await collectBody(upstreamRes);
          log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${usedKey.slice(-4)}  ${body.slice(0, 100)}`);
          lastErr = { status: sc, body };
          upstreamRes = null;
          break;
        }

        // Success
        markKeySuccess(provider, usedKey);
        log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${usedKey.slice(-4)}`);
        break outer;

      } catch (e) {
        log(`[${logId}] ${provider}/${upstreamModel} → error  attempt=${attempt+1}/${maxAttempts}  ${e.message}`);
        markKeyError(provider, usedKey);
        lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
        upstreamRes = null;
      }
    }
  }

  if (!upstreamRes || !usedProvider) {
    // --- CF all failed → try free keys as last resort ---
    if (cfg.free_keys?.enabled && !clientGone) {
      const freeTargets = getFreeKeyTargets(clientModel);
      if (freeTargets.length > 0) log(`[${logId}] fallback: ${freeTargets.map(t => `${t.provider}/${t.upstreamModel}`).join(' > ')}`);
      for (const ft of freeTargets) {
        if (clientGone) break;
        const fbBody = { ...bodyTemplate, model: ft.upstreamModel };
        if (!supportsReasoningContent(ft.provider, ft.upstreamModel) && Array.isArray(fbBody.messages)) {
          fbBody.messages = sanitizeMessages(fbBody.messages);
        }
        const bodyStr = JSON.stringify(fbBody);
        for (const key of ft.keys) {
          if (clientGone) break;
          try {
            const acceptHdr = isStream ? 'text/event-stream' : 'application/json';
            upstreamRes = await forwardToDirect(key, bodyStr, ft.base_url, 'chat/completions', acceptHdr);
            usedProvider = ft.provider;
            usedModel = ft.upstreamModel;
            const sc = upstreamRes.statusCode;
            if (sc === 429 || sc >= 500) {
              const bd = await collectBody(upstreamRes);
              log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → ${sc}  key=...${key.slice(-4)}`);
              lastErr = { status: sc, body: bd };
              upstreamRes = null;
              if (sc === 429) await sleep(1000);
              continue;
            }
            if (sc >= 400) {
              const bd = await collectBody(upstreamRes);
              log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → ${sc} skip  key=...${key.slice(-4)}  ${bd.slice(0,100)}`);
              lastErr = { status: sc, body: bd };
              upstreamRes = null;
              break;
            }
            log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → ${sc}  key=...${key.slice(-4)}`);
            break;
          } catch (e) {
            log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → error  ${e.message}`);
            lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
            upstreamRes = null;
          }
        }
        if (upstreamRes) break;
      }
    }
  }

  if (!upstreamRes || !usedProvider) {
    const errMsg = lastErr ? (typeof lastErr.body === 'string' ? lastErr.body.slice(0, 300) : JSON.stringify(lastErr.body).slice(0, 300)) : 'no upstream';
    const sc = lastErr?.status || 502;
    log(`[${logId}] ← ${sc}  all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
    res.writeHead(sc, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `all failed: ${errMsg}` } }));
    return;
  }

  // --- success path ---
  log(`[${logId}] ← 200  ${((Date.now()-t0)/1000).toFixed(1)}s  ${usedProvider}/${usedModel}`);

  if (isStream) {
    // SSE streaming response
    const needModelRewrite = usedModel !== clientModel;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': logId,
      'X-Provider': usedProvider,
      'X-Upstream-Model': usedModel,
    });

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

// ============================================================
//  GENERIC PROXY  (embeddings, images, audio, etc.)
// ============================================================

/**
 * Generic proxy for non-chat endpoints.
 * @param {string} endpointPath  - Gateway sub-path, e.g. '/embeddings', '/images/generations'
 * @param {boolean} [jsonBody]   - Whether request body is JSON (true) or raw (false)
 */
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
  const activeTargets = CF_CONFIGURED ? targets.filter(t => PROVIDERS_WITH_KEYS.has(t.provider)) : [];
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
    if (clientGone) break;
    const { provider, upstreamModel } = target;
    const key = selectKey(provider);
    if (!key) { log(`[${logId}] ${provider}/${upstreamModel} → no key`); continue; }

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
      if (clientGone) return;
      const sc = upstreamRes.statusCode;

      if (sc >= 200 && sc < 300) {
        markKeySuccess(provider, key);
        log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${key.slice(-4)}  ${((Date.now()-t0)/1000).toFixed(1)}s`);
        // Forward response headers & body
        const ctype = upstreamRes.headers['content-type'] || 'application/json';
        const body = await collectBody(upstreamRes);
        res.writeHead(sc, { 'Content-Type': ctype, 'X-Request-Id': logId, 'X-Provider': provider });
        res.end(body);
        return;
      }

      // Upstream error
      const body = await collectBody(upstreamRes);
      if (sc === 429 || sc >= 500) {
        log(`[${logId}] ${provider}/${upstreamModel} → ${sc}  key=...${key.slice(-4)}`);
        markKeyError(provider, key);
        lastErr = { status: sc, body };
        if (sc === 429) await sleep(1000);
        continue;
      }

      // Upstream client error — skip to next target (provider may not support this endpoint)
      log(`[${logId}] ${provider}/${upstreamModel} → ${sc} skip  key=...${key.slice(-4)}  ${body.slice(0, 100)}`);
      lastErr = { status: sc, body };
      continue;

    } catch (e) {
      log(`[${logId}] ${provider}/${upstreamModel} → error  ${e.message}`);
      markKeyError(provider, key);
      lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
    }
  }

  // All attempts exhausted
  if ((lastErr || activeTargets.length === 0) && cfg.free_keys?.enabled && !clientGone) {
    const freeTargets = getFreeKeyTargets(clientModel);
    if (freeTargets.length > 0) log(`[${logId}] freekey fallback: ${freeTargets.map(t => `${t.provider}/${t.upstreamModel}`).join(' > ')}`);
    for (const ft of freeTargets) {
      if (clientGone) break;
      for (const key of ft.keys) {
        if (clientGone) break;
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
        } catch (e) {
          log(`[${logId}] ${ft.provider}/${ft.upstreamModel} → error  ${e.message}`);
        }
      }
    }
  }

  const sc = lastErr?.status || 502;
  log(`[${logId}] ← ${sc}  all failed  ${((Date.now()-t0)/1000).toFixed(1)}s`);
  res.writeHead(sc, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `all upstream providers failed`, type: 'proxy_error' } }));
}

// ============================================================
//  HTTP SERVER
// ============================================================

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
      // Check for premature destroy
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

server.listen(PORT, () => {
  log(`[config] started port=${PORT} account=${ACCOUNT_ID || '(degraded)'} gateway=${GATEWAY_NAME || '(degraded)'}`);
  const summary = Object.entries(PROVIDER_KEYS).map(([p, ks]) => `${p}:${ks.length}`).join(' ');
  log(`[config] keys ${summary}`);
  log(`[config] timeout=${(TIMEOUT_MS/1000).toFixed(0)}s cooldown=${(KEY_COOLDOWN_MS/1000).toFixed(0)}s maxBody=${(MAX_BODY_SIZE/1024/1024).toFixed(1)}MB`);
  if (cfg.free_keys?.enabled) setTimeout(() => fetchFreeKeys(), 3000);
});

// --- graceful config reload ---
if (fs.existsSync(CONFIG_PATH)) {
  let reloadTimer = null;
  fs.watch(CONFIG_PATH, (event) => {
    if (event === 'change' && !reloadTimer) {
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
