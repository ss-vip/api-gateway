// Executes console.html scripts in a DOM stub; string-fetching alone hid a boot
// crash that blanked the dashboard with no error.
//
//   node --test test/console-boot.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../src/console.html'), 'utf8');

function extractInlineScripts(html) {
  // only <script> with no src — external ones (bootstrap, chart.js, the
  // translation lib) are not needed for the boot path we assert
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

// Every id the page declares, so $(id) resolves instead of throwing.
function declaredIds(html) {
  return [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
}

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', className: '', dataset: {}, style: {},
    checked: false, disabled: false, files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { return c; }, removeChild() {}, remove() {}, focus() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    scrollIntoView() {},
  };
  return el;
}

function makeSandbox(ids, { fetchImpl } = {}) {
  const store = new Map();
  const els = new Map(ids.map((i) => [i, makeEl(i)]));
  const listeners = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { if (typeof fn === 'function') { try { fn(); } catch {} } return 0; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    AbortController: class { constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} }; } abort() { this.signal.aborted = true; } },
    AbortSignal: { timeout: () => ({}) },
    TextDecoder, TextEncoder, URL, URLSearchParams, Promise, JSON, Math, Date,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { protocol: 'http:', href: 'http://127.0.0.1/console', reload() {} },
    navigator: { language: 'en-US' },
    fetch: fetchImpl || (() => Promise.reject(new Error('no fetch in sandbox'))),
    document: {
      body: { classList: { add() {}, remove() {}, contains: () => false }, appendChild() {} },
      documentElement: { classList: { add() {}, remove() {} } },
      getElementById: (id) => els.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      createElement: (tag) => makeEl('<' + tag + '>'),
      createTextNode: (t) => ({ t }),
    },
    getComputedStyle: () => ({}),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.scrollTo = () => {};
  sandbox.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  return { sandbox, els, listeners };
}

async function runScripts(ids, { fetchImpl, stopAfter, ticks = 6 } = {}) {
  const { sandbox, els } = makeSandbox(ids, { fetchImpl });
  const ctx = vm.createContext(sandbox);
  const errors = [];
  const scripts = extractInlineScripts(HTML);
  for (let i = 0; i < scripts.length; i++) {
    if (stopAfter != null && i > stopAfter) break;
    try {
      vm.runInContext(scripts[i], ctx, { filename: `console.html#script${i}` });
    } catch (e) {
      errors.push({ index: i, message: e.message, stack: String(e.stack || '').split('\n').slice(0, 3).join(' | ') });
    }
  }
// Drain microtasks so the async boot path actually runs.
  for (let i = 0; i < ticks; i++) { try { await Promise.resolve(); } catch {} }
  await new Promise((r) => setImmediate(r));
  return { errors, ctx, els, scriptCount: scripts.length };
}

// A recording stand-in for the translate.js library: every entry point that
// could fetch or render records its call instead of doing anything.
function makeTranslateSpy(calls) {
  const rec = (name) => (...args) => { calls.push(name + (args.length ? ':' + args.map(String).join(',') : '')); };
  return {
    setDocuments: rec('setDocuments'),
    execute: rec('execute'),
    changeLanguage: rec('changeLanguage'),
    service: { use: rec('service.use') },
    language: { setLocal: rec('language.setLocal'), clearCacheLanguage: rec('language.clearCacheLanguage') },
    ignore: { class: { push: rec('ignore.class.push') } },
    listener: { start: rec('listener.start'), renderTaskFinish: function () {} },
  };
}

function makeLangItem(lang, handlers) {
  const item = {
    getAttribute: (k) => (k === 'data-lang' ? lang : null),
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener: (ev, fn) => { handlers.push({ lang, fn, item }); },
  };
  return item;
}

// Runs the page with a translate spy installed and a preset gw_lang, then
// drives the translation entry points exactly as the UI would.
async function runWithTranslateSpy(gwLang) {
  const ids = declaredIds(HTML);
  const calls = [];
  const handlers = [];
  const langItems = ['english', 'japanese'].map((l) => makeLangItem(l, handlers));
  const store = new Map(gwLang ? [['gw_lang', gwLang]] : []);
  const fetchImpl = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const { sandbox, els } = makeSandbox(ids, { fetchImpl });
  sandbox.translate = makeTranslateSpy(calls);
  sandbox.MutationObserver = class { constructor() {} observe() {} disconnect() {} };
  sandbox.document.querySelectorAll = (sel) =>
    String(sel).includes('lang-item') ? langItems : [];
  // localStorage preset must win over the sandbox default
  const origGet = sandbox.localStorage.getItem;
  sandbox.localStorage.getItem = (k) => (store.has(k) ? store.get(k) : origGet(k));
  sandbox.localStorage.setItem = (k, v) => store.set(k, String(v));
  const ctx = vm.createContext(sandbox);
  const scripts = extractInlineScripts(HTML);
  for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctx, { filename: `console.html#script${i}` });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  const click = (lang) => {
    const h = handlers.find((x) => x.lang === lang);
    if (!h) throw new Error(`no click handler for ${lang}`);
    h.fn.call(h.item, { preventDefault() {} });
  };
  return { ctx, calls, click, els, handlers };
}

