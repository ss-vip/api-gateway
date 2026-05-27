import { requestId, logStructured } from "./lib/request.js";
import { loadChannels, selectChannel, markDegraded, markHealthy, clearChannelCache } from "./lib/channel.js";
import { UPSTREAM_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from "./lib/constants.js";
import { RollingFilter } from "./lib/sse.js";

// Auth cache (1 min TTL)
let tokenCache = { token: null, ts: 0 };
const TOKEN_TTL = 60_000;

async function resolveClientToken(env) {
  if (tokenCache.token && Date.now() - tokenCache.ts < TOKEN_TTL) {
    return tokenCache.token;
  }
  try {
    const cf = await env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    tokenCache = { token: cf?.client_token || null, ts: Date.now() };
  } catch {
    tokenCache = { token: null, ts: Date.now() };
  }
  return tokenCache.token;
}

// Filter cache (3 min TTL)
let filterCache = { data: null, ts: 0 };
const FILTER_TTL = 180_000;

async function loadFilters(env) {
  if (filterCache.data && Date.now() - filterCache.ts < FILTER_TTL) {
    return filterCache.data;
  }
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, text, mode, is_enabled FROM filters WHERE is_enabled = 1 ORDER BY id"
    ).all();
    filterCache = { data: results || [], ts: Date.now() };
  } catch {
    filterCache = { data: [], ts: Date.now() };
  }
  return filterCache.data;
}

// 清除所有快取（dashboard 變更資料時呼叫）
export function clearGatewayCache() {
  tokenCache = { token: null, ts: 0 };
  filterCache = { data: null, ts: 0 };
  clearChannelCache();
}

// 工具函數

function buildBaseHeaders(reqHeaders, rid) {
  const headers = new Headers(reqHeaders);
  headers.set("X-Request-Id", rid);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-worker");
  headers.delete("cf-visitor");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");
  return headers;
}

function cleanResponseHeaders(headers) {
  const h = new Headers(headers);
  h.delete("content-encoding");
  h.delete("transfer-encoding");
  h.delete("cf-ray");
  h.delete("cf-cache-status");
  return h;
}

// 串流內容過濾 TransformStream

function createFilterTransform(filters) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";

  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";

      for (const line of parts) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) {
              delta.content = RollingFilter.applyStatic(delta.content, filters);
            }
            controller.enqueue(encoder.encode("data: " + JSON.stringify(parsed) + "\n"));
          } catch {
            controller.enqueue(encoder.encode(line + "\n"));
          }
        } else {
          controller.enqueue(encoder.encode(line + "\n"));
        }
      }
    },
    flush(controller) {
      if (buf) controller.enqueue(encoder.encode(buf));
    },
  });
}

// 串流 idle timeout — 上游停滯超過 idleMs 時自動斷開

function createIdleTimeoutStream(readable, idleMs) {
  const reader = readable.getReader();
  const { readable: out, writable } = new TransformStream();
  const writer = writable.getWriter();
  let idleTimer;

  (async () => {
    try {
      while (true) {
        clearTimeout(idleTimer);
        const timeout = new Promise((_, reject) => {
          idleTimer = setTimeout(() => reject(new Error("idle")), idleMs);
        });
        const result = await Promise.race([reader.read(), timeout]);
        clearTimeout(idleTimer);
        if (result.done) { await writer.close(); return; }
        await writer.write(result.value);
      }
    } catch (e) {
      await writer.close();
    } finally {
      clearTimeout(idleTimer);
      reader.releaseLock();
    }
  })();

  return out;
}

// 通道選取 + 自動重試（max 3 channels）

async function tryForward(env, path, method, baseHeaders, body, rid) {
  const channels = await loadChannels(env);
  if (channels.length === 0) {
    return { error: { message: "No upstream channels available", status: 503 } };
  }

  const attempted = new Set();

  for (let i = 0; i < Math.min(3, channels.length); i++) {
    const channel = selectChannel(channels, attempted);
    if (!channel) break;
    attempted.add(channel.id);

    const url = new URL(path, channel.base_url).href;
    const headers = new Headers(baseHeaders);
    headers.set("Authorization", `Bearer ${channel.api_key}`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        markHealthy(channel.id);
        return { response: res, channel };
      }

      if (res.status >= 500 || res.status === 429) {
        markDegraded(channel.id);
        logStructured("warn", "upstream error, retrying", {
          channel: channel.name, status: res.status, rid,
        });
        continue;
      }

      return { response: res };

    } catch (err) {
      markDegraded(channel.id);
      logStructured("warn", "upstream fetch failed", {
        channel: channel.name, error: err.message, rid,
      });
      continue;
    }
  }

  return { error: { message: "All upstream channels failed", status: 502 } };
}

