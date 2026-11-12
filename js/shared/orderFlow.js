/*
 * Order lifecycle planners.
 *
 * Each planX() function is pure: it takes the current order (normalizeOrder() shape), the actor
 * and fresh inventory documents, validates the request against the lifecycle rules and returns
 *   { ok: true, ops: [...], summary }  or  { ok: false, error: '<code>', message }
 * The ops are abstract writes (see ops.js) that are committed in ONE batch, so a status change, its
 * stock effect, the customer-visible timeline entry, the customer notification and the audit entry
 * either all happen or none do.
 *
 * Stock model
 *   • placing an order      → inventory.reserved += qty            (done by orderBuilder)
 *   • Shipped / Delivered   → stock -= qty, reserved -= qty        (physical deduction, once)
 *   • Cancelled (pre-ship)  → reserved -= qty                      (reservation released)
 *   • Returned + restock    → stock += qty
 * "Physical deduction happened" is derived from order.shippedAtMs, so it can never run twice.
 */

import { ORDER_TRANSITIONS, ORDER_STATUS, roleCan } from './constants.js';
import { TS, inc, clean } from './ops.js';
import { normalizeStatus } from './orderModel.js';
import { autoId } from './id.js';

const fail = (error, message) => ({ ok: false, error, message: message || error });

export function allowedNext(status) {
  return ORDER_TRANSITIONS[normalizeStatus(status)] || [];
}

export function requiredPermission(to) {
  if (to === 'cancelled') return 'orders.cancel';
  if (to === 'refund_pending' || to === 'refunded') return 'orders.refund';
  return 'orders.update';
}

/** Customers may cancel only a pending, unpaid, schema-2 order. */
export function customerCanCancel(o) {
  return !o.isLegacy && o.status === 'pending' && o.payment.status !== 'paid';
}

export function customerCanRequestReturn(o, nowMs = Date.now(), windowDays = 7) {
  if (o.isLegacy || o.status !== 'delivered' || !o.deliveredAtMs) return false;
  return nowMs - o.deliveredAtMs <= windowDays * 86400000;
}

export function trackedLines(o, invByKey) {
  return o.items.filter((l) => invByKey?.[l.key]?.track === true);
}

/* ───────────────────────── shared op builders ───────────────────────── */

export function catalogStampOp(nowMs) {
  return { op: 'set', path: 'meta/catalog', merge: true, data: { version: nowMs, updatedAt: TS } };
}

export function auditOp(actor, { action, entity, entityId, summary, before = null, after = null }) {
  return {
    op: 'set', path: `auditLogs/${autoId()}`,
    data: clean({
      actorUid: actor.uid, actorEmail: actor.email || '', actorRole: actor.role,
      action, entity, entityId, summary: String(summary).slice(0, 600), before, after, createdAt: TS,
    }),
  };
}

export function timelineOp(order, actor, { type, status = null, note = '', visibility = 'customer' }) {
  return {
    op: 'set', path: `orders/${order.id}/events/${autoId()}`,
    data: clean({
      type, status, note: String(note).slice(0, 500), visibility,
      userId: order.userId, actorUid: actor.uid, actorRole: actor.role, createdAt: TS,
    }),
  };
}

export function notificationOp(order, { title, body, kind = 'order' }) {
  if (!order.userId) return null;
  return {
    op: 'set', path: `users/${order.userId}/notifications/${autoId()}`,
    data: { title, body, kind, orderNumber: order.orderNumber, read: false, createdAt: TS },
  };
}

export function movementOp(actor, { key, inv, type, delta, reservedDelta = 0, orderNumber = '', note = '' }) {
  return {
    op: 'set', path: `inventoryMovements/${autoId()}`,
    data: clean({
      key, productId: inv.productId, variantId: inv.variantId ?? null, sku: inv.sku || '',
      type, delta, reservedDelta, refType: orderNumber ? 'order' : 'manual', refId: orderNumber, note: String(note).slice(0, 300),
      stockAfter: (inv.stock || 0) + delta, actorUid: actor.uid, actorEmail: actor.email || '', createdAt: TS,
    }),
  };
}

