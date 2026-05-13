// ============================================================
// Global Constants — single source of truth
// ============================================================

// ---- Tool & Message ---- //
export const TOOL_NAME_MAX_LENGTH = 64;
export const MAX_JSON_REPAIR_SIZE = 50_000; // 50KB max (CF free tier: 10ms CPU budget)
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

// ---- Request Timeouts & Retries (free tier: minimize CPU & D1 writes) ---- //
export const REQUEST_TIMEOUT_SECONDS = 15;
export const TOTAL_TIMEOUT_SECONDS = 25;
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

// ---- Cache (free tier: minimize D1 reads) ---- //
export const CACHE_TTL_RATE_MS = 60_000;  // 60s: reduce D1 reads by 6× vs 10s
export const CACHE_TTL_NORMAL_MS = 120_000; // 120s: reduce D1 reads by 4× vs 30s

// ---- D1 (free tier: preserve write quota) ---- //
export const D1_BATCH_MAX = 100;
export const RATE_PERSIST_THRESHOLD = 0.7; // persist counters when >70% consumed
export const HEALTH_PERSIST_INTERVAL_MS = 60_000; // flush health to D1 every 60s max

// ---- Image ---- //
export const MAX_IMAGE_BASE64_BYTES = 5_242_880; // 5MB max per base64 image (free tier: 10ms CPU)

// ---- Free Tier Hard Limits ---- //
export const MAX_BODY_BYTES = 524_288;       // 512KB max request body (prevents CPU spike from huge JSON)
export const STREAM_MAX_DURATION_MS = 20_000; // 20s max stream wall-clock (CF kills at 30s; keep 10s buffer)

// ---- Stream ---- //
export const STREAM_BUF_MAX_BYTES = 524_288; // 512KB safety cap (free tier memory: 128MB)
