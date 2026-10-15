'use strict';

// Black-box: one mock upstream + the real gateway as a subprocess.
// Mock branches on the Authorization key (one key per provider).

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TOKEN = 'test-client-token';
// Three providers point at the same mock but use distinct keys so the mock can
// branch its response: JSON (happy path), SSE (stream), 500 (upstream error).
const KEY_JSON = 'key-json';
const KEY_SSE = 'key-sse';
const KEY_ERR = 'key-err';
const KEY_OC = 'key-oc';
const KEY_RSP = 'key-rsp';
const KEY_RSPEMPTY = 'key-rspempty';
// stream that closes WITHOUT a terminal marker ([DONE] / stop / message_stop) →
// the gateway must treat it as a truncated upstream, not a clean success
const KEY_SSETRUNC = 'key-ssetrunc';
// stream that terminates with finish_reason but NO [DONE] — still a valid ending
const KEY_SSEFIN = 'key-ssefin';
// stream whose CONTENT contains the literal text `"stop":` but never terminates.
// A naive /"stop":/ regex would call this complete; it must be reported truncated.
const KEY_SSEDECOY = 'key-ssedecoy';
// upstream that DOES honour stream_options.include_usage — the gateway must
// pass its usage chunk through instead of synthesising a second one
const KEY_SSEUP = 'key-sse-usage';
const MODEL_SSEUP = 'chatstreamusage';
// upstream that reports its OWN rate-limit headers + one that always 429s
const KEY_RLHDR = 'key-rlhdr';
const KEY_429 = 'key-429';
const MODEL_RL = 'chatrlhdr';
const MODEL_429 = 'chat429';
// regression fixtures (2026-10 review): STT model patching + recordSuccess fix,
// 3xx-must-not-stream, and explicit rate_limit surviving a 429 (auto-RPM guard)
const KEY_STT = 'key-stt';
const KEY_302 = 'key-302';
const KEY_RL429 = 'key-rl429';
// slow-but-steady body: keeps trickling for ~2s without ever idling.
// Must NOT be killed (the cap is an idle timeout that resets per chunk).
const KEY_SLOW = 'key-slow';
const MODEL_SSEFIN = 'chatstreamfin';
const MODEL_SSEDECOY = 'chatstreamdecoy';
const MODEL_SLOW = 'chatslow';
// sends headers declaring a body, then hangs up mid-body → truncation
const KEY_TRUNC = 'key-trunc';
const MODEL_SSETRUNC = 'chatstreamtrunc';
const MODEL_TRUNC = 'chattrunc';
const MODEL_JSON = 'chat';
const MODEL_SSE = 'chatstream';
const MODEL_ERR = '_err5xx';

let mock, mockPort, gw, gwPort, cfgPath;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

