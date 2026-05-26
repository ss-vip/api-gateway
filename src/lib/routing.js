// ─── Shared Routing Helpers ──────────────────────────────────────────
// Extracted from gateway.js for use by both router.js and gateway.js

import { RPM_WINDOW_SECONDS, RPD_WINDOW_SECONDS } from "./constants.js";

/**
 * Calculate effective RPM based on channel weight.
 */
export function getEffectiveRpm(ch) {
  if (!ch.rpm_limit || ch.rpm_limit <= 0) return 0;
  return Math.max(1, Math.round(ch.rpm_limit * (ch.weight || 50) / 50));
}

/**
 * Normalize rate window: determine if a rate counter is still active.
 */
export function normalizeRateWindow(count, resetAt, windowSeconds, now) {
  const reset = Number(resetAt || 0);
  const value = Number(count || 0);
  if (!reset || reset > now + windowSeconds) return { count: 0, resetAt: now, active: false };
  if (now - reset >= windowSeconds) return { count: 0, resetAt: now, active: false };
  return { count: value, resetAt: reset, active: true };
}
