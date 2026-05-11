import { Hono } from "hono";
import { cors } from "hono/cors";
import dashboard from "./dashboard";

const app = new Hono();
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: false,
  }),
);

let cache = { data: null, ts: 0 };
let cacheFlight = null;
const clearCache = () => {
  cache.data = null;
  cache.ts = 0;
  cacheFlight = null;
};

app.route("/", dashboard(clearCache));

const debug = (c, msg) => {
  if (c.env.DEBUG) console.log(msg);
};

function hasImage(messages = []) {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (c) =>
          c.type === "image_url" ||
          c.type === "input_image" ||
          c.type === "image",
      ),
  );
}

// --- Protocol Translators ---

function o2aRequest(body, targetModel) {
  const messages = [];
  let system = "";
  for (const m of body.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      system +=
        (system ? "\n" : "") +
        (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else if (m.role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content:
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      };
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "user") {
        if (!Array.isArray(lastMsg.content))
          lastMsg.content = [{ type: "text", text: lastMsg.content }];
        lastMsg.content.push(toolResult);
      } else {
        messages.push({ role: "user", content: [toolResult] });
      }
    } else {
      let role = m.role;
      let content = m.content;
      if (m.role === "assistant" && m.tool_calls) {
        const contentArr = [];
        if (m.content) contentArr.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls) {
          contentArr.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: attemptRepairJson(tc.function.arguments) || {},
          });
        }
        content = contentArr;
      } else if (Array.isArray(content)) {
        content = content.map((c) => {
          if (c.type === "image_url" && c.image_url?.url?.startsWith("data:")) {
            const match = c.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match)
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: match[1],
                  data: match[2],
                },
              };
          }
          return c;
        });
      }
      messages.push({ role, content: content || "" });
    }
  }

  const mergedMessages = [];
  for (const m of messages) {
    const last = mergedMessages[mergedMessages.length - 1];
    if (last && last.role === m.role) {
      if (!Array.isArray(last.content))
        last.content = [{ type: "text", text: last.content }];
      if (!Array.isArray(m.content))
        last.content.push({ type: "text", text: m.content });
      else last.content.push(...m.content);
    } else {
      mergedMessages.push(m);
    }
  }
  if (mergedMessages.length > 0 && mergedMessages[0].role !== "user")
    mergedMessages.unshift({ role: "user", content: " " });

  return {
    model: targetModel || body.model,
    messages: mergedMessages,
    system: system || undefined,
    max_tokens: body.max_tokens || 4096,
    stop_sequences: Array.isArray(body.stop)
      ? body.stop
      : body.stop
        ? [body.stop]
        : undefined,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    tools: body.tools
      ? body.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || {
          type: "object",
          properties: {},
        },
      }))
      : undefined,
  };
}

function a2oRequest(body, targetModel) {
  const messages = [];
  if (body.system) {
    if (typeof body.system === "string")
      messages.push({ role: "system", content: body.system });
    else if (Array.isArray(body.system))
      messages.push({
        role: "system",
        content: body.system.map((s) => s.text).join("\n"),
      });
  }
  for (const m of body.messages || []) {
    if (Array.isArray(m.content)) {
      let textContent = [],
        tool_calls = [];
      for (const c of m.content) {
        if (c.type === "text") textContent.push({ type: "text", text: c.text });
        else if (c.type === "image")
          textContent.push({
            type: "image_url",
            image_url: {
              url: `data:${c.source.media_type};base64,${c.source.data}`,
            },
          });
        else if (c.type === "tool_use")
          tool_calls.push({
            id: c.id,
            type: "function",
            function: {
              name: c.name,
              arguments:
                typeof c.input === "string" ? c.input : JSON.stringify(c.input),
            },
          });
        else if (c.type === "tool_result")
          messages.push({
            role: "tool",
            tool_call_id: c.tool_use_id,
            content:
              typeof c.content === "string"
                ? c.content
                : JSON.stringify(c.content),
          });
      }
      if (
        textContent.length > 0 ||
        tool_calls.length > 0 ||
        (m.role === "assistant" &&
          textContent.length === 0 &&
          tool_calls.length === 0)
      ) {
        const newMsg = {
          role: m.role,
          content:
            textContent.length === 1 && textContent[0].type === "text"
              ? textContent[0].text
              : textContent.length > 0
                ? textContent
                : "",
        };
        if (tool_calls.length > 0) newMsg.tool_calls = tool_calls;
        messages.push(newMsg);
      }
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return {
    model: targetModel || body.model,
    messages,
    max_tokens: body.max_tokens,
    stop: body.stop_sequences,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    tools: body.tools
      ? body.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
      : undefined,
  };
}

function o2aResponse(json, model) {
  let content = "";
  for (const block of json.content || []) {
    if (block.type === "text") content += block.text;
    else if (block.type === "thinking") content = `> [Thinking]\n> ${block.thinking}\n\n` + content;
    else if (block.type === "tool_use") {
      // Keep track for potential mapping, but o2aResponse currently handles text
    }
  }
  const choice = json.choices?.[0] || {};
  if (choice.message?.content)
    content = choice.message.content;
  if (choice.message?.tool_calls) {
    // Tool calls handled below
  }
  return {
    id: json.id,
    type: "message",
    role: "assistant",
    model: model || json.model,
    content: [{ type: "text", text: content }],
    stop_reason:
      choice.finish_reason === "stop"
        ? "end_turn"
        : choice.finish_reason === "tool_calls"
          ? "tool_use"
          : choice.finish_reason,
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0,
    },
  };
}

function a2oResponse(json, model) {
  let content = "";
  const tool_calls = [];
  for (const c of json.content || []) {
    if (c.type === "text") content += c.text;
    if (c.type === "tool_use")
      tool_calls.push({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      });
  }
  return {
    id: json.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || json.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: tool_calls.length ? tool_calls : undefined,
        },
        finish_reason:
          json.stop_reason === "end_turn"
            ? "stop"
            : json.stop_reason === "tool_use"
              ? "tool_calls"
              : json.stop_reason,
      },
    ],
    usage: {
      prompt_tokens: json.usage?.input_tokens || 0,
      completion_tokens: json.usage?.output_tokens || 0,
      total_tokens:
        (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0),
    },
  };
}

