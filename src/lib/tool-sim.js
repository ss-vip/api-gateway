import { estimateInputTokens } from "./request.js";

// ─── XML Tool Call Format ──────────────────────────────────────────
// Some upstream providers don't support structured function calling (tool_calls)
// but instead return tool invocation as XML in the content field:
//
//   <tool_call>
//   function_name
//     <arg_key>param1</arg_key>
//     <arg_value>value1</arg_value>
//     <arg_key>param2</arg_key>
//     <arg_value>value2</arg_value>
//   </tool_call>
//
// These functions detect and convert this format to OpenAI-compatible
// tool_calls chunks so LobeChat can properly dispatch MCP tools.

const TOOL_CALL_START = '<tool_call>';
const TOOL_CALL_END = '</tool_call>';

let toolCallIdCounter = 0;

export function nextToolCallId() {
  return 'call_' + Date.now().toString(36) + '_' + (++toolCallIdCounter).toString(36);
}

export function hasTools(body) {
  return body.tools && Array.isArray(body.tools) && body.tools.length > 0;
}

export function shouldSimulateTools(body) {
  return hasTools(body) && body.tool_choice !== "none";
}

export function prepareRequestBody(body, ch, originalModel) {
  const reqBody = { ...body, model: ch.model || originalModel };

  // Note: tools are always kept in the request body regardless of ch.support_tools.
  // The upstream model will either respond with proper tool_calls or ignore them.
  // Previously stripped when !ch.support_tools, but that broke MCP tool flows.
  // Tool call detection in streaming response is handled by the downstream client.

  if (ch.max_tokens > 0) {
    const inputTokens = estimateInputTokens(body);
    const remaining = Math.max(1, ch.max_tokens - inputTokens);
    reqBody.max_tokens = Math.min(reqBody.max_tokens || remaining, remaining, 1000000);
  }

  return reqBody;
}

/**
 * Parse a complete XML tool call string into { name, arguments }.
 *
 * Input:  "<tool_call>\nfetch\n<arg_key>url</arg_key>..."
 * Output: { name: "fetch", arguments: '{"url":"...","description":"..."}' }
 */
