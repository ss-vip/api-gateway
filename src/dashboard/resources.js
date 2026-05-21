import { Hono } from "hono";

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const PEPPER = "vg7p@2mK9#qR";

async function hashPassword(password) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PEPPER + password));
  return bytesToHex(new Uint8Array(hash));
}
async function verifyPassword(password, storedHash) {
  if (!storedHash || storedHash.length !== 64) return false;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PEPPER + password));
  return bytesToHex(new Uint8Array(hash)) === storedHash;
}
async function getAdminPass(c) {
  try {
    const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
    return cf?.admin_password || null;
  } catch { return null; }
}

export { getAdminPass, verifyPassword };

function generateFallbackToken() {
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "sk-";
  for (let i = 0; i < 30; i++) t += chars[bytes[i] % chars.length];
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

export default function (clearCache) {
  const api = new Hono();

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

  api.get("/init", async (c) => {
    const [ch, fl] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all(),
      c.env.DB.prepare("SELECT id, text, mode, is_enabled FROM filters ORDER BY id").all(),
    ]);
    const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first();
    return c.json({
      channels: ch.results || [],
      filters: fl.results || [],
      config: { token: cf?.client_token || "", recovery_period: parseInt(cf?.recovery_period) || 300 },
    });
  });

  const channelsListHandler = async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all();
    return c.json(results || []);
  };

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
          "INSERT INTO channels (id, name, base_url, api_key, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, support_stream, response_time, fallback_model, headers, provider_options, provider, absolute_url, support_image_gen, support_audio_tts, support_audio_stt, support_image_edit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey,
          ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
          ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
          ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
          ch.support_tools ? 1 : 0, ch.support_stream === 0 ? 0 : 1, ch.response_time || 0, ch.fallback_model || "",
          h, po, ch.provider || "", ch.absolute_url ? 1 : 0,
          ch.support_image_gen ? 1 : 0, ch.support_audio_tts ? 1 : 0, ch.support_audio_stt ? 1 : 0, ch.support_image_edit ? 1 : 0
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
    const body = await c.req.json().catch(() => ({}));
    const fromBody = !!body.base_url;
    let ch;
    if (fromBody) {
      ch = { id: chId, ...body };
    } else {
      const rows = (await c.env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(chId).all()).results || [];
      ch = rows[0];
    }
    if (!ch) return c.json({ ok: false, error: "Channel not found", diagnosis: "渠道不存在" }, 404);
    const { buildUrl, buildEndpointUrl } = await import("../lib/providers/openai.js");
    const url = ch.absolute_url ? buildEndpointUrl(ch.base_url, "chat") : buildUrl(ch.base_url, ch.model || "test", false);
    if (!url) return c.json({ ok: false, error: "Invalid URL", diagnosis: "渠道 URL 格式錯誤" }, 400);

    // Helper: test streaming support
    async function testStreamRequest(timeoutMs = 15000) {
      const start = Date.now();
      try {
        const reqBody = { model: ch.model || "test", messages: [{ role: "user", content: "OK" }], stream: true };
        const headers = { "Content-Type": "application/json", Authorization: "Bearer " + ch.api_key };
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(timeoutMs) });
        const ms = Date.now() - start;
        if (!res.ok) return { ok: false, ms, detail: "HTTP " + res.status };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let hasContent = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes('"content":"') || chunk.includes('"content": "') || chunk.includes('"tool_calls"')) {
            hasContent = true; break;
          }
        }
        await reader.cancel();
        if (hasContent) return { ok: true, ms, detail: "stream supported" };
        return { ok: false, ms, detail: "empty stream (no SSE content)" };
      } catch (e) {
        const ms = Date.now() - start;
        if (e.name === 'TimeoutError') return { ok: false, ms, detail: "超時" };
        return { ok: false, ms, detail: e.message?.slice(0, 80) || "error" };
      }
    }

    // Helper: send a test request and return diagnosis
    // feature: 'basic' | 'vision' | 'tools' — changes success criteria
    async function testRequest(reqBody, timeoutMs = 10000, feature = 'basic') {
      const start = Date.now();
      try {
        const headers = { "Content-Type": "application/json", Authorization: "Bearer " + ch.api_key };
        if (!headers.Authorization) delete headers.Authorization;
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        const ms = Date.now() - start;
        if (res.status === 200) {
          try {
            const json = JSON.parse(text);
            const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.delta?.content;
            const toolCalls = json?.choices?.[0]?.message?.tool_calls || json?.choices?.[0]?.delta?.tool_calls;
            const finishReason = json?.choices?.[0]?.finish_reason;

            // Tools test: must return actual tool_calls to be considered supported
            if (feature === 'tools') {
              const hasToolCalls = (toolCalls && toolCalls.length > 0) || finishReason === "tool_calls";
              if (hasToolCalls) return { ok: true, ms, detail: "tool_calls received" };
              return { ok: false, ms, detail: "tools not supported (text-only response)" };
            }

            // Vision: model must return content (image was sent inline)
            if (feature === 'vision' && content && content.trim().length > 0) {
              return { ok: true, ms, detail: content.slice(0, 100) };
            }

            if (content && content.trim().length > 0) return { ok: true, ms, detail: content.slice(0, 100) };
            if (toolCalls && toolCalls.length > 0) return { ok: true, ms, detail: "tool_calls received" };
            if (finishReason === "tool_calls") return { ok: true, ms, detail: "tool_calls (finish_reason)" };
            return { ok: false, ms, detail: "empty response" };
          } catch (e) {
            if (text && text.length > 0) return { ok: true, ms, detail: "non-JSON response" };
            return { ok: false, ms, detail: "empty body" };
          }
        }
        if (res.status === 400) return { ok: false, ms, detail: "不支援（HTTP 400）" };
        if (res.status === 401 || res.status === 403) return { ok: false, ms, detail: "API Key 無效（" + res.status + "）" };
        return { ok: false, ms, detail: "HTTP " + res.status };
      } catch (e) {
        const ms = Date.now() - start;
        if (e.name === 'TimeoutError') return { ok: false, ms, detail: "超時" };
        return { ok: false, ms, detail: e.message?.slice(0, 80) || "error" };
      }
    }

    // Helper: update channel health and force cache refresh
    async function updateHealth(isHealthy, diagnosis) {
      const now = Math.floor(Date.now() / 1000);
      const newErrors = isHealthy ? 0 : (ch.consecutive_errors || 0) + 1;
      await c.env.DB.prepare(
        "UPDATE channels SET consecutive_errors=?, last_error_msg=?, last_error_at=?, response_time=? WHERE id=?"
      ).bind(newErrors, isHealthy ? "" : diagnosis, now, 0, chId).run();
      clearCache(); // Force gateway to reload channel state
    }

    // 1. Basic connectivity test (explicit non-streaming to get clean JSON)
    const baseReq = { model: ch.model || "test", messages: [{ role: "user", content: "OK" }], stream: false };
    const baseResult = await testRequest(baseReq, 15000);
    if (!baseResult.ok) {
      let diagnosis = "連線失敗";
      let httpStatus = 0;
      if (baseResult.detail.includes("無效")) { diagnosis = "API Key 無效或已失效"; httpStatus = 401; }
      else if (baseResult.detail.includes("400")) { diagnosis = "請求被拒絕，模型可能不支援"; httpStatus = 400; }
      else if (baseResult.detail.includes("超時")) { diagnosis = "連線超時（15s），渠道可能無回應"; httpStatus = 0; }
      else if (baseResult.detail.includes("empty")) { diagnosis = "回應內容為空，渠道未正確回應"; httpStatus = 200; }
      if (!fromBody) await updateHealth(false, diagnosis);
      return c.json({ ok: false, status: httpStatus, ms: baseResult.ms, diagnosis,
        health_updated: !fromBody, message: fromBody ? "" : "渠道已標記為異常，將暫時不被選用" });
    }

    // Basic test passed - reset health
    if (!fromBody) await updateHealth(true, "");
    const baseMs = baseResult.ms;

    // 2. Test capabilities (vision, tools) in parallel
    const [visionRes, toolsRes] = await Promise.all([
      testRequest({
        model: ch.model || "test",
        messages: [{ role: "user", content: [{ type: "text", text: "desc" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } }] }],
        stream: false,
      }, 8000, 'vision').catch(() => ({ ok: false, ms: 0, detail: "test error" })),
      testRequest({
        model: ch.model || "test",
        messages: [{ role: "user", content: "test" }],
        tools: [{ type: "function", function: { name: "test_func", description: "test", parameters: { type: "object", properties: {} } } }],
        tool_choice: "required",
        stream: false,
      }, 8000, 'tools').catch(() => ({ ok: false, ms: 0, detail: "test error" })),
    ]);

    // 3. Test streaming capability
    const streamRes = await testStreamRequest(15000).catch(() => ({ ok: false, ms: 0, detail: "test error" }));

    // Persist detected capabilities (only if not a test-from-body)
    if (!fromBody) {
      const now = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare(
        "UPDATE channels SET support_stream=?, is_vision=?, support_tools=? WHERE id=?"
      ).bind(streamRes.ok ? 1 : 0, visionRes.ok ? 1 : 0, toolsRes.ok ? 1 : 0, chId).run();
      clearCache();
    }

    const capabilities = {
      vision: { ok: visionRes.ok, detail: visionRes.ok ? "✅ 支援" : "❌ " + visionRes.detail },
      tools: { ok: toolsRes.ok, detail: toolsRes.ok ? "✅ 支援" : "❌ " + toolsRes.detail },
      stream: { ok: streamRes.ok, detail: streamRes.ok ? "✅ 支援" : "❌ " + streamRes.detail },
    };

    return c.json({
      ok: true,
      status: 200,
      ms: baseMs,
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
      batch.push(c.env.DB.prepare("DELETE FROM channels"));
      const allKeyRows = await c.env.DB.prepare("SELECT id, api_key FROM channels").all();
      const allKeys = {};
      for (const row of allKeyRows.results || []) allKeys[row.id] = row.api_key;
      for (const ch of d.channels) {
        const apiKey = ch.api_key || (allKeys[ch.id] || "");
        const h = ch.headers ? (typeof ch.headers === "object" ? JSON.stringify(ch.headers) : ch.headers) : null;
        const po = ch.provider_options ? (typeof ch.provider_options === "object" ? JSON.stringify(ch.provider_options) : ch.provider_options) : null;
        batch.push(
          c.env.DB.prepare(
            "INSERT INTO channels (id, name, base_url, api_key, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, max_tokens, support_tools, support_stream, response_time, fallback_model, headers, provider_options, provider, absolute_url, support_image_gen, support_audio_tts, support_audio_stt, support_image_edit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
          ch.id || null, ch.name || "", ch.base_url || "", apiKey,
            ch.model || "", ch.weight || 50, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0,
            ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0,
            ch.rpm_limit || 0, ch.rpd_limit || 0, ch.max_tokens || 0,
            ch.support_tools ? 1 : 0, ch.support_stream === 0 ? 0 : 1, ch.response_time || 0, ch.fallback_model || "",
            h, po, ch.provider || "", ch.absolute_url ? 1 : 0,
            ch.support_image_gen ? 1 : 0, ch.support_audio_tts ? 1 : 0, ch.support_audio_stt ? 1 : 0, ch.support_image_edit ? 1 : 0
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