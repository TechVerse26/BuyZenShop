/*
 * Admin "Audit log", clicked through in Chromium (see tests/e2e/flows.mjs).
 *
 * Seed (relative to now), newest first — the periods hold:  24 h → 1–4 · 7 d → 1–6 · 30 d → 1–7 · everything → 1–8
 *   1  −10 min  boss@shop.test  store_admin    order.status     order SV-261025-AB12CD   confirmed → shipped
 *   2  −1 h     system          (no e-mail)    migration.run    system                   no before / after
 *   3  −2 h     root@shop.test  super_admin    settings.update  settings                 shipping.insideFee 70 → 80 (name, outsideFee unchanged)
 *   4  −5 h     pm@shop.test    product_manager product.create  product p9               created: name, price, status, tags
 *   5  −26 h    om@shop.test    order_manager  order.status     order RPT-C              pending → cancelled
 *   6  −3 d     boss@shop.test  store_admin    coupon.delete    coupon WELCOME10         deleted: code, value
 *   7  −10 d    root@shop.test  super_admin    staff.create     staff pm                 created: email, role, active
 *   8  −40 d    boss@shop.test  store_admin    report.export    report orders            created: kind, count
 * Staff: sa Super Admin · sadm Store Admin (both hold audit.read) · pm / om / im / cs / rp may not open the page.
 * (The browser runs with a Bengali locale: assert on the page structure and the database, not on words; digits are compared as Latin digits.)
 */
import { ROLES } from '../../../js/shared/constants.js';
import { timeKey } from '../../../js/shared/reportFlow.js';
import { text } from './helpers.mjs';

const AUDIT_PAGE = '/admin/#/audit';
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const latin = (s) => String(s ?? '').replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
const digits = (s) => latin(s).replace(/\D/g, '');
const wait = (page, fn, arg = null, ms = 12000) => page.waitForFunction(fn, arg, { timeout: ms });
const rowsReady = (page, n) => wait(page, (k) => document.querySelectorAll('#aud-table tbody tr').length === k, n, 15000);
const summaries = (page) => page.$$eval('#aud-table tbody tr', (trs) => trs.map((tr) => tr.querySelector('.aud-what span').textContent.trim()));
/** the numbers of the count line, ascending: "2 of the 6 loaded" in English, "loaded 6 … 2" in Bengali */
const counts = async (page) => (latin(await text(page, '#aud-count')).match(/\d+/g) || []).map(Number).sort((a, b) => a - b);
/** waits for exactly these rows (the row count alone is already true for the previous filter), then returns what is there */
const showing = async (page, expected) => {
  try { await wait(page, (s) => [...document.querySelectorAll('#aud-table tbody tr')].map((tr) => tr.querySelector('.aud-what span').textContent.trim()).join('\n') === s, expected.join('\n'), 8000); } catch { /* the caller's comparison reports it */ }
  return summaries(page);
};
const optionValues = (page, sel) => page.$$eval(`${sel} option`, (os) => os.map((o) => o.value));
const shot = async (f, name, { full = true } = {}) => { if (process.env.SV_SHOTS) await f.page.waitForTimeout(400).then(() => f.page.screenshot({ path: `${process.env.SV_SHOTS}/${name}.${f.page.viewportSize().width}.png`, fullPage: full })); };

