/* Reports — js/shared/reportFlow.js: periods (Bangladesh days), buckets, comparisons, the report numbers, the sheets and the audited export. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, previousRange, pickUnit, groupBuckets, compare, buildReport, exportSheet, planReportExport, dayKey, dayFromKey, timeKey, REPORT } from '../../js/shared/reportFlow.js';
import { buckets } from '../../js/shared/stats.js';

const DAY = 86400000;
const HOUR = 3600000;
const OFF = 6 * HOUR;
const dhaka = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - OFF;      // a Bangladesh wall-clock moment
const NOW = dhaka(2026, 11, 10, 16, 5);                                              // Tuesday 10 Nov 2026, 16:05 in Dhaka

test('dayKey / timeKey / dayFromKey: Bangladesh dates, round trip, impossible dates are refused', () => {
  assert.equal(dayKey(dhaka(2026, 11, 10, 0, 0)), '2026-11-10');
  assert.equal(dayKey(dhaka(2026, 11, 9, 23, 59)), '2026-11-09');
  assert.equal(dayKey(Date.UTC(2026, 10, 9, 18, 30)), '2026-11-10', '18:30 UTC is already the next day in Dhaka');
  assert.equal(timeKey(dhaka(2026, 11, 10, 16, 5)), '2026-11-10 16:05');
  assert.equal(dayFromKey('2026-11-10'), dhaka(2026, 11, 10));
  assert.equal(dayFromKey(' 2026-11-10 '), dhaka(2026, 11, 10));
  for (const bad of ['', null, '2026-2-3', '2026-02-30', '2026-13-01', '10/11/2026', 'abc']) assert.equal(dayFromKey(bad), null, String(bad));
  assert.equal(dayFromKey('2028-02-29'), dhaka(2028, 2, 29), 'a leap day is a day');
});

test('resolveRange: the presets are whole Bangladesh days and end with today (or the month)', () => {
  const at = (preset, extra = {}) => resolveRange({ preset, nowMs: NOW, ...extra });
  let r = at('today');
  assert.deepEqual([r.ok, r.days, r.fromKey, r.toKey], [true, 1, '2026-11-10', '2026-11-10']);
  assert.equal(r.fromMs, dhaka(2026, 11, 10)); assert.equal(r.toMs, dhaka(2026, 11, 11) - 1);
  r = at('7d'); assert.deepEqual([r.days, r.fromKey, r.toKey], [7, '2026-11-04', '2026-11-10']);
  r = at('30d'); assert.deepEqual([r.days, r.fromKey, r.toKey], [30, '2026-10-12', '2026-11-10']);
  r = at('month'); assert.deepEqual([r.days, r.fromKey, r.toKey], [10, '2026-11-01', '2026-11-10']);
  r = at('lastMonth'); assert.deepEqual([r.days, r.fromKey, r.toKey], [31, '2026-10-01', '2026-10-31']);
  assert.equal(resolveRange({ preset: 'lastMonth', nowMs: dhaka(2026, 1, 15) }).fromKey, '2025-12-01', 'last month of January is December of the year before');
  assert.equal(resolveRange({ preset: 'lastMonth', nowMs: dhaka(2026, 3, 1) }).days, 28, 'February 2026 has 28 days');
  // just after Dhaka midnight it is already the next day, although UTC still says yesterday
  assert.equal(resolveRange({ preset: 'today', nowMs: Date.UTC(2026, 10, 9, 18, 30) }).fromKey, '2026-11-10');
});

test('resolveRange: a custom period is checked — real dates, in order, at most a year', () => {
  const c = (from, to) => resolveRange({ preset: 'custom', from, to, nowMs: NOW });
  const ok = c('2026-10-01', '2026-10-31');
  assert.deepEqual([ok.ok, ok.days, ok.fromMs, ok.toMs], [true, 31, dhaka(2026, 10, 1), dhaka(2026, 11, 1) - 1]);
  assert.equal(c('2026-10-05', '2026-10-05').days, 1, 'one day is allowed');
  assert.deepEqual(c('', '2026-10-31'), { ok: false, error: 'invalid', field: 'from' });
  assert.deepEqual(c('2026-10-01', '2026-02-30'), { ok: false, error: 'invalid', field: 'to' });
  assert.deepEqual(c('2026-10-31', '2026-10-01'), { ok: false, error: 'order', field: 'to' });
  assert.equal(c('2025-11-09', '2026-11-10').error, 'too_long', '367 days are too many');
  assert.equal(c('2025-11-10', '2026-11-10').days, 366, 'a whole year (366 days counting both ends) is the longest period');
  assert.equal(c('2025-11-10', '2026-11-09').ok, true, '365 days are fine');
  assert.deepEqual(resolveRange({ preset: 'forever', nowMs: NOW }), { ok: false, error: 'invalid', field: 'preset' });
});

test('previousRange: the period of equal length that ends the moment this one starts', () => {
  for (const preset of ['today', '7d', '30d', 'month', 'lastMonth']) {
    const r = resolveRange({ preset, nowMs: NOW });
    const p = previousRange(r);
    assert.equal(p.toMs + 1, r.fromMs, `${preset}: no gap and no overlap`);
    assert.equal(p.toMs + 1 - p.fromMs, r.toMs + 1 - r.fromMs, `${preset}: same length`);
    assert.equal(p.days, r.days);
  }
  assert.deepEqual([previousRange(resolveRange({ preset: '7d', nowMs: NOW })).fromKey, previousRange(resolveRange({ preset: '7d', nowMs: NOW })).toKey], ['2026-10-28', '2026-11-03']);
});

test('pickUnit and groupBuckets: hours, days, weeks of seven days, calendar months — nothing is lost', () => {
  assert.deepEqual([1, 2, 62, 63, 186, 187, 366].map(pickUnit), ['hour', 'day', 'day', 'week', 'week', 'month', 'month']);
  const from = dhaka(2026, 9, 25);
  const to = dhaka(2026, 12, 3) + DAY - 1;                                           // 70 days, spans four calendar months
  const orders = [];
  for (let i = 0; i < 70; i++) orders.push({ createdAtMs: from + i * DAY + 5 * HOUR, status: 'delivered', totals: { total: 100 + i } });
  orders.push({ createdAtMs: from + 4 * DAY, status: 'cancelled', totals: { total: 999 } });
  const daily = buckets(orders, from, to, 'day');
  assert.equal(daily.length, 70);
  const sum = (rows, k) => rows.reduce((s, b) => s + b[k], 0);
  const weeks = groupBuckets(daily, 'week');
  assert.equal(weeks.length, 10);
  assert.ok(weeks.every((w) => w.days === 7));
  assert.deepEqual([weeks[0].start, weeks[0].end], [from, from + 6 * DAY]);
  const months = groupBuckets(daily, 'month');
  assert.deepEqual(months.map((m) => dayKey(m.start)), ['2026-09-25', '2026-10-01', '2026-11-01', '2026-12-01'], 'the first month starts where the period starts');
  assert.deepEqual(months.map((m) => m.days), [6, 31, 30, 3]);
  for (const key of ['orders', 'sales', 'salesOrders']) {
    assert.equal(sum(weeks, key), sum(daily, key), `weeks keep ${key}`);
    assert.equal(sum(months, key), sum(daily, key), `months keep ${key}`);
  }
  assert.deepEqual(groupBuckets(daily, 'day').map((b) => b.days), new Array(70).fill(1));
});

test('compare: moves in whole-and-tenth percent, no division by zero', () => {
  assert.deepEqual(compare(150, 100), { delta: 50, pct: 50 });
  assert.deepEqual(compare(50, 100), { delta: -50, pct: -50 });
  assert.deepEqual(compare(1, 3), { delta: -2, pct: -66.7 });
  assert.deepEqual(compare(0, 0), { delta: 0, pct: 0 });
  assert.deepEqual(compare(10, 0), { delta: 10, pct: null }, 'nothing earlier to compare with');
  assert.deepEqual(compare(undefined, 'x'), { delta: 0, pct: 0 });
});

/* ───────────────────────── a small shop ───────────────────────── */
const line = (productId, name, qty, unitPrice, categoryId = '') => ({ key: productId, productId, name, qty, unitPrice, lineTotal: qty * unitPrice, categoryId });
const order = (id, o) => ({
  id, orderNumber: id, userId: o.u || '', customer: { name: o.name || '', phone: o.phone || '' }, address: { district: o.district || '' },
  items: o.items, totals: { subtotal: o.total - (o.ship || 0) + (o.disc || 0), discount: o.disc || 0, shipping: o.ship || 0, total: o.total },
  couponCode: o.coupon || '', payment: { method: o.method || 'cod', status: o.pay || 'unpaid' }, status: o.status, createdAtMs: o.at,
});
const START = dhaka(2026, 11, 4);
const range = resolveRange({ preset: '7d', nowMs: NOW });
const orders = [
  order('A', { u: 'u1', name: 'Rahim', phone: '01711111111', district: 'Dhaka', items: [line('p1', 'T-Shirt', 2, 500, 'c1'), line('p2', 'Cap', 1, 200, 'c1')], total: 1260, ship: 60, status: 'delivered', method: 'bkash', pay: 'paid', at: START + 10 * HOUR, coupon: 'WELCOME10', disc: 0 }),
  order('B', { u: 'u1', name: 'Rahim', phone: '01711111111', district: 'Dhaka', items: [line('p1', 'T-Shirt', 1, 500, 'c1')], total: 540, ship: 60, status: 'confirmed', at: START + 2 * DAY + 3 * HOUR, coupon: 'WELCOME10', disc: 50 }),
  order('C', { u: 'u2', name: '=cmd|calc', phone: '01822222222', district: 'Sirajganj', items: [line('p3', 'Watch', 1, 3500, 'c2')], total: 3560, ship: 60, status: 'shipped', method: 'nagad', pay: 'awaiting_verification', at: START + 3 * DAY + 20 * HOUR }),
  order('D', { u: 'u3', name: 'Nadia', phone: '01933333333', district: 'Dhaka', items: [line('p2', 'Cap', 3, 200, 'c1')], total: 660, ship: 60, status: 'cancelled', at: START + 3 * DAY + HOUR }),
  order('E', { u: 'u1', name: 'Rahim', district: '', items: [line('p4', 'Loose item', 1, 100, '')], total: 100, status: 'pending', at: Date.UTC(2026, 10, 9, 18, 30) }),   // 00:30 in Dhaka on 10 Nov
];
const prevOrders = [
  order('X', { u: 'u1', items: [line('p1', 'T-Shirt', 1, 500, 'c1')], total: 560, ship: 60, status: 'delivered', at: dhaka(2026, 10, 30, 12) }),
  order('Y', { u: 'u9', items: [line('p1', 'T-Shirt', 1, 500, 'c1')], total: 560, ship: 60, status: 'cancelled', at: dhaka(2026, 10, 31, 12) }),
];