const STATUS_STAMP = { confirmed: 'confirmedAt', shipped: 'shippedAt', delivered: 'deliveredAt', cancelled: 'cancelledAt' };
/** order status chosen on a return request → status of returns/{id} */
const RETURN_DOC_STATUS = { refund_pending: 'approved', returned: 'received', delivered: 'rejected' };

/* ───────────────────────── staff: status change ───────────────────────── */

/**
 * @param {object} p
 * @param {object} p.order        normalizeOrder() result
 * @param {string} p.to           target status
 * @param {{uid,email,role}} p.actor
 * @param {number} p.nowMs
 * @param {Object<string,object>} p.invByKey   fresh inventory docs for the order's lines
 * @param {{note?:string, restock?:boolean, markCodPaid?:boolean, carrier?:string, trackingNo?:string, trackingUrl?:string, restoreCoupon?:boolean, cancelReason?:string, sendMail?:boolean}} [p.options]
 */
export function planStatusChange({ order, to, actor, nowMs, invByKey = {}, options = {} }) {
  const from = order.status;
  if (!ORDER_STATUS[to]) return fail('unknown_status');
  if (!allowedNext(from).includes(to)) return fail('invalid_transition', `${from} → ${to} is not allowed`);
  if (!roleCan(actor.role, requiredPermission(to))) return fail('forbidden', `Your role cannot set "${to}".`);
  if ((to === 'cancelled') && order.isLegacy === false && order.shippedAtMs) return fail('already_shipped');

  const ops = [];
  const data = { status: to, updatedAt: TS };
  const stampField = STATUS_STAMP[to];
  if (stampField) data[stampField] = TS;
  if (to === 'delivered' && !order.shippedAtMs && !order.isLegacy) data.shippedAt = TS;
  if (to === 'cancelled') data.cancelReason = String(options.cancelReason || options.note || '').slice(0, 200);

  if (to === 'shipped' || (to === 'delivered' && !order.shippedAtMs)) {
    if (options.carrier || options.trackingNo || options.trackingUrl) {
      data.shipping = clean({
        ...(order.shipping || {}),
        carrier: String(options.carrier || '').slice(0, 60),
        trackingNo: String(options.trackingNo || '').slice(0, 80),
        trackingUrl: String(options.trackingUrl || '').slice(0, 300),
      });
    }
  }

  // Payment side effects (only when the actor may touch payments).
  const mayPay = roleCan(actor.role, 'payments.verify') || roleCan(actor.role, 'orders.refund');
  if (to === 'delivered' && order.payment.method === 'cod' && order.payment.status !== 'paid' && options.markCodPaid && mayPay) {
    data.payment = clean({ ...order.payment, status: 'paid', collectedAt: TS, verifiedBy: actor.uid });
  }

  /* ---- stock effects (schema 2, tracked lines only) ---- */
  let stockTouched = false;
  if (!order.isLegacy) {
    const deduct = (to === 'shipped' || to === 'delivered') && !order.shippedAtMs;
    const release = to === 'cancelled' && !order.shippedAtMs;
    const restock = to === 'returned' && order.shippedAtMs && options.restock === true;
    for (const line of order.items) {
      const inv = invByKey[line.key];
      if (!inv || inv.track !== true) {
        if (inv && (deduct || release)) ops.push({ op: 'update', path: `inventory/${line.key}`, data: { lastOrderId: order.id, updatedAt: TS } });
        continue;
      }
      if (deduct) {
        ops.push({ op: 'update', path: `inventory/${line.key}`, data: { stock: inc(-line.qty), reserved: inc(-line.qty), lastOrderId: order.id, updatedAt: TS } });
        ops.push(movementOp(actor, { key: line.key, inv, type: 'ship', delta: -line.qty, reservedDelta: -line.qty, orderNumber: order.orderNumber }));
        stockTouched = true;
      } else if (release) {
        ops.push({ op: 'update', path: `inventory/${line.key}`, data: { reserved: inc(-line.qty), lastOrderId: order.id, updatedAt: TS } });
        ops.push(movementOp(actor, { key: line.key, inv, type: 'correction', delta: 0, reservedDelta: -line.qty, orderNumber: order.orderNumber, note: 'Reservation released (order cancelled)' }));
        stockTouched = true;
      } else if (restock) {
        ops.push({ op: 'update', path: `inventory/${line.key}`, data: { stock: inc(line.qty), lastOrderId: order.id, updatedAt: TS } });
        ops.push(movementOp(actor, { key: line.key, inv, type: 'return', delta: line.qty, orderNumber: order.orderNumber, note: 'Returned goods restocked' }));
        stockTouched = true;
      }
    }
    // Optional: give the customer their coupon use back (needs coupons.write).
    if (to === 'cancelled' && options.restoreCoupon && order.couponCode && roleCan(actor.role, 'coupons.write')) {
      ops.push({ op: 'update', path: `coupons/${order.couponCode}`, data: { usedCount: inc(-1), lastOrderId: order.id } });
      ops.push({ op: 'delete', path: `couponUsage/${order.couponCode}__${order.userId}` });
    }
  }

  ops.unshift({ op: 'update', path: `orders/${order.id}`, data });
  // A return request keeps its own status in returns/{id}; the caller says whether that document exists (updating a missing one would fail the batch).
  if (options.returnDocExists === true && from === 'return_requested' && RETURN_DOC_STATUS[to]) {
    ops.push({ op: 'update', path: `returns/${order.id}`, data: { status: RETURN_DOC_STATUS[to], updatedAt: TS } });
  }
  ops.push(timelineOp(order, actor, { type: 'status', status: to, note: options.note || '' }));
  const n = notificationOp(order, { title: ORDER_STATUS[to].label, body: `Order ${order.orderNumber}: ${ORDER_STATUS[to].label}`, kind: 'order_status' });
  if (n) ops.push(n);
  ops.push(auditOp(actor, {
    action: 'order.status', entity: 'order', entityId: order.id,
    summary: `Order ${order.orderNumber}: ${from} → ${to}`, before: { status: from }, after: { status: to },
  }));
  if (stockTouched) ops.push(catalogStampOp(nowMs));

  return { ok: true, ops, summary: `${from} → ${to}`, stockTouched };
}

