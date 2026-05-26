// ─── XML Tool Call Extraction ───────────────────────────────────────
// Some upstream providers don't support structured function calling
// (tool_calls) but may return tool invocation as XML in the content field:
//
//   <tool_call>
//   function_name
//     <arg_key>param1</arg_key>
//     <arg_value>value1</arg_value>
//   </tool_call>
//
// or attribute style:
//   <tool_call tool="name" arg1="val1" arg2="val2">
//
// These utilities detect and convert this format to OpenAI-compatible
// tool_calls for MCP dispatch.

const TOOL_CALL_START = '<tool_call>';
const TOOL_CALL_END = '</tool_call>';
const TOOL_CALL_START_RE = /<tool_call(?:\s[^>]*)?>/gi;

let toolCallIdCounter = 0;

export function nextToolCallId() {
  return 'call_' + Date.now().toString(36) + '_' + (++toolCallIdCounter).toString(36);
}

export function stripToolXmlTags(content) {
  if (!content || typeof content !== 'string') return content;
  let cleaned = content.replace(/<tool_call(?:\s[^>]*)?>[\s\S]*?<\/tool_call>/gi, '');
  cleaned = cleaned.replace(/<tool_call(?:\s[^>]*)?>/gi, '');
  cleaned = cleaned.replace(/<\/tool_call>/gi, '');
  cleaned = cleaned.replace(/<\/?(?:arg_key|arg_value)>/gi, '');
  return cleaned.trim();
}

function parseXmlToolCallAttribute(xml, decode) {
  const attrMatch = xml.match(/<tool_call\s+([^>]*)>/i);
  if (!attrMatch) return null;
  const attrsStr = attrMatch[1];
  const attrs = {};
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(attrsStr)) !== null) {
    attrs[decode(m[1])] = decode(m[2]);
  }
  const toolName = attrs.tool || attrs.name || null;
  if (!toolName) return null;
  const args = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k !== 'tool' && k !== 'name') args[k] = v;
  }
  return { name: toolName, arguments: JSON.stringify(args) };
}

export function parseXmlToolCall(xml) {
  const nameMatch = xml.match(/<tool_call>\s*([^\s<]+)/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  if (!name) return null;

  const keys = [];
  const values = [];
  const keyRe = /<arg_key>([^<]*)<\/arg_key>/g;
  const valRe = /<arg_value>([^<]*)<\/arg_value>/g;
  let m;

  while ((m = keyRe.exec(xml)) !== null) keys.push(m[1]);
  while ((m = valRe.exec(xml)) !== null) values.push(m[1]);

  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const attrFormat = parseXmlToolCallAttribute(xml, decode);
  if (attrFormat) return attrFormat;

  const args = {};
  if (keys.length > 0) {
    keys.forEach((k, i) => { args[decode(k)] = decode(values[i] || ''); });
  }
  return { name, arguments: JSON.stringify(args) };
}

/**
 * Stateful streaming XML tool call processor.
 *
 * Usage:
 *   const state = { buffering: false, buf: '' };
 *   const result = processXmlToolCallStream(content, state);
 *
 * Returns:
 *   { action: 'none' }              — no tool call, forward as-is
 *   { action: 'buffer' }            — buffering XML, skip content
 *   { action: 'text_before', text } — text before <tool_call>
 *   { action: 'emit', toolCalls[], afterText } — parse complete, emit tool calls
 */
export function processXmlToolCallStream(content, state) {
  if (state.buffering) {
    state.buf += content;
    const endIdx = state.buf.indexOf(TOOL_CALL_END);
    if (endIdx === -1) {
      return { action: 'buffer' };
    }
    const xml = state.buf.slice(0, endIdx + TOOL_CALL_END.length);
    state.buf = state.buf.slice(endIdx + TOOL_CALL_END.length);
    state.buffering = false;

    const afterXml = state.buf;
    state.buf = '';

    const parsed = parseXmlToolCall(xml);
    if (parsed && parsed.name) {
      const idx = state.toolCallIndex ?? 0;
      state.toolCallIndex = idx + 1;
      return {
        action: 'emit',
        toolCalls: [{ index: idx, id: nextToolCallId(), type: 'function', function: { name: parsed.name, arguments: parsed.arguments } }],
        afterText: afterXml || undefined,
      };
    }
    const stripped = stripToolXmlTags(xml);
    return { action: 'text_before', text: (stripped + afterXml).trim() || undefined };
  }

  TOOL_CALL_START_RE.lastIndex = 0;
  const startMatch = TOOL_CALL_START_RE.exec(content);
  if (!startMatch) return { action: 'none' };

  const startIdx = startMatch.index;
  const beforeText = content.slice(0, startIdx);
  const fromStart = content.slice(startIdx);

  const endIdx = fromStart.indexOf(TOOL_CALL_END);
  if (endIdx !== -1) {
    const xml = fromStart.slice(0, endIdx + TOOL_CALL_END.length);
    const afterXml = fromStart.slice(endIdx + TOOL_CALL_END.length);

    const parsed = parseXmlToolCall(xml);
    if (parsed && parsed.name) {
      const idx = state.toolCallIndex ?? 0;
      state.toolCallIndex = idx + 1;
      return {
        action: 'emit',
        textBefore: beforeText || undefined,
        toolCalls: [{ index: idx, id: nextToolCallId(), type: 'function', function: { name: parsed.name, arguments: parsed.arguments } }],
        afterText: afterXml || undefined,
      };
    }
    const stripped = stripToolXmlTags(fromStart);
    return { action: 'text_before', text: (beforeText + stripped).trim() || undefined };
  }

  state.buffering = true;
  state.buf = fromStart;
  return beforeText ? { action: 'text_before', text: beforeText } : { action: 'buffer' };
}

export function extractXmlToolCallsFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  TOOL_CALL_START_RE.lastIndex = 0;
  if (!TOOL_CALL_START_RE.test(content)) return null;

  const textParts = [];
  const toolCalls = [];
  let remaining = content;

  while (remaining.length > 0) {
    TOOL_CALL_START_RE.lastIndex = 0;
    const startMatch = TOOL_CALL_START_RE.exec(remaining);
    if (!startMatch) {
      textParts.push(remaining);
      break;
    }
    const startIdx = startMatch.index;
    if (startIdx > 0) textParts.push(remaining.slice(0, startIdx));

    const endIdx = remaining.indexOf(TOOL_CALL_END, startIdx);
    if (endIdx === -1) {
      const afterTag = remaining.slice(startIdx + startMatch[0].length);
      textParts.push(afterTag);
      break;
    }
    const xml = remaining.slice(startIdx, endIdx + TOOL_CALL_END.length);
    const parsed = parseXmlToolCall(xml);
    if (parsed && parsed.name) {
      toolCalls.push({
        id: nextToolCallId(),
        type: 'function',
        function: { name: parsed.name, arguments: parsed.arguments },
      });
    }
    remaining = remaining.slice(endIdx + TOOL_CALL_END.length);
  }

  if (toolCalls.length === 0) return null;
  return { content: textParts.join('') || null, tool_calls: toolCalls };
}

