// ─── Error Classification Engine ──────────────────────────────────────
// 9Router-inspired rule-based error classifier.
// Text-based rules have priority over status-based rules.
// Each rule defines: match condition, error type, and recovery action.

/**
 * @typedef {Object} ErrorRule
 * @property {RegExp} [match] - Text pattern to match against error message
 * @property {number[]} [status] - HTTP status codes to match
 * @property {string} type - Error category: rate_limit | quota | transient | auth | permanent
 * @property {string} action - Recovery action: cooldown_60s | cooldown_5m | cooldown_24h | retry_3x | retry_1x | disable
 */

const ERROR_RULES = [
  // ── Text-based rules (priority) ──
  { match: /rate limit|rate_limit|too many requests|429/i,   type: 'rate_limit',    action: 'cooldown_5m' },
  { match: /quota|insufficient_quota|quota_exceeded/i,         type: 'quota',         action: 'cooldown_24h' },
  { match: /exceeded.*tokens|tokens.*limit/i,                  type: 'quota',         action: 'cooldown_5m' },
  { match: /context length|context_length|max.*tokens/i,       type: 'permanent',     action: 'disable' },
  { match: /invalid.*api.*key|auth.*error|unauthorized/i,      type: 'auth',          action: 'disable' },
  { match: /account.*disabled|suspended|banned/i,              type: 'permanent',     action: 'disable' },
  { match: /model.*not.*found|not.*support|unsupported/i,      type: 'permanent',     action: 'retry_1x' },
  { match: /timeout|timed.?out/i,                              type: 'transient',     action: 'retry_3x' },
  { match: /overloaded|server.*error|internal/i,               type: 'transient',     action: 'retry_3x' },
  { match: /bad gateway|502|service.*unavail|503/i,            type: 'transient',     action: 'retry_3x' },
  { match: /upstream.*error|origin.*error|upstream/i,          type: 'transient',     action: 'retry_3x' },

  // ── Status-based rules (fallback) ──
  { status: [429],                                             type: 'rate_limit',    action: 'cooldown_5m' },
  { status: [502, 503, 504],                                   type: 'transient',     action: 'retry_3x' },
  { status: [500],                                             type: 'transient',     action: 'retry_1x' },
  { status: [401, 403],                                        type: 'auth',          action: 'disable' },
  { status: [400],                                             type: 'permanent',     action: 'retry_1x' },
];

const DEFAULT_RULE = { type: 'transient', action: 'retry_1x' };

/**
 * Classify an upstream error by message text and HTTP status.
 * Text-based rules take priority.
 *
 * @param {number} status - HTTP status code (0 or null if connection error)
 * @param {string} message - Error message from upstream
 * @returns {{ type: string, action: string, matchedBy: string }}
 */
export function classifyError(status, message) {
  const text = String(message || '');
  
  // Text rules first
  for (const rule of ERROR_RULES) {
    if (rule.match && rule.match.test(text)) {
      return { type: rule.type, action: rule.action, matchedBy: 'text' };
    }
  }
  
  // Status rules second
  if (status) {
    for (const rule of ERROR_RULES) {
      if (rule.status && rule.status.includes(status)) {
        return { type: rule.type, action: rule.action, matchedBy: 'status' };
      }
    }
  }
  
  return { type: DEFAULT_RULE.type, action: DEFAULT_RULE.action, matchedBy: 'default' };
}

/**
 * Calculate cooldown seconds based on error type and consecutive count.
 *
 * @param {string} errorType - From classifyError
 * @param {number} consecutiveErrors - Current consecutive error count
 * @returns {number} Cooldown in seconds
 */
export function cooldownFor(errorType, consecutiveErrors) {
  switch (errorType) {
    case 'rate_limit':   return Math.min(60 * Math.pow(2, consecutiveErrors - 4), 3600);
    case 'quota':        return 86400; // 24h
    case 'auth':
    case 'permanent':    return 86400 * 7; // 7d (effectively disabled)
    case 'transient':
    default:             return Math.min(5 * Math.pow(2, Math.min(consecutiveErrors - 1, 4)), 300);
  }
}
