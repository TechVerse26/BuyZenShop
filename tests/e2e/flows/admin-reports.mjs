/*
 * Admin "Reports", clicked through in Chromium (see tests/e2e/flows.mjs).
 *
 * Seed: the two orders of the shared fixtures are removed and eight orders with KNOWN numbers are put in their place, placed relative to today (Bangladesh days):
 *   this 7 days   A today 10:10 u1 delivered bKash paid  T-shirt ×2 + Watch   total 5 970 (shipping 70)
 *                 B −1 d  15:10 u2 confirmed Nagad paid  Wallet, coupon WELCOME10 (−150)  total 1 480
 *                 C −2 d  20:10 u1 shipped   COD unpaid  T-shirt              total 1 270
 *                 D −3 d  09:10 u2 cancelled COD unpaid  Phone Case ×2         total 1 030   (not a sale)
 *                 E −4 d  11:10 u3 pending   COD unpaid  Cap                   total   670   (not a sale yet)
 *   the 7 days before   P1 −8 d delivered bKash paid T-shirt 1 270 · P2 −10 d delivered COD paid Watch 3 630 · P3 −12 d cancelled Cap 670
 *   → sales 8 720 (3 orders) · orders 5 · units 5 · received 7 450 · customers 3 · cancel rate 20 % · discounts 150
 *     before: sales 4 900 · orders 3 · customers 2 · cancel rate 33.3 %
 * Staff: sa Super Admin · sadm Store Admin (reads customers) · rp Reporting (reads reports and orders, not customers) · pm / om / im / cs may not open it.
 * (The browser runs with a Bengali locale: assert on the page structure and the database, not on words; digits are compared as Latin digits.)
 */
import fs from 'node:fs';
import { ORDER_STATUS, ORDER_STATUS_IDS, PAYMENT_METHODS, PAYMENT_STATUS } from '../../../js/shared/constants.js';
import { text } from './helpers.mjs';

const REPORTS = '/admin/#/reports';
const DAY = 86400000;
const OFF = 6 * 3600000;                                                       // Bangladesh is UTC+6 all year
const todayStart = () => Math.floor((Date.now() + OFF) / DAY) * DAY - OFF;
/** Bangladesh date "YYYY-MM-DD" of the day `ago` days before today */
const keyOf = (ago) => new Date(todayStart() - ago * DAY + OFF).toISOString().slice(0, 10);
const latin = (s) => String(s ?? '').replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
const digits = (s) => latin(s).replace(/\D/g, '');
const wait = (page, fn, arg = null, ms = 12000) => page.waitForFunction(fn, arg, { timeout: ms });

/** the body shows a report, the empty state or an error — not the spinner */
const loaded = (page) => wait(page, () => { const b = document.querySelector('#rpt-body'); return !!b && !b.querySelector('.spinner') && b.children.length > 0; });
/** waits until the "Orders" tile shows exactly n (a plain "loaded" is already true for the previous period) */
const ordersAre = (page, n) => wait(page, (k) => {
  const el = document.querySelectorAll('#rpt-kpis .stat .stat-value')[1];
  return !!el && el.textContent.replace(/[০-৯]/g, (c) => '০১২৩৪৫৬৭৮৯'.indexOf(c)).replace(/\D/g, '') === String(k);
}, n, 20000);
const pressed = (page) => page.$$eval('[data-action="range"]', (bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.range));
const kpis = (page) => page.$$eval('#rpt-kpis .stat', (els) => els.map((e) => {
  const d = e.querySelector('.rpt-delta');
  const shown = d ? d.querySelector('span[aria-hidden="true"]') : null;
  return {
    value: e.querySelector('.stat-value').textContent.trim(),
    sub: ((e.querySelector('.rpt-sub') || {}).textContent || '').trim(),
    dir: d ? d.dataset.dir : '',
    good: d ? d.classList.contains('is-good') : null,
    shown: shown ? shown.textContent.trim() : '',
  };
}));
const ranks = (page, sel) => page.$$eval(`${sel} .rank li`, (lis) => lis.map((li) => ({
  label: li.querySelector('.rank-label').textContent.trim(),
  value: li.querySelector('.rank-val').textContent.trim(),
  sub: ((li.querySelector('.rank-sub') || {}).textContent || '').trim(),
})));
const rowsOf = (page, sel) => page.$$eval(sel, (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent.trim())));
const cols = (page, sel) => page.$$eval(`${sel} .chart-col`, (cs) => cs.map((c) => ({ l: c.dataset.l, v: c.dataset.v })));
const csvRows = (csv) => csv.replace(/^﻿/, '').trim().split(/\r?\n/);
const exports = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'report.export').sort((a, b) => String(a.entityId).localeCompare(String(b.entityId)));
/** a full-page screenshot with SV_SHOTS=<dir> (no-op otherwise) */
const shot = async (f, name) => { if (process.env.SV_SHOTS) await f.page.waitForTimeout(400).then(() => f.page.screenshot({ path: `${process.env.SV_SHOTS}/${name}.${f.page.viewportSize().width}.png`, fullPage: true })); };