test('buildReport: sales count only revenue statuses, orders count everything, and every number is compared with the period before', () => {
  const r = buildReport({ orders, prevOrders, range, categoryNames: { c1: 'Clothing', c2: 'Watches' } });
  assert.equal(r.empty, false);
  const k = r.kpis;
  assert.deepEqual([k.sales.value, k.sales.count], [1260 + 540 + 3560, 3], 'delivered + confirmed + shipped; pending and cancelled do not count');
  assert.equal(k.orders.value, 5);
  assert.equal(k.aov.value, Math.round((1260 + 540 + 3560) / 3));
  assert.equal(k.units.value, 3 + 1 + 1, 'units of counted orders only');
  assert.equal(k.received.value, 1260, 'only the bKash order is paid');
  assert.equal(k.customers.value, 3, 'u1, u2 and u3 ordered');
  assert.equal(k.discount.value, 50); assert.equal(k.shipping.value, 180);
  assert.deepEqual([k.cancelRate.value, k.cancelRate.pct], [20, null], '1 of 5 orders was cancelled');
  assert.equal(k.cancelRate.delta, -30, 'it was 1 of 2 before: 20 − 50 points');
  assert.deepEqual([k.sales.delta, k.sales.pct], [5360 - 560, Math.round(((5360 - 560) / 560) * 1000) / 10]);
  assert.deepEqual([k.orders.delta, k.orders.pct], [3, 150]);
  assert.equal(k.customers.pct, 50, '3 customers against 2 (u1, u9)');
});

