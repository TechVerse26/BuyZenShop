/*
 * Shared order view pieces for order-success, the account order page and tracking.
 * Every function takes a normalised order (shared/orderModel.js → normalizeOrder) and returns SafeHtml.
 *
 *   methodName(method)             "Cash on Delivery" | "bKash" | "Nagad"
 *   orderLinesHtml(order, {after}) items: thumbnail, name, variant, qty × price, line total (+ optional extra per line)
 *   orderTotalsHtml(order)         subtotal / discount / delivery / total
 *   addressHtml(order)             delivery address block
 *   paymentHtml(order)             method, payment status, TrxID, sender number
 *   paymentNote(order)             one plain sentence about what happens with the money next
 *   stepsHtml(order)               progress: placed → confirmed → processing → shipped → delivered (+ cancelled / return / refund)
 *   timelineEntries(order, events) merged, oldest-first history (events come from data/orders.listOrderEvents)
 *   eventsHtml(entries)            the history as a vertical timeline
 *   orderRowHtml(order, {href})    one <li> in an order list (links to /account/orders/<id> unless href is given)
 */
import { html, safeUrl } from '../../core/dom.js';
import { registerBoth, t, tn, pick } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { money, num, fmtPhone, fmtDate, fmtDateTime } from '../../core/format.js';
import { paymentBadge, statusBadge, loadCss } from '../../core/ui.js';
import { ORDER_STATUS, PAYMENT_STATUS, PAYMENT_METHODS } from '../../shared/constants.js';
import { assetUrl } from '../../shared/productModel.js';

loadCss('/css/pages/order.css'); // every order view below is styled by this sheet

registerBoth({
  'op.qtyPrice': ['{qty} × {price}', '{qty} × {price}'],
  'op.subtotal': ['Subtotal', 'সাবটোটাল'],
  'op.discount': ['Discount ({code})', 'ছাড় ({code})'],
  'op.discountNoCode': ['Discount', 'ছাড়'],
  'op.delivery': ['Delivery', 'ডেলিভারি'],
  'op.free': ['Free', 'ফ্রি'],
  'op.total': ['Total', 'মোট'],
  'op.method': ['Method', 'পদ্ধতি'],
  'op.payStatus': ['Payment status', 'পেমেন্টের অবস্থা'],
  'op.trx': ['TrxID', 'TrxID'],
  'op.sender': ['Paid from', 'যে নম্বর থেকে'],
  'op.note.cod': ['Pay {amount} in cash to the courier when the order arrives.', 'অর্ডার পৌঁছালে কুরিয়ারকে {amount} নগদে দিন।'],
  'op.note.awaiting': ['We are checking your {method} payment. The order is confirmed after the payment is verified.', 'আপনার {method} পেমেন্ট যাচাই করা হচ্ছে। যাচাই শেষ হলে অর্ডার নিশ্চিত হবে।'],
  'op.note.paid': ['Payment received. Thank you!', 'পেমেন্ট পাওয়া গেছে। ধন্যবাদ!'],
  'op.note.failed': ['We could not verify this payment. Send the correct transaction ID so we can check again.', 'এই পেমেন্ট যাচাই করা যায়নি। সঠিক ট্রানজেকশন আইডি পাঠান, আমরা আবার দেখব।'],
  'op.note.refunded': ['This payment has been refunded.', 'এই পেমেন্ট ফেরত দেওয়া হয়েছে।'],
  'op.s.placed': ['Placed', 'জমা হয়েছে'],
  'op.s.confirmed': ['Confirmed', 'নিশ্চিত'],
  'op.s.processing': ['Processing', 'প্রস্তুত হচ্ছে'],
  'op.s.shipped': ['Shipped', 'পাঠানো হয়েছে'],
  'op.s.delivered': ['Delivered', 'ডেলিভারি হয়েছে'],
  'op.ev.payment': ['Payment: {status}', 'পেমেন্ট: {status}'],
  'op.ev.refund': ['Refund issued', 'রিফান্ড দেওয়া হয়েছে'],
  'op.ev.placed': ['Order placed', 'অর্ডার জমা হয়েছে'],
  'op.ev.update': ['Order update', 'অর্ডার আপডেট'],
  'op.ev.status': ['Status: {status}', 'অবস্থা: {status}'],
  'op.items_one': ['{n} item', '{n}টি পণ্য'],
  'op.items_other': ['{n} items', '{n}টি পণ্য'],
  'op.aria.steps': ['Order progress', 'অর্ডারের অগ্রগতি'],
  'op.aria.events': ['Order history', 'অর্ডারের ইতিহাস'],
});

