export const SSE_CHUNK_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

export class RollingFilter {
  constructor(filters) {
    this.filters = (filters || []).filter(f => f.is_enabled && f.text && f.text.length >= 1 && f.text.length <= 30);
    this.buf = "";
    this.safe = this.filters.reduce((m, f) => Math.max(m, f.text.length - 1), 0);
    this.truncated = false;
  }
  transform(chunk) {
    if (this.filters.length === 0) return chunk;
    if (this.truncated) return "";
    this.buf += chunk;
    for (const f of this.filters) {
      if (f.mode === 1) {
        const idx = this.buf.indexOf(f.text);
        if (idx !== -1) { this.buf = this.buf.substring(0, idx); this.truncated = true; break; }
      } else {
        this.buf = this.buf.split(f.text).join("");
      }
    }
    if (this.truncated) { const out = this.buf; this.buf = ""; return out; }
    const flush = Math.max(0, this.buf.length - this.safe);
    const out = this.buf.slice(0, flush);
    this.buf = this.buf.slice(flush);
    return out;
  }
  flush() {
    if (this.truncated) return "";
    const out = this.buf; this.buf = ""; return out;
  }
  static applyStatic(text, filters) {
    if (!text || !filters || filters.length === 0) return text;
    const enabled = filters.filter(f => f.is_enabled && f.text && f.text.length >= 1 && f.text.length <= 30);
    let out = text;
    for (const f of enabled) {
      if (f.mode === 1) { const idx = out.indexOf(f.text); if (idx !== -1) out = out.substring(0, idx); }
      else { out = out.split(f.text).join(""); }
    }
    return out;
  }
}

export function sseEvent(w, enc, data) {
  return w.write(enc.encode("data: " + JSON.stringify(data) + "\n\n"));
}

export function sseComment(w, enc, comment) {
  return w.write(enc.encode(": " + comment + "\n\n"));
}

function buildErrorChunk(msg) {
  return {
    id: "chatcmpl-" + Date.now(), object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { content: "\n\n" + msg }, finish_reason: "stop" }],
  };
}

export async function writeStreamError(w, enc, msg) {
  try {
    await sseEvent(w, enc, buildErrorChunk(msg));
  } catch (e) {
    // Stream already closed — expected when client disconnects
  }
  try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e) {
    // [DONE] write failure is normal if client disconnected first
  }
}

export async function writeSimulatedStream(w, enc, json) {
  try {
    const msg = json?.choices?.[0]?.message;
    const finishReason = json?.choices?.[0]?.finish_reason || "stop";
    const id = json.id || ("chatcmpl-" + Date.now());
    const created = json.created || Math.floor(Date.now() / 1000);
    const model = json.model || "";

    await sseEvent(w, enc, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      // OpenAI 規格：每個 tool_call chunk 應有獨立 index
      for (let i = 0; i < msg.tool_calls.length; i++) {
        const tc = msg.tool_calls[i];
        await sseEvent(w, enc, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: tc.index ?? i,
                id: tc.id,
                type: tc.type,
                function: tc.function,
              }],
            },
            finish_reason: i === msg.tool_calls.length - 1 ? "tool_calls" : null,
          }],
        });
      }
    } else if (msg?.content) {
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: msg.content }, finish_reason }],
      });
    }

    if (json.usage) {
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [],
        usage: json.usage,
      });
    }

    await w.write(enc.encode("data: [DONE]\n\n"));
  } catch (e) {
    try { await w.write(enc.encode("data: [DONE]\n\n")); } catch (e2) {}
  }
}