/* ───────────────────────── customer: cancel / return ───────────────────────── */

/** Customer cancels their own pending order. Releases reserved stock in the same batch. */
export function planCustomerCancel({ order, uid, reason = '', invByKey = {} }) {
  if (order.userId !== uid) return fail('forbidden');
  if (!customerCanCancel(order)) return fail('not_cancellable', 'This order can no longer be cancelled online. Please contact support.');
  const ops = [{
    op: 'update', path: `orders/${order.id}`,
    data: { status: 'cancelled', cancelledAt: TS, cancelReason: String(reason).slice(0, 200), updatedAt: TS },
  }];
  for (const line of order.items) {
    const inv = invByKey[line.key];
    if (inv && inv.track === true) {
      ops.push({ op: 'update', path: `inventory/${line.key}`, data: { reserved: inc(-line.qty), lastOrderId: order.id } });
    }
  }
  return { ok: true, ops };
}

/** Customer asks to return a delivered order: creates returns/{orderNumber} and flips the order status. */
export function planCustomerReturn({ order, uid, lines, reason, details = '', nowMs = Date.now(), windowDays = 7 }) {
  if (order.userId !== uid) return fail('forbidden');
  if (!customerCanRequestReturn(order, nowMs, windowDays)) return fail('not_returnable', 'The return window for this order has closed.');
  const chosen = (lines || []).filter((l) => l.qty > 0);
  if (chosen.length < 1) return fail('no_lines', 'Select at least one item to return.');
  const valid = chosen.every((l) => order.items.some((i) => i.key === l.key && l.qty <= i.qty));
  if (!valid) return fail('bad_lines');
  return {
    ok: true,
    ops: [
      { op: 'update', path: `orders/${order.id}`, data: { status: 'return_requested', returnRequestedAt: TS, updatedAt: TS } },
      {
        op: 'set', path: `returns/${order.id}`,
        data: {
          orderNumber: order.id, userId: uid,
          lines: chosen.map((l) => ({ key: l.key, qty: l.qty })),
          reason: String(reason).slice(0, 100), details: String(details).slice(0, 600),
          status: 'requested', createdAt: TS, updatedAt: TS,
        },
      },
    ],
  };
}

/* ───────────────────────── staff: payment verification ───────────────────────── */

/**
 * action: 'verify' (bKash/Nagad money seen in the merchant account), 'reject', 'cod_paid'.
 * A TrxID typed by the customer is NOT proof of payment; only this explicit staff action marks an order paid.
 */
