'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function _parseRetryAfter(res) {
  const h = res?.headers?.['retry-after'] || res?.headers?.['Retry-After'];
  if (!h) return 0;
  const n = parseInt(h, 10);
  if (!isNaN(n)) return n * 1000;
  const t = Date.parse(h);
  return isNaN(t) ? 0 : Math.max(0, t - Date.now());
}

test('_parseRetryAfter seconds', () => {
  assert.equal(_parseRetryAfter({ headers: { 'retry-after': '120' } }), 120000);
});

test('_parseRetryAfter date', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const v = _parseRetryAfter({ headers: { 'retry-after': future } });
  assert.ok(v > 4000 && v <= 5000);
});

test('_parseRetryAfter missing', () => {
  assert.equal(_parseRetryAfter({ headers: {} }), 0);
});

test('adaptive RPM decreases on 429', () => {
  const PROVIDER_RPM = { groq: 12 };
  const _effectiveRPM = new Map(Object.entries(PROVIDER_RPM));
  function _adjustRpm(p, success) {
    const orig = PROVIDER_RPM[p];
    let cur = _effectiveRPM.get(p) ?? orig;
    if (success) {
      cur = Math.min(orig, cur + 1);
      _effectiveRPM.set(p, cur);
    } else {
      cur = Math.max(1, Math.floor(cur * 0.7));
      _effectiveRPM.set(p, cur);
    }
  }
  _adjustRpm('groq', false);
  assert.equal(_effectiveRPM.get('groq'), 8);
  _adjustRpm('groq', false);
  assert.equal(_effectiveRPM.get('groq'), 5);
});

test('health score sorts by errorCount', () => {
  const pool = new Map([
    ['k1', { errorCount: 2, successCount: 10, lastLatency: 100 }],
    ['k2', { errorCount: 0, successCount: 5, lastLatency: 200 }],
    ['k3', { errorCount: 0, successCount: 10, lastLatency: 50 }],
  ]);
  const free = ['k1', 'k2', 'k3'];
  free.sort((a, b) => {
    const sa = pool.get(a), sb = pool.get(b);
    if (sa.errorCount !== sb.errorCount) return sa.errorCount - sb.errorCount;
    if (sa.successCount !== sb.successCount) return sb.successCount - sa.successCount;
    return (sa.lastLatency || 0) - (sb.lastLatency || 0);
  });
  assert.deepEqual(free, ['k3', 'k2', 'k1']);
});

test('reasoning strip deletes fields', () => {
  const PROVIDER_REASONING_SPEC = { amd: 'strip', deepseek: 'keep', mistral: 'effort' };
  function _adjust(body, provider) {
    const spec = PROVIDER_REASONING_SPEC[provider] || 'strip';
    if (!body.reasoning && !body.reasoning_content) return;
    if (spec === 'keep') return;
    if (spec === 'strip') { delete body.reasoning; delete body.reasoning_content; delete body.reasoning_effort; }
  }
  const b1 = { reasoning: { enabled: true }, reasoning_content: 'x' };
  _adjust(b1, 'amd');
  assert.equal(b1.reasoning, undefined);
  assert.equal(b1.reasoning_content, undefined);
  const b2 = { reasoning: { enabled: true } };
  _adjust(b2, 'deepseek');
  assert.ok(b2.reasoning);
});

test('_sanCache FIFO', () => {
  const m = new Map();
  const max = 3;
  function clear() { while (m.size > max) m.delete(m.keys().next().value); }
  m.set('a', 1); m.set('b', 2); m.set('c', 3); m.set('d', 4);
  clear();
  assert.equal(m.size, 3);
  assert.ok(!m.has('a'));
  assert.ok(m.has('d'));
});
