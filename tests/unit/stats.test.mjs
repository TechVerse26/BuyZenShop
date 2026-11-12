/* The numbers on the Dashboard and Reports pages come from these functions, so each definition the UI promises is pinned here:
 * sales = confirmed … delivered orders only; received = the paid part of that; days and hours are Bangladesh time. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DHAKA_OFFSET_MS, isRevenueOrder, dayStart, hourStart, dhakaHour, summarize, buckets, topProducts, breakdown, categorySales,
} from '../../js/shared/stats.js';
import { REVENUE_STATUSES } from '../../js/shared/constants.js';

const H = 3600000;
const D = 24 * H;
const T0 = Date.UTC(2026, 0, 1, 18, 0);                       // 00:00 on 2 Jan 2026 in Dhaka

const item = (productId, qty, lineTotal, extra = {}) => ({ productId, name: extra.name || productId.toUpperCase(), qty, unitPrice: extra.unitPrice ?? (lineTotal / qty), lineTotal, categoryId: extra.categoryId ?? 'c1' });
const order = (status, total, over = {}) => ({
  id: over.id || `o-${status}-${total}`, status, createdAtMs: over.at ?? T0 + H,
  totals: { total, discount: over.discount ?? 0, shipping: over.shipping ?? 0 },
  items: over.items || [item('p1', 1, total)], payment: { status: over.paid ? 'paid' : 'unpaid' }, district: over.district,
});

const ORDERS = [
  order('confirmed', 1000, { paid: true, discount: 100, shipping: 100, items: [item('p1', 2, 800, { name: 'Shirt' }), item('p2', 1, 100, { name: 'Cap', categoryId: 'c2' })], district: 'Dhaka' }),
  order('delivered', 500, { shipping: 100, items: [item('p1', 1, 400, { name: 'Shirt' })], at: T0 + 5 * H, district: 'Dhaka' }),
  order('pending', 700, { district: 'Sirajganj' }),
  order('cancelled', 300, { district: 'Sirajganj' }),
  order('shipped', 250, { paid: true, items: [{ productId: 'p3', name: 'Belt', qty: 5, unitPrice: 30, categoryId: 'c2' }], at: T0 + D + H, district: 'Rajshahi' }),   // no lineTotal → unitPrice × qty
  order('returned', 900, { district: 'Rajshahi' }),
];

test('only confirmed … delivered orders count as sales', () => {
  assert.deepEqual([...REVENUE_STATUSES].sort(), ['confirmed', 'delivered', 'packed', 'processing', 'shipped']);
  for (const s of REVENUE_STATUSES) assert.equal(isRevenueOrder({ status: s }), true, s);
  for (const s of ['pending', 'awaiting_payment', 'cancelled', 'returned', 'refunded', 'failed', 'something-else']) assert.equal(isRevenueOrder({ status: s }), false, s);
});

test('Bangladesh day and hour boundaries (UTC+6, no daylight saving)', () => {
  assert.equal(DHAKA_OFFSET_MS, 6 * H);
  assert.equal(dayStart(Date.UTC(2026, 0, 1, 17, 59, 59, 999)), Date.UTC(2025, 11, 31, 18, 0));
  assert.equal(dayStart(Date.UTC(2026, 0, 1, 18, 0)), Date.UTC(2026, 0, 1, 18, 0));
  assert.equal(dayStart(Date.UTC(2026, 6, 1, 0, 0)), Date.UTC(2026, 5, 30, 18, 0), 'July has the same offset as January');
  assert.equal(hourStart(Date.UTC(2026, 0, 1, 18, 59, 59)), Date.UTC(2026, 0, 1, 18, 0));
  assert.equal(dhakaHour(Date.UTC(2026, 0, 1, 18, 0)), 0);
  assert.equal(dhakaHour(Date.UTC(2026, 0, 1, 17, 59)), 23);
  assert.equal(dhakaHour(Date.UTC(2026, 0, 1, 6, 30)), 12);
  assert.equal(dhakaHour(Date.UTC(1969, 11, 31, 23, 0)), 5, 'before 1970 as well');
});

test('summary: every order is counted, only sales add money, received is the paid part', () => {
  assert.deepEqual(summarize(ORDERS), {
    count: 6, cancelled: 1, salesCount: 3, sales: 1750, units: 9, received: 1250, discount: 100, shipping: 200, aov: 583,
  });
  assert.deepEqual(summarize([]), { count: 0, cancelled: 0, salesCount: 0, sales: 0, units: 0, received: 0, discount: 0, shipping: 0, aov: 0 });
  const odd = summarize([{ status: 'confirmed' }, { status: 'delivered', totals: { total: 'x' }, items: [{ qty: 'y' }] }]);
  assert.deepEqual([odd.sales, odd.units, odd.salesCount, odd.aov], [0, 0, 2, 0], 'missing or garbage numbers count as zero, never NaN');
});

test('average order value is rounded to whole taka', () => {
  assert.equal(summarize([order('confirmed', 100), order('confirmed', 100), order('confirmed', 101)]).aov, 100, '301 / 3 = 100.33');
  assert.equal(summarize([order('confirmed', 100), order('confirmed', 101)]).aov, 101, '100.5 rounds up');
});

test('day buckets cover the period inclusively and place each order in its Bangladesh day', () => {
  const b = buckets(ORDERS, T0, T0 + D + 2 * H, 'day');
  assert.deepEqual(b.map((x) => x.start), [T0, T0 + D]);
  assert.deepEqual(b[0], { start: T0, orders: 5, sales: 1500, salesOrders: 2 });
  assert.deepEqual(b[1], { start: T0 + D, orders: 1, sales: 250, salesOrders: 1 });
  const total = b.reduce((s, x) => s + x.orders, 0);
  assert.equal(total, ORDERS.length, 'nothing is lost between buckets');
});

test('an order just before midnight Dhaka time belongs to the earlier day, one second later to the next', () => {
  const late = order('confirmed', 10, { at: T0 + D - 1 });
  const next = order('confirmed', 20, { at: T0 + D });
  const b = buckets([late, next], T0, T0 + D, 'day');
  assert.deepEqual(b.map((x) => [x.orders, x.sales]), [[1, 10], [1, 20]]);
});

test('hour buckets for a single day; orders outside the range or without a time are ignored', () => {
  const b = buckets([...ORDERS, order('confirmed', 5, { at: T0 - 1 }), order('confirmed', 5, { at: T0 + 30 * H }), { status: 'confirmed', totals: { total: 99 } }], T0, T0 + 6 * H, 'hour');
  assert.equal(b.length, 7);
  assert.equal(b[1].orders, 4, 'four orders were placed between 01:00 and 02:00');
  assert.equal(b[1].sales, 1000);
  assert.equal(b[5].orders, 1);
  assert.equal(b.reduce((s, x) => s + x.orders, 0), 5);
});

test('best sellers: variants of one product are grouped, by revenue or by units, ties broken deterministically', () => {
  const top = topProducts(ORDERS);
  assert.deepEqual(top.map((p) => [p.key, p.name, p.qty, p.revenue]), [['p1', 'Shirt', 3, 1200], ['p3', 'Belt', 5, 150], ['p2', 'Cap', 1, 100]]);
  assert.deepEqual(topProducts(ORDERS, { by: 'qty' }).map((p) => p.key), ['p3', 'p1', 'p2']);
  assert.deepEqual(topProducts(ORDERS, { limit: 1 }).map((p) => p.key), ['p1']);
  assert.deepEqual(topProducts([order('pending', 999)]), [], 'unpaid, cancelled and returned orders do not make a best seller');
  const tie = topProducts([order('confirmed', 100, { items: [item('b', 1, 50, { name: 'Bravo' }), item('a', 1, 50, { name: 'Alpha' })] })]);
  assert.deepEqual(tie.map((p) => p.name), ['Alpha', 'Bravo'], 'equal revenue and units: by name');
});

test('breakdown: every order is counted in its group but only sales add money; groups sorted by sales, then count', () => {
  const byDistrict = breakdown(ORDERS, (o) => o.district);
  assert.deepEqual(byDistrict, [
    { key: 'Dhaka', count: 2, sales: 1500 },
    { key: 'Rajshahi', count: 2, sales: 250 },
    { key: 'Sirajganj', count: 2, sales: 0 },
  ]);
  assert.deepEqual(breakdown(ORDERS, (o) => (o.district === 'Dhaka' ? '' : null)), [], 'empty and missing keys are skipped');
  assert.deepEqual(breakdown(ORDERS, (o) => o.status).map((g) => g.key), ['confirmed', 'delivered', 'shipped', 'cancelled', 'pending', 'returned'], 'money first; the three with no sales by name');
});

test('category sales add units and revenue of counted orders per category', () => {
  assert.deepEqual(categorySales(ORDERS), [
    { key: 'c1', qty: 3, revenue: 1200 },
    { key: 'c2', qty: 6, revenue: 250 },
  ]);
  assert.deepEqual(categorySales([order('cancelled', 100)]), []);
  assert.deepEqual(categorySales([order('confirmed', 100, { items: [{ productId: 'x', qty: 1, unitPrice: 100 }] })]), [{ key: '', qty: 1, revenue: 100 }], 'a line without a category is grouped under the empty key');
});