export const methodName = (m) => { const x = PAYMENT_METHODS[m]; return x ? pick(x.label, x.bn) : String(m || ''); };
const statusLabel = (map, id) => { const s = map[id]; return s ? pick(s.label, s.bn) : String(id || ''); };

/** `after(line)` may return extra SafeHtml shown under each item (e.g. a "Write a review" link). */
export function orderLinesHtml(order, { after = null } = {}) {
  return html`<ul class="ord-lines">${order.items.map((l) => html`<li>
    <span class="ord-thumb">${l.image ? html`<img src="${safeUrl(assetUrl(l.image))}" alt="" width="56" height="56" loading="lazy" decoding="async">` : icon('image', { size: 22 })}</span>
    <span class="ord-line-body">
      <span class="ord-line-name">${l.name}</span>
      ${l.variantLabel ? html`<span class="muted small">${l.variantLabel}</span>` : ''}
      <span class="muted small">${t('op.qtyPrice', { qty: num(l.qty), price: money(l.unitPrice) })}</span>
      ${after ? after(l) : ''}
    </span>
    <span class="ord-line-total">${money(l.lineTotal)}</span></li>`)}</ul>`;
}

export function orderTotalsHtml(order) {
  const x = order.totals;
  return html`<dl class="ord-totals">
    <div><dt>${t('op.subtotal')}</dt><dd>${money(x.subtotal)}</dd></div>
    ${x.discount ? html`<div class="is-discount"><dt>${order.couponCode ? t('op.discount', { code: order.couponCode }) : t('op.discountNoCode')}</dt><dd>−${money(x.discount)}</dd></div>` : ''}
    <div><dt>${t('op.delivery')}${order.zoneName ? html` <span class="muted small">(${order.zoneName})</span>` : ''}</dt><dd>${x.shipping ? money(x.shipping) : t('op.free')}</dd></div>
    <div class="is-total"><dt>${t('op.total')}</dt><dd>${money(x.total)}</dd></div>
  </dl>`;
}

export function addressHtml(order) {
  const a = order.address || {};
  const line = [a.line1, a.area, a.upazila, a.district, a.postalCode].filter(Boolean).join(', ');
  return html`<address class="ord-addr">
    <strong>${a.name || order.customer.name || ''}</strong>
    <span>${fmtPhone(a.phone || order.customer.phone || '')}</span>
    <span>${line}</span>
  </address>`;
}

export function paymentHtml(order) {
  const p = order.payment;
  return html`<dl class="ord-kv">
    <div><dt>${t('op.method')}</dt><dd>${methodName(p.method)}</dd></div>
    <div><dt>${t('op.payStatus')}</dt><dd>${paymentBadge(p.status)}</dd></div>
    ${p.trxId ? html`<div><dt>${t('op.trx')}</dt><dd class="mono">${p.trxId}</dd></div>` : ''}
    ${p.senderNumber ? html`<div><dt>${t('op.sender')}</dt><dd>${fmtPhone(p.senderNumber)}</dd></div>` : ''}
  </dl>`;
}

/** One honest sentence about the money. Never says "paid" before staff verified it. */
export function paymentNote(order) {
  const p = order.payment;
  if (order.status === 'cancelled') return '';
  if (p.status === 'paid') return t('op.note.paid');
  if (p.status === 'refunded') return t('op.note.refunded');
  if (p.status === 'failed') return t('op.note.failed');
  if (p.method === 'cod') return t('op.note.cod', { amount: money(p.amountDue || order.totals.total) });
  if (p.status === 'awaiting_verification') return t('op.note.awaiting', { method: methodName(p.method) });
  return '';
}

const STEPS = [['pending', 'op.s.placed'], ['confirmed', 'op.s.confirmed'], ['processing', 'op.s.processing'], ['shipped', 'op.s.shipped'], ['delivered', 'op.s.delivered']];
const REACHED = { pending: 0, confirmed: 1, processing: 2, packed: 2, shipped: 3, delivered: 4, return_requested: 4, returned: 4, refund_pending: 4, refunded: 4 };

