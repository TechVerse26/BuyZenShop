/*
 * Order detail — everything staff do with one order:
 *   status steps (stock moves in the same atomic batch), payment verification (a TrxID typed by the customer is NOT proof),
 *   courier / tracking, return request, refund, customer-visible or internal notes, print invoice / packing slip / label.
 * The page follows the order live (realtime listener), so a customer cancelling or re-submitting a TrxID shows up at once.
 * All writes go through the planners in shared/orderFlow.js via data/orders.js; firestore.rules check them again.
 */
import { html, render, bindActions, readForm, copyText, raw, safeUrl } from '../../core/dom.js';
import { registerBoth, t, tn, lbl, getLang } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { statusBadge, paymentBadge, badge, emptyState, fieldHtml, formDialog, confirmDialog, openMenu, toast, toastError } from '../../core/ui.js';
import { showFormErrors, url as urlRule } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { money, num, fmtDateTime, relTime, fmtPhone } from '../../core/format.js';
import { printDocument, invoiceHtml, packingSlipHtml, shippingLabelHtml, amountDue } from '../../core/print.js';
import { can, staffRole } from '../../data/auth.js';
import { watchDoc, getDocDataSafe } from '../../data/db.js';
import { fetchOrderEvents } from '../../data/ordersAdmin.js';
import { normalizeOrder } from '../../shared/orderModel.js';
import { allowedNext, requiredPermission } from '../../shared/orderFlow.js';
import { normalizeTrxId } from '../../shared/id.js';
import { toMillis } from '../../shared/pricing.js';
import { ORDER_STATUS, PAYMENT_STATUS, PAYMENT_METHODS, DISTRICT_BN, roleCan, ROLES } from '../../shared/constants.js';
import { safeMount, kvList } from '../lib/ui.js';
import { methodLabel, loadBusiness, piiVisible, showPhone, showEmail } from '../lib/orderUi.js';
import { changeStatus, verifyPayment, rejectPayment, markCodPaid, refundOrder, addOrderNote, updateTracking } from '../data/orders.js';
import { ORDER_NOTE_MAX } from '../../shared/orderFlow.js';