test('buildReport: statuses in lifecycle order, payment methods, payment states without cancelled orders, hours in Dhaka time', () => {
  const r = buildReport({ orders, prevOrders, range });
  assert.deepEqual(r.byStatus.map((s) => [s.status, s.count]), [['pending', 1], ['confirmed', 1], ['shipped', 1], ['delivered', 1], ['cancelled', 1]]);
  assert.equal(r.byStatus.find((s) => s.status === 'delivered').sales, 1260);
  assert.equal(r.byStatus.find((s) => s.status === 'pending').sales, 0, 'a pending order is not sales yet');
  assert.deepEqual(r.methods.map((m) => [m.method, m.count, m.sales, m.received]), [['cod', 3, 540, 0], ['bkash', 1, 1260, 1260], ['nagad', 1, 3560, 0]]);
  assert.deepEqual(r.payStatus.map((p) => [p.status, p.count]), [['unpaid', 2], ['awaiting_verification', 1], ['paid', 1]], 'the cancelled order is left out');
  assert.equal(r.hours.length, 24);
  assert.equal(r.hours[0].orders, 1, 'order E was placed at 00:30 Dhaka time (18:30 UTC the day before)');
  assert.equal(r.hours[10].orders + r.hours[3].orders + r.hours[20].orders + r.hours[1].orders, 4);
  assert.equal(r.hours.reduce((n, h) => n + h.orders, 0), 5);
});

