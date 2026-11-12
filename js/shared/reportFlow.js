/*
 * Reports — the rules of the game, pure (no Firebase, no DOM), so the page, the data layer and the tests run the very same code.
 *
 *   resolveRange({ preset, from, to, nowMs })    → { ok, preset, fromMs, toMs, days, fromKey, toKey } | { ok:false, error, field }
 *        presets: today · 7d · 30d · month · lastMonth · custom (from / to are Bangladesh dates "YYYY-MM-DD", at most 366 days)
 *        error codes: invalid (field: preset · from · to) · order · too_long
 *   previousRange(range)                         → the period of the same length right before it (the "vs previous period" comparison)
 *   pickUnit(days) · groupBuckets(daily, unit)   → hour (one day) · day (≤ 62 days) · week (≤ 186) · month — what one bar of the sales chart is
 *   compare(current, previous)                   → { delta, pct }   pct is null when there is nothing to compare with
 *   buildReport({ orders, prevOrders, range, categoryNames }) → every number the Reports page shows
 *   exportSheet(kind, { orders, range, withCustomer })        → { filename, headers, rows }    kinds: orders · daily · products
 *   planReportExport({ kind, count, range, actor })           → { ok, action, ops } | { ok:false, error }    (forbidden · invalid · empty)
 *
 * Definitions (the page repeats them, nobody has to guess what a number means — see also shared/stats.js):
 *   sales      = order totals of orders in a revenue status (confirmed … delivered); pending, cancelled, returned and refunded orders do not count
 *   orders     = every order placed in the period, whatever its status
 *   received   = the part of sales whose payment is verified or collected
 *   customers  = different signed-in customers who placed an order in the period (counted from the orders themselves — no extra data is read)
 *   cancel rate = cancelled orders / all orders placed, in percent
 * Days are Bangladesh days (UTC+6, no daylight saving). A comparison always uses the period of equal length that ends the moment this one starts.
 *
 * Personal data: a sheet carries the customer's name and phone only when `withCustomer` is set (the caller passes customers.read). A bulk export is itself audited
 * (one `report.export` entry with the sheet's kind, its row count and the period — never the rows) and needs reports.read AND reports.export.
 */
import { roleCan, ORDER_STATUS, ORDER_STATUS_IDS, PAYMENT_METHODS, PAYMENT_METHOD_IDS, PAYMENT_STATUS } from './constants.js';
import { DHAKA_OFFSET_MS, dayStart, dhakaHour, summarize, buckets, topProducts, breakdown, categorySales, isRevenueOrder } from './stats.js';
import { auditOp } from './orderFlow.js';

export const REPORT = Object.freeze({ READ: 'reports.read', EXPORT: 'reports.export', MAX_DAYS: 366, TOP: 10, TOP_SMALL: 8 });
export const PRESETS = Object.freeze(['today', '7d', '30d', 'month', 'lastMonth', 'custom']);
export const EXPORT_KINDS = Object.freeze(['orders', 'daily', 'products']);

const DAY = 24 * 3600 * 1000;
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const pad = (n) => String(n).padStart(2, '0');

/* ───────────────────────── Bangladesh dates ───────────────────────── */

