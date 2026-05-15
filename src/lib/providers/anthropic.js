import { SKIP, DONE } from "./index.js";

let anthropicChunkId = 0;
function nextChunkId() {
  anthropicChunkId = anthropicChunkId >= 2147483647 ? 1 : anthropicChunkId + 1;
  return anthropicChunkId;
}

function mapFinishReason(stopReason, stopSequence) {
  if (stopReason === "end_turn" || stopReason === "stop_sequence") return "stop";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopSequence) return "stop";
  return null;
}

function openaiToAnthropicContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const c of content) {
      if (c.type === "text") {
        blocks.push({ type: "text", text: c.text || "" });
      } else if (c.type === "image_url") {
        const dataUrl = c.image_url?.url || "";
        if (dataUrl.startsWith("data:")) {
          const commaIdx = dataUrl.indexOf(",");
          if (commaIdx === -1) continue;
          const header = dataUrl.slice(0, commaIdx);
          const base64Data = dataUrl.slice(commaIdx + 1);
          const mimeType = header.replace("data:", "").replace(";base64", "").replace(";utf8", "").trim() || "image/png";
          blocks.push({ type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } });
        } else if (dataUrl.startsWith("http")) {
          const ext = dataUrl.split(".").pop()?.split("?")[0]?.toLowerCase() || "jpeg";
          const mediaMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
          blocks.push({ type: "image", source: { type: "url", media_type: mediaMap[ext] || "image/jpeg", url: dataUrl } });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: String(content || "") }];
}

function openaiToolCallsToAnthropic(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => {
    const fn = tc.function || {};
    let input = {};
    if (fn.arguments) {
      if (typeof fn.arguments === "object") {
        input = fn.arguments;
      } else {
        try { input = JSON.parse(fn.arguments); } catch { input = {}; }
      }
    }
    return { type: "tool_use", id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: fn.name || "unknown_tool", input };
  });
}

function anthropicToolUseToOpenAI(blocks) {
  if (!blocks || !Array.isArray(blocks)) return undefined;
  const toolUses = blocks.filter((b) => b.type === "tool_use");
  if (toolUses.length === 0) return undefined;
  return toolUses.map((tu, i) => ({
    index: i, id: tu.id || `call_a_${i}`, type: "function",
    function: { name: tu.name || "", arguments: JSON.stringify(tu.input || {}) },
  }));
}

function openaiToolResultToAnthropic(message) {
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id || "unknown",
    content: typeof message.content === "string" ? message.content : (message.content ? JSON.stringify(message.content) : ""),
  };
}

function createAnthropicStreamState() {
  return { lastEvent: null, toolCallAccums: {}, toolCallIds: {} };
}

