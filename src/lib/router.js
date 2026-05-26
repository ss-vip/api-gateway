// ─── Channel Selection Router ────────────────────────────────────────
// Simplified weighted random selection: model match × error penalty × base weight.
// Rate proximity and latency penalties removed — marginal benefit vs CPU cost.

import {
  BACKOFF_ERROR_THRESHOLD,
  RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS,
} from "./constants.js";
import { getEffectiveRpm, normalizeRateWindow } from "./routing.js";
import { getBufferedRate } from "../routes/maintenance.js";
import { estimateInputTokens } from "./request.js";

// ── Per-model lock (9Router-inspired) ──
// More granular than channel-level cooldown: locks a specific model
// across all channels sharing it.
const MODEL_LOCKS = new Map(); // key: `modelLock_${model}`

/**
 * Lock a model globally for a duration.
 * @param {string} model
 * @param {number} durationMs
 */
export function lockModel(model, durationMs) {
  if (!model) return;
  MODEL_LOCKS.set('modelLock_' + model, Date.now() + durationMs);
}

/**
 * Check if a model is currently locked.
 * @param {string} model
 * @returns {boolean}
 */
export function isModelLocked(model) {
  if (!model) return false;
  const until = MODEL_LOCKS.get('modelLock_' + model);
  return !!until && until > Date.now();
}

/**
 * Clear expired model locks (call periodically).
 */
// pruneModelLocks removed — periodic cleanup not needed; modelLock TTL self-expires on read.

// ── Model alias matching ──
// Supports exact match, prefix match (e.g. "claude" matches "claude-sonnet-4-5"),
// and provider-prefixed match ("kr/claude-sonnet-4-5").
function modelMatches(chModel, targetModel) {
  if (!chModel || !targetModel) return false;
  const models = chModel.split(',').map(s => s.trim()).filter(Boolean);
  for (const m of models) {
    if (m === targetModel) return 2;  // exact match
    if (targetModel.endsWith('/' + m) || m.endsWith('/' + targetModel)) return 2; // provider prefix
  }
  for (const m of models) {
    if (targetModel.startsWith(m) || m.startsWith(targetModel)) return 1; // prefix match
  }
  return 0;
}

/**
 * Select best channel from pool using weighted random selection.
 *
 * @param {object[]} channels - Pool of available channels (will NOT be mutated)
 * @param {string} originalModel - Requested model name
 * @param {boolean} isStream - Whether this is a streaming request
 * @param {object} body - Full request body (for input token estimation)
 * @returns {object|null} Selected channel or null if none available
 */
export function selectChannel(channels, originalModel, isStream, body) {
  const now = Math.floor(Date.now() / 1000);
  const model = (originalModel || '').trim();
  const inputTokens = estimateInputTokens(body);

  // Fast path: single channel
  if (channels.length === 1) {
    const ch = channels[0];
    if (!ch.is_enabled) return null;
    if (isStream && ch.support_stream === 0) return null;
    if (isModelLocked(model) && modelMatches(ch.model, model)) return null;
    if (ch.max_tokens > 0 && inputTokens >= ch.max_tokens) return null;
    if (isInCooldown(ch, now)) return null;
    if (isRateLimited(ch, now)) return null;
    return ch;
  }

  // Build filtered + weighted healthy list
  let totalW = 0;
  const candidates = [];

  for (const ch of channels) {
    if (!ch.is_enabled) continue;
    if (isStream && ch.support_stream === 0) continue;
    if (isModelLocked(model) && modelMatches(ch.model, model)) continue;
    if (ch.max_tokens > 0 && inputTokens >= ch.max_tokens) continue;
    if (isInCooldown(ch, now)) continue;
    if (isRateLimited(ch, now)) continue;

    let w = ch.weight || 50;

    // Model match bonus
    const match = modelMatches(ch.model, model);
    if (match >= 2) w *= 10;
    else if (match === 1) w *= 5;
    else {
      // Check fallback model
      const fbMatch = modelMatches(ch.fallback_model, model);
      if (fbMatch >= 2) w *= 5;
      else if (fbMatch === 1) w *= 2;
      else w *= 0.1;
    }

    // Error penalty（consecutive_errors 已含 rate_limit + timeout）
    const err = ch.consecutive_errors || 0;
    if (err >= BACKOFF_ERROR_THRESHOLD) w *= 0.05;
    else if (err >= 4) w *= 0.2;
    else if (err === 3) w *= 0.4;
    else if (err === 2) w *= 0.6;
    else if (err === 1) w *= 0.8;

    w = Math.max(1, Math.min(1000, Math.round(w)));
    candidates.push({ ch, w });
    totalW += w;
  }

  if (candidates.length === 0) return null;

  // All RPM=1 and multiple candidates → round-robin for fairness
  const allRpm1 = candidates.every(c => c.ch.rpm_limit === 1);
  if (allRpm1 && candidates.length > 1) {
    candidates.sort((a, b) => (b.ch.weight || 50) - (a.ch.weight || 50));
    return roundRobin(candidates);
  }

  // High load on all channels → pick least loaded
  const highLoad = candidates.every(c => isHeavilyLoaded(c.ch, now));
  if (highLoad && candidates.length > 1) {
    return candidates.reduce((best, c) => {
      const load = (getRate(c.ch, now).rpmCount || 0) / (c.ch.weight || 50);
      return load < best.load ? { ch: c.ch, load } : best;
    }, { ch: null, load: Infinity }).ch;
  }

  // Weighted random selection
  let r = Math.random() * totalW;
  for (const c of candidates) {
    r -= c.w;
    if (r <= 0) return c.ch;
  }
  return candidates[candidates.length - 1].ch;
}

