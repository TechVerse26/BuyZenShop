/*
 * Shop Verse service worker — deliberately small and conservative.
 *
 *  • Pages (navigations): always the network. If it fails, the offline page. HTML is never cached, so a new deploy is visible at once.
 *  • Same-origin scripts, styles, icons and gallery images: network first; the cached copy is used only when the network fails or is very slow.
 *    There is no build step (no file hashes), so serving cached code while online could mix old and new modules.
 *  • EVERYTHING else is left to the browser: Firestore, Auth, Storage, Google APIs, the Tawk chat, fonts, other origins, every non-GET request.
 *    Prices, stock, orders and sign-in are therefore never answered from a cache.
 *  • Caches are named `sv-static-<VERSION>`; every other cache (including the old site's) is deleted on activate.
 *    Bump VERSION when this file's logic changes. A new worker waits until the page asks for it (message SKIP_WAITING, see js/store/pwa.js).
 */
const VERSION = 'v2';
const STATIC = `sv-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL];
const STATIC_PATH = /^\/(?:css\/|js\/|assets\/|gallery\/)/;
const NETWORK_TIMEOUT = 4000;
const MAX_ENTRIES = 150;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== STATIC) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') { event.respondWith(navigate(req)); return; }
  if (STATIC_PATH.test(url.pathname)) event.respondWith(networkFirst(req));
});

async function navigate(req) {
  try { return await fetch(req); } catch (e) {
    return (await caches.match(OFFLINE_URL)) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(STATIC);
  const net = fetch(req);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT));
  const res = await Promise.race([net.then((r) => r, () => null), timeout]);   // null = failed or slow
  if (res) { remember(cache, req, res); return res; }
  return (await cache.match(req)) || net;   // nothing cached: keep waiting for the network (or fail exactly as without a worker)
}

function remember(cache, req, res) {
  if (!res.ok || res.type !== 'basic') return;
  cache.put(req, res.clone()).then(() => trim(cache), () => {});
}

async function trim(cache) {
  const keys = (await cache.keys()).filter((k) => !new URL(k.url).pathname.endsWith(OFFLINE_URL));
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}
