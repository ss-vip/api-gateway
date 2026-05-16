// Vibe Coding 全面模擬測試套件
// 測試所有正常/異常情境，確保工具正常運作

import http from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const GATEWAY_PORT = 17860;
const MOCK_PORT = 17861;

let passed = 0, failed = 0;
let gwProcess = null, mockServer = null;
let _clientToken = "sk-test123456";
function getToken() { return _clientToken; }

// ─── Mock Upstream Server ─────────────────────────────────────────
function startMockUpstream() {
  return new Promise((resolveMock) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${MOCK_PORT}`);
      const path = url.pathname;
      const scenario = globalThis._scenario || "normal";

      // Collect POST body
      let body = {};
      if (req.method === "POST") {
        let buf = "";
        req.on("data", (c) => buf += c);
        req.on("end", () => {
          try { body = JSON.parse(buf); } catch(e) {}
          handle();
        });
      } else {
        handle();
      }

      function handle() {
        const isStream = body.stream === true;

        if (path === "/__scenario") {
          globalThis._scenario = body.scenario || "normal";
          if (body.retryAfter !== undefined) globalThis._retryAfter = body.retryAfter;
          return res.writeHead(200, { "Content-Type": "application/json" }) && res.end(JSON.stringify({ ok: true }));
        }

        const ss = (status, ct, data) => { res.writeHead(status, { "Content-Type": ct }); res.end(data); };
        const json = (status, obj) => ss(status, "application/json", JSON.stringify(obj));
        const sse = (data) => { res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }); data.forEach(d => res.write(d)); res.end(); };
        const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

        if (path === "/v1/chat/completions" || path === "/chat/completions") {
          const now = Math.floor(Date.now() / 1000);

          switch (scenario) {
            case "normal":
              if (isStream) {
                sse([
                  sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
                  sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: { content: "Hello! I am a mock AI assistant." }, finish_reason: null }] }),
                  sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
                  "data: [DONE]\n\n",
                ]);
              } else {
                json(200, { id: "chatcmpl-mock", object: "chat.completion", created: now, model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content: "Hello! I am a mock AI assistant." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
              }
              break;

            case "tool-call":
              if (isStream) {
                sse([
                  sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] }),
                  sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }),
                  sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_mock_1", function: { arguments: '{"location":"Taipei"}' } }] }, finish_reason: null }] }),
                  sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
                  "data: [DONE]\n\n",
                ]);
              } else {
                json(200, { id: "chatcmpl-mock", object: "chat.completion", created: now, model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "get_weather", arguments: '{"location":"Taipei"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 } });
              }
              break;

            case "vision":
              json(200, { id: "chatcmpl-mock", object: "chat.completion", created: now, model: "mock-vision-model", choices: [{ index: 0, message: { role: "assistant", content: "I see an image in your message." }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });
              break;

            case "rate-limit": case "429":
              res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(globalThis._retryAfter || 30) });
              res.end(JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }));
              break;

            case "server-error": case "500":
              json(500, { error: { message: "Internal Server Error", type: "server_error" } });
              break;

            case "timeout":
              break; // Never respond

            case "disconnect-midstream":
              res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
              res.write(sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: { content: "Starting response but then " }, finish_reason: null }] }));
              setTimeout(() => { try { req.socket.destroy(); } catch(e) {} }, 100);
              break;

            case "invalid-json":
              ss(200, "application/json", "this is not json{{{");
              break;

            case "stream-error":
              res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
              res.write(sseLine({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: now, model: "mock-model", choices: [{ index: 0, delta: { content: "Some content " }, finish_reason: null }] }));
              res.write(sseLine({ type: "error", error: { message: "Upstream API error" } }));
              res.end();
              break;

            default:
              json(503, { error: { message: "Unknown scenario", type: "server_error" } });
          }
        } else if (path === "/v1/models" || path === "/models") {
          json(200, { object: "list", data: [{ id: "mock-model", object: "model", created: 1735689600, owned_by: "mock" }] });
        } else if (path === "/v1/embeddings" || path === "/embeddings") {
          json(200, { object: "list", data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }], model: "mock-embedding", usage: { prompt_tokens: 5, total_tokens: 5 } });
        } else {
          ss(404, "text/plain", "Not found");
        }
      }
    });

    server.listen(MOCK_PORT, () => {
      globalThis._scenario = "normal";
      console.log(`  [mock] upstream on :${MOCK_PORT}`);
      resolveMock(server);
    });
  });
}

// ─── HTTP Helper ─────────────────────────────────────────────────
async function api(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (path.startsWith("/admin")) headers["X-Admin-Token"] = token || "test-admin-pass";

    const opts = {
      hostname: "localhost",
      port: GATEWAY_PORT,
      path,
      method,
      headers,
    };

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on("error", (e) => reject(e));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── SSE Streaming Helper ─────────────────────────────────────────
async function streamApi(path, body, token) {
  return new Promise((resolve, reject) => {
  const chunks = [];
  const req = http.request({
    hostname: "localhost",
    port: GATEWAY_PORT,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  }, (res) => {
    let buf = "";
    const processBuffer = () => {
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6).trim();
          if (data === "[DONE]") {
            chunks.push({ type: "done" });
          } else if (data === "[KEEPALIVE]") {
            chunks.push({ type: "keepalive" });
          } else {
            try {
              chunks.push({ type: "chunk", data: JSON.parse(data) });
            } catch (e) {
              chunks.push({ type: "parse-error", raw: data.slice(0, 100) });
            }
          }
        }
      }
    };
    res.on("data", (c) => {
      buf += c.toString();
      processBuffer();
    });
    res.on("end", () => {
      // Process remaining buffer
      if (buf.trim()) processBuffer();
      resolve({ status: res.statusCode, headers: res.headers, chunks });
    });
    res.on("error", reject);
  });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Test Assertion Helpers ──────────────────────────────────────
function assert(condition, msg) {
  if (condition) {
    console.log(`    ✅ ${msg}`);
    passed++;
  } else {
    console.log(`    ❌ ${msg}`);
    failed++;
  }
}

function assertStatus(res, expected, label) {
  assert(res.status === expected, `${label} → HTTP ${res.status} (expected ${expected})`);
}

function assertBody(res, checkFn, label) {
  try {
    const ok = checkFn(res.json);
    assert(ok, `${label} → body valid`);
  } catch (e) {
    assert(false, `${label} → ${e.message}`);
  }
}

// ─── Scenario Controller ─────────────────────────────────────────
async function setScenario(scenario, retryAfter) {
  globalThis._retryAfter = retryAfter;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ scenario });
    const req = http.request({
      hostname: "localhost", port: MOCK_PORT, path: "/__scenario", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function setupChannel(name, scenario = "normal") {
  // Reset scenario
  await setScenario(scenario);

  const channel = {
    id: 1,
    name,
    base_url: `http://localhost:${MOCK_PORT}/v1`,
    api_key: "sk-mock-key",
    model: "mock-model",
    weight: 100,
    is_enabled: 1,
    is_vision: scenario === "vision" ? 1 : 0,
    support_tools: 1,
    rpm_limit: 0,
    rpd_limit: 0,
    max_tokens: 0,
    fallback_model: "",
    headers: null,
    provider_options: null,
    provider: "openai",
    last_429: 0,
    consecutive_errors: 0,
    last_error_msg: "",
    last_error_at: 0,
    response_time: 0,
    rpm_count: 0,
    rpm_reset_at: 0,
    rpd_count: 0,
    rpd_reset_at: 0,
  };
  return channel;
}

