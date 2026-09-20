'use strict';

const crypto = require('crypto');

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
    // crypto-based 9-char alphanumeric id — replaces Math.random() (collision-hardened for tool-call-heavy traffic)
    const _ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const nid = Array.from(crypto.randomBytes(9), (b) => _ALNUM[b % 62]).join('');
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
          return value.map(t => {
            const r = { provider: t.provider, upstreamModel: t.model || clientModel };
            if (t.endpoint) r.endpoint = t.endpoint;
            if (t.fallback) r.fallback = t.fallback;
            return r;
          });
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
  if (typeof fetch === 'undefined') return 0; // Node < 18 — skip remote image fetch
  if (!Array.isArray(messages)) return 0;
  let converted = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== 'image_url' || !part.image_url?.url) continue;
      const raw = part.image_url.url.trim();
      if (!raw || raw.startsWith('data:')) continue;
      let safeUrl = null;
      try {
        const u = new URL(raw);
        if (u.protocol === 'https:' && _allowedImageOrigins.length) {
          const reqHost = u.hostname;
          for (const o of _allowedImageOrigins) {
            const originHost = o.slice('https://'.length);
            if (reqHost === originHost || reqHost.endsWith('.' + originHost)) {
              // note: origin is server-controlled, path from parsed URL
              safeUrl = o + u.pathname;
              break;
            }
          }
        }
      } catch {}
      if (!safeUrl) continue;
      try {
        const resp = await fetch(safeUrl, { signal: AbortSignal.timeout(10000), redirect: 'error' });
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

// --- Chat ↔ Responses conversion (for providers reachable only through one shape) ---
function _chatTextParts(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  return '';
}

function _mapChatTool(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.type === 'function' && t.function && typeof t.function.name === 'string') {
    const r = { type: 'function', name: t.function.name };
    if (t.function.description !== undefined) r.description = t.function.description;
    if (t.function.parameters !== undefined) r.parameters = t.function.parameters;
    if (t.function.strict !== undefined) r.strict = t.function.strict;
    return r;
  }
  return { ...t }; // note: non-function tool types pass through untouched
}

function _mapChatToolChoice(c) {
  if (c === 'auto') return 'auto';
  // note: upstream only supports auto — required/named degrade to auto, none is honored by withholding tools
  if (c === 'required') return 'auto';
  if (c && c.type === 'function' && c.function && typeof c.function.name === 'string') return 'auto';
  return undefined;
}

// Translates chat messages to responses input items. ok=false → caller keeps legacy last-user-text fallback.
function _chatMessagesToInput(messages) {
  const input = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') return { ok: false };
    if (m.role === 'system' || m.role === 'developer' || m.role === 'user') {
      if (typeof m.content !== 'string') return { ok: false };
      input.push({ role: m.role, content: m.content });
    } else if (m.role === 'assistant') {
      const text = _chatTextParts(m.content);
      if (text) input.push({ role: 'assistant', content: text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || tc.type !== 'function' || !tc.function || typeof tc.function.name !== 'string') return { ok: false };
          input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}) });
        }
      } else if (!text) {
        return { ok: false };
      }
    } else if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string') return { ok: false };
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null) });
    } else {
      return { ok: false };
    }
  }
  return { ok: true, input };
}

