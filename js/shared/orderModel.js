/*
 * Uniform in-memory view of an order document.
 *
 * Two shapes exist in Firestore:
 *   schemaVersion 2  – written by this code base (items map + itemOrder, totals, payment object …)
 *   legacy (no schemaVersion) – written by the pre-upgrade site (items array, subtotal, totalAmount,
 *                      paymentMethod, transactionId, status "Pending"/"Delivered", ISO `timestamp`)
 * Every UI module reads orders through normalizeOrder(), so both shapes display and report correctly.
 * Legacy documents are never rewritten just to display them.
 */

import { toMillis } from './pricing.js';
import { ORDER_STATUS } from './constants.js';

const LEGACY_PAYMENT = { 'cash on delivery': 'cod', cod: 'cod', bkash: 'bkash', nagad: 'nagad' };

export function normalizeStatus(s) {
  const x = String(s ?? 'pending').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ORDER_STATUS[x] ? x : 'pending';
}

export function isLegacyOrder(data) {
  return !data || data.schemaVersion == null || data.schemaVersion < 2 || !data.itemOrder;
}

export function normalizeOrder(id, data) {
  return isLegacyOrder(data) ? fromLegacy(id, data || {}) : fromV2(id, data);
}

function fromV2(id, d) {
  const items = (d.itemOrder || []).map((k) => ({ key: k, ...d.items[k] }));
  return {
    id,
    orderNumber: d.orderNumber || id,
    isLegacy: false,
    schemaVersion: d.schemaVersion,
    userId: d.userId,
    customer: d.customer || {},
    address: d.address || {},
    zoneId: d.zoneId || '',
    zoneName: d.zoneName || '',
    items,
    totals: d.totals || { subtotal: 0, eligibleSubtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0 },
    couponCode: d.couponCode || '',
    payment: d.payment || { method: 'cod', status: 'unpaid', trxId: '', senderNumber: '', amountDue: d.totals?.total || 0 },
    status: normalizeStatus(d.status),
    notes: d.notes || {},
    shipping: d.shipping || null,
    refund: d.refund || null,
    cancelReason: d.cancelReason || '',
    createdAtMs: toMillis(d.createdAt),
    updatedAtMs: toMillis(d.updatedAt),
    confirmedAtMs: toMillis(d.confirmedAt),
    shippedAtMs: toMillis(d.shippedAt),
    deliveredAtMs: toMillis(d.deliveredAt),
    cancelledAtMs: toMillis(d.cancelledAt),
    returnRequestedAtMs: toMillis(d.returnRequestedAt),
    raw: d,
  };
}

function fromLegacy(id, d) {
  const items = (Array.isArray(d.items) ? d.items : []).map((it, i) => {
    const price = Number(it.price) || 0;
    const qty = Number(it.qty) || 1;
    return {
      key: it.id || String(i), productId: it.id || '', variantId: null, sku: '', name: it.name || 'Item', variantLabel: '',
      unitPrice: price, regularPrice: price, qty, lineTotal: price * qty, image: '', categoryId: '',
    };
  });
  const subtotal = Number(d.subtotal) || items.reduce((s, l) => s + l.lineTotal, 0);
  const discount = Number(d.discountAmount) || 0;
  const shipping = Number(d.deliveryCharge) || 0;
  const total = Number(d.totalAmount) || subtotal - discount + shipping;
  const method = LEGACY_PAYMENT[String(d.paymentMethod || 'cod').trim().toLowerCase()] || 'cod';
  const status = normalizeStatus(d.status);
  const trx = d.transactionId && d.transactionId !== 'N/A' ? String(d.transactionId) : '';
  const area = String(d.deliveryArea || '');
  const num = String(d.orderId || id).replace(/^order_/, '');
  const created = toMillis(d.timestamp);
  const voucher = d.voucherCode && d.voucherCode !== 'None' ? String(d.voucherCode) : '';
  return {
    id,
    orderNumber: num,
    isLegacy: true,
    schemaVersion: 1,
    userId: d.userId || '',
    customer: { name: d.customerName || d.userName || '', phone: d.customerPhone || '', email: d.userEmail && d.userEmail !== 'Mobile User' ? d.userEmail : '' },
    address: { name: d.customerName || '', phone: d.customerPhone || '', district: /^inside/i.test(area) ? 'Sirajganj' : '', line1: d.customerAddress || '' },
    zoneId: '',
    zoneName: area,
    items,
    totals: { subtotal, eligibleSubtotal: voucher ? subtotal : 0, discount, shipping, tax: 0, total },
    couponCode: voucher,
    payment: {
      method,
      status: method === 'cod' ? (status === 'delivered' ? 'paid' : 'unpaid') : 'awaiting_verification',
      trxId: trx, senderNumber: '', amountDue: total,
    },
    status,
    notes: {},
    shipping: null,
    refund: null,
    cancelReason: '',
    createdAtMs: created,
    updatedAtMs: created,
    confirmedAtMs: null, shippedAtMs: null, deliveredAtMs: status === 'delivered' ? created : null,
    cancelledAtMs: status === 'cancelled' ? created : null, returnRequestedAtMs: null,
    raw: d,
  };
}

/** Units across all lines. */
export const itemCount = (o) => o.items.reduce((s, l) => s + l.qty, 0);