// --- mock upstream ---------------------------------------------------------
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = {};
        const raw = Buffer.concat(chunks).toString('utf8');
        try { body = JSON.parse(raw || '{}'); } catch {}
        const auth = req.headers['authorization'] || '';
        mock.requests.push({ method: req.method, url: req.url, auth, body, raw,
          fp: { ua: req.headers['user-agent'] || '', client: req.headers['x-opencode-client'] || '',
            session: req.headers['x-opencode-session'] || '', request: req.headers['x-opencode-request'] || '' } });

        // classifier.dev shape (free-mode: no auth) — label by marker, else by labels
        if (body && Array.isArray(body.inputs) && Array.isArray(body.labels)) {
          const txt = String(body.inputs[0] || '');
          const lb = body.labels.map(String);
          const label = txt.includes('XYZZY-ABUSE') ? 'abuse' : lb.includes('complex') ? 'complex' : lb[0];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tier: 'fast', model: 'jev-test', results: [{ label, confidence: 0.95, scores: {} }], usage: { classifications: body.inputs.length } }));
          return;
        }
        if (auth.includes(KEY_ERR)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream boom', type: 'server_error' } }));
          return;
        }
        if (auth.includes(KEY_RSPEMPTY)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'resp_e', status: 'incomplete', output: [], usage: { input_tokens: 9, output_tokens: 1024, total_tokens: 1033 } }));
          return;
        }
        if (auth.includes(KEY_RSP)) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"delta-text"}\n\n' +
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_t","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"snap-text"}]}],"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}\n\n' +
            'data: [DONE]\n\n'
          );
          return;
        }
        if (auth.includes(KEY_429)) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '17' });
          res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
          return;
        }
        if (auth.includes(KEY_302)) {
          // a redirect must be treated as an upstream failure, never piped as success
          res.writeHead(302, { 'Content-Type': 'application/json', Location: 'http://127.0.0.1:1/x' });
          res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'redirect-body' } }] }));
          return;
        }
        if (auth.includes(KEY_RL429)) {
          // 429 on the first hit, success afterwards — lets the test observe the
          // interval AFTER a 429 (the auto-RPM guard must keep it untouched)
          const n = mock.requests.filter((q) => q.auth.includes(KEY_RL429)).length;
          if (n <= 1) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'slow down' } }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }] }));
          }
          return;
        }
        if (auth.includes(KEY_RLHDR)) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'x-ratelimit-limit-requests': '77', 'x-ratelimit-remaining-requests': '5' });
          res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }] }));
          return;
        }
        if (auth.includes(KEY_SSEUP)) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"id":"up1","model":"upstream-actual","choices":[{"delta":{"content":"up"}}]}\n\n');
          res.write('data: {"id":"up1","model":"upstream-actual","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
          res.write('data: {"id":"up1","model":"upstream-actual","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":4242}}\n\n');
          res.write('data: [DONE]\n\n');
          setTimeout(() => { try { res.end(); } catch {} }, 10);
          return;
        }
        if (auth.includes(KEY_SSEFIN)) {
          // terminal chunk carries finish_reason and there is no [DONE] frame
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"model":"upstream-actual","choices":[{"delta":{"content":"fin"}}]}\n\n');
          res.write('data: {"model":"upstream-actual","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
          setTimeout(() => { try { res.end(); } catch {} }, 10);
          return;
        }
        if (auth.includes(KEY_SSEDECOY)) {
          // the model literally emits `"stop":` as content, then the socket dies
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"model":"upstream-actual","choices":[{"delta":{"content":"here is a JSON snippet: "}}]}\n\n');
          res.write('data: {"model":"upstream-actual","choices":[{"delta":{"content":"\\"stop\\": true, "}}]}\n\n');
          setTimeout(() => { try { res.end(); } catch {} }, 10);
          return;
        }
        if (auth.includes(KEY_SLOW)) {
          // one byte every 250ms — every gap stays far below the idle timeout
          res.writeHead(200, { 'Content-Type': 'application/json' });
          let n = 0;
          const tick = setInterval(() => {
            if (n++ === 0) return res.write('{"msg":"');
            if (n > 6) { clearInterval(tick); return res.end('slow-ok"}'); }
            res.write('x');
          }, 250);
          return;
        }
        if (auth.includes(KEY_SSETRUNC)) {
          // headers say 200/stream, we emit one delta then END with no terminal
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"model":"upstream-actual","choices":[{"delta":{"content":"partial"}}]}\n\n');
          setTimeout(() => { try { res.end(); } catch {} }, 20);
          return;
        }
        if (auth.includes(KEY_TRUNC)) {
          // declare 500 bytes, send 10, then destroy the socket mid-body
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
          res.write('{"partial":');
          setTimeout(() => { try { res.destroy(); } catch {} }, 20);
          return;
        }
        if (auth.includes(KEY_SSE)) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(
            'data: {"model":"upstream-actual","choices":[{"delta":{"content":"hi"}}]}\n\n' +
            'data: [DONE]\n\n'
          );
          return;
        }
        // default: JSON (works for both stream and non-stream clients because
        // the gateway passes the upstream body through)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', model: 'upstream-actual', choices: [{ message: { content: 'ok' } }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      mockPort = srv.address().port;
      mock = { requests: [], server: srv };
      resolve();
    });
  });
}

