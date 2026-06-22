'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let cfg = {};
try {
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  console.error('[config] failed to load config.json:', e.message);
}

const ACCOUNT_ID   = process.env.ACCOUNT_ID   || cfg.account_id   || '';
const GATEWAY_NAME = process.env.GATEWAY_NAME || cfg.gateway_name || '';
const CF_CONFIGURED = !!(ACCOUNT_ID && GATEWAY_NAME);
if (!CF_CONFIGURED) {
  console.warn('[config] ACCOUNT_ID / GATEWAY_NAME not set — running degraded (chat will 502)');
}

const CLIENT_TOKEN = process.env.CLIENT_TOKEN || cfg.client_token || '';

const PROVIDER_KEYS = { ...(cfg.providers || {}) };

const ENV_MAP = {
  GEMINI_KEYS:'google-ai-studio', MISTRAL_KEYS:'mistral', CEREBRAS_KEYS:'cerebras',
  OPENAI_KEYS:'openai', ANTHROPIC_KEYS:'anthropic', DEEPSEEK_KEYS:'deepseek',
  GROK_KEYS:'grok', TOGETHER_KEYS:'together', OPENROUTER_KEYS:'openrouter',
};
for (const [ev, p] of Object.entries(ENV_MAP)) {
  const v = process.env[ev];
  if (v) PROVIDER_KEYS[p] = v.split(',').map(s => s.trim()).filter(Boolean);
}

const MODELS = cfg.models || {};
const MODEL_ENTRIES = Object.entries(MODELS).sort((a, b) => b[0].length - a[0].length);

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

const PORT            = parseInt(process.env.PORT   || cfg.port   || '3000', 10);
const TIMEOUT_MS      = parseInt(process.env.TIMEOUT || cfg.timeout || '600000', 10);
const KEY_COOLDOWN_MS = parseInt(process.env.KEY_COOLDOWN || cfg.key_cooldown || '30000', 10);
const MAX_KEY_BACKOFF = parseInt(process.env.MAX_KEY_BACKOFF || cfg.max_key_backoff || '300000', 10);
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || cfg.log_retention_days || '0', 10);
const CF_API_TOKEN = process.env.CF_API_TOKEN || cfg.cf_api_token || '';

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

