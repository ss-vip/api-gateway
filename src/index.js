import { Hono } from 'hono'
import { cors } from 'hono/cors'
import dashboard from './dashboard'

const app = new Hono()
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: false,
}))

let cache = { data: null, ts: 0 }
let cacheFlight = null
const clearCache = () => { cache.data = null; cache.ts = 0; cacheFlight = null }

app.route('/', dashboard(clearCache))

const debug = (c, msg) => { if (c.req.url.includes('localhost') || c.req.url.includes('127.0.0.1')) console.log(msg) }

function hasImage(messages = []) {
  return messages.some(m => Array.isArray(m.content) &&
    m.content.some(c => c.type === 'image_url' || c.type === 'input_image' || c.type === 'image'))
}

// --- Protocol Translators ---

function o2aRequest(body) {
  const messages = []
  let system = ""
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      system += (system ? "\n" : "") + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    } else {
      let content = m.content
      if (Array.isArray(content)) {
        content = content.map(c => {
          if (c.type === 'image_url' && c.image_url?.url?.startsWith('data:')) {
            const m = c.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
            if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
          }
          return c
        })
      }
      messages.push({ role: m.role, content })
    }
  }
  return {
    model: body.model,
    messages,
    system: system || undefined,
    max_tokens: body.max_tokens || 4096,
    stop_sequences: Array.isArray(body.stop) ? body.stop : (body.stop ? [body.stop] : undefined),
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    tools: body.tools ? body.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    })) : undefined
  }
}

function a2oRequest(body) {
  const messages = []
  if (body.system) messages.push({ role: 'system', content: body.system })
  for (const m of body.messages || []) {
    let content = m.content
    if (Array.isArray(content)) {
      content = content.map(c => {
        if (c.type === 'text') return { type: 'text', text: c.text }
        if (c.type === 'image') return { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } }
        return c
      })
    }
    messages.push({ role: m.role, content })
  }
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stop: body.stop_sequences,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    tools: body.tools ? body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    })) : undefined
  }
}

function o2aResponse(json, model) {
  const content = []
  const choice = json.choices?.[0] || {}
  if (choice.message?.content) content.push({ type: 'text', text: choice.message.content })
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: attemptRepairJson(tc.function.arguments) || {} })
    }
  }
  return {
    id: json.id,
    type: 'message',
    role: 'assistant',
    model: model || json.model,
    content,
    stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : (choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason),
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0
    }
  }
}

function a2oResponse(json, model) {
  let content = ""
  const tool_calls = []
  for (const c of json.content || []) {
    if (c.type === 'text') content += c.text
    if (c.type === 'tool_use') tool_calls.push({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })
  }
  return {
    id: json.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || json.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: content || null, tool_calls: tool_calls.length ? tool_calls : undefined },
      finish_reason: json.stop_reason === 'end_turn' ? 'stop' : (json.stop_reason === 'tool_use' ? 'tool_calls' : json.stop_reason)
    }],
    usage: {
      prompt_tokens: json.usage?.input_tokens || 0,
      completion_tokens: json.usage?.output_tokens || 0,
      total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0)
    }
  }
}

function attemptRepairJson(str) {
  if (!str || str.length > 2_000_000) return null
  try { return JSON.parse(str) } catch (e) { }
  let s = str.trim()
  if (s.startsWith('```json')) s = s.replace(/^```json\n?/, '').replace(/\n?```$/, '')
  try { return JSON.parse(s) } catch (e) { }
  try {
    let inString = false, output = ''
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === '"' && (i === 0 || s[i - 1] !== '\\')) inString = !inString
      if (inString && (ch === '\n' || ch === '\r')) { output += ch === '\n' ? '\\n' : '\\r' } else { output += ch }
    }
    return JSON.parse(output)
  } catch (e) { }
  return null
}