const CATALOG = { p1: ['Classic Cotton T-Shirt', 'c1', 1200], p2: ['Leather Wallet', 'c2', 1500], p4: ['Phone Case', 'c2', 450], p5: ['Sports Watch', 'c3', 3500], p6: ['Backorder Cap', 'c1', 600] };
const PEOPLE = { u1: ['Rahim', '01711111111'], u2: ['Karim', '01822222222'], u3: ['Mina', '01933333333'] };
function orderExpr({ id, uid, ago, hour, status, method, pay, lines, discount = 0, coupon = '', shipping, district }) {
  const items = {}; const itemOrder = []; let subtotal = 0;
  for (const [pid, qty] of lines) {
    const [name, categoryId, unit] = CATALOG[pid];
    items[pid] = { productId: pid, variantId: null, sku: pid.toUpperCase(), name, variantLabel: '', unitPrice: unit, regularPrice: unit, qty, lineTotal: qty * unit, image: '', categoryId };
    itemOrder.push(pid); subtotal += qty * unit;
  }
  const total = subtotal - discount + shipping;
  const [name, phone] = PEOPLE[uid];
  const at = todayStart() - ago * DAY + hour * 3600000 + 600000;
  const doc = {
    schemaVersion: 2, orderNumber: id, userId: uid, customer: { name, phone, email: '' },
    address: { name, phone, district, upazila: '', area: '', postalCode: '', line1: 'House 1, Road 2, Test Area', notes: '' },
    zoneId: district === 'Sirajganj' ? 'inside-sirajganj' : 'outside-sirajganj', zoneName: district === 'Sirajganj' ? 'Inside Sirajganj' : 'Outside Sirajganj',
    items, itemOrder, totals: { subtotal, eligibleSubtotal: 0, discount, shipping, tax: 0, total }, couponCode: coupon,
    payment: { method, status: pay, trxId: '', senderNumber: '', amountDue: total }, status, notes: { customer: '' },
  };
  return `Object.assign(${JSON.stringify(doc)}, { createdAt: new Ts(${at}), updatedAt: new Ts(${at}) })`;
}
const ORDERS = [
  { id: 'RPT-A', uid: 'u1', ago: 0, hour: 10, status: 'delivered', method: 'bkash', pay: 'paid', lines: [['p1', 2], ['p5', 1]], shipping: 70, district: 'Sirajganj' },
  { id: 'RPT-B', uid: 'u2', ago: 1, hour: 15, status: 'confirmed', method: 'nagad', pay: 'paid', lines: [['p2', 1]], discount: 150, coupon: 'WELCOME10', shipping: 130, district: 'Dhaka' },
  { id: 'RPT-C', uid: 'u1', ago: 2, hour: 20, status: 'shipped', method: 'cod', pay: 'unpaid', lines: [['p1', 1]], shipping: 70, district: 'Sirajganj' },
  { id: 'RPT-D', uid: 'u2', ago: 3, hour: 9, status: 'cancelled', method: 'cod', pay: 'unpaid', lines: [['p4', 2]], shipping: 130, district: 'Dhaka' },
  { id: 'RPT-E', uid: 'u3', ago: 4, hour: 11, status: 'pending', method: 'cod', pay: 'unpaid', lines: [['p6', 1]], shipping: 70, district: 'Sirajganj' },
  { id: 'RPT-P1', uid: 'u1', ago: 8, hour: 12, status: 'delivered', method: 'bkash', pay: 'paid', lines: [['p1', 1]], shipping: 70, district: 'Sirajganj' },
  { id: 'RPT-P2', uid: 'u2', ago: 10, hour: 14, status: 'delivered', method: 'cod', pay: 'paid', lines: [['p5', 1]], shipping: 130, district: 'Dhaka' },
  { id: 'RPT-P3', uid: 'u1', ago: 12, hour: 16, status: 'cancelled', method: 'cod', pay: 'unpaid', lines: [['p6', 1]], shipping: 70, district: 'Sirajganj' },
];
/** removes the two orders of the shared fixtures (their age depends on the day the suite runs) and puts the given orders in */
const seed = async (f, list = ORDERS) => {
  for (const id of ['SV-261025-AB12CD', 'SV-261026-EF34GH']) await f.remove(`orders/${id}`);
  for (const o of list) await f.put(`orders/${o.id}`, orderExpr(o));
};
/** opens the export menu, picks entry `i` (0 orders · 1 days · 2 products) and returns the downloaded file */
const download = async (page, i) => {
  await page.click('#rpt-export');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('[role="menuitem"]').nth(i).click()]);
  return { name: dl.suggestedFilename(), csv: fs.readFileSync(await dl.path(), 'utf8') };
};
const openReport = async (f, preset = null, orders = null) => {
  const { page } = f;
  await f.goto(REPORTS);
  await loaded(page);
  if (preset) { await page.click(`[data-action="range"][data-range="${preset}"]`); if (orders !== null) await ordersAre(page, orders); else await loaded(page); }
};