test('buildReport: top products, categories, districts, coupons and customers', () => {
  const r = buildReport({ orders, prevOrders, range, categoryNames: { c1: 'Clothing', c2: 'Watches' } });
  assert.deepEqual(r.products.byRevenue.map((p) => [p.name, p.qty, p.revenue]), [['Watch', 1, 3500], ['T-Shirt', 3, 1500], ['Cap', 1, 200]], 'cancelled and pending lines are left out');
  assert.deepEqual(r.products.byQty.map((p) => p.name), ['T-Shirt', 'Cap', 'Watch'], 'three units first; one unit each is ordered by name');
  assert.deepEqual(r.categories.map((c) => [c.name, c.qty, c.revenue]), [['Watches', 1, 3500], ['Clothing', 4, 1700]]);
  assert.deepEqual(r.districts.map((d) => [d.name, d.count, d.sales]), [['Sirajganj', 1, 3560], ['Dhaka', 3, 1800]], 'orders without a district are not listed');
  assert.deepEqual(r.coupons, [{ code: 'WELCOME10', orders: 2, discount: 50 }]);
  assert.deepEqual(r.topCustomers.map((c) => [c.userId, c.name, c.orders, c.sales]), [['u2', '=cmd|calc', 1, 3560], ['u1', 'Rahim', 2, 1800]]);
  assert.equal(buildReport({ orders, range, categoryNames: {} }).categories.find((c) => c.id === 'c2').name, '', 'an unknown category has no name (the page says "uncategorised")');
  const unc = buildReport({ orders: [orders[4], { ...orders[4], id: 'E2', status: 'confirmed' }], range });
  assert.deepEqual(unc.categories.map((c) => c.id), [''], 'a line without a category is kept under an empty id');
});

test('buildReport: the sales series follows the period — hours for one day, days, weeks, months', () => {
  const one = resolveRange({ preset: 'today', nowMs: NOW });
  const r1 = buildReport({ orders, range: one });
  assert.equal(r1.series.unit, 'hour'); assert.equal(r1.series.rows.length, 24);
  const r7 = buildReport({ orders, range });
  assert.equal(r7.series.unit, 'day'); assert.equal(r7.series.rows.length, 7);
  assert.equal(r7.series.rows.reduce((s, b) => s + b.sales, 0), 5360);
  const year = resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-11-10', nowMs: NOW });
  assert.equal(year.ok, true);
  const ry = buildReport({ orders, range: year });
  assert.equal(ry.series.unit, 'month'); assert.equal(ry.series.rows.length, 11);
  assert.equal(ry.series.rows.reduce((s, b) => s + b.orders, 0), 5);
  const empty = buildReport({ orders: [], prevOrders: [], range });
  assert.equal(empty.empty, true);
  assert.deepEqual([empty.kpis.sales.value, empty.kpis.sales.pct, empty.kpis.cancelRate.value], [0, 0, 0]);
  assert.equal(empty.hours.length, 24); assert.deepEqual(empty.coupons, []);
});