const NOW = Date.now();
const ENTRIES = [
  { id: 'A1', ago: 10 * MIN, uid: 'sadm', email: 'boss@shop.test', role: 'store_admin', action: 'order.status', entity: 'order', entityId: 'SV-261025-AB12CD', summary: 'Order SV-261025-AB12CD: confirmed → shipped', before: { status: 'confirmed' }, after: { status: 'shipped' } },
  { id: 'A2', ago: HOUR, uid: 'sys', email: '', role: '', action: 'migration.run', entity: 'system', entityId: '', summary: 'Migration finished', before: null, after: null },
  { id: 'A3', ago: 2 * HOUR, uid: 'sa', email: 'root@shop.test', role: 'super_admin', action: 'settings.update', entity: 'settings', entityId: 'public', summary: 'Settings updated: shipping', before: { name: 'Shop', shipping: { insideFee: 70, outsideFee: 120 } }, after: { name: 'Shop', shipping: { insideFee: 80, outsideFee: 120 } } },
  { id: 'A4', ago: 5 * HOUR, uid: 'pm', email: 'pm@shop.test', role: 'product_manager', action: 'product.create', entity: 'product', entityId: 'p9', summary: 'Product created: Straw Hat', before: null, after: { name: 'Straw Hat', price: 450, status: 'draft', tags: ['hat', 'summer'] } },
  { id: 'A5', ago: 26 * HOUR, uid: 'om', email: 'om@shop.test', role: 'order_manager', action: 'order.status', entity: 'order', entityId: 'RPT-C', summary: 'Order RPT-C: pending → cancelled', before: { status: 'pending' }, after: { status: 'cancelled' } },
  { id: 'A6', ago: 3 * DAY, uid: 'sadm', email: 'boss@shop.test', role: 'store_admin', action: 'coupon.delete', entity: 'coupon', entityId: 'WELCOME10', summary: 'Coupon deleted: WELCOME10', before: { code: 'WELCOME10', value: 10 }, after: null },
  { id: 'A7', ago: 10 * DAY, uid: 'sa', email: 'root@shop.test', role: 'super_admin', action: 'staff.create', entity: 'staff', entityId: 'pm', summary: 'Staff added: pm@shop.test', before: null, after: { email: 'pm@shop.test', role: 'product_manager', active: true } },
  { id: 'A8', ago: 40 * DAY, uid: 'sadm', email: 'boss@shop.test', role: 'store_admin', action: 'report.export', entity: 'report', entityId: 'orders', summary: 'Exported orders: 5 rows', before: null, after: { kind: 'orders', count: 5 } },
];
const put = (f, e) => f.put(`auditLogs/${e.id}`, `Object.assign(${JSON.stringify({ actorUid: e.uid, actorEmail: e.email, actorRole: e.role, action: e.action, entity: e.entity, entityId: e.entityId, summary: e.summary, before: e.before, after: e.after })}, { createdAt: new Ts(${NOW - e.ago}) })`);
const seed = async (f, list = ENTRIES) => { for (const e of list) await put(f, e); };
/** n bulk entries, one per minute, the newest being "Bulk entry <n-1>", all within the last two days */
const bulk = (f, n) => f.put('meta/bulk', `(() => { const m = window.__MOCK__; for (let i = 0; i < ${n}; i++) m.db.set('auditLogs/BULK-' + i, { actorUid: 'sadm', actorEmail: 'boss@shop.test', actorRole: 'store_admin', action: 'bulk.entry', entity: 'order', entityId: 'B' + i, summary: 'Bulk entry ' + i, before: null, after: null, createdAt: new Ts(${NOW} - 2 * 86400000 + i * 60000) }); return { note: 'bulk' }; })()`);
const openDetails = async (page, i) => { await page.locator('#aud-table tbody tr').nth(i).locator('[data-action="detail"]').click(); await page.waitForSelector('[role="dialog"] .aud-diff, [role="dialog"] [data-kind]', { timeout: 8000 }); };
const closeDialog = async (page) => { await page.keyboard.press('Escape'); await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 }); };
const diffRows = (page) => page.$$eval('[role="dialog"] .aud-diff tbody tr', (trs) => trs.map((tr) => [tr.querySelector('code').textContent.trim(), tr.children[1].textContent.trim(), tr.children[2].textContent.trim(), tr.querySelector('.badge') ? tr.querySelector('.badge').textContent.trim() : '']));