function attemptRepairJson(str) {
  if (!str || str.length > 2_000_000) return null;
  try {
    return JSON.parse(str);
  } catch (e) { }
  let s = str.trim();
  if (s.startsWith("```json"))
    s = s.replace(/^```json\n?/, "").replace(/\n?```$/, "");
  try {
    return JSON.parse(s);
  } catch (e) { }
  try {
    let inString = false,
      output = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' && (i === 0 || s[i - 1] !== "\\")) inString = !inString;
      if (inString && (ch === "\n" || ch === "\r")) {
        output += ch === "\n" ? "\\n" : "\\r";
      } else {
        output += ch;
      }
    }
    return JSON.parse(output);
  } catch (e) { }
  return null;
}

class RollingFilter {
  // Only apply filters whose keyword is 1–30 chars; longer keywords cause streaming latency.
  // safeLen is computed once in the constructor to avoid per-chunk recalculation.
  constructor(filters) {
    this.filters = filters.filter(
      (f) => f.is_enabled && f.text && f.text.length > 0 && f.text.length <= 30,
    );
    this.safeLen = this.filters.reduce(
      (m, f) => Math.max(m, f.text.length - 1),
      0,
    );
    this.buffer = "";
    this.truncated = false;
  }
  transform(chunk) {
    if (this.filters.length === 0) return chunk;
    if (this.truncated) return "";
    this.buffer += chunk;
    for (const f of this.filters) {
      if (f.mode === 1) {
        const idx = this.buffer.indexOf(f.text);
        if (idx !== -1) {
          this.buffer = this.buffer.substring(0, idx);
          this.truncated = true;
          break;
        }
      } else {
        this.buffer = this.buffer.split(f.text).join("");
      }
    }
    if (this.truncated) {
      const out = this.buffer;
      this.buffer = "";
      return out;
    }
    const flushLen = Math.max(0, this.buffer.length - this.safeLen);
    const out = this.buffer.slice(0, flushLen);
    this.buffer = this.buffer.slice(flushLen);
    return out;
  }
  flush() {
    if (this.truncated) return "";
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
}

function selectChannel(channels, delay_period) {
  const now = Math.floor(Date.now() / 1000);
  const available = channels.filter((c) => {
    if (!c.is_enabled) return false;
    if (c.consecutive_errors >= 5) return now - (c.last_error_at || 0) > 1800;
    if (now - (c.last_429 || 0) < delay_period) return false;
    if (c.rpm_limit > 0) {
      const withinMin = now - (c.rpm_reset_at || 0) < 60;
      if (withinMin && (c.rpm_count || 0) >= c.rpm_limit) return false;
    }
    if (c.rpd_limit > 0) {
      const withinDay = now - (c.rpd_reset_at || 0) < 86400;
      if (withinDay && (c.rpd_count || 0) >= c.rpd_limit) return false;
    }
    return true;
  });
  if (available.length === 0) return null;
  const totalWeight = available.reduce(
    (sum, c) => sum + Math.max(0, c.weight || 0),
    0,
  );
  if (totalWeight <= 0)
    return available[Math.floor(Math.random() * available.length)];
  let r = Math.random() * totalWeight;
  for (const c of available) {
    r -= Math.max(0, c.weight || 0);
    if (r <= 0) return c;
  }
  return available[0];
}

function updateRateCounters(cachedCh, nowSec) {
  if (!cachedCh) return;
  if (nowSec - (cachedCh.rpm_reset_at || 0) >= 60) {
    cachedCh.rpm_count = 1;
    cachedCh.rpm_reset_at = nowSec;
  } else cachedCh.rpm_count = (cachedCh.rpm_count || 0) + 1;
  if (nowSec - (cachedCh.rpd_reset_at || 0) >= 86400) {
    cachedCh.rpd_count = 1;
    cachedCh.rpd_reset_at = nowSec;
  } else cachedCh.rpd_count = (cachedCh.rpd_count || 0) + 1;
}

const mkChunk = (
  delta,
  finish_reason = null,
  model = undefined,
  protocol = "openai",
) => {
  if (protocol === "anthropic") {
    // Anthropic doesn't have a single "chunk" format like OpenAI, but we use this for the filter's tail
    return JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta.content || "" },
    });
  }
  return JSON.stringify({
    id: "chat_id-" + Math.random().toString(36).slice(2),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });
};