// --- gateway subprocess ----------------------------------------------------
function startGateway() {
  return new Promise((resolve, reject) => {
    freePort().then((p) => {
      gwPort = p;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
      cfgPath = path.join(dir, 'config.jsonc');
      const cfg = {
        client_token: TOKEN,
        port: gwPort,
        key_cooldown: 200,
        log: { enabled: false },
        providers: {
          mockjson: { apiKeys: [KEY_JSON], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mocksse: { apiKeys: [KEY_SSE], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockerr: { apiKeys: [KEY_ERR], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          orcarouter: { apiKeys: ['key-orca'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          opencode: { apiKeys: [KEY_OC], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockrsp: { apiKeys: [KEY_RSP], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockrspempty: { apiKeys: [KEY_RSPEMPTY], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          tierlite: { apiKeys: ['key-lite'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          tierheavy: { apiKeys: ['key-heavy'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          trisemlite: { apiKeys: ['key-semlite'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          trisemheavy: { apiKeys: ['key-semheavy'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockcls2: { apiKeys: ['key-cls2'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockssetrunc: { apiKeys: [KEY_SSETRUNC], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockssefin: { apiKeys: [KEY_SSEFIN], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockssedecoy: { apiKeys: [KEY_SSEDECOY], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mocksseup: { apiKeys: [KEY_SSEUP], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockrlhdr: { apiKeys: [KEY_RLHDR], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mock429: { apiKeys: [KEY_429], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockslow: { apiKeys: [KEY_SLOW], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mocktrunc: { apiKeys: [KEY_TRUNC], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mocklow: { apiKeys: ['key-low'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockvis: { apiKeys: ['key-vis'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mocknc: { apiKeys: ['key-nc'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockstt: { apiKeys: [KEY_STT], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mock302: { apiKeys: [KEY_302], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockrl429: { apiKeys: [KEY_RL429], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
        },
        rate_limit: { mockrl429: 100 },
        model_limits: { 'mocklow/m': 100 },
        endpoint_fallbacks: { '/v1/audio/speech': 'notchat' },
        smart_route: {
          tri: [
            { alias: 'tri-lite', max_tokens: 4000 },
            { alias: 'tri-heavy', max_tokens: 128000 },
          ],
          trisem: {
            tiers: [
              { alias: 'trisem-lite', max_tokens: 4000 },
              { alias: 'trisem-heavy', max_tokens: 128000 },
            ],
          },
        },
        classifier: { base_url: `http://127.0.0.1:${mockPort}`, timeout_ms: 3000 },
        models: {
          [MODEL_JSON]: [{ provider: 'mockjson', model: 'mock-model' }],
          ocmock: [{ provider: 'opencode', model: 'mock-model' }],
          rsp: [{ provider: 'mockrsp', model: 'mock-model', endpoint: '/v1/responses' }],
          rspempty: [{ provider: 'mockrspempty', model: 'mock-model', endpoint: '/v1/responses' }],
          [MODEL_SSE]: [{ provider: 'mocksse', model: 'mock-model' }],
          [MODEL_SSETRUNC]: [{ provider: 'mockssetrunc', model: 'mock-model' }],
          [MODEL_SSEFIN]: [{ provider: 'mockssefin', model: 'mock-model' }],
          [MODEL_SSEDECOY]: [{ provider: 'mockssedecoy', model: 'mock-model' }],
          [MODEL_SSEUP]: [{ provider: 'mocksseup', model: 'mock-model' }],
          [MODEL_RL]: [{ provider: 'mockrlhdr', model: 'mock-model' }],
          [MODEL_429]: [{ provider: 'mock429', model: 'mock-model' }],
          [MODEL_SLOW]: [{ provider: 'mockslow', model: 'mock-model' }],
          [MODEL_TRUNC]: [{ provider: 'mocktrunc', model: 'mock-model' }],
          [MODEL_ERR]: [{ provider: 'mockerr', model: 'mock-model' }],
          orca: [{ provider: 'orcarouter', model: 'orca-model' }],
          fbchain: [{ provider: 'mockerr', model: 'mock-model', fallback: MODEL_JSON }],
          fbself: [{ provider: 'mockerr', model: 'mock-model', fallback: 'fbself' }],
          'tri-lite': [{ provider: 'tierlite', model: 'mock-model' }],
          'tri-heavy': [{ provider: 'tierheavy', model: 'mock-model' }],
          tri: [{ provider: 'tierlite', model: 'mock-model' }],
          'trisem-lite': [{ provider: 'trisemlite', model: 'mock-model' }],
          'trisem-heavy': [{ provider: 'trisemheavy', model: 'mock-model' }],
          trisem: [{ provider: 'trisemlite', model: 'mock-model' }],
          clsalt: [{ provider: 'mockcls2', model: 'alt-decidermodel' }],
          low: [{ provider: 'mocklow', model: 'm' }],
          vision: [{ provider: 'mockvis', model: 'mock-model' }],
          notchat: [{ provider: 'mocknc', model: 'mock-model' }],
          sttmock: [{ provider: 'mockstt', model: 'stt-upstream-model' }],
          redir302: [{ provider: 'mock302', model: 'mock-model' }],
          rl429: [{ provider: 'mockrl429', model: 'mock-model' }],
        },
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));

// NOTE: stdio ignored — piping it would fill the 64KB buffer and block the gateway.
      gw = spawn(process.execPath, ['src/index.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, CONFIG_PATH: cfgPath, CLIENT_TOKEN: TOKEN },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      gw.on('exit', (code) => { if (gw && !gw.killed) reject(new Error('gateway exited early, code=' + code)); });

      const start = Date.now();
      const probe = setInterval(() => {
        const r = http.request({ hostname: '127.0.0.1', port: gwPort, path: '/health', method: 'GET' }, (res) => {
          res.resume();
          if (res.statusCode === 200) { clearInterval(probe); resolve(); }
        });
        r.on('error', () => {});
        r.end();
        if (Date.now() - start > 15000) { clearInterval(probe); reject(new Error('gateway start timeout (no /health)')); }
      }, 200);
    }).catch(reject);
  });
}

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      hostname: '127.0.0.1', port: gwPort, method: opts.method || 'POST',
      path: opts.path, headers: opts.headers || {},
      timeout: opts.timeout || 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('timeout', () => { r.destroy(new Error('request timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function authH() { return { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }; }
function chatBody(model, extra = {}) {
  return { model, messages: [{ role: 'user', content: 'hi' }], ...extra };
}

before(async () => {
  await startMock();
  await startGateway();
});

after(() => {
  if (gw && !gw.killed) gw.kill('SIGKILL');
  if (mock && mock.server) mock.server.close();
  if (cfgPath) { try { fs.rmSync(path.dirname(cfgPath), { recursive: true, force: true }); } catch {} }
});

// ---------------------------------------------------------------------------
test('GET / returns liveness text', async () => {
  const r = await req({ method: 'GET', path: '/', headers: {} });
  assert.equal(r.status, 200);
  assert.match(r.body, /working/i);
});

test('GET /health returns ok', async () => {
  const r = await req({ method: 'GET', path: '/health', headers: {} });
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.body).status === 'ok');
});

test('auth: missing token → 401', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' } }, chatBody(MODEL_JSON));
  assert.equal(r.status, 401);
});

test('auth: wrong token → 401', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' } }, chatBody(MODEL_JSON));
  assert.equal(r.status, 401);
});

test('chat: forwards to upstream and passes through response', async () => {
  // note: omitted stream means JSON passthrough (OpenAI-standard default)
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody(MODEL_JSON));
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes('data:'), 'non-stream response must not be SSE-framed');
  const j = JSON.parse(r.body);
  assert.equal(j.choices[0].message.content, 'ok');
});

test('chat: mock upstream received the forwarded request', async () => {
  mock.requests.length = 0;
  await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody(MODEL_JSON, { temperature: 0.5 }));
  assert.ok(mock.requests.length >= 1);
  const seen = mock.requests.some((x) => x.body && x.body.temperature === 0.5);
  assert.ok(seen, 'upstream should receive forwarded body fields');
});

test('chat: unsupported model → 404 model_not_found (OpenAI contract)', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, { model: 'nope-model', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 404);
  const e = JSON.parse(r.body).error;
  assert.equal(e.type, 'not_found_error');
  assert.equal(e.code, 'model_not_found');
  assert.equal(e.param, 'model');
});

test('chat: invalid body (no messages) → 400', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, { model: MODEL_JSON });
  assert.equal(r.status, 400);
});

test('chat: orcarouter provider routes to upstream with its key', async () => {
  mock.requests.length = 0;
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('orca'));
  assert.equal(r.status, 200);
  const seen = mock.requests.some((x) => x.auth.includes('key-orca') && x.body && x.body.model === 'orca-model');
  assert.ok(seen, 'orcarouter provider should forward with its own key and upstream model');
});

test('chat: opencode provider sends CLI-imitating fingerprint headers', async () => {
  mock.requests.length = 0;
  const r1 = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('ocmock'));
  assert.equal(r1.status, 200);
  const r2 = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('ocmock'));
  assert.equal(r2.status, 200);
  const seen = mock.requests.filter(x => x.auth.includes(KEY_OC));
  assert.ok(seen.length >= 2, 'upstream should receive both requests');
  for (const s of seen) {
    assert.match(s.fp.ua, /^opencode\/latest\/\d+\.\d+/, 'UA must carry versioned opencode identity');
    assert.equal(s.fp.client, 'tui');
    assert.ok(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(s.fp.session), 'session must be canonical ses_shape');
    assert.ok(s.fp.request.startsWith('req-'), 'request id should be unique per call');
  }
  assert.notEqual(seen[0].fp.request, seen[1].fp.request, 'request ids must differ per call');
});

test('chat: responses-override streams upstream and assembles chat completion', async () => {
  mock.requests.length = 0;
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('rsp'));
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.object, 'chat.completion');
  assert.equal(j.choices[0].message.content, 'snap-text');
  assert.equal(j.usage.prompt_tokens, 7);
  const seen = mock.requests.find(x => x.auth.includes(KEY_RSP));
  assert.ok(seen && seen.body && seen.body.stream === true, 'upstream must be fetched with stream:true');
});

test('chat: responses-override bumps budget once on empty incomplete then answers honest empty', async () => {
  mock.requests.length = 0;
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('rspempty'));
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.choices[0].message.content, '');
  assert.equal(j.choices[0].finish_reason, 'length');
  const seen = mock.requests.filter(x => x.auth.includes(KEY_RSPEMPTY));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body.max_output_tokens, 1024);
  assert.equal(seen[1].body.max_output_tokens, 2048);
});

test('chat: smart_route picks lite tier for small prompts', async () => {
  mock.requests.length = 0;
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('tri', { max_tokens: 10 }));
  assert.equal(r.status, 200);
  assert.ok(mock.requests.some((x) => x.auth.includes('key-lite')), 'small prompt should hit lite tier');
});

test('chat: smart_route picks heavy tier for large prompts', async () => {
  mock.requests.length = 0;
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('tri', { max_tokens: 50000 }));
  assert.equal(r.status, 200);
  assert.ok(mock.requests.some((x) => x.auth.includes('key-heavy')), 'large prompt should hit heavy tier');
});

test('chat: smart_route object-form family also picks tiers', async () => {
  mock.requests.length = 0;
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody('trisem', { max_tokens: 10 }));
  assert.equal(r.status, 200);
  assert.ok(mock.requests.some((x) => x.auth.includes('key-semlite')), 'small prompt should hit lite tier');
});

test('POST /v1/classifier relays to classifier upstream', async () => {
  const r = await req(
    { method: 'POST', path: '/v1/classifier', headers: authH() },
    { texts: ['the checkout button does nothing'], labels: ['bug', 'feature', 'praise'] }
  );
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.results[0].label, 'bug');
});

test('POST /v1/classifier serves repeats from memo without upstream', async () => {
  mock.requests.length = 0;
  const body = { texts: ['memo probe unique line 42'], labels: ['bug', 'feature'] };
  const r1 = await req({ method: 'POST', path: '/v1/classifier', headers: authH() }, body);
  assert.equal(r1.status, 200);
  assert.equal(JSON.parse(r1.body).cached, false);
  const r2 = await req({ method: 'POST', path: '/v1/classifier', headers: authH() }, body);
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r2.body).cached, true);
  const upstreamHits = mock.requests.filter((x) => x.body && Array.isArray(x.body.inputs));
  assert.equal(upstreamHits.length, 1, 'second identical call must not reach upstream');
});

test('POST /v1/classifier routes by model and isolates memo per upstream', async () => {
  mock.requests.length = 0;
  const body = { model: 'clsalt', texts: ['model routing probe sentence'], labels: ['bug', 'feature'] };
  const r = await req({ method: 'POST', path: '/v1/classifier', headers: authH() }, body);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).cached, false);
  assert.ok(mock.requests.some((x) => x.auth.includes('key-cls2')), 'must reach the alias upstream');
  // same texts/labels via default upstream must NOT share the memo entry
  const r2 = await req({ method: 'POST', path: '/v1/classifier', headers: authH() },
    { texts: ['model routing probe sentence'], labels: ['bug', 'feature'] });
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r2.body).cached, false);
  const bad = await req({ method: 'POST', path: '/v1/classifier', headers: authH() },
    { model: 'no-such-alias', texts: ['hi there'], labels: ['a', 'b'] });
  assert.equal(bad.status, 400);
});

test('POST /v1/classify alias still reaches the same relay', async () => {
  const r = await req(
    { method: 'POST', path: '/v1/classify', headers: authH() },
    { texts: ['alias path probe line'], labels: ['bug', 'feature'] }
  );
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).results[0].label, 'bug');
});

test('POST /v1/classifier rejects bad input and missing auth', async () => {
  const bad = await req(
    { method: 'POST', path: '/v1/classifier', headers: authH() },
    { texts: ['hi'], labels: ['only-one'] }
  );
  assert.equal(bad.status, 400);
  const noauth = await req(
    { method: 'POST', path: '/v1/classifier', headers: { 'Content-Type': 'application/json' } },
    { texts: ['hi'], labels: ['a', 'b'] }
  );
  assert.equal(noauth.status, 401);
});

test('POST /v1/classifier normalizes unknown tier to fast', async () => {
  // regression: a bogus tier must not cause ReferenceError → 502
  // (tests the _normalizeClassifierTier helper call path)
  const r = await req(
    { method: 'POST', path: '/v1/classifier', headers: authH() },
    { texts: ['tier probe sentence'], labels: ['bug', 'feature'], tier: 'bogus' }
  );
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).results[0].label, 'bug');
});

test('chat: vision-routed request never overflows onto audio aliases', async () => {
  mock.requests.length = 0;
  const r = await req(
    { method: 'POST', path: '/v1/chat/completions', headers: authH() },
    { model: 'low', messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ] }] }
  );
  assert.equal(r.status, 200);
  assert.ok(mock.requests.some((x) => x.auth.includes('key-vis')), 'image request must stay on vision');
  assert.ok(!mock.requests.some((x) => x.auth.includes('key-nc')), 'must not wander onto audio alias');
});

test('chat: SSE stream rewrites model back to client model', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody(MODEL_SSE, { stream: true }));
  assert.equal(r.status, 200);
  assert.match(r.body, /"model":"chatstream"/, 'SSE model should be rewritten to client model');
  assert.ok(r.body.includes('[DONE]'));
});

test('chat: SSE frames are forwarded exactly once (no duplication)', async () => {
  // Regression: the non-include_usage path wrote every frame AND the raw chunk,
  // so clients received each token twice.
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody(MODEL_SSE, { stream: true }));
  assert.equal(r.status, 200);
  const frames = r.body.split('\n\n').map((f) => f.trim()).filter(Boolean);
  const dataFrames = frames.filter((f) => f.startsWith('data:') && !f.includes('[DONE]'));
  const seen = new Set();
  for (const f of dataFrames) {
    assert.ok(!seen.has(f), `duplicate SSE frame forwarded to client: ${f.slice(0, 80)}`);
    seen.add(f);
  }
  const dones = frames.filter((f) => f.includes('[DONE]'));
  assert.equal(dones.length, 1, `expected exactly one [DONE], got ${dones.length}`);
});

test('chat: upstream 5xx surfaces as error to client', async () => {
// Retries resolve fast: key_cooldown is low in the test config.
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_ERR));
  assert.equal(r.status, 502);
  assert.ok(r.body.includes('error') || r.body.includes('all failed'), 'client should receive the upstream error');
});

