import { Hono } from "hono";

const RES_CACHE_TTL = 30_000;
let resCache = { data: null, ts: 0, gen: 0 };

function withCache(fn) {
  return async (c) => {
    if (resCache.data && Date.now() - resCache.ts < RES_CACHE_TTL) return c.json(resCache.data);
    const data = await fn(c);
    resCache = { data, ts: Date.now(), gen: resCache.gen };
    return c.json(data);
  };
}

function clearResCache() {
  resCache.gen++;
  resCache.data = null;
  resCache.ts = 0;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return bytesToHex(salt) + ":" + bytesToHex(new Uint8Array(bits));
}
async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (!storedHash.includes(":")) {
    if (storedHash.length !== 64) return false;
    const legacyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("vg7p@2mK9#qR" + password));
    return bytesToHex(new Uint8Array(legacyHash)) === storedHash;
  }
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return bytesToHex(new Uint8Array(bits)) === hashHex;
}
async function getAdminPass(c) {
  try {
    const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
    return cf?.admin_password || null;
  } catch { return null; }
}

export { getAdminPass, verifyPassword };

function generateFallbackToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = new Uint32Array(30);
  crypto.getRandomValues(rand);
  let t = "sk-";
  for (let i = 0; i < 30; i++) t += chars[rand[i] % chars.length];
  return t;
}
function getDefaults() {
  return { token: generateFallbackToken(), recovery_period: 300 };
}

const setupRateLimit = new Map();
const SETUP_MAX_ATTEMPTS = 5;
const SETUP_BAN_MS = 10 * 60 * 1000; // 10 minutes

function checkSetupRateLimit(ip) {
  const state = setupRateLimit.get(ip) || { count: 0, banUntil: 0 };
  if (Date.now() < state.banUntil) return { blocked: true, remaining: 0 };
  if (state.count >= SETUP_MAX_ATTEMPTS) {
    setupRateLimit.set(ip, { count: 0, banUntil: Date.now() + SETUP_BAN_MS });
    return { blocked: true, remaining: 0 };
  }
  setupRateLimit.set(ip, { count: state.count + 1, banUntil: 0 });
  return { blocked: false, remaining: SETUP_MAX_ATTEMPTS - state.count - 1 };
}

// Periodic cleanup: remove expired bans
export function pruneSetupRateLimit() {
  const now = Date.now();
  for (const [ip, state] of setupRateLimit) {
    if (state.banUntil > 0 && now >= state.banUntil) setupRateLimit.delete(ip);
  }
}