export const adminReportsFlows = [
  {
    name: 'admin reports: every number comes from the orders, is compared with the period before, and only real sales count', as: 'sadm',
    async run(f) {
      const { page } = f;
      await seed(f);
      await f.goto(REPORTS);
      await loaded(page);
      f.ok((await page.locator('a[href$="#/reports"]').count()) > 0, 'the menu offers Reports');
      f.eq(await pressed(page), ['30d'], 'the default period is 30 days');
      let k = await kpis(page);
      f.eq([Number(digits(k[0].value)), Number(digits(k[1].value))], [13620, 8], '30 days hold all eight orders (sales 13 620)');
      f.eq(k[0].dir, 'none', 'the 30 days before hold nothing to compare with');

      await page.click('[data-action="range"][data-range="7d"]');
      await ordersAre(page, 5);
      f.eq(await pressed(page), ['7d'], 'the chosen chip is the pressed one');
      k = await kpis(page);
      f.eq(k.length, 8, 'eight tiles');
      const v = k.map((x) => Number(digits(x.value)));
      f.eq([v[0], v[1], v[3], v[4], v[5], v[6], v[7]], [8720, 5, 5, 7450, 3, 20, 150], 'sales · orders · units · received · customers · cancel rate · discounts');
      f.ok(Math.abs(v[2] - 2907) <= 1, `the average order is sales / counted orders (${v[2]})`);
      f.eq(k.map((x) => x.dir), ['up', 'up', 'up', 'up', 'up', 'up', 'down', ''], 'every tile is compared with the 7 days before (the cancel rate fell; discounts carry no comparison)');
      f.eq(k.map((x) => x.good), [true, true, true, true, true, true, true, null], 'rising sales and a falling cancel rate are both good');
      f.ok(/^78/.test(digits(k[0].shown)), `sales: +78 % (${k[0].shown})`);
      f.eq(digits(k[1].shown), '667', `orders: +66.7 % (${k[1].shown})`);
      f.eq(digits(k[5].shown), '50', `customers: +50 % (${k[5].shown})`);
      f.eq(digits(k[6].shown), '133', `cancel rate: −13.3 points (${k[6].shown})`);
      f.eq([digits(k[0].sub), digits(k[6].sub)], ['3', '1'], 'sales say how many orders they come from, the cancel rate how many were cancelled');
      const period = await text(page, '#rpt-period');
      f.ok(period.includes('·') && period.length > 12, `the page names both periods (${period})`);

      const present = ORDER_STATUS_IDS.filter((id) => ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'].includes(id));
      const status = await ranks(page, '#rpt-status');
      f.eq(status.map((r) => r.label), present.map((id) => ORDER_STATUS[id].bn), 'statuses in life-cycle order');
      f.eq(status.map((r) => digits(r.value)), present.map(() => '1'), 'one order each');
      f.eq(status.filter((r) => r.sub).length, 3, 'only counted orders show sales');

      const pay = await rowsOf(page, '#rpt-pay .rpt-table tbody tr');
      f.eq(pay.map((r) => [r[0], digits(r[1]), digits(r[2]), digits(r[3])]), [
        [PAYMENT_METHODS.cod.bn, '3', '1270', '0'], [PAYMENT_METHODS.bkash.bn, '1', '5970', '5970'], [PAYMENT_METHODS.nagad.bn, '1', '1480', '1480'],
      ], 'orders, sales and received money per payment method');
      const states = await page.$$eval('#rpt-pay .rpt-states li', (lis) => lis.map((li) => [li.children[0].textContent.trim(), li.children[1].textContent.trim()]));
      f.eq(states.map((s) => [s[0], digits(s[1])]), [[PAYMENT_STATUS.unpaid.bn, '2'], [PAYMENT_STATUS.paid.bn, '2']], 'payment states leave the cancelled order out');

      let prod = await ranks(page, '#rpt-products');
      f.eq(prod.map((r) => r.label), ['Classic Cotton T-Shirt', 'Sports Watch', 'Leather Wallet'], 'top products by sales (a cancelled and a pending order sell nothing)');
      f.eq(prod.map((r) => digits(r.value)), ['3600', '3500', '1500'], 'with their sales');
      f.eq(prod.map((r) => digits(r.sub)), ['3', '1', '1'], 'and their units');
      await page.click('#rpt-products [data-by="qty"]');
      prod = await ranks(page, '#rpt-products');
      f.eq(prod.map((r) => r.label), ['Classic Cotton T-Shirt', 'Leather Wallet', 'Sports Watch'], 'by units; equal units are ordered by name');
      f.eq(prod.map((r) => digits(r.value)), ['3', '1', '1'], 'the units');
      f.eq(await page.$$eval('#rpt-products [data-by]', (bs) => bs.map((b) => b.getAttribute('aria-pressed'))), ['false', 'true'], 'the switch shows the chosen view');
      f.eq(await page.evaluate(() => document.activeElement && document.activeElement.dataset.by), 'qty', 'and keeps the focus');

      const names = { c1: (await f.doc('categories/c1')).name, c2: (await f.doc('categories/c2')).name, c3: (await f.doc('categories/c3')).name };
      const cats = await ranks(page, '#rpt-categories');
      f.eq(cats.map((r) => r.label), [names.c1, names.c3, names.c2], 'categories carry their names');
      f.eq(cats.map((r) => digits(r.value)), ['3600', '3500', '1500'], 'ordered by sales');
      const geo = await ranks(page, '#rpt-geo');
      f.eq(geo.map((r) => [r.label, digits(r.value), digits(r.sub)]), [['Sirajganj', '7240', '3'], ['Dhaka', '1480', '2']], 'districts: sales and number of orders');
      const cp = await rowsOf(page, '#rpt-coupons tbody tr');
      f.eq(cp.map((r) => [r[0], digits(r[1]), digits(r[2])]), [['WELCOME10', '1', '150']], 'coupons: orders and the discount they gave');
      const cu = await rowsOf(page, '#rpt-customers tbody tr');
      f.eq(cu.map((r) => [r[0], digits(r[1]), digits(r[2])]), [['Rahim', '2', '7240'], ['Karim', '1', '1480']], 'top customers (a role that may read customers)');
      f.ok((await page.locator('#rpt-customers tbody tr a').first().getAttribute('href')).endsWith('#/customers/u1'), 'a customer name opens the profile');

      const hours = await cols(page, '#rpt-hours');
      f.eq(hours.length, 24, 'one bar per hour of the day');
      f.eq(hours.map((c, i) => [i, Number(digits(c.v))]).filter((x) => x[1] > 0), [[9, 1], [10, 1], [11, 1], [15, 1], [20, 1]], 'orders by Bangladesh hour');
      const days = await cols(page, '#rpt-sales');
      f.eq(days.map((c) => Number(digits(c.v))), [0, 0, 0, 0, 1270, 1480, 5970], 'one bar per day, oldest first; cancelled and pending orders add nothing');
      f.eq(await page.locator('#rpt-defs li').count(), 7, 'the page says how every number is counted');
      f.eq(await page.locator('#rpt-body .alert').count(), 0, 'no warning for a complete period');
      await shot(f, 'admin-reports');
    },
  },
  {
    name: 'admin reports: period chips, a custom period with checked dates, and the last chip is remembered', as: 'sadm',
    async run(f) {
      const { page } = f;
      await seed(f);
      await openReport(f);
      await page.click('[data-action="range"][data-range="today"]');
      await ordersAre(page, 1);
      f.eq(digits((await kpis(page))[0].value), '5970', "today's sales are order A alone");

      await page.click('[data-action="range"][data-range="custom"]');
      f.ok(await page.locator('#rpt-custom').isVisible(), 'the date form opens');
      f.eq(await pressed(page), ['custom'], 'the custom chip is pressed');
      f.eq([await page.inputValue('#f-from'), await page.inputValue('#f-to')], [keyOf(0), keyOf(0)], 'it starts with the period that is on screen');
      f.eq(digits((await kpis(page))[1].value), '1', 'and nothing reloads by itself');

      await page.fill('#f-from', '');
      await page.click('[data-action="apply"]');
      await wait(page, () => ((document.querySelector('#err-from') || {}).textContent || '').trim().length > 0);
      await page.fill('#f-from', keyOf(5)); await page.fill('#f-to', keyOf(6));
      await page.click('[data-action="apply"]');
      await wait(page, () => ((document.querySelector('#err-to') || {}).textContent || '').trim().length > 0);
      const orderErr = await text(page, '#err-to');
      f.eq(await text(page, '#err-from'), '', 'the start error is gone once the start is valid');
      await page.fill('#f-from', keyOf(400)); await page.fill('#f-to', keyOf(0));
      await page.click('[data-action="apply"]');
      await wait(page, (old) => { const t = ((document.querySelector('#err-to') || {}).textContent || '').trim(); return t.length > 0 && t !== old; }, orderErr);
      f.eq(digits((await kpis(page))[1].value), '1', 'a refused period never changes the report');
      await shot(f, 'admin-reports-custom');

      await page.fill('#f-from', keyOf(1)); await page.fill('#f-to', keyOf(0));
      await page.click('[data-action="apply"]');
      await ordersAre(page, 2);
      let k = await kpis(page);
      f.eq([digits(k[0].value), k[0].dir, k[1].dir], ['7450', 'up', 'flat'], 'yesterday and today: sales 7 450 against 1 270 in the two days before (C counted, D cancelled); two orders against two orders');
      f.ok(/^486/.test(digits(k[0].shown)), `sales: +486.6 % (${k[0].shown})`);
      f.eq([await text(page, '#err-from'), await text(page, '#err-to')], ['', ''], 'no errors left');

      for (const p of ['month', 'lastMonth']) {
        await page.click(`[data-action="range"][data-range="${p}"]`);
        await wait(page, () => { const b = document.querySelector('#rpt-body'); return !!b && !b.querySelector('.spinner') && !!(b.querySelector('#rpt-kpis') || b.querySelector('.empty')); });
        f.eq(await page.locator('#rpt-body [data-action="retry"]').count(), 0, `${p}: loads without an error`);
      }
      await page.click('[data-action="range"][data-range="7d"]');
      await ordersAre(page, 5);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loaded(page);
      await ordersAre(page, 5);
      f.eq(await pressed(page), ['7d'], 'the last chosen period is remembered');
    },
  },
  {
    name: 'admin reports: every export is audited first and holds exactly the period, with customer columns for roles that read customers', as: 'sa',
    async run(f) {
      const { page } = f;
      await seed(f);
      await openReport(f, '7d', 5);
      f.eq(await page.locator('[data-action="export"]').count(), 1, 'Super Admin may export');

      await page.click('#rpt-export');
      f.eq(await page.locator('[role="menuitem"]').count(), 3, 'three sheets: orders, days, products');
      await page.keyboard.press('Escape');

      const o = await download(page, 0);
      f.eq(o.name, `orders-report-${keyOf(6)}_${keyOf(0)}.csv`, 'the file name carries the period');
      const lines = csvRows(o.csv);
      f.eq(lines[0], 'Order,Date (Dhaka),Status,Payment method,Payment status,Lines,Units,Subtotal,Discount,Shipping,Total,Coupon,District,Customer,Phone', 'the columns (with customer name and phone)');
      f.eq(lines.slice(1).map((l) => l.split(',')[0]), ['RPT-E', 'RPT-D', 'RPT-C', 'RPT-B', 'RPT-A'], 'one row per order of the period, oldest first — none of the period before');
      const b = lines.find((l) => l.startsWith('RPT-B,')).split(',');
      f.eq([b[2], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14]], [ORDER_STATUS.confirmed.label, '1', '1', '1500', '150', '130', '1480', 'WELCOME10', 'Dhaka', 'Karim', '01822222222'], 'a row carries status, units, money, coupon, district and customer');
      let log = await exports(f);
      f.eq(log.length, 1, 'the export is in the audit log');
      f.eq([log[0].entityId, log[0].actorUid, log[0].actorRole, log[0].after], ['orders', 'sa', 'super_admin', { kind: 'orders', count: 5, from: keyOf(6), to: keyOf(0) }], 'with the sheet, the row count and the period — never the rows');

      const d = csvRows((await download(page, 1)).csv);
      f.eq(d[0], 'Date (Dhaka),Orders,Counted orders,Sales', 'the daily sheet');
      f.eq(d.slice(1).map((l) => l.split(',')[0]), [6, 5, 4, 3, 2, 1, 0].map(keyOf), 'one row per day, oldest first');
      f.eq(d.slice(1).map((l) => Number(l.split(',')[3])).reduce((s, n) => s + n, 0), 8720, 'the days add up to the sales');
      const p = csvRows((await download(page, 2)).csv);
      f.eq(p, ['Product,Units,Sales', 'Classic Cotton T-Shirt,3,3600', 'Sports Watch,1,3500', 'Leather Wallet,1,1500'], 'products sold, best first');
      log = await exports(f);
      f.eq(log.map((a) => [a.entityId, a.after.count]), [['daily', 7], ['orders', 5], ['products', 3]], 'three exports, three audit entries');
    },
  },
  {
    name: 'admin reports: the Reporting role gets numbers and sheets without customer names or phones', as: 'rp',
    async run(f) {
      const { page } = f;
      await seed(f);
      await openReport(f, '7d', 5);
      f.eq(digits((await kpis(page))[0].value), '8720', 'the numbers are the same');
      f.eq(await page.locator('#rpt-customers').count(), 0, 'the top-customers table is not offered (customers.read is missing)');
      const o = await download(page, 0);
      const lines = csvRows(o.csv);
      f.eq(lines[0], 'Order,Date (Dhaka),Status,Payment method,Payment status,Lines,Units,Subtotal,Discount,Shipping,Total,Coupon,District', 'the columns stop at the district');
      f.eq(lines.length - 1, 5, 'every order of the period is in it');
      f.ok(!/Rahim|Karim|Mina|01711|01822|01933/.test(o.csv), 'no customer name or phone anywhere in the file');
      const log = await exports(f);
      f.eq(log.map((a) => [a.entityId, a.actorUid, a.actorRole]), [['orders', 'rp', 'reporting']], 'the export is audited with the role');
    },
  },
  ...['pm', 'om', 'im', 'cs'].map((as) => ({
    name: `admin reports: ${as} may not open Reports`, as,
    async run(f) {
      await f.goto(REPORTS);
      await f.page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await f.page.locator('a[href$="#/reports"]').count(), 0, 'and the menu does not offer it');
    },
  })),
  {
    name: 'admin reports: a period without orders says so and exports nothing', as: 'sadm',
    async run(f) {
      const { page } = f;
      let downloads = 0;
      page.on('download', () => { downloads += 1; });
      await seed(f, []);
      await f.goto(REPORTS);
      await loaded(page);
      f.eq([await page.locator('#rpt-body .empty').count(), await page.locator('#rpt-kpis').count()], [1, 0], 'the empty state, no tiles');
      await shot(f, 'admin-reports-empty');
      await page.click('#rpt-export');
      await page.locator('[role="menuitem"]').first().click();
      await page.waitForSelector('#toasts .toast-info', { timeout: 6000 });
      f.eq(downloads, 0, 'no file');
      f.eq((await exports(f)).length, 0, 'and no audit entry for a file that was never made');
    },
  },
  {
    name: 'admin reports: exactly the cap is complete; one order more warns and no sheet is handed over', as: 'sadm',
    async run(f) {
      const { page } = f;
      let downloads = 0;
      page.on('download', () => { downloads += 1; });
      await seed(f, []);
      const tpl = {
        schemaVersion: 2, userId: 'u1', customer: { name: 'Bulk', phone: '', email: '' }, address: { district: 'Dhaka' },
        items: { p1: { productId: 'p1', variantId: null, name: 'Classic Cotton T-Shirt', unitPrice: 100, regularPrice: 100, qty: 1, lineTotal: 100, categoryId: 'c1' } },
        itemOrder: ['p1'], totals: { subtotal: 100, discount: 0, shipping: 0, tax: 0, total: 100 }, couponCode: '', payment: { method: 'cod', status: 'unpaid' }, status: 'confirmed',
      };
      const first = todayStart() + 3600000;
      await f.put('meta/bulk', `(() => { const m = window.__MOCK__; const tpl = ${JSON.stringify(tpl)}; for (let i = 0; i < 5000; i++) { const at = ${first} + i * 1000; m.db.set('orders/BULK-' + i, Object.assign({}, tpl, { orderNumber: 'BULK-' + i, createdAt: new Ts(at), updatedAt: new Ts(at) })); } return { note: 'bulk' }; })()`);
      await f.goto(REPORTS);
      await loaded(page);
      await ordersAre(page, 5000);
      f.eq(await page.locator('#rpt-body .alert').count(), 0, 'exactly 5 000 orders are the whole period: no warning');

      await f.put('orders/RPT-OLD', orderExpr({ id: 'RPT-OLD', uid: 'u1', ago: 3, hour: 9, status: 'confirmed', method: 'cod', pay: 'unpaid', lines: [['p1', 1]], shipping: 0, district: 'Dhaka' }));
      await page.click('[data-action="refresh"]');
      await page.waitForSelector('#rpt-body .alert-warn[role="alert"]', { timeout: 20000 });
      f.eq(digits((await kpis(page))[1].value), '5000', 'the report covers the newest 5 000 and says so');
      const wide = await page.$$eval('#rpt-body .table-wrap', (ws) => ws.filter((w) => w.scrollWidth > w.clientWidth + 1).map((w) => w.closest('section').id));
      f.eq(wide, [], 'even with seven-digit amounts no table needs a sideways scroll');
      await shot(f, 'admin-reports-truncated');
      await page.click('#rpt-export');
      await page.locator('[role="menuitem"]').first().click();
      await page.waitForSelector('#toasts .toast-bad', { timeout: 6000 });
      f.eq(downloads, 0, 'an incomplete period is never exported');
      f.eq((await exports(f)).length, 0, 'and nothing is audited for it');
    },
  },
];
