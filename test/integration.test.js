'use strict';

// Black-box integration tests for src/index.js.
// Strategy: spin up ONE mock upstream HTTP server plus the real gateway (as a
// subprocess with a temp config). The gateway follows the OpenAI-standard
// stream contract (omitted stream means JSON; explicit stream:true means SSE),
// so we distinguish mock behaviour by the `Authorization` key the gateway
// sends (one key per provider). No production code is modified.

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
        mock.requests.push({ method: req.method, url: req.url, auth, body,
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
          mocklow: { apiKeys: ['key-low'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mockvis: { apiKeys: ['key-vis'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
          mocknc: { apiKeys: ['key-nc'], baseUrl: `http://127.0.0.1:${mockPort}`, pathPrefix: '/v1' },
        },
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

test('chat: upstream 5xx surfaces as error to client', async () => {
  // The gateway retries on key cooldown then returns the error as JSON
  // (omitted stream means non-stream). key_cooldown is low in the test
  // config so retries resolve fast.
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

test('GET /v1/models lists configured aliases', async () => {
  const r = await req({ method: 'GET', path: '/v1/models', headers: authH() });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  const ids = j.data.map((m) => m.id);
  assert.ok(ids.includes(MODEL_JSON));
  assert.ok(ids.includes(MODEL_SSE));
});