test('chat: fallback alias is tried after primary hard-fails', async () => {
  // fbchain → mockerr (500) → falls back to MODEL_JSON (mockjson 200 'ok')
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody('fbchain'));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).choices[0].message.content, 'ok');
});

test('chat: self-referential fallback terminates instead of looping', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 30000 }, chatBody('fbself'));
  assert.equal(r.status, 502);
  assert.ok(r.body.includes('error') || r.body.includes('all failed'));
});

test('chat: upstream 5xx with stream:true surfaces as SSE error', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_ERR, { stream: true }));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('error') || r.body.includes('all failed'), 'stream client should receive the upstream error as SSE');
  assert.ok(r.body.includes('[DONE]'));
});

test('chat: SSE stream that ends without a terminal marker is NOT counted as success', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_SSETRUNC, { stream: true }));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('partial'), 'client should still receive the partial delta');
  assert.ok(/error|before terminal/i.test(r.body), 'truncated stream must be signalled, not silently accepted');
});

test('chat: truncated upstream body yields 502, not an empty 200 success', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_TRUNC));
  assert.equal(r.status, 502, 'truncated body must not be reported as success');
  assert.ok(/truncat/i.test(r.body));
});

test('chat: SSE ending with finish_reason (no [DONE]) counts as complete', async () => {
  // not every provider emits a literal [DONE]; a terminal finish_reason is a
  // valid ending and must not be misreported as a truncated stream
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_SSEFIN, { stream: true }));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('fin'), 'content should reach the client: ' + r.body.slice(0, 200));
  assert.ok(!/truncat|terminal/i.test(r.body), 'finish_reason stream wrongly flagged as truncated: ' + r.body.slice(0, 200));
});

