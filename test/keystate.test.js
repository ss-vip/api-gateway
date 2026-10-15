// Degraded keys must stay degraded across a restart.
//
//   node --test test/keystate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('http');
const { spawn } = require('child_process');

let mock, dir, cfgPath;
let hits = [];

function startMock(handler) {
  return new Promise((res) => {
    mock = http.createServer(handler);
    mock.listen(0, '127.0.0.1', () => res());
  });
}

function freePort() {
  return new Promise((res, rej) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

// boots a real gateway, runs `fn(port)`, then SIGTERMs it and waits for exit
async function withGateway(cfgOverrides, fn) {
  const port = await freePort();
  const cfg = {
    client_token: 'tok', port, timeout: 8000,
    key_cooldown: 60000, max_key_backoff: 60000,
    log: { enabled: false },        // state must work with logging OFF
    providers: { mock: { apiKeys: ['sk-test-key-aaaaaaaa'], baseUrl: `http://127.0.0.1:${mock.address().port}`, pathPrefix: '/v1' } },
    models: { m: [{ provider: 'mock', model: 'mm' }] },
    ...cfgOverrides,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const proc = spawn(process.execPath, [path.resolve(__dirname, '../src/index.js')], {
    env: { ...process.env, CONFIG_PATH: cfgPath, CLIENT_TOKEN: 'tok' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const res = await fn(port, () => out);
  await new Promise((res2) => { proc.once('exit', res2); proc.kill('SIGTERM'); setTimeout(res2, 5000); });
  return { res, out };
}

const chat = (port) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  signal: AbortSignal.timeout(30000),
}).then((r) => r.status);

test('a quota-exhausted key stays degraded after a restart', async (t) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-kstate-'));
  cfgPath = path.join(dir, 'config.json');
  await startMock((req, res) => {
    hits.push(1);
    // quota-shaped 429
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details' } }));
  });
  t.after(() => { try { mock.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  // 1st run: the key gets quota-degraded, then we restart via SIGTERM
  const first = await withGateway({ quota_backoff: 3600000 }, async (port) => {
    const s = await chat(port);
    return s;
  });
  assert.ok(first.out.includes('[quota]'), 'quota degradation should have been recorded:\n' + first.out.split('\n').filter((l) => l.includes('quota')).join('\n'));

  const statePath = path.join(dir, 'gw-state.json');
  assert.ok(fs.existsSync(statePath), 'gw-state.json should exist after a degradation event');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.v, 1);
  assert.ok(state.keys?.mock, 'state should record the provider');
  const ids = Object.keys(state.keys.mock);
  assert.equal(ids.length, 1, 'exactly one key recorded');
  assert.match(ids[0], /^[0-9a-f]{12}$/, 'key must be stored as a 12-hex digest, not the key itself: ' + ids[0]);

  // the file must contain no request content and no recoverable key material
  const raw = fs.readFileSync(statePath, 'utf8');
  assert.ok(!raw.includes('sk-test-key'), 'raw key leaked into the state file');
  assert.ok(!raw.includes('quota, please check'), 'response body leaked into the state file');
  assert.ok(!raw.includes('"model"') && !raw.includes('"messages"'), 'request data leaked into the state file');

  hits.length = 0;
  // 2nd run: the restored cooldown must keep the request off the upstream
  const second = await withGateway({ quota_backoff: 3600000 }, async (port) => {
    const s = await chat(port);
    return s;
  });
  assert.ok(second.out.includes('[state] restored'), 'boot should report restored cooldowns:\n' + second.out.split('\n').filter((l) => l.includes('state')).join('\n'));
  assert.equal(hits.length, 0, `after a restart the degraded key must not be re-hitted, upstream saw ${hits.length} request(s)`);
  assert.ok(second.res >= 400, 'the client should get an error, not a wasted upstream call');
});

test('a recovered key is dropped from the state file', async (t) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-kstate2-'));
  cfgPath = path.join(dir, 'config.json');
  let fail = true;
  await startMock((req, res) => {
    if (fail) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'quota exceeded for this account' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }] }));
  });
  t.after(() => { try { mock.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  await withGateway({ quota_backoff: 3000, key_cooldown: 3000 }, async (port) => { await chat(port); });
  const statePath = path.join(dir, 'gw-state.json');
  assert.ok(fs.existsSync(statePath), 'state written on degradation');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).keys.mock).length, 1);

  fail = false;
  // The restored cooldown governs, not the new config value — an already
  // recorded backoff must not be retroactively shortened by a config edit.
  await withGateway({ quota_backoff: 3000, key_cooldown: 3000 }, async (port) => {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await chat(port);
    assert.equal(s, 200, 'upstream recovered, request should succeed');
  });
  assert.ok(!fs.existsSync(statePath) || Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).keys?.mock || {}).length === 0,
    'a recovered key must not linger in the state file');
});