/** "2026-11-10" — the Bangladesh calendar day that contains `ms`. */
export const dayKey = (ms) => { const d = new Date(ms + DHAKA_OFFSET_MS); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
/** "2026-11-10 16:05" — Bangladesh date and time. */
export const timeKey = (ms) => { const d = new Date(ms + DHAKA_OFFSET_MS); return `${dayKey(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
/** Start (ms) of the Bangladesh day written "YYYY-MM-DD"; null when the text is not a real calendar date. */
export function dayFromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return utc - DHAKA_OFFSET_MS;
}
const monthStart = (ms) => { const d = new Date(ms + DHAKA_OFFSET_MS); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - DHAKA_OFFSET_MS; };
const monthStartBefore = (ms) => { const d = new Date(ms + DHAKA_OFFSET_MS); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) - DHAKA_OFFSET_MS; };

/* ───────────────────────── periods ───────────────────────── */

export function resolveRange({ preset = '30d', from = '', to = '', nowMs = Date.now() } = {}) {
  const today = dayStart(nowMs);
  let fromMs; let toMs;
  switch (preset) {
    case 'today': fromMs = today; toMs = today + DAY - 1; break;
    case '7d': fromMs = today - 6 * DAY; toMs = today + DAY - 1; break;
    case '30d': fromMs = today - 29 * DAY; toMs = today + DAY - 1; break;
    case 'month': fromMs = monthStart(nowMs); toMs = today + DAY - 1; break;
    case 'lastMonth': fromMs = monthStartBefore(nowMs); toMs = monthStart(nowMs) - 1; break;
    case 'custom': {
      const a = dayFromKey(from); const b = dayFromKey(to);
      if (a === null) return fail('invalid', { field: 'from' });
      if (b === null) return fail('invalid', { field: 'to' });
      if (a > b) return fail('order', { field: 'to' });
      fromMs = a; toMs = b + DAY - 1;
      break;
    }
    default: return fail('invalid', { field: 'preset' });
  }
  const days = Math.round((toMs + 1 - fromMs) / DAY);
  if (days > REPORT.MAX_DAYS) return fail('too_long', { field: 'to' });
  return { ok: true, preset, fromMs, toMs, days, fromKey: dayKey(fromMs), toKey: dayKey(toMs) };
}

/** The period of the same length that ends the moment `range` starts. */
export function previousRange(range) {
  const span = range.toMs + 1 - range.fromMs;
  const toMs = range.fromMs - 1;
  const fromMs = toMs + 1 - span;
  return { ok: true, preset: 'previous', fromMs, toMs, days: range.days, fromKey: dayKey(fromMs), toKey: dayKey(toMs) };
}

export const pickUnit = (days) => (days <= 1 ? 'hour' : days <= 62 ? 'day' : days <= 186 ? 'week' : 'month');

/**
 * Daily buckets (stats.buckets) → buckets of a week (seven days counted from the first day of the period) or of a calendar month.
 * Each: { start, end, orders, sales, salesOrders, days } — `start` / `end` are the first and last Bangladesh day inside the bucket.
 */
export function groupBuckets(daily, unit) {
  const one = (b) => ({ start: b.start, end: b.start, orders: b.orders, sales: b.sales, salesOrders: b.salesOrders, days: 1 });
  if (unit !== 'week' && unit !== 'month') return daily.map(one);
  const out = [];
  const index = new Map();
  daily.forEach((b, i) => {
    const key = unit === 'week' ? Math.floor(i / 7) : monthStart(b.start);
    let cur = index.get(key);
    if (!cur) { cur = { start: b.start, end: b.start, orders: 0, sales: 0, salesOrders: 0, days: 0 }; index.set(key, cur); out.push(cur); }
    cur.end = b.start; cur.orders += b.orders; cur.sales += b.sales; cur.salesOrders += b.salesOrders; cur.days += 1;
  });
  return out;
}

/** How much a number moved. pct is whole-and-tenth percent; null when the earlier value was 0 and the new one is not (nothing to divide by). */
export function compare(current, previous) {
  const c = Number(current) || 0; const p = Number(previous) || 0;
  return { delta: c - p, pct: p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : (c === 0 ? 0 : null) };
}

/* ───────────────────────── the report ───────────────────────── */

const uniqueCustomers = (orders) => new Set(orders.map((o) => o.userId).filter(Boolean)).size;
const rate = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export function buildReport({ orders = [], prevOrders = [], range, categoryNames = {} } = {}) {
  const cur = summarize(orders);
  const prev = summarize(prevOrders);
  const customers = uniqueCustomers(orders);
  const cancelRate = rate(cur.cancelled, cur.count);
  const prevCancelRate = rate(prev.cancelled, prev.count);

  const kpis = {
    sales: { value: cur.sales, count: cur.salesCount, ...compare(cur.sales, prev.sales) },
    orders: { value: cur.count, ...compare(cur.count, prev.count) },
    aov: { value: cur.aov, ...compare(cur.aov, prev.aov) },
    units: { value: cur.units, ...compare(cur.units, prev.units) },
    received: { value: cur.received, ...compare(cur.received, prev.received) },
    customers: { value: customers, ...compare(customers, uniqueCustomers(prevOrders)) },
    cancelRate: { value: cancelRate, delta: Math.round((cancelRate - prevCancelRate) * 10) / 10, pct: null },
    discount: { value: cur.discount },
    shipping: { value: cur.shipping },
  };

  const unit = pickUnit(range.days);
  const daily = buckets(orders, range.fromMs, range.toMs, unit === 'hour' ? 'hour' : 'day');
  const series = { unit, rows: groupBuckets(daily, unit) };

  const statusRows = new Map(breakdown(orders, (o) => o.status).map((r) => [r.key, r]));
  const byStatus = ORDER_STATUS_IDS.filter((id) => statusRows.has(id)).map((id) => ({ status: id, count: statusRows.get(id).count, sales: statusRows.get(id).sales }));

  const methods = PAYMENT_METHOD_IDS.map((method) => {
    const s = summarize(orders.filter((o) => (o.payment && o.payment.method) === method));
    return { method, count: s.count, sales: s.sales, received: s.received };
  }).filter((m) => m.count > 0);

  const payRows = new Map(breakdown(orders.filter((o) => o.status !== 'cancelled'), (o) => o.payment && o.payment.status).map((r) => [r.key, r]));
  const payStatus = Object.keys(PAYMENT_STATUS).filter((id) => payRows.has(id)).map((id) => ({ status: id, count: payRows.get(id).count }));

  const categories = categorySales(orders).slice(0, REPORT.TOP_SMALL).map((c) => ({ id: c.key, name: categoryNames[c.key] || '', qty: c.qty, revenue: c.revenue }));
  const districts = breakdown(orders, (o) => (o.address && o.address.district) || '').slice(0, REPORT.TOP_SMALL).map((d) => ({ name: d.key, count: d.count, sales: d.sales }));

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));
  for (const o of orders) if (o.createdAtMs) hours[dhakaHour(o.createdAtMs)].orders += 1;

  const couponMap = new Map();
  for (const o of orders) {
    const code = String(o.couponCode || '').trim();
    if (!code) continue;
    const c = couponMap.get(code) || { code, orders: 0, discount: 0 };
    c.orders += 1;
    if (isRevenueOrder(o)) c.discount += Number(o.totals && o.totals.discount) || 0;
    couponMap.set(code, c);
  }
  const coupons = [...couponMap.values()].sort((a, b) => (b.discount - a.discount) || (b.orders - a.orders) || a.code.localeCompare(b.code));

  const customerMap = new Map();
  for (const o of orders) {
    if (!o.userId || !isRevenueOrder(o)) continue;
    const c = customerMap.get(o.userId) || { userId: o.userId, name: '', orders: 0, sales: 0 };
    c.orders += 1;
    c.sales += Number(o.totals && o.totals.total) || 0;
    if (!c.name && o.customer && o.customer.name) c.name = o.customer.name;
    customerMap.set(o.userId, c);
  }
  const topCustomers = [...customerMap.values()].sort((a, b) => (b.sales - a.sales) || (b.orders - a.orders) || String(a.userId).localeCompare(String(b.userId))).slice(0, REPORT.TOP_SMALL);

  return {
    range, empty: cur.count === 0, kpis, series, byStatus, methods, payStatus,
    products: { byRevenue: topProducts(orders, { limit: REPORT.TOP, by: 'revenue' }), byQty: topProducts(orders, { limit: REPORT.TOP, by: 'qty' }) },
    categories, districts, hours, coupons, topCustomers,
  };
}

/* ───────────────────────── sheets and the audit entry ───────────────────────── */

const label = (map, id) => (map[id] ? map[id].label : String(id ?? ''));
const unitsOf = (o) => (o.items || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);

export function exportSheet(kind, { orders = [], range, withCustomer = false } = {}) {
  const filename = `${kind}-report-${range.fromKey}_${range.toKey}.csv`;
  if (kind === 'orders') {
    const headers = ['Order', 'Date (Dhaka)', 'Status', 'Payment method', 'Payment status', 'Lines', 'Units', 'Subtotal', 'Discount', 'Shipping', 'Total', 'Coupon', 'District', ...(withCustomer ? ['Customer', 'Phone'] : [])];
    const sorted = orders.slice().sort((a, b) => ((a.createdAtMs || 0) - (b.createdAtMs || 0)) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
    const rows = sorted.map((o) => {
      const t = o.totals || {};
      const row = [
        o.orderNumber || o.id, o.createdAtMs ? timeKey(o.createdAtMs) : '', label(ORDER_STATUS, o.status),
        label(PAYMENT_METHODS, o.payment && o.payment.method), label(PAYMENT_STATUS, o.payment && o.payment.status),
        (o.items || []).length, unitsOf(o), Number(t.subtotal) || 0, Number(t.discount) || 0, Number(t.shipping) || 0, Number(t.total) || 0,
        o.couponCode || '', (o.address && o.address.district) || '',
      ];
      if (withCustomer) row.push((o.customer && o.customer.name) || '', (o.customer && o.customer.phone) || '');
      return row;
    });
    return { filename, headers, rows };
  }
  if (kind === 'daily') {
    const rows = buckets(orders, range.fromMs, range.toMs, 'day').map((b) => [dayKey(b.start), b.orders, b.salesOrders, b.sales]);
    return { filename, headers: ['Date (Dhaka)', 'Orders', 'Counted orders', 'Sales'], rows };
  }
  if (kind === 'products') {
    const rows = topProducts(orders, { limit: Infinity, by: 'revenue' }).map((p) => [p.name, p.qty, p.revenue]);
    return { filename, headers: ['Product', 'Units', 'Sales'], rows };
  }
  return null;
}

/** One audit entry for a bulk export. The file is only handed over once this has been written. */
export function planReportExport({ kind, count = 0, range, actor }) {
  if (!actor || !roleCan(actor.role, REPORT.READ) || !roleCan(actor.role, REPORT.EXPORT)) return fail('forbidden');
  if (!EXPORT_KINDS.includes(kind) || !Number.isInteger(count) || count < 0 || !range || !range.fromKey || !range.toKey) return fail('invalid');
  if (count === 0) return fail('empty');
  return {
    ok: true, action: 'report.export',
    ops: [auditOp(actor, {
      action: 'report.export', entity: 'report', entityId: kind,
      summary: `Exported the ${kind} report (${count} rows) for ${range.fromKey} to ${range.toKey}`,
      before: null, after: { kind, count, from: range.fromKey, to: range.toKey },
    })],
  };
}