test('chat: literal "stop": in content does NOT fake a terminal event', async () => {
  // a naive /"stop":/ scan over raw stream bytes would accept this truncated
  // stream as complete, because the model emitted that text as its answer
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_SSEDECOY, { stream: true }));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('JSON snippet'), 'content should still reach the client');
  assert.ok(/error|terminal|truncat/i.test(r.body), 'truncated stream must be signalled: ' + r.body.slice(0, 300));
});

test('chat: slow-but-steady upstream body is not killed by the idle timeout', async () => {
  // the cap is an IDLE timeout, not a total budget: the timer resets on every
  // chunk, so a body that keeps trickling is never killed
  const t0 = Date.now();
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_SLOW));
  const ms = Date.now() - t0;
  assert.equal(r.status, 200, 'slow steady body should succeed: ' + r.body.slice(0, 160));
  assert.ok(r.body.includes('slow-ok'), 'body should be complete: ' + r.body.slice(0, 160));
  assert.ok(ms > 1000, `expected a multi-second transfer, took ${ms}ms`);
});

test('chat: stream_options.include_usage emits a usage-only chunk before [DONE]', async () => {
  // Most OpenAI-compatible upstreams ignore the flag, so the gateway has to
  // synthesise it. Agent tools depend on this for context/cost accounting.
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_SSE, {
    stream: true, stream_options: { include_usage: true },
  }));
  assert.equal(r.status, 200);
  const frames = r.body.split('\n\n').map((f) => f.trim()).filter(Boolean);
  const doneIdx = frames.findIndex((f) => /data:\s*\[DONE\]/.test(f));
  assert.ok(doneIdx >= 0, 'stream must end with [DONE]');
  const usageFrames = frames.filter((f) => /"usage"/.test(f));
  assert.equal(usageFrames.length, 1, `expected exactly one usage frame, got ${usageFrames.length}`);
  const payload = JSON.parse(usageFrames[0].replace(/^data:\s*/, ''));
  assert.deepEqual(payload.choices, [], 'usage chunk must carry an empty choices array');
  assert.equal(payload.object, 'chat.completion.chunk');
  assert.equal(payload.model, MODEL_SSE, 'usage chunk must use the client alias');
  assert.ok(payload.usage.prompt_tokens > 0, 'prompt_tokens should be counted');
  assert.ok(payload.usage.completion_tokens > 0, 'completion_tokens should be counted');
  assert.equal(payload.usage.total_tokens, payload.usage.prompt_tokens + payload.usage.completion_tokens, 'total mismatch');
  assert.ok(frames.indexOf(usageFrames[0]) < doneIdx, 'usage chunk must precede [DONE]');
});

