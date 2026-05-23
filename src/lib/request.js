const ERROR_CODE_MAP = {
  auth_error: "invalid_api_key",
  invalid_request_error: "invalid_request_error",
  server_error: "api_error",
  rate_limit_error: "rate_limit_exceeded",
  upstream_error: "upstream_error",
};

export function requestId() {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return "req_" + Array.from(buf).map(b => b.toString(36).padStart(2, "0")).join("");
}

export function logStructured(level, msg, extra = {}) {
  const entry = { ts: Date.now(), level, msg, ...extra };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

export function errResponse(c, message, type, status, code) {
  return c.json({ error: { message, type, param: null, code: code || ERROR_CODE_MAP[type] || type } }, status);
}

export function hasVisionContent(body) {
  if (!body?.messages) return false;
  for (const msg of body.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "image_url") return true;
      }
    }
  }
  return false;
}

export function estimateInputTokens(body) {
  if (!body?.messages) return 0;
  let chars = 0;
  for (const msg of body.messages) {
    if (typeof msg?.content === "string") {
      chars += msg.content.length;
      continue;
    }
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (typeof part?.text === "string") chars += part.text.length;
        else if (part?.type === "image_url") chars += 1024;
        else chars += JSON.stringify(part || {}).length;
      }
      continue;
    }
    chars += JSON.stringify(msg || {}).length;
  }
  if (Array.isArray(body.tools)) chars += Math.min(JSON.stringify(body.tools).length, 20_000);
  return Math.ceil(chars / 4);
}

export function nextToolCallId() {
  // crypto.randomUUID is available in Workers (global) — no shared counter race
  const id = crypto.randomUUID().split("-").join("").slice(0, 28);
  return "call_" + id;
}

/**
 * LobeChat compatibility: some versions emit JSON with a bare array at position 0
 * instead of {"messages": [...]}. This scans on JSON parse failure (~0.5ms/100KB,
 * Free Tier CPU), inserts "messages": before the array, and retries.
 *
 * Decision: KEPT per P7 architecture — transport gateway must tolerate
 * client-side quirks. Cost is negligible (single-pass char scan, only on parse error).
 * Not needed once LobeChat fixes the client, but zero-risk to retain.
 */
export function tryRepairChatJson(text) {
  if (!text || text.length < 3) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastNonWS = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; if (!inString) lastNonWS = '"'; continue; }
    if (inString) continue;

    if (ch === '{') { depth++; lastNonWS = '{'; continue; }
    if (ch === '}') { depth--; lastNonWS = '}'; continue; }
    if (ch === '[') {
      if (depth === 1 && lastNonWS !== ':') {
        const repaired = text.slice(0, i) + '"messages": ' + text.slice(i);
        try { return JSON.parse(repaired); } catch (_) { return null; }
      }
      depth++; lastNonWS = '['; continue;
    }
    if (ch === ']') { depth--; lastNonWS = ']'; continue; }
    if (ch.trim()) lastNonWS = ch;
  }
  return null;
}