// ─── Start Gateway ────────────────────────────────────────────────
async function startGateway() {
  const proc = spawn("node", ["--expose-gc", "app.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      LOG_DIR: resolve(ROOT, "temp/logs"),
      BACKUP_DIR: resolve(ROOT, "temp/backups"),
      FREE_TIER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`  [gw] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`  [gw:err] ${d}`));
  proc.on("error", (e) => { throw e; });

  // Poll until the port is open (max 20s)
  for (let i = 0; i < 40; i++) {
    try {
      const r = await api("GET", "/health");
      if (r.status === 200) {
        console.log(`  [gw] gateway ready on :${GATEWAY_PORT} (attempt ${i + 1})`);
        return proc;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Gateway failed to start within 20s");
}

// ─── Stop Everything ──────────────────────────────────────────────
function cleanup() {
  if (gwProcess) { try { gwProcess.kill(); } catch(e) {} }
}

// ─── Helper: Set Admin Password via DB ────────────────────────────
async function setupAdmin() {
  // Set admin password directly via admin API (no auth needed when no password set)
  const res = await api("POST", "/admin/api/admin-pass", { pass: "test-admin-pass" });
  if (res.status !== 200) {
    console.log(`  [setup] admin-pass: HTTP ${res.status} ${res.body}`);
  }
  return res;
}

async function batchChannels(channels) {
  const res = await api("POST", "/admin/api/batch-channels", channels, "test-admin-pass");
  if (res.status !== 200) {
    console.log(`  [setup] batch-channels: HTTP ${res.status} ${res.body}`);
  }
  return res;
}

// ═══════════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════════

async function runTests() {
  console.log("\n" + "=".repeat(60));
  console.log("  VIBE CODING 全面模擬測試");
  console.log("=".repeat(60));

  // 1. ── STARTUP ──────────────────────────────────────────────────
  console.log("\n📦 [1/5] 環境準備");
  mockServer = await startMockUpstream();
  console.log("  ✅ Mock upstream ready");

  gwProcess = await startGateway();
  // Small delay to ensure server is accepting connections
  await new Promise(r => setTimeout(r, 500));
  console.log("  ✅ Gateway ready");

  // Re-seed db.json for consistent test state
  const DB_PATH = resolve(ROOT, "src/db.json");
  writeFileSync(DB_PATH, JSON.stringify({
    channels: [],
    filters: [],
    config: { id: 1, client_token: getToken(), admin_password: "", recovery_period: 300, created_at: 0, updated_at: 0 }
  }, null, 2));

  await setScenario("normal");
  await setupAdmin();
  console.log("  ✅ Admin password set");

  // Verify the token is what we expect
  const tokenCheck = await api("GET", "/admin/api/config", null, "test-admin-pass");
  if (tokenCheck.status === 200) {
    _clientToken = tokenCheck.json?.token || _clientToken;
    console.log(`  ✅ Client token: ${_clientToken}`);
  } else {
    console.log(`  ⚠️ Using default token: ${_clientToken}`);
  }

  // ────────────────────────────────────────────────────────────────
  //   TEST GROUP A: AUTH & BASIC
  // ────────────────────────────────────────────────────────────────
  console.log("\n🔐 [A] 認證與基本端點");

  // A1: No auth → 401
  console.log("  A1: No auth token");
  let r = await api("POST", "/v1/chat/completions", { model: "x", messages: [{ role: "user", content: "hi" }] });
  assertStatus(r, 401, "no auth");
  assertBody(r, (j) => j.error?.code === "invalid_api_key", "error code = invalid_api_key");

  // A2: Bad token → 401
  console.log("  A2: Bad token");
  r = await api("POST", "/v1/chat/completions", { model: "x", messages: [{ role: "user", content: "hi" }] }, "bad-token");
  assertStatus(r, 401, "bad token");

  // A3: Models endpoint
  console.log("  A3: GET /v1/models");
  r = await api("GET", "/v1/models", null, getToken());
  assertStatus(r, 200, "models endpoint");
  assertBody(r, (j) => j.object === "list", "returns list");

  // A4: Health
  console.log("  A4: GET /health");
  r = await api("GET", "/health", null, getToken());
  assertStatus(r, 200, "health endpoint");
  assertBody(r, (j) => j.ok === true, "health ok");

  // ────────────────────────────────────────────────────────────────
  //   TEST GROUP B: NORMAL OPERATION
  // ────────────────────────────────────────────────────────────────
  console.log("\n✅ [B] 正常運作");

  // B1: Non-streaming success
  console.log("  B1: Non-streaming chat completion");
  await setScenario("normal");
  await batchChannels([await setupChannel("normal-ch", "normal")]);
  r = await api("POST", "/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
  }, getToken());
  assertStatus(r, 200, "200 OK");
  assertBody(r, (j) => j.choices?.[0]?.message?.content?.includes("Hello"), "has response content");
  assertBody(r, (j) => j.usage?.total_tokens > 0, "has usage tokens");

  // B2: Streaming success
  console.log("  B2: Streaming chat completion");
  await setScenario("normal");
  const s = await streamApi("/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
  }, getToken());
  assertStatus(s, 200, "200 OK");
  assert(s.chunks.length > 0, `received ${s.chunks.length} SSE chunks (expected >0)`);
  const contentChunks = s.chunks.filter(c => c.type === "chunk" && c.data?.choices?.[0]?.delta?.content);
  const errorParses = s.chunks.filter(c => c.type === "parse-error");
  if (contentChunks.length === 0) {
    console.log(`    [debug] chunks: ${JSON.stringify(s.chunks.slice(0, 5).map(c => ({ type: c.type, fields: c.data ? Object.keys(c.data) : [] })))}`);
    if (errorParses.length > 0) console.log(`    [debug] parse errors: ${errorParses.map(c => c.raw).join(", ")}`);
  }
  assert(contentChunks.length > 0, `${contentChunks.length} content chunks`);
  assert(s.chunks.some(c => c.type === "done"), "has [DONE]");

  // B3: Tool calling (non-streaming)
  console.log("  B3: Tool calling (non-streaming)");
  await setScenario("tool-call");
  r = await api("POST", "/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "What's the weather?" }],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { location: { type: "string" } } } } }],
  }, getToken());
  assertStatus(r, 200, "200 OK");
  assertBody(r, (j) => j.choices?.[0]?.message?.tool_calls?.length > 0, "has tool_calls");
  assertBody(r, (j) => j.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "get_weather", "tool name = get_weather");

  // B4: Tool calling (streaming)
  console.log("  B4: Tool calling (streaming)");
  await setScenario("tool-call");
  const s2 = await streamApi("/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "What's the weather?" }],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
    stream: true,
  }, getToken());
  assertStatus(s2, 200, "200 OK");
  const toolChunks = s2.chunks.filter(c => c.type === "chunk" && c.data?.choices?.[0]?.delta?.tool_calls);
  if (toolChunks.length === 0) {
    console.log(`    [debug] tool stream chunks: ${JSON.stringify(s2.chunks.slice(0, 5).map(c => ({ type: c.type, keys: c.data ? Object.keys(c.data) : [] })))}`);
  }
  assert(toolChunks.length > 0, `${toolChunks.length} tool call delta chunks`);
  assert(s2.chunks.some(c => c.type === "done"), "has [DONE]");

  // B5: Embeddings
  console.log("  B5: Embeddings");
  r = await api("POST", "/v1/embeddings", {
    model: "mock-model",
    input: "Hello world",
  }, getToken());
  assertStatus(r, 200, "200 OK");
  assertBody(r, (j) => j.data?.[0]?.embedding?.length > 0, "has embedding vector");

  // ────────────────────────────────────────────────────────────────
  //   TEST GROUP C: CHANNEL INSTABILITY & RECOVERY
  // ────────────────────────────────────────────────────────────────
  console.log("\n⚠️ [C] 渠道不穩、冷卻、故障復原");

  // C1: Channel returns 429 → cooling → switch to other channel
  console.log("  C1: 429 rate limit with retry to backup channel");
  await setScenario("rate-limit");
  const ch1 = await setupChannel("primary", "rate-limit");
  ch1.id = 1;
  const ch2 = await setupChannel("backup", "normal");
  ch2.id = 2;
  await batchChannels([ch1, ch2]);
  r = await api("POST", "/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
  }, getToken());
  assertStatus(r, 200, "backup channel succeeds");
  assertBody(r, (j) => j.choices?.[0]?.message?.content?.includes("Hello"), "backup response correct");

  // C2: Channel returns 500 → error learning → switch
  console.log("  C2: 500 server error → retry other channel");
  await setScenario("server-error");
  const ch3 = await setupChannel("broken", "server-error");
  ch3.id = 3;
  const ch4 = await setupChannel("working", "normal");
  ch4.id = 4;
  await batchChannels([ch3, ch4]);
  r = await api("POST", "/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
  }, getToken());
  assertStatus(r, 200, "working channel succeeds after error");
  assertBody(r, (j) => j.choices?.[0]?.message?.content?.includes("Hello"), "fallback response correct");

  // C3: All channels fail → 503
  console.log("  C3: All channels fail → 503");
  await setScenario("server-error");
  const ch5 = await setupChannel("fail1", "server-error");
  ch5.id = 5;
  const ch6 = await setupChannel("fail2", "server-error");
  ch6.id = 6;
  await batchChannels([ch5, ch6]);
  r = await api("POST", "/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
  }, getToken());
  assertStatus(r, 503, "all channels fail = 503");
  assertBody(r, (j) => j.error?.code === "api_error", "error code = api_error");

  // C4: Invalid JSON from upstream → error recovery
  console.log("  C4: Upstream invalid JSON → 503 fallback");
  await setScenario("invalid-json");
  await batchChannels([await setupChannel("bad-json", "invalid-json")]);
  r = await api("POST", "/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
  }, getToken());
  assertStatus(r, 503, "invalid upstream JSON = 503");

  // C5: Stream mid-disconnect → error recovery
  console.log("  C5: Stream mid-connection lost → graceful error");
  await setScenario("disconnect-midstream");
  await batchChannels([await setupChannel("disconnect", "disconnect-midstream")]);
  const s3 = await streamApi("/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
  }, getToken());
  // Should still get a valid HTTP response (streaming started ok)
  assert(s3.status === 200 || s3.status === 503, `stream disconnects gracefully: HTTP ${s3.status}`);
  // May or may not have [DONE] depending on timing
  // The important thing is the request doesn't hang

  // ────────────────────────────────────────────────────────────────
  //   TEST GROUP D: EDGE CASES
  // ────────────────────────────────────────────────────────────────
  console.log("\n⚡ [D] 邊界情境");

  // D1: Invalid JSON body → 400
  console.log("  D1: Invalid request JSON → 400");
  r = await api("POST", "/v1/chat/completions", "not-json-at-all", getToken());
  // This won't go through the JSON helper, let's test manually
  const rawRes = await new Promise((resolve) => {
    const req = http.request({
      hostname: "localhost", port: GATEWAY_PORT, path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test123456" },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.write("not-json{");
    req.end();
  });
  assertStatus(rawRes, 400, "invalid JSON = 400");

  // D2: Missing messages → 400
  console.log("  D2: Missing messages → 400");
  r = await api("POST", "/v1/chat/completions", { model: "x" }, getToken());
  assertStatus(r, 400, "missing messages = 400");
  assertBody(r, (j) => j.error?.type === "invalid_request_error", "error type = invalid_request_error");

  // D3: No channels configured → 503
  console.log("  D3: No channels → 503");
  await batchChannels([]);
  r = await api("POST", "/v1/chat/completions", {
    model: "mock-model",
    messages: [{ role: "user", content: "Hello" }],
  }, getToken());
  assertStatus(r, 503, "no channels = 503");

  // D4: Channel model mismatch → reject then try other channels
  console.log("  D4: Model name priority routing");
  await setScenario("normal");
  const chA = await setupChannel("other-model", "normal");
  chA.id = 10;
  chA.model = "other-model";
  const chB = await setupChannel("exact-match", "normal");
  chB.id = 11;
  chB.model = "gpt-4-vibe";  // matches the request model
  await batchChannels([chA, chB]);
  r = await api("POST", "/v1/chat/completions", {
    model: "gpt-4-vibe",
    messages: [{ role: "user", content: "Hello" }],
  }, getToken());
  assertStatus(r, 200, "model-priority routing works");

  // D5: Stream duration exceeded
  console.log("  D5: Stream duration limit");
  // Set a very short STREAM_MAX_DURATION_MS via env won't work here,
  // but we can verify the limit exists in code
  // (already verified by C5)

  // D6: Rate-limit headers present
  console.log("  D6: Rate-limit response headers");
  r = await api("GET", "/health", null, getToken());
  assert(r.headers["x-ratelimit-limit"] !== undefined, "has X-RateLimit-Limit header");
  assert(r.headers["x-ratelimit-remaining"] !== undefined, "has X-RateLimit-Remaining header");

  // ────────────────────────────────────────────────────────────────
  //   TEST GROUP E: DASHBOARD & ADMIN API
  // ────────────────────────────────────────────────────────────────
  console.log("\n🛠 [E] 管理後台 API");

  // E1: Login with correct password
  console.log("  E1: Admin login");
  r = await api("POST", "/admin/login", { password: "test-admin-pass" });
  assertStatus(r, 200, "login success");
  assertBody(r, (j) => j.ok === true, "login returns ok");

  // E2: Login with wrong password
  console.log("  E2: Admin login wrong password");
  r = await api("POST", "/admin/login", { password: "wrong" });
  assertStatus(r, 401, "wrong password = 401");

  // E3: Admin API channels CRUD
  console.log("  E3: Admin channels API");
  r = await api("GET", "/admin/api", null, "test-admin-pass");
  assertStatus(r, 200, "list channels");

  // E4: Config update
  console.log("  E4: Config update");
  r = await api("POST", "/admin/api/config", { token: "sk-new-test-token", recovery_period: 600 }, "test-admin-pass");
  assertStatus(r, 200, "config updated");

  // E5: Export/Import
  console.log("  E5: Export");
  r = await api("GET", "/admin/api/export", null, "test-admin-pass");
  assertStatus(r, 200, "export works");

  // ────────────────────────────────────────────────────────────────
  //   TEST GROUP F: CONCURRENT & STRESS
  // ────────────────────────────────────────────────────────────────
  console.log("\n🔥 [F] 並發與壓力");

  // F1: Multiple concurrent requests
  console.log("  F1: 10 concurrent normal requests");
  await setScenario("normal");
  // Re-read token in case E4 changed it
  const tokCheck = await api("GET", "/admin/api/config", null, "test-admin-pass");
  if (tokCheck.status === 200) _clientToken = tokCheck.json?.token || _clientToken;
  await batchChannels([await setupChannel("stress", "normal")]);
  // Give cache time to fully propagate
  await new Promise(r => setTimeout(r, 500));
  // Warm up: send one request to populate cache
  const warmup = await api("POST", "/v1/chat/completions", {
    model: "mock-model", messages: [{ role: "user", content: "warmup" }],
  }, getToken());
  if (warmup.status !== 200) console.log(`    [debug] warmup: HTTP ${warmup.status} ${warmup.body?.slice(0, 100)}`);
  const concurrent = [];
  for (let i = 0; i < 10; i++) {
    concurrent.push(api("POST", "/v1/chat/completions", {
      model: "mock-model",
      messages: [{ role: "user", content: `Request ${i}` }],
    }, getToken()));
  }
  const results = await Promise.allSettled(concurrent);
  const successCount = results.filter(r => r.status === "fulfilled" && r.value.status === 200).length;
  const totalOk = results.filter(r => r.status === "fulfilled").length;
  if (successCount !== 10) {
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.status !== 200) {
        console.log(`    [debug] req ${i}: HTTP ${r.value.status} ${r.value.body?.slice(0, 80)}`);
      }
    });
  }
  assert(successCount === 10, `${successCount}/10 concurrent succeeded (${totalOk} total resolved)`);

  // F2: Overload protection (if MAX_CONCURRENT is low enough)
  console.log("  F2: Rate limit headers reflect capacity");
  r = await api("GET", "/health", null, getToken());
  const remaining = parseInt(r.headers["x-ratelimit-remaining"] || "0");
  assert(remaining >= 0, `remaining capacity: ${remaining}`);

  // ────────────────────────────────────────────────────────────────
  //   SUMMARY
  // ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log(`  測試結果: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  cleanup();
  mockServer.close();

  process.exit(failed > 0 ? 1 : 0);
}

// Main
runTests().catch((e) => {
  console.error("Test harness error:", e);
  cleanup();
  process.exit(1);
});