const provider = {
  name: "anthropic",

  createStreamState() {
    return createAnthropicStreamState();
  },

  buildUrl(baseUrl, _model, _isStream) {
    let base = (baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (base.endsWith("/messages")) return base;
    return `${base}/v1/messages`;
  },

  prepareRequest(body, channel) {
    const { messages, tools, stream, max_tokens, ...rest } = body;
    const anthropicMessages = [];
    let systemText = "";

    for (const m of messages || []) {
      if (m.role === "system") {
        systemText += (typeof m.content === "string" ? m.content : "") + "\n";
        continue;
      }
      if (m.role === "tool" || m.role === "function") {
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          lastMsg.content.push(openaiToolResultToAnthropic(m));
        } else {
          anthropicMessages.push({ role: "user", content: [openaiToolResultToAnthropic(m)] });
        }
        continue;
      }
      const anthropicRole = m.role === "assistant" ? "assistant" : "user";
      const content = [];
      if (m.content) {
        if (typeof m.content === "string") {
          content.push({ type: "text", text: m.content });
        } else if (Array.isArray(m.content)) {
          content.push(...openaiToAnthropicContent(m.content));
        }
      }
      if (m.tool_calls) content.push(...openaiToolCallsToAnthropic(m.tool_calls));
      if (content.length > 0) anthropicMessages.push({ role: anthropicRole, content });
    }

    const anthropicBody = {
      model: rest.model || body.model || "claude-sonnet-4-20250514",
      messages: anthropicMessages,
      max_tokens: max_tokens || 4096,
      stream: !!stream,
    };

    if (systemText.trim()) anthropicBody.system = systemText.trim();
    if (rest.temperature != null) anthropicBody.temperature = rest.temperature;
    if (rest.top_p != null) anthropicBody.top_p = rest.top_p;
    if (rest.stop) anthropicBody.stop_sequences = Array.isArray(rest.stop) ? rest.stop : [rest.stop];

    if (tools && Array.isArray(tools) && tools.length > 0) {
      anthropicBody.tools = tools.map((t) => {
        const fn = t.function || {};
        return { name: fn.name || "unknown_tool", description: fn.description || "", input_schema: fn.parameters || { type: "object", properties: {} } };
      });
    }

    if (rest.tool_choice) {
      if (rest.tool_choice === "none") {
        anthropicBody.tool_choice = { type: "none" };
      } else if (rest.tool_choice === "auto") {
        anthropicBody.tool_choice = { type: "auto" };
      } else if (rest.tool_choice === "required" || rest.tool_choice === "any") {
        anthropicBody.tool_choice = { type: "any" };
      } else if (typeof rest.tool_choice === "object") {
        const fnName = rest.tool_choice.function?.name || rest.tool_choice.function;
        anthropicBody.tool_choice = fnName ? { type: "tool", name: fnName } : { type: "any" };
      }
    }

    const anthropicHeaders = {
      "x-api-key": channel?.api_key || "",
      "anthropic-version": "2023-06-01",
      "Authorization": "",
    };

    return { body: anthropicBody, headers: anthropicHeaders };
  },

  parseResponse(text) {
    const raw = JSON.parse(text);
    if (raw.error) return raw;
    if (raw.type === "error") return { error: { message: raw.error?.message || "Anthropic API error" } };
    const content = raw.content || [];
    const textParts = content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const toolCalls = anthropicToolUseToOpenAI(content);
    const inputTokens = raw.usage?.input_tokens || 0;
    const outputTokens = raw.usage?.output_tokens || 0;
    return {
      id: raw.id || `chatcmpl-a-${nextChunkId()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: raw.model || "unknown",
      choices: [{
        index: 0,
        message: { role: "assistant", content: textParts || null, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: mapFinishReason(raw.stop_reason, raw.stop_sequence),
      }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
  },

  processStreamLine(rawLine, state) {
    const trimmed = rawLine.trim();
    if (!trimmed) return SKIP;
    const s = state || createAnthropicStreamState();

    if (trimmed.startsWith("event:")) {
      s.lastEvent = trimmed.slice(6).trim();
      return SKIP;
    }
    if (!trimmed.startsWith("data:")) { s.lastEvent = null; return SKIP; }

    const dataStr = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed.slice(5).trim();
    if (!dataStr) { s.lastEvent = null; return SKIP; }

    const eventType = s.lastEvent || "message";
    s.lastEvent = null;

    try {
      const parsed = JSON.parse(dataStr);
      if (parsed.type === "ping") return SKIP;
      if (parsed.type === "error") return { _error: true, message: parsed.error?.message || "Anthropic stream error" };

      if (eventType === "message_start" || parsed.type === "message_start") {
        const msg = parsed.message || parsed;
        const textParts = (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
        const toolCalls = anthropicToolUseToOpenAI(msg.content || []);
        return {
          id: msg.id || `chatcmpl-a-${nextChunkId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: msg.model || "unknown",
          choices: [{ index: 0, delta: { ...(textParts ? { content: textParts } : {}), ...(toolCalls ? { tool_calls: toolCalls } : {}), role: "assistant" }, finish_reason: null }],
          usage: msg.usage ? { prompt_tokens: msg.usage.input_tokens || 0, completion_tokens: 0, total_tokens: msg.usage.input_tokens || 0 } : undefined,
        };
      }

      if (eventType === "content_block_delta" || parsed.type === "content_block_delta") {
        const delta = parsed.delta || {};
        const blockIndex = parsed.index || 0;
        if (delta.type === "text_delta") {
          return { id: `chatcmpl-a-${nextChunkId()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown", choices: [{ index: 0, delta: { content: delta.text || "" }, finish_reason: null }] };
        }
        if (delta.type === "input_json_delta") {
          const toolCallId = s.toolCallIds?.[blockIndex] || `toolu_${blockIndex}`;
          const partial = delta.partial_json || "";
          if (!s.toolCallAccums) s.toolCallAccums = {};
          s.toolCallAccums[blockIndex] = (s.toolCallAccums[blockIndex] || "") + partial;
          return { id: `chatcmpl-a-${nextChunkId()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: "", arguments: partial } }] }, finish_reason: null }] };
        }
        return SKIP;
      }

      if (eventType === "content_block_start" || parsed.type === "content_block_start") {
        const block = parsed.content_block || parsed;
        const blockIndex = parsed.index || 0;
        if (block.type === "tool_use") {
          s.toolCallIds = s.toolCallIds || {};
          s.toolCallIds[blockIndex] = block.id || `toolu_${blockIndex}`;
          s.toolCallAccums = s.toolCallAccums || {};
          s.toolCallAccums[blockIndex] = "";
          return { id: `chatcmpl-a-${nextChunkId()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: block.id || `toolu_${blockIndex}`, type: "function", function: { name: block.name || "", arguments: "" } }] }, finish_reason: null }] };
        }
        if (block.type === "text") {
          return { id: `chatcmpl-a-${nextChunkId()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown", choices: [{ index: 0, delta: { content: block.text || "" }, finish_reason: null }] };
        }
        return SKIP;
      }

      if (eventType === "message_delta" || parsed.type === "message_delta") {
        const delta = parsed.delta || parsed;
        const usage = parsed.usage || {};
        const finishReason = mapFinishReason(delta.stop_reason, delta.stop_sequence);
        return { id: `chatcmpl-a-${nextChunkId()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "unknown", choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: usage.output_tokens != null ? { prompt_tokens: 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.output_tokens || 0 } : undefined };
      }

      if (eventType === "message_stop" || parsed.type === "message_stop") {
        s.toolCallAccums = {};
        s.toolCallIds = {};
        return DONE;
      }

      return SKIP;
    } catch (e) {
      return SKIP;
    }
  },

  isErrorResponse(parsed) {
    return parsed && (parsed.error || parsed.type === "error");
  },
};

export default provider;
