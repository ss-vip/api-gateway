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

let cache = { data: null, ts: 0 }
let cacheFlight = null
const clearCache = () => { cache.data = null; cache.ts = 0; cacheFlight = null }

app.route('/', dashboard(clearCache))

const debug = (c, msg) => { if (c.req.url.includes('localhost') || c.req.url.includes('127.0.0.1')) console.log(msg) }

function mapToClaude(body) {
  // Extract system messages from messages array (Anthropic requires top-level system field)
  const systemMsgs = (body.messages || []).filter(m => m.role === 'system')
  const system = systemMsgs.map(m => (typeof m.content === 'string' ? m.content : m.content?.map?.(c => c.text || '').join('') || '')).join('\n') || undefined

  // Convert OpenAI tools format → Anthropic format
  const tools = body.tools?.map(t => {
    if (t.type === 'function' && t.function) {
      return { name: t.function.name, description: t.function.description, input_schema: t.function.parameters || { type: 'object', properties: {} } }
    }
    return t
  })

  // Convert messages: handle tool_calls and tool responses
  const messages = []
  for (const m of (body.messages || [])) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      // Anthropic requires tool results to be inside a 'user' message
      // We append it to the previous user message if possible, or create a new one
      const tr = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }
      if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
        const last = messages[messages.length - 1]
        if (Array.isArray(last.content)) last.content.push(tr)
        else last.content = [{ type: 'text', text: last.content }, tr]
      } else {
        messages.push({ role: 'user', content: [tr] })
      }
    } else if (m.role === 'assistant' && m.tool_calls) {
      const content = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const t of m.tool_calls) {
        if (t.type === 'function') {
          content.push({ type: 'tool_use', id: t.id, name: t.function.name, input: JSON.parse(t.function.arguments || '{}') })
        }
      }
      messages.push({ role: 'assistant', content })
    } else {
      // Standard user/assistant message. Clean up any 'name' fields Anthropic rejects
      const cleanMsg = { role: m.role, content: m.content }
      messages.push(cleanMsg)
    }
  }

  // Convert OpenAI tool_choice → Anthropic tool_choice
  let tool_choice
  if (body.tool_choice === 'auto') tool_choice = { type: 'auto' }
  else if (body.tool_choice === 'none') tool_choice = { type: 'none' }
  else if (body.tool_choice === 'required') tool_choice = { type: 'any' }
  else if (typeof body.tool_choice === 'object' && body.tool_choice?.function?.name)
    tool_choice = { type: 'tool', name: body.tool_choice.function.name }

  return {
    model: body.model,
    system,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream,
    tools: tools?.length ? tools : undefined,
    tool_choice,
    thinking: body.thinking,
  }
}

function mapFromClaude(json) {
  const content = json.content || []
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('')
  const reasoning = content.filter(c => c.type === 'thinking').map(c => c.thinking).join('')
  const tool_calls = content.filter(c => c.type === 'tool_use').map(t => ({
    id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) }
  }))
  const hasTools = tool_calls.length > 0
  const finish = hasTools ? 'tool_calls'
    : (json.stop_reason === 'end_turn' ? 'stop' : (json.stop_reason || 'stop'))
  return {
    id: json.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model,
    usage: json.usage ? {
      prompt_tokens: json.usage.input_tokens || 0,
      completion_tokens: json.usage.output_tokens || 0,
      total_tokens: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0),
    } : undefined,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        reasoning_content: reasoning || undefined,
        tool_calls: hasTools ? tool_calls : undefined,
      },
      finish_reason: finish,
    }],
  }
}

function hasImage(messages = []) {
  return messages.some(m => Array.isArray(m.content) &&
    m.content.some(c => c.type === 'image_url' || c.type === 'input_image'))
}

function attemptRepairJson(str) {
  try { return JSON.parse(str) } catch (e) {}
  let s = str.trim()
  if (s.startsWith('```json')) s = s.replace(/^```json\n?/, '').replace(/\n?```$/, '')
  try { return JSON.parse(s) } catch (e) {}
  try {
    let inString = false, output = ''
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === '"' && (i === 0 || s[i - 1] !== '\\')) inString = !inString
      if (inString && (ch === '\n' || ch === '\r')) { output += ch === '\n' ? '\\n' : '\\r' } else { output += ch }
    }
    return JSON.parse(output)
  } catch (e) {}
  return null
}

