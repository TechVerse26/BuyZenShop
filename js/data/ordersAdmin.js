/*
 * Staff-side order queries (used by Orders, Customers, Dashboard and Reports).
 *
 * Two shapes live in the `orders` collection (see shared/orderModel.js):
 *   v2      createdAt = Timestamp      → queried with createdAt
 *   legacy  timestamp  = ISO string    → queried with timestamp
 * Every function runs both queries and returns merged, normalised orders (newest first), so legacy
 * orders keep showing up in lists and reports. No composite indexes are needed: each query uses a
 * single field for the range and ordering; everything else is filtered in memory.
 */
import { listDocs, getDocDataSafe } from './db.js';
import { Timestamp } from '../core/firebase.js';
import { normalizeOrder } from '../shared/orderModel.js';
import { LIMITS } from '../shared/constants.js';

const norm = (d) => { const { id, ...rest } = d; return normalizeOrder(id, rest); };

function merge(a, b, limit) {
  const seen = new Set();
  const out = [];
  for (const o of [...a, ...b]) { if (seen.has(o.id)) continue; seen.add(o.id); out.push(o); }
  out.sort((x, y) => (y.createdAtMs || 0) - (x.createdAtMs || 0));
  return limit ? out.slice(0, limit) : out;
}

/** Newest orders across both shapes. */
export async function fetchRecentOrders({ limit = 200 } = {}) {
  const [v2, legacy] = await Promise.all([
    listDocs('orders', { orderBy: [['createdAt', 'desc']], limit }),
    listDocs('orders', { orderBy: [['timestamp', 'desc']], limit }),
  ]);
  return merge(v2.docs.map(norm), legacy.docs.map(norm), limit);
}

/** Orders created within [fromMs, toMs] (inclusive). Capped at LIMITS.REPORT_MAX_ORDERS per shape. */
export async function fetchOrdersBetween(fromMs, toMs, { limit = LIMITS.REPORT_MAX_ORDERS } = {}) {
  const [v2, legacy] = await Promise.all([
    listDocs('orders', { where: [['createdAt', '>=', Timestamp.fromMillis(fromMs)], ['createdAt', '<=', Timestamp.fromMillis(toMs)]], orderBy: [['createdAt', 'desc']], limit }),
    listDocs('orders', { where: [['timestamp', '>=', new Date(fromMs).toISOString()], ['timestamp', '<=', new Date(toMs).toISOString()]], orderBy: [['timestamp', 'desc']], limit }),
  ]);
  const truncated = v2.size >= limit || legacy.size >= limit;
  return { orders: merge(v2.docs.map(norm), legacy.docs.map(norm)), truncated };
}

export async function fetchOrder(id) {
  const d = await getDocDataSafe(`orders/${id}`);
  return d ? norm(d) : null;
}

export async function fetchOrdersByUser(uid, { limit = 100 } = {}) {
  const { docs } = await listDocs('orders', { where: [['userId', '==', uid]], limit });
  return docs.map(norm).sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

/** Fresh inventory documents for an order's lines, as { key: invDoc } (what the order planners need). */
export async function fetchInventoryForOrder(order) {
  const out = {};
  await Promise.all(order.items.map(async (l) => {
    const d = await getDocDataSafe(`inventory/${l.key}`);
    if (d) { const { id, ...rest } = d; out[l.key] = rest; }
  }));
  return out;
}

/** Timeline entries (all visibilities) for an order, oldest first. */
export async function fetchOrderEvents(orderId) {
  const { docs } = await listDocs(`orders/${orderId}/events`);
  return docs.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
}
