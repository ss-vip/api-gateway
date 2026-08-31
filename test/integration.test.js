'use strict';

// Black-box integration tests for src/index.js.
// Strategy: spin up ONE mock upstream HTTP server plus the real gateway (as a
// subprocess with a temp config). The gateway always forwards to the upstream
// in stream mode and rewrites `model` to the upstream model, so we distinguish
// mock behaviour by the `Authorization` key the gateway sends (one key per
// provider). No production code is modified.

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
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
        const auth = req.headers['authorization'] || '';
        mock.requests.push({ method: req.method, url: req.url, auth, body });

        if (auth.includes(KEY_ERR)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream boom', type: 'server_error' } }));
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
        },
        models: {
          [MODEL_JSON]: [{ provider: 'mockjson', model: 'mock-model' }],
          [MODEL_SSE]: [{ provider: 'mocksse', model: 'mock-model' }],
          [MODEL_ERR]: [{ provider: 'mockerr', model: 'mock-model' }],
          orca: [{ provider: 'orcarouter', model: 'orca-model' }],
        },
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));

      // NOTE: stdio is fully ignored. Piping gateway's stdout/stderr to the
      // parent would fill the pipe buffer (64KB) and BLOCK the gateway process
      // once it emits enough logs during a request. We wait on /health instead.
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
    const data = body ? JSON.stringify(body) : null;
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
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody(MODEL_JSON));
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  // gateway rewrites the model back to the client-requested model
  assert.equal(j.model, MODEL_JSON);
  assert.equal(j.choices[0].message.content, 'ok');
});

test('chat: mock upstream received the forwarded request', async () => {
  mock.requests.length = 0;
  await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody(MODEL_JSON, { temperature: 0.5 }));
  assert.ok(mock.requests.length >= 1);
  const seen = mock.requests.some((x) => x.body && x.body.temperature === 0.5);
  assert.ok(seen, 'upstream should receive forwarded body fields');
});

test('chat: unsupported model → 400', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, { model: 'nope-model', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 400);
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

test('chat: SSE stream rewrites model back to client model', async () => {
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH() }, chatBody(MODEL_SSE, { stream: true }));
  assert.equal(r.status, 200);
  assert.match(r.body, /"model":"chatstream"/, 'SSE model should be rewritten to client model');
  assert.ok(r.body.includes('[DONE]'));
});

test('chat: upstream 5xx surfaces as error to client', async () => {
  // The gateway retries on key cooldown then returns the error as a streamed
  // (status 200, SSE body) proxy_error. key_cooldown is low in the test config
  // so retries resolve fast.
  const r = await req({ method: 'POST', path: '/v1/chat/completions', headers: authH(), timeout: 20000 }, chatBody(MODEL_ERR));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('error') || r.body.includes('all failed'), 'client should receive the upstream error');
});

test('GET /v1/models lists configured aliases', async () => {
  const r = await req({ method: 'GET', path: '/v1/models', headers: authH() });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  const ids = j.data.map((m) => m.id);
  assert.ok(ids.includes(MODEL_JSON));
  assert.ok(ids.includes(MODEL_SSE));
});
