import { Hono } from 'hono'
import { cors } from 'hono/cors'
import dashboard from './dashboard'

const app = new Hono()
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'anthropic-version'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
  maxAge: 600,
  credentials: true,
}))

app.route('/', dashboard)

let cache = { data: null, ts: 0 }

const isLocal = (c) => c.req.url.includes('localhost') || c.req.url.includes('127.0.0.1')
const debug = (c, msg) => { if (isLocal(c)) console.log(msg) }

function mapToClaude(body) {
  return {
    model: body.model,
    messages: body.messages,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream,
    tools: body.tools,
    tool_choice: body.tool_choice
  }
}

function mapFromClaude(json) {
  const content = json.content || []
  const text = content.filter(c => c.type === "text").map(c => c.text).join("")
  const reasoning = content.filter(c => c.type === "thinking").map(c => c.thinking).join("")
  const tool_calls = content.filter(c => c.type === "tool_use").map(t => ({
    id: t.id,
    type: "function",
    function: { name: t.name, arguments: JSON.stringify(t.input || {}) }
  }))
  return {
    id: json.id,
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: text, reasoning_content: reasoning || undefined, tool_calls: tool_calls.length ? tool_calls : undefined },
      finish_reason: "stop"
    }]
  }
}

function hasImage(messages = []) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === "image_url" || c.type === "input_image"))
}

function attemptRepairJson(str) {
  try { return JSON.parse(str) } catch (e) {}
  let s = str.trim()
  if (s.startsWith('```json')) s = s.replace(/^```json\n?/, '').replace(/\n?```$/, '')
  try { return JSON.parse(s) } catch (e) {}
  try {
    let r = s.replace(/\\"/g, '\\\\"');
    let inString = false, output = "";
    for (let i = 0; i < r.length; i++) {
      let char = r[i];
      if (char === '"' && (i === 0 || r[i - 1] !== '\\')) inString = !inString;
      if (inString && (char === '\n' || char === '\r')) {
        output += (char === '\n' ? '\\n' : '\\r');
      } else {
        output += char;
      }
    }
    return JSON.parse(output);
  } catch (e) {}
  return null
}

class RollingFilter {
  constructor(filters) {
    this.filters = filters.filter(f => f.is_enabled)
    this.buffer = ""
  }
  transform(chunk) {
    if (this.filters.length === 0) return chunk
    this.buffer += chunk
    let modified = false
    for (const f of this.filters) {
      if (f.mode === 1) {
        const idx = this.buffer.indexOf(f.text)
        if (idx !== -1) { this.buffer = this.buffer.substring(0, idx); modified = true; }
      } else {
        if (this.buffer.includes(f.text)) { this.buffer = this.buffer.split(f.text).join(""); modified = true; }
      }
    }
    const out = this.buffer
    this.buffer = out.slice(-20)
    return modified ? out : chunk
  }
}

function selectChannel(channels, cooldownTime) {
  const now = Math.floor(Date.now() / 1000)
  const available = channels.filter(c => {
    if (c.consecutive_errors >= 5) {
      if (now - (c.last_error_at || 0) > 604800) return true
      return false
    }
    if ((now - (c.last_429 || 0)) < cooldownTime) return false
    return true
  })
  if (available.length === 0) return null
  const totalWeight = available.reduce((sum, c) => sum + (c.weight || 1), 0)
  let r = Math.random() * totalWeight
  for (const c of available) {
    r -= (c.weight || 1)
    if (r <= 0) return c
  }
  return available[0]
}

function transformStream(readable, filters, provider) {
  const { readable: r, writable: w } = new TransformStream()
  const writer = w.getWriter()
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const filter = new RollingFilter(filters)
  let buffer = ""
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let lines = buffer.split("\n")
        buffer = lines.pop()
        for (let line of lines) {
          if (!line.startsWith("data: ")) continue
          const dataStr = line.replace("data: ", "").trim()
          if (dataStr === "[DONE]") { await writer.write(encoder.encode("data: [DONE]\n\n")); continue; }
          try {
            const json = JSON.parse(dataStr)
            let content = "", reasoning = ""
            if (provider === "anthropic") {
              if (json.type === "content_block_delta") {
                if (json.delta?.text) content = json.delta.text
                if (json.delta?.thinking) reasoning = json.delta.thinking
              }
            } else {
              content = json.choices?.[0]?.delta?.content || ""
              reasoning = json.choices?.[0]?.delta?.reasoning_content || ""
            }
            if (content || reasoning) {
              if (content) content = filter.transform(content)
              const chunk = {
                id: "chatcmpl-" + Math.random().toString(36).slice(2),
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                choices: [{ index: 0, delta: { content: content || undefined, reasoning_content: reasoning || undefined }, finish_reason: null }]
              }
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
          } catch (e) {}
        }
      }
    } finally {
      writer.close()
    }
  })()
  return r
}

