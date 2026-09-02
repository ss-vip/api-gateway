'use strict';

// --- JSONC Parser ---
function parseJsonc(str) {
  if (!str) return null;
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

function _jsonValid(s) {
  if (!s) return { ok: true };
  try { JSON.parse(s); return { ok: true }; }
  catch (e1) {
    try { const r = parseJsonc(s); return r !== null ? { ok: true } : { ok: false, error: e1.message }; }
    catch (e2) { return { ok: false, error: e1.message }; }
  }
}

function _ndjsonValid(s) {
  if (!s) return { ok: true };
  let lineNo = 0;
  for (const rawLine of s.split('\n')) {
    const l = rawLine.trim();
    if (!l) continue;
    lineNo++;
    try { JSON.parse(l); } catch (e) { return { ok: false, error: `line ${lineNo}: ${e.message}` }; }
  }
  return { ok: true };
}

function _autoFixJson(s) {
  if (!s) return null;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length) { if (s[i] === '\\') i++; else if (s[i] === '"') break; i++; }
      continue;
    }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      const open = stack.pop();
      if (!open || (open === '{' && c !== '}') || (open === '[' && c !== ']')) return null;
    }
  }
  if (!stack.length) return null;
  let fixed = s;
  for (let i = stack.length - 1; i >= 0; i--) fixed += stack[i] === '{' ? '}' : ']';
  return parseJsonc(fixed) !== null ? fixed : null;
}

// --- Error message extraction ---
function _errMsg(body, logBodyMax) {
  if (!body) return '-';
  const raw = typeof body === 'string' ? body : body.toString();
  const clean = raw.replace(/^\ufeff/, '').trim().replace(/\n/g, ' ');
  if (/^</i.test(clean)) return 'upstream returned HTML (' + Buffer.byteLength(raw) + ' bytes)';
  if (clean.length > logBodyMax) return clean.slice(0, logBodyMax) + '... (' + raw.length + ' chars)';
  try {
    const p = JSON.parse(clean);
    const r = Array.isArray(p) ? p[0] : p;
    const msg = r?.error?.message || r?.error?.type || r?.message;
    if (msg && typeof msg === 'string') return msg.replace(/\n/g, ' ').slice(0, logBodyMax);
  } catch {
    try {
      const escaped = clean.replace(/("(?:[^"\\]|\\.)*")/g, s => s.replace(/\n/g, '\\n'));
      const p = JSON.parse(escaped);
      const r = Array.isArray(p) ? p[0] : p;
      const msg = r?.error?.message || r?.error?.type || r?.message;
      if (msg && typeof msg === 'string') return msg.replace(/\n/g, ' ').slice(0, logBodyMax);
    } catch {}
  }
  return clean.replace(/\n/g, ' ').slice(0, logBodyMax);
}

// --- Quota error detection ---
const QUOTA_RE = /quota|insufficient|credit|billing|subscription|free[_ ]usage[_ ]exceeded/i;
function _isQuotaError(status, body) {
  if (status !== 429 && status !== 403) return false;
  const s = typeof body === 'string' ? body : JSON.stringify(body || '');
  return QUOTA_RE.test(s);
}

// --- Token estimation ---
function estimateStrTokens(str) {
  const cjk = (str.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
  const nonCjk = str.length - cjk;
  return Math.ceil(nonCjk / 4 * 1.2 + cjk / 1.5 * 1.2);
}

function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let est = 0, images = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') {
      est += estimateStrTokens(c);
    } else if (c && typeof c === 'object') {
      const parts = Array.isArray(c) ? c : [c];
      for (const p of parts) {
        if (p.text) est += estimateStrTokens(p.text);
        if (p.type === 'image_url') images++;
      }
    }
  }
  return est + images * 1000;
}

// --- Chat body validation ---
function validateChatBody(body) {
  if (!body || typeof body !== 'object') return 'invalid request body';
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) return 'messages must be a non-empty array';
  if (!body.model || typeof body.model !== 'string') return 'model is required';
  const hasNonEmptyContent = (msg) => {
    if (typeof msg.content === 'string') return msg.content !== '';
    if (Array.isArray(msg.content)) {
      return msg.content.some(block => block && block.type === 'text' && block.text && block.text.trim() !== '');
    }
    return false;
  };
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!msg || typeof msg !== 'object') return `messages[${i}] must be an object`;
    if (typeof msg.role !== 'string' || !msg.role) return `messages[${i}].role is required`;
    if (msg.role === 'assistant') {
      const hasContent = hasNonEmptyContent(msg) || (msg.reasoning_content && msg.reasoning_content !== '');
      if (!hasContent && (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0))
        return `messages[${i}].content or tool_calls required for assistant`;
    } else if (msg.role === 'tool') {
      if (!msg.tool_call_id) return `messages[${i}].tool_call_id required`;
      if (msg.content === undefined) msg.content = '';
    } else {
      if (!msg.content && msg.content !== '') return `messages[${i}].content is required`;
    }
  }
  return null;
}

// --- Non-text content detection ---
function _hasNonTextContent(msgs) {
  return Array.isArray(msgs) && msgs.some(m => Array.isArray(m.content) && m.content.some(c => c?.type && c.type !== 'text'));
}

