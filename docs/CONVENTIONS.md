# Engineering handbook — read this first (≈10 min), then only the sections of the other docs you need

Shop Verse: a **static** Firebase-backed store (storefront `/`) + admin panel (`/admin/`). Vanilla ES modules, **no build step**, hosted on Vercel.
The Firestore Security Rules are the trust layer (there is no backend). Default language is Bengali, English is the alternate.

## 1. Where things are
```
index.html, admin/index.html      shells (one <main id="main"> / <div id="admin-root">)
css/ tokens base components layout store store-chrome  +  css/pages/<page>.css (page-specific, loaded with loadCss)
js/core/       dom ui i18n format validate errors icons router theme storage firebase print        (browser helpers, no business rules)
js/shared/     pure logic usable in Node tests: constants pricing id slug csv markdown search productModel orderModel orderBuilder orderFlow contentModel migration ops
js/data/       Firestore access for the browser: auth settings catalog cart wishlist orders ordersAdmin account support db write
js/store/      app.js routes.js pwa.js | pages/*.js | components/*.js | lib/*.js          (storefront)
js/admin/      app.js nav.js routes.js | pages/*.js | lib/*.js | data/*.js                (admin panel; hash routes /admin/#/orders)
tests/rules    rules interpreter + scenario tests   tests/unit  pure-logic tests   tools/ check-syntax check-imports run-tests api-index css-index
docs/          DATA_MODEL.md  API_INDEX.md (signatures)  CSS_INDEX.md (class names)  CONVENTIONS.md
```
Look things up instead of opening whole files: `node tools/api-index.mjs show ui.js dom.js` prints the usage header + exports of those modules;
`docs/CSS_INDEX.md` lists every existing class and token; `docs/DATA_MODEL.md` lists every collection, its shape and its access rules.

## 2. Hard rules
1. **Only `js/core/firebase.js` imports the Firebase SDK** (pinned 10.8.1). Everything else imports from it / from `js/data/*`.
2. **Never write HTML with string concatenation.** Use the `html` tagged template (escapes everything) and `render(el, safeHtml)` — the only innerHTML writer.
   `raw()` only for pre-sanitised strings (e.g. `renderMarkdown` output). URLs from data → `safeUrl()`. No inline `onclick=`; use `data-action="name"` + `bindActions(root, {name: (el, ev) => …})`.
   Lint: `node tools/check-syntax.mjs <path>` fails on innerHTML/eval/inline handlers/direct localStorage use.
3. **Prices, stock, coupons, shipping are never trusted from the browser**: the rules re-derive them. Orders are created only through `placeOrder`; status/payment/refund/stock changes only through the planners in `js/shared/orderFlow.js`.
4. **No composite indexes, no unconstrained list queries on guarded collections** — read "Query rules of thumb" in `docs/DATA_MODEL.md`. Sort/filter client-side.
5. **Staff writes**: build abstract ops (`{op:'set'|'update'|'delete', path, data, merge?}` with sentinels `TS`, `inc(n)`, `DEL` from `js/shared/ops.js`), include `auditOp(actor(), {...})` and, for catalog data, `catalogStampOp(Date.now())`, and commit with `commitAtomic(ops)` (≤ 18 ops) — or `commitChunked` for idempotent bulk jobs. Pure planners (return ops) live in `js/shared/*` and are unit/rules-tested; pages only call them.
6. **UI gating with `can('perm')`** (js/data/auth.js) is cosmetic; the rules enforce. Admin pages declare `meta.perm` in `js/admin/routes.js` (already done) and may hide buttons with `can()`.
7. **No fake data**: no hard-coded metrics, counters, testimonials, ratings or "sold N" claims. Empty state when there is nothing. Every button does something real or is not rendered.
8. **Honesty**: never claim payment is received before staff verify it; a customer-typed TrxID is only a claim. Never log or show secrets.
9. Bilingual UI: every user-visible string through `t('key')` with `registerBoth({ 'xx.key': ['English', 'বাংলা'] })` at the top of **your own module**, keys prefixed by your page (`shop.`, `pdp.`, `a.orders.`…). Call `t()` at render time. Bengali must read naturally (not transliterated English).
10. Do not edit files you do not own (your task lists them). Shared files (`js/core/*`, `js/data/*`, `js/shared/*`, `css/{tokens,base,components,layout,store}.css`, routes/nav files, rules) may get a *tiny, clearly-correct bug fix via Edit* — list every such edit in your report; anything bigger → describe it in the report.

## 3. Page contract
```js
// js/store/pages/xyz.js  or  js/admin/pages/xyz.js
export default {
  async mount(ctx) {            // ctx = { el, params, query, path, route, router, signal, cleanup(fn) }
    render(ctx.el, skeleton);   // show something immediately
    const data = await load();
    if (ctx.signal.aborted) return;                 // user navigated away while loading
    render(ctx.el, html`…`);
    ctx.cleanup(bindActions(ctx.el, { save: (el) => … }, { change: {…}, input: {…}, submit: { formName: (form) => … } }));
    // return a disposer, or register ctx.cleanup(fn) for listeners / onSnapshot unsubscribes / timers
  },
};
```
* Storefront: history routes (`router.navigate('/cart')`, links are plain `<a href="/cart">` — the router intercepts same-origin clicks); `router.setQuery({…})` updates the URL without re-mounting (filters, tabs, pagination); `setMeta({title, description, canonical, image, noindex, jsonLd})` per page; wrap content in `<div class="container page">`. Language changes re-mount the page (`router.reload`). URL helpers: `js/store/lib/links.js`. The cart/wishlist are local-first stores with `subscribe`.
* Admin: hash routes (`#/orders/SV-…`, links are `<a href="#/orders">`); wrap work in `safeMount(ctx, async () => {…})` and start with `if (!needs(ctx, 'perm')) return;` (all from `js/admin/lib/ui.js`); heading with `pageHead({title, sub, actions})`; page titles come from the route meta. Use `runAction(btn, async () => …, {ok: t('common.saved')})` for every save/destructive action (busy state + toast + friendly error) and `confirmDialog` before destructive ones.
* Page-specific CSS: create `css/pages/<name>.css` and `loadCss('/css/pages/<name>.css')` (from `js/core/ui.js`) at the top of `mount` — never edit the shared stylesheets for page-only rules. Use tokens (`var(--s-4)`, `var(--surface)`, `var(--border)`…) and existing classes (`docs/CSS_INDEX.md`); no hard-coded colours.

