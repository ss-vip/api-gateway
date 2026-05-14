import { SKIP, DONE } from "./index.js";

const provider = {
  name: "openai",

  buildUrl(baseUrl, _model) {
    let base = (baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (base.endsWith("/chat/completions")) return base;
    if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  },

  prepareRequest(body) {
    return { body, headers: {} };
  },

  parseResponse(text) {
    return JSON.parse(text);
  },

  processStreamLine(rawLine) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith(":") || trimmed.length === 0) return SKIP;
    if (!trimmed.startsWith("data:")) return SKIP;

    const dataStr = trimmed.startsWith("data: ")
      ? trimmed.slice(6).trim()
      : trimmed.slice(5).trim();

    if (dataStr === "[DONE]") return DONE;
    if (dataStr.length > 0 && dataStr[0] !== "{" && dataStr[0] !== "[") return SKIP;

    try {
      const parsed = JSON.parse(dataStr);
      if (parsed.type === "ping") return SKIP;
      if (parsed.type === "error" || parsed.error) {
        return {
          _error: true,
          message: parsed.error?.message || parsed.message || "Unknown stream error",
        };
      }
      return parsed;
    } catch (e) {
      return SKIP;
    }
  },

  isErrorResponse(parsed) {
    return parsed && (parsed.error || parsed.type === "error");
  },

  mapFinishReason(reason) {
    return reason || null;
  },
};

export default provider;