// Route Handlers

/** POST /v1/chat/completions */
async function handleChatCompletions(c) {
  const rid = requestId();

  // 先 clone body stream 再做 JSON parse（body 只能 consume 一次）
  const rawBody = await c.req.raw.clone().text();
  let body, isStream = false;
  try {
    body = JSON.parse(rawBody);
    isStream = body?.stream === true;
  } catch (e) {
    return c.json({
      error: { message: "Invalid JSON body", type: "invalid_request_error", param: null, code: "invalid_request_error" },
    }, 400);
  }

  logStructured("info", "chat completion", {
    model: body?.model || "unknown", stream: isStream, rid,
  });

  const baseHeaders = buildBaseHeaders(c.req.raw.headers, rid);

  const result = await tryForward(
    c.env, "/v1/chat/completions", "POST", baseHeaders, rawBody, rid,
  );

  if (result.error) {
    return c.json({
      error: {
        message: result.error.message,
        type: "upstream_error", param: null, code: "upstream_error",
      },
    }, result.error.status);
  }

  const { response: upstream } = result;
  const resHeaders = cleanResponseHeaders(upstream.headers);
  resHeaders.set("X-Request-Id", rid);

  if (isStream) {
    // 總是加上 idle timeout，防止上游停滯時 worker hanging
    let body = createIdleTimeoutStream(upstream.body, STREAM_IDLE_TIMEOUT_MS);

    const filters = await loadFilters(c.env);
    if (filters.length > 0) {
      body = body.pipeThrough(createFilterTransform(filters));
    }

    return new Response(body, { status: upstream.status, headers: resHeaders });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}

/** GET /v1/models — 依序嘗試所有通道，任一成功即回傳 */
async function handleModels(c) {
  const channels = await loadChannels(c.env);
  if (channels.length === 0) return c.json({ object: "list", data: [] });

  // 遍歷所有通道（含 degraded），models 端點通常較穩定
  for (const channel of channels) {
    try {
      const url = new URL("/v1/models", channel.base_url).href;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${channel.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return c.json(await res.json());
    } catch (e) {
      logStructured("warn", "models fetch failed, trying next", {
        channel: channel.name, error: e.message,
      });
    }
  }

  return c.json({ object: "list", data: [] });
}

/** 任意 /v1/* 通用代理 — 透過 tryForward 獲得 retry + load balance */
async function handleGenericProxy(c) {
  const rid = requestId();
  const path = c.req.path;
  const baseHeaders = buildBaseHeaders(c.req.raw.headers, rid);

  // 先 clone body（text）供 tryForward 使用
  const rawBody = c.req.method !== "GET" && c.req.method !== "HEAD"
    ? await c.req.raw.clone().text()
    : undefined;

  const result = await tryForward(
    c.env, path, c.req.method, baseHeaders, rawBody, rid,
  );

  if (result.error) {
    return c.json({
      error: { message: result.error.message, type: "upstream_error", param: null, code: "upstream_error" },
    }, result.error.status);
  }

  const { response: upstream } = result;
  const resHeaders = cleanResponseHeaders(upstream.headers);
  resHeaders.set("X-Request-Id", rid);
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

// /v1/* 認證 middleware — 驗證 Bearer token 等於 config.client_token
async function authMiddleware(c, next) {
  if (c.req.method === "OPTIONS") return next();

  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({
      error: {
        message: "Missing API key. Provide via Authorization: Bearer <key>",
        type: "auth_error", param: null, code: "invalid_api_key",
      },
    }, 401);
  }

  const key = auth.slice(7).trim();
  const validToken = await resolveClientToken(c.env);

  if (!validToken || key !== validToken) {
    return c.json({
      error: {
        message: "Invalid API key",
        type: "auth_error", param: null, code: "invalid_api_key",
      },
    }, 401);
  }

  await next();
}

// 註冊路由

export default function registerGateway(app) {
  // 所有 /v1/* 先過 auth
  app.use("/v1/*", authMiddleware);

  app.post("/v1/chat/completions", handleChatCompletions);
  app.get("/v1/models", handleModels);
  app.all("/v1/*", handleGenericProxy);
}
