import { insertLog, updateChannelCooldown, getFilters, getDbConfig, getAvailableChannels, incrementChannelUsage, updateChannelError, resetChannelHealth } from "./db.js";


/**
 * Helper to process escape sequences in filter text (like \n, \r, \t)
 */
function processFilterText(text) {
  if (!text) return "";
  return text.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

/**
 * RollingFilter handles real-time text stream replacement and truncation.
 */
class RollingFilter {
  constructor(patterns) {
    this.patterns = (patterns || [])
      .filter(p => p.is_enabled && p.text)
      .map(p => ({ ...p, processedText: processFilterText(p.text) }))
      .filter(p => p.processedText.length > 0);
    this.buffer = "";
    this.isTruncated = false;
  }
  transform(text) {
    if (this.isTruncated) return "";
    if (!this.patterns.length) return text;
    this.buffer += text;
    let result = "";
    while (this.buffer.length > 0) {
      let matched = null;
      for (const p of this.patterns) { if (this.buffer.startsWith(p.processedText)) { matched = p; break; } }
      if (matched) {
        if (matched.mode === 1) { this.isTruncated = true; this.buffer = ""; return result; }
        this.buffer = this.buffer.substring(matched.processedText.length); continue;
      }
      let longestPrefix = 0;
      for (const p of this.patterns) {
        for (let len = Math.min(this.buffer.length, p.processedText.length - 1); len > 0; len--) {
          if (p.processedText.startsWith(this.buffer.substring(0, len))) { longestPrefix = Math.max(longestPrefix, len); }
        }
      }
      if (longestPrefix > 0 && longestPrefix === this.buffer.length) break;
      result += this.buffer[0]; this.buffer = this.buffer.substring(1);
    }
    return result;
  }
  flush() {
    if (this.isTruncated) return "";
    const r = this.buffer; this.buffer = ""; return r;
  }
}

/**
 * Helper to apply all active filters to a single string (for Non-Streaming)
 */
function applyFiltersToText(text, filters) {
  if (!text || !filters.length) return { text, isTruncated: false };
  let current = text;
  let isTruncated = false;

  const processed = filters.map(f => ({ ...f, pText: processFilterText(f.text) }));

  // Truncate mode (Mode 1)
  for (const f of processed) {
    if (f.mode === 1 && current.includes(f.pText)) {
      current = current.split(f.pText)[0];
      isTruncated = true;
    }
  }
  // Delete mode (Mode 0)
  for (const f of processed) {
    if (f.mode !== 1) {
      current = current.split(f.pText).join("");
    }
  }
  return { text: current, isTruncated };
}

/**
 * Heuristic JSON repair for common AI/Shell issues
 */
function attemptRepairJson(str) {
  try {
    let r = str.replace(/\\"/g, '\\\\"');
    let inString = false, output = "";
    for (let i = 0; i < r.length; i++) {
      let char = r[i];
      if (char === '"' && (i === 0 || r[i - 1] !== '\\')) inString = !inString;
      if (inString && (char === '\n' || char === '\r')) output += (char === '\n' ? '\\n' : '\\r');
      else output += char;
    }
    return JSON.parse(output);
  } catch (e) { return null; }
}

function validateOpenAIRequest(body) {
  if (!body.messages || !Array.isArray(body.messages)) return "Missing 'messages' array.";
  if (body.messages.length === 0) return "'messages' array cannot be empty.";
  return null;
}

export const handleProxy = async (c) => {
  const db = c.env.DB;
  const startTime = Date.now();
  let rawBody = "", body = {}, wasRepaired = false;

  try {
    // 獲取過濾器配置
    const activeFilters = await getFilters(db);

    const configToken = await db.prepare("SELECT value FROM config WHERE key = 'client_bearer_token'").first();
    const authHeader = c.req.header("Authorization");
    if (authHeader !== `Bearer ${configToken?.value || "sk-test123456"}`) return c.json({ error: "Unauthorized" }, 401);

    try {
      rawBody = await c.req.text();
      body = JSON.parse(rawBody);
    } catch (e) {
      const repaired = attemptRepairJson(rawBody);
      if (repaired) { body = repaired; wasRepaired = true; }
      else {
        c.executionCtx.waitUntil(insertLog(db, { channel_name: "System", model: "bad_json", prompt: "parse", request_body: { raw: rawBody.substring(0, 5000) }, response_status: 400, response_body: "Invalid JSON", latency_ms: Date.now() - startTime }));
        return c.json({ error: "Invalid JSON format." }, 400);
      }
    }

    const validationError = validateOpenAIRequest(body);
    if (validationError) {
      c.executionCtx.waitUntil(insertLog(db, { channel_name: "System", model: body.model || "unknown", prompt: "fail", request_body: body, response_status: 400, response_body: validationError, latency_ms: Date.now() - startTime }));
      return c.json({ error: validationError }, 400);
    }

    const cooldownStr = await getDbConfig(db, "cooldown_time");
    const cooldownSeconds = parseInt(cooldownStr || "300");

    const hasImage = body.messages.some(msg => Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url'));
    const list = await getAvailableChannels(db, cooldownSeconds, hasImage);


    if (!list.length) return c.json({ error: "No active channels." }, 503);

    const attempt = async (remains, count = 0) => {
      if (!remains.length || count >= 5) return c.json({ error: "Upstream fail." }, 500);

      let totalWeight = remains.reduce((a, b) => a + b.weight, 0);
      let r = Math.random() * totalWeight;
      let selIdx = 0;
      for (let i = 0; i < remains.length; i++) { if (r < remains[i].weight) { selIdx = i; break; } r -= remains[i].weight; }
      const sel = remains[selIdx];

      const upstreamBody = { ...body, model: sel.model_name };
      const targetUrl = sel.base_url.replace(/\/$/, "") + "/v1/chat/completions";
      const lastMsg = body.messages.at(-1)?.content;
      const promptSummary = (typeof lastMsg === 'string' ? lastMsg : JSON.stringify(lastMsg) || "").substring(0, 100);

      c.executionCtx.waitUntil(incrementChannelUsage(db, sel.id));

      if (count > 0) await new Promise(res => setTimeout(res, 500 * count));

      try {
        // Build request headers - disguise as normal OpenAI client
        const upstreamHeaders = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sel.api_key}`,
          "User-Agent": "OpenAI/1.3.7",
          "Accept": "application/json",
          // Additional headers to avoid blocking
          "Accept-Encoding": "gzip, deflate",
          "Connection": "keep-alive",
          "Cache-Control": "no-cache",
        };

        // Add OpenAI-specific headers for better mimicry
        if (sel.base_url.includes("openai.com")) {
          upstreamHeaders["OpenAI-Beta"] = "v1";
        }

        const res = await fetch(targetUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamBody),
        }).catch(err => {
          throw new Error(`Fetch failed: ${err.message}`);
        });

        // Handle non-OK responses before streaming
        if (!res.ok) {
          const errorText = await res.text();
          c.executionCtx.waitUntil(insertLog(db, {
            channel_name: (wasRepaired ? "[Repaired] " : "") + sel.name,
            model: upstreamBody.model,
            prompt: promptSummary,
            request_body: upstreamBody,
            target_url: targetUrl,
            response_status: res.status,
            response_body: errorText || "[No Data]",
            latency_ms: Date.now() - startTime
          }));

          // Update channel status based on error type
          if (res.status === 429 || res.status === 401 || res.status >= 500) {
            await updateChannelCooldown(db, sel.id);
            c.executionCtx.waitUntil(updateChannelError(db, sel.id, `Status ${res.status}: ${errorText.substring(0, 100)}`));
            remains.splice(selIdx, 1);
            return attempt(remains, count + 1);
          }
          if (res.status === 200) {
            c.executionCtx.waitUntil(resetChannelHealth(db, sel.id));
          }
          return new Response(errorText, {
            status: res.status,
            headers: {
              "Content-Type": res.headers.get("Content-Type") || "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        if (upstreamBody.stream) {
          const [clientStream, logStream] = res.body.tee();
          const filter = new RollingFilter(activeFilters);
          const encoder = new TextEncoder(), decoder = new TextDecoder();

          const transformedStream = new ReadableStream({
            async start(controller) {
              const reader = clientStream.getReader();
              let streamBuffer = "";
              let lastDataObj = null;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  streamBuffer += decoder.decode(value, { stream: true });
                  let lines = streamBuffer.split("\n");
                  streamBuffer = lines.pop();
                  for (const line of lines) {
                    if (line.startsWith("data: ")) {
                      const dataStr = line.slice(6).trim();
                      if (dataStr === "[DONE]") {
                        const remaining = filter.flush();
                        if (remaining && lastDataObj) {
                          const finalChunk = JSON.parse(JSON.stringify(lastDataObj));
                          if (finalChunk.choices?.[0]) {
                            finalChunk.choices[0].delta = { content: remaining };
                            delete finalChunk.choices[0].finish_reason;
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
                          }
                        }
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                      } else {
                        try {
                          const data = JSON.parse(dataStr);
                          lastDataObj = data;
                          const delta = data.choices?.[0]?.delta;
                          if (delta) {
                            if (delta.content) delta.content = filter.transform(delta.content);
                            if (delta.reasoning_content) delta.reasoning_content = filter.transform(delta.reasoning_content);
                            if (filter.isTruncated) {
                              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                              reader.cancel(); return;
                            }
                          }
                          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                        } catch (e) { controller.enqueue(encoder.encode(line + "\n")); }
                      }
                    } else if (line.trim()) { controller.enqueue(encoder.encode(line + "\n")); }
                  }
                }
              } finally { controller.close(); reader.releaseLock(); }
            }
          });

          c.executionCtx.waitUntil((async () => {
            let fullText = "", reasoningText = "";
            const reader = logStream.getReader();
            const logDecoder = new TextDecoder();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const lines = logDecoder.decode(value).split("\n");
                for (const l of lines) {
                  if (l.startsWith("data: ") && !l.includes("[DONE]")) {
                    try {
                      const d = JSON.parse(l.slice(6));
                      const delta = d.choices[0]?.delta;
                      if (delta?.content) fullText += delta.content;
                      if (delta?.reasoning_content) reasoningText += delta.reasoning_content;
                    } catch (e) { }
                  }
                }
                if (fullText.length + reasoningText.length > 25000) break;
              }
            } finally { reader.releaseLock(); }

            let loggedResponse = (reasoningText ? "--- Reasoning ---\n" + reasoningText + "\n\n" : "") + fullText;
            activeFilters.forEach(f => {
              const pText = processFilterText(f.text);
              if (f.mode === 1) loggedResponse = loggedResponse.split(pText)[0];
              else loggedResponse = loggedResponse.split(pText).join("");
            });
            await insertLog(db, { channel_name: (wasRepaired ? "[Repaired] " : "") + sel.name, model: upstreamBody.model, prompt: promptSummary, request_body: upstreamBody, target_url: targetUrl, response_status: res.status, response_body: loggedResponse || "[Stream Content]", latency_ms: Date.now() - startTime });
          })());

          return new Response(transformedStream, { status: res.status, headers: { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" } });
        } else {
          // Non-streaming response (res.ok is guaranteed - errors handled above)
          const responseText = await res.text();
          let outputBody = responseText;

          if (activeFilters.length > 0) {
            try {
              const data = JSON.parse(responseText);
              const msg = data.choices?.[0]?.message;
              if (msg) {
                if (msg.content) {
                  const resF = applyFiltersToText(msg.content, activeFilters);
                  msg.content = resF.text;
                }
                if (msg.reasoning_content) {
                  const resF = applyFiltersToText(msg.reasoning_content, activeFilters);
                  msg.reasoning_content = resF.text;
                }
              }
              outputBody = JSON.stringify(data);
            } catch (e) {
              activeFilters.forEach(f => {
                const pText = processFilterText(f.text);
                if (f.mode === 1) outputBody = outputBody.split(pText)[0];
                else outputBody = outputBody.split(pText).join("");
              });
            }
          }

          c.executionCtx.waitUntil(insertLog(db, {
            channel_name: (wasRepaired ? "[Repaired] " : "") + sel.name,
            model: upstreamBody.model,
            prompt: promptSummary,
            request_body: upstreamBody,
            target_url: targetUrl,
            response_status: res.status,
            response_body: outputBody || "[No Data]",
            latency_ms: Date.now() - startTime
          }));

          // Reset channel health on success
          c.executionCtx.waitUntil(resetChannelHealth(db, sel.id));

          return new Response(outputBody, {
            status: res.status,
            headers: {
              "Content-Type": res.headers.get("Content-Type") || "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
      } catch (e) {
        console.error("Channel request failed:", e.message);
        remains.splice(selIdx, 1);
        return attempt(remains, count + 1);
      }
    };
    return attempt(list, 0);
  } catch (criticalErr) { return c.json({ error: criticalErr.message }, 500); }
};
