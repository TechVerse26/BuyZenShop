/*
 * Builds the complete, atomic write set for placing an order.
 *
 * The write set is exactly what firestore.rules expects (see the header of that file):
 *   - one `inventory/{lineKey}` update per line (reserve stock + bind it to this order),
 *   - optional coupon counter + per-customer usage record,
 *   - optional `paymentTrx/{TRXID}` uniqueness record (manual bKash / Nagad),
 *   - `users/{uid}.lastOrderAt` stamp (cooldown / restricted-account gate),
 *   - the order document itself, with prices and totals re-derived from the inventory documents.
 *
 * Pure function: no I/O. Used by js/data/orders.js (browser) and by the rules tests.
 */

import { APP, LIMITS, PATTERNS } from './constants.js';
import { computeTotals, effectivePrice, lineEligible } from './pricing.js';
import { TS, inc, clean } from './ops.js';
import { normalizePhone, normalizeTrxId, normalizeCouponCode, lineKey as makeKey } from './id.js';

const clip = (v, n) => String(v ?? '').slice(0, n);

export class OrderBuildError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

/**
 * @param {object} i
 * @param {string} i.uid
 * @param {string} i.orderNumber                  document id, PREFIX-yymmdd-XXXXXX
 * @param {number} i.nowMs
 * @param {{name,phone,email?}} i.customer
 * @param {{name,phone,district,upazila?,area?,postalCode?,line1,notes?}} i.address
 * @param {{id,name,districts,fee,freeOver?,active}} i.zone
 * @param {Array<{key,inv,qty,name,variantLabel?,image?,sku?}>} i.lines   inv = inventory document data
 * @param {object|null} i.coupon                  coupon document data (with .code) or null
 * @param {number|null} i.couponUsageCount        existing couponUsage.count, or null when none exists
 * @param {{method,trxId?,senderNumber?}} i.payment
 * @param {string} [i.note]
 */
