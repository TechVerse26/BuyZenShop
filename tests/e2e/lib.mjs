/*
 * Shared Playwright plumbing for tests/e2e/run.mjs (route smoke test) and tests/e2e/flows.mjs (click-through scenarios).
 *
 *   const { base, browser, close } = await launch();             // static dev server + Chromium
 *   const { ctx, page, problems } = await openPage(browser, base, { seed, as: 'u1', cart: [{ key: 'p1', qty: 1 }], vp: 'phone' });
 *
 * `warnings` (console.warn text) never fails a test; flows.mjs prints it next to a failure.
 * Every Firebase SDK URL is answered with tests/e2e/mock-firebase/mock.js (which evaluates the real firestore.rules);
 * fonts / chat widget requests are stubbed. `problems` collects console errors, uncaught exceptions, failed requests and HTTP >= 400.
 */
import { createRequire } from 'node:module';
import { startServer } from '../../tools/dev-server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

export const VIEW = { phone: { width: 360, height: 740 }, desktop: { width: 1280, height: 800 } };
export const IGNORED = [/fonts\.googleapis\.com/, /fonts\.gstatic\.com/, /tawk\.to/];

export async function launch() {
  const srv = await startServer();
  const browser = await chromium.launch();
  return { base: srv.url, browser, close: async () => { await browser.close(); await srv.close(); } };
}

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function openPage(browser, base, { seed, as = null, cart = null, vp = 'phone' } = {}) {
  const ctx = await browser.newContext({ viewport: VIEW[vp], locale: 'bn-BD', timezoneId: 'Asia/Dhaka', serviceWorkers: 'block' });
  await ctx.route('https://www.gstatic.com/firebasejs/**', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' },
    body: `export * from '${base}/tests/e2e/mock-firebase/mock.js';`,
  }));
  await ctx.route('https://mock-storage.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
  await ctx.route(/fonts\.googleapis\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route(/fonts\.gstatic\.com|tawk\.to/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const page = await ctx.newPage();
  const problems = [];
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text().slice(0, 240)); });
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(`console: ${m.text().slice(0, 260)}`); });
  page.on('response', (res) => { if (res.status() >= 400 && !IGNORED.some((rx) => rx.test(res.url()))) problems.push(`HTTP ${res.status()}: ${res.url().slice(0, 140)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message || e).slice(0, 260)}`));
  page.on('requestfailed', (q) => { const u = q.url(); if (!IGNORED.some((rx) => rx.test(u))) problems.push(`request failed: ${u.slice(0, 120)}`); });
  await page.addInitScript(({ s, cart: c }) => {
    window.__SEED__ = s;
    if (c && !window.sessionStorage.getItem('__cart_seeded')) {
      try { window.localStorage.setItem('sv.cart.v2', JSON.stringify({ lines: c })); window.sessionStorage.setItem('__cart_seeded', '1'); } catch { /* ignore */ }
    }
  }, { s: { ...seed, signedInAs: as || null }, cart });
  return { ctx, page, problems, warnings };
}