export function stepsHtml(order) {
  const s = order.status;
  let reached = REACHED[s];
  if (s === 'cancelled') reached = order.shippedAtMs ? 3 : order.confirmedAtMs ? 1 : 0;
  const after = ['return_requested', 'returned', 'refund_pending', 'refunded'].includes(s) ? s : (s === 'cancelled' ? 'cancelled' : '');
  return html`<ol class="ord-steps" aria-label="${t('op.aria.steps')}">
    ${STEPS.map(([id, key], i) => {
    const done = i < reached || (i === reached && !after && s === 'delivered');
    const current = i === reached && !done && s !== 'cancelled';
    return html`<li class="${done ? 'is-done' : ''} ${current ? 'is-current' : ''}" ${current ? html`aria-current="step"` : ''}><span class="ord-dot" aria-hidden="true">${done ? icon('check', { size: 14 }) : ''}</span><span>${t(key)}</span></li>`;
  })}
    ${after ? html`<li class="is-end ${after === 'cancelled' ? 'is-bad' : 'is-warn'}"><span class="ord-dot" aria-hidden="true">${icon(after === 'cancelled' ? 'x' : 'undo', { size: 14 })}</span><span>${statusLabel(ORDER_STATUS, after)}</span></li>` : ''}
  </ol>`;
}

function eventTitle(ev) {
  if (ev.type === 'placed') return t('op.ev.placed');
  if (ev.type === 'status') return t('op.ev.status', { status: statusLabel(ORDER_STATUS, ev.status) });
  if (ev.type === 'payment') return t('op.ev.payment', { status: statusLabel(PAYMENT_STATUS, ev.status) });
  if (ev.type === 'refund') return t('op.ev.refund');
  return t('op.ev.update');
}

/**
 * The customer-visible history, oldest first: staff entries (orders/{id}/events) plus the moments the order document itself
 * records (placed / confirmed / shipped / delivered / cancelled / return requested) when no staff entry already says so.
 * @returns {Array<{type:string,status:string|null,note:string,atMs:number|null}>}
 */
export function timelineEntries(order, events = []) {
  const out = events.map((ev) => ({ type: ev.type, status: ev.status || null, note: ev.note || '', atMs: ev.createdAt && ev.createdAt.ms ? ev.createdAt.ms : null }));
  const has = (status) => out.some((e) => e.type === 'status' && e.status === status);
  out.push({ type: 'placed', status: null, note: '', atMs: order.createdAtMs });
  const marks = [['confirmed', order.confirmedAtMs, ''], ['shipped', order.shippedAtMs, ''], ['delivered', order.deliveredAtMs, ''],
    ['return_requested', order.returnRequestedAtMs, ''], ['cancelled', order.cancelledAtMs, order.cancelReason]];
  for (const [status, ms, note] of marks) if (ms && !has(status)) out.push({ type: 'status', status, note, atMs: ms });
  return out.sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
}

export function eventsHtml(entries = []) {
  if (!entries.length) return html``;
  return html`<ol class="ord-events" aria-label="${t('op.aria.events')}">${entries.map((ev) => html`<li>
    <span class="ord-ev-dot" aria-hidden="true"></span>
    <div><strong>${eventTitle(ev)}</strong>
      ${ev.note && ev.type !== 'refund' ? html`<p>${ev.note}</p>` : ''}
      ${ev.atMs ? html`<time class="muted small">${fmtDateTime(ev.atMs)}</time>` : ''}</div></li>`)}</ol>`;
}

export function orderRowHtml(o, { href } = {}) {
  const names = o.items.slice(0, 2).map((l) => l.name).join(', ');
  const more = o.items.length > 2 ? ` +${num(o.items.length - 2)}` : '';
  const units = o.items.reduce((n, l) => n + l.qty, 0);
  return html`<li class="ord-row"><a href="${href || `/account/orders/${o.id}`}">
    <span class="ord-row-top"><strong class="mono">${o.orderNumber}</strong><span class="ord-row-badges">${statusBadge(o.status)}</span></span>
    <span class="ord-row-items">${names}${more}</span>
    <span class="ord-row-bottom"><span class="muted small">${o.createdAtMs ? fmtDate(o.createdAtMs) : ''} · ${tn('op.items', units, { n: num(units) })}</span><strong>${money(o.totals.total)}</strong></span>
  </a></li>`;
}