export function planPaymentAction({ order, action, actor, nowMs, receivedAmount, note = '' }) {
  if (!(roleCan(actor.role, 'payments.verify'))) return fail('forbidden', 'Your role cannot verify payments.');
  const p = order.payment;
  if (order.isLegacy) return fail('legacy', 'Legacy orders have no payment record to verify.');
  if (['cancelled', 'refunded'].includes(order.status)) return fail('closed_order');
  let next;
  if (action === 'verify') {
    if (p.method === 'cod') return fail('cod', 'Cash on delivery is marked paid on delivery.');
    if (!['awaiting_verification', 'failed'].includes(p.status)) return fail('wrong_state');
    const got = Number(receivedAmount);
    if (!Number.isFinite(got) || got < p.amountDue) return fail('amount', `Received amount must be at least ৳${p.amountDue}.`);
    next = { ...p, status: 'paid', receivedAmount: got, verifiedAt: TS, verifiedBy: actor.uid };
  } else if (action === 'reject') {
    if (p.method === 'cod' || p.status !== 'awaiting_verification') return fail('wrong_state');
    next = { ...p, status: 'failed', failReason: String(note).slice(0, 200), verifiedAt: TS, verifiedBy: actor.uid };
  } else if (action === 'cod_paid') {
    if (p.method !== 'cod' || p.status === 'paid') return fail('wrong_state');
    next = { ...p, status: 'paid', collectedAt: TS, verifiedBy: actor.uid };
  } else return fail('unknown_action');

  const title = action === 'reject' ? 'Payment could not be verified' : 'Payment received';
  const ops = [
    { op: 'update', path: `orders/${order.id}`, data: { payment: clean(next), updatedAt: TS } },
    timelineOp(order, actor, { type: 'payment', status: next.status, note }),
    auditOp(actor, {
      action: `payment.${action}`, entity: 'order', entityId: order.id,
      summary: `Order ${order.orderNumber}: payment ${p.status} → ${next.status}`, before: { paymentStatus: p.status }, after: { paymentStatus: next.status },
    }),
  ];
  const n = notificationOp(order, { title, body: `Order ${order.orderNumber}: ${title}`, kind: 'payment' });
  if (n) ops.push(n);
  return { ok: true, ops };
}

/* ───────────────────────── staff: refund ───────────────────────── */

/** Records a refund (money already returned manually) and closes the order as refunded. */
export function planRefund({ order, actor, amount, method, note = '' }) {
  if (!roleCan(actor.role, 'orders.refund')) return fail('forbidden', 'Your role cannot issue refunds.');
  if (order.isLegacy) return fail('legacy');
  if (!['refund_pending', 'returned'].includes(order.status)) return fail('wrong_state', 'Move the order to "Refund pending" first.');
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 1 || amt > order.totals.total) return fail('amount', `Refund must be between ৳1 and ৳${order.totals.total}.`);
  const refundId = autoId();
  const ops = [
    {
      op: 'set', path: `refunds/${refundId}`,
      data: clean({
        orderNumber: order.id, userId: order.userId, amount: amt, method: String(method || '').slice(0, 40),
        note: String(note).slice(0, 300), actorUid: actor.uid, createdAt: TS,
      }),
    },
    { op: 'update', path: `orders/${order.id}`, data: { status: 'refunded', refund: { amount: amt, method: String(method || ''), at: TS, by: actor.uid }, payment: clean({ ...order.payment, status: 'refunded' }), updatedAt: TS } },
    timelineOp(order, actor, { type: 'refund', status: 'refunded', note: `৳${amt}` }),
    auditOp(actor, { action: 'order.refund', entity: 'order', entityId: order.id, summary: `Order ${order.orderNumber}: refunded ৳${amt}`, after: { amount: amt } }),
  ];
  return { ok: true, ops };
}

/* ───────────────────────── staff: notes & tracking ───────────────────────── */

export const ORDER_NOTE_MAX = 500;

/**
 * Adds a line to the order timeline. visibility 'internal' = staff only; 'customer' = shown on the customer's order page
 * and also sent to them as a notification. Needs orders.update or support.reply (what the rules require for events).
 */