class RollingFilter {
  constructor(filters) { this.filters = filters.filter(f => f.is_enabled); this.buffer = '' }
  transform(chunk) {
    if (this.filters.length === 0) return chunk
    this.buffer += chunk
    for (const f of this.filters) {
      if (f.mode === 1) { const idx = this.buffer.indexOf(f.text); if (idx !== -1) this.buffer = this.buffer.substring(0, idx) }
      else { this.buffer = this.buffer.split(f.text).join('') }
    }
    // Keep a lookahead suffix sized to the longest filter (to catch cross-chunk matches)
    const safeLen = this.filters.reduce((m, f) => Math.max(m, f.text.length - 1), 0)
    const flushLen = Math.max(0, this.buffer.length - safeLen)
    const out = this.buffer.slice(0, flushLen)
    this.buffer = this.buffer.slice(flushLen)
    return out
  }
  flush() { const out = this.buffer; this.buffer = ''; return out }
}

function selectChannel(channels, cooldownTime) {
  const now = Math.floor(Date.now() / 1000)
  const available = channels.filter(c => {
    if (!c.is_enabled) return false
    if (c.consecutive_errors >= 5) return (now - (c.last_error_at || 0)) > 604800
    if ((now - (c.last_429 || 0)) < cooldownTime) return false
    if (c.rpm_limit > 0) {
      const withinMin = (now - (c.rpm_reset_at || 0)) < 60
      if (withinMin && (c.rpm_count || 0) >= c.rpm_limit) return false
    }
    if (c.rpd_limit > 0) {
      const withinDay = (now - (c.rpd_reset_at || 0)) < 86400
      if (withinDay && (c.rpd_count || 0) >= c.rpd_limit) return false
    }
    return true
  })
  if (available.length === 0) return null
  const totalWeight = available.reduce((sum, c) => sum + Math.max(0, c.weight || 0), 0)
  if (totalWeight <= 0) return available[Math.floor(Math.random() * available.length)]
  let r = Math.random() * totalWeight
  for (const c of available) { r -= Math.max(0, c.weight || 0); if (r <= 0) return c }
  return available[0]
}

// Update RPM/RPD in-memory counters immediately after a successful request
function updateRateCounters(cachedCh, nowSec) {
  if (!cachedCh) return
  if (nowSec - (cachedCh.rpm_reset_at || 0) >= 60) { cachedCh.rpm_count = 1; cachedCh.rpm_reset_at = nowSec }
  else cachedCh.rpm_count = (cachedCh.rpm_count || 0) + 1
  if (nowSec - (cachedCh.rpd_reset_at || 0) >= 86400) { cachedCh.rpd_count = 1; cachedCh.rpd_reset_at = nowSec }
  else cachedCh.rpd_count = (cachedCh.rpd_count || 0) + 1
}

// --- Streaming: full tool_calls support for OpenAI and Anthropic ---
const mkChunk = (delta, finish_reason = null) => ({
  id: 'chatcmpl-' + Math.random().toString(36).slice(2),
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  choices: [{ index: 0, delta, finish_reason }],
})

