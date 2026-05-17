import { BACKOFF_MAX_SECONDS } from "./constants.js";

const state = new Map();

const FEATURE_EXCLUDE_MS = 600_000;
const WEIGHT_RECENT = 0.3;

class AdaptiveState {
  constructor() {
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

    this.vision = null;
    this.tools = null;
    this.requiresMaxTokens = null;
    this.requiresMaxTokensConfidence = 0;

    this.blockedParams = null;

    this.excludeVisionUntil = 0;
    this.excludeToolsUntil = 0;
  }
}

function get(id) {
  let s = state.get(id);
  if (!s) { s = new AdaptiveState(); state.set(id, s); }
  return s;
}

export function parseRetryAfter(res) {
  const header = res.headers.get("Retry-After");
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) return seconds;
  const ts = Date.parse(header);
  if (!isNaN(ts)) return Math.max(1, Math.round((ts - Date.now()) / 1000));
  return null;
}

export function record429(chId, retryAfter) {
  const s = get(chId);
  s.consecutive429s++; s.consecutiveErrors++;
  s.last429At = Date.now(); s.lastErrorAt = Date.now();
  if (retryAfter > 0) s.avg429Recovery = runningAvg(s.avg429Recovery, Math.min(retryAfter, BACKOFF_MAX_SECONDS), WEIGHT_RECENT);
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
    if (recSec >= 5 && recSec <= BACKOFF_MAX_SECONDS) {
      if (s.consecutive429s > 0) s.avg429Recovery = runningAvg(s.avg429Recovery, recSec, WEIGHT_RECENT);
      if (s.consecutive503s > 0) s.avg503Recovery = runningAvg(s.avg503Recovery, recSec, WEIGHT_RECENT);
      if (s.consecutiveErrors > 0) s.avgErrorRecovery = runningAvg(s.avgErrorRecovery, recSec, WEIGHT_RECENT);
    }
  }
  s.consecutive429s = 0; s.consecutive503s = 0; s.consecutiveErrors = 0;
  s.lastSuccessAt = now;
}

const ERROR_PATTERNS = [
  { key: "maxTokens", re: /max[_-]?tokens\s+(is\s+)?(required|must\b)/i },
  { key: "noVision", re: /(image|picture|photo|visual|vision)\s+.*(not\s+support|unsupport|unrecognized|invalid)/i },
  { key: "noTools", re: /(tool|function)\s+(calling|call)\s+.*(not\s+support|unsupport|unrecognized|invalid)/i },
  { key: "noTools", re: /(tools|functions)\s+(is\s+)?(not\s+support|unsupport|unrecognized)/i },
  { key: "contextExceeded", re: /(context|token)\s+(length|limit|exceeded|too\s+(long|many))/i },
  { key: "blockResponseFormat", re: /response_format.*(not\s+support|unsupport|unrecognized)/i },
];

export function parseErrorForLearning(errText, status) {
  const lower = String(errText || "").toLowerCase();
  if (status !== 400) return null;
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(lower)) return p.key;
  }
  if (/\b(unknown|unexpected|unrecognized)\b.*\b(parameter|field|argument|param)\b/i.test(lower)) {
    return "unknownParam";
  }
  return null;
}

export function extractBlockedParam(errText) {
  const m = String(errText || "").match(/['"`](\w+)['"`]/);
  return m ? m[1] : null;
}

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
    case "contextExceeded":
      s.contextExceededCount = (s.contextExceededCount || 0) + 1;
      s.excludeContextUntil = now + FEATURE_EXCLUDE_MS;
      break;
  }
}

export function isVisionExcluded(chId) {
  const s = state.get(chId);
  if (!s) return false;
  if (s.vision === false) return true;
  if (Date.now() < s.excludeVisionUntil) return true;
  return false;
}

export function isToolsExcluded(chId) {
  const s = state.get(chId);
  if (!s) return false;
  if (s.tools === false) return true;
  if (Date.now() < s.excludeToolsUntil) return true;
  return false;
}

export function isContextExceeded(chId) {
  const s = state.get(chId);
  if (!s) return false;
  if (s.contextExceededCount > 0 && Date.now() < (s.excludeContextUntil || 0)) return true;
  return false;
}

export function requiresMaxTokens(chId) {
  const s = state.get(chId);
  return s?.requiresMaxTokens === true && (s?.requiresMaxTokensConfidence || 0) >= 2;
}

export function getBlockedParams(chId) {
  const s = state.get(chId);
  return s?.blockedParams;
}

function runningAvg(current, newVal, weight) {
  if (current === null) return newVal;
  return Math.round(current * (1 - weight) + newVal * weight);
}

export function cleanupState(validIds) {
  for (const id of state.keys()) {
    if (!validIds.has(id)) state.delete(id);
  }
}
