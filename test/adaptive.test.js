// Client errors (404/400/410) must never degrade keys or open circuits.
//
//   node --test test/adaptive.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('http');
const { spawn } = require('child_process');

let mock, gw, gwPort, cfgPath, gwOut = '';
let tmpDir;

function freePort() {
  return new Promise((res, rej) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

function startMock(handler) {
  return new Promise((res) => {
    mock = http.createServer(handler);
    mock.listen(0, '127.0.0.1', () => res());
  });
}

async function startGateway(cfgOverrides = {}) {
  gwPort = await freePort();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-adapt-'));
  cfgPath = path.join(tmpDir, 'config.jsonc');
  fs.writeFileSync(cfgPath, JSON.stringify({
    client_token: 'tok', port: gwPort, timeout: 10000,
    log: { enabled: false },
    circuit_breaker: { threshold: 3, cooldown_ms: 20000 },
    model_lockout: { threshold: 3, cooldown_ms: 20000 },
    providers: { mock: { apiKeys: ['k1'], baseUrl: `http://127.0.0.1:${mock.address().port}`, pathPrefix: '/v1' } },
    models: { m: [{ provider: 'mock', model: 'mm' }] },
    ...cfgOverrides,
  }, null, 2));
  gw = spawn(process.execPath, [path.resolve(__dirname, '../src/index.js')], {
    env: { ...process.env, CONFIG_PATH: cfgPath, CLIENT_TOKEN: 'tok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gwOut = '';
  gw.stdout.on('data', (d) => { gwOut += d; });
  gw.stderr.on('data', (d) => { gwOut += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${gwPort}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('gateway did not start:\n' + gwOut);
}

function stopAll() {
  try { gw?.kill('SIGKILL'); } catch {}
  try { mock?.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

const post = (model = 'm', timeout = 60000) => fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
  signal: AbortSignal.timeout(timeout),
}).then(async (r) => ({ status: r.status, text: await r.text() }));

const status = () => fetch(`http://127.0.0.1:${gwPort}/api/console/status`, { headers: { Authorization: 'Bearer tok' } })
  .then((r) => r.json());

test('client errors (404) never degrade the key pool or open the circuit', async (t) => {
  await startMock((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'no such model' } })); });
  await startGateway();
  t.after(stopAll);

  const r = await post();
  assert.equal(r.status, 502, 'upstream 404 surfaces to the client as 502');
  assert.ok(gwOut.includes('404'), 'the request actually reached the upstream');
  assert.ok(!/[circuit] mock opened/.test(gwOut), '404 must not open the circuit');
  assert.ok(!/\[lockout\]/.test(gwOut), '404 must not lock the model');

  const s = await status();
  assert.equal(s.providers.mock.degraded, 0, 'the key must still be healthy after a 404');
});

test('server errors DO open the circuit', async (t) => {
  await startMock((req, res) => { res.writeHead(503); res.end('busy'); });
// Single-key providers report no capacity; the breaker needs multiple keys.
  await startGateway({
    key_cooldown: 0, max_key_backoff: 0,
    providers: { mock: { apiKeys: ['k1', 'k2', 'k3'], baseUrl: `http://127.0.0.1:${mock.address().port}`, pathPrefix: '/v1' } },
  });
  t.after(stopAll);

  await Promise.all([post(), post(), post(), post()]);

  assert.ok(/\[circuit\] mock opened/.test(gwOut), 'circuit should open after 3x5xx:\n' + gwOut.split('\n').filter((l) => l.includes('circuit')).join('\n'));
  const s = await status();
  assert.ok(s.providers.mock.cbOpen, 'status should report the breaker open');
});

test('a single-key provider reports no capacity rather than hammering upstream', async (t) => {
  await startMock((req, res) => { res.writeHead(503); res.end('busy'); });
  await startGateway({ key_cooldown: 30000 });
  t.after(stopAll);
  let hits = 0;
  mock.on('request', () => { hits++; });

  await Promise.all([post(), post(), post()]);
  assert.equal(hits, 1, `a cooling key must absorb only one in-flight failure, upstream got ${hits} hits`);
});

test('a 401 marks the key but does not open the provider circuit', async (t) => {
  await startMock((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid api key' } })); });
  await startGateway();
  t.after(stopAll);

  await post();
  const s = await status();
  assert.ok(s.recent401.length >= 1, '401 should be tracked for the retry-401 workflow');
  assert.equal(s.providers.mock.cbOpen, false, '401 is key-scoped, not a provider outage');
});