test('chat: include_usage does not duplicate an upstream-supplied usage chunk', async () => {
  // an upstream that DOES honour the flag must not get a second usage frame
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_SSEUP, {
    stream: true, stream_options: { include_usage: true },
  }));
  assert.equal(r.status, 200);
  const usageFrames = r.body.split('\n\n').filter((f) => /"usage"/.test(f));
  assert.equal(usageFrames.length, 1, `upstream usage must be passed through exactly once, got ${usageFrames.length}`);
  const payload = JSON.parse(usageFrames[0].replace(/^data:\s*/, ''));
  assert.equal(payload.usage.total_tokens, 4242, 'upstream usage values must be preserved, not overwritten');
});

test('chat: include_usage off by default adds no usage chunk', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_SSE, { stream: true }));
  assert.equal(r.status, 200);
  assert.ok(!/"usage"/.test(r.body), 'no usage chunk unless the client asked for one');
  assert.ok(/data:\s*\[DONE\]/.test(r.body), 'must still terminate with [DONE]');
});

test('errors use the OpenAI error envelope', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody('_err5xx'));
  assert.equal(r.status, 502);
  const j = JSON.parse(r.body);
  assert.ok(j.error, 'no error object');
  assert.equal(typeof j.error.message, 'string');
  assert.equal(j.error.type, 'api_error', `expected api_error for a 5xx, got ${j.error.type}`);
  assert.ok(typeof j.error.code === 'string' && j.error.code, 'missing machine-readable code');
});