export function normalizeToolCallNames(toolCalls, body) {
  if (!toolCalls || toolCalls.length === 0 || !body?.tools) return;
  const origNames = [];
  for (const t of body.tools) {
    const fn = t.function || t;
    if (fn?.name) origNames.push(fn.name);
  }
  if (origNames.length === 0) return;
  const norm = (s) => s.replace(/_+/g, '_');
  const lookup = {};
  for (const n of origNames) lookup[norm(n)] = n;

  for (const tc of toolCalls) {
    if (!tc.function?.name) continue;
    const raw = tc.function.name;
    if (origNames.includes(raw)) continue;
    const key = norm(raw);
    if (lookup[key]) {
      tc.function.name = lookup[key];
      continue;
    }
    for (const o of origNames) {
      if (o.includes(raw)) { tc.function.name = o; break; }
    }
  }
}

/**
 * 為不支援原生 tool_calls 的模型建立 XML 模擬提示詞。
 * 注入到 system message 結尾，教模型以 <tool_call> XML 格式回應。
 */
export function buildToolSimPrompt(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return '';
  const parts = [
    '\n\n## Available Functions (XML format)',
    'When you need to call a function, respond with XML in this exact format (do NOT wrap in markdown code blocks):',
    '',
    '<tool_call>',
    'function_name',
    '  <arg_key>parameter_name_1</arg_key>',
    '  <arg_value>parameter_value_1</arg_value>',
    '  <arg_key>parameter_name_2</arg_key>',
    '  <arg_value>parameter_value_2</arg_value>',
    '</tool_call>',
    '',
    'Available functions:',
  ];

  for (const tool of tools) {
    const fn = tool.function || tool;
    if (!fn.name) continue;
    parts.push(`\n### ${fn.name}`);
    if (fn.description) parts.push(fn.description);
    if (fn.parameters) {
      const props = fn.parameters.properties;
      if (props) {
        const required = new Set(fn.parameters.required || []);
        const paramList = Object.entries(props).map(([k, v]) => {
          const req = required.has(k) ? '(required)' : '(optional)';
          return `  - ${k}: ${v.type || 'string'} ${req}${v.description ? ' — ' + v.description : ''}`;
        });
        if (paramList.length > 0) parts.push(`Parameters:\n${paramList.join('\n')}`);
      }
    }
  }

  parts.push('\nReturn function calls using the XML format above when needed.');
  return parts.join('\n');
}