function transformStream(
  readable,
  filters,
  responseModel,
  fromProtocol,
  toProtocol,
) {
  const { readable: r, writable: w } = new TransformStream();
  const writer = w.getWriter(),
    reader = readable.getReader();
  const decoder = new TextDecoder(),
    encoder = new TextEncoder();
  const filter = new RollingFilter(filters);
  let buf = "",
    messageId = "response_id_" + Math.random().toString(36).slice(2);
  let anthropicToolIndexMap = {},
    nextAnthropicIndex = 1;
  let openaiToolIndexMap = {},
    nextOpenaiIndex = 0;
  let sentMessageStart = false;
  let stoppedBlocks = new Set();
  let textBlockIndex = 0;

  const send = async (data) => {
    if (typeof data === "object") data = JSON.stringify(data);
    await writer.write(encoder.encode(`data: ${data}\n\n`));
  };

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          let trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.startsWith("data: ")
            ? trimmed.slice(6).trim()
            : trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            const tail = filter.flush();
            if (tail) {
              if (toProtocol === "anthropic") {
                if (!sentMessageStart) {
                  sentMessageStart = true;
                  await send({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", model: responseModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
                  await send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                }
                await send({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: tail },
                });
              } else {
                await send(
                  mkChunk({ content: tail }, null, responseModel, "openai"),
                );
              }
            }
            if (toProtocol === "openai") await send("[DONE]");
            continue;
          }

          try {
            const json = JSON.parse(dataStr);
            if (json.type === "ping") {
              if (toProtocol === "anthropic") await send(json);
              continue;
            }
            if (json.type === "error") {
              const errMsg = json.error?.message || "Unknown stream error";
              if (toProtocol === "anthropic") {
                await send({
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "text_delta",
                    text: `\n\n[Upstream Error: ${errMsg}]`,
                  },
                });
                await send({ type: "message_stop" });
              } else {
                await send(
                  mkChunk(
                    { content: `\n\n[Upstream Error: ${errMsg}]` },
                    "stop",
                    responseModel,
                    "openai",
                  ),
                );
                await send("[DONE]");
              }
              continue;
            }
            let content = "",
              finishReason = null,
              toolCalls = null;

            if (fromProtocol === "openai") {
              const choice = json.choices?.[0];
              content = choice?.delta?.content || "";
              finishReason = choice?.finish_reason;
              toolCalls = choice?.delta?.tool_calls;
            } else {
              if (json.type === "content_block_delta") {
                if (json.delta?.type === "text_delta")
                  content = json.delta?.text || "";
                else if (json.delta?.type === "input_json_delta") {
                  const oIdx = anthropicToolIndexMap[json.index] ?? 0;
                  toolCalls = [
                    {
                      index: oIdx,
                      function: { arguments: json.delta.partial_json },
                    },
                  ];
                }
              } else if (
                json.type === "content_block_start" &&
                json.content_block?.type === "tool_use"
              ) {
                anthropicToolIndexMap[json.index] = nextOpenaiIndex++;
                toolCalls = [
                  {
                    index: anthropicToolIndexMap[json.index],
                    id: json.content_block.id,
                    type: "function",
                    function: { name: json.content_block.name, arguments: "" },
                  },
                ];
              } else if (json.type === "message_delta") {
                finishReason = json.delta?.stop_reason;
              }
              // content_block_stop tracked for forwarding
            }

            let outContent = content ? filter.transform(content) : "";
            if (finishReason) outContent += filter.flush();

            if (toProtocol === "anthropic") {
              if (fromProtocol === "anthropic") {
                // Filter-aware pass-through: forward ALL events as-is,
                // only intercept text_delta for content filtering.
                // This naturally supports thinking blocks, tool_use, and all future event types.
                if (json.type === "message_start") {
                  if (responseModel) json.message = { ...json.message, model: responseModel };
                  await send(json);
                } else if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
                  if (!filters.length) {
                    await send(json);
                  } else {
                    const filtered = filter.transform(json.delta.text || "");
                    if (filtered) {
                      await send({ ...json, delta: { type: "text_delta", text: filtered } });
                    }
                  }
                } else if (json.type === "content_block_stop" && textBlockIndex === json.index && filters.length) {
                  // Flush filter buffer before closing the text block
                  const tail = filter.flush();
                  if (tail) {
                    await send({ type: "content_block_delta", index: json.index, delta: { type: "text_delta", text: tail } });
                  }
                  await send(json);
                } else if (json.type === "content_block_start" && json.content_block?.type === "text") {
                  textBlockIndex = json.index;
                  await send(json);
                } else if (json.type === "message_delta" && filters.length) {
                  // Safety flush in case content_block_stop didn't trigger
                  const tail = filter.flush();
                  if (tail && textBlockIndex >= 0) {
                    await send({ type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: tail } });
                  }
                  await send(json);
                } else {
                  // Forward everything else as-is: thinking, tool_use, ping remnants, etc.
                  await send(json);
                }
              } else {
                // openai → anthropic translation (full synthesis)
                if (!sentMessageStart && (outContent || toolCalls || finishReason)) {
                  sentMessageStart = true;
                  await send({
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      model: responseModel,
                      content: [],
                      usage: { input_tokens: 0, output_tokens: 0 },
                    },
                  });
                  await send({
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  });
                }
                if (outContent)
                  await send({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: outContent },
                  });
                if (toolCalls) {
                  for (const tc of toolCalls) {
                    if (tc.id && tc.function?.name) {
                      openaiToolIndexMap[tc.index] = nextAnthropicIndex++;
                      await send({
                        type: "content_block_start",
                        index: openaiToolIndexMap[tc.index],
                        content_block: {
                          type: "tool_use",
                          id: tc.id,
                          name: tc.function.name,
                          input: {},
                        },
                      });
                    }
                    if (tc.function?.arguments) {
                      await send({
                        type: "content_block_delta",
                        index: openaiToolIndexMap[tc.index],
                        delta: {
                          type: "input_json_delta",
                          partial_json: tc.function.arguments,
                        },
                      });
                    }
                  }
                }
                if (finishReason) {
                  await send({ type: "content_block_stop", index: 0 });
                  for (const v of Object.values(openaiToolIndexMap))
                    await send({ type: "content_block_stop", index: v });
                  await send({
                    type: "message_delta",
                    delta: {
                      stop_reason:
                        finishReason === "stop"
                          ? "end_turn"
                          : finishReason === "tool_calls"
                            ? "tool_use"
                            : finishReason,
                      stop_sequence: null,
                    },
                    usage: { output_tokens: 0 },
                  });
                  await send({ type: "message_stop" });
                }
              }
            } else {
              if (fromProtocol === "openai" && !filters.length) {
                if (responseModel) json.model = responseModel;
                await send(json);
              } else {
                const delta = {};
                if (outContent) delta.content = outContent;
                if (toolCalls) delta.tool_calls = toolCalls;
                if (delta.content || delta.tool_calls || finishReason) {
                  await send(
                    mkChunk(
                      delta,
                      finishReason === "end_turn"
                        ? "stop"
                        : finishReason === "tool_use"
                          ? "tool_calls"
                          : finishReason,
                      responseModel,
                      "openai",
                    ),
                  );
                }
              }
            }
          } catch (e) {
            console.error("[Stream parse]", e.message, "raw:", trimmed?.slice(0, 200));
          }
        }
      }
    } finally {
      try {
        writer.close();
      } catch (e) { }
    }
  })();
  return r;
}

