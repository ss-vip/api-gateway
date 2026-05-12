// ============================================================
// Global Constants — single source of truth
// ============================================================

// ---- Tool & Message ---- //
export const TOOL_NAME_MAX_LENGTH = 64;
export const MAX_JSON_REPAIR_SIZE = 2_000_000;
export const FILTER_TEXT_MAX_LENGTH = 30;

// ---- Circuit Breaker ---- //
export const COOLDOWN_ERROR_THRESHOLD = 5;
export const COOLDOWN_WINDOW_SECONDS = 1800; // 30 min base
export const COOLDOWN_429_DEFAULT_SECONDS = 300; // 5 min
export const COOLDOWN_503_SECONDS = 60;
export const COOLDOWN_MAX_SECONDS = 3600; // 1 hour cap

// ---- Rate Limiting Windows ---- //
export const RPM_WINDOW_SECONDS = 60;
export const RPD_WINDOW_SECONDS = 86400;

// ---- Request Timeouts ---- //
export const REQUEST_TIMEOUT_SECONDS = 15;
export const TOTAL_TIMEOUT_SECONDS = 25;
export const MAX_RETRIES = 5;
export const RETRY_DELAY_BASE_MS = 200;
export const RETRY_DELAY_VARIANCE_MS = 300;
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

// ---- Cache ---- //
export const CACHE_TTL_RATE_MS = 10_000;
export const CACHE_TTL_NORMAL_MS = 30_000;

// ---- D1 ---- //
export const D1_BATCH_MAX = 100;
export const RATE_PERSIST_THRESHOLD = 0.7; // persist counters when >70% consumed

// ---- Stream ---- //
export const STREAM_BUF_MAX_BYTES = 1_000_000; // 1MB safety cap
