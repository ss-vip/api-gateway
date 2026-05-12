// ============================================================
// Adaptive Learning Layer
// Learns from upstream behavior — no hardcoded presets.
// Tracks per-channel: rate limits, recovery patterns,
// feature support (vision/tools/max_tokens/params).
//
// All state is in-memory (per-worker). Lost on cold start,
// but quickly re-learns within each session.
// ============================================================

import { COOLDOWN_MAX_SECONDS } from "./constants.js";

// ============================================================
// Per-Channel State
// ============================================================
const state = new Map();

const FEATURE_EXCLUDE_MS = 600_000; // 10 min feature exclusion
const WEIGHT_RECENT = 0.3;

class AdaptiveState {
  constructor() {
    // Rate limit recovery
    this.consecutive429s = 0;
    this.consecutive503s = 0;
    this.consecutiveErrors = 0;
    this.avg429Recovery = null;
    this.avg503Recovery = null;
    this.avgErrorRecovery = null;
    this.last429At = 0;
    this.last503At = 0;
    this.lastErrorAt = 0;
    this.lastSuccessAt = 0;

    // Feature support (null = unknown, true/false = learned)
    this.vision = null;
    this.tools = null;
    this.requiresMaxTokens = null;
    this.requiresMaxTokensConfidence = 0;

    // Blocked params: when a 400 says "unknown parameter: X"
    this.blockedParams = null; // Set, lazily created

    // Feature exclusion timestamps (when not to use this channel)
    this.excludeVisionUntil = 0;
    this.excludeToolsUntil = 0;
  }
}

function get(id) {
  let s = state.get(id);
  if (!s) { s = new AdaptiveState(); state.set(id, s); }
  return s;
}

// ============================================================
// Retry-After Header Parser
// ============================================================
export function parseRetryAfter(res) {
  const header = res.headers.get("Retry-After");
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) return seconds;
  const ts = Date.parse(header);
  if (!isNaN(ts)) return Math.max(1, Math.round((ts - Date.now()) / 1000));
  return null;
}

// ============================================================
// Adaptive Cooldown
// ============================================================
export function computeCooldown(chId, errorType) {
  const s = get(chId);
  if (errorType === "429") return calc(s.avg429Recovery, s.consecutive429s, 300, 60);
  if (errorType === "503") return calc(s.avg503Recovery, s.consecutive503s, 60, 10);
  return calc(s.avgErrorRecovery, s.consecutiveErrors, 300, 60);
}

function calc(avg, consecutive, base, minVal) {
  const exp = Math.min(consecutive, 4);
  const cd = avg ? avg * Math.pow(2, exp) : base * Math.pow(2, exp);
  return Math.max(minVal, Math.min(Math.round(cd), COOLDOWN_MAX_SECONDS));
}

// ============================================================
// Rate Limit Events
// ============================================================
export function record429(chId, retryAfter) {
  const s = get(chId);
  s.consecutive429s++; s.consecutiveErrors++;
  s.last429At = Date.now(); s.lastErrorAt = Date.now();
  if (retryAfter > 0) s.avg429Recovery = runningAvg(s.avg429Recovery, Math.min(retryAfter, COOLDOWN_MAX_SECONDS), WEIGHT_RECENT);
}

export function record503(chId, retryAfter) {
  const s = get(chId);
  s.consecutive503s++; s.consecutiveErrors++;
  s.last503At = Date.now(); s.lastErrorAt = Date.now();
  if (retryAfter > 0) s.avg503Recovery = runningAvg(s.avg503Recovery, Math.min(retryAfter, COOLDOWN_MAX_SECONDS), WEIGHT_RECENT);
}

export function recordError(chId) {
  const s = get(chId);
  s.consecutiveErrors++; s.lastErrorAt = Date.now();
}

export function recordSuccess(chId) {
  const s = get(chId);
  const now = Date.now();
  if (s.consecutiveErrors > 0) {
    const recSec = Math.round((now - s.lastErrorAt) / 1000);
    if (recSec >= 5 && recSec <= COOLDOWN_MAX_SECONDS) {
      if (s.consecutive429s > 0) s.avg429Recovery = runningAvg(s.avg429Recovery, recSec, WEIGHT_RECENT);
      if (s.consecutive503s > 0) s.avg503Recovery = runningAvg(s.avg503Recovery, recSec, WEIGHT_RECENT);
      if (s.consecutiveErrors > 0) s.avgErrorRecovery = runningAvg(s.avgErrorRecovery, recSec, WEIGHT_RECENT);
    }
  }
  s.consecutive429s = 0; s.consecutive503s = 0; s.consecutiveErrors = 0;
  s.lastSuccessAt = now;
}