// Rate limit counters storage (in-memory, persisted to D1 on cache refresh)
let rateLimitCache = { data: {}, ts: 0 };

async function loadCache(env) {
  const ttl = cache.data?.channels?.some(
    (ch) => ch.rpm_limit > 0 || ch.rpd_limit > 0,
  )
    ? 10000
    : 30000;
  const needsSave = cache.data && Date.now() - cache.ts >= ttl;
  if (cache.data && !needsSave) return cache.data;

  if (!cacheFlight) {
    cacheFlight = (async () => {
      if (needsSave) {
        await saveRateLimits(env).catch(() => { });
      }
      try {
        const [ch, fl, cf] = await Promise.all([
          env.DB.prepare("SELECT * FROM channels WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM filters WHERE is_enabled=1").all(),
          env.DB.prepare("SELECT * FROM config WHERE id=1").first(),
        ]);
        const nowSec = Math.floor(Date.now() / 1000);
        const channels = ch.results || [];
        for (const c of channels) {
          const saved = rateLimitCache.data[c.id];
          if (saved) {
            if (nowSec - saved.rpm_reset_at < 60) {
              c.rpm_count = saved.rpm_count;
              c.rpm_reset_at = saved.rpm_reset_at;
            }
            if (nowSec - saved.rpd_reset_at < 86400) {
              c.rpd_count = saved.rpd_count;
              c.rpd_reset_at = saved.rpd_reset_at;
            }
          }
        }
        cache = {
          data: {
            channels,
            filters: fl.results || [],
            config: cf || { client_token: "sk-test123456", recovery_period: 300 },
          },
          ts: Date.now(),
        };
        cacheFlight = null;
        return cache.data;
      } catch (e) {
        cacheFlight = null;
        console.error("[loadCache] D1 query failed:", e.message);
        throw e;
      }
    })();
  }
  return cacheFlight;
}

