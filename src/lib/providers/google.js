import { SKIP, DONE } from "./index.js";

let googleChunkId = 0;
let googleToolCallId = 0;

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
  return fcs.map((fc) => ({
    index: 0,
    id: `call_g_${++googleToolCallId}`,
    type: "function",
    function: {
      name: fc.functionCall.name || "",
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

        if (dataUrl.startsWith("data:")) {
          const commaIdx = dataUrl.indexOf(",");
          if (commaIdx === -1) { continue; }
          const header = dataUrl.slice(0, commaIdx);
          const base64Data = dataUrl.slice(commaIdx + 1);
          const mimeType = header
            .replace("data:", "").replace(";base64", "").replace(";utf8", "").trim() || "image/png";
          parts.push({ inlineData: { mimeType, data: base64Data } });
        } else if (dataUrl.startsWith("http://") || dataUrl.startsWith("https://")) {
          const ext = dataUrl.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
          const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
          const mimeType = mimeMap[ext] || "image/jpeg";
          parts.push({ fileData: { mimeType, fileUri: dataUrl } });
        }
      }
    }
    return parts;
  }
  return [{ text: String(content || "") }];
}

function buildFunctionCallParts(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => {
    const fn = tc.function || {};
    let args = {};
    if (fn.arguments) {
      try { args = JSON.parse(fn.arguments); } catch {
        try { args = JSON.parse(fn.arguments + (fn.arguments.endsWith('"') ? "" : '"')); } catch {}
      }
    }
    return { functionCall: { name: fn.name || "", args } };
  });
}

const provider = {
  name: "google",

  buildUrl(baseUrl, model) {
    let base = (baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (base.includes(":streamGenerateContent")) return base;
    const modelName = encodeURIComponent(model || "gemini-2.0-flash");
    return `${base}/models/${modelName}:streamGenerateContent`;
  },

  prepareRequest(body) {
    const { messages, tools, stream, ...rest } = body;

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

      if (m.content) {
        parts.push(...openaiToGoogleParts(m.content));
      }

      if (m.tool_calls) {
        parts.push(...buildFunctionCallParts(m.tool_calls));
      }

      if (m.role === "tool" || m.role === "function") {
        parts.push({
          functionResponse: {
            name: m.name || "unknown",
            response: { response: m.content || "" },
          },
        });
      }

      if (parts.length > 0) {
        contents.push({ role: googleRole, parts });
      }
    }

    const responseFormat = rest.response_format;
    let responseMimeType;
    if (responseFormat?.type === "json_object") {
      responseMimeType = "application/json";
    } else if (responseFormat?.type === "json_schema" && responseFormat?.json_schema?.schema) {
      responseMimeType = "application/json";
    }

    let toolConfig;
    if (rest.tool_choice) {
      if (rest.tool_choice === "none") {
        toolConfig = { functionCallingConfig: { mode: "NONE" } };
      } else if (rest.tool_choice === "required" || rest.tool_choice === "forced") {
        toolConfig = { functionCallingConfig: { mode: "ANY" } };
      } else if (typeof rest.tool_choice === "object" && rest.tool_choice.type === "function") {
        toolConfig = {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [rest.tool_choice.function?.name].filter(Boolean),
          },
        };
      }
    }

    const googleBody = {
      contents,
      generationConfig: {
        ...(rest.temperature != null ? { temperature: rest.temperature } : {}),
        ...(rest.max_tokens != null ? { maxOutputTokens: rest.max_tokens } : {}),
        ...(rest.top_p != null ? { topP: rest.top_p } : {}),
        ...(rest.stop ? { stopSequences: Array.isArray(rest.stop) ? rest.stop : [rest.stop] } : {}),
        ...(responseMimeType ? { responseMimeType } : {}),
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
      ...(toolConfig ? { toolConfig } : {}),
    };

    if (systemInstruction) {
      googleBody.systemInstruction = {
        parts: [{ text: systemInstruction.trim() }],
      };
    }

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

  parseResponse(text) {
    const raw = JSON.parse(text);

    if (raw.error) return raw;

    const candidate = raw.candidates?.[0];
    if (!candidate) return { choices: [], object: "chat.completion" };

    const parts = candidate.content?.parts || [];

    return {
      id: `chatcmpl-g-${++googleChunkId}`,
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

  processStreamLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("data:")) return SKIP;

    const dataStr = trimmed.startsWith("data: ")
      ? trimmed.slice(6).trim()
      : trimmed.slice(5).trim();

    if (!dataStr || dataStr === "[DONE]") return DONE;

    try {
      const parsed = JSON.parse(dataStr);

      if (parsed.error) {
        return {
          _error: true,
          message: parsed.error.message || "Google API error",
        };
      }

      const candidate = parsed.candidates?.[0];
      if (!candidate || !candidate.content) return SKIP;

      const parts = candidate.content?.parts || [];
      const text = extractText(parts);
      const toolCalls = extractToolCalls(parts);
      const finishReason = finishReasonMap(candidate.finishReason);

      return {
        id: `chatcmpl-g-${++googleChunkId}`,
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
