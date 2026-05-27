// 日誌工具 — API key 遮罩

const API_KEY_REGEX = /(["']?api_key["']?\s*[:=]\s*["']?)([^"'\s,}\]">]+)/gi;

/** 在字串中遮罩疑似 API key 的內容（key=sk-... → key=sk-***...） */
export function maskApiKey(str) {
  if (typeof str !== "string") return str;
  return str.replace(API_KEY_REGEX, (m, pre, key) => {
    if (key.length > 8) return pre + key.slice(0, 8) + "***";
    return pre + "***";
  });
}