function chatToResponses(bodyObj) {
  const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
  const mapped = _chatMessagesToInput(msgs);
  let input;
  if (mapped.ok && mapped.input.length > 0) {
    input = mapped.input;
  } else {
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    input = _chatTextParts(lastUser && lastUser.content) || 'hi';
  }
  const want = Number(bodyObj.max_tokens || bodyObj.max_output_tokens || 500) || 500;
  // note: reasoning models spend the output budget on thinking — small limits return empty text, keep headroom
  const out = { model: bodyObj.model, input, max_output_tokens: Math.max(want + 512, 1024) };
  if (bodyObj.reasoning) out.reasoning = bodyObj.reasoning;
  if (bodyObj.tool_choice !== 'none' && Array.isArray(bodyObj.tools)) {
    const tools = bodyObj.tools.map(_mapChatTool).filter(Boolean);
    if (tools.length > 0) out.tools = tools;
  }
  const choice = _mapChatToolChoice(bodyObj.tool_choice);
  if (choice !== undefined) out.tool_choice = choice;
  if (bodyObj.response_format && typeof bodyObj.response_format === 'object') {
    const rf = bodyObj.response_format;
    if (rf.type === 'json_object') {
      out.text = { format: { type: 'json_object' } };
    } else if (rf.type === 'json_schema' && rf.json_schema && typeof rf.json_schema === 'object') {
      const js = rf.json_schema;
      const fmt = { type: 'json_schema', name: js.name || 'response', schema: js.schema || {} };
      if (js.strict !== undefined) fmt.strict = js.strict;
      out.text = { format: fmt };
    }
  }
  if (bodyObj.temperature !== undefined) out.temperature = bodyObj.temperature;
  if (bodyObj.top_p !== undefined) out.top_p = bodyObj.top_p;
  return out;
}

// --- Chat → Anthropic Messages conversion ---
function _chatContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const blocks = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') {
      blocks.push({ type: 'text', text: p.text });
    } else if (p.type === 'image_url' && p.image_url?.url) {
      const url = String(p.image_url.url);
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(url);
      if (m) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      } else if (/^https?:\/\//i.test(url)) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
      // note: non-http non-data image urls are dropped (already filtered upstream)
    }
  }
  return blocks.length ? blocks : null;
}

function _mapChatToolToAnthropic(t) {
  if (!t || typeof t !== 'object') return null;
  const fn = t.type === 'function' ? t.function : t;
  if (!fn || typeof fn.name !== 'string') return null;
  const r = { name: fn.name };
  if (fn.description !== undefined) r.description = fn.description;
  r.input_schema = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object' };
  return r;
}

function chatToAnthropic(bodyObj) {
  const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
  const systemParts = [];
  const messages = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = _chatTextParts(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'user') {
      const c = _chatContentToAnthropic(m.content);
      if (c !== null) messages.push({ role: 'user', content: c });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = _chatTextParts(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || tc.type !== 'function' || !tc.function || typeof tc.function.name !== 'string') continue;
          let input = {};
          try { input = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); } catch { input = {}; }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'tool') {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null);
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: c }] });
      continue;
    }
  }
  if (!messages.length) {
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    messages.push({ role: 'user', content: _chatTextParts(lastUser && lastUser.content) || 'hi' });
  }
  // note: Anthropic requires a non-empty user-first turn; merge leading non-user blocks
  const out = { model: bodyObj.model, max_tokens: Number(bodyObj.max_tokens) || 1024, messages };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (bodyObj.temperature !== undefined) out.temperature = bodyObj.temperature;
  if (bodyObj.top_p !== undefined) out.top_p = bodyObj.top_p;
  if (bodyObj.stop !== undefined) out.stop_sequences = Array.isArray(bodyObj.stop) ? bodyObj.stop : [bodyObj.stop];
  if (bodyObj.tool_choice !== 'none' && Array.isArray(bodyObj.tools)) {
    const tools = bodyObj.tools.map(_mapChatToolToAnthropic).filter(Boolean);
    if (tools.length) {
      out.tools = tools;
      if (bodyObj.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
      else if (bodyObj.tool_choice === 'required') out.tool_choice = { type: 'any' };
      else if (bodyObj.tool_choice && typeof bodyObj.tool_choice === 'object' && bodyObj.tool_choice.function?.name) {
        out.tool_choice = { type: 'tool', name: bodyObj.tool_choice.function.name };
      }
    }
  }
  if (bodyObj.stream !== undefined) out.stream = !!bodyObj.stream;
  return out;
}