function forwardToGateway(provider, apiKey, body) {
  return new Promise((resolve, reject) => {
    const bodyObj = JSON.parse(body);
    bodyObj.model = `${provider}/${bodyObj.model}`;
    const newBody = JSON.stringify(bodyObj);
    const opts = {
      hostname: cfg.gateway_base_url || 'gateway.ai.cloudflare.com',
      port: 443,
      path: `/v1/${ACCOUNT_ID}/${GATEWAY_NAME}/compat/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream',
      },
      timeout: TIMEOUT_MS,
    };
    const req = https.request(opts, resolve);
    req.on('error', (e) => reject(e.name === 'AbortError' ? new Error('aborted') : e));
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.write(newBody);
    req.end();
  });
}

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
      if (!ok) console.error(`[cleanup] ${res.statusCode} ${body.slice(0, 200)}`);
    });
  });
  req.on('error', (e) => console.error(`[cleanup] ${e.message}`));
  req.end();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function rid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

async function handleChatCompletion(req, res, bodyJson, logId) {
  if (!CF_CONFIGURED) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'gateway not configured — set ACCOUNT_ID and GATEWAY_NAME', type: 'not_configured' } }));
    return;
  }
  const clientModel = bodyJson.model || 'unknown';
  const targets = resolveModel(clientModel);

  if (!targets) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `model '${clientModel}' not supported`, type: 'unsupported_model' } }));
    return;
  }

  console.log(`[${logId}] → ${clientModel} msgs=${(bodyJson.messages || []).length}`);

  const rotated = rotateTargets(targets, clientModel);
  if (rotated.length > 1) console.log(`[${logId}] order: ${rotated.map(t => `${t.provider}/${t.upstreamModel}`).join(' > ')}`);

  let lastErr = null, upstreamRes = null, usedProvider = null, usedKey = null;
  let usedModel = null;
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  outer: for (const target of rotated) {
    if (clientGone) break;
    const provider = target.provider;
    const upstreamModel = target.upstreamModel;
    const maxAttempts = Math.max(1, (PROVIDER_KEYS[provider] || []).length);

    const bodyClone = { ...bodyJson, model: upstreamModel, stream: true };
    const requestBody = JSON.stringify(bodyClone);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (clientGone) break outer;
      usedKey = selectKey(provider);
      if (!usedKey) { console.log(`[${logId}] ${provider}/${upstreamModel} no healthy key`); break; }

      try {
        upstreamRes = await forwardToGateway(provider, usedKey, requestBody);
        usedProvider = provider;
        usedModel = upstreamModel;
        const sc = upstreamRes.statusCode;

        if (sc === 429 || sc >= 500) {
          const body = await collectBody(upstreamRes);
          console.log(`[${logId}] ${provider}/${upstreamModel} ${sc} attempt=${attempt+1}/${maxAttempts} body=${body.slice(0, 200)}`);
          markKeyError(provider, usedKey);
          lastErr = { status: sc, body };
          upstreamRes = null;
          if (sc === 429) await sleep(1000);
          continue;
        }

        if (sc >= 400) {
          const body = await collectBody(upstreamRes);
          console.log(`[${logId}] ${provider}/${upstreamModel} ${sc} non-retryable body=${body.slice(0, 200)}`);
          lastErr = { status: sc, body };
          upstreamRes = null;
          break;
        }

        markKeySuccess(provider, usedKey);
        console.log(`[${logId}] ${provider}/${upstreamModel} 200 key=...${usedKey.slice(-4)}`);
        break outer;

      } catch (e) {
        console.log(`[${logId}] ${provider}/${upstreamModel} error: ${e.message} attempt=${attempt+1}/${maxAttempts}`);
        markKeyError(provider, usedKey);
        lastErr = { status: 502, body: JSON.stringify({ error: { message: e.message } }) };
        upstreamRes = null;
      }
    }
  }

  if (!upstreamRes || !usedProvider) {
    const errMsg = lastErr ? (typeof lastErr.body === 'string' ? lastErr.body.slice(0, 300) : JSON.stringify(lastErr.body).slice(0, 300)) : 'no upstream';
    res.writeHead(lastErr?.status || 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `all failed: ${errMsg}` } }));
    return;
  }

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
  upstreamRes.on('error', (e) => { console.log(`[${logId}] stream: ${e.message}`); try { res.end(); } catch {} });
  req.on('close', () => { if (upstreamRes && !upstreamRes.destroyed) upstreamRes.destroy(); });
}

const server = http.createServer((req, res) => {
  const logId = rid();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (CLIENT_TOKEN) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== CLIENT_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'auth_error' } }));
      return;
    }
  }

  if (req.url === '/health' || req.url === '/v1/health') {
    cleanupOldLogs();
    const s = { status: 'ok', uptime: Math.floor(process.uptime()), providers: {}, degraded: [] };
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

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server is working');
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data',  (c) => { body += c; });
    req.on('end', () => {
      let json;
      try { json = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid JSON', type: 'invalid_request' } }));
        return;
      }
      handleChatCompletion(req, res, json, logId);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

Object.keys(PROVIDER_KEYS).forEach(initProvider);

server.timeout = 0;
server.keepAliveTimeout = 0;

server.on('error', (e) => {
  console.error(`[gateway] server error: ${e.message}`);
  if (e.code === 'EADDRINUSE') console.error(`[gateway] port ${PORT} is already in use`);
  setTimeout(() => process.exit(1), 1000).unref();
});

server.listen(PORT, () => {
  console.log(`[gateway] started port=${PORT} account=${ACCOUNT_ID || '(degraded)'} gateway=${GATEWAY_NAME || '(degraded)'}`);
  for (const [p, keys] of Object.entries(PROVIDER_KEYS)) {
    console.log(`[gateway]   ${p}: ${keys.length} key(s)`);
  }
  console.log(`[gateway] timeout=${TIMEOUT_MS}ms cooldown=${KEY_COOLDOWN_MS}ms`);
});

if (fs.existsSync(CONFIG_PATH)) {
  fs.watch(CONFIG_PATH, (event) => {
    if (event === 'change') {
      console.log(`[config] ${path.basename(CONFIG_PATH)} changed — restarting...`);
      setTimeout(() => process.exit(0), 1000).unref();
    }
  });
}

function shutdown(signal) {
  console.log(`\n[gateway] ${signal} — closing...`);
  server.close(() => { console.log('[gateway] done'); process.exit(0); });
  setTimeout(() => { console.error('[gateway] force exit'); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error('[gateway] FATAL:', e.stack); process.exit(1); });
process.on('unhandledRejection', (r) => { console.error('[gateway] REJECTION:', r instanceof Error ? r.stack : r); });