// --- Drop invalid image parts ---
function _dropInvalidImageParts(msgs) {
  let dropped = 0;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!Array.isArray(m.content)) continue;
      const before = m.content.length;
      m.content = m.content.filter(c => {
        if (c?.type === 'image_url') {
          const u = c.image_url?.url;
          const ok = typeof u === 'string' && (u.trim().startsWith('data:') || /^https?:\/\//i.test(u));
          if (!ok) return false;
        }
        return true;
      });
      dropped += before - m.content.length;
      if (m.content.length === 0) {
        if (m.tool_calls?.length) delete m.content;
        else m.content = [{ type: 'text', text: '.' }];
      }
    }
  }
  return dropped;
}

// --- Tool ID sanitization ---
function _sanitizeToolIds(msg, idMap) {
  const m = { ...msg };
  const validId = /^[a-zA-Z0-9]{9}$/;
  const remap = (id) => {
    if (!id || validId.test(id)) return id;
    if (idMap.has(id)) return idMap.get(id);
    const nid = (Math.random().toString(36).slice(2)+'000000000').slice(0,9);
    idMap.set(id, nid);
    return nid;
  };
  if (m.role === 'tool' && m.tool_call_id) m.tool_call_id = remap(m.tool_call_id);
  if (m.role === 'assistant' && Array.isArray(m.tool_calls))
    m.tool_calls = m.tool_calls.map(tc => tc.id ? { ...tc, id: remap(tc.id) } : tc);
  return m;
}

const _NVIDIA_ASSISTANT_CONTENT = '.\n';
function normalizeMessageOrder(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const idMap = new Map();
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'tool' && messages[i].role === 'user') {
      out.push({ role: 'assistant', content: _NVIDIA_ASSISTANT_CONTENT });
    }
    const msg = _sanitizeToolIds(messages[i], idMap);
    if (msg.role === 'assistant' && !msg.content && !msg.reasoning_content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      throw new Error('400 assistant message requires content or tool_calls');
    }
    out.push(msg);
  }
  return out;
}

// --- Utility functions ---
function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (n, u) => n > 0 ? `${n}${u}` : '';
  return [p(d, 'd'), p(h, 'h'), p(m, 'm'), p(s, 's')].filter(Boolean).join(' ') || '0s';
}

function logKey(k) { return k ? `...${k.slice(-4)}` : '-'; }

function _safeSlice(str, len) {
  const s = String(str).slice(0, len);
  const lc = s.charCodeAt(s.length - 1);
  return (lc >= 0xD800 && lc <= 0xDFFF) ? s.slice(0, -1) : s;
}

function rewriteModelInSse(chunk, toModel) {
  if (!toModel) return chunk;
  const s = chunk.toString();
  if (/^\s*data:\s*\{[^}]*"error"\s*:/.test(s)) return s;
  return s.replace(/([{,]\s*)"model"\s*:\s*"[^"]+"/g, `$1"model":"${toModel}"`);
}

// --- Model resolution (factory functions to inject config) ---
function createModelResolver(modelEntries) {
  return function resolveModel(clientModel) {
    const m = (clientModel || '').toLowerCase();
    for (const [key, value] of modelEntries) {
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
  };
}

function createEndpointResolver(modelEntries, endpointFallbacks) {
  const resolveModel = createModelResolver(modelEntries);
  return function resolveModelForEndpoint(clientModel, endpointPath) {
    let t = clientModel ? resolveModel(clientModel) : null;
    if (!t && endpointPath) {
      const alias = endpointFallbacks[endpointPath];
      if (alias) t = resolveModel(alias);
    }
    return t || null;
  };
}

// --- Fetch remote images and convert to base64 data URI ---
let _allowedImageOrigins = [];

function setAllowedImageOrigins(origins) {
  if (Array.isArray(origins) && origins.length) {
    _allowedImageOrigins = origins.map(o => o.replace(/\/+$/, '').toLowerCase());
  }
}

async function _fetchAndConvertImages(messages) {
  if (!Array.isArray(messages)) return 0;
  let converted = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== 'image_url' || !part.image_url?.url) continue;
      const url = part.image_url.url.trim();
      if (!url || url.startsWith('data:')) continue;
      let allowed = false;
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' && _allowedImageOrigins.length) {
          const host = u.protocol + '//' + u.host;
          allowed = _allowedImageOrigins.some(o => host === o || host.endsWith('.' + o.slice(u.protocol.length + 2)));
        }
      } catch {}
      if (!allowed) continue;
      try {
        // lgtm[js/ssrf]
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!resp.ok) continue;
        const contentType = resp.headers.get('content-type') || 'image/png';
        if (!/^image\//i.test(contentType)) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) continue;
        part.image_url.url = `data:${contentType};base64,${buf.toString('base64')}`;
        converted++;
      } catch {}
    }
  }
  return converted;
}

module.exports = {
  parseJsonc,
  _jsonValid,
  _ndjsonValid,
  _autoFixJson,
  _errMsg,
  _isQuotaError,
  QUOTA_RE,
  estimateStrTokens,
  estimateTokens,
  validateChatBody,
  _hasNonTextContent,
  _dropInvalidImageParts,
  _sanitizeToolIds,
  normalizeMessageOrder,
  formatUptime,
  logKey,
  _safeSlice,
  rewriteModelInSse,
  createModelResolver,
  createEndpointResolver,
  _fetchAndConvertImages,
  setAllowedImageOrigins,
};
