#!/usr/bin/env node
/*
 * Click-through scenarios: a customer or staff member uses the real UI in Chromium, with the real firestore.rules evaluated
 * by tests/e2e/mock-firebase/mock.js. After each scenario the mock database is inspected, so these tests check what was
 * actually stored (order, totals, stock reservation, coupon usage, TrxID record …), not just what is on screen.
 *
 *   node tests/e2e/flows.mjs                 every scenario, phone viewport (360×740)
 *   node tests/e2e/flows.mjs --both          phone and desktop
 *   node tests/e2e/flows.mjs --only coupon   scenarios whose name contains "coupon"
 *
 * A scenario also fails on console errors, uncaught exceptions, failed requests, HTTP >= 400 and on any read / write that the
 * rules denied — except the denials a scenario declares with `denied: true` (it tests exactly that rejection).
 */
import { buildSeed } from './fixtures.mjs';
import { launch, openPage } from './lib.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const only = opt('only');
const viewports = flag('both') ? ['phone', 'desktop'] : [flag('desktop') ? 'desktop' : 'phone'];

const seed = buildSeed();
/** the whole text of an element or attribute being one translation key of a known prefix, e.g. "tkm.guest" */
const RAW_KEY = /^(?:od|pe|inv|co|common|prd|rev|dash|ord|auth|pdp|shop|sp|ad|op|cartp|hdr|err|os|admin|ao|ct|trk|home|order|iv|v|ftr|wl|nt|aor|oe|coupon|acc|tk|pd|gal|tab|stk|nf|card|addr|orders|chart|app|products|cart|support|settings|reports|inventory|customers|coupons|staff|shipping|reviews|payments|migrate|mail|costs|stf|stp|cfg|soon|shz|cpn|tax|rvm|tkm|cus|chm|cpg|rpt|aud)\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
/* every file in tests/e2e/flows/ (except helpers.mjs) exports one or more arrays of scenarios; they are all picked up, so a new page needs no registration */
const FLOW_DIR = new URL('./flows/', import.meta.url);
const ORDER = ['customer', 'account', 'storefront'];                                   // storefront first, then the admin files alphabetically
const files = fs.readdirSync(FLOW_DIR).filter((n) => n.endsWith('.mjs') && n !== 'helpers.mjs').sort((a, b) => {
  const ia = ORDER.indexOf(a.replace('.mjs', '')); const ib = ORDER.indexOf(b.replace('.mjs', ''));
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});
const ALL = [];
for (const name of files) for (const exported of Object.values(await import(new URL(name, FLOW_DIR).href))) if (Array.isArray(exported)) ALL.push(...exported);

const { base, browser, close } = await launch();
let failed = 0;
let ran = 0;
for (const vp of viewports) {
  console.log(`\n── ${vp} ──`);
  for (const sc of ALL.filter((s) => !only || s.name.includes(only))) {
    const t0 = Date.now();
    const { ctx, page, problems, warnings } = await openPage(browser, base, { seed, as: sc.as, cart: sc.cart, vp });
    const failures = [];
    const denied = [];
    const f = {
      page, base, vp, seed,
      ok: (cond, msg) => { if (!cond) failures.push(msg); return !!cond; },
      eq: (actual, expected, msg) => { const same = JSON.stringify(actual) === JSON.stringify(expected); if (!same) failures.push(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); return same; },
      collect: async () => { try { denied.push(...(await page.evaluate(() => (window.__MOCK__ ? window.__MOCK__.log.denied.splice(0) : []))) ); } catch { /* page is navigating */ } },
      goto: async (p) => { await f.collect(); await page.goto(base + p, { waitUntil: 'domcontentloaded' }); },
      /** documents whose path starts with `prefix`: { path: doc } */
      /** the mock database lives in the page, so a scenario that reads or patches it before its first navigation gets the home page loaded first */
      mock: async () => { if (page.url() === 'about:blank') await page.goto(base + '/', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.__MOCK__, null, { timeout: 10000 }); },
      docs: async (prefix) => { await f.mock(); return Object.fromEntries(await page.evaluate((p) => window.__MOCK__.dump(p), prefix)); },
      doc: async (path) => { await f.mock(); return page.evaluate((p) => window.__MOCK__.dump(p).find(([k]) => k === p)?.[1] ?? null, path); },
      patch: async (key, src) => { await f.mock(); return page.evaluate(({ k, s }) => window.__MOCK__.patch(k, new Function('d', 'Ts', s)), { k: key, s: src }); },
      /** create or replace a document: `src` is a JS expression that may use Ts, e.g. put('products/old1', "({ name: 'Old', price: 100, createdAt: new Ts(Date.now()) })") */
      put: async (key, src) => { await f.mock(); return page.evaluate(({ k, s }) => window.__MOCK__.put(k, new Function('Ts', `return (${s});`)), { k: key, s: src }); },
      remove: async (key) => { await f.mock(); return page.evaluate((k) => window.__MOCK__.remove(k), key); },
      until: async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; },
    };
    try { await sc.run(f); } catch (e) { failures.push(`scenario threw: ${String(e && e.message || e).slice(0, Number(process.env.SV_ERR_LEN) || 300)}`); }
    // a screen must never show a translation KEY ("tkm.guest") instead of its words — it happens when a page uses a string that only another page registers
    try {
      const raw = await page.evaluate((src) => {
        const re = new RegExp(src);
        const seen = new Set();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) continue;
          if (n.parentElement && n.parentElement.closest('[translate="no"]')) continue;       // identifiers (action codes, field paths) are not translatable text
          const v = n.nodeValue.trim();
          if (v && re.test(v)) seen.add(v);
        }
        for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) {
          for (const a of ['aria-label', 'title', 'placeholder', 'alt']) { const v = (el.getAttribute(a) || '').trim(); if (v && re.test(v)) seen.add(v); }
        }
        return [...seen].slice(0, 5);
      }, RAW_KEY.source);
      if (raw.length) failures.push(`untranslated keys on screen: ${raw.join(', ')}`);
    } catch { /* the page is gone or navigating */ }
    await f.collect();
    if (!sc.denied) for (const d of denied) failures.push(`rules denied ${d.kind} ${d.key || ''} ${d.ops ? d.ops.join(' | ') : ''} ${d.error || ''}`.slice(0, 280));
    failures.push(...[...new Set(problems)]);
    await ctx.close();
    ran++;
    const ms = Date.now() - t0;
    if (failures.length) { failed++; console.log(`✗ ${sc.name.padEnd(30)} ${ms}ms`); for (const m of failures.slice(0, 8)) console.log(`    ${m}`); if (failures.length > 8) console.log(`    … ${failures.length - 8} more`); for (const w of warnings.slice(0, 3)) console.log(`    (console.warn) ${w}`); }
    else console.log(`✓ ${sc.name.padEnd(30)} ${ms}ms`);
  }
}
await close();
console.log(`\n${ran - failed}/${ran} scenarios passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