function transformStream(readable, filters, provider) {
  const { readable: r, writable: w } = new TransformStream()
  const writer = w.getWriter(), reader = readable.getReader()
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  const filter = new RollingFilter(filters)
  let buf = '', toolBlocks = {}, toolCallIdx = 0
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        let lines = buf.split('\n'); buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const dataStr = line.slice(6).trim()
          if (dataStr === '[DONE]') {
            const tail = filter.flush()
            if (tail) await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({ content: tail }))}\n\n`))
            await writer.write(encoder.encode('data: [DONE]\n\n'))
            continue
          }
          try {
            const json = JSON.parse(dataStr)
            if (provider === 'anthropic') {
              if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
                const cb = json.content_block
                toolBlocks[json.index] = { id: cb.id, name: cb.name, idx: toolCallIdx++ }
                await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({
                  tool_calls: [{ index: toolBlocks[json.index].idx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }]
                }))}\n\n`))
              } else if (json.type === 'content_block_delta') {
                const d = json.delta
                if (d?.type === 'text_delta' && d.text) {
                  const out = filter.transform(d.text)
                  if (out) await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({ content: out }))}\n\n`))
                } else if (d?.type === 'thinking_delta' && d.thinking) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({ reasoning_content: d.thinking }))}\n\n`))
                } else if (d?.type === 'input_json_delta' && toolBlocks[json.index]) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({
                    tool_calls: [{ index: toolBlocks[json.index].idx, function: { arguments: d.partial_json || '' } }]
                  }))}\n\n`))
                }
              } else if (json.type === 'message_delta' && json.delta?.stop_reason) {
                const finish = json.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
                await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({}, finish))}\n\n`))
              }
            } else {
              const delta = json.choices?.[0]?.delta || {}
              const finish = json.choices?.[0]?.finish_reason || null
              if (delta.tool_calls?.length) {
                await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({ tool_calls: delta.tool_calls }, finish))}\n\n`))
              } else if (delta.content || delta.reasoning_content) {
                let content = delta.content || '', reasoning = delta.reasoning_content || ''
                if (content) content = filter.transform(content)
                const out = {}
                if (content) out.content = content
                if (reasoning) out.reasoning_content = reasoning
                if (Object.keys(out).length) await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk(out, finish))}\n\n`))
              } else if (finish) {
                await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({}, finish))}\n\n`))
              }
            }
          } catch (e) {}
        }
      }
    } finally { writer.close() }
  })()
  return r
}

async function loadCache(env) {
  // Use shorter TTL when channels have rate limits so exhaustion is detected faster
  const ttl = cache.data?.channels?.some(ch => ch.rpm_limit > 0 || ch.rpd_limit > 0) ? 10000 : 30000
  if (cache.data && Date.now() - cache.ts < ttl) return cache.data
  if (!cacheFlight) {
    cacheFlight = Promise.all([
      env.DB.prepare('SELECT * FROM channels WHERE is_enabled=1').all(),
      env.DB.prepare('SELECT * FROM filters WHERE is_enabled=1').all(),
      env.DB.prepare('SELECT * FROM config WHERE id=1').first(),
    ]).then(([ch, fl, cf]) => {
      cache = {
        data: {
          channels: ch.results || [],
          filters: fl.results || [],
          config: cf || { client_token: 'sk-test123456', cooldown_time: 300 },
        },
        ts: Date.now(),
      }
      cacheFlight = null
      return cache.data
    }).catch(e => { cacheFlight = null; throw e })
  }
  return cacheFlight
}

app.get('/v1/models', c => c.json({
  object: 'list',
  data: [{ id: 'openai', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'gateway' }],
}))

function validateChatBody(body) {
  if (!body || typeof body !== 'object') return "Body must be a JSON object"
  if (!Array.isArray(body.messages)) return "Field 'messages' must be an array"
  if (body.messages.length === 0) return "Field 'messages' cannot be empty"
  for (const m of body.messages) { if (!m.role) return "Each message must have a 'role'" }
  return null
}

app.post('/v1/chat/completions', async c => {
  let data
  try { data = await loadCache(c.env) } catch (e) {
    if (!cache.data) return c.json({ error: { message: 'Database not initialized. Please run schema.sql', type: 'server_error' } }, 500)
    data = cache.data
  }

  const token = (c.req.header('Authorization') || '').replace('Bearer ', '')
  if (data.config.client_token && token !== data.config.client_token)
    return c.json({ error: { message: 'Unauthorized', type: 'authentication_error' } }, 401)

  const body = attemptRepairJson(await c.req.text())
  if (!body) return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  const validErr = validateChatBody(body)
  if (validErr) return c.json({ error: { message: validErr, type: 'invalid_request_error' } }, 400)

  const isVision = hasImage(body.messages)
  let pool = data.channels.filter(ch => ch.is_enabled === 1 && (isVision ? ch.is_vision === 1 : true))
  if (pool.length === 0) return c.json({ error: { message: 'No enabled channels configured', type: 'server_error' } }, 503)

  // Detect if all available channels are exhausted by rate limits vs genuinely unavailable
  const now503 = Math.floor(Date.now() / 1000)
  const availableCount = pool.filter(ch => {
    if (ch.consecutive_errors >= 5 && (now503 - (ch.last_error_at || 0)) <= 604800) return false
    if ((now503 - (ch.last_429 || 0)) < data.config.cooldown_time) return false
    if (ch.rpm_limit > 0 && (now503 - (ch.rpm_reset_at || 0)) < 60 && (ch.rpm_count || 0) >= ch.rpm_limit) return false
    if (ch.rpd_limit > 0 && (now503 - (ch.rpd_reset_at || 0)) < 86400 && (ch.rpd_count || 0) >= ch.rpd_limit) return false
    return true
  }).length

  if (availableCount === 0) {
    // All channels rate-limited: find earliest RPD reset to inform client
    let earliestResetSec = Infinity
    for (const ch of pool) {
      if (ch.rpd_limit > 0 && (ch.rpd_count || 0) >= ch.rpd_limit) {
        const resetAt = (ch.rpd_reset_at || 0) + 86400
        if (resetAt < earliestResetSec) earliestResetSec = resetAt
      }
    }
    const retryAfter = earliestResetSec === Infinity ? 300 : Math.max(60, earliestResetSec - now503)
    return new Response(
      JSON.stringify({ error: { message: 'All channels are rate-limited. Retry after ' + Math.ceil(retryAfter / 60) + ' min.', type: 'rate_limit_error', retry_after: retryAfter } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } }
    )
  }

  for (let i = 0; i < 3; i++) {
    const ch = selectChannel(pool, data.config.cooldown_time); if (!ch) break
    const baseUrl = ch.base_url.replace(/\/v[0-9]+$/, '').replace(/\/$/, '')
    const url = baseUrl + (ch.provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions')
    const reqBody = ch.provider === 'anthropic' ? mapToClaude(body) : body
    debug(c, `[Gateway] Calling ${ch.name}: ${url}`)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ch.api_key}`,
          'Content-Type': 'application/json',
          ...(ch.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
        },
        body: JSON.stringify(reqBody),
      })

      if (!res.ok) {
        const errText = await res.clone().text().then(t => t.slice(0, 200)).catch(() => 'Unknown error')
        const ts = Math.floor(Date.now() / 1000)
        if (res.status === 429)
          c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET last_429=?,last_error_msg=?,last_error_at=? WHERE id=?').bind(ts, 'Rate limited (429)', ts, ch.id).run())
        else if (res.status === 401 || res.status === 403)
          c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=5,last_error_msg=?,last_error_at=? WHERE id=?').bind('Auth failed (' + res.status + ')', ts, ch.id).run())
        else
          c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=consecutive_errors+1,last_error_msg=?,last_error_at=? WHERE id=?').bind(errText, ts, ch.id).run())
        pool = pool.filter(p => p.id !== ch.id); continue
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const cachedCh = data.channels.find(x => x.id === ch.id)
      updateRateCounters(cachedCh, nowSec)
      // Merge consecutive_errors reset + RPM/RPD into one DB write when possible
      if (ch.consecutive_errors > 0 && (ch.rpm_limit > 0 || ch.rpd_limit > 0)) {
        c.executionCtx.waitUntil(
          c.env.DB.prepare(
            `UPDATE channels SET consecutive_errors=0,last_error_at=0,
              rpm_count=CASE WHEN ?-rpm_reset_at>=60 THEN 1 ELSE rpm_count+1 END,
              rpm_reset_at=CASE WHEN ?-rpm_reset_at>=60 THEN ? ELSE rpm_reset_at END,
              rpd_count=CASE WHEN ?-rpd_reset_at>=86400 THEN 1 ELSE rpd_count+1 END,
              rpd_reset_at=CASE WHEN ?-rpd_reset_at>=86400 THEN ? ELSE rpd_reset_at END
            WHERE id=?`
          ).bind(nowSec, nowSec, nowSec, nowSec, nowSec, nowSec, ch.id).run()
        )
      } else if (ch.consecutive_errors > 0) {
        c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=0,last_error_at=0 WHERE id=?').bind(ch.id).run())
      } else if (ch.rpm_limit > 0 || ch.rpd_limit > 0) {
        c.executionCtx.waitUntil(
          c.env.DB.prepare(
            `UPDATE channels SET
              rpm_count=CASE WHEN ?-rpm_reset_at>=60 THEN 1 ELSE rpm_count+1 END,
              rpm_reset_at=CASE WHEN ?-rpm_reset_at>=60 THEN ? ELSE rpm_reset_at END,
              rpd_count=CASE WHEN ?-rpd_reset_at>=86400 THEN 1 ELSE rpd_count+1 END,
              rpd_reset_at=CASE WHEN ?-rpd_reset_at>=86400 THEN ? ELSE rpd_reset_at END
            WHERE id=?`
          ).bind(nowSec, nowSec, nowSec, nowSec, nowSec, nowSec, ch.id).run()
        )
      }

      if (body.stream) {
        return new Response(transformStream(res.body, data.filters, ch.provider), {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
        })
      }

      const resText = await res.text()
      let json = attemptRepairJson(resText); if (!json) continue
      if (ch.provider === 'anthropic') json = mapFromClaude(json)
      if (json.choices?.[0]?.message?.content) {
        const f = new RollingFilter(data.filters)
        json.choices[0].message.content = f.transform(json.choices[0].message.content) + f.flush()
      }
      return c.json(json)
    } catch (e) {
      const ts = Math.floor(Date.now() / 1000)
      c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=consecutive_errors+1,last_error_msg=?,last_error_at=? WHERE id=?').bind((e.message || 'Network error').slice(0, 200), ts, ch.id).run())
      pool = pool.filter(p => p.id !== ch.id)
    }
  }
  return c.json({ error: { message: 'All upstream channels failed', type: 'server_error' } }, 502)
})

export default app