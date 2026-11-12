/*
 * Customer-side order operations.
 *
 *   quoteOrder({ uid, lines, zone, couponCode })    live totals for the checkout page (fresh inventory + coupon)
 *   placeOrder({ … })                               builds the atomic write set (shared/orderBuilder) and commits it
 *   listMyOrders() / getMyOrder(id) / listOrderEvents(id) / watchMyOrder(id, cb)
 *   cancelMyOrder(order, reason) / requestReturn(order, {lines, reason, details}) / resubmitPayment(order, {trxId, senderNumber})
 *
 * Prices, stock and coupons are NEVER taken from the cart or the page: every write re-reads the
 * inventory / coupon documents, and firestore.rules re-derive the same numbers before accepting the batch.
 */
import { getDocData, getDocDataSafe, listDocs, watchDoc } from './db.js';
import { commitAtomic } from './write.js';
import { settings } from './settings.js';
import { buildOrder, OrderBuildError } from '../shared/orderBuilder.js';
import { computeTotals, effectivePrice } from '../shared/pricing.js';
import { makeOrderNumber, normalizeCouponCode, normalizePhone, normalizeTrxId } from '../shared/id.js';
import { normalizeOrder } from '../shared/orderModel.js';
import { planCustomerCancel, planCustomerReturn } from '../shared/orderFlow.js';
import { TS } from '../shared/ops.js';
import { PATTERNS } from '../shared/constants.js';
import { AppError, isPermissionDenied, explainError } from '../core/errors.js';
import { registerBoth, t } from '../core/i18n.js';
import { serializeDoc } from './db.js';
import { money } from '../core/format.js';