test('error types follow the OpenAI status mapping', async () => {
  const bad = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, '{bad');
  assert.equal(bad.status, 400, 'malformed JSON status');
  assert.equal(JSON.parse(bad.body).error.type, 'invalid_request_error', '400 maps to invalid_request_error');

  const unsupported = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, { model: 'no-such-alias', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(unsupported.status, 404, 'unknown model must be 404 per OpenAI spec');
  const um = JSON.parse(unsupported.body).error;
  assert.equal(um.type, 'not_found_error', `404 maps to not_found_error, got ${um.type}`);
  assert.equal(um.code, 'model_not_found', 'model_not_found code lets clients offer a model list');
  assert.equal(um.param, 'model', 'param should identify the offending field');

  const unauth = await fetch(`http://127.0.0.1:${gwPort}/v1/models`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(unauth.status, 401, 'bad token status');
  const ue = await unauth.json();
  assert.equal(ue.error.type, 'authentication_error', `401 maps to authentication_error, got ${ue.error.type}`);
});

test('x-ratelimit-* headers are emitted for a rate-limited provider', async () => {
  // mockjson is a manual provider, so the gateway auto-derives an interval
  // (DEFAULT_MANUAL_RPM) and can honestly advertise its admission capacity
  const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ model: MODEL_JSON, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  });
  await r.text();
  const limit = r.headers.get('x-ratelimit-limit-requests');
  const remaining = r.headers.get('x-ratelimit-remaining-requests');
  const reset = r.headers.get('x-ratelimit-reset-requests');
  assert.ok(limit, 'x-ratelimit-limit-requests missing');
  assert.ok(remaining !== null, 'x-ratelimit-remaining-requests missing');
  assert.ok(reset, 'x-ratelimit-reset-requests missing');
  assert.ok(/^\d+$/.test(limit), `limit should be an integer, got ${limit}`);
  assert.ok(/^(\d+ms|\d+s)$/.test(reset), `reset should be an OpenAI-style duration, got ${reset}`);
});

test('upstream x-ratelimit-* headers are relayed verbatim', async () => {
  const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ model: MODEL_RL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  });
  await r.text();
  assert.equal(r.headers.get('x-ratelimit-limit-requests'), '77', 'upstream limit header must win over our own');
  assert.equal(r.headers.get('x-ratelimit-remaining-requests'), '5', 'upstream remaining must be relayed');
});

test('a 429 publishes a retry-after backoff signal', async () => {
  const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ model: MODEL_429, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  });
  await r.text();
  assert.equal(r.headers.get('x-ratelimit-remaining-requests'), '0', 'a rate-limited response must report 0 remaining');
  const ra = r.headers.get('retry-after');
  assert.ok(ra, 'retry-after missing on 429');
  assert.ok(Number(ra) >= 1, `retry-after should be seconds, got ${ra}`);
  const reset = r.headers.get('x-ratelimit-reset-requests');
  assert.ok(reset && /^\d+(ms|s)$/.test(reset), `reset should be a duration, got ${reset}`);
});

// ---------------------------------------------------------------------------
// regressions from the 2026-10 review (each guards a bug the E2E suite caught)
test('stt: multipart model field is patched to the upstream model and success is recorded', async () => {
  // two bugs in one flow: (1) the default STT branch used to forward the raw
  // multipart with the client alias as model; (2) a recordSuccess(logId) crash
  // turned every successful STT into a 502 AFTER the upstream had answered.
  const boundary = '----gwtest42';
  const mp = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsttmock\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nBINARYWAVBYTES\r\n`
    + `--${boundary}--\r\n`;
  const r = await req({
    path: '/v1/audio/transcriptions',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${TOKEN}` },
  }, mp);
  assert.equal(r.status, 200, 'STT success must reach the client, got: ' + r.body.slice(0, 120));
  const hit = mock.requests.find((q) => q.auth.includes(KEY_STT));
  assert.ok(hit, 'upstream saw the STT request');
  assert.match(hit.raw, /name="model"\r\n\r\nstt-upstream-model\r\n/, 'model field must be patched to the upstream model');
  assert.ok(hit.raw.includes('BINARYWAVBYTES'), 'audio bytes must survive untouched');
});

