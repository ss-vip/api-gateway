'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib.js');

// ---------------------------------------------------------------------------
// JSONC / config parsing
// ---------------------------------------------------------------------------
test('parseJsonc strips line and block comments', () => {
  const src = `{
    // line comment
    "a": 1, /* block */ "b": 2
  }`;
  assert.deepEqual(lib.parseJsonc(src), { a: 1, b: 2 });
});

test('parseJsonc tolerates trailing commas', () => {
  const src = `{"a": [1, 2,], "b": 3,}`;
  assert.deepEqual(lib.parseJsonc(src), { a: [1, 2], b: 3 });
});

test('parseJsonc handles strings containing // inside quotes', () => {
  const src = `{"url": "https://x.com"}`;
  assert.deepEqual(lib.parseJsonc(src), { url: 'https://x.com' });
});

test('parseJsonc returns null for empty input', () => {
  assert.equal(lib.parseJsonc(''), null);
  assert.equal(lib.parseJsonc('   '), null);
});

test('_autoFixJson closes unbalanced braces', () => {
  const fixed = lib._autoFixJson('{"a": [1, 2');
  assert.ok(fixed && lib.parseJsonc(fixed) !== null);
  assert.deepEqual(lib.parseJsonc(fixed), { a: [1, 2] });
});

test('_autoFixJson returns null on mismatched brackets', () => {
  assert.equal(lib._autoFixJson('{"a": ]'), null);
});

test('_jsonValid accepts plain JSON and JSONC', () => {
  assert.deepEqual(lib._jsonValid('{"a":1}'), { ok: true });
  assert.deepEqual(lib._jsonValid('{"a":1,} // c'), { ok: true });
  const bad = lib._jsonValid('{bad');
  assert.equal(bad.ok, false);
  assert.ok(typeof bad.error === 'string');
});

test('_ndjsonValid validates one object per line', () => {
  assert.deepEqual(lib._ndjsonValid('{"a":1}\n{"b":2}'), { ok: true });
  const bad = lib._ndjsonValid('{"a":1}\n{bad');
  assert.equal(bad.ok, false);
  assert.ok(/line 2/.test(bad.error));
  assert.deepEqual(lib._ndjsonValid(''), { ok: true });
});

// ---------------------------------------------------------------------------
// Model alias resolution & endpoint fallback
// ---------------------------------------------------------------------------
test('createModelResolver matches exact and prefixed client models', () => {
  const entries = new Map([
    ['gpt-4o', [{ provider: 'openai', model: 'gpt-4o' }]],
    ['openai', [{ provider: 'mistral', model: 'mistral-small-latest' }]],
  ]);
  const resolve = lib.createModelResolver(entries);
  assert.deepEqual(resolve('gpt-4o'), [{ provider: 'openai', upstreamModel: 'gpt-4o' }]);
  assert.deepEqual(resolve('OPENAI'), [{ provider: 'mistral', upstreamModel: 'mistral-small-latest' }]);
  assert.deepEqual(resolve('openai/something'), [{ provider: 'mistral', upstreamModel: 'mistral-small-latest' }]);
  assert.equal(resolve('unknown'), null);
});

test('createEndpointResolver falls back to endpoint alias', () => {
  const entries = new Map([
    ['dall-e-3', [{ provider: 'together', model: 'FLUX' }]],
  ]);
  const resolve = lib.createEndpointResolver(
    entries,
    { '/v1/images/generations': 'dall-e-3' }
  );
  assert.deepEqual(resolve('openai', '/v1/images/generations'), [{ provider: 'together', upstreamModel: 'FLUX' }]);
  assert.equal(resolve('openai', '/v1/chat/completions'), null);
  assert.equal(resolve(null, '/v1/missing'), null);
});

// ---------------------------------------------------------------------------
// Chat body validation
// ---------------------------------------------------------------------------
test('validateChatBody rejects malformed bodies', () => {
  assert.equal(lib.validateChatBody(null), 'invalid request body');
  assert.equal(lib.validateChatBody({}), 'messages must be a non-empty array');
  assert.match(lib.validateChatBody({ messages: [] }), /non-empty/);
  assert.match(lib.validateChatBody({ messages: [{ role: 'user' }] }), /model is required/);
});

test('validateChatBody accepts a valid message array', () => {
  const body = {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'x' },
      { role: 'user', content: 'hi' },
    ],
  };
  assert.equal(lib.validateChatBody(body), null);
});

test('validateChatBody requires content for user messages', () => {
  const body = { model: 'm', messages: [{ role: 'user' }] };
  assert.match(lib.validateChatBody(body), /content is required/);
});