registerBoth({
  'od.back': ['Orders', 'অর্ডার'],
  'od.title': ['Order {n}', 'অর্ডার {n}'],
  'od.placed': ['Placed {when}', 'অর্ডারের সময় {when}'],
  'od.notFound': ['Order not found', 'অর্ডার পাওয়া যায়নি'],
  'od.notFoundText': ['It may have been removed, or the number is wrong.', 'অর্ডারটি মুছে গেছে অথবা নম্বর ভুল।'],
  'od.legacyNote': ['This order was placed on the old site. You can view it and move its status; payment checks, tracking and refunds are not available for it.', 'এই অর্ডারটি পুরনো সাইটে করা। এটি দেখা ও এর অবস্থা বদলানো যায়; পেমেন্ট যাচাই, ট্র্যাকিং ও রিফান্ড এখানে নেই।'],
  'od.copy': ['Copy number', 'নম্বর কপি'],
  'od.copied': ['Copied', 'কপি হয়েছে'],
  'od.print': ['Print', 'প্রিন্ট'],
  'od.print.invoice': ['Invoice', 'ইনভয়েস'],
  'od.print.slip': ['Packing slip', 'প্যাকিং স্লিপ'],
  'od.print.label': ['Shipping label', 'শিপিং লেবেল'],
  'od.items': ['Items', 'পণ্য'],
  'od.count_one': ['{n} item', '{n}টি পণ্য'],
  'od.count_other': ['{n} items', '{n}টি পণ্য'],
  'od.legacy': ['Old site', 'পুরনো সাইট'],
  'od.col.item': ['Item', 'পণ্য'],
  'od.col.price': ['Price', 'দাম'],
  'od.col.qty': ['Qty', 'পরিমাণ'],
  'od.col.total': ['Total', 'মোট'],
  'od.subtotal': ['Subtotal', 'সাবটোটাল'],
  'od.discount': ['Discount', 'ছাড়'],
  'od.shipping': ['Delivery charge', 'ডেলিভারি চার্জ'],
  'od.free': ['Free', 'ফ্রি'],
  'od.total': ['Total', 'সর্বমোট'],
  'od.due': ['Amount due', 'বাকি'],
  'od.timeline': ['Timeline and notes', 'টাইমলাইন ও নোট'],
  'od.note.label': ['Add a note', 'নোট যোগ করুন'],
  'od.note.placeholder': ['Write a note about this order…', 'এই অর্ডার সম্পর্কে নোট লিখুন…'],
  'od.note.vis': ['Who can see it', 'কারা দেখতে পাবে'],
  'od.note.internal': ['Staff only', 'শুধু স্টাফ'],
  'od.note.customer': ['The customer too (they get a notification)', 'কাস্টমারও (তাকে নোটিফিকেশন যাবে)'],
  'od.note.add': ['Add note', 'নোট যোগ করুন'],
  'od.note.added': ['Note added.', 'নোট যোগ হয়েছে।'],
  'od.ev.placed': ['Order placed', 'অর্ডার করা হয়েছে'],
  'od.ev.payment': ['Payment', 'পেমেন্ট'],
  'od.ev.refund': ['Refund recorded', 'রিফান্ড রেকর্ড হয়েছে'],
  'od.ev.shipping': ['Tracking updated', 'ট্র্যাকিং আপডেট'],
  'od.ev.noteInternal': ['Internal note', 'অভ্যন্তরীণ নোট'],
  'od.ev.noteCustomer': ['Message to customer', 'কাস্টমারকে বার্তা'],
  'od.ev.internal': ['Staff only', 'শুধু স্টাফ'],
  'od.ev.customer': ['Customer sees this', 'কাস্টমার দেখতে পায়'],
  'od.status': ['Status', 'অবস্থা'],
  'od.nextSteps': ['Next step', 'পরের ধাপ'],
  'od.noNext': ['This order is finished; no further steps.', 'এই অর্ডার শেষ; আর কোনো ধাপ নেই।'],
  'od.noPermNext': ['Your role cannot move this order further.', 'আপনার রোল দিয়ে এই অর্ডার আর এগোনো যাবে না।'],
  'od.act.confirmed': ['Confirm order', 'অর্ডার নিশ্চিত করুন'],
  'od.act.processing': ['Start processing', 'প্রস্তুত করা শুরু'],
  'od.act.packed': ['Mark as packed', 'প্যাক হয়েছে'],
  'od.act.shipped': ['Mark as shipped', 'পাঠানো হয়েছে'],
  'od.act.delivered': ['Mark as delivered', 'ডেলিভারি হয়েছে'],
  'od.act.cancelled': ['Cancel order', 'অর্ডার বাতিল'],
  'od.act.return_requested': ['Log a return request', 'রিটার্নের অনুরোধ রেকর্ড করুন'],
  'od.act.returned': ['Goods received back', 'পণ্য ফেরত এসেছে'],
  'od.act.refund_pending': ['Start refund', 'রিফান্ড শুরু করুন'],
  'od.act.rejectReturn': ['Reject the return', 'রিটার্ন নাকচ করুন'],
  'od.dlg.title': ['{label}?', '{label}?'],
  'od.dlg.note': ['Note (the customer can see it)', 'নোট (কাস্টমার দেখতে পাবে)'],
  'od.dlg.carrier': ['Courier', 'কুরিয়ার'],
  'od.dlg.tracking': ['Tracking number', 'ট্র্যাকিং নম্বর'],
  'od.dlg.trackingUrl': ['Tracking link', 'ট্র্যাকিং লিংক'],
  'od.dlg.cod': ['The courier collected the cash — mark the payment as paid', 'কুরিয়ার নগদ টাকা আদায় করেছে — পেমেন্ট "পরিশোধিত" চিহ্নিত করুন'],
  'od.dlg.reason': ['Reason for cancelling', 'বাতিলের কারণ'],
  'od.dlg.restoreCoupon': ['Give the customer their coupon use back', 'কাস্টমারের কুপন ব্যবহার ফেরত দিন'],
  'od.dlg.restock': ['Put the returned items back in stock', 'ফেরত আসা পণ্য আবার স্টকে যোগ করুন'],
  'od.dlg.hint.shipped': ['Stock is deducted now and the customer is notified.', 'এখন স্টক কমবে এবং কাস্টমারকে জানানো হবে।'],
  'od.dlg.hint.delivered': ['Stock is deducted now if it was not already.', 'আগে না কমে থাকলে এখন স্টক কমবে।'],
  'od.dlg.hint.cancelled': ['The stock reserved for this order is released. This cannot be undone.', 'এই অর্ডারের জন্য রাখা স্টক ছেড়ে দেওয়া হবে। এটি ফেরানো যায় না।'],
  'od.dlg.hint.confirmed': ['The customer is notified.', 'কাস্টমারকে জানানো হবে।'],
  'od.status.done': ['Status updated.', 'অবস্থা বদলেছে।'],
  'od.pay': ['Payment', 'পেমেন্ট'],
  'od.pay.method': ['Method', 'মাধ্যম'],
  'od.pay.due': ['Amount due', 'প্রদেয়'],
  'od.pay.received': ['Received', 'পাওয়া গেছে'],
  'od.pay.trx': ['TrxID (typed by the customer)', 'TrxID (কাস্টমারের লেখা)'],
  'od.pay.sender': ['Sender number', 'প্রেরকের নম্বর'],
  'od.pay.reason': ['Reason', 'কারণ'],
  'od.pay.checkHint': ['Open your bKash / Nagad merchant app and confirm this transaction and its amount before you verify. The TrxID alone is not proof of payment.', 'যাচাইয়ের আগে আপনার বিকাশ/নগদ মার্চেন্ট অ্যাপে এই ট্রানজেকশন ও পরিমাণ মিলিয়ে নিন। শুধু TrxID পেমেন্টের প্রমাণ নয়।'],
  'od.pay.dup': ['This TrxID is already attached to another order: {n}. Do not verify both.', 'এই TrxID আরেকটি অর্ডারে ব্যবহৃত: {n}। দুটোই যাচাই করবেন না।'],
  'od.pay.verify': ['Verify payment', 'পেমেন্ট যাচাই করুন'],
  'od.pay.reject': ['Could not verify', 'যাচাই করা গেল না'],
  'od.pay.cod': ['Mark cash as collected', 'নগদ আদায় হয়েছে'],
  'od.pay.verifyTitle': ['Verify this payment', 'এই পেমেন্ট যাচাই করুন'],
  'od.pay.receivedLabel': ['Amount you received (৳)', 'আপনি যত টাকা পেয়েছেন (৳)'],
  'od.pay.rejectTitle': ['Payment could not be verified', 'পেমেন্ট যাচাই করা যায়নি'],
  'od.pay.rejectLabel': ['Reason (the customer can send a new TrxID)', 'কারণ (কাস্টমার নতুন TrxID দিতে পারবেন)'],
  'od.pay.codTitle': ['Mark the cash as collected?', 'নগদ আদায় হয়েছে বলে চিহ্নিত করবেন?'],
  'od.pay.done': ['Payment updated.', 'পেমেন্ট হালনাগাদ হয়েছে।'],
  'od.cust': ['Customer', 'কাস্টমার'],
  'od.cust.profile': ['Open customer profile', 'কাস্টমারের প্রোফাইল'],
  'od.cust.note': ['Note from the customer', 'কাস্টমারের নোট'],
  'od.cust.guest': ['No account (old-site order)', 'অ্যাকাউন্ট নেই (পুরনো সাইটের অর্ডার)'],
  'od.mask': ['Contact details are hidden for your role.', 'আপনার রোলের জন্য যোগাযোগের তথ্য লুকানো।'],
  'od.deliver': ['Delivery', 'ডেলিভারি'],
  'od.deliver.zone': ['Zone', 'এলাকা'],
  'od.deliver.carrier': ['Courier', 'কুরিয়ার'],
  'od.deliver.tracking': ['Tracking', 'ট্র্যাকিং'],
  'od.deliver.trackLink': ['Open tracking page', 'ট্র্যাকিং পেজ খুলুন'],
  'od.deliver.edit': ['Edit tracking', 'ট্র্যাকিং সম্পাদনা'],
  'od.deliver.none': ['No courier details yet.', 'এখনো কুরিয়ারের তথ্য নেই।'],
  'od.deliver.title': ['Courier and tracking', 'কুরিয়ার ও ট্র্যাকিং'],
  'od.deliver.saved': ['Tracking details saved.', 'ট্র্যাকিংয়ের তথ্য সেভ হয়েছে।'],
  'od.ret': ['Return request', 'রিটার্নের অনুরোধ'],
  'od.ret.reason': ['Reason', 'কারণ'],
  'od.ret.details': ['Details', 'বিবরণ'],
  'od.ret.lines': ['Items', 'পণ্য'],
  'od.ret.status.requested': ['Requested', 'অনুরোধ করা হয়েছে'],
  'od.ret.status.approved': ['Refund approved', 'রিফান্ড অনুমোদিত'],
  'od.ret.status.received': ['Goods received', 'পণ্য ফেরত এসেছে'],
  'od.ret.status.rejected': ['Rejected', 'নাকচ'],
  'od.refund': ['Refund', 'রিফান্ড'],
  'od.refund.amount': ['Amount refunded (৳)', 'ফেরত দেওয়া টাকা (৳)'],
  'od.refund.method': ['Paid back by', 'যেভাবে ফেরত দিয়েছেন'],
  'od.refund.note': ['Note', 'নোট'],
  'od.refund.help': ['Send the money back first (bKash, Nagad, bank or cash), then record it here. This closes the order.', 'আগে টাকা ফেরত পাঠান (বিকাশ, নগদ, ব্যাংক বা নগদ), তারপর এখানে রেকর্ড করুন। এতে অর্ডার বন্ধ হবে।'],
  'od.refund.record': ['Record refund', 'রিফান্ড রেকর্ড করুন'],
  'od.refund.done': ['Refund recorded.', 'রিফান্ড রেকর্ড হয়েছে।'],
  'od.refund.recorded': ['Refunded {amount} via {method}', '{amount} ফেরত দেওয়া হয়েছে ({method})'],
  'od.refund.bank': ['Bank transfer', 'ব্যাংক ট্রান্সফার'],
  'od.refund.cash': ['Cash', 'নগদ'],
  'od.refund.other': ['Other', 'অন্য'],
  'od.loadFailed': ['The order could not be loaded.', 'অর্ডার লোড করা যায়নি।'],
  'od.printFailed': ['The print view could not be opened.', 'প্রিন্ট ভিউ খোলা যায়নি।'],
});