export function planOrderNote({ order, actor, text, visibility = 'internal' }) {
  if (!(roleCan(actor.role, 'orders.update') || roleCan(actor.role, 'support.reply'))) return fail('forbidden', 'Your role cannot add notes.');
  const note = String(text ?? '').trim();
  if (!note) return fail('empty', 'Write something first.');
  if (note.length > ORDER_NOTE_MAX) return fail('too_long', `A note can have at most ${ORDER_NOTE_MAX} characters.`);
  const vis = visibility === 'customer' ? 'customer' : 'internal';
  const ops = [timelineOp(order, actor, { type: 'note', note, visibility: vis })];
  if (vis === 'customer') {
    const n = notificationOp(order, { title: 'A message about your order', body: note.slice(0, 200), kind: 'order' });
    if (n) ops.push(n);
  }
  ops.push(auditOp(actor, { action: 'order.note', entity: 'order', entityId: order.id, summary: `Order ${order.orderNumber}: ${vis === 'customer' ? 'customer-visible' : 'internal'} note added` }));
  return { ok: true, ops };
}

/** Courier / tracking details can be corrected without changing the status. */
export function planShippingUpdate({ order, actor, shipping }) {
  if (!roleCan(actor.role, 'orders.update')) return fail('forbidden', 'Your role cannot update shipping.');
  if (order.isLegacy) return fail('legacy', 'Legacy orders cannot be edited here.');
  if (['cancelled', 'refunded'].includes(order.status)) return fail('closed_order');
  const carrier = String(shipping?.carrier ?? '').trim().slice(0, 60);
  const trackingNo = String(shipping?.trackingNo ?? '').trim().slice(0, 80);
  const trackingUrl = String(shipping?.trackingUrl ?? '').trim().slice(0, 300);
  if (trackingUrl && !/^https?:\/\/[^\s]+$/i.test(trackingUrl)) return fail('bad_url', 'The tracking link must start with http:// or https://');
  if (!carrier && !trackingNo && !trackingUrl) return fail('empty', 'Enter a courier or a tracking number.');
  const next = clean({ ...(order.shipping || {}), carrier, trackingNo, trackingUrl });
  const ops = [
    { op: 'update', path: `orders/${order.id}`, data: { shipping: next, updatedAt: TS } },
    timelineOp(order, actor, { type: 'shipping', note: [carrier, trackingNo].filter(Boolean).join(' · ') }),
  ];
  const n = notificationOp(order, { title: 'Tracking details updated', body: `Order ${order.orderNumber}: ${[carrier, trackingNo].filter(Boolean).join(' · ')}`, kind: 'order' });
  if (n) ops.push(n);
  ops.push(auditOp(actor, { action: 'order.shipping', entity: 'order', entityId: order.id, summary: `Order ${order.orderNumber}: shipping details updated`, after: { carrier, trackingNo } }));
  return { ok: true, ops };
}

/* ───────────────────────── staff: recount reservations ───────────────────────── */

/**
 * Reconciles inventory.reserved with the open orders (pending…packed). Use after incidents
 * (e.g. an interrupted batch). Returns the corrections as ops + a human readable diff.
 * @param {Array} orders  normalized schema-2 orders (all statuses are fine; only reserved ones count)
 * @param {Object<string,object>} invByKey  every tracked inventory doc
 */
export function planReservationRecount({ orders, invByKey, actor }) {
  const expected = {};
  for (const o of orders) {
    if (o.isLegacy || !['pending', 'confirmed', 'processing', 'packed'].includes(o.status)) continue;
    for (const l of o.items) expected[l.key] = (expected[l.key] || 0) + l.qty;
  }
  const diffs = [];
  const ops = [];
  for (const [key, inv] of Object.entries(invByKey)) {
    if (inv.track !== true) continue;
    const want = expected[key] || 0;
    const have = inv.reserved || 0;
    if (want !== have) {
      diffs.push({ key, have, want });
      ops.push({ op: 'update', path: `inventory/${key}`, data: { reserved: want, updatedAt: TS } });
      ops.push(movementOp(actor, { key, inv, type: 'reserve_fix', delta: 0, reservedDelta: want - have, note: `Reservation recount ${have} → ${want}` }));
    }
  }
  if (ops.length) ops.push(catalogStampOp(Date.now()));
  return { ok: true, ops, diffs };
}