test('exportSheet: customer columns only when asked for; totals match the report; file names carry the period', () => {
  const o = exportSheet('orders', { orders, range });
  assert.equal(o.filename, 'orders-report-2026-11-04_2026-11-10.csv');
  assert.equal(o.headers.includes('Customer'), false); assert.equal(o.headers.includes('Phone'), false);
  assert.equal(o.rows.length, 5);
  assert.ok(o.rows.every((r) => r.length === o.headers.length));
  assert.deepEqual(o.rows.map((r) => r[0]), ['A', 'B', 'D', 'C', 'E'], 'oldest first');
  assert.deepEqual(o.rows[0], ['A', '2026-11-04 10:00', 'Delivered', 'bKash', 'Paid', 2, 3, 1200, 0, 60, 1260, 'WELCOME10', 'Dhaka']);
  const withC = exportSheet('orders', { orders, range, withCustomer: true });
  assert.deepEqual(withC.headers.slice(-2), ['Customer', 'Phone']);
  assert.deepEqual(withC.rows[0].slice(-2), ['Rahim', '01711111111']);
  const d = exportSheet('daily', { orders, range });
  assert.equal(d.rows.length, 7); assert.deepEqual(d.headers, ['Date (Dhaka)', 'Orders', 'Counted orders', 'Sales']);
  assert.equal(d.rows.reduce((s, r) => s + r[3], 0), 5360); assert.equal(d.rows.reduce((s, r) => s + r[1], 0), 5);
  assert.deepEqual(d.rows[0], ['2026-11-04', 1, 1, 1260]);
  const p = exportSheet('products', { orders, range });
  assert.deepEqual(p.rows, [['Watch', 1, 3500], ['T-Shirt', 3, 1500], ['Cap', 1, 200]], 'every product of a counted order, best first');
  assert.equal(exportSheet('everything', { orders, range }), null);
});

test('planReportExport: needs reports.read AND reports.export; one audit entry that never carries the rows', () => {
  const r = resolveRange({ preset: '7d', nowMs: NOW });
  const ACTOR = (role) => ({ uid: 'x', email: 'x@y.test', role });
  for (const role of ['super_admin', 'store_admin', 'reporting']) {
    const p = planReportExport({ kind: 'orders', count: 42, range: r, actor: ACTOR(role) });
    assert.equal(p.ok, true, role);
    assert.equal(p.ops.length, 1);
    const d = p.ops[0].data;
    assert.match(p.ops[0].path, /^auditLogs\//);
    assert.deepEqual([d.action, d.entity, d.entityId, d.actorRole, d.actorUid], ['report.export', 'report', 'orders', role, 'x']);
    assert.deepEqual(d.after, { kind: 'orders', count: 42, from: '2026-11-04', to: '2026-11-10' });
    assert.equal(d.before, null);
    assert.match(d.summary, /42 rows/);
  }
  for (const role of ['product_manager', 'order_manager', 'inventory_manager', 'customer_support', 'nobody', '']) {
    assert.deepEqual(planReportExport({ kind: 'orders', count: 1, range: r, actor: ACTOR(role) }), { ok: false, error: 'forbidden' }, role);
  }
  assert.deepEqual(planReportExport({ kind: 'orders', count: 1, range: r, actor: null }), { ok: false, error: 'forbidden' });
  const A = ACTOR('reporting');
  assert.equal(planReportExport({ kind: 'everything', count: 1, range: r, actor: A }).error, 'invalid');
  assert.equal(planReportExport({ kind: 'daily', count: -1, range: r, actor: A }).error, 'invalid');
  assert.equal(planReportExport({ kind: 'daily', count: 1.5, range: r, actor: A }).error, 'invalid');
  assert.equal(planReportExport({ kind: 'daily', count: 1, range: null, actor: A }).error, 'invalid');
  assert.equal(planReportExport({ kind: 'daily', count: 0, range: r, actor: A }).error, 'empty', 'an empty sheet is not exported (nothing to audit)');
  assert.equal(REPORT.MAX_DAYS, 366);
});
