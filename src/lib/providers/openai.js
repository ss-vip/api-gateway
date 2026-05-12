// ============================================================
// OpenAI Provider — Canonical Format
// This is the default/fallback provider
// ============================================================

import { SKIP, DONE } from "./index.js";

const provider = {
  name: "openai",

  // ---- URL Building ---- //
  buildUrl(baseUrl) {
    let base = (baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (base.endsWith("/chat/completions")) return base;
    if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  },

  // ---- Request Preparation (canonical → upstream) ---- //
  // OpenAI format is the canonical format, so passthrough
  prepareRequest(body) {
    return { body, headers: {} };
  },

  // ---- Response Parsing (upstream → canonical) ---- //
  parseResponse(text) {
    return JSON.parse(text);
  },

  // ---- Stream Line Processing (upstream SSE → canonical events) ---- //
  processStreamLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("data:")) return SKIP;

    const dataStr = trimmed.startsWith("data: ")
      ? trimmed.slice(6).trim()
      : trimmed.slice(5).trim();

    if (dataStr === "[DONE]") return DONE;

    try {
      const parsed = JSON.parse(dataStr);

      // Ping events
      if (parsed.type === "ping") return SKIP;

      // Error events
      if (parsed.type === "error" || parsed.error) {
        return {
          _error: true,
          message: parsed.error?.message || parsed.message || "Unknown stream error",
        };
      }

      // Already in canonical format
      return parsed;
    } catch (e) {
      return SKIP;
    }
  },

  // ---- Error Detection ---- //
  isErrorResponse(parsed) {
    return parsed && (parsed.error || parsed.type === "error");
  },

  // ---- Finish Reason Mapping ---- //
  mapFinishReason(reason) {
    return reason || null; // already canonical
  },
};

export default provider;