// ============================================================
// Feature Support Learning
// Learns from 400 error message patterns.
// ============================================================

const ERROR_PATTERNS = [
  { key: "maxTokens", re: /max[_-]?tokens\s+(is\s+)?(required|must\b)/i },
  { key: "noVision", re: /(image|picture|photo|visual|vision)\s+.*(not\s+support|unsupport|unrecognized|invalid)/i },
  { key: "noTools", re: /(tool|function)\s+(calling|call)\s+.*(not\s+support|unsupport|unrecognized|invalid)/i },
  { key: "noTools", re: /(tools|functions)\s+(is\s+)?(not\s+support|unsupport|unrecognized)/i },
  { key: "contextExceeded", re: /(context|token)\s+(length|limit|exceeded|too\s+(long|many))/i },
  { key: "blockResponseFormat", re: /response_format.*(not\s+support|unsupport|unrecognized)/i },
];

// Parse error text and extract matching pattern key + unknown param
export function parseErrorForLearning(errText, status) {
  if (status !== 400) return null;
  const lower = String(errText || "").toLowerCase();
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(lower)) return p.key;
  }
  // Check for "unknown parameter" pattern (catch-all for any param)
  if (/\b(unknown|unexpected|unrecognized)\b.*\b(parameter|field|argument|param)\b/i.test(lower)) {
    return "unknownParam";
  }
  return null;
}

// Extract the specific parameter name from "Unknown parameter: 'xxx'" or "Unrecognized field 'xxx'"
export function extractBlockedParam(errText) {
  const m = String(errText || "").match(/['"`](\w+)['"`]/);
  return m ? m[1] : null;
}

// Learn from a 400 error
export function learnFromError(chId, patternKey, paramName) {
  const s = get(chId);
  const now = Date.now();

  switch (patternKey) {
    case "maxTokens":
      s.requiresMaxTokens = true;
      s.requiresMaxTokensConfidence = Math.min(s.requiresMaxTokensConfidence + 1, 5);
      break;
    case "noVision":
      s.excludeVisionUntil = now + FEATURE_EXCLUDE_MS;
      s.vision = false;
      break;
    case "noTools":
      s.excludeToolsUntil = now + FEATURE_EXCLUDE_MS;
      s.tools = false;
      break;
    case "unknownParam":
      if (paramName) {
        if (!s.blockedParams) s.blockedParams = new Set();
        s.blockedParams.add(paramName);
      }
      break;
    case "blockResponseFormat":
      if (!s.blockedParams) s.blockedParams = new Set();
      s.blockedParams.add("response_format");
      break;
    // contextExceeded — informational, doesn't change routing
  }
}

// ============================================================
// Feature Support Queries (called during pool building / request prep)
// ============================================================

// Should this channel be excluded for vision/image requests?
export function isVisionExcluded(chId) {
  const s = state.get(chId);
  if (!s) return false;
  if (s.vision === false) return true; // permanently learned
  if (Date.now() < s.excludeVisionUntil) return true; // temporarily excluded
  return false;
}

// Should this channel be excluded for tool-calling requests?
export function isToolsExcluded(chId) {
  const s = state.get(chId);
  if (!s) return false;
  if (s.tools === false) return true;
  if (Date.now() < s.excludeToolsUntil) return true;
  return false;
}

// Does this channel require max_tokens to be explicitly set?
export function requiresMaxTokens(chId) {
  const s = state.get(chId);
  return s ? s.requiresMaxTokens === true : false;
}

// Get blocked params for this channel (params that cause 400)
export function getBlockedParams(chId) {
  const s = state.get(chId);
  return s?.blockedParams;
}

// ============================================================
// Internal
// ============================================================
function runningAvg(current, newVal, weight) {
  if (current === null) return newVal;
  return Math.round(current * (1 - weight) + newVal * weight);
}

// Debug
export function getAdaptiveState(id) {
  const s = state.get(id);
  return s ? { ...s, blockedParams: s.blockedParams ? [...s.blockedParams] : null } : null;
}