export const adminAuditFlows = [
  {
    name: 'admin audit: newest first with who, what and about; search, area, person and period narrow it; the entry shows what changed', as: 'sa',
    async run(f) {
      const { page } = f;
      await seed(f);
      await f.goto(AUDIT_PAGE);
      await rowsReady(page, 6);
      f.ok((await page.locator('a[href$="#/audit"]').count()) > 0, 'the menu offers the audit log');
      f.eq(await page.inputValue('#f-period'), '7d', 'the default period is 7 days');
      f.eq(await summaries(page), ENTRIES.slice(0, 6).map((e) => e.summary), 'newest first, the last 7 days');
      f.eq(await counts(page), [6, 6], 'six of the six loaded entries');

      const first = page.locator('#aud-table tbody tr').first();
      f.eq(await first.locator('.aud-mail').textContent(), 'boss@shop.test', 'who: the e-mail');
      f.eq((await first.locator('.badge').textContent()).trim(), ROLES.store_admin.bn, 'who: the role');
      f.eq((await first.locator('.aud-code').textContent()).trim(), 'order.status', 'the action code');
      f.ok((await first.locator('.aud-about a').getAttribute('href')).endsWith('#/orders/SV-261025-AB12CD'), 'about: the order opens');
      f.eq(await page.locator('#aud-table tbody tr').nth(1).locator('.aud-about a').count(), 0, 'an area without a page has no link');
      f.eq(await page.locator('#aud-table tbody tr').nth(1).locator('.aud-mail').textContent(), 'sys', 'no e-mail recorded: the uid is shown');

      f.eq(await optionValues(page, '#f-entity'), ['', 'order', 'coupon', 'product', 'settings', 'system'], 'areas present, most frequent first');
      f.eq(await optionValues(page, '#f-actor'), ['', 'sadm', 'om', 'pm', 'sa', 'sys'], 'people present, most frequent first (ties by e-mail)');
      await page.selectOption('#f-entity', 'order');
      f.eq(await showing(page, [ENTRIES[0].summary, ENTRIES[4].summary]), [ENTRIES[0].summary, ENTRIES[4].summary], 'area: orders');
      f.eq(await counts(page), [2, 6], 'two of the six');
      await page.selectOption('#f-actor', 'sadm');
      f.eq(await showing(page, [ENTRIES[0].summary]), [ENTRIES[0].summary], 'area and person together');
      await page.click('[data-action="clear"]');
      await rowsReady(page, 6);
      f.eq([await page.inputValue('#f-entity'), await page.inputValue('#f-actor'), await page.inputValue('#q')], ['', '', ''], 'clearing resets every filter');
      await page.fill('#q', 'CANCELLED');
      f.eq(await showing(page, [ENTRIES[4].summary]), [ENTRIES[4].summary], 'search ignores case and finds words of the summary');
      await page.fill('#q', 'p9');
      f.eq(await showing(page, [ENTRIES[3].summary]), [ENTRIES[3].summary], 'search finds the id');
      await page.fill('#q', 'zzzz');
      await wait(page, () => !document.querySelector('#aud-table') && !!document.querySelector('#aud-results .empty'));
      f.eq(await page.locator('#aud-results .empty').count(), 1, 'nothing matches: an empty state, not an empty table');
      await page.click('[data-action="clear"]');
      await rowsReady(page, 6);

      await page.selectOption('#f-period', '24h');
      await rowsReady(page, 4);
      f.eq(await summaries(page), ENTRIES.slice(0, 4).map((e) => e.summary), 'the last 24 hours');
      await page.selectOption('#f-period', '30d');
      await rowsReady(page, 7);
      f.ok((await page.locator('#aud-table tbody tr').nth(6).locator('.aud-about a').getAttribute('href')).endsWith('#/staff'), 'Super Admin may open the staff page from the entry');
      await page.selectOption('#f-period', 'all');
      await rowsReady(page, 8);
      f.eq(await counts(page), [8, 8], 'everything: eight entries');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await rowsReady(page, 8);
      f.eq(await page.inputValue('#f-period'), 'all', 'the chosen period is remembered');
      await page.selectOption('#f-period', '7d');
      await rowsReady(page, 6);

      await shot(f, 'admin-audit');
      // 1: one field changed
      await openDetails(page, 0);
      f.eq(await page.locator('[role="dialog"] [data-kind]').getAttribute('data-kind'), 'changed', 'a status change');
      f.eq(await diffRows(page), [['status', 'confirmed', 'shipped', await page.locator('[role="dialog"] .aud-diff .badge').first().textContent().then((s) => s.trim())]], 'status: confirmed → shipped');
      const dd = await page.$$eval('[role="dialog"] .kv dd', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      f.ok(dd[0].startsWith(timeKey(NOW - ENTRIES[0].ago)), `the time is shown in Bangladesh time (${dd[0]})`);
      f.ok(dd[1].includes('boss@shop.test') && dd[1].includes('sadm'), 'who: e-mail and uid');
      f.eq(dd[2], 'order.status', 'the action');
      f.ok((await page.locator('[role="dialog"] .aud-open a').getAttribute('href')).endsWith('#/orders/SV-261025-AB12CD'), 'a link to the order');
      await page.click('[role="dialog"] .aud-raw summary');
      const raw = JSON.parse(await page.locator('[role="dialog"] .aud-raw pre').textContent());
      f.eq(raw, { before: { status: 'confirmed' }, after: { status: 'shipped' } }, 'the raw snapshots');
      await shot(f, 'admin-audit-details', { full: false });
      await closeDialog(page);
      // 2: no before/after
      await openDetails(page, 1);
      f.eq([await page.locator('[role="dialog"] [data-kind]').getAttribute('data-kind'), await page.locator('[role="dialog"] .aud-diff').count(), await page.locator('[role="dialog"] .aud-open').count()], ['none', 0, 0], 'nothing recorded: no table, no link');
      await closeDialog(page);
      // 3: nested field, only the difference
      await openDetails(page, 2);
      f.eq((await diffRows(page)).map((r) => r.slice(0, 3)), [['shipping.insideFee', '70', '80']], 'a nested field is named by its path; unchanged fields are left out');
      await closeDialog(page);
      // 4: created
      await openDetails(page, 3);
      f.eq(await page.locator('[role="dialog"] [data-kind]').getAttribute('data-kind'), 'created', 'a created product');
      f.eq((await diffRows(page)).map((r) => r.slice(0, 3)), [['name', '—', 'Straw Hat'], ['price', '—', '450'], ['status', '—', 'draft'], ['tags', '—', '["hat","summer"]']], 'every set value, a list as JSON');
      await closeDialog(page);
      // 6: deleted
      await page.selectOption('#f-entity', 'coupon');
      await rowsReady(page, 1);
      await openDetails(page, 0);
      f.eq(await page.locator('[role="dialog"] [data-kind]').getAttribute('data-kind'), 'deleted', 'a deleted coupon');
      f.eq((await diffRows(page)).map((r) => r.slice(0, 3)), [['code', 'WELCOME10', '—'], ['value', '10', '—']], 'every removed value');
      await closeDialog(page);

      // the link in the dialog leaves the log
      await page.click('[data-action="clear"]');
      await rowsReady(page, 6);
      await openDetails(page, 0);
      await page.click('[role="dialog"] .aud-open a');
      await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });
      await wait(page, () => location.hash === '#/orders/SV-261025-AB12CD');
    },
  },
  {
    name: 'admin audit: Store Admin reads the log, but gets no link to a page their role cannot open', as: 'sadm',
    async run(f) {
      const { page } = f;
      await seed(f);
      await f.goto(AUDIT_PAGE);
      await rowsReady(page, 6);
      await page.selectOption('#f-period', '30d');
      await rowsReady(page, 7);
      const staffRow = page.locator('#aud-table tbody tr').nth(6);
      f.eq(await staffRow.locator('.aud-code').textContent(), 'staff.create', 'the staff entry is listed');
      f.eq(await staffRow.locator('.aud-about a').count(), 0, 'without a link: Store Admin cannot manage staff');
      f.eq(await page.locator('#aud-table tbody tr').first().locator('.aud-about a').count(), 1, 'but orders open');
      await openDetails(page, 6);
      f.eq(await page.locator('[role="dialog"] .aud-open').count(), 0, 'the dialog has no link either');
      await closeDialog(page);
    },
  },
  ...['pm', 'om', 'im', 'cs', 'rp'].map((as) => ({
    name: `admin audit: ${as} may not open the audit log`, as,
    async run(f) {
      await f.goto(AUDIT_PAGE);
      await f.page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await f.page.locator('a[href$="#/audit"]').count(), 0, 'and the menu does not offer it');
    },
  })),
  {
    name: 'admin audit: an empty log says so; links with ?q= and ?entity= open filtered', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(AUDIT_PAGE);
      await wait(page, () => !!document.querySelector('#aud-results .empty'));
      f.eq([await page.locator('#aud-table').count(), (await text(page, '#aud-count')).length], [0, 0], 'no table, no count line');
      await page.selectOption('#f-period', 'all');
      await wait(page, () => !!document.querySelector('#aud-results .empty'));
      await shot(f, 'admin-audit-empty');

      await seed(f);
      await f.goto(`${AUDIT_PAGE}?q=SV-261025`);
      await rowsReady(page, 1);
      f.eq([await page.inputValue('#q'), await summaries(page)], ['SV-261025', [ENTRIES[0].summary]], '?q= fills the search and filters');
      await f.goto(`${AUDIT_PAGE}?entity=order`);
      await rowsReady(page, 2);
      f.eq(await page.inputValue('#f-entity'), 'order', '?entity= selects the area');
    },
  },
  {
    name: 'admin audit: 100 entries at a time; older ones load on request; the page stops at 1 000 and says so', as: 'sa',
    async run(f) {
      const { page } = f;
      await bulk(f, 1050);
      await f.goto(AUDIT_PAGE);
      await rowsReady(page, 50);
      f.eq(await counts(page), [100, 100], 'the first 100 are loaded');
      f.eq((await summaries(page))[0], 'Bulk entry 1049', 'newest first');
      f.eq(await page.locator('#aud-results nav.pagination').count(), 1, 'the table pages through them 50 at a time');
      f.eq(await page.locator('[data-action="more"]').count(), 1, 'and older entries can be loaded');
      await page.fill('#q', 'Bulk entry 9');
      await wait(page, () => !!document.querySelector('#aud-results .alert-info'));
      f.eq(await page.locator('#aud-results .alert-info').count(), 1, 'with a filter set the page says it searches the loaded entries only');
      await page.click('[data-action="clear"]');
      await rowsReady(page, 50);

      await page.click('[data-action="more"]');
      await wait(page, () => (document.querySelector('#aud-count') || { textContent: '' }).textContent.replace(/[০-৯]/g, (c) => '০১২৩৪৫৬৭৮৯'.indexOf(c)).includes('200'));
      await page.click('[data-action="page"][data-page="4"]');
      await rowsReady(page, 50);
      const last = (await summaries(page)).pop();
      f.eq(last, 'Bulk entry 850', 'the 200th entry continues exactly where the first 100 ended');
      for (let loaded = 300; loaded <= 1000; loaded += 100) {
        await page.click('[data-action="more"]');
        await wait(page, (n) => (document.querySelector('#aud-count').textContent.replace(/[০-৯]/g, (c) => '০১২৩৪৫৬৭৮৯'.indexOf(c)).replace(/\D/g, '')) === String(n) + String(n), loaded, 15000);
      }
      f.eq(await page.locator('[data-action="more"]').count(), 0, 'no more button at 1 000 loaded');
      f.eq(await page.locator('#aud-results .alert-info').count(), 1, 'a note says the newest 1 000 are shown');
      await shot(f, 'admin-audit-capped');
    },
  },
];
