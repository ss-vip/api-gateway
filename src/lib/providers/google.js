// ============================================================
// Google AI Studio Provider
// Converts between OpenAI format and Gemini API format
// Endpoint: POST /v1beta/models/{model}:streamGenerateContent
// ============================================================

import { SKIP, DONE } from "./index.js";

// ---- Internal Helpers ---- //

function extractText(parts) {
  if (!parts || !Array.isArray(parts)) return "";
  return parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join("");
}

function extractToolCalls(parts) {
  const fcs = (parts || []).filter((p) => p.functionCall);
  if (fcs.length === 0) return undefined;
  return fcs.map((fc, i) => ({
    index: i,
    id: `call_${fc.functionCall.name}_${i}`,
    type: "function",
    function: {
      name: fc.functionCall.name,
      arguments: JSON.stringify(fc.functionCall.args || {}),
    },
  }));
}

function finishReasonMap(reason) {
  const map = {
    STOP: "stop",
    MAX_TOKENS: "length",
    SAFETY: "content_filter",
    RECITATION: "content_filter",
    OTHER: "stop",
    FINISH_REASON_UNSPECIFIED: null,
  };
  return map[reason] || null;
}

// ---- Convert OpenAI content parts to Google parts ---- //
function openaiToGoogleParts(content) {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (c.type === "text") {
        parts.push({ text: c.text });
      } else if (c.type === "image_url") {
        const dataUrl = c.image_url?.url || "";
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx === -1) {
          parts.push({ text: "[image: unsupported format]" });
          continue;
        }
        const header = dataUrl.slice(0, commaIdx);
        const base64Data = dataUrl.slice(commaIdx + 1);
        const mimeType =
          header
            .replace("data:", "")
            .replace(";base64", "")
            .replace(";utf8", "")
            .trim() || "image/png";
        parts.push({ inlineData: { mimeType, data: base64Data } });
      }
    }
    return parts;
  }
  return [{ text: String(content || "") }];
}

// ---- Tool Call Parts ---- //
function buildFunctionCallParts(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => ({
    functionCall: {
      name: tc.function?.name || "",
      args: (() => {
        try {
          return JSON.parse(tc.function?.arguments || "{}");
        } catch {
          return {};
        }
      })(),
    },
  }));
}

// ============================================================
// Provider Interface
// ============================================================

const provider = {
  name: "google",

  // ---- URL: /{base}/models/{model}:streamGenerateContent ---- //
  buildUrl(baseUrl, model) {
    let base = (baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    // If baseUrl already has the full endpoint path, use it
    if (base.includes(":streamGenerateContent")) return base;
    const modelName = model || "gemini-2.0-flash";
    return `${base}/models/${modelName}:streamGenerateContent`;
  },

  // ---- Convert OpenAI request → Google format ---- //
  prepareRequest(body) {
    const { messages, tools, stream, ...rest } = body;

    // Separate system instruction from messages
    let systemInstruction = undefined;
    const contents = [];

    for (const m of messages || []) {
      if (m.role === "system") {
        systemInstruction = systemInstruction || "";
        systemInstruction += (typeof m.content === "string" ? m.content : "") + "\n";
        continue;
      }

      const googleRole = m.role === "assistant" ? "model" : "user";
      const parts = [];

      // Content parts
      if (m.content) {
        parts.push(...openaiToGoogleParts(m.content));
      }

      // Tool calls in assistant messages
      if (m.tool_calls) {
        parts.push(...buildFunctionCallParts(m.tool_calls));
      }

      // Tool responses
      if (m.role === "tool" || m.role === "function") {
        parts.push({
          functionResponse: {
            name: m.name || "unknown",
            response: { response: m.content || "" },
          },
        });
      }

      // Skip empty messages
      if (parts.length > 0) {
        contents.push({ role: googleRole, parts });
      }
    }

    const googleBody = {
      contents,
      generationConfig: {
        ...(rest.temperature != null ? { temperature: rest.temperature } : {}),
        ...(rest.max_tokens != null ? { maxOutputTokens: rest.max_tokens } : {}),
        ...(rest.top_p != null ? { topP: rest.top_p } : {}),
        ...(rest.stop ? { stopSequences: Array.isArray(rest.stop) ? rest.stop : [rest.stop] } : {}),
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
    };

    // System instruction
    if (systemInstruction) {
      googleBody.systemInstruction = {
        parts: [{ text: systemInstruction.trim() }],
      };
    }

    // Tools → functionDeclarations
    if (tools && Array.isArray(tools)) {
      googleBody.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.function?.name,
            description: t.function?.description,
            parameters: t.function?.parameters,
          })),
        },
      ];
    }

    return { body: googleBody, headers: {} };
  },

  // ---- Parse Google response → canonical OpenAI format ---- //
  parseResponse(text) {
    const raw = JSON.parse(text);

    // Error from Google
    if (raw.error) return raw;

    const candidate = raw.candidates?.[0];
    if (!candidate) return { choices: [], object: "chat.completion" };

    const parts = candidate.content?.parts || [];

    return {
      id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: raw.modelVersion || "unknown",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: extractText(parts) || null,
            ...(extractToolCalls(parts)
              ? { tool_calls: extractToolCalls(parts) }
              : {}),
          },
          finish_reason: finishReasonMap(candidate.finishReason),
        },
      ],
      usage: {
        prompt_tokens: raw.usageMetadata?.promptTokenCount || 0,
        completion_tokens: raw.usageMetadata?.candidatesTokenCount || 0,
        total_tokens:
          (raw.usageMetadata?.promptTokenCount || 0) +
          (raw.usageMetadata?.candidatesTokenCount || 0),
      },
    };
  },

  // ---- Process Google SSE stream line ---- //
  processStreamLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("data:")) return SKIP;

    const dataStr = trimmed.startsWith("data: ")
      ? trimmed.slice(6).trim()
      : trimmed.slice(5).trim();

    if (!dataStr || dataStr === "[DONE]") return DONE;

    try {
      const parsed = JSON.parse(dataStr);

      // Error
      if (parsed.error) {
        return {
          _error: true,
          message: parsed.error.message || "Google API error",
        };
      }

      const candidate = parsed.candidates?.[0];
      // Safety-only events or empty candidates → skip
      if (!candidate || !candidate.content) return SKIP;

      const parts = candidate.content?.parts || [];
      const text = extractText(parts);
      const toolCalls = extractToolCalls(parts);
      const finishReason = finishReasonMap(candidate.finishReason);

      return {
        id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: parsed.modelVersion,
        choices: [
          {
            index: 0,
            delta: {
              ...(text ? { content: text } : {}),
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
          },
        ],
      };
    } catch (e) {
      return SKIP;
    }
  },

  isErrorResponse(parsed) {
    return parsed && (parsed.error || !parsed.candidates);
  },
};

export default provider;
