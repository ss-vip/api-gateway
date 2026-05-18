export const TOOL_NAME_MAX_LENGTH = 64;
export const FILTER_TEXT_MIN_LENGTH = 1;
export const FILTER_TEXT_MAX_LENGTH = 30;

export const BACKOFF_ERROR_THRESHOLD = 5;
export const BACKOFF_429_SECONDS = 300;
export const BACKOFF_MAX_SECONDS = 3600;

export const RPM_WINDOW_SECONDS = 60;
export const RPD_WINDOW_SECONDS = 86400;

// Non-streaming timeout (per channel attempt)
export const REQUEST_TIMEOUT_SECONDS = 15;
// Streaming: allow longer duration for complex tool-use conversations
export const STREAM_MAX_DURATION_MS = 120_000;
export const STREAM_BUF_MAX_BYTES = 131_072;

export const CACHE_TTL_RATE_MS = 60_000;
export const CACHE_TTL_NORMAL_MS = 120_000;

export const MAX_IMAGE_BASE64_BYTES = 1_048_576;
export const MAX_SUBREQUESTS = 40;

export const GLOBAL_TIMEOUT_MS = 28_000;