## 4. Idioms
* **Forms**: `fieldHtml({name, label, type, value, required, hint, options, …})` renders label + control + `#err-<name>` slot; read with `readForm(form)`; validate with `validateForm(values, {name: [required(), minLen(2)], …})` and `showFormErrors(form, errors)`; submit with `bindActions(el, {}, {submit: {formName: fn}})` and `<form data-form="formName" novalidate>`. Disable the submit button while saving (`withBusy` / `runAction`).
* **Modals/drawers/menus/toasts**: `openModal({title, body, footer, size})` → `{el, bodyEl, close, …}`; `confirmDialog`, `promptDialog`, `alertDialog`; `toast(msg)`, `toastError(msg)`; `explainError(e)` turns SDK/rules errors into a friendly localized sentence — show it, never raw `e.message`.
* **Loading/empty/error**: `spinnerBlock()`, `skeletonCards(n)`, `skeletonRows(n)`, `emptyState({icon, title, text, action})`, `errorState({text})` with a retry that reloads data.
* **Formatting**: `money(n)` (৳, lakh grouping), `num`, `pct`, `fmtDate/fmtDateTime/fmtTime/relTime` (Asia/Dhaka), `compact`, `maskPhone/maskEmail`. Never `toLocaleString` directly (digits follow the Bangla-digit setting).
* **Icons**: `icon('cart', {size, cls, title})` (names in `js/core/icons.js`; unknown name → box).
* **Responsive**: design mobile-first for 360 px Android phones; tap targets ≥ 44 px; no horizontal page scroll; tables inside `.table-wrap`; light + dark both work (tokens only); honour `prefers-reduced-motion` (no autoplay, no big transitions).
* **Design brief** (the owner's taste): premium, minimalist, consistent tokens, stable layouts that do not jump, generous spacing, one accent colour. **No neon, glow, gradients, glassmorphism, excessive animation, emoji as icons.** Icons are the inline SVG set. Images always have `width`/`height` and `alt`; `loading="lazy"` below the fold.
* **Accessibility**: real `<button>`/`<a>`; labels on all inputs; `aria-live` via `announce(msg)` for async results; focus moves into dialogs and back; visible focus ring (already in base.css); `aria-pressed/aria-expanded/aria-current` where relevant.
* **Performance**: don't re-render the whole page on every keystroke (update only the results region); debounce search (`debounce`); keep lists paginated (24–50 rows).

## 5. Verification (run before you report)
* `node --check <file>` is implied by `node tools/check-syntax.mjs <your folders>`; `node tools/check-imports.mjs <folder>` (run once per folder) proves every relative import resolves and every imported name is exported — it catches most typos in a no-build project.
* Pure logic (models, planners, query-state, aggregations) → `tests/unit/<area>.test.mjs` (node:test; `node tools/run-tests.mjs tests/unit`).
* Every planner that emits Firestore ops → a rules test in `tests/rules/<area>.rules.test.mjs`, using the harness:
```js
import { MemDb } from './rules-engine.mjs';
import { baseDb, commitBoth, failedOps, NOW } from './harness.mjs';   // baseDb(): staff docs sa/sadm/pm/om/im/cs/rp, users u1/u2, zones, products, inventory, coupons
const db = baseDb();                                                  // staff uids: 'sa' super admin, 'om' order manager, 'pm' product manager …
const plan = planX({ …, actor: { uid: 'pm', email: 'pm@x.test', role: 'product_manager' }, nowMs: NOW });
const r = commitBoth(db, { uid: 'pm' }, plan.ops);                    // evaluates ONE atomic batch with the strict and tolerant engines
assert.equal(r.strict.allowed, true, failedOps(r.strict).join(' | '));
// and prove the negative: the same ops as another role / a customer must be denied
```
  Whole suite: `node tools/run-tests.mjs tests/rules` must stay green (all existing + yours).
* You cannot run the app against real Firebase here (network blocked). Say exactly what you verified (commands + results) and what you could not (e.g. "not exercised in a browser"). Never claim a test ran that did not.

## 6. Working efficiently (the token budget is tight)
* Don't read whole files "to get a feel". Use the API index / `grep -n` / `sed -n 'a,bp'`. Read `firestore.rules` only for the collections you touch (`grep -n "match /orders" -A 60`).
* Write each file in ONE Write call (complete, no placeholders), run all checks in ONE Bash call, don't re-read files you just wrote, don't print large outputs (`| tail -20`).
* Prefer compact, readable code and shared helpers over cleverness. Ship the must-haves of your brief first; nice-to-haves only if cheap and clearly marked in your report if skipped.
* Final report ≤ 30 lines: files created (one line each), exports others may rely on, deviations from the brief, tiny shared-file edits, rules gaps, exact verification results, what is unverified.