export function parseXmlToolCall(xml) {
  // Tool name: first non-whitespace, non-tag text after <tool_call>
  const nameMatch = xml.match(/<tool_call>\s*([^\s<]+)/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  if (!name) return null;

  // Key-value pairs
  const keys = [];
  const values = [];
  const keyRe = /<arg_key>([^<]*)<\/arg_key>/g;
  const valRe = /<arg_value>([^<]*)<\/arg_value>/g;
  let m;

  while ((m = keyRe.exec(xml)) !== null) keys.push(m[1]);
  while ((m = valRe.exec(xml)) !== null) values.push(m[1]);

  const args = {};
  // Simple decode: restore &lt; &gt; &amp; &quot; &#39;
  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  if (keys.length > 0) {
    keys.forEach((k, i) => {
      args[decode(k)] = decode(values[i] || '');
    });
  }

  return { name, arguments: JSON.stringify(args) };
}

/**
 * Stateful streaming XML tool call processor.
 *
 * Usage:
 *   const state = { buffering: false, buf: '' };
 *   // For each streaming chunk with content:
 *   const result = processXmlToolCallStream(content, state);
 *
 * Returns an object describing what to do with the content:
 *   { action: 'none' }              — no tool call detected, forward as-is
 *   { action: 'buffer' }            — currently buffering XML, skip content
 *   { action: 'text_before', text } — text before <tool_call>, forward this text
 *   { action: 'emit', toolCalls[], afterText } — parse complete, emit tool calls
 *   { action: 'after', afterText }  — text after </tool_call>, forward this text
 */
export function processXmlToolCallStream(content, state) {
  if (state.buffering) {
    state.buf += content;
    const endIdx = state.buf.indexOf(TOOL_CALL_END);
    if (endIdx === -1) {
      return { action: 'buffer' };
    }
    // Complete XML found in buffer
    const xml = state.buf.slice(0, endIdx + TOOL_CALL_END.length);
    state.buf = state.buf.slice(endIdx + TOOL_CALL_END.length);
    state.buffering = false;

    // If there's leftover content in buffer, it's text after </tool_call>
    const afterXml = state.buf;
    state.buf = '';

    const parsed = parseXmlToolCall(xml);
    if (parsed && parsed.name) {
      const idx = state.toolCallIndex ?? 0;
      state.toolCallIndex = idx + 1;
      return {
        action: 'emit',
        toolCalls: [{
          index: idx,
          id: nextToolCallId(),
          type: 'function',
          function: { name: parsed.name, arguments: parsed.arguments },
        }],
        afterText: afterXml || undefined,
      };
    }
    // Parse failed — treat as regular text
    return { action: 'text_before', text: xml + afterXml };
  }

  // Check for <tool_call> in current content
  const startIdx = content.indexOf(TOOL_CALL_START);
  if (startIdx === -1) {
    return { action: 'none' };
  }

  const beforeText = content.slice(0, startIdx);
  const fromStart = content.slice(startIdx);

  // Check if complete in this chunk
  const endIdx = fromStart.indexOf(TOOL_CALL_END);
  if (endIdx !== -1) {
    // Complete in single chunk
    const xml = fromStart.slice(0, endIdx + TOOL_CALL_END.length);
    const afterXml = fromStart.slice(endIdx + TOOL_CALL_END.length);

    const parsed = parseXmlToolCall(xml);
    if (parsed && parsed.name) {
      const idx = state.toolCallIndex ?? 0;
      state.toolCallIndex = idx + 1;
      return {
        action: 'emit',
        textBefore: beforeText || undefined,
        toolCalls: [{
          index: idx,
          id: nextToolCallId(),
          type: 'function',
          function: { name: parsed.name, arguments: parsed.arguments },
        }],
        afterText: afterXml || undefined,
      };
    }
    // Parse failed — treat as regular text
    return { action: 'text_before', text: content };
  }

  // Start buffering
  state.buffering = true;
  state.buf = fromStart;

  if (beforeText) {
    return { action: 'text_before', text: beforeText };
  }
  return { action: 'buffer' };
}

/**
 * Extract tool call XML from a complete (non-streaming) response content string.
 * Parses all <tool_call>...</tool_call> blocks and returns structured data
 * for modifying the response JSON, or null if no tool calls found.
 *
 * @param {string} content — the message.content from upstream JSON
 * @returns {null|{content: string, tool_calls: object[]}}
 */
export function extractXmlToolCallsFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  if (!content.includes(TOOL_CALL_START)) return null;

  const textParts = [];
  const toolCalls = [];
  let remaining = content;

  while (remaining.length > 0) {
    const startIdx = remaining.indexOf(TOOL_CALL_START);
    if (startIdx === -1) {
      textParts.push(remaining);
      break;
    }

    // Text before <tool_call>
    if (startIdx > 0) {
      textParts.push(remaining.slice(0, startIdx));
    }

    const endIdx = remaining.indexOf(TOOL_CALL_END, startIdx);
    if (endIdx === -1) {
      // No closing tag — treat as regular text
      textParts.push(remaining.slice(startIdx));
      break;
    }

    const xml = remaining.slice(startIdx, endIdx + TOOL_CALL_END.length);
    const parsed = parseXmlToolCall(xml);
    if (parsed && parsed.name) {
      toolCalls.push({
        index: toolCalls.length,
        id: nextToolCallId(),
        type: 'function',
        function: { name: parsed.name, arguments: parsed.arguments },
      });
    } else {
      // Parse failed — treat as regular text
      textParts.push(xml);
    }

    remaining = remaining.slice(endIdx + TOOL_CALL_END.length);
  }

  if (toolCalls.length === 0) return null;

  return {
    content: textParts.join(''),
    tool_calls: toolCalls,
  };
}
