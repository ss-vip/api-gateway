// ─── Unified Request Logger ──────────────────────────────────────────
// Structured per-request logging with sanitization (API key masking).

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,       // OpenAI-style sk- keys
  /[Bb]earer\s+[a-zA-Z0-9_-]{20,}/g,
  /api[-_]?key['"]?\s*[:=]\s*['"][^'"]{8,}['"]/gi,
];

/**
 * Mask sensitive patterns (API keys, tokens) in a string.
 * Preserves first 4 + last 4 chars for debugging.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskApiKey(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(SENSITIVE_PATTERNS, (match) => {
    if (match.length <= 12) return 'sk-***masked***';
    const prefix = match.startsWith('sk-') ? 'sk-' : '';
    const body = prefix ? match.slice(3) : match;
    if (body.length <= 12) return prefix + '***masked***';
    return prefix + body.slice(0, 4) + '...' + body.slice(-4);
  });
}

/**
 * Sanitize an entire object recursively, masking sensitive fields.
 * Modifies in-place for performance.
 *
 * @param {object} obj
 * @returns {object}
 */
export function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const sensitiveKeys = ['api_key', 'apiKey', 'authorization', 'Authorization',
    'token', 'client_token', 'admin_password', 'password', 'secret'];
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.includes(key) && typeof obj[key] === 'string') {
      if (obj[key].length > 8) {
        obj[key] = obj[key].slice(0, 4) + '...' + obj[key].slice(-4);
      } else {
        obj[key] = '***masked***';
      }
    } else if (typeof obj[key] === 'string') {
      obj[key] = maskApiKey(obj[key]);
    } else if (obj[key] && typeof obj[key] === 'object') {
      sanitizeObject(obj[key]);
    }
  }
  return obj;
}

/**
 * Create a per-request logger bound to a request ID.
 *
 * @param {string} rid - Request ID
 * @returns {{ info, warn, error, data: object }}
 */
export function createRequestLogger(rid) {
  const events = [];
  const startTs = Date.now();

  function log(level, msg, extra = {}) {
    const entry = { ts: Date.now(), rid, level, msg, ...extra };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
    events.push(entry);
  }

  return {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),

    /**
     * Log a sanitized version of the incoming request.
     */
    logRequest: (method, url, body) => {
      const safe = sanitizeObject(body ? JSON.parse(JSON.stringify(body)) : {});
      log('info', 'incoming request', { method, url, bodyKeys: Object.keys(safe) });
    },

    /**
     * Log a sanitized version of the upstream request.
     */
    logUpstream: (chId, url, reqBody) => {
      const safe = sanitizeObject(reqBody ? JSON.parse(JSON.stringify(reqBody)) : {});
      log('info', 'upstream request', { channelId: chId, url, bodyPreview: JSON.stringify(safe).slice(0, 500) });
    },

    /**
     * Log upstream response outcome.
     */
    logUpstreamResponse: (chId, status, durationMs, error) => {
      const extra = { channelId: chId, status, durationMs };
      if (error) {
        extra.error = maskApiKey(String(error).slice(0, 500));
        log('error', 'upstream error', extra);
      } else {
        log('info', 'upstream success', extra);
      }
    },

    /**
     * Get all logged events for this request.
     */
    getEvents: () => events,
    getDuration: () => Date.now() - startTs,
  };
}
