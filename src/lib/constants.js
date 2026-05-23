export const BACKOFF_ERROR_THRESHOLD = 5;
export const BACKOFF_429_SECONDS = 300;
export const BACKOFF_MAX_SECONDS = 3600;

export const RPM_WINDOW_SECONDS = 60;
export const RPD_WINDOW_SECONDS = 86400;

// Defaults (Paid tier). For Free Tier (30s wall clock), call setTimeouts(env)
// which reads REQUEST_TIMEOUT_SECONDS and GLOBAL_TIMEOUT_MS env vars.
let _requestTimeout = 120;
let _globalTimeout = 180_000;

export function getRequestTimeout() { return _requestTimeout; }
export function getGlobalTimeout() { return _globalTimeout; }

export function setTimeouts(env) {
  const rt = parseInt(env.REQUEST_TIMEOUT_SECONDS);
  const gt = parseInt(env.GLOBAL_TIMEOUT_MS);
  if (Number.isFinite(rt) && rt >= 1) _requestTimeout = rt;
  if (Number.isFinite(gt) && gt >= 1000) _globalTimeout = gt;
}