test('validateChatBody allows assistant with tool_calls', () => {
  const body = {
    model: 'm',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'abc123456', type: 'function' }] },
      { role: 'tool', tool_call_id: 'abc123456', content: 'ok' },
    ],
  };
  assert.equal(lib.validateChatBody(body), null);
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------
test('estimateStrTokens: CJK costs more than latin', () => {
  const cjk = lib.estimateStrTokens('中文測試中文測試');
  const latin = lib.estimateStrTokens('hello world');
  assert.ok(cjk > latin);
  assert.ok(latin > 0);
});

test('estimateTokens counts images', () => {
  const m = [
    { role: 'user', content: 'hi' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }] },
  ];
  assert.ok(lib.estimateTokens(m) >= 1000);
  assert.equal(lib.estimateTokens(null), 0);
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
test('formatUptime formats human readable uptime', () => {
  assert.equal(lib.formatUptime(0), '0s');
  assert.equal(lib.formatUptime(65), '1m 5s');
  assert.equal(lib.formatUptime(90061), '1d 1h 1m 1s');
});

test('logKey masks key leaving last 4 chars', () => {
  assert.equal(lib.logKey('sk-abcdef1234'), '...1234');
  assert.equal(lib.logKey(''), '-');
  assert.equal(lib.logKey(null), '-');
});

test('rewriteModelInSse rewrites model but not error chunks', () => {
  const ok = `data: {"model":"gpt-4o","choices":[]}\n`;
  assert.equal(lib.rewriteModelInSse(ok, 'alias'), `data: {"model":"alias","choices":[]}\n`);
  const err = `data: {"error":{"message":"x"},"model":"gpt-4o"}`;
  assert.equal(lib.rewriteModelInSse(err, 'alias'), err);
  assert.equal(lib.rewriteModelInSse(ok, ''), ok);
});

test('_safeSlice avoids splitting a surrogate pair', () => {
  const s = '😀'; // surrogate pair, length 2
  const cut = lib._safeSlice(s, 1);
  assert.equal(cut.length, 0); // whole char dropped rather than split
  assert.equal(lib._safeSlice('abc', 2), 'ab');
});

// ---------------------------------------------------------------------------
// Quota / error detection
// ---------------------------------------------------------------------------
test('_isQuotaError detects quota signatures on 429/403', () => {
  assert.equal(lib._isQuotaError(429, 'insufficient quota'), true);
  assert.equal(lib._isQuotaError(403, 'billing issue'), true);
  assert.equal(lib._isQuotaError(500, 'insufficient quota'), false);
  assert.equal(lib._isQuotaError(429, 'rate limit exceeded'), false);
});

test('_errMsg extracts message from JSON error body', () => {
  const body = JSON.stringify({ error: { message: 'bad key' } });
  assert.equal(lib._errMsg(body, 100), 'bad key');
  assert.equal(lib._errMsg('plain text error', 100), 'plain text error');
  assert.equal(lib._errMsg(null, 100), '-');
});

test('_hasNonTextContent detects image parts', () => {
  assert.equal(lib._hasNonTextContent([{ role: 'user', content: [{ type: 'image_url' }] }]), true);
  assert.equal(lib._hasNonTextContent([{ role: 'user', content: 'just text' }]), false);
});

test('_dropInvalidImageParts filters bad urls', () => {
  const msgs = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
      { type: 'image_url', image_url: { url: 'not-a-url' } },
      { type: 'text', text: 'hi' },
    ],
  }];
  const dropped = lib._dropInvalidImageParts(msgs);
  assert.equal(dropped, 1);
  assert.equal(msgs[0].content.length, 2);
});

test('normalizeMessageOrder inserts synthetic assistant before tool+user', () => {
  const out = lib.normalizeMessageOrder([
    { role: 'user', content: 'a' },
    { role: 'tool', tool_call_id: 'abc123456', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[2].content, '.\n');
});

test('normalizeMessageOrder sanitizes invalid tool ids', () => {
  const out = lib.normalizeMessageOrder([
    { role: 'assistant', tool_calls: [{ id: 'bad-id', type: 'function' }] },
    { role: 'tool', tool_call_id: 'bad-id', content: 'x' },
  ]);
  const newId = out[0].tool_calls[0].id;
  assert.notEqual(newId, 'bad-id');
  assert.equal(/^[a-zA-Z0-9]{9}$/.test(newId), true);
  assert.equal(out[1].tool_call_id, newId);
});