export function buildOrder(i) {
  const { uid, orderNumber, nowMs } = i;
  if (!uid) throw new OrderBuildError('auth', 'Sign in to place an order.');
  if (!PATTERNS.orderNumber.test(orderNumber)) throw new OrderBuildError('order_number', 'Bad order number.');
  if (!i.lines || i.lines.length < 1) throw new OrderBuildError('empty', 'Cart is empty.');
  if (i.lines.length > LIMITS.MAX_LINES) throw new OrderBuildError('too_many_lines', `You can order at most ${LIMITS.MAX_LINES} different items at a time.`, { max: LIMITS.MAX_LINES });
  if (!i.zone || i.zone.active === false) throw new OrderBuildError('zone', 'We do not deliver to this district yet.');
  if (!(i.zone.districts || []).includes(i.address.district)) throw new OrderBuildError('zone', 'We do not deliver to this district yet.');

  const phone = normalizePhone(i.customer.phone);
  const addrPhone = normalizePhone(i.address.phone || i.customer.phone);
  if (!phone) throw new OrderBuildError('phone', 'Enter a valid Bangladeshi mobile number (01XXXXXXXXX).');
  if (!addrPhone) throw new OrderBuildError('phone', 'Enter a valid delivery phone number.');

  /* ---- lines: re-price from the inventory documents ---- */
  const priced = i.lines.map((l) => {
    const inv = l.inv;
    if (!inv || inv.active !== true) throw new OrderBuildError('unavailable', `${l.name} is no longer available.`, { key: l.key });
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new OrderBuildError('qty', 'Quantity must be at least 1.', { key: l.key });
    if (l.qty > inv.maxPerOrder || l.qty > LIMITS.MAX_QTY_PER_LINE) throw new OrderBuildError('max_per_order', `Maximum ${Math.min(inv.maxPerOrder, LIMITS.MAX_QTY_PER_LINE)} per order for ${l.name}.`, { key: l.key, max: inv.maxPerOrder });
    if (inv.track === true && inv.allowBackorder !== true && (inv.reserved || 0) + l.qty > (inv.stock || 0)) {
      throw new OrderBuildError('stock', `Only ${Math.max(0, (inv.stock || 0) - (inv.reserved || 0))} left of ${l.name}.`, { key: l.key, available: Math.max(0, (inv.stock || 0) - (inv.reserved || 0)) });
    }
    const expectedKey = makeKey(inv.productId, inv.variantId ?? null);
    if (expectedKey !== l.key) throw new OrderBuildError('key', 'Cart line does not match the product.', { key: l.key });
    return {
      key: l.key,
      productId: inv.productId,
      variantId: inv.variantId ?? null,
      categoryId: inv.categoryId || '',
      unitPrice: effectivePrice(inv, nowMs),
      regularPrice: inv.price,
      qty: l.qty,
      inv,
      meta: l,
    };
  });
  if (new Set(priced.map((p) => p.key)).size !== priced.length) throw new OrderBuildError('duplicate', 'Duplicate cart lines.');

  /* ---- coupon / totals ---- */
  const couponCode = i.coupon ? normalizeCouponCode(i.coupon.code) : '';
  const calc = computeTotals({
    lines: priced, coupon: i.coupon || null, zone: i.zone, nowMs, uid,
    usedByUser: i.couponUsageCount || 0,
  });
  if (i.coupon && !calc.coupon.ok) throw new OrderBuildError('coupon', 'Coupon cannot be applied.', { reason: calc.coupon.reason, min: calc.coupon.min });
  const totals = calc.totals;

  /* ---- payment ---- */
  const method = i.payment?.method;
  let payment;
  if (method === 'cod') {
    payment = { method, status: 'unpaid', trxId: '', senderNumber: '', amountDue: totals.total };
  } else if (method === 'bkash' || method === 'nagad') {
    const trxId = normalizeTrxId(i.payment.trxId);
    const sender = normalizePhone(i.payment.senderNumber);
    if (!PATTERNS.trxId.test(trxId)) throw new OrderBuildError('trx', 'Enter the transaction ID shown in your payment message (6–20 letters/digits).');
    if (!sender) throw new OrderBuildError('sender', 'Enter the mobile number you paid from.');
    payment = { method, status: 'awaiting_verification', trxId, senderNumber: sender, amountDue: totals.total };
  } else {
    throw new OrderBuildError('method', 'Choose a payment method.');
  }

  /* ---- order document (key set must equal the rules' allow-list) ---- */
  const items = {};
  const itemOrder = [];
  for (const p of priced) {
    items[p.key] = {
      productId: p.productId,
      variantId: p.variantId,
      sku: clip(p.meta.sku ?? p.inv.sku ?? '', 60),
      name: clip(p.meta.name, 200),
      variantLabel: clip(p.meta.variantLabel ?? '', 120),
      unitPrice: p.unitPrice,
      regularPrice: p.regularPrice,
      qty: p.qty,
      lineTotal: p.unitPrice * p.qty,
      image: clip(p.meta.image ?? '', 600),
      categoryId: clip(p.categoryId, 60),
    };
    itemOrder.push(p.key);
  }

  const a = i.address;
  const order = {
    schemaVersion: APP.schemaVersion,
    orderNumber,
    userId: uid,
    customer: { name: clip(i.customer.name, 80).trim(), phone, email: clip(i.customer.email ?? '', 120).trim() },
    address: {
      name: clip(a.name || i.customer.name, 80).trim(),
      phone: addrPhone,
      district: a.district,
      upazila: clip(a.upazila, 60),
      area: clip(a.area, 80),
      postalCode: clip(a.postalCode, 10),
      line1: clip(a.line1, 300).trim(),
      notes: clip(a.notes, 200),
    },
    zoneId: i.zone.id,
    zoneName: i.zone.name,
    items,
    itemOrder,
    totals,
    couponCode,
    payment,
    status: 'pending',
    notes: { customer: clip(i.note, 300) },
    createdAt: TS,
    updatedAt: TS,
  };

  /* ---- atomic write set ---- */
  const ops = [];
  for (const p of priced) {
    ops.push({
      op: 'update',
      path: `inventory/${p.key}`,
      data: p.inv.track === true ? { reserved: inc(p.qty), lastOrderId: orderNumber } : { lastOrderId: orderNumber },
    });
  }
  if (couponCode) {
    ops.push({ op: 'update', path: `coupons/${couponCode}`, data: { usedCount: inc(1), lastOrderId: orderNumber } });
    const usagePath = `couponUsage/${couponCode}__${uid}`;
    ops.push(i.couponUsageCount == null
      ? { op: 'set', path: usagePath, data: { code: couponCode, userId: uid, count: 1, lastOrderId: orderNumber, updatedAt: TS } }
      : { op: 'update', path: usagePath, data: { count: i.couponUsageCount + 1, lastOrderId: orderNumber, updatedAt: TS } });
  }
  if (payment.trxId) {
    ops.push({ op: 'set', path: `paymentTrx/${payment.trxId}`, data: { orderId: orderNumber, userId: uid, method: payment.method, createdAt: TS } });
  }
  ops.push({ op: 'update', path: `users/${uid}`, data: { lastOrderAt: TS } });
  ops.push({ op: 'set', path: `orders/${orderNumber}`, data: order });

  return { orderNumber, order: clean(order), totals, ops: ops.map((o) => ({ ...o, data: clean(o.data) })), lines: priced };
}

/** Re-exported for UI code that previews eligibility per line. */
export { lineEligible };