class RollingFilter {
  // Only apply filters whose keyword is 1–30 chars; longer keywords cause streaming latency.
  // safeLen is computed once in the constructor to avoid per-chunk recalculation.
  constructor(filters) {
    this.filters = filters.filter(f => f.is_enabled && f.text && f.text.length > 0 && f.text.length <= 30)
    this.safeLen = this.filters.reduce((m, f) => Math.max(m, f.text.length - 1), 0)
    this.buffer = ''
    this.truncated = false
  }
  transform(chunk) {
    if (this.filters.length === 0) return chunk
    if (this.truncated) return ''
    this.buffer += chunk
    for (const f of this.filters) {
      if (f.mode === 1) {
        const idx = this.buffer.indexOf(f.text)
        if (idx !== -1) { this.buffer = this.buffer.substring(0, idx); this.truncated = true; break }
      } else {
        this.buffer = this.buffer.split(f.text).join('')
      }
    }
    if (this.truncated) { const out = this.buffer; this.buffer = ''; return out }
    const flushLen = Math.max(0, this.buffer.length - this.safeLen)
    const out = this.buffer.slice(0, flushLen)
    this.buffer = this.buffer.slice(flushLen)
    return out
  }
  flush() { if (this.truncated) return ''; const out = this.buffer; this.buffer = ''; return out }
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

function updateRateCounters(cachedCh, nowSec) {
  if (!cachedCh) return
  if (nowSec - (cachedCh.rpm_reset_at || 0) >= 60) { cachedCh.rpm_count = 1; cachedCh.rpm_reset_at = nowSec }
  else cachedCh.rpm_count = (cachedCh.rpm_count || 0) + 1
  if (nowSec - (cachedCh.rpd_reset_at || 0) >= 86400) { cachedCh.rpd_count = 1; cachedCh.rpd_reset_at = nowSec }
  else cachedCh.rpd_count = (cachedCh.rpd_count || 0) + 1
}

const mkChunk = (delta, finish_reason = null, model = undefined, protocol = 'openai') => {
  if (protocol === 'anthropic') {
    // Anthropic doesn't have a single "chunk" format like OpenAI, but we use this for the filter's tail
    return JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content || '' } })
  }
  return JSON.stringify({
    id: 'chatcmpl-' + Math.random().toString(36).slice(2),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason }],
  })
}

// Unified stream transformer that handles OpenAI/Anthropic in/out
function transformStream(readable, filters, responseModel, fromProtocol, toProtocol) {
  const { readable: r, writable: w } = new TransformStream()
  const writer = w.getWriter(), reader = readable.getReader()
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  const filter = new RollingFilter(filters)
  let buf = '', messageId = 'msg_' + Math.random().toString(36).slice(2)

  const send = async (data) => {
    if (typeof data === 'object') data = JSON.stringify(data)
    await writer.write(encoder.encode(`data: ${data}\n\n`))
  }

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        let lines = buf.split('\n'); buf = lines.pop()
        for (const line of lines) {
          let trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const dataStr = trimmed.startsWith('data: ') ? trimmed.slice(6).trim() : trimmed.slice(5).trim()
          if (dataStr === '[DONE]') {
            const tail = filter.flush()
            if (tail) {
              if (toProtocol === 'anthropic') await send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tail } })
              else await send(mkChunk({ content: tail }, null, responseModel))
            }
            if (toProtocol === 'openai') await send('[DONE]')
            continue
          }

          try {
            const json = JSON.parse(dataStr)
            let content = '', finishReason = null, toolCalls = null

            // 1. Normalize input to internal fields
            if (fromProtocol === 'openai') {
              const choice = json.choices?.[0]
              content = choice?.delta?.content || ''
              finishReason = choice?.finish_reason
              toolCalls = choice?.delta?.tool_calls
            } else {
              if (json.type === 'content_block_delta') content = json.delta?.text || ''
              if (json.type === 'message_delta') finishReason = json.delta?.stop_reason
              // tool use in anthropic streams is more complex, skipping for now
            }

            // 2. Apply Filters
            let outContent = content ? filter.transform(content) : ''
            if (finishReason) outContent += filter.flush()

            // 3. Map to Output Protocol
            if (toProtocol === 'anthropic') {
              if (fromProtocol === 'anthropic' && !filters.length) {
                await send(json) // Passthrough
              } else {
                if (json.type === 'message_start' || (!json.type && fromProtocol === 'openai' && !content && !finishReason)) {
                  await send({ type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: responseModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } } })
                  await send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
                }
                if (outContent) await send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: outContent } })
                if (finishReason) {
                  await send({ type: 'content_block_stop', index: 0 })
                  await send({ type: 'message_delta', delta: { stop_reason: finishReason === 'stop' ? 'end_turn' : finishReason, stop_sequence: null }, usage: { output_tokens: 0 } })
                  await send({ type: 'message_stop' })
                }
              }
            } else {
              // to OpenAI
              if (fromProtocol === 'openai' && !filters.length) {
                if (responseModel) json.model = responseModel
                await send(json)
              } else {
                const delta = {}
                if (outContent) delta.content = outContent
                if (toolCalls) delta.tool_calls = toolCalls
                if (delta.content || delta.tool_calls || finishReason) {
                  await send(mkChunk(delta, finishReason === 'end_turn' ? 'stop' : finishReason, responseModel))
                }
              }
            }
          } catch (e) { }
        }
      }
    } finally { try { writer.close() } catch (e) { } }
  })()
  return r
}

