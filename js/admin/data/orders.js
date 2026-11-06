/*
 * Staff-side order reads and actions for the admin pages.
 *
 *   await fetchOrdersFiltered({ status, payment, from, to })    → { orders, truncated }   (exhaustive for a status / payment filter)
 *   await changeStatus(order, 'shipped', { carrier, trackingNo })     one atomic batch: order + stock + timeline + notification + audit
 *   await verifyPayment(order, { receivedAmount, note }) / rejectPayment(order, { note }) / markCodPaid(order)
 *   await refundOrder(order, { amount, method, note })
 *   await addOrderNote(order, { text, visibility }) / updateTracking(order, shipping)
 *
 * Every action re-reads the inventory it touches, asks the pure planner in shared/orderFlow.js for the writes and commits
 * them in ONE batch; the planner's refusals become bilingual AppErrors. firestore.rules re-check the same things.
 */
import { listDocs } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { fetchRecentOrders, fetchOrdersBetween, fetchInventoryForOrder } from '../../data/ordersAdmin.js';
import { invalidateCatalog } from '../../data/catalog.js';
import { normalizeOrder } from '../../shared/orderModel.js';
import { planStatusChange, planPaymentAction, planRefund, planOrderNote, planShippingUpdate } from '../../shared/orderFlow.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t, has } from '../../core/i18n.js';
import { invalidateAdminCatalog } from './catalogAdmin.js';

registerBoth({
  'oe.forbidden': ['Your role cannot do this.', 'আপনার রোল দিয়ে এটি করা যাবে না।'],
  'oe.invalid_transition': ['This order cannot move to that status from where it is now.', 'অর্ডারটি এখন যে ধাপে আছে সেখান থেকে ওই ধাপে যাওয়া যায় না।'],
  'oe.already_shipped': ['A shipped order cannot be cancelled. Use the return flow instead.', 'পাঠানো অর্ডার বাতিল করা যায় না। রিটার্ন প্রক্রিয়া ব্যবহার করুন।'],
  'oe.wrong_state': ['The order is not in a state where this can be done.', 'অর্ডারটি এখন এমন অবস্থায় নেই যেখানে এটি করা যায়।'],
  'oe.amount': ['The amount is not valid for this order.', 'পরিমাণটি এই অর্ডারের জন্য সঠিক নয়।'],
  'oe.legacy': ['This is an order from the old site; it can only be viewed here.', 'এটি পুরনো সাইটের অর্ডার; এখানে শুধু দেখা যায়।'],
  'oe.closed_order': ['This order is closed.', 'এই অর্ডার বন্ধ হয়ে গেছে।'],
  'oe.cod': ['Cash on delivery is marked paid when the cash is collected.', 'ক্যাশ অন ডেলিভারির টাকা আদায় হলে "পরিশোধিত" চিহ্নিত করুন।'],
  'oe.empty': ['Fill in the details first.', 'আগে তথ্য লিখুন।'],
  'oe.too_long': ['The text is too long.', 'লেখাটি অনেক বড়।'],
  'oe.bad_url': ['The tracking link must start with http:// or https://', 'ট্র্যাকিং লিংক http:// বা https:// দিয়ে শুরু হতে হবে।'],
});

const norm = (d) => { const { id, ...rest } = d; return normalizeOrder(id, rest); };
/** The pre-upgrade site stored statuses capitalised ("Pending", "Delivered"). */
const legacyStatus = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const RECENT_LIMIT = 300;

/**
 * Orders for the list page. A status or payment filter runs as an equality query, so it finds EVERY such order (up to `limit`),
 * however old; a date range uses the created-at range; with no filter the latest RECENT_LIMIT orders are returned.
 */
export async function fetchOrdersFiltered({ status = '', payment = '', from = null, to = null, limit = 500 } = {}) {
  const keep = (o) => (!status || o.status === status) && (!payment || o.payment.status === payment);
  if (from != null || to != null) {
    const res = await fetchOrdersBetween(from ?? 0, to ?? Date.now());
    return { orders: res.orders.filter(keep), truncated: res.truncated };
  }
  if (status || payment) {
    const jobs = status
      ? [listDocs('orders', { where: [['status', '==', status]], limit }), listDocs('orders', { where: [['status', '==', legacyStatus(status)]], limit })]
      : [listDocs('orders', { where: [['payment.status', '==', payment]], limit })];
    const parts = await Promise.all(jobs);
    const seen = new Set();
    const orders = [];
    for (const p of parts) for (const d of p.docs) { if (!seen.has(d.id)) { seen.add(d.id); orders.push(norm(d)); } }
    orders.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    return { orders: orders.filter(keep), truncated: parts.some((p) => p.size >= limit) };
  }
  const orders = await fetchRecentOrders({ limit: RECENT_LIMIT });
  return { orders, truncated: orders.length >= RECENT_LIMIT };
}

/* ───────────────────────── actions ───────────────────────── */

function explain(res) {
  const key = `oe.${res.error}`;
  return new AppError(res.error, has(key) ? t(key) : res.message || res.error);
}

async function commit(res, { stock = false } = {}) {
  if (!res.ok) throw explain(res);
  await commitAtomic(res.ops);
  if (stock || res.stockTouched) { invalidateAdminCatalog(); invalidateCatalog(); }
  return res;
}

export async function changeStatus(order, to, options = {}) {
  const invByKey = await fetchInventoryForOrder(order);
  return commit(planStatusChange({ order, to, actor: actor(), nowMs: Date.now(), invByKey, options }));
}

export const verifyPayment = (order, { receivedAmount, note = '' }) => commit(planPaymentAction({ order, action: 'verify', actor: actor(), nowMs: Date.now(), receivedAmount, note }));
export const rejectPayment = (order, { note = '' }) => commit(planPaymentAction({ order, action: 'reject', actor: actor(), nowMs: Date.now(), note }));
export const markCodPaid = (order) => commit(planPaymentAction({ order, action: 'cod_paid', actor: actor(), nowMs: Date.now() }));
export const refundOrder = (order, { amount, method, note = '' }) => commit(planRefund({ order, actor: actor(), amount, method, note }));
export const addOrderNote = (order, { text, visibility = 'internal' }) => commit(planOrderNote({ order, actor: actor(), text, visibility }));
export const updateTracking = (order, shipping) => commit(planShippingUpdate({ order, actor: actor(), shipping }));
