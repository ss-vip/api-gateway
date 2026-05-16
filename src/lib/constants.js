function env(key, def) {
  const v = process.env[key];
  return v !== undefined ? parseInt(v, 10) : def;
}
function envBool(key, def) {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

// FREE_TIER=1 enables conservative resource defaults for shared hosting (Serv00, etc.)
const FREE = envBool("FREE_TIER", false);

export const TOOL_NAME_MAX_LENGTH = 64;
export const FILTER_TEXT_MIN_LENGTH = 1;
export const FILTER_TEXT_MAX_LENGTH = 30;

export const BACKOFF_ERROR_THRESHOLD = 5;
export const BACKOFF_429_SECONDS = 300;
export const BACKOFF_MAX_SECONDS = 3600;

export const RPM_WINDOW_SECONDS = 60;
export const RPD_WINDOW_SECONDS = 86400;

export const REQUEST_TIMEOUT_SECONDS = env("REQUEST_TIMEOUT_SECONDS", FREE ? 120 : 60);
export const STREAM_IDLE_TIMEOUT_MS = env("STREAM_IDLE_TIMEOUT_MS", FREE ? 180_000 : 120_000);

export const CACHE_TTL_RATE_MS = 60_000;
export const CACHE_TTL_NORMAL_MS = FREE ? 300_000 : 120_000;

export const D1_BATCH_MAX = 100;
export const RATE_PERSIST_THRESHOLD = 0.7;
export const HEALTH_PERSIST_INTERVAL_MS = 15_000;

export const MAX_IMAGE_BASE64_BYTES = FREE ? 1_048_576 : 5_242_880;

export const STREAM_MAX_DURATION_MS = env("STREAM_MAX_DURATION_MS", FREE ? 180_000 : 300_000);

export const STREAM_BUF_MAX_BYTES = FREE ? 131_072 : 524_288;

export const MAX_CONCURRENT_REQUESTS = env("MAX_CONCURRENT_REQUESTS", FREE ? 20 : 60);

export const ENABLE_BACKUPS = envBool("ENABLE_BACKUPS", !FREE);

export const GC_MEMORY_THRESHOLD_MB = env("GC_MEMORY_THRESHOLD_MB", FREE ? 80 : 150);

export const LOG_TRUNCATE_LINES = env("LOG_TRUNCATE_LINES", FREE ? 300 : 1000);
export const LOG_KEEP_LINES = env("LOG_KEEP_LINES", FREE ? 150 : 500);
