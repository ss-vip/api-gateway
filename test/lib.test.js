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

test('createModelResolver propagates endpoint and fallback', () => {
  const entries = new Map([
    ['a', [{ provider: 'opencode', model: 'm', endpoint: '/v1/responses', fallback: 'b' }]],
    ['c', [{ provider: 'x', model: 'y', fallback: ['b', 'a'] }]],
  ]);
  const resolve = lib.createModelResolver(entries);
  assert.deepEqual(resolve('a'), [{ provider: 'opencode', upstreamModel: 'm', endpoint: '/v1/responses', fallback: 'b' }]);
  assert.deepEqual(resolve('c'), [{ provider: 'x', upstreamModel: 'y', fallback: ['b', 'a'] }]);
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

// ---------------------------------------------------------------------------
// Chat ↔ Responses conversion
// ---------------------------------------------------------------------------
test('chatToResponses maps history, tools and keeps output headroom', () => {
  const out = lib.chatToResponses({
    model: 'm',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
    max_tokens: 100,
    tools: [{ type: 'function', function: { name: 'get_time', description: 'd', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto',
  });
  assert.equal(out.max_output_tokens, 1024);
  assert.deepEqual(out.input, [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]);
  assert.deepEqual(out.tools, [{ type: 'function', name: 'get_time', description: 'd', parameters: { type: 'object', properties: {} } }]);
  assert.equal(out.tool_choice, 'auto');
});

test('chatToResponses converts tool_calls and tool results to responses items', () => {
  const out = lib.chatToResponses({
    model: 'm',
    messages: [
      { role: 'user', content: 'what time' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
    ],
  });
  assert.deepEqual(out.input, [
    { role: 'user', content: 'what time' },
    { type: 'function_call', call_id: 'call_1', name: 'get_time', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '12:00' },
  ]);
});

test('chatToResponses falls back to last user text on unmappable shapes', () => {
  const out = lib.chatToResponses({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] }],
  });
  assert.equal(out.input, 'see');
});

test('responsesOutputToChat extracts text, tool calls and chat-shaped usage', () => {
  const conv = lib.responsesOutputToChat({
    status: 'completed',
    output: [
      { type: 'reasoning', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'function_call', call_id: 'call_9', name: 'read_file', arguments: '{"p":"a"}' },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  }, 'alias');
  assert.equal(conv.text, 'ok');
  assert.deepEqual(conv.toolCalls, [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } }]);
  assert.equal(conv.finish, 'tool_calls');
  assert.deepEqual(conv.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
});

test('responsesOutputToChat maps incomplete status to length', () => {
  const conv = lib.responsesOutputToChat({ status: 'incomplete', output: [], usage: {} }, 'alias');
  assert.equal(conv.finish, 'length');
  assert.equal(conv.text, '');
});

test('chatToResponses maps response_format to text.format', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const o1 = lib.chatToResponses({ model: 'm', messages: msgs, response_format: { type: 'json_object' } });
  assert.deepEqual(o1.text, { format: { type: 'json_object' } });
  const o2 = lib.chatToResponses({ model: 'm', messages: msgs, response_format: { type: 'json_schema', json_schema: { name: 'ans', schema: { type: 'object' }, strict: true } } });
  assert.deepEqual(o2.text, { format: { type: 'json_schema', name: 'ans', schema: { type: 'object' }, strict: true } });
  const o3 = lib.chatToResponses({ model: 'm', messages: msgs, response_format: { type: 'text' } });
  assert.equal(o3.text, undefined);
});

test('chatToResponses coerces tool_choice to upstream-supported auto', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const tools = [{ type: 'function', function: { name: 'a', parameters: {} } }];
  const r1 = lib.chatToResponses({ model: 'm', messages: msgs, tools, tool_choice: 'required' });
  assert.equal(r1.tool_choice, 'auto');
  assert.equal(r1.tools.length, 1);
  const r2 = lib.chatToResponses({ model: 'm', messages: msgs, tools, tool_choice: { type: 'function', function: { name: 'a' } } });
  assert.equal(r2.tool_choice, 'auto');
  const r3 = lib.chatToResponses({ model: 'm', messages: msgs, tools, tool_choice: 'none' });
  assert.equal(r3.tool_choice, undefined);
  assert.equal(r3.tools, undefined);
});

test('chatToResponses maps named tool_choice and parallel tool_calls', () => {
  const out = lib.chatToResponses({
    model: 'm',
    tool_choice: { type: 'function', function: { name: 'a' } },
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
        { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: { nested: true } },
    ],
  });
  assert.equal(out.tool_choice, 'auto');
  assert.deepEqual(out.input.slice(1), [
    { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{"x":1}' },
    { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'r1' },
    { type: 'function_call_output', call_id: 'c2', output: '{"nested":true}' },
  ]);
});

test('canonOpencodeSession renders stable ses_shape sessions', () => {
  const a = lib.canonOpencodeSession('seed-1');
  const b = lib.canonOpencodeSession('seed-1');
  const c = lib.canonOpencodeSession('seed-2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(lib.isCanonOpencodeSession(a));
  assert.ok(lib.isCanonOpencodeSession('ses_abcdef123456AbCdEfGhIjKlMn'));
  assert.equal(lib.isCanonOpencodeSession('gw-abc'), false);
  assert.equal(lib.isCanonOpencodeSession('ses_short'), false);
});

test('PLACEHOLDER_TOOLS declares callable-shaped function tools', () => {
  assert.ok(Array.isArray(lib.PLACEHOLDER_TOOLS) && lib.PLACEHOLDER_TOOLS.length >= 6);
  for (const t of lib.PLACEHOLDER_TOOLS) {
    assert.equal(t.type, 'function');
    assert.ok(typeof t.name === 'string' && t.name);
  }
});

test('assembleResponsesSSE prefers the completed snapshot', () => {
  const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"he"}\n\n'
    + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"llo"}\n\n'
    + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n'
    + 'data: [DONE]\n\n';
  const rj = lib.assembleResponsesSSE(sse);
  assert.equal(rj.id, 'resp_9');
  assert.equal(rj.status, 'completed');
  const conv = lib.responsesOutputToChat(rj, 'alias');
  assert.equal(conv.text, 'hi');
  assert.equal(conv.finish, 'stop');
  assert.deepEqual(conv.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
});

test('assembleResponsesSSE falls back to deltas without completed snapshot', () => {
  const sse = 'data: {"type":"response.output_item.added","item":{"id":"it_1","type":"function_call","call_id":"call_7","name":"read"}}\n\n'
    + 'data: {"type":"response.function_call_arguments.delta","item_id":"it_1","delta":"{\\"p\\":"}\n\n'
    + 'data: {"type":"response.function_call_arguments.delta","item_id":"it_1","delta":"\\"a\\"}"}\n\n';
  const conv = lib.responsesOutputToChat(lib.assembleResponsesSSE(sse), 'alias');
  assert.equal(conv.toolCalls.length, 1);
  assert.equal(conv.toolCalls[0].function.name, 'read');
  assert.equal(conv.toolCalls[0].function.arguments, '{"p":"a"}');
  assert.equal(conv.finish, 'tool_calls');
});

test('responsesOutputToChat round-trips parallel tool calls', () => {
  const conv = lib.responsesOutputToChat({
    status: 'completed',
    output: [
      { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{"x":1}' },
      { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' },
    ],
    usage: {},
  }, 'alias');
  assert.equal(conv.toolCalls.length, 2);
  assert.equal(conv.finish, 'tool_calls');
  assert.equal(conv.toolCalls[1].function.name, 'b');
});

test('chatToAnthropic extracts system and converts tool calls', () => {
  const out = lib.chatToAnthropic({
    model: 'm',
    max_tokens: 77,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'let me check', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
      ] },
      { role: 'tool', tool_call_id: 't1', content: 'found' },
    ],
    tools: [{ type: 'function', function: { name: 'search', description: 's', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  });
  assert.equal(out.system, 'sys');
  assert.equal(out.max_tokens, 77);
  assert.equal(out.messages[1].content[1].type, 'tool_use');
  assert.equal(out.messages[2].content[0].type, 'tool_result');
  assert.equal(out.tools[0].input_schema.type, 'object');
  assert.deepEqual(out.tool_choice, { type: 'auto' });
});

test('chatToAnthropic converts data-url images and drops bad parts', () => {
  const out = lib.chatToAnthropic({
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'not-a-url' } },
    ] }],
  });
  assert.equal(out.messages[0].content[0].type, 'text');
  assert.equal(out.messages[0].content[1].type, 'image');
  assert.equal(out.messages[0].content[1].source.media_type, 'image/png');
  assert.equal(out.messages[0].content.length, 2);
});

test('chatToAnthropic falls back to last user text when empty', () => {
  const out = lib.chatToAnthropic({ model: 'm', messages: [] });
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.max_tokens, 1024);
});