export default function (_clearCache) {
  const api = new Hono();

  function clearCache() {
    _clearCache();
    clearResCache();
  }

  const PUBLIC_SUFFIXES = ["/auth-status", "/verify-token"];
  api.use("*", async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_SUFFIXES.some((s) => path.endsWith(s))) return await next();
    const storedHash = await getAdminPass(c);
    if (!storedHash) {
      if (path.endsWith("/admin-pass")) return await next();
      return c.json({ error: "請先設定密碼" }, 403);
    }
    const inputToken = c.req.header("X-Admin-Token");
    if (!inputToken) return c.json({ error: "Unauthorized" }, 401);
    if (!(await verifyPassword(inputToken, storedHash)))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  api.get("/init", withCache(async (c) => {
    const [ch, fl] = await Promise.all([
      c.env.DB.prepare(
        "SELECT id, name, base_url, api_key, model, weight,\
                is_enabled, is_vision, last_429, consecutive_errors,\
                last_error_msg, last_error_at,\
                rpm_limit, rpd_limit, rpm_count, rpm_reset_at,\
                rpd_count, rpd_reset_at, max_tokens, support_tools,\
                support_stream, response_time, fallback_model, headers,\
                provider_options, provider, absolute_url,\
                cooldown_until,\
                support_image_gen, support_audio_tts, support_audio_stt, support_image_edit, support_embeddings\
         FROM channels ORDER BY id"
      ).all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    return {
      channels: ch.results || [],
      filters: fl.results || [],
      config: { token: cf?.client_token || "", recovery_period: parseInt(cf?.recovery_period) || 300 },
    };
  }));

  const channelsListHandler = withCache(async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, name, base_url, api_key, model, weight,\
              is_enabled, is_vision, last_429, consecutive_errors,\
              last_error_msg, last_error_at,\
              rpm_limit, rpd_limit, rpm_count, rpm_reset_at,\
              rpd_count, rpd_reset_at, max_tokens, support_tools,\
              support_stream, response_time, fallback_model, headers,\
              provider_options, provider, absolute_url,\
              cooldown_until,\
              support_image_gen, support_audio_tts, support_audio_stt, support_image_edit, support_embeddings\
       FROM channels ORDER BY id"
    ).all();
    return results || [];
  });

  api.get("/", channelsListHandler);
  api.get("/channels", channelsListHandler);

  api.post("/batch-channels", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body)) return c.json({ ok: false, error: "Expected array" }, 400);
    const channels = body;
    const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
    const allKeys = {};
    for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
    const batch = [c.env.DB.prepare("DELETE FROM channels")];
    for (const ch of channels) {
      const apiKey = ch.api_key || (allKeys[ch.id] || "");
      const h = ch.headers ? (typeof ch.headers === "object" ? JSON.stringify(ch.headers) : ch.headers) : null;
      const po = ch.provider_options ? (typeof ch.provider_options === "object" ? JSON.stringify(ch.provider_options) : ch.provider_options) : null;
      batch.push(
        c.env.DB.prepare(
          "INSERT INTO channels (id, name, base_url, api_key, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, support_stream, response_time, fallback_model, headers, provider_options, provider, absolute_url, support_image_gen, support_audio_tts, support_audio_stt, support_image_edit, support_embeddings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey,
          ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
          ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
          ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
          ch.support_tools ? 1 : 0, ch.support_stream === 0 ? 0 : 1, ch.response_time || 0, ch.fallback_model || "",
          h, po, ch.provider || "", ch.absolute_url ? 1 : 0,
          ch.support_image_gen ? 1 : 0, ch.support_audio_tts ? 1 : 0, ch.support_audio_stt ? 1 : 0, ch.support_image_edit ? 1 : 0, ch.support_embeddings ? 1 : 0
        )
      );
    }
    await c.env.DB.batch(batch);
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/channels/:id/reset-health", async (c) => {
    await c.env.DB.prepare("UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0 WHERE id=?").bind(c.req.param("id")).run();
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/channels/reset-all-health", async (c) => {
    await c.env.DB.prepare("UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0").run();
    clearCache();
    return c.json({ ok: true });
  });

  api.get("/filters", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all();
    return c.json(results || []);
  });

  api.post("/filters", async (c) => {
    const filters = await c.req.json();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM filters"),
      ...filters.map((f) =>
        c.env.DB.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0)
      ),
    ]);
    clearCache();
    return c.json({ ok: true });
  });

  api.get("/config", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
      return c.json({
        token: cf?.client_token || getDefaults().token,
        recovery_period: cf?.recovery_period || getDefaults().recovery_period,
      });
    } catch (e) {
      return c.json({ token: getDefaults().token, recovery_period: getDefaults().recovery_period });
    }
  });

  api.get("/auth-status", async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
      return c.json({ needsSetup: !cf?.admin_password });
    } catch (e) {
      return c.json({ needsSetup: true });
    }
  });

  api.post("/verify-token", async (c) => {
    const { token } = await c.req.json();
    if (!token) return c.json({ valid: false }, 400);
    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ valid: false }, 403);
    return c.json({ valid: await verifyPassword(token, storedHash) });
  });

  api.post("/config", async (c) => {
    const b = await c.req.json();
    const ex = await c.env.DB.prepare("SELECT client_token, recovery_period FROM config WHERE id=1").first();
    const existingToken = ex?.client_token || "";
    const existingPeriod = ex?.recovery_period ? parseInt(ex.recovery_period) : null;
    try {
      const token = b.token || existingToken || getDefaults().token;
      const period = parseInt(b.recovery_period) || existingPeriod || getDefaults().recovery_period;
      if (ex) {
        await c.env.DB.prepare("UPDATE config SET client_token=?, recovery_period=? WHERE id=1")
          .bind(token, period).run();
      } else {
        await c.env.DB.prepare("INSERT INTO config (id, client_token, recovery_period) VALUES (1, ?, ?)")
          .bind(token, period).run();
      }
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/proxy-models", async (c) => {
    const { url, key } = await c.req.json();
    if (!url) return c.json({ error: "Missing URL" }, 400);
    let target = url.trim().replace(/\/+$/, "");
    if (!target.endsWith("/models")) {
      if (target.endsWith("/chat/completions")) target = target.replace("/chat/completions", "/models");
      else if (/\/v[\w]+\//.test(target + "/")) target = `${target}/models`;
      else if (/\/v\d+$/.test(target)) target = `${target}/models`;
      else target += "/v1/models";
    }
    try {
      const res = await fetch(target, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) return c.json({ error: `Upstream error: ${res.status}` }, res.status);
      return c.json(await res.json());
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  api.post("/admin-pass", async (c) => {
    const ip = c.req.header("CF-Connecting-IP")
      || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
      || "unknown";
    const rl = checkSetupRateLimit(ip);
    if (rl.blocked) return c.json({ error: "嘗試過多，請 10 分鐘後再试" }, 429);

    const { pass } = await c.req.json();
    if (!pass || pass.length < 6 || pass.length > 20)
      return c.json({ error: "密碼需 6-20 個字元" }, 400);
    const hashedPass = await hashPassword(pass);
    const ex = await c.env.DB.prepare("SELECT id FROM config WHERE id=1").first();
    if (ex) {
      await c.env.DB.prepare("UPDATE config SET admin_password=? WHERE id=1").bind(hashedPass).run();
    } else {
      await c.env.DB.prepare("INSERT INTO config (id, admin_password) VALUES (1, ?)").bind(hashedPass).run();
    }
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/channels/:id/test", async (c) => {
    const chId = parseInt(c.req.param("id"), 10);
    const reqBody = await c.req.json().catch(() => ({}));
    const fromBody = !!reqBody.base_url;
    let ch;
    if (fromBody) {
      ch = { id: chId, ...reqBody };
    } else {
      const rows = (await c.env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(chId).all()).results || [];
      ch = rows[0];
    }
    if (!ch) return c.json({ ok: false, error: "Channel not found", diagnosis: "渠道不存在" }, 404);
    const { buildUrl, buildEndpointUrl } = await import("../lib/providers/openai.js");

    // Determine channel type → test relevant endpoints
    const modelLC = (ch.model || '').toLowerCase();
    const isLikelyChat = !(
      modelLC.includes('tts') || modelLC.includes('whisper') ||
      (modelLC.includes('dall-e') && !modelLC.includes('gpt'))
    );
    const testsToRun = [];
    if (isLikelyChat) testsToRun.push('chat');
    if (ch.support_image_gen || modelLC.includes('dall-e') || modelLC.includes('image')) testsToRun.push('image_gen');
    if (ch.support_audio_tts || modelLC.includes('tts') || modelLC.includes('speech') || modelLC.includes('audio')) testsToRun.push('audio_tts');
    if (ch.support_audio_stt || modelLC.includes('whisper') || modelLC.includes('transcript')) testsToRun.push('audio_stt');
    if (testsToRun.length === 0) testsToRun.push('chat');

    // Shared fetch helper
    async function testFetch(endpointType, fetchOpts, checkFn, timeoutMs = 15000) {
      const url = endpointType === 'chat'
        ? (ch.absolute_url ? buildEndpointUrl(ch.base_url, 'chat') : buildUrl(ch.base_url, ch.model || 'test', false))
        : buildEndpointUrl(ch.base_url, endpointType);
      if (!url) return { ok: false, ms: 0, detail: 'Invalid URL' };
      const start = Date.now();
      try {
        const headers = { Authorization: 'Bearer ' + ch.api_key, ...fetchOpts.headers };
        const res = await fetch(url, { ...fetchOpts, headers, signal: AbortSignal.timeout(timeoutMs) });
        const ms = Date.now() - start;
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const detail = res.status === 400 ? '不支援（HTTP 400）'
            : (res.status === 401 || res.status === 403) ? 'API Key 無效（' + res.status + '）'
            : 'HTTP ' + res.status + (text ? ': ' + text.slice(0, 80) : '');
          return { ok: false, ms, detail };
        }
        return await checkFn(res, ms);
      } catch (e) {
        const ms = Date.now() - start;
        if (e.name === 'TimeoutError') return { ok: false, ms, detail: '超時' };
        return { ok: false, ms, detail: e.message?.slice(0, 80) || 'error' };
      }
    }

    const capabilities = {};

    // Chat: basic → vision / tools / stream
    if (testsToRun.includes('chat')) {
      const chatUrl = ch.absolute_url ? buildEndpointUrl(ch.base_url, 'chat') : buildUrl(ch.base_url, ch.model || 'test', false);
      if (chatUrl) {
        const basic = await testFetch('chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: ch.model || 'test', messages: [{ role: 'user', content: 'OK' }], stream: false }),
        }, async (res, ms) => {
          const text = await res.text();
          try {
            const j = JSON.parse(text);
            const c = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.delta?.content;
            if (c && c.trim().length > 0) return { ok: true, ms, detail: c.slice(0, 100) };
            if (j?.choices?.[0]?.message?.tool_calls) return { ok: true, ms, detail: 'tool_calls received' };
            return { ok: false, ms, detail: 'empty response' };
          } catch (e) {
            return text.length > 0 ? { ok: true, ms, detail: 'non-JSON response' } : { ok: false, ms, detail: 'empty body' };
          }
        }, 15000);

        if (basic.ok) {
          capabilities.basic = basic;

          const [visionRes, toolsRes] = await Promise.all([
            testFetch('chat', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: ch.model || 'test',
                messages: [{ role: 'user', content: [
                  { type: 'text', text: 'desc' },
                  { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } },
                ] }],
                stream: false,
              }),
            }, async (res, ms) => {
              const j = await res.json();
              const c = j?.choices?.[0]?.message?.content;
              return c && c.trim().length > 0
                ? { ok: true, ms, detail: c.slice(0, 100) }
                : { ok: false, ms, detail: 'vision not supported' };
            }, 10000).catch(() => ({ ok: false, ms: 0, detail: 'test error' })),

            // Tools: try tool_choice:"required" first, fallback to "auto" on 400
            (async () => {
              const toolBody = {
                model: ch.model || 'test',
                messages: [{ role: 'user', content: 'test' }],
                tools: [{ type: 'function', function: { name: 'test_func', description: 'test', parameters: { type: 'object', properties: {} } } }],
                tool_choice: 'required',
                stream: false,
              };
              const r1 = await testFetch('chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toolBody),
              }, async (res, ms) => {
                const j = await res.json();
                const tc = j?.choices?.[0]?.message?.tool_calls;
                const fr = j?.choices?.[0]?.finish_reason;
                if ((tc && tc.length > 0) || fr === 'tool_calls') return { ok: true, ms, detail: 'tool_calls received' };
                return { ok: false, ms, detail: 'tools not supported (text-only)' };
              }, 10000);
              // 400 → retry with "auto"
              if (!r1.ok && r1.detail.includes('400')) {
                toolBody.tool_choice = 'auto';
                delete toolBody.tool_choice;
                return await testFetch('chat', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(toolBody),
                }, async (res, ms) => {
                  const j = await res.json();
                  const tc = j?.choices?.[0]?.message?.tool_calls;
                  const fr = j?.choices?.[0]?.finish_reason;
                  if ((tc && tc.length > 0) || fr === 'tool_calls') return { ok: true, ms, detail: 'tool_calls received (auto)' };
                  return { ok: true, ms, detail: 'chat ok (tools not forced)' };
                }, 10000);
              }
              return r1;
            })(),
          ]);

          capabilities.vision = visionRes;
          capabilities.tools = toolsRes;

          // Stream
          const streamRes = await testFetch('chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: ch.model || 'test', messages: [{ role: 'user', content: 'OK' }], stream: true }),
          }, async (res, ms) => {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              // Check for "[DONE]" marker OR valid SSE data line
              if (buf.includes('[DONE]') || buf.includes('data: {')) break;
            }
            await reader.cancel();
            const hasData = buf.includes('[DONE]') || buf.includes('data: {');
            return hasData
              ? { ok: true, ms, detail: 'stream supported' }
              : { ok: false, ms, detail: 'empty stream' };
          }, 15000).catch(() => ({ ok: false, ms: 0, detail: 'test error' }));
          capabilities.stream = streamRes;
        } else {
          capabilities.basic = basic;
        }
      }
    }

    if (testsToRun.includes('image_gen')) {
      const imgRes = await testFetch('image_gen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ch.model || 'dall-e-3', prompt: 'a cat', n: 1, size: '1024x1024' }),
      }, async (res, ms) => {
        const j = await res.json();
        const url = j?.data?.[0]?.url || j?.data?.[0]?.b64_json;
        return url ? { ok: true, ms, detail: 'image generated' } : { ok: false, ms, detail: 'no image in response' };
      }, 20000).catch(() => ({ ok: false, ms: 0, detail: 'test error' }));
      capabilities.image_gen = imgRes;
    }

    if (testsToRun.includes('audio_tts')) {
      const ttsRes = await testFetch('audio_tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ch.model || 'tts-1', input: 'hello', voice: 'alloy' }),
      }, async (res, ms) => {
        const ct = res.headers.get('content-type') || '';
        const body = await res.arrayBuffer();
        if (ct.startsWith('audio/') && body.byteLength > 100) return { ok: true, ms, detail: 'audio generated (' + ct + ')' };
        return { ok: false, ms, detail: 'not audio content: ' + ct };
      }, 20000).catch(() => ({ ok: false, ms: 0, detail: 'test error' }));
      capabilities.audio_tts = ttsRes;
    }

    if (testsToRun.includes('audio_stt')) {
      // STT needs multipart — minimally test endpoint reachability
      const sttUrl = buildEndpointUrl(ch.base_url, 'audio_stt');
      if (sttUrl) {
        const start = Date.now();
        try {
          const headers = { Authorization: 'Bearer ' + ch.api_key };
          const res = await fetch(sttUrl, { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
          const ms = Date.now() - start;
          // 400 expected (no file), 404/501 = not supported
          capabilities.audio_stt = res.status === 400 || res.status === 200
            ? { ok: true, ms, detail: 'endpoint reachable (HTTP ' + res.status + ')' }
            : { ok: false, ms, detail: 'HTTP ' + res.status };
        } catch (e) {
          capabilities.audio_stt = { ok: false, ms: Date.now() - start, detail: e.message?.slice(0, 60) || 'error' };
        }
      } else {
        capabilities.audio_stt = { ok: false, ms: 0, detail: 'Invalid URL' };
      }
    }

    const chatOk = capabilities.basic?.ok;
    const primaryTest = testsToRun.includes('chat') ? 'chat' : testsToRun[0];
    const primaryOk = capabilities[primaryTest]?.ok || capabilities.basic?.ok;

    if (!primaryOk) {
      const result = capabilities.basic || capabilities.image_gen || capabilities.audio_tts || capabilities.audio_stt || { ms: 0, detail: 'unknown error' };
      let diagnosis = '連線失敗';
      let httpStatus = 0;
      if (result.detail.includes('無效')) { diagnosis = 'API Key 無效或已失效'; httpStatus = 401; }
      else if (result.detail.includes('400')) { diagnosis = '請求被拒絕，模型可能不支援'; httpStatus = 400; }
      else if (result.detail.includes('超時')) { diagnosis = '連線超時，渠道可能無回應'; httpStatus = 0; }
      else if (result.detail.includes('empty') || result.detail.includes('no image')) { diagnosis = '回應內容為空'; httpStatus = 200; }
      if (!fromBody) {
        const now = Math.floor(Date.now() / 1000);
        await c.env.DB.prepare(
          'UPDATE channels SET consecutive_errors=?, last_error_msg=?, last_error_at=?, response_time=? WHERE id=?'
        ).bind((ch.consecutive_errors || 0) + 1, diagnosis, now, 0, chId).run();
        clearCache();
      }
      return c.json({ ok: false, status: httpStatus, ms: result.ms, diagnosis,
        health_updated: !fromBody, message: fromBody ? '' : '渠道已標記為異常' });
    }

    // Primary test passed — reset health
    if (!fromBody) {
      const now = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare(
        'UPDATE channels SET consecutive_errors=0, last_error_msg="", last_error_at=0, response_time=? WHERE id=?'
      ).bind(capabilities.basic?.ms || 0, chId).run();
    }

    if (!fromBody) {
      const now = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare(
        `UPDATE channels SET
          support_stream=?, is_vision=?, support_tools=?,
          support_image_gen=?, support_audio_tts=?, support_audio_stt=?
         WHERE id=?`
      ).bind(
        capabilities.stream?.ok ? 1 : 0,
        capabilities.vision?.ok ? 1 : 0,
        capabilities.tools?.ok ? 1 : 0,
        capabilities.image_gen?.ok ? 1 : 0,
        capabilities.audio_tts?.ok ? 1 : 0,
        capabilities.audio_stt?.ok ? 1 : 0,
        chId
      ).run();
      clearCache();
    }

    return c.json({
      ok: true,
      status: 200,
      ms: capabilities.basic?.ms || 0,
      diagnosis: "連線正常",
      health_updated: !fromBody,
      message: fromBody ? "" : "渠道健康狀態已重置",
      capabilities,
    });
  });

  api.get("/export", async (c) => {
    const [channels, filters] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const config = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    return c.json({
      channels: channels.results || [],
      filters: filters.results || [],
      config: config ? { token: config.client_token, recovery_period: config.recovery_period } : {},
    });
  });

  api.post("/import-all", async (c) => {
    const d = await c.req.json();
    const batch = [];
    if (d.channels) {
      const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
      batch.push(c.env.DB.prepare("DELETE FROM channels"));
      const allKeys = {};
      for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
      for (const ch of d.channels) {
        const apiKey = ch.api_key || (allKeys[ch.id] || "");
        const h = ch.headers ? (typeof ch.headers === "object" ? JSON.stringify(ch.headers) : ch.headers) : null;
        const po = ch.provider_options ? (typeof ch.provider_options === "object" ? JSON.stringify(ch.provider_options) : ch.provider_options) : null;
        batch.push(
          c.env.DB.prepare(
            "INSERT INTO channels (id, name, base_url, api_key, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, support_stream, response_time, fallback_model, headers, provider_options, provider, absolute_url, support_image_gen, support_audio_tts, support_audio_stt, support_image_edit, support_embeddings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey,
            ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
            ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
            ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
            ch.support_tools ? 1 : 0, ch.support_stream === 0 ? 0 : 1, ch.response_time || 0, ch.fallback_model || "",
            h, po, ch.provider || "", ch.absolute_url ? 1 : 0,
            ch.support_image_gen ? 1 : 0, ch.support_audio_tts ? 1 : 0, ch.support_audio_stt ? 1 : 0, ch.support_image_edit ? 1 : 0, ch.support_embeddings ? 1 : 0
          )
        );
      }
    }
    if (d.filters) {
      batch.push(c.env.DB.prepare("DELETE FROM filters"));
      for (const f of d.filters) {
        batch.push(c.env.DB.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0));
      }
    }
    if (d.config) {
      const currentPass = await getAdminPass(c);
      batch.push(
        c.env.DB.prepare("INSERT OR REPLACE INTO config (id, client_token, admin_password, recovery_period) VALUES (1, ?, ?, ?)")
          .bind(d.config.token || getDefaults().token, currentPass || "", parseInt(d.config.recovery_period) || getDefaults().recovery_period)
      );
    }
    if (batch.length > 0) await c.env.DB.batch(batch);
    clearCache();
    return c.json({ ok: true });
  });

  api.post("/reset", async (c) => {
    const freshToken = generateFallbackToken();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare("UPDATE config SET client_token=?, recovery_period=? WHERE id=1").bind(freshToken, getDefaults().recovery_period),
    ]);
    clearCache();
    return c.json({ ok: true, new_token: freshToken });
  });

  return api;
}