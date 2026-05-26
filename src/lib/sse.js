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

    // 1) 角色 chunk
    await sseEvent(w, enc, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    // 2) 文字內容（若有的話，可能位於 tool_calls 之前）
    if (msg?.content) {
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }],
      });
    }

    // 3) tool_calls — 採用 OpenAI 規格的多 chunk 格式
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      for (let i = 0; i < msg.tool_calls.length; i++) {
        const tc = msg.tool_calls[i];
        const idx = tc.index ?? i;

        // 3a) 名稱 chunk：id + type + function.name
        await sseEvent(w, enc, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                id: tc.id,
                type: tc.type || 'function',
                function: { name: tc.function.name },
              }],
            },
            finish_reason: null,
          }],
        });

        // 3b) 參數 chunk：function.arguments（完整 JSON）
        await sseEvent(w, enc, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                function: { arguments: tc.function.arguments },
              }],
            },
            finish_reason: null,
          }],
        });
      }

      // 3c) 結束 chunk：空 delta + finish_reason
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
    } else {
      // 無 tool_calls → 直接送 finish_reason 結束 chunk
      await sseEvent(w, enc, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });
    }

    // 4) 用量
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