// ── Internal helpers ──

const rateCache = new Map();

function getRate(ch, now) {
  let r = rateCache.get(ch.id);
  if (!r) {
    const buf = getBufferedRate(ch.id);
    r = {
      rpm: normalizeRateWindow(
        buf ? buf.rpmCount : ch.rpm_count,
        buf ? buf.rpmResetAt : ch.rpm_reset_at,
        RPM_WINDOW_SECONDS, now
      ),
      rpd: normalizeRateWindow(
        buf ? buf.rpdCount : ch.rpd_count,
        buf ? buf.rpdResetAt : ch.rpd_reset_at,
        RPD_WINDOW_SECONDS, now
      ),
      rpmCount: buf ? buf.rpmCount : (ch.rpm_count || 0),
    };
    rateCache.set(ch.id, r);
  }
  return r;
}
// clearRateCache removed — rate cache TTL self-expires; no external invalidation needed.

function isInCooldown(ch, now) {
  if (ch.last_429 > 0 && ch.last_429 > now) return true;
  if (ch.cooldown_until > 0 && ch.cooldown_until > now) return true;
  const errs = ch.consecutive_errors || 0;
  if (errs >= BACKOFF_ERROR_THRESHOLD) {
    const cooldownUntil = (ch.last_error_at || 0) + exponentialCooldown(errs);
    if (cooldownUntil > now) return true;
  }
  return false;
}

function isRateLimited(ch, now) {
  const { rpm, rpd } = getRate(ch, now);
  if (ch.rpd_limit > 0 && rpd.active && rpd.count >= ch.rpd_limit) return true;
  if (ch.rpm_limit > 0) {
    const effectiveRpm = getEffectiveRpm(ch);
    if (rpm.active && rpm.count >= effectiveRpm) return true;
    const usage = rpm.active ? rpm.count / effectiveRpm : 0;
    if (usage > 0.7 && Math.random() < (usage - 0.7) * 3) return true;
  }
  return false;
}

function isHeavilyLoaded(ch, now) {
  if (!ch.rpm_limit) return false;
  const effectiveRpm = getEffectiveRpm(ch);
  if (!effectiveRpm) return false;
  const { rpm } = getRate(ch, now);
  if (!rpm.active) return false;
  return rpm.count / effectiveRpm > 0.5;
}

// ── Round-robin ──
let rrIdx = {};

function roundRobin(candidates) {
  const key = candidates.map(c => c.ch.id).sort().join(',');
  rrIdx[key] = ((rrIdx[key] ?? -1) + 1) % candidates.length;
  return candidates[rrIdx[key]].ch;
}

function exponentialCooldown(consecutiveErrors) {
  if (consecutiveErrors <= BACKOFF_ERROR_THRESHOLD) return 0;
  const exponent = Math.min(consecutiveErrors - BACKOFF_ERROR_THRESHOLD, 4);
  const BACKOFF_429_SECONDS = 300;
  const BACKOFF_MAX_SECONDS = 3600;
  return Math.min(BACKOFF_429_SECONDS * Math.pow(2, exponent), BACKOFF_MAX_SECONDS);
}

// ── EWMA latency tracking ──
const ewmaLatency = new Map();
const EWMA_ALPHA = 0.3;

export function updateEwma(chId, rt) {
  const prev = ewmaLatency.get(chId) || rt;
  ewmaLatency.set(chId, EWMA_ALPHA * rt + (1 - EWMA_ALPHA) * prev);
}

export function clearEwma() {
  ewmaLatency.clear();
}
