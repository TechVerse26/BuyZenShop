/*
 * Sales statistics — pure functions over normalised orders (shared/orderModel.js).
 * Used by the Dashboard and Reports pages; covered by tests/unit/stats.test.mjs.
 *
 * Definitions (the UI repeats them, so nobody has to guess what a number means):
 *   sales      = sum of order totals whose status is in REVENUE_STATUSES (confirmed … delivered).
 *                Pending, cancelled, returned and refunded orders do not count.
 *   received   = the part of `sales` whose payment is verified or collected (payment.status === 'paid').
 *   aov        = sales / number of counted orders (rounded to whole taka).
 *   orders     = every order placed in the period, whatever its status.
 *
 * Days are Bangladesh days (UTC+6, no daylight saving), so "today" matches what the shop owner sees on the wall clock.
 */
import { REVENUE_STATUSES } from './constants.js';

export const DHAKA_OFFSET_MS = 6 * 3600 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const REVENUE = new Set(REVENUE_STATUSES);
export const isRevenueOrder = (o) => REVENUE.has(o.status);

/** Start (ms) of the Bangladesh day that contains `ms`. */
export const dayStart = (ms) => Math.floor((ms + DHAKA_OFFSET_MS) / DAY) * DAY - DHAKA_OFFSET_MS;
/** Start (ms) of the Bangladesh hour that contains `ms`. */
export const hourStart = (ms) => Math.floor((ms + DHAKA_OFFSET_MS) / HOUR) * HOUR - DHAKA_OFFSET_MS;
/** Hour of day (0–23) in Bangladesh. */
export const dhakaHour = (ms) => Math.floor((((ms + DHAKA_OFFSET_MS) % DAY) + DAY) % DAY / HOUR);

const lineRevenue = (l) => (Number.isFinite(l.lineTotal) ? l.lineTotal : (Number(l.unitPrice) || 0) * (Number(l.qty) || 0));

export function summarize(orders) {
  const s = { count: 0, cancelled: 0, salesCount: 0, sales: 0, units: 0, received: 0, discount: 0, shipping: 0, aov: 0 };
  for (const o of orders) {
    s.count += 1;
    if (o.status === 'cancelled') s.cancelled += 1;
    if (!isRevenueOrder(o)) continue;
    const t = o.totals || {};
    s.salesCount += 1;
    s.sales += Number(t.total) || 0;
    s.discount += Number(t.discount) || 0;
    s.shipping += Number(t.shipping) || 0;
    for (const l of o.items || []) s.units += Number(l.qty) || 0;
    if (o.payment && o.payment.status === 'paid') s.received += Number(t.total) || 0;
  }
  s.aov = s.salesCount ? Math.round(s.sales / s.salesCount) : 0;
  return s;
}

/**
 * Time buckets between fromMs and toMs (inclusive of the bucket that contains toMs).
 * unit: 'day' | 'hour'. Each bucket: { start, orders, sales, salesOrders }.
 */
export function buckets(orders, fromMs, toMs, unit = 'day') {
  const step = unit === 'hour' ? HOUR : DAY;
  const first = unit === 'hour' ? hourStart(fromMs) : dayStart(fromMs);
  const out = [];
  for (let s = first; s <= toMs; s += step) out.push({ start: s, orders: 0, sales: 0, salesOrders: 0 });
  for (const o of orders) {
    const ms = o.createdAtMs;
    if (!ms || ms < first || ms > toMs) continue;
    const b = out[Math.floor((ms - first) / step)];
    if (!b) continue;
    b.orders += 1;
    if (isRevenueOrder(o)) { b.sales += Number(o.totals?.total) || 0; b.salesOrders += 1; }
  }
  return out;
}

/** Best-selling products among counted orders. Variants of one product are grouped. by: 'revenue' | 'qty'. */
export function topProducts(orders, { limit = 5, by = 'revenue' } = {}) {
  const map = new Map();
  for (const o of orders) {
    if (!isRevenueOrder(o)) continue;
    for (const l of o.items || []) {
      const key = l.productId || l.key;
      const cur = map.get(key) || { key, name: l.name || key, qty: 0, revenue: 0 };
      cur.qty += Number(l.qty) || 0;
      cur.revenue += lineRevenue(l);
      map.set(key, cur);
    }
  }
  return [...map.values()]
    .sort((a, b) => (b[by] - a[by]) || (b.qty - a.qty) || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit);
}

/**
 * Group orders by a key. Returns [{ key, count, sales }] sorted by sales then count.
 * `sales` only adds counted (revenue-status) orders; `count` counts every order in the group.
 */
export function breakdown(orders, keyFn) {
  const map = new Map();
  for (const o of orders) {
    const key = keyFn(o);
    if (key == null || key === '') continue;
    const cur = map.get(key) || { key, count: 0, sales: 0 };
    cur.count += 1;
    if (isRevenueOrder(o)) cur.sales += Number(o.totals?.total) || 0;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => (b.sales - a.sales) || (b.count - a.count) || String(a.key).localeCompare(String(b.key)));
}

/** Units sold per product category (counted orders only), by categoryId stored on each order line. */
export function categorySales(orders) {
  const map = new Map();
  for (const o of orders) {
    if (!isRevenueOrder(o)) continue;
    for (const l of o.items || []) {
      const key = l.categoryId || '';
      const cur = map.get(key) || { key, qty: 0, revenue: 0 };
      cur.qty += Number(l.qty) || 0;
      cur.revenue += lineRevenue(l);
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}