// Save rate limit counters to D1
async function saveRateLimits(env) {
  if (!cache.data?.channels) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const updates = [];
  for (const ch of cache.data.channels) {
    if (ch.rpm_limit > 0 || ch.rpd_limit > 0) {
      // Save to in-memory cache
      rateLimitCache.data[ch.id] = {
        rpm_count: ch.rpm_count || 0,
        rpm_reset_at: ch.rpm_reset_at || nowSec,
        rpd_count: ch.rpd_count || 0,
        rpd_reset_at: ch.rpd_reset_at || nowSec,
      };
      // Batch write to D1
      updates.push(
        env.DB.prepare(
          "UPDATE channels SET rpm_count=?, rpm_reset_at=?, rpd_count=?, rpd_reset_at=? WHERE id=?",
        ).bind(
          ch.rpm_count || 0,
          ch.rpm_reset_at || nowSec,
          ch.rpd_count || 0,
          ch.rpd_reset_at || nowSec,
          ch.id,
        ),
      );
    }
  }
  if (updates.length > 0) {
    env.DB.batch(updates).catch(() => { });
  }
}

// dynamically return deduplicated models
app.get("/v1/models", async (c) => {
  let channels = [];
  try {
    const d = await loadCache(c.env);
    channels = d?.channels || [];
  } catch (e) {
    channels = cache.data?.channels || [];
  }
  return c.json({
    object: "list",
    data: [{
      id: "openai",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "gateway",
    }],
  });
});

function validateChatBody(body) {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  if (!Array.isArray(body.messages)) return "Field 'messages' must be an array";
  if (body.messages.length === 0) return "Field 'messages' cannot be empty";
  for (const m of body.messages) {
    if (!m.role) return "Each message must have a 'role'";
  }
  return null;
}

// Return protocol-appropriate error responses
function errResponse(c, protocol, message, type, status) {
  if (protocol === "anthropic") {
    return c.json({ type: "error", error: { type, message } }, status);
  }
  return c.json({ error: { message, type } }, status);
}

