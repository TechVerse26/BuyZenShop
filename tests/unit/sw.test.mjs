/*
 * The service worker (sw.js) in a fake worker scope: which requests it touches, what it caches, what it never touches.
 * Real browser behaviour (registration, updates) is not exercised here — only the decisions the worker makes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://shop.test';
const req = (path, extra = {}) => ({ url: path.startsWith('http') ? path : ORIGIN + path, method: 'GET', mode: 'no-cors', ...extra });
const ok = (body = 'ok', type = 'basic') => { const r = new Response(body, { status: 200 }); Object.defineProperty(r, 'type', { value: type }); return r; };

function boot({ fetchImpl } = {}) {
  const handlers = {};
  const stores = new Map();
  const timers = [];
  const key = (r) => new URL(r.url || r, ORIGIN).href;   // like the Cache API: relative strings resolve against the worker's origin
  const store = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const cacheApi = (name) => ({
    async match(r) { const hit = store(name).get(key(r)); return hit ? hit.clone() : undefined; },
    async put(r, res) { store(name).set(key(r), res); },
    async keys() { return [...store(name).keys()].map((url) => ({ url })); },
    async delete(r) { return store(name).delete(key(r)); },
    async addAll(urls) { for (const u of urls) store(name).set(ORIGIN + u, await sandbox.fetch(ORIGIN + u)); },
  });
  const caches = {
    async open(name) { store(name); return cacheApi(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(r) { for (const name of stores.keys()) { const hit = await cacheApi(name).match(r); if (hit) return hit; } return undefined; },
  };
  const calls = { claim: 0, skip: 0 };
  const sandbox = {
    self: { location: { origin: ORIGIN }, addEventListener: (type, fn) => { handlers[type] = fn; }, clients: { claim: async () => { calls.claim++; } }, skipWaiting: () => { calls.skip++; } },
    caches, fetch: fetchImpl || (async () => ok('net')), Response, URL, Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  vm.runInNewContext(SRC, sandbox);
  const fire = async (request) => {
    let responded; let called = false;
    handlers.fetch({ request, respondWith: (p) => { called = true; responded = p; } });
    return { handled: called, response: called ? await Promise.resolve(responded) : undefined };
  };
  return { handlers, stores, timers, calls, fire, sandbox };
}
const text = (r) => r.text();

test('install precaches only the offline page; activate removes every other cache (including the old site\'s) and claims clients', async () => {
  const sw = boot();
  let p; sw.handlers.install({ waitUntil: (x) => { p = x; } }); await p;
  assert.deepEqual([...sw.stores.get('sv-static-v2').keys()], [ORIGIN + '/offline.html']);
  sw.stores.set('offline-shell-v1', new Map());
  sw.stores.set('sv-static-v1', new Map());
  sw.handlers.activate({ waitUntil: (x) => { p = x; } }); await p;
  assert.deepEqual([...sw.stores.keys()], ['sv-static-v2']);
  assert.equal(sw.calls.claim, 1);
});

test('a waiting worker is activated only when the page asks (SKIP_WAITING)', () => {
  const sw = boot();
  sw.handlers.message({ data: { type: 'something-else' } });
  sw.handlers.message({ data: null });
  assert.equal(sw.calls.skip, 0);
  sw.handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.calls.skip, 1);
});

test('never touches non-GET requests, other origins (Firebase, Google, chat, storage) or same-origin data paths', async () => {
  const sw = boot();
  for (const r of [
    req('/js/app.js', { method: 'POST' }),
    req('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel'),
    req('https://identitytoolkit.googleapis.com/v1/accounts:lookup'),
    req('https://firebasestorage.googleapis.com/v0/b/x/o/p.jpg'),
    req('https://embed.tawk.to/abc/default'),
    req('https://fonts.googleapis.com/css2?family=Hind+Siliguri'),
    req('/api/anything'), req('/sw.js'), req('/manifest.webmanifest'),
    req('https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js', { mode: 'cors' }),
  ]) assert.equal((await sw.fire(r)).handled, false, r.url);
});

test('navigation: the network answer when online (nothing cached), the offline page when the network fails', async () => {
  let online = true;
  const sw = boot({ fetchImpl: async (r) => { if (!online && !String(r.url || r).endsWith('/offline.html')) throw new TypeError('offline'); return ok(String(r.url || r).endsWith('/offline.html') ? 'OFFLINE PAGE' : 'LIVE'); } });
  let p; sw.handlers.install({ waitUntil: (x) => { p = x; } }); await p;
  const nav = req('/shop', { mode: 'navigate' });
  const live = await sw.fire(nav);
  assert.equal(await text(live.response), 'LIVE');
  assert.equal([...sw.stores.get('sv-static-v2').keys()].length, 1, 'HTML is not cached');
  online = false;
  assert.equal(await text((await sw.fire(nav)).response), 'OFFLINE PAGE');
  assert.equal((await sw.fire(req('/admin/', { mode: 'navigate' }))).handled, true, 'the admin panel gets the same treatment');
});

test('static files: network first and remembered; served from the cache only when the network fails; failures are not cached', async () => {
  let online = true;
  const sw = boot({ fetchImpl: async (r) => { if (!online) throw new TypeError('offline'); return String(r.url).includes('missing') ? new Response('nope', { status: 404 }) : ok('v-' + r.url.split('/').pop()); } });
  const js = req('/js/store/app.js');
  assert.equal(await text((await sw.fire(js)).response), 'v-app.js');
  await new Promise((r) => setImmediate(r));
  assert.ok(sw.stores.get('sv-static-v2').has(js.url), 'cached after a good response');
  for (const path of ['/css/base.css', '/assets/icons/icon-192.png', '/gallery/watch-cut.webp']) assert.equal((await sw.fire(req(path))).handled, true, path);
  online = false;
  assert.equal(await text((await sw.fire(js)).response), 'v-app.js', 'offline: the cached copy');
  await assert.rejects(async () => (await sw.fire(req('/js/never-seen.js'))).response, TypeError, 'offline and never cached: fails like without a worker');
  online = true;
  const bad = await sw.fire(req('/js/missing.js'));
  assert.equal(bad.response.status, 404);
  await new Promise((r) => setImmediate(r));
  assert.ok(!sw.stores.get('sv-static-v2').has(ORIGIN + '/js/missing.js'), 'a 404 is passed on but not cached');
});

test('static files: a very slow network falls back to the cached copy, an uncached file keeps waiting for the network', async () => {
  let release; const slow = new Promise((r) => { release = r; });
  let mode = 'fast';
  const sw = boot({ fetchImpl: async () => (mode === 'fast' ? ok('OLD') : slow) });
  const file = req('/js/core/dom.js');
  await sw.fire(file); await new Promise((r) => setImmediate(r));
  mode = 'slow';
  const pending = sw.fire(file);
  await new Promise((r) => setImmediate(r));
  assert.equal(sw.timers.at(-1).ms, 4000, 'a 4 second patience');
  sw.timers.at(-1).fn();
  assert.equal(await text((await pending).response), 'OLD', 'cached copy after the timeout');
  const uncached = sw.fire(req('/js/core/new.js'));
  await new Promise((r) => setImmediate(r));
  sw.timers.at(-1).fn();
  release(ok('FRESH'));
  assert.equal(await text((await uncached).response), 'FRESH', 'nothing cached: the network answer, however slow');
});