async function loadCache(env) {
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

// /v1/models: dynamically return deduplicated models from all enabled channels.
// This lets IDE tools see the actual models available and do model-based selection.
// Falls back to 'openai' if no channels have a model configured.
app.get('/v1/models', async c => {
  let channels = []
  try { const d = await loadCache(c.env); channels = d?.channels || [] } catch (e) { channels = cache.data?.channels || [] }
  const seen = new Set()
  const models = []
  for (const ch of channels) {
    const id = (ch.model || '').trim()
    if (id && !seen.has(id)) { seen.add(id); models.push(id) }
  }
  if (models.length === 0) models.push('openai')
  return c.json({
    object: 'list',
    data: models.map(id => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'gateway' })),
  })
})

function validateChatBody(body) {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object'
  if (!Array.isArray(body.messages)) return "Field 'messages' must be an array"
  if (body.messages.length === 0) return "Field 'messages' cannot be empty"
  for (const m of body.messages) { if (!m.role) return "Each message must have a 'role'" }
  return null
}

// Build a clean upstream URL from a stored base_url.
function buildUpstreamUrl(baseUrl, provider) {
  let base = (baseUrl || '').trim()
  if (!base) return null
  base = base.replace(/\/+$/, '')

  if (provider === 'anthropic') {
    if (base.endsWith('/messages')) return base
    if (base.endsWith('/v1')) return `${base}/messages`
    return `${base}/v1/messages`
  }

  if (base.endsWith('/chat/completions')) return base
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

async function handleChatRequest(c, clientProtocol) {
  let data
  try { data = await loadCache(c.env) } catch (e) {
    if (!cache.data) return c.json({ error: { message: 'Database not initialized', type: 'server_error' } }, 500)
    data = cache.data
  }

  const token = (c.req.header('Authorization') || c.req.header('x-api-key') || '').replace('Bearer ', '')
  if (data.config.client_token && token !== data.config.client_token)
    return c.json({ error: { message: 'Unauthorized', type: 'authentication_error' } }, 401)

  let body
  try { body = JSON.parse(await c.req.text()) } catch (e) {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }
  const validErr = validateChatBody(body)
  if (validErr) return c.json({ error: { message: validErr, type: 'invalid_request_error' } }, 400)

  const isVision = hasImage(body.messages)
  const isToolUse = !!(body.tools && body.tools.length > 0)
  let pool = data.channels.filter(ch => {
    if (ch.is_enabled !== 1) return false
    if (isVision && ch.is_vision !== 1) return false
    return true
  })

  const estTokens = Math.floor(JSON.stringify(body.messages || []).length / 3.5)
  const tokenMatchedPool = pool.filter(ch => !ch.max_tokens || ch.max_tokens === 0 || estTokens <= ch.max_tokens)
  if (tokenMatchedPool.length > 0) pool = tokenMatchedPool

  if (isToolUse) {
    const toolSupportedPool = pool.filter(ch => ch.support_tools !== 0)
    if (toolSupportedPool.length > 0) pool = toolSupportedPool
  }

  const originalModel = body.model
  const requestedModel = (originalModel || '').trim().toLowerCase()
  if (requestedModel) {
    const matched = pool.filter(ch => (ch.model || '').trim().toLowerCase() === requestedModel)
    if (matched.length > 0) pool = matched
  }

  if (pool.length === 0) return c.json({ error: { message: 'No enabled channels supporting this request', type: 'server_error' } }, 503)

  const now = Math.floor(Date.now() / 1000)
  const availableCount = pool.filter(ch => {
    if (ch.consecutive_errors >= 5 && (now - (ch.last_error_at || 0)) <= 604800) return false
    if ((now - (ch.last_429 || 0)) < data.config.cooldown_time) return false
    if (ch.rpm_limit > 0 && (now - (ch.rpm_reset_at || 0)) < 60 && (ch.rpm_count || 0) >= ch.rpm_limit) return false
    if (ch.rpd_limit > 0 && (now - (ch.rpd_reset_at || 0)) < 86400 && (ch.rpd_count || 0) >= ch.rpd_limit) return false
    return true
  }).length

  if (availableCount === 0) return c.json({ error: { message: 'All channels are rate-limited', type: 'rate_limit_error' } }, 429)

  const isStream = body.stream === true || body.stream === 'true' || body.stream === 1

  for (let i = 0, maxTries = Math.min(pool.length, 5); i < maxTries; i++) {
    const ch = selectChannel(pool, data.config.cooldown_time); if (!ch) break
    const targetProtocol = ch.provider || 'openai'
    const url = buildUpstreamUrl(ch.base_url, targetProtocol)
    if (!url) { pool = pool.filter(p => p.id !== ch.id); continue }

    // --- Translation Logic ---
    let reqBody = { ...body }
    if (ch.model) reqBody.model = ch.model
    if (clientProtocol === 'openai' && targetProtocol === 'anthropic') reqBody = o2aRequest(reqBody)
    else if (clientProtocol === 'anthropic' && targetProtocol === 'openai') reqBody = a2oRequest(reqBody)

    // Common sanitization
    if (targetProtocol === 'openai' && Array.isArray(reqBody.messages)) {
      reqBody.messages = reqBody.messages.map(m => {
        let newM = { ...m }
        if (newM.role === 'developer') newM.role = 'system'
        if (newM.role === 'user' && !newM.content) newM.content = ' '
        return newM
      })
    }

    debug(c, `[Gateway] ${clientProtocol}->${targetProtocol} | ${ch.name}: ${url}`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 28000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': targetProtocol === 'openai' ? `Bearer ${ch.api_key}` : undefined,
          'x-api-key': targetProtocol === 'anthropic' ? ch.api_key : undefined,
          'anthropic-version': targetProtocol === 'anthropic' ? '2023-06-01' : undefined,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) {
        // ... (Error handling remains similar, update error count)
        const errText = await res.text()
        const ts = Math.floor(Date.now() / 1000)
        c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=consecutive_errors+1,last_error_msg=?,last_error_at=? WHERE id=?').bind(errText.slice(0, 1000), ts, ch.id).run())
        pool = pool.filter(p => p.id !== ch.id); continue
      }

      updateRateCounters(data.channels.find(x => x.id === ch.id), Math.floor(Date.now() / 1000))
      c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=0,last_error_at=0 WHERE id=?').bind(ch.id).run())

      if (isStream) {
        const responseModel = originalModel || ch.model || undefined
        return new Response(transformStream(res.body, data.filters, responseModel, targetProtocol, clientProtocol), {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
        })
      }

      const resText = await res.text()
      let json = attemptRepairJson(resText); if (!json) continue

      // --- Response Translation ---
      let finalResponse = json
      if (targetProtocol === 'openai' && clientProtocol === 'anthropic') finalResponse = o2aResponse(json, originalModel)
      else if (targetProtocol === 'anthropic' && clientProtocol === 'openai') finalResponse = a2oResponse(json, originalModel)
      else if (originalModel) finalResponse.model = originalModel

      return c.json(finalResponse)
    } catch (e) {
      clearTimeout(timeoutId)
      pool = pool.filter(p => p.id !== ch.id)
    }
  }
  return c.json({ error: { message: 'All upstream channels failed', type: 'server_error' } }, 502)
}

app.post('/v1/chat/completions', async c => handleChatRequest(c, 'openai'))
app.post('/v1/messages', async c => handleChatRequest(c, 'anthropic'))

export default app