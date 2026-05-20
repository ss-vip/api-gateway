export function buildUrl(baseUrl, _model, _isStream) {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (base.endsWith("/chat/completions")) return base;
  if (/\/v[\w]+\//.test(base + "/")) return `${base}/chat/completions`;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}