const EVENT_ICON = { status: 'check-circle', payment: 'wallet', refund: 'credit-card', note: 'message-circle', shipping: 'truck' };
const MANUAL = new Set(['bkash', 'nagad']);
const RETURN_STATES = ['return_requested', 'returned', 'refund_pending', 'refunded'];

const errText = (e) => explainError(e);
const districtName = (d) => (getLang() === 'bn' ? (DISTRICT_BN[d] || d) : d);

export default {
  async mount(ctx) {
    await safeMount(ctx, async () => {
      const id = decodeURIComponent(String(ctx.params.id || ''));
      const href = (p) => ctx.router.href(p);
      let order = null;
      let events = [];
      let ret = null;       // returns/{id}
      let trx = null;       // paymentTrx/{TRXID}
      let lastStamp = '';
      let ready = false;

      /* ── context documents ── */
      const loadExtras = async () => {
        const jobs = [];
        jobs.push(fetchOrderEvents(id).then((e) => { events = e; }).catch((e) => { console.warn('events failed', e); events = []; }));
        if (order && RETURN_STATES.includes(order.status)) jobs.push(getDocDataSafe(`returns/${id}`).then((r) => { ret = r; }).catch(() => { ret = null; }));
        else ret = null;
        const trxId = order ? normalizeTrxId(order.payment.trxId) : '';
        if (order && MANUAL.has(order.payment.method) && trxId) jobs.push(getDocDataSafe(`paymentTrx/${trxId}`).then((r) => { trx = r; }).catch(() => { trx = null; }));
        else trx = null;
        await Promise.all(jobs);
      };

      /* ── shell: three hosts are re-rendered, the note form is rendered once so typing is never lost ── */
      render(ctx.el, html`<div class="od">
        <div id="od-head"></div>
        <div id="od-legacy"></div>
        <div class="split">
          <div class="stack" id="od-main">
            <section class="panel" id="od-items" aria-labelledby="od-items-h"></section>
            <section class="panel" aria-labelledby="od-tl-h">
              <div class="panel-head"><h2 id="od-tl-h">${t('od.timeline')}</h2></div>
              <div class="panel-body">
                <div id="od-note"></div>
                <div id="od-timeline"></div>
              </div>
            </section>
          </div>
          <aside id="od-aside" class="stack" aria-label="${t('od.status')}"></aside>
        </div>
      </div>`);
      const $ = (sel) => ctx.el.querySelector(sel);

      /* ── pieces ── */
      const headHtml = () => html`<a class="back-link" href="${href('/orders')}">${icon('arrow-left', { size: 16 })}<span>${t('od.back')}</span></a>
        <div class="page-head">
          <div>
            <h1><span class="mono">${order.orderNumber}</span></h1>
            <p class="page-sub">${order.createdAtMs ? t('od.placed', { when: fmtDateTime(order.createdAtMs) }) : ''}${order.createdAtMs ? ` · ${relTime(order.createdAtMs)}` : ''}</p>
            <div class="row row-wrap gap-2 mt-2">${statusBadge(order.status)}${paymentBadge(order.payment.status)}${order.isLegacy ? badge(t('od.legacy')) : ''}</div>
          </div>
          <div class="page-actions">
            <button type="button" class="btn btn-sm" data-action="copy">${icon('copy', { size: 16 })}<span>${t('od.copy')}</span></button>
            <button type="button" class="btn btn-sm" data-action="print-menu" aria-haspopup="menu">${icon('printer', { size: 16 })}<span>${t('od.print')}</span></button>
          </div>
        </div>`;

      const itemsHtml = () => {
        const tot = order.totals;
        return html`<div class="panel-head"><h2 id="od-items-h">${t('od.items')}</h2><span class="muted small">${tn('od.count', order.items.length, { n: num(order.items.length) })}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th scope="col">${t('od.col.item')}</th><th scope="col" class="num od-col-wide">${t('od.col.price')}</th><th scope="col" class="num od-col-wide">${t('od.col.qty')}</th><th scope="col" class="num">${t('od.col.total')}</th></tr></thead>
            <tbody>${order.items.map((l) => html`<tr>
              <td><div class="cell-main">${l.image ? html`<img class="thumb" src="${safeUrl(l.image)}" alt="" loading="lazy">` : html`<span class="thumb" aria-hidden="true"></span>`}
                <div><div class="t">${l.name}</div><div class="s">${[l.variantLabel, l.sku].filter(Boolean).join(' · ')}</div><div class="s od-line-meta">${money(l.unitPrice)} × ${num(l.qty)}</div></div></div></td>
              <td class="num nowrap od-col-wide">${money(l.unitPrice)}${l.regularPrice > l.unitPrice ? html`<span class="cell-sub"><s>${money(l.regularPrice)}</s></span>` : ''}</td>
              <td class="num od-col-wide">${num(l.qty)}</td>
              <td class="num nowrap">${money(l.lineTotal)}</td></tr>`)}</tbody></table></div>
          <div class="panel-body od-totals">
            ${kvList([
              [t('od.subtotal'), money(tot.subtotal)],
              tot.discount > 0 ? [`${t('od.discount')}${order.couponCode ? ` (${order.couponCode})` : ''}`, `− ${money(tot.discount)}`] : null,
              [t('od.shipping'), tot.shipping > 0 ? money(tot.shipping) : t('od.free')],
              [html`<strong>${t('od.total')}</strong>`, html`<strong>${money(tot.total)}</strong>`],
              [t('od.due'), money(amountDue(order))],
            ])}
          </div>`;
      };

      const timelineHtml = () => {
        const rows = [...events].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        const title = (e) => {
          if (e.type === 'status') return (ORDER_STATUS[e.status] && lbl(ORDER_STATUS[e.status])) || e.status;
          if (e.type === 'payment') return `${t('od.ev.payment')}: ${(PAYMENT_STATUS[e.status] && lbl(PAYMENT_STATUS[e.status])) || e.status}`;
          if (e.type === 'refund') return t('od.ev.refund');
          if (e.type === 'shipping') return t('od.ev.shipping');
          if (e.type === 'note') return e.visibility === 'internal' ? t('od.ev.noteInternal') : t('od.ev.noteCustomer');
          return e.type;
        };
        return html`<ol class="timeline mt-4">
          ${rows.map((e) => html`<li><div class="row row-wrap gap-2"><strong class="od-ev-title">${icon(EVENT_ICON[e.type] || 'clock', { size: 16 })}<span>${title(e)}</span></strong>${e.visibility === 'internal' ? badge(t('od.ev.internal')) : ''}</div>
            ${e.note ? html`<div class="od-note-text">${e.note}</div>` : ''}
            <div class="when">${[ROLES[e.actorRole] ? lbl(ROLES[e.actorRole]) : '', fmtDateTime(toMillis(e.createdAt))].filter(Boolean).join(' · ')}</div></li>`)}
          <li class="is-muted"><strong class="od-ev-title">${icon('package', { size: 16 })}<span>${t('od.ev.placed')}</span></strong><div class="when">${fmtDateTime(order.createdAtMs)}</div></li>
        </ol>`;
      };

      const noteFormHtml = () => (can('orders.update') || can('support.reply')) ? html`<form data-form="note" class="od-note-form" novalidate>
        ${fieldHtml({ name: 'text', label: t('od.note.label'), type: 'textarea', rows: 3, placeholder: t('od.note.placeholder'), attrs: { maxlength: ORDER_NOTE_MAX } })}
        <div class="row row-wrap gap-3 mt-2">
          ${fieldHtml({ name: 'visibility', label: t('od.note.vis'), type: 'select', options: [{ value: 'internal', label: t('od.note.internal') }, { value: 'customer', label: t('od.note.customer') }], value: 'internal', cls: 'grow' })}
          <button class="btn btn-primary" type="submit">${t('od.note.add')}</button>
        </div></form>` : '';

      /* status panel */
      const verbFor = (to) => {
        if (order.status === 'return_requested' && to === 'delivered') return t('od.act.rejectReturn');
        return t(`od.act.${to}`);
      };
      const nextList = () => allowedNext(order.status).filter((to) => to !== 'refunded');
      const statusPanel = () => {
        const nexts = nextList();
        const allowed = nexts.filter((to) => roleCan(staffRole(), requiredPermission(to)));
        const forward = allowed.filter((to) => to !== 'cancelled' && !(order.status === 'return_requested' && to === 'delivered'));
        const primary = forward[0];
        return html`<section class="panel" aria-labelledby="od-st-h"><div class="panel-head"><h2 id="od-st-h">${t('od.nextSteps')}</h2>${statusBadge(order.status)}</div>
          <div class="panel-body stack gap-2">
            ${!nexts.length ? html`<p class="muted">${t('od.noNext')}</p>` : !allowed.length ? html`<p class="muted">${t('od.noPermNext')}</p>` : allowed.map((to) => html`<button type="button" class="btn ${to === primary ? 'btn-primary' : (to === 'cancelled' ? 'btn-danger-ghost' : '')} btn-block" data-action="status" data-to="${to}">${verbFor(to)}</button>`)}
          </div></section>`;
      };

      /* payment panel */
      const payPanel = () => {
        const p = order.payment;
        const canPay = can('payments.verify') && !order.isLegacy && !['cancelled', 'refunded'].includes(order.status);
        const manual = MANUAL.has(p.method);
        const dup = trx && trx.orderId && trx.orderId !== order.id;
        const verifiable = canPay && manual && ['awaiting_verification', 'failed'].includes(p.status);
        return html`<section class="panel" aria-labelledby="od-pay-h"><div class="panel-head"><h2 id="od-pay-h">${t('od.pay')}</h2>${paymentBadge(p.status)}</div>
          <div class="panel-body">
            ${kvList([
              [t('od.pay.method'), methodLabel(p.method)],
              [t('od.pay.due'), money(p.amountDue ?? order.totals.total)],
              p.receivedAmount != null ? [t('od.pay.received'), money(p.receivedAmount)] : null,
              p.trxId ? [t('od.pay.trx'), html`<span class="mono">${p.trxId}</span> <button type="button" class="btn btn-ghost btn-sm" data-action="copy-trx" aria-label="${t('common.copy')}">${icon('copy', { size: 14 })}</button>`] : null,
              p.senderNumber ? [t('od.pay.sender'), html`<span class="mono">${showPhone(p.senderNumber)}</span>`] : null,
              p.status === 'failed' && p.failReason ? [t('od.pay.reason'), p.failReason] : null,
            ])}
            ${dup ? html`<p class="alert alert-bad mt-3">${icon('alert-triangle', { size: 18 })}<span>${t('od.pay.dup', { n: trx.orderId })}</span></p>` : ''}
            ${verifiable && p.status === 'awaiting_verification' ? html`<p class="alert mt-3">${icon('info', { size: 18 })}<span>${t('od.pay.checkHint')}</span></p>` : ''}
            <div class="stack gap-2 mt-4">
              ${verifiable ? html`<button type="button" class="btn btn-primary btn-block" data-action="pay-verify">${t('od.pay.verify')}</button>` : ''}
              ${verifiable && p.status === 'awaiting_verification' ? html`<button type="button" class="btn btn-block" data-action="pay-reject">${t('od.pay.reject')}</button>` : ''}
              ${canPay && p.method === 'cod' && p.status !== 'paid' && p.status !== 'refunded' ? html`<button type="button" class="btn btn-block" data-action="pay-cod">${t('od.pay.cod')}</button>` : ''}
            </div>
          </div></section>`;
      };

      /* customer + delivery */
      const custPanel = () => {
        const c = order.customer; const a = order.address || {};
        const phone = c.phone || a.phone || '';
        const email = c.email || '';
        const open = piiVisible();
        return html`<section class="panel" aria-labelledby="od-c-h"><div class="panel-head"><h2 id="od-c-h">${t('od.cust')}</h2></div>
          <div class="panel-body">
            <div class="strong">${c.name || a.name || '—'}</div>
            ${phone ? html`<div class="row gap-2 mt-2">${icon('phone', { size: 16 })}${open ? html`<a href="tel:${phone}">${fmtPhone(phone)}</a>` : html`<span class="mono">${showPhone(phone)}</span>`}</div>` : ''}
            ${email ? html`<div class="row gap-2 mt-2">${icon('mail', { size: 16 })}${open ? html`<a href="mailto:${email}">${email}</a>` : html`<span>${showEmail(email)}</span>`}</div>` : ''}
            ${!open ? html`<p class="muted small mt-3">${t('od.mask')}</p>` : ''}
            ${order.userId && can('customers.read') ? html`<p class="mt-3"><a class="btn btn-sm" href="${href('/customers/' + encodeURIComponent(order.userId))}">${icon('user', { size: 16 })}<span>${t('od.cust.profile')}</span></a></p>` : (!order.userId ? html`<p class="muted small mt-3">${t('od.cust.guest')}</p>` : '')}
            ${order.notes && order.notes.customer ? html`<div class="mt-4"><div class="small muted">${t('od.cust.note')}</div><div class="od-note-text">${order.notes.customer}</div></div>` : ''}
          </div></section>`;
      };

      const deliverPanel = () => {
        const a = order.address || {};
        const s = order.shipping || {};
        const open = piiVisible();
        const canEdit = can('orders.update') && !order.isLegacy && !['cancelled', 'refunded'].includes(order.status);
        const lines = open ? [a.line1, [a.area, a.upazila].filter(Boolean).join(', '), [districtName(a.district), a.postalCode].filter(Boolean).join(' ')].filter(Boolean) : [districtName(a.district)].filter(Boolean);
        return html`<section class="panel" aria-labelledby="od-d-h"><div class="panel-head"><h2 id="od-d-h">${t('od.deliver')}</h2>${canEdit ? html`<button type="button" class="btn btn-sm" data-action="tracking">${icon('edit', { size: 14 })}<span>${t('od.deliver.edit')}</span></button>` : ''}</div>
          <div class="panel-body">
            <address class="od-address">${lines.map((l) => html`<div>${l}</div>`)}</address>
            ${order.zoneName ? html`<p class="muted small mt-3">${t('od.deliver.zone')}: ${order.zoneName}</p>` : ''}
            <div class="mt-4">${s.carrier || s.trackingNo || s.trackingUrl
              ? kvList([
                s.carrier ? [t('od.deliver.carrier'), s.carrier] : null,
                s.trackingNo ? [t('od.deliver.tracking'), html`<span class="mono">${s.trackingNo}</span>`] : null,
                s.trackingUrl ? [t('od.deliver.tracking'), html`<a class="row gap-2" href="${safeUrl(s.trackingUrl)}" target="_blank" rel="noopener noreferrer">${icon('external-link', { size: 14 })}<span>${t('od.deliver.trackLink')}</span></a>`] : null,
              ])
              : html`<p class="muted small">${t('od.deliver.none')}</p>`}</div>
          </div></section>`;
      };

      const retPanel = () => ret ? html`<section class="panel" aria-labelledby="od-r-h"><div class="panel-head"><h2 id="od-r-h">${t('od.ret')}</h2>${badge(t(`od.ret.status.${ret.status}`, null, ret.status), ret.status === 'rejected' ? 'bad' : ret.status === 'requested' ? 'warn' : 'info')}</div>
        <div class="panel-body">${kvList([
          [t('od.ret.reason'), ret.reason],
          ret.details ? [t('od.ret.details'), ret.details] : null,
          [t('od.ret.lines'), (ret.lines || []).map((l) => { const it = order.items.find((i) => i.key === l.key); return `${it ? it.name : l.key} × ${num(l.qty)}`; }).join(', ')],
        ])}</div></section>` : '';

      const refundPanel = () => {
        if (order.status === 'refunded' && order.refund) {
          return html`<section class="panel" aria-labelledby="od-rf-h"><div class="panel-head"><h2 id="od-rf-h">${t('od.refund')}</h2>${statusBadge('refunded')}</div>
            <div class="panel-body"><p>${t('od.refund.recorded', { amount: money(order.refund.amount), method: order.refund.method || '—' })}</p></div></section>`;
        }
        if (!['returned', 'refund_pending'].includes(order.status) || !can('orders.refund') || order.isLegacy) return '';
        return html`<section class="panel" aria-labelledby="od-rf-h"><div class="panel-head"><h2 id="od-rf-h">${t('od.refund')}</h2></div>
          <div class="panel-body"><p class="muted small mb-3">${t('od.refund.help')}</p>
            <button type="button" class="btn btn-primary btn-block" data-action="refund">${t('od.refund.record')}</button></div></section>`;
      };

      const legacyHtml = () => order.isLegacy ? html`<p class="alert mb-4">${icon('info', { size: 18 })}<span>${t('od.legacyNote')}</span></p>` : '';

      const paint = () => {
        if (!order) return;
        render($('#od-head'), headHtml());
        render($('#od-legacy'), legacyHtml());
        render($('#od-items'), itemsHtml());
        render($('#od-timeline'), timelineHtml());
        render($('#od-aside'), html`${statusPanel()}${payPanel()}${custPanel()}${deliverPanel()}${retPanel()}${refundPanel()}`);
      };
      const showNotFound = () => render(ctx.el, html`<a class="back-link" href="${href('/orders')}">${icon('arrow-left', { size: 16 })}<span>${t('od.back')}</span></a>${emptyState({ icon: 'package', title: t('od.notFound'), text: t('od.notFoundText') })}`);

      /* ── live order ── */
      const apply = async (doc) => {
        if (ctx.signal.aborted) return;
        if (!doc) { order = null; showNotFound(); return; }
        const { id: docId, ...rest } = doc;
        order = normalizeOrder(docId, rest);
        const stamp = `${order.status}|${order.payment.status}|${order.updatedAtMs}`;
        const changed = lastStamp !== stamp;
        lastStamp = stamp;
        if (!ready || changed) await loadExtras();
        if (ctx.signal.aborted) return;
        if (!ready) { ready = true; render($('#od-note'), noteFormHtml()); }
        paint();
      };
      const first = new Promise((resolve) => {
        let done = false;
        const off = watchDoc(`orders/${id}`, async (doc) => { await apply(doc); if (!done) { done = true; resolve(); } }, (e) => {
          if (ctx.signal.aborted) return;
          console.warn('order not readable', e && e.code);
          showNotFound();
          if (!done) { done = true; resolve(); }
        });
        ctx.cleanup(off);
      });
      await first;
      if (ctx.signal.aborted || !order) return;

      /* ── helpers for actions ── */
      const refreshAll = async () => { await loadExtras(); if (!ctx.signal.aborted && order) paint(); };
      const attempt = async (fn, okMsg) => {
        try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) {
          if (!isRefusal(e)) reportError(e, 'order.action');   // a refusal with a message is an answer, not a crash
          toastError(errText(e));
          return false;
        }
      };
      const fieldErr = (form, errors) => { showFormErrors(form, errors); return Object.keys(errors).length === 0; };

      /* ── status step ── */
      const statusDialog = async (to) => {
        const label = verbFor(to);
        const s = order.shipping || {};
        const needsCarrier = to === 'shipped';
        const codUnpaid = to === 'delivered' && order.payment.method === 'cod' && order.payment.status !== 'paid' && can('payments.verify') && !order.isLegacy;
        const hint = t(`od.dlg.hint.${to}`, null, '');
        const body = html`<form novalidate class="stack gap-3">
          ${hint ? html`<p class="${to === 'cancelled' ? 'alert alert-warn' : 'muted small'}">${hint}</p>` : ''}
          ${to === 'cancelled' ? fieldHtml({ name: 'cancelReason', label: t('od.dlg.reason'), required: true, attrs: { maxlength: 200 } }) : ''}
          ${needsCarrier ? html`${fieldHtml({ name: 'carrier', label: t('od.dlg.carrier'), value: s.carrier || '', attrs: { maxlength: 60 } })}${fieldHtml({ name: 'trackingNo', label: t('od.dlg.tracking'), value: s.trackingNo || '', attrs: { maxlength: 80 } })}${fieldHtml({ name: 'trackingUrl', label: t('od.dlg.trackingUrl'), type: 'url', value: s.trackingUrl || '', attrs: { maxlength: 300, placeholder: 'https://' } })}` : ''}
          ${codUnpaid ? fieldHtml({ name: 'markCodPaid', label: t('od.dlg.cod'), type: 'checkbox', value: true }) : ''}
          ${to === 'returned' ? fieldHtml({ name: 'restock', label: t('od.dlg.restock'), type: 'checkbox', value: true }) : ''}
          ${to === 'cancelled' && order.couponCode && can('coupons.write') && !order.isLegacy ? fieldHtml({ name: 'restoreCoupon', label: t('od.dlg.restoreCoupon'), type: 'checkbox', value: false }) : ''}
          ${to !== 'cancelled' ? fieldHtml({ name: 'note', label: t('od.dlg.note'), type: 'textarea', rows: 2, attrs: { maxlength: 200 } }) : ''}
        </form>`;
        await formDialog({
          title: t('od.dlg.title', { label }), body, confirmText: label, danger: to === 'cancelled',
          onSubmit: async (form) => {
            const v = readForm(form);
            const errs = {};
            if (to === 'cancelled' && !v.cancelReason) errs.cancelReason = t('v.required');
            if (needsCarrier && v.trackingUrl && urlRule(v.trackingUrl)) errs.trackingUrl = urlRule(v.trackingUrl);
            if (!fieldErr(form, errs)) return false;
            const options = { note: v.note || '', carrier: v.carrier, trackingNo: v.trackingNo, trackingUrl: v.trackingUrl, markCodPaid: v.markCodPaid === true, restock: v.restock === true, restoreCoupon: v.restoreCoupon === true, cancelReason: v.cancelReason, returnDocExists: !!ret };
            const ok = await attempt(() => changeStatus(order, to, options), t('od.status.done'));
            if (ok) await refreshAll();
            return ok;
          },
        });
      };

      /* ── payment ── */
      const payVerify = async () => {
        const due = order.payment.amountDue ?? order.totals.total;
        await formDialog({
          title: t('od.pay.verifyTitle'), confirmText: t('od.pay.verify'),
          body: html`<form novalidate class="stack gap-3"><p class="alert">${icon('info', { size: 18 })}<span>${t('od.pay.checkHint')}</span></p>
            ${fieldHtml({ name: 'receivedAmount', label: t('od.pay.receivedLabel'), type: 'number', value: due, required: true, attrs: { min: due, step: 1, inputmode: 'numeric' }, hint: `${t('od.pay.due')}: ${money(due)}` })}
            ${fieldHtml({ name: 'note', label: t('od.dlg.note'), type: 'textarea', rows: 2, attrs: { maxlength: 200 } })}</form>`,
          onSubmit: async (form) => {
            const v = readForm(form);
            const amt = Number(v.receivedAmount);
            if (!fieldErr(form, !(Number.isFinite(amt) && amt >= due) ? { receivedAmount: t('v.minValue', { n: due }) } : {})) return false;
            const ok = await attempt(() => verifyPayment(order, { receivedAmount: amt, note: v.note || '' }), t('od.pay.done'));
            if (ok) await refreshAll();
            return ok;
          },
        });
      };
      const payReject = async () => {
        await formDialog({
          title: t('od.pay.rejectTitle'), confirmText: t('od.pay.reject'), danger: true,
          body: html`<form novalidate>${fieldHtml({ name: 'note', label: t('od.pay.rejectLabel'), type: 'textarea', rows: 3, required: true, attrs: { maxlength: 200 } })}</form>`,
          onSubmit: async (form) => {
            const v = readForm(form);
            if (!fieldErr(form, !v.note ? { note: t('v.required') } : {})) return false;
            const ok = await attempt(() => rejectPayment(order, { note: v.note }), t('od.pay.done'));
            if (ok) await refreshAll();
            return ok;
          },
        });
      };

      /* ── tracking / refund ── */
      const trackingDialog = async () => {
        const s = order.shipping || {};
        await formDialog({
          title: t('od.deliver.title'),
          body: html`<form novalidate class="stack gap-3">
            ${fieldHtml({ name: 'carrier', label: t('od.dlg.carrier'), value: s.carrier || '', attrs: { maxlength: 60 } })}
            ${fieldHtml({ name: 'trackingNo', label: t('od.dlg.tracking'), value: s.trackingNo || '', attrs: { maxlength: 80 } })}
            ${fieldHtml({ name: 'trackingUrl', label: t('od.dlg.trackingUrl'), type: 'url', value: s.trackingUrl || '', attrs: { maxlength: 300, placeholder: 'https://' } })}</form>`,
          onSubmit: async (form) => {
            const v = readForm(form);
            if (!fieldErr(form, v.trackingUrl && urlRule(v.trackingUrl) ? { trackingUrl: urlRule(v.trackingUrl) } : {})) return false;
            const ok = await attempt(() => updateTracking(order, { carrier: v.carrier, trackingNo: v.trackingNo, trackingUrl: v.trackingUrl }), t('od.deliver.saved'));
            if (ok) await refreshAll();
            return ok;
          },
        });
      };
      const refundDialog = async () => {
        await formDialog({
          title: t('od.refund'), confirmText: t('od.refund.record'),
          body: html`<form novalidate class="stack gap-3"><p class="muted small">${t('od.refund.help')}</p>
            ${fieldHtml({ name: 'amount', label: t('od.refund.amount'), type: 'number', value: order.totals.total, required: true, attrs: { min: 1, max: order.totals.total, step: 1, inputmode: 'numeric' }, hint: `${t('od.total')}: ${money(order.totals.total)}` })}
            ${fieldHtml({ name: 'method', label: t('od.refund.method'), type: 'select', value: order.payment.method === 'cod' ? 'cash' : order.payment.method, options: [{ value: 'bkash', label: lbl(PAYMENT_METHODS.bkash) }, { value: 'nagad', label: lbl(PAYMENT_METHODS.nagad) }, { value: 'bank', label: t('od.refund.bank') }, { value: 'cash', label: t('od.refund.cash') }, { value: 'other', label: t('od.refund.other') }] })}
            ${fieldHtml({ name: 'note', label: t('od.refund.note'), type: 'textarea', rows: 2, attrs: { maxlength: 300 } })}</form>`,
          onSubmit: async (form) => {
            const v = readForm(form);
            const amt = Number(v.amount);
            if (!fieldErr(form, !(Number.isInteger(amt) && amt >= 1 && amt <= order.totals.total) ? { amount: t('v.maxValue', { n: order.totals.total }) } : {})) return false;
            const ok = await attempt(() => refundOrder(order, { amount: amt, method: v.method, note: v.note || '' }), t('od.refund.done'));
            if (ok) await refreshAll();
            return ok;
          },
        });
      };

      /* ── printing ── */
      const printDoc = async (kind) => {
        try {
          const business = await loadBusiness();
          if (kind === 'invoice') await printDocument(invoiceHtml(order, { business }), { title: `Invoice ${order.orderNumber}` });
          else if (kind === 'slip') await printDocument(packingSlipHtml(order, { business }), { title: `Packing slip ${order.orderNumber}` });
          else await printDocument(shippingLabelHtml(order, { business }), { title: `Label ${order.orderNumber}`, paper: 'label' });
        } catch (e) { console.error(e); toastError(t('od.printFailed')); }
      };

      ctx.cleanup(bindActions(ctx.el, {
        copy: async () => { if (await copyText(order.orderNumber)) toast(t('od.copied'), { timeout: 1500 }); },
        'copy-trx': async () => { if (await copyText(order.payment.trxId)) toast(t('od.copied'), { timeout: 1500 }); },
        'print-menu': (btn) => openMenu({ anchor: btn, items: [
          { label: t('od.print.invoice'), icon: 'file-text', onClick: () => printDoc('invoice') },
          { label: t('od.print.slip'), icon: 'package', onClick: () => printDoc('slip') },
          { label: t('od.print.label'), icon: 'truck', onClick: () => printDoc('label') },
        ] }),
        status: (el) => statusDialog(el.dataset.to),
        'pay-verify': payVerify,
        'pay-reject': payReject,
        'pay-cod': async () => {
          if (!(await confirmDialog({ title: t('od.pay.codTitle'), message: `${money(order.totals.total)}`, confirmText: t('od.pay.cod') }))) return;
          if (await attempt(() => markCodPaid(order), t('od.pay.done'))) await refreshAll();
        },
        tracking: trackingDialog,
        refund: refundDialog,
      }, {
        submit: {
          note: async (form) => {
            const v = readForm(form);
            const btn = form.querySelector('[type="submit"]');
            if (!fieldErr(form, !v.text ? { text: t('v.required') } : {})) return;
            btn.disabled = true;
            const ok = await attempt(() => addOrderNote(order, { text: v.text, visibility: v.visibility }), t('od.note.added'));
            btn.disabled = false;
            if (ok) { form.reset(); await refreshAll(); }
          },
        },
      }));
    });
  },
};
