#!/usr/bin/env node
/*
 * Browser smoke test (Playwright + Chromium): every route loads, renders content and logs nothing wrong — with the real
 * firestore.rules in the loop (tests/e2e/mock-firebase/mock.js) and a seeded store (tests/e2e/fixtures.mjs).
 *
 *   node tests/e2e/run.mjs                    # all routes, phone viewport (360×740)
 *   node tests/e2e/run.mjs --desktop          # 1280×800 instead     (--both runs the two)
 *   node tests/e2e/run.mjs --only checkout    # routes whose name contains "checkout"
 *   node tests/e2e/run.mjs --shots out/shots  # save full-page screenshots
 *   node tests/e2e/run.mjs --list             # print the route table
 *
 * A route "fails" when it throws, logs a console error, loads nothing, scrolls horizontally, has an <img> without alt, or when
 * the mock Firestore denied a read / write or demanded a composite index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildSeed } from './fixtures.mjs';
import { launch, openPage, VIEW } from './lib.mjs';
import { routes as adminRoutes } from '../../js/admin/routes.js';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const seed = buildSeed();
const ORDER = seed.orderNumbers[0];

const S = (name, p, as = null, extra = {}) => ({ name, path: p, as, ...extra });
const STORE = [
  S('home', '/'), S('shop', '/shop'), S('search', '/search?q=shirt'), S('category', '/category/clothing'), S('brand', '/brand/nordic'),
  S('product', '/product/classic-cotton-t-shirt'), S('product-variable', '/product/running-shoes'), S('product-sale', '/product/leather-wallet'),
  S('cart', '/cart', null, { cart: [{ key: 'p1', qty: 2 }, { key: 'p2', qty: 1 }] }), S('cart-empty', '/cart'),
  S('cart-issues', '/cart', null, { cart: [{ key: 'p1', qty: 2 }, { key: 'p2', qty: 5 }, { key: 'p7', qty: 1 }, { key: 'pd', qty: 1 }, { key: 'p5', qty: 1, p: 3000 }] }),
  S('checkout', '/checkout', 'u1', { cart: [{ key: 'p1', qty: 1 }, { key: 'p5', qty: 1 }] }),
  S('order-success', `/order-success/${ORDER}`, 'u1'),
  S('account', '/account', 'u1'), S('account-orders', '/account/orders', 'u1'), S('account-order', `/account/orders/${ORDER}`, 'u1'),
  S('account-addresses', '/account/addresses', 'u1'), S('account-notifications', '/account/notifications', 'u1'), S('account-support', '/account/support', 'u1'), S('account-support-thread', `/account/support/${seed.ticketId}`, 'u1'),
  S('wishlist', '/wishlist'), S('track', '/track', 'u1'), S('track-order', `/track/${ORDER}`, 'u1'),
  S('login', '/login'), S('contact', '/contact'), S('page-about', '/page/about'), S('not-found', '/no-such-page'),
];
const ADMIN_SAMPLES = { '/orders/:id': `/orders/${ORDER}`, '/customers/:id': '/customers/u1', '/support/:id': `/support/${seed.ticketId}`, '/products/:id': '/products/p1', '/content/pages/:slug': '/content/pages/about' };
const ADMIN = adminRoutes.filter((r) => r.path !== '/forbidden' && (!r.path.includes(':') || ADMIN_SAMPLES[r.path]))
  .map((r) => S(`admin${r.path === '/' ? '-home' : r.path.replace(/[/:]/g, '-')}`, `/admin/#${ADMIN_SAMPLES[r.path] || r.path}`, 'sa', { admin: true }));
const ALL = [...STORE, ...ADMIN];

if (flag('list')) { for (const r of ALL) console.log(`${r.name.padEnd(26)} ${r.path}${r.as ? `   (as ${r.as})` : ''}`); process.exit(0); }

const only = opt('only');
const shots = opt('shots');
const viewports = flag('both') ? ['phone', 'desktop'] : [flag('desktop') ? 'desktop' : 'phone'];

async function visit(browser, base, r, vp) {
  const { ctx, page, problems } = await openPage(browser, base, { seed, as: r.as, cart: r.cart, vp });
  const t0 = Date.now();
  try {
    await page.goto(base + r.path, { waitUntil: 'domcontentloaded' });
    const sel = r.admin ? '.admin-content' : '#main';
    const ready = await page.waitForFunction((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      if (el.querySelector('.spinner, .skeleton, .sk-line, .skeleton-card')) return false;
      return (el.innerText || '').trim().length > 10 || !!el.querySelector('img, svg, canvas, form, table');
    }, sel, { timeout: 12000 }).then(() => true).catch(() => false);
    if (!ready) problems.push('content did not finish loading within 12 s');
    await page.waitForTimeout(500);
    // lazy sections (reviews, images) only load when scrolled near: walk down the page, then come back to the top
    await page.evaluate(async () => {
      const step = Math.max(300, window.innerHeight - 100);
      for (let y = 0; y < document.documentElement.scrollHeight + step; y += step) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.waitForFunction(() => !document.querySelector('#main .spinner, #main .sk-line, .admin-content .spinner, .admin-content .sk-line'), null, { timeout: 8000 }).catch(() => problems.push('a lazy section did not finish loading after scrolling'));
    await page.waitForTimeout(300);
    const dom = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      noAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).length,
      active: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className).slice(0, 40)}#${document.activeElement.id}` : '',
      mock: window.__MOCK__ ? { denied: window.__MOCK__.log.denied, index: window.__MOCK__.log.index } : null,
    }));
    if (dom.overflow > 1) problems.push(`horizontal scroll: page is ${dom.overflow}px wider than the viewport`);
    if (dom.noAlt) problems.push(`${dom.noAlt} <img> without alt`);
    if (/skip-link/.test(dom.active)) problems.push(`the skip link holds focus after navigation (${dom.active})`);
    if (!dom.mock) problems.push('Firebase mock was never loaded (the app did not reach firebase.js)');
    else {
      for (const d of dom.mock.denied) problems.push(`rules denied ${d.kind} ${d.key || ''} ${d.ops ? d.ops.join(' | ') : JSON.stringify(d.constraints || {})} [uid ${d.uid}] ${d.error || ''}`.slice(0, 300));
      for (const i of dom.mock.index) problems.push(`composite index needed: ${i.path} where [${i.filters}] orderBy [${i.orders}]`);
    }
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${r.name}.${vp}.png`), fullPage: true }); }
  } catch (e) { problems.push(`runner: ${String(e.message || e).slice(0, 240)}`); }
  await ctx.close();
  return { problems: [...new Set(problems)], ms: Date.now() - t0 };
}

const { base, browser, close } = await launch();
let failed = 0;
let ran = 0;
for (const vp of viewports) {
  console.log(`\n── ${vp} (${VIEW[vp].width}×${VIEW[vp].height}) ──`);
  for (const r of ALL.filter((x) => !only || x.name.includes(only))) {
    const res = await visit(browser, base, r, vp);
    ran++;
    if (res.problems.length) { failed++; console.log(`✗ ${r.name.padEnd(26)} ${res.ms}ms`); for (const p of res.problems.slice(0, 6)) console.log(`    ${p}`); if (res.problems.length > 6) console.log(`    … ${res.problems.length - 6} more`); }
    else console.log(`✓ ${r.name.padEnd(26)} ${res.ms}ms`);
  }
}
await close();
console.log(`\n${ran - failed}/${ran} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