function responsesOutputToChat(rj, clientModel) {
  const out = rj && Array.isArray(rj.output) ? rj.output : [];
  let text = '';
  const toolCalls = [];
  for (const item of out) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) if (c && c.type === 'output_text' && c.text) text += c.text;
    } else if (item.type === 'function_call' && item.name) {
      toolCalls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } });
    }
  }
  const finish = toolCalls.length > 0 ? 'tool_calls' : (rj && rj.status === 'completed' ? 'stop' : 'length');
  const ru = (rj && rj.usage) || {};
  const usage = { prompt_tokens: ru.input_tokens || 0, completion_tokens: ru.output_tokens || 0, total_tokens: ru.total_tokens || (ru.input_tokens || 0) + (ru.output_tokens || 0) };
  return { text, toolCalls, finish, usage };
}

// --- opencode free-tier contract ---
// note: upstream checks the session SHAPE (ses_ + 12 hex + 14 base62), not the value — render deterministically so cache affinity survives
function canonOpencodeSession(seed) {
  const hex = crypto.createHash('sha256').update(String(seed ?? '')).digest('hex');
  const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const raw = Buffer.from(hex.slice(12, 40), 'hex');
  let tail = '';
  for (let i = 0; i < 14; i++) tail += B62[raw[i] % 62];
  return `ses_${hex.slice(0, 12)}${tail}`;
}
function isCanonOpencodeSession(s) {
  return typeof s === 'string' && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(s);
}
// note: free tier refuses tool-less requests (names allowlisted upstream, shifts over time) — declare plausible placeholders so plain-chat callers pass the gate
const PLACEHOLDER_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'list', 'task'].map(name => ({
  type: 'function', name, description: 'Do not call this tool.', parameters: { type: 'object', properties: {} },
}));
// note: assemble a responses-SSE stream into an rj-like object for responsesOutputToChat; prefers the completed snapshot, falls back to deltas
function assembleResponsesSSE(sse) {
  const rj = { id: null, status: 'incomplete', output: [], usage: {} };
  const calls = new Map();
  let text = '';
  for (const chunk of String(sse).split(/\n\n+/)) {
    for (const line of chunk.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const ty = ev.type || '';
      if (ty === 'response.output_text.delta' && typeof ev.delta === 'string') {
        text += ev.delta;
      } else if (ty === 'response.output_item.added' && ev.item && ev.item.type === 'function_call') {
        calls.set(ev.item.id, { call_id: ev.item.call_id || ev.item.id, name: ev.item.name || '', args: '' });
      } else if (ty === 'response.function_call_arguments.delta' && ev.item_id && typeof ev.delta === 'string') {
        const c = calls.get(ev.item_id);
        if (c) c.args += ev.delta;
      } else if (ty === 'response.output_item.done' && ev.item && ev.item.type === 'function_call') {
        // note: some servers send the full call here instead of deltas — backfill only untracked ids
        if (!calls.has(ev.item.id)) calls.set(ev.item.id, { call_id: ev.item.call_id || ev.item.id, name: ev.item.name || '', args: typeof ev.item.arguments === 'string' ? ev.item.arguments : '' });
      } else if ((ty === 'response.completed' || ty === 'response.failed' || ty === 'response.incomplete') && ev.response) {
        const r = ev.response;
        if (r.id) rj.id = r.id;
        if (r.status) rj.status = r.status;
        if (r.usage) rj.usage = r.usage;
        if (Array.isArray(r.output) && r.output.length > 0) rj.output = r.output;
      }
    }
  }
  if (rj.output.length === 0) {
    const out = [];
    if (text) out.push({ type: 'message', content: [{ type: 'output_text', text }] });
    for (const c of calls.values()) out.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.args });
    rj.output = out;
  }
  return rj;
}

// --- smart routing helpers (pure) ---
const CHAT_FAMILY_ENDPOINTS = ['/v1/chat/completions', '/v1/responses', '/v1/messages'];
// note: legacy global overflow must not land on audio/image aliases — derive non-chat
// families from endpoint_fallbacks values (config-driven, no new metadata)
function buildNonChatAliases(endpointFallbacks, chatEndpoints = CHAT_FAMILY_ENDPOINTS) {
  const out = new Set();
  for (const [ep, alias] of Object.entries(endpointFallbacks || {})) {
    if (typeof alias !== 'string' || !alias) continue;
    if (!chatEndpoints.includes(ep)) out.add(alias.toLowerCase());
  }
  return out;
}
// note: tiers sorted ascending by max_tokens — first fit wins, none fit → largest (let targetCtx skip decide)
function pickTier(tiers, totalEst) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  for (const t of tiers) {
    if (t && typeof t.max_tokens === 'number' && totalEst <= t.max_tokens) return t;
  }
  return tiers[tiers.length - 1];
}

