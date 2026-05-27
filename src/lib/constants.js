// 共用常數 — 硬編碼，不使用環境變數
// CF Workers Free 對 HTTP fetch 的 wall-clock 時間無限制，此處設定實務上限

// upstream fetch 超時（毫秒）
// 長思考模型（如 DeepSeek R1）從發出請求到收到第一個 token 可能需 30-60s
// 設 120s 以容許多數 long-thinking 情境
export const UPSTREAM_TIMEOUT_MS = 120_000;

export const CHANNEL_COOLDOWN_MS = UPSTREAM_TIMEOUT_MS;
export const STREAM_IDLE_TIMEOUT_MS = 60_000;