test('chat: upstream 3xx is a failure, never streamed to the client as success', async () => {
  const r = await req({ path: '/v1/chat/completions', headers: authH() }, chatBody('redir302'));
  assert.equal(r.status, 502, 'a 302 must surface as an upstream failure');
  const j = JSON.parse(r.body);
  assert.equal(j.error.code, 'upstream_unavailable');
  assert.match(j.error.message, /all failed/, 'reported through the gateway error envelope, not a piped 2xx');
});

test('rate_limit: an explicit configured interval survives a 429 (auto-RPM must not clobber it)', async () => {
  // one key: first hit 429s, second succeeds — the success response advertises
  // the gateway interval. Before the guard, the 429 stretched 100ms to ~8.5s
  // (limit-requests 600 → 7) and it stayed there.
  const r = await req({ path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody('rl429'));
  assert.equal(r.status, 200, 'the retry after the 429 must succeed, got: ' + r.body.slice(0, 120));
  assert.equal(r.headers['x-ratelimit-limit-requests'], '600',
    `60000/100ms must stay intact after a 429, got ${r.headers['x-ratelimit-limit-requests']}`);
});

test('CORS: console endpoints do not reflect foreign origins; API endpoints stay wildcard', async () => {
  const evil = await req({ method: 'GET', path: '/api/console/status', headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.status, 401, 'unauthenticated console access stays denied');
  assert.equal(evil.headers['access-control-allow-origin'], undefined,
    'a foreign Origin must not be reflected on console endpoints');
  const api = await req({ method: 'GET', path: '/v1/models', headers: { Origin: 'http://evil.example' } });
  assert.equal(api.headers['access-control-allow-origin'], '*', 'API endpoints keep the wildcard CORS');
});

test('error responses are always valid JSON, never a dropped connection', async () => {
// Undefined X-Request-Id used to destroy the socket instead of sending JSON.
  const post_ = (raw) => fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authH() },
    body: raw,
    signal: AbortSignal.timeout(20000),
  });
  const cases = [
    ['unknown model', JSON.stringify({ model: 'nope-model', messages: [{ role: 'user', content: 'x' }] }), 404],
    ['malformed JSON', '{bad', 400],
    ['missing messages', JSON.stringify({ model: MODEL_JSON }), 400],
  ];
  for (const [label, raw, want] of cases) {
    let r;
    try { r = await post_(raw); } catch (e) { throw new Error(`${label}: connection dropped instead of returning an error (${e.message})`); }
    const text = await r.text();
    assert.equal(r.status, want, `${label}: status`);
    let j = null;
    try { j = JSON.parse(text); } catch { throw new Error(`${label}: body is not JSON: ${text.slice(0, 140)}`); }
    assert.ok(j.error && j.error.message, `${label}: no error envelope, got ${text.slice(0, 120)}`);
  }
});

test('GET /v1/models lists configured aliases', async () => {
  const r = await req({ method: 'GET', path: '/v1/models', headers: authH() });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  const ids = j.data.map((m) => m.id);
  assert.ok(ids.includes(MODEL_JSON));
  assert.ok(ids.includes(MODEL_SSE));
});

test('console save rejects structurally invalid config without touching the file', async () => {
  // A successful save would restart the shared gateway fixture, so only the
  // rejection paths are exercised here — and each must leave the file alone.
  const before = fs.readFileSync(cfgPath, 'utf8');
  const save = (content) => req(
    { method: 'POST', path: '/api/console/save', headers: authH(), timeout: 20000 },
    { file: 'config', content },
  );
  const cases = [
    ['empty providers', JSON.stringify({ providers: {}, models: { m: [{ provider: 'x', model: 'y' }] } }), /at least one provider/],
    ['no live keys', JSON.stringify({ providers: { a: ['  '] }, models: { m: [{ provider: 'a', model: 'y' }] } }), /non-empty API key/],
    ['dangling provider', JSON.stringify({ providers: { a: ['k'] }, models: { m: [{ provider: 'ghost', model: 'y' }] } }), /unknown provider/],
    ['bad port', JSON.stringify({ port: 99999, providers: { a: ['k'] }, models: { m: [{ provider: 'a', model: 'y' }] } }), /port must be/],
  ];
  for (const [label, content, want] of cases) {
    const r = await save(content);
    assert.equal(r.status, 400, `${label}: expected 400, got ${r.status}: ${r.body.slice(0, 160)}`);
    assert.ok(want.test(r.body), `${label}: expected ${want}, got ${r.body.slice(0, 160)}`);
  }
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), before, 'rejected saves must not modify the config file');
});