// Await the chain: async throws become rejections invisible to runInContext.
async function bootChain(ids) {
  const api = { providers: {}, http_codes: {} };
  const called = [];
  const fetchImpl = (u) => {
    called.push(String(u));
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null },
      json: () => Promise.resolve(u.includes('/status') ? api : u.includes('/load') ? { config: '{}', log: '' } : {}),
      text: () => Promise.resolve(''),
    });
  };
  const { ctx } = await runScripts(ids, { fetchImpl });
  const failures = [];
  // Drive loadAll directly: it is the call site that broke, and unlike bootAuth
  // it does not open an SSE stream (which needs a real response body).
  try {
    await vm.runInContext('loadAll(0)', ctx, { filename: 'loadAll' });
  } catch (e) {
    failures.push(`loadAll rejected: ${e && e.message}`);
  }
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  // the requests must actually have gone out — a throw before the fetch is
  // exactly how the dashboard ended up empty
  if (!called.some((u) => u.includes('/api/console/load'))) {
    failures.push('loadAll never requested /api/console/load — it aborted before fetching');
  }
  if (!called.some((u) => u.includes('/api/console/status'))) {
    failures.push('loadAll never requested /api/console/status — dashboard would render no metrics');
  }
  return { ctx, failures, api, called };
}

test('console.html: every declared element id is unique', () => {
  const seen = new Map();
  for (const m of HTML.matchAll(/\bid="([^"]+)"/g)) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], `duplicate ids break getElementById lookups: ${dupes.join(', ')}`);
});

test('console.html: inline scripts parse and boot without an uncaught error', async () => {
  const ids = declaredIds(HTML);
  assert.ok(ids.length > 50, `expected a real page, only found ${ids.length} ids`);
  const fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const { errors, scriptCount } = await runScripts(ids, { fetchImpl });
  assert.ok(scriptCount >= 2, `expected several inline scripts, found ${scriptCount}`);
  assert.deepEqual(errors, [], errors.map((e) => `script#${e.index}: ${e.message}  ${e.stack}`).join('\n'));
});

test('console.html: the async boot chain completes without rejecting', async () => {
// Undeclared `_ovSeq` once aborted loadAll() and blanked the dashboard silently.
  const ids = declaredIds(HTML);
  const { failures } = await bootChain(ids);
  assert.deepEqual(failures, [], failures.join('; '));
});

test('console.html: default landing touches no translation API', async () => {
// No preference: landing must not touch the translation library.
  const run = await runWithTranslateSpy(null);
  assert.deepEqual(run.calls, [], `landing page must not call the library, got: ${run.calls.join(' | ')}`);
  // Clicking the English entry must also stay silent (it just reloads).
  run.click('english');
  assert.deepEqual(run.calls, [], `selecting English must not call the library, got: ${run.calls.join(' | ')}`);
  // Post-login auto path with no preference stays silent too.
  await vm.runInContext('window.maybeStartTranslation()', run.ctx);
  assert.deepEqual(run.calls, [], `post-login with no preference must not call the library, got: ${run.calls.join(' | ')}`);
});

test('console.html: selecting English after a translation stays silent', async () => {
  // A session that previously used Japanese, then switches back to English:
  // the English branch reloads and must issue no further library calls.
  const run = await runWithTranslateSpy('japanese');
  await vm.runInContext('window.maybeStartTranslation()', run.ctx);
  assert.ok(run.calls.length > 0, 'precondition: japanese session should initialise the library');
  const n0 = run.calls.length;
  run.click('english');
  assert.equal(run.calls.length, n0, `switching back to English must not call the library, new calls: ${run.calls.slice(n0).join(' | ')}`);
});

test('console.html: a non-English preference still translates after login', async () => {
  // The converse lock-in: silencing English must not break real translation.
  const run = await runWithTranslateSpy('japanese');
  await vm.runInContext('window.maybeStartTranslation()', run.ctx);
  assert.ok(run.calls.some((c) => c === 'execute'), `expected execute, got: ${run.calls.join(' | ')}`);
  assert.ok(run.calls.some((c) => c.startsWith('changeLanguage:japanese')), `expected changeLanguage:japanese, got: ${run.calls.join(' | ')}`);
});

test('console.html: helpers used at boot are defined BEFORE the script that calls them', () => {
  // The specific regression: showLoading/toast/hideLoading were defined in a
  // later <script>, while the boot path in an earlier one called them.
  const scripts = extractInlineScripts(HTML);
  const firstUse = (name) => scripts.findIndex((s) => new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(s));
  const definedIn = (name) => scripts.findIndex((s) =>
    new RegExp(`(function\\s+${name}\\b|window\\.${name}\\s*=)`).test(s));
  for (const name of ['showLoading', 'hideLoading', 'toast']) {
    const use = firstUse(name), def = definedIn(name);
    assert.ok(def >= 0, `${name} is called but never defined`);
    assert.ok(def <= use, `${name} is first used in script #${use} but only defined in script #${def}`);
  }
});