app.get('/v1/models', c => c.json({
  object: "list",
  data: [{ id: "openai", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "gateway" }]
}))

function validateChatBody(body) {
  if (!body || typeof body !== 'object') return "Body must be a JSON object"
  if (!Array.isArray(body.messages)) return "Field 'messages' must be an array"
  if (body.messages.length === 0) return "Field 'messages' cannot be empty"
  for (const m of body.messages) {
    if (!m.role) return "Each message must have a 'role'"
  }
  return null
}

app.post('/v1/chat/completions', async c => {
  const now = Date.now()
  if (!cache.data || now - cache.ts > 30000) {
    const [ch, fl, cf] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels WHERE is_enabled=1").all(),
      c.env.DB.prepare("SELECT * FROM filters WHERE is_enabled=1").all(),
      c.env.DB.prepare("SELECT * FROM config WHERE id=1").first()
    ])
    cache = { data: { channels: ch.results, filters: fl.results, config: cf || { client_token: "sk-test123456", cooldown_time: 300 } }, ts: now }
  }
  const token = (c.req.header("Authorization") || "").replace("Bearer ", "")
  if (cache.data.config.client_token && token !== cache.data.config.client_token) return c.json({ error: "Unauthorized" }, 401)
  const bodyText = await c.req.text()
  let body = attemptRepairJson(bodyText)
  if (!body) {
    debug(c, `[Gateway] Invalid JSON Body: ${bodyText}`)
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400)
  }
  const error = validateChatBody(body)
  if (error) {
    debug(c, `[Gateway] Validation Failed: ${error}. Body: ${JSON.stringify(body)}`)
    return c.json({ error: { message: error, type: "invalid_request_error" } }, 400)
  }
  const isVision = hasImage(body.messages)
  let pool = cache.data.channels.filter(ch => isVision ? ch.is_vision === 1 : true)
  if (pool.length === 0) return c.json({ error: "No usable channels" }, 503)
  for (let i = 0; i < 3; i++) {
    const ch = selectChannel(pool, cache.data.config.cooldown_time)
    if (!ch) break
    let baseUrl = ch.base_url.replace(/\/v[0-9]+$/, "").replace(/\/$/, "")
    let url = baseUrl + (ch.provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions")
    let reqBody = ch.provider === "anthropic" ? mapToClaude(body) : body
    debug(c, `[Gateway] Calling ${ch.name}: ${url}`)
    debug(c, `[Gateway] Body: ${JSON.stringify(reqBody).slice(0, 500)}...`)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ch.api_key}`,
          "Content-Type": "application/json",
          ...(ch.provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {})
        },
        body: JSON.stringify(reqBody)
      })
      if (!res.ok) {
        const resClone = res.clone()
        const errorMsg = await resClone.text().then(t => t.slice(0, 100)).catch(() => "Unknown error")
        debug(c, `[Gateway] ${ch.name} failed (${res.status}): ${errorMsg}`)
        const ts = Math.floor(Date.now() / 1000)
        if (res.status === 429) {
          c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE channels SET last_429 = ?, last_error_msg = ?, last_error_at = ? WHERE id = ?").bind(ts, "Rate limited (429)", ts, ch.id).run())
        } else if (res.status === 401 || res.status === 403) {
          c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE channels SET consecutive_errors = 5, last_error_msg = ?, last_error_at = ? WHERE id = ?").bind("Auth failed (" + res.status + ")", ts, ch.id).run())
        } else {
          c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE channels SET consecutive_errors = consecutive_errors + 1, last_error_msg = ?, last_error_at = ? WHERE id = ?").bind(errorMsg, ts, ch.id).run())
        }
        pool = pool.filter(p => p.id !== ch.id); continue
      }
      if (ch.consecutive_errors > 0) c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE channels SET consecutive_errors = 0, last_error_at = 0 WHERE id = ?").bind(ch.id).run())
      if (body.stream) return new Response(transformStream(res.body, cache.data.filters, ch.provider), { headers: { "Content-Type": "text/event-stream" } })
      const resText = await res.text()
      let json = attemptRepairJson(resText)
      if (!json) continue
      if (ch.provider === "anthropic") json = mapFromClaude(json)
      if (json.choices?.[0]?.message?.content) {
        const f = new RollingFilter(cache.data.filters)
        json.choices[0].message.content = f.transform(json.choices[0].message.content)
      }
      return c.json(json)
    } catch (e) {
      debug(c, `[Gateway] ${ch.name} error: ${e.message}`)
      const ts = Math.floor(Date.now() / 1000)
      c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE channels SET consecutive_errors = consecutive_errors + 1, last_error_msg = ?, last_error_at = ? WHERE id = ?").bind(e.message, ts, ch.id).run())
      pool = pool.filter(p => p.id !== ch.id)
    }
  }
  return c.json({ error: "All upstream failed" }, 502)
})

export default app