// --- bounded TTL memoizer (in-process; hard memory cap, PM2-safe by construction) ---
// note: worst-case memory = min(maxEntries × avg entry, maxBytes) + map overhead.
// defaults (2000 entries / 8MB) sit ~3% below a 256MB heap cap — it cannot move total RSS
// meaningfully, and three outer guards still apply: V8 --max-old-space-size, in-app
// MEM_LIMIT_MB (exit 1), PM2 --max-memory-restart. Expired entries are purged lazily.
function createMemoCache({ maxEntries = 2000, maxBytes = 8 * 1024 * 1024, ttlMs = 3600000 } = {}) {
  const map = new Map(); // fp -> { value, exp, bytes } (insertion order = oldest first)
  let bytes = 0, hits = 0, misses = 0, sets = 0;
  function purge(now) {
    for (const [k, e] of map) {
      if (e.exp <= now) { bytes -= e.bytes; map.delete(k); }
    }
  }
  return {
    get(fp, now = Date.now()) {
      const e = map.get(fp);
      if (!e) { misses++; return undefined; }
      if (e.exp <= now) { bytes -= e.bytes; map.delete(fp); misses++; return undefined; }
      map.delete(fp); map.set(fp, e); // LRU touch
      hits++;
      return e.value;
    },
    set(fp, value, now = Date.now()) {
      if (maxEntries <= 0 || maxBytes <= 0) return false;
      let json;
      try { json = typeof value === 'string' ? value : JSON.stringify(value); } catch { return false; }
      if (json == null) return false;
      const b = fp.length + Buffer.byteLength(json);
      if (b > maxBytes) return false; // single entry can never fit — don't cache
      const old = map.get(fp);
      if (old) { bytes -= old.bytes; map.delete(fp); }
      if (++sets % 100 === 0) purge(now);
      for (const [k, e] of map) {
        if (map.size < maxEntries && bytes + b <= maxBytes) break;
        bytes -= e.bytes; map.delete(k);
      }
      map.set(fp, { value, exp: now + ttlMs, bytes: b });
      bytes += b;
      return true;
    },
    stats() { return { hits, misses, entries: map.size, bytes }; },
  };
}

// --- classifier.dev relay client (passive upstream adapter — this throws, caller maps errors) ---
async function classifyTexts({ baseUrl, apiKey, tier = 'fast', timeoutMs = 15000, maxChars = 2000 } = {}, { labels, inputs } = {}) {
  if (typeof fetch === 'undefined') throw new Error('fetch unavailable (Node 18+ required)');
  if (!Array.isArray(labels) || labels.length < 2) throw new Error('classify requires 2+ labels');
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('classify requires 1+ inputs');
  const base = String(baseUrl || 'https://classifier.dev').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const clipped = inputs.map(s => String(s ?? '').slice(0, maxChars));
  const r = await fetch(base, {
    method: 'POST', headers,
    body: JSON.stringify({ inputs: clipped, labels, tier }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const body = await r.text();
  if (r.status === 429) {
    const e = new Error('classifier rate limited');
    e.code = 'classifier_429';
    e.retryAfter = r.headers.get('retry-after');
    throw e;
  }
  if (!r.ok) {
    const e = new Error(`classifier upstream ${r.status}: ${body.slice(0, 200)}`);
    e.code = `classifier_${r.status}`;
    throw e;
  }
  return JSON.parse(body);
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
  chatToResponses,
  chatToAnthropic,
  responsesOutputToChat,
  canonOpencodeSession,
  isCanonOpencodeSession,
  PLACEHOLDER_TOOLS,
  assembleResponsesSSE,
  CHAT_FAMILY_ENDPOINTS,
  buildNonChatAliases,
  pickTier,
  createMemoCache,
  classifyTexts,
};
