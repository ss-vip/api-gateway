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
    m.content.some(c => c.type === 'image_url' || c.type === 'input_image'))
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

const mkChunk = (delta, finish_reason = null, model = undefined) => ({
  id: 'chatcmpl-' + Math.random().toString(36).slice(2),
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason }],
})

// OpenAI SSE stream passthrough with rolling filter applied to content
function transformStream(readable, filters, responseModel) {
  const { readable: r, writable: w } = new TransformStream()
  const writer = w.getWriter(), reader = readable.getReader()
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  const filter = new RollingFilter(filters)
  let buf = ''
    ; (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          buf += decoder.decode(value, { stream: true })
          let lines = buf.split('\n'); buf = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const dataStr = line.startsWith('data: ') ? line.slice(6).trim() : line.slice(5).trim()
            if (dataStr === '[DONE]') {
              const tail = filter.flush()
              if (tail) await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({ content: tail }, null, responseModel))}\n\n`))
              await writer.write(encoder.encode('data: [DONE]\n\n'))
              continue
            }
            try {
              const json = JSON.parse(dataStr)
              if (responseModel) json.model = responseModel
              const choice = json.choices?.[0]
              if (!choice) {
                await writer.write(encoder.encode(`data: ${JSON.stringify(json)}\n\n`))
                continue
              }
              const delta = choice.delta || {}

              if (typeof delta.content === 'string') {
                let outContent = filter.transform(delta.content)
                // Flush filter immediately if finish_reason is received so text isn't sent after stop
                if (choice.finish_reason) {
                  outContent += filter.flush()
                }

                if (outContent) {
                  choice.delta.content = outContent
                  await writer.write(encoder.encode(`data: ${JSON.stringify(json)}\n\n`))
                } else if (delta.role || choice.finish_reason || delta.tool_calls) {
                  choice.delta.content = ""
                  await writer.write(encoder.encode(`data: ${JSON.stringify(json)}\n\n`))
                }
              } else {
                if (choice.finish_reason) {
                  const tail = filter.flush()
                  if (tail) {
                    // Send tail as a separate chunk before the finish_reason chunk
                    await writer.write(encoder.encode(`data: ${JSON.stringify(mkChunk({ content: tail }, null, responseModel))}\n\n`))
                  }
                }
                await writer.write(encoder.encode(`data: ${JSON.stringify(json)}\n\n`))
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
// Handles different API versions (e.g. /v1, /v2) and custom paths.
function buildUpstreamUrl(baseUrl) {
  let base = (baseUrl || '').trim()
  if (!base) return null
  base = base.replace(/\/+$/, '') // strip trailing slashes

  if (base.endsWith('/chat/completions')) {
    return base
  }

  // If the base URL ends with a version like /v1, /v2, just append /chat/completions
  if (/\/v\d+$/.test(base)) {
    return `${base}/chat/completions`
  }

  // Default fallback for bare domains
  return `${base}/v1/chat/completions`
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

  // Parse user request body strictly — no repair to avoid corrupting message content
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

  // Dynamic Context Window Routing: estimate tokens (rough approx: char length / 3.5)
  const estTokens = Math.floor(JSON.stringify(body.messages || []).length / 3.5)
  const tokenMatchedPool = pool.filter(ch => !ch.max_tokens || ch.max_tokens === 0 || estTokens <= ch.max_tokens)
  if (tokenMatchedPool.length > 0) pool = tokenMatchedPool

  // Tool-based routing: prioritize channels that support tools if the request needs them
  if (isToolUse) {
    const toolSupportedPool = pool.filter(ch => ch.support_tools !== 0)
    if (toolSupportedPool.length > 0) pool = toolSupportedPool
  }

  if (pool.length === 0) return c.json({ error: { message: 'No enabled channels configured or supporting this request (Vision/Tools)', type: 'server_error' } }, 503)

  // Model-based routing: prefer channels whose configured model matches the user's request.
  // Falls back to the full enabled pool if no channel matches (fully backward-compatible).
  const originalModel = body.model
  const requestedModel = (originalModel || '').trim().toLowerCase()
  if (requestedModel) {
    const matched = pool.filter(ch => (ch.model || '').trim().toLowerCase() === requestedModel)
    if (matched.length > 0) pool = matched
    // else: no match → keep full pool as fallback
  }

  const now503 = Math.floor(Date.now() / 1000)
  const availableCount = pool.filter(ch => {
    if (ch.consecutive_errors >= 5 && (now503 - (ch.last_error_at || 0)) <= 604800) return false
    if ((now503 - (ch.last_429 || 0)) < data.config.cooldown_time) return false
    if (ch.rpm_limit > 0 && (now503 - (ch.rpm_reset_at || 0)) < 60 && (ch.rpm_count || 0) >= ch.rpm_limit) return false
    if (ch.rpd_limit > 0 && (now503 - (ch.rpd_reset_at || 0)) < 86400 && (ch.rpd_count || 0) >= ch.rpd_limit) return false
    return true
  }).length

  if (availableCount === 0) {
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

  const isStream = body.stream === true || body.stream === 'true' || body.stream === 1

  for (let i = 0, maxTries = Math.min(pool.length, 5); i < maxTries; i++) {
    const ch = selectChannel(pool, data.config.cooldown_time); if (!ch) break

    const url = buildUpstreamUrl(ch.base_url)
    if (!url) {
      pool = pool.filter(p => p.id !== ch.id); continue
    }

    const reqBody = { ...body }
    if (ch.model) reqBody.model = ch.model

    // --- Auto Sanitization for Upstream Compatibility ---
    // 1. Remove top-level null values (causes 400 on some strict proxies)
    for (const key of Object.keys(reqBody)) {
      if (reqBody[key] === null) delete reqBody[key]
    }

    // 2. Remove stream_options if not streaming (OpenAI spec says it's only valid for stream)
    if (!isStream) {
      delete reqBody.stream_options
    }

    if (Array.isArray(reqBody.messages)) {
      reqBody.messages = reqBody.messages.filter(m => {
        // 3. Drop empty assistant messages with no tool calls (Claude/Anthropic throws 400)
        if (m.role === 'assistant' && (!m.tool_calls || m.tool_calls.length === 0)) {
          if (m.content === '' || m.content === null || (Array.isArray(m.content) && m.content.length === 0)) {
            return false
          }
        }
        return true
      }).map(m => {
        let newM = { ...m }
    // 4. OpenAI's new 'developer' role often breaks older proxies; fallback to 'system'
        if (newM.role === 'developer') newM.role = 'system'
        // 5. Prevent empty user messages (some models throw 400 for empty user content)
        if (newM.role === 'user' && (newM.content === '' || newM.content === null)) {
          newM.content = ' '
        }
        return newM
      })
    }

    // 6. Strip tools if channel does not support them
    if (ch.support_tools === 0) {
      delete reqBody.tools
      delete reqBody.tool_choice
    }
    // ---------------------------------------------------

    debug(c, `[Gateway] Calling ${ch.name} (id=${ch.id}): ${url}\nuser requested: ${originalModel}, forwarding as: ${reqBody.model}`)

    // 28s timeout — keeps us well under Cloudflare's 30s subrequest limit
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 28000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ch.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error')
        const ts = Math.floor(Date.now() / 1000)
        let errMsgInfo = ''
        if (res.status === 429) {
          errMsgInfo = JSON.stringify({ message: 'Rate limited (429)', url, request: JSON.stringify(reqBody).slice(0, 4000), response: errText.slice(0, 4000) })
          c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET last_429=?,last_error_msg=?,last_error_at=? WHERE id=?').bind(ts, errMsgInfo, ts, ch.id).run())
        } else if (res.status === 401 || res.status === 403) {
          errMsgInfo = JSON.stringify({ message: `Auth failed (${res.status})`, url, request: JSON.stringify(reqBody).slice(0, 4000), response: errText.slice(0, 4000) })
          c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=5,last_error_msg=?,last_error_at=? WHERE id=?').bind(errMsgInfo, ts, ch.id).run())
        } else {
          // Intelligent logic: auto-detect and update max_tokens or support_tools from error messages
          if (res.status === 400 || res.status === 413) {
            // Check context length
            const tokMatch = errText.match(/max(?:imum)?\s*(?:context\s*length|tokens?)\s*(?:is|of|:)?\s*(\d+)/i)
            if (tokMatch && tokMatch[1]) {
              const maxTok = parseInt(tokMatch[1], 10)
              if (maxTok > 0) c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET max_tokens=? WHERE id=?').bind(maxTok, ch.id).run())
            }
            // Check tool support
            if (errText.toLowerCase().includes('tools') || errText.toLowerCase().includes('function')) {
              if (errText.toLowerCase().includes('not support') || errText.toLowerCase().includes('unsupported')) {
                c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET support_tools=0 WHERE id=?').bind(ch.id).run())
              }
            }
          }
          errMsgInfo = JSON.stringify({ message: `HTTP ${res.status}`, url, request: JSON.stringify(reqBody).slice(0, 4000), response: errText.slice(0, 4000) })
          c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=consecutive_errors+1,last_error_msg=?,last_error_at=? WHERE id=?').bind(errMsgInfo, ts, ch.id).run())
        }
        pool = pool.filter(p => p.id !== ch.id); continue
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const cachedCh = data.channels.find(x => x.id === ch.id)
      updateRateCounters(cachedCh, nowSec)
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

      if (isStream) {
        const responseModel = originalModel || ch.model || undefined
        return new Response(transformStream(res.body, data.filters, responseModel), {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
        })
      }

      const resText = await res.text()
      let json = attemptRepairJson(resText); if (!json) continue
      // Normalize model field to match user's requested model so IDE tools don't get confused
      if (json.model !== undefined && originalModel) json.model = originalModel
      // Apply content filters to non-streamed text responses
      if (json.choices?.[0]?.message?.content) {
        const f = new RollingFilter(data.filters)
        json.choices[0].message.content = f.transform(json.choices[0].message.content) + f.flush()
      }
      return c.json(json)
    } catch (e) {
      clearTimeout(timeoutId)
      const baseMsg = e.name === 'AbortError' ? 'Request timeout (28s)' : (e.message || 'Network error')
      const errMsgInfo = JSON.stringify({ message: baseMsg, url, request: JSON.stringify(reqBody).slice(0, 4000), response: '' })
      const ts = Math.floor(Date.now() / 1000)
      c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE channels SET consecutive_errors=consecutive_errors+1,last_error_msg=?,last_error_at=? WHERE id=?').bind(errMsgInfo, ts, ch.id).run())
      pool = pool.filter(p => p.id !== ch.id)
    }
  }
  return c.json({ error: { message: 'All upstream channels failed', type: 'server_error' } }, 502)
})

export default app