registerBoth({
  'order.err.auth': ['Sign in to place an order.', 'অর্ডার করতে লগইন করুন।'],
  'order.err.empty': ['Your cart is empty.', 'আপনার কার্ট খালি।'],
  'order.err.too_many_lines': ['You can order at most {max} different items at a time.', 'একবারে সর্বোচ্চ {max}টি ভিন্ন পণ্য অর্ডার করা যায়।'],
  'order.err.zone': ['We do not deliver to this district yet.', 'এই জেলায় এখনও ডেলিভারি দেওয়া হচ্ছে না।'],
  'order.err.phone': ['Enter a valid Bangladeshi mobile number (01XXXXXXXXX).', 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন (০১XXXXXXXXX)।'],
  'order.err.unavailable': ['An item in your cart is no longer available. Please review your cart.', 'কার্টের একটি পণ্য আর পাওয়া যাচ্ছে না। কার্ট দেখে নিন।'],
  'order.err.qty': ['Quantity must be at least 1.', 'পরিমাণ কমপক্ষে ১ হতে হবে।'],
  'order.err.max_per_order': ['You asked for more than the per-order limit of an item. Lower the quantity.', 'একটি পণ্যের প্রতি অর্ডারের সীমার বেশি চেয়েছেন। পরিমাণ কমান।'],
  'order.err.stock': ['Not enough stock for an item. Lower the quantity or remove it.', 'একটি পণ্যের স্টক যথেষ্ট নেই। পরিমাণ কমান বা পণ্যটি সরান।'],
  'order.err.coupon': ['This coupon cannot be applied to your order.', 'এই কুপন আপনার অর্ডারে প্রযোজ্য নয়।'],
  'order.err.trx': ['Enter the transaction ID from your payment message (6–20 letters or digits).', 'পেমেন্ট মেসেজের ট্রানজেকশন আইডি দিন (৬–২০টি অক্ষর/সংখ্যা)।'],
  'order.err.sender': ['Enter the mobile number you paid from.', 'যে নম্বর থেকে টাকা পাঠিয়েছেন সেটি দিন।'],
  'order.err.method': ['Choose a payment method.', 'পেমেন্ট পদ্ধতি বেছে নিন।'],
  'order.err.changed': ['Prices or stock changed while you were checking out. We refreshed them — please review and confirm again.', 'চেকআউটের সময় দাম বা স্টক বদলে গেছে। আমরা হালনাগাদ করেছি — দেখে আবার নিশ্চিত করুন।'],
  'order.err.cooldown': ['Please wait a few seconds before placing another order.', 'আরেকটি অর্ডারের আগে কয়েক সেকেন্ড অপেক্ষা করুন।'],
  'order.err.restricted': ['Online ordering is not available for this account. Please contact support.', 'এই অ্যাকাউন্টে অনলাইন অর্ডার বন্ধ আছে। সাপোর্টে যোগাযোগ করুন।'],
  'order.err.trxUsed': ['This transaction ID was not accepted — it is probably already attached to another order. Check the TrxID in your payment message.', 'এই ট্রানজেকশন আইডি গ্রহণ করা যায়নি — সম্ভবত এটি আগেই অন্য অর্ডারে ব্যবহার হয়েছে। পেমেন্ট মেসেজের TrxID আবার দেখুন।'],
  'coupon.not_found': ['That coupon code does not exist.', 'এই কুপন কোডটি নেই।'],
  'coupon.inactive': ['This coupon is not active.', 'এই কুপনটি সক্রিয় নয়।'],
  'coupon.not_started': ['This coupon is not valid yet.', 'এই কুপনটি এখনও চালু হয়নি।'],
  'coupon.expired': ['This coupon has expired.', 'এই কুপনের মেয়াদ শেষ।'],
  'coupon.min_order': ['Spend at least {min} to use this coupon.', 'এই কুপন ব্যবহারে কমপক্ষে {min} কেনাকাটা করতে হবে।'],
  'coupon.customer_only': ['This coupon is not available for your account.', 'এই কুপনটি আপনার অ্যাকাউন্টের জন্য নয়।'],
  'coupon.usage_limit': ['This coupon has reached its usage limit.', 'এই কুপনের ব্যবহারের সীমা শেষ।'],
  'coupon.per_customer_limit': ['You have already used this coupon.', 'আপনি এই কুপন আগেই ব্যবহার করেছেন।'],
  'coupon.no_eligible_items': ['No item in your cart is eligible for this coupon.', 'আপনার কার্টের কোনো পণ্য এই কুপনের আওতায় পড়ে না।'],
  'coupon.signin': ['Sign in to use a coupon.', 'কুপন ব্যবহার করতে লগইন করুন।'],
});

export function couponMessage(reason, extra = {}) {
  const key = `coupon.${reason}`;
  return t(key, { min: extra.min !== undefined ? money(extra.min) : '' }, t('order.err.coupon'));
}

/* ───────────────────────── fresh data for a quote / order ───────────────────────── */

async function loadFresh({ uid, lines, couponCode }) {
  const keys = lines.map((l) => l.key);
  const invDocs = await Promise.all(keys.map((k) => getDocDataSafe(`inventory/${k}`)));
  const invByKey = {};
  keys.forEach((k, i) => { if (invDocs[i]) { const { id, ...rest } = invDocs[i]; invByKey[k] = rest; } });
  let coupon = null; let usageCount = null;
  const code = normalizeCouponCode(couponCode);
  if (code && PATTERNS.couponCode.test(code) && uid) {
    coupon = await getDocDataSafe(`coupons/${code}`);
    if (coupon) {
      const u = await getDocDataSafe(`couponUsage/${code}__${uid}`);
      usageCount = u ? u.count || 0 : null;
    }
  }
  return { invByKey, coupon, usageCount, code };
}

/**
 * Totals for the checkout page. Never throws for business problems; returns { ok, issues, totals, coupon }.
 * @param {{uid:string, lines:Array<{key,qty,name?}>, zone:object|null, couponCode?:string}} p
 */
export async function quoteOrder({ uid, lines, zone, couponCode = '' }) {
  const fresh = await loadFresh({ uid, lines, couponCode });
  const nowMs = Date.now();
  const issues = [];
  const priced = [];
  for (const l of lines) {
    const inv = fresh.invByKey[l.key];
    if (!inv || inv.active !== true) { issues.push({ key: l.key, code: 'unavailable' }); continue; }
    if (inv.track === true && inv.allowBackorder !== true && (inv.reserved || 0) + l.qty > (inv.stock || 0)) issues.push({ key: l.key, code: 'stock', available: Math.max(0, (inv.stock || 0) - (inv.reserved || 0)) });
    if (l.qty > inv.maxPerOrder) issues.push({ key: l.key, code: 'max_per_order', max: inv.maxPerOrder });
    priced.push({ key: l.key, productId: inv.productId, categoryId: inv.categoryId || '', unitPrice: effectivePrice(inv, nowMs), regularPrice: inv.price, qty: l.qty });
  }
  if (!zone) return { ok: false, issues, totals: null, coupon: { ok: false, reason: 'none' }, invByKey: fresh.invByKey };
  const calc = computeTotals({ lines: priced, coupon: fresh.coupon ? { ...fresh.coupon, code: fresh.code } : null, zone, nowMs, uid, usedByUser: fresh.usageCount || 0 });
  let couponState = calc.coupon;
  if (couponCode && !fresh.coupon) couponState = { ok: false, reason: 'not_found' };
  return { ok: issues.length === 0 && (!couponCode || couponState.ok), issues, totals: calc.totals, coupon: couponState, lines: calc.lines, invByKey: fresh.invByKey };
}

/* ───────────────────────── place order ───────────────────────── */

/**
 * @param {object} i
 * @param {string} i.uid
 * @param {{name,phone,email?}} i.customer
 * @param {object} i.address     { name, phone, district, upazila?, area?, postalCode?, line1, notes? }
 * @param {object} i.zone        shipping zone (zoneForDistrict result)
 * @param {Array<{key,qty,name,variantLabel?,image?,sku?}>} i.lines
 * @param {string} [i.couponCode]
 * @param {string} [i.orderNumber]   reuse the number of an earlier attempt (retry after a lost response)
 * @param {number} [i.expectTotal]   the total the customer was shown; a different fresh total aborts with code "changed"
 *                                   Errors thrown after the batch was sent carry `attempted: true` (the order may still have been written).
 * @param {{method:'cod'|'bkash'|'nagad', trxId?:string, senderNumber?:string}} i.payment
 * @param {string} [i.note]
 * @returns {Promise<{orderNumber:string, totals:object, order:object}>}
 */
export async function placeOrder(i) {
  const fresh = await loadFresh({ uid: i.uid, lines: i.lines, couponCode: i.couponCode });
  if (i.couponCode && !fresh.coupon) throw new AppError('coupon', couponMessage('not_found'), { reason: 'not_found' });
  // A caller that retries after a lost response passes the same order number, so one click can never become two orders.
  const orderNumber = i.orderNumber && PATTERNS.orderNumber.test(i.orderNumber) ? i.orderNumber : makeOrderNumber(settings().orderPrefix || 'SV');
  let built;
  try {
    built = buildOrder({
      uid: i.uid, orderNumber, nowMs: Date.now(), customer: i.customer, address: i.address, zone: i.zone,
      lines: i.lines.map((l) => ({ key: l.key, inv: fresh.invByKey[l.key], qty: l.qty, name: l.name, variantLabel: l.variantLabel, image: l.image, sku: l.sku })),
      coupon: fresh.coupon ? { ...fresh.coupon, code: fresh.code } : null, couponUsageCount: fresh.usageCount,
      payment: i.payment, note: i.note,
    });
  } catch (e) { throw translateBuildError(e); }
  // Never charge a total the customer has not seen: if prices, stock-based sale windows or the coupon moved since the last quote, stop and let them re-confirm.
  if (i.expectTotal != null && built.totals.total !== i.expectTotal) throw new AppError('changed', t('order.err.changed'), { refresh: true });
  try {
    await commitAtomic(built.ops);
  } catch (e) { throw await explainCommitFailure(e, i); }
  return { orderNumber, totals: built.totals, order: built.order };
}

function translateBuildError(e) {
  if (!(e instanceof OrderBuildError)) return e;
  const key = `order.err.${e.code}`;
  const msg = e.code === 'coupon' ? couponMessage(e.reason, { min: e.min }) : t(key, { max: e.max ?? '', n: e.available ?? '' }, e.message);
  return new AppError(e.code, msg, { key: e.key, reason: e.reason, available: e.available, max: e.max });
}

/**
 * A rejected batch (permission-denied) after the order was just built from fresh prices and stock is almost always:
 * a restricted account, the 15 s cooldown, or — for bKash / Nagad — a TrxID that is already attached to another order.
 * Customers cannot read paymentTrx (that would let anyone probe other people's payments), so the last case is inferred.
 */
async function explainCommitFailure(e, i) {
  const attempted = { attempted: true };                       // the batch may or may not have reached the server
  if (!isPermissionDenied(e)) return new AppError(e.code || 'commit', explainError(e), attempted);
  try {
    const profile = await getDocDataSafe(`users/${i.uid}`);
    if (profile && profile.restricted === true) return new AppError('restricted', t('order.err.restricted'), attempted);
    const last = profile && profile.lastOrderAt && profile.lastOrderAt.toMillis ? profile.lastOrderAt.toMillis() : 0;
    if (last && Date.now() - last < 16000) return new AppError('cooldown', t('order.err.cooldown'), attempted);
  } catch { /* fall through */ }
  if (i.payment && i.payment.trxId) return new AppError('trx_used', t('order.err.trxUsed'), attempted);
  return new AppError('changed', t('order.err.changed'), { ...attempted, refresh: true });
}

/* ───────────────────────── my orders ───────────────────────── */

export async function listMyOrders(uid, { limit = 100 } = {}) {
  // No orderBy on purpose: legacy orders have no createdAt, and a plain equality query needs no composite index.
  const { docs } = await listDocs('orders', { where: [['userId', '==', uid]], limit });
  return docs.map((d) => { const { id, ...rest } = d; return normalizeOrder(id, rest); })
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}
export async function getMyOrder(id) {
  const d = await getDocDataSafe(`orders/${id}`);
  if (!d) return null;
  const { id: _id, ...rest } = d;
  return normalizeOrder(id, rest);
}
export function watchMyOrder(id, cb, onError) {
  return watchDoc(`orders/${id}`, (d) => { if (!d) return cb(null); const { id: _i, ...rest } = d; cb(normalizeOrder(id, rest)); }, onError);
}
/** Customer-visible timeline entries (oldest first). */
export async function listOrderEvents(orderId, uid) {
  const { docs } = await listDocs(`orders/${orderId}/events`, { where: [['userId', '==', uid], ['visibility', '==', 'customer']] });
  return docs.map(serializeDoc).sort((a, b) => (a.createdAt?.ms || 0) - (b.createdAt?.ms || 0));
}

async function freshInventoryFor(order) {
  const entries = await Promise.all(order.items.map(async (l) => [l.key, await getDocDataSafe(`inventory/${l.key}`)]));
  const invByKey = {};
  for (const [k, d] of entries) if (d) { const { id, ...rest } = d; invByKey[k] = rest; }
  return invByKey;
}

export async function cancelMyOrder(order, uid, reason = '') {
  const invByKey = await freshInventoryFor(order);
  const plan = planCustomerCancel({ order, uid, reason, invByKey });
  if (!plan.ok) throw new AppError(plan.error, plan.message);
  try { await commitAtomic(plan.ops); } catch (e) { throw new AppError(e.code || 'commit', explainError(e)); }
}

/** Days after delivery during which a return can be requested (settings → checkout.returnWindowDays, default 7). The window is enforced here and in the UI, not by the rules. */
export const returnWindowDays = () => Math.max(1, Number((settings().checkout || {}).returnWindowDays) || 7);

export async function requestReturn(order, uid, { lines, reason, details = '' }) {
  const plan = planCustomerReturn({ order, uid, lines, reason, details, nowMs: Date.now(), windowDays: returnWindowDays() });
  if (!plan.ok) throw new AppError(plan.error, plan.message);
  try { await commitAtomic(plan.ops); } catch (e) { throw new AppError(e.code || 'commit', explainError(e)); }
}

/** After staff mark a manual payment "failed", the customer can submit a corrected TrxID. */
export async function resubmitPayment(order, uid, { trxId, senderNumber }) {
  const trx = normalizeTrxId(trxId);
  const sender = normalizePhone(senderNumber);
  if (!PATTERNS.trxId.test(trx)) throw new AppError('trx', t('order.err.trx'));
  if (!sender) throw new AppError('sender', t('order.err.sender'));
  if (order.payment.method === 'cod' || order.payment.status !== 'failed' || order.status !== 'pending') throw new AppError('state', t('common.error'));
  const ops = [
    { op: 'update', path: `orders/${order.id}`, data: { payment: { method: order.payment.method, status: 'awaiting_verification', trxId: trx, senderNumber: sender, amountDue: order.payment.amountDue }, updatedAt: TS } },
    { op: 'set', path: `paymentTrx/${trx}`, data: { orderId: order.id, userId: uid, method: order.payment.method, createdAt: TS } },
  ];
  try { await commitAtomic(ops); } catch (e) {
    if (isPermissionDenied(e)) throw new AppError('trx_used', t('order.err.trxUsed'));
    throw new AppError(e.code || 'commit', explainError(e));
  }
}