// Build a clean upstream URL from a stored base_url.
function buildUpstreamUrl(baseUrl, provider) {
  let base = (baseUrl || "").trim();
  if (!base) return null;
  base = base.replace(/\/+$/, "");

  if (provider === "anthropic") {
    if (base.endsWith("/messages")) return base;
    if (base.endsWith("/v1")) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  if (base.endsWith("/chat/completions")) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

async function handleChatRequest(c, clientProtocol) {
  let data;
  try {
    data = await loadCache(c.env);
  } catch (e) {
    if (!cache.data)
      return errResponse(c, clientProtocol, "Database not initialized", "server_error", 500);
    data = cache.data;
  }

  const token = (
    c.req.header("Authorization") ||
    c.req.header("x-api-key") ||
    ""
  ).replace("Bearer ", "");
  if (data.config.client_token && token !== data.config.client_token)
    return errResponse(c, clientProtocol, "Unauthorized", "authentication_error", 401);

  let body;
  let rawBodyText;
  try {
    rawBodyText = await c.req.text();
    body = JSON.parse(rawBodyText);
  } catch (e) {
    return errResponse(c, clientProtocol, "Invalid JSON body", "invalid_request_error", 400);
  }
  const validErr = validateChatBody(body);
  if (validErr)
    return errResponse(c, clientProtocol, validErr, "invalid_request_error", 400);

  const isVision = hasImage(body.messages);
  const isToolUse = !!(body.tools && body.tools.length > 0);
  let pool = data.channels.filter((ch) => {
    if (ch.is_enabled !== 1) return false;
    if (isVision && ch.is_vision !== 1) return false;
    return true;
  });

  // Estimate tokens from raw text length (avoids expensive re-serialization)
  const estTokens = Math.floor(rawBodyText.length / 4);
  const tokenMatchedPool = pool.filter(
    (ch) => !ch.max_tokens || ch.max_tokens === 0 || estTokens <= ch.max_tokens,
  );
  if (tokenMatchedPool.length > 0) pool = tokenMatchedPool;

  if (isToolUse) {
    const toolSupportedPool = pool.filter((ch) => ch.support_tools !== 0);
    if (toolSupportedPool.length > 0) pool = toolSupportedPool;
  }

  const originalModel = body.model;
  const requestedModel = (originalModel || "").trim().toLowerCase();
  
  if (requestedModel && requestedModel !== "openai") {
    let matched = pool.filter(
      (ch) => (ch.model || "").trim().toLowerCase() === requestedModel,
    );
    // Fuzzy match: if requested model name contains channel model name
    if (matched.length === 0) {
      matched = pool.filter((ch) => {
        const cm = (ch.model || "").trim().toLowerCase();
        return cm && (requestedModel.includes(cm) || cm.includes(requestedModel));
      }).sort((a, b) => (b.model?.length || 0) - (a.model?.length || 0));
    }
    if (matched.length > 0) pool = matched;
  }

  if (pool.length === 0)
    return errResponse(c, clientProtocol, "No enabled channels supporting this request", "server_error", 503);

  const now = Math.floor(Date.now() / 1000);
  const availableCount = pool.filter((ch) => {
    if (ch.consecutive_errors >= 5 && now - (ch.last_error_at || 0) <= 1800)
      return false;
    if (now - (ch.last_429 || 0) < data.config.recovery_period) return false;
    if (
      ch.rpm_limit > 0 &&
      now - (ch.rpm_reset_at || 0) < 60 &&
      (ch.rpm_count || 0) >= ch.rpm_limit
    )
      return false;
    if (
      ch.rpd_limit > 0 &&
      now - (ch.rpd_reset_at || 0) < 86400 &&
      (ch.rpd_count || 0) >= ch.rpd_limit
    )
      return false;
    return true;
  }).length;

  if (availableCount === 0)
    return errResponse(c, clientProtocol, "All channels are rate-limited", "rate_limit_error", 429);

  const isStream =
    body.stream === true || body.stream === "true" || body.stream === 1;
  const dbUpdates = [];

  for (let i = 0, maxTries = Math.min(pool.length, 5); i < maxTries; i++) {
    if (i > 0)
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));

    let ts, cachedCh;
    const ch = selectChannel(pool, data.config.recovery_period);
    if (!ch) break;
    const targetProtocol = ch.provider || "openai";
    const url = buildUpstreamUrl(ch.base_url, targetProtocol);
    if (!url) {
      pool = pool.filter((p) => p.id !== ch.id);
      continue;
    }

    // --- Translation Logic ---
    let reqBody = { ...body };
    if (clientProtocol === "openai" && targetProtocol === "anthropic")
      reqBody = o2aRequest(reqBody, ch.model);
    else if (clientProtocol === "anthropic" && targetProtocol === "openai")
      reqBody = a2oRequest(reqBody, ch.model);
    else if (ch.model) reqBody.model = ch.model;

    // Common sanitization
    if (targetProtocol === "openai" && Array.isArray(reqBody.messages)) {
      reqBody.messages = reqBody.messages.map((m) => {
        let newM = { ...m };
        if (newM.role === "developer") newM.role = "system";
        if (newM.role === "user" && !newM.content) newM.content = " ";
        return newM;
      });
    }

    debug(
      c,
      `[Gateway] ${clientProtocol}->${targetProtocol} | ${ch.name}: ${url}`,
    );

    const timeElapsed = Date.now() / 1000 - now;
    const remainingTime = 29 - timeElapsed;
    if (remainingTime <= 2) break;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      remainingTime * 1000,
    );
    const abortHandler = () => controller.abort();
    c.req.raw.signal?.addEventListener("abort", abortHandler);
    try {
      const upstreamHeaders = {
        "Content-Type": "application/json",
        "User-Agent": c.req.header("User-Agent") || "Claude-Code-Gateway/1.0"
      };
      if (targetProtocol === "anthropic") {
        upstreamHeaders["x-api-key"] = ch.api_key;
        upstreamHeaders["anthropic-version"] = "2023-06-01";
        // Forward beta feature headers (thinking, computer use, etc.)
        const clientBeta = c.req.header("anthropic-beta");
        if (clientBeta) upstreamHeaders["anthropic-beta"] = clientBeta;
      } else {
        upstreamHeaders["Authorization"] = `Bearer ${ch.api_key}`;
      }
      const res = await fetch(url, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      c.req.raw.signal?.removeEventListener("abort", abortHandler);

      if (!res.ok || !res.body) {
        const errText = res.body ? await res.text() : "Empty upstream response";
        ts = Math.floor(Date.now() / 1000);
        cachedCh = data.channels.find((x) => x.id === ch.id);

        let maxTokensToLearn = null;
        const openaiMatch = errText.match(
          /maximum context length is (\d+) tokens/i,
        );
        if (openaiMatch) maxTokensToLearn = parseInt(openaiMatch[1], 10);
        const anthropicMatch = errText.match(/Max allowed is (\d+)/i);
        if (anthropicMatch) maxTokensToLearn = parseInt(anthropicMatch[1], 10);

        if (
          maxTokensToLearn &&
          (!cachedCh || cachedCh.max_tokens !== maxTokensToLearn)
        ) {
          if (cachedCh) cachedCh.max_tokens = maxTokensToLearn;
          dbUpdates.push(
            c.env.DB.prepare(
              "UPDATE channels SET max_tokens=? WHERE id=?",
            ).bind(maxTokensToLearn, ch.id),
          );
        }

        let capabilityLearned = false;
        if (
          errText.match(/does not support image/i) ||
          errText.match(/image.*not supported/i) ||
          errText.match(/images are not supported/i)
        ) {
          capabilityLearned = true;
          if (cachedCh && cachedCh.is_vision !== 0) {
            cachedCh.is_vision = 0;
            dbUpdates.push(
              c.env.DB.prepare(
                "UPDATE channels SET is_vision=0 WHERE id=?",
              ).bind(ch.id),
            );
          }
        }
        if (
          errText.match(/does not support tool/i) ||
          errText.match(/tool_use.*not supported/i) ||
          errText.match(/tools are not supported/i)
        ) {
          capabilityLearned = true;
          if (cachedCh && cachedCh.support_tools !== 0) {
            cachedCh.support_tools = 0;
            dbUpdates.push(
              c.env.DB.prepare(
                "UPDATE channels SET support_tools=0 WHERE id=?",
              ).bind(ch.id),
            );
          }
        }

        console.error(`[Upstream ${res.status}] ${ch.name} ${url}:`, errText.slice(0, 500));
        const debugInfo = JSON.stringify({
          message: errText.slice(0, 500),
          url: url,
          request: JSON.stringify({ model: reqBody.model, stream: reqBody.stream, tools: reqBody.tools?.length || 0, messages: reqBody.messages?.length || 0 }),
          response: errText.slice(0, 2000),
        });

        const isHardQuota = errText.match(/quota.?exceed|insufficient.?quota|insufficient.?credit|weekly.?limit|billing.?inactive|plan.?limit/i);
        const retryAfter = res.headers.get("Retry-After");

        if (res.status === 429 || isHardQuota) {
          let customDelay = ts + data.config.recovery_period;
          if (isHardQuota) {
            customDelay = ts + 604800;
          } else if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) customDelay = ts + seconds;
          }

          if (cachedCh) {
            cachedCh.last_429 = customDelay;
            cachedCh.last_error_msg = debugInfo;
          }
          dbUpdates.push(
            c.env.DB.prepare(
              "UPDATE channels SET last_429=?, last_error_msg=? WHERE id=?",
            ).bind(customDelay, debugInfo, ch.id),
          );
        } else if (!maxTokensToLearn && !capabilityLearned) {
          if (cachedCh) {
            cachedCh.consecutive_errors =
              (cachedCh.consecutive_errors || 0) + 1;
            cachedCh.last_error_at = ts;
            cachedCh.last_error_msg = debugInfo;
          }
          if (!cachedCh || cachedCh.consecutive_errors <= 5) {
            dbUpdates.push(
              c.env.DB.prepare(
                "UPDATE channels SET consecutive_errors=consecutive_errors+1,last_error_msg=?,last_error_at=? WHERE id=?",
              ).bind(debugInfo, ts, ch.id),
            );
          }
        }

        // Don't retry errors that will fail on every channel (body-level issues)
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && !maxTokensToLearn && !capabilityLearned) {
          if (dbUpdates.length > 0)
            c.executionCtx.waitUntil(c.env.DB.batch(dbUpdates).catch(() => { }));
          try {
            const errJson = JSON.parse(errText);
            if (clientProtocol === "anthropic" && !errJson.type) {
              return c.json({ type: "error", error: { type: "upstream_error", message: errJson.error?.message || errText.slice(0, 500) } }, res.status);
            }
            return c.json(errJson, res.status);
          } catch {
            return errResponse(c, clientProtocol, errText.slice(0, 500), "upstream_error", res.status);
          }
        }

        if (ch.fallback_model) {
          const fallbackCh = {
            ...ch,
            model: ch.fallback_model,
            fallback_model: null,
            is_fallback: true,
          };
          pool = pool.map((p) => (p.id === ch.id ? fallbackCh : p));
        } else {
          pool = pool.filter((p) => p.id !== ch.id);
        }
        continue;
      }

      cachedCh = data.channels.find((x) => x.id === ch.id);
      updateRateCounters(cachedCh, Math.floor(Date.now() / 1000));
      if (cachedCh && cachedCh.consecutive_errors > 0) {
        cachedCh.consecutive_errors = 0;
        dbUpdates.push(
          c.env.DB.prepare(
            "UPDATE channels SET consecutive_errors=0,last_error_at=0 WHERE id=?",
          ).bind(ch.id),
        );
      }
      // Sync rate limit counters to D1 for cross-instance accuracy
      if (cachedCh && (cachedCh.rpm_limit > 0 || cachedCh.rpd_limit > 0)) {
        dbUpdates.push(
          c.env.DB.prepare(
            "UPDATE channels SET rpm_count=?, rpm_reset_at=?, rpd_count=?, rpd_reset_at=? WHERE id=?",
          ).bind(cachedCh.rpm_count || 0, cachedCh.rpm_reset_at || 0, cachedCh.rpd_count || 0, cachedCh.rpd_reset_at || 0, ch.id),
        );
      }

      if (isStream) {
        if (dbUpdates.length > 0)
          c.executionCtx.waitUntil(c.env.DB.batch(dbUpdates).catch(() => { }));
        const responseModel = originalModel || ch.model || undefined;
        return new Response(
          transformStream(
            res.body,
            data.filters,
            responseModel,
            targetProtocol,
            clientProtocol,
          ),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "X-Accel-Buffering": "no",
            },
          },
        );
      }

      const resText = await res.text();
      let json = attemptRepairJson(resText);
      if (!json) continue;

      // --- Response Translation ---
      let finalResponse = json;
      if (targetProtocol === "openai" && clientProtocol === "anthropic")
        finalResponse = o2aResponse(json, originalModel);
      else if (targetProtocol === "anthropic" && clientProtocol === "openai")
        finalResponse = a2oResponse(json, originalModel);
      else if (originalModel) finalResponse.model = originalModel;

      if (dbUpdates.length > 0)
        c.executionCtx.waitUntil(c.env.DB.batch(dbUpdates).catch(() => { }));
      return c.json(finalResponse);
    } catch (e) {
      clearTimeout(timeoutId);
      c.req.raw.signal?.removeEventListener("abort", abortHandler);

      if (e.name === 'AbortError') {
        return errResponse(c, clientProtocol, "Request aborted or timed out", "timeout_error", 408);
      }

      ts = Math.floor(Date.now() / 1000);
      cachedCh = data.channels.find((x) => x.id === ch.id);
      const errMsg = e.message || "Network error / Timeout";
      console.error(`[Network error] ${ch.name} ${url}:`, errMsg);
      const debugInfo = JSON.stringify({
        message: errMsg.slice(0, 500),
        url: url,
        request: JSON.stringify({ model: reqBody.model, stream: reqBody.stream, tools: reqBody.tools?.length || 0, messages: reqBody.messages?.length || 0 }),
        response: "",
      });

      if (cachedCh) {
        cachedCh.consecutive_errors = (cachedCh.consecutive_errors || 0) + 1;
        cachedCh.last_error_at = ts;
        cachedCh.last_error_msg = debugInfo;
      }
      if (!cachedCh || cachedCh.consecutive_errors <= 5) {
        dbUpdates.push(
          c.env.DB.prepare(
            "UPDATE channels SET consecutive_errors=consecutive_errors+1,last_error_msg=?,last_error_at=? WHERE id=?",
          ).bind(debugInfo, ts, ch.id),
        );
      }

      if (ch.fallback_model) {
        const fallbackCh = {
          ...ch,
          model: ch.fallback_model,
          fallback_model: null,
          is_fallback: true,
        };
        pool = pool.map((p) => (p.id === ch.id ? fallbackCh : p));
      } else {
        pool = pool.filter((p) => p.id !== ch.id);
      }
    }
  }
  if (dbUpdates.length > 0)
    c.executionCtx.waitUntil(c.env.DB.batch(dbUpdates).catch(() => { }));
  console.error(`[Gateway] All channels failed for model=${body.model} pool=${pool.length}`);
  return errResponse(c, clientProtocol, "All upstream channels failed", "server_error", 502);
}

app.post("/v1/chat/completions", async (c) => handleChatRequest(c, "openai"));
app.post("/v1/messages", async (c) => handleChatRequest(c, "anthropic"));

export default app;
