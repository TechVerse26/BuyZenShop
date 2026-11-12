/*
 * Account → one order (/account/orders/:id)
 *
 *   progress, items + totals, address, payment, history
 *   actions: print invoice · buy again · cancel (pending, unpaid) · request a return (delivered, inside the return window)
 *            · send the TrxID again (manual payment that staff marked "failed")
 * Every change goes through data/orders.js, which builds the atomic write set that firestore.rules re-validates.
 */
import { html, render, bindActions, readForm, withBusy } from '../../../core/dom.js';
import { registerBoth, t, pick } from '../../../core/i18n.js';
import { icon } from '../../../core/icons.js';
import { loadCss, skeletonRows, emptyState, errorState, toast, toastError, formDialog, fieldHtml, statusBadge, paymentBadge, announce } from '../../../core/ui.js';
import { explainError, AppError } from '../../../core/errors.js';
import { validateForm, showFormErrors, required, trxId as trxValidator, phone as phoneValidator } from '../../../core/validate.js';
import { fmtDateTime, num } from '../../../core/format.js';
import { printInvoice } from '../../../core/invoice.js';
import { getMyOrder, listOrderEvents, cancelMyOrder, requestReturn, resubmitPayment, returnWindowDays } from '../../../data/orders.js';
import { currentUid } from '../../../data/auth.js';
import { settings } from '../../../data/settings.js';
import { cart } from '../../../data/cart.js';
import { loadCatalog, productById } from '../../../data/catalog.js';
import { customerCanCancel, customerCanRequestReturn } from '../../../shared/orderFlow.js';
import { productUrl } from '../../lib/links.js';
import { orderLinesHtml, orderTotalsHtml, addressHtml, paymentHtml, paymentNote, stepsHtml, timelineEntries, eventsHtml } from '../../components/orderParts.js';

registerBoth({
  'od.back': ['My orders', 'আমার অর্ডার'],
  'od.placedOn': ['Placed {date}', 'অর্ডারের সময় {date}'],
  'od.invoice': ['Invoice', 'ইনভয়েস'],
  'od.again': ['Buy again', 'আবার কিনুন'],
  'od.cancel': ['Cancel order', 'অর্ডার বাতিল'],
  'od.return': ['Request a return', 'রিটার্নের অনুরোধ'],
  'od.help': ['Need help with this order?', 'এই অর্ডার নিয়ে সাহায্য লাগবে?'],
  'od.helpLink': ['Contact support', 'সাপোর্টে লিখুন'],
  'od.items': ['Items', 'পণ্য'],
  'od.address': ['Delivery address', 'ডেলিভারির ঠিকানা'],
  'od.payment': ['Payment', 'পেমেন্ট'],
  'od.history': ['History', 'ইতিহাস'],
  'od.review': ['Write a review', 'রিভিউ লিখুন'],
  'od.notFound': ['Order not found', 'অর্ডার পাওয়া যায়নি'],
  'od.notFoundText': ['This order does not exist or belongs to another account.', 'এই অর্ডারটি নেই, অথবা অন্য অ্যাকাউন্টের।'],
  'od.loadError': ['The order could not be loaded.', 'অর্ডারটি লোড করা যায়নি।'],
  'od.added': ['Items added to your cart', 'পণ্যগুলো কার্টে যোগ হয়েছে'],
  'od.legacy': ['This order was placed before the store upgrade, so some actions are not available. Contact support if you need help.', 'এই অর্ডারটি স্টোর আপগ্রেডের আগের, তাই কিছু অপশন নেই। সাহায্য লাগলে সাপোর্টে লিখুন।'],
  /* cancel */
  'od.c.title': ['Cancel this order?', 'অর্ডারটি বাতিল করবেন?'],
  'od.c.text': ['The items are released back to stock. This cannot be undone.', 'পণ্যগুলো আবার স্টকে ফিরে যাবে। এটি ফেরানো যাবে না।'],
  'od.c.reason': ['Reason (optional)', 'কারণ (ঐচ্ছিক)'],
  'od.c.pick': ['Choose a reason', 'কারণ বেছে নিন'],
  'od.c.keep': ['Keep order', 'অর্ডার রাখুন'],
  'od.c.confirm': ['Cancel order', 'অর্ডার বাতিল করুন'],
  'od.c.done': ['Order cancelled', 'অর্ডার বাতিল হয়েছে'],
  /* return */
  'od.r.title': ['Request a return', 'রিটার্নের অনুরোধ'],
  'od.r.text': ['Choose the items you want to send back. Our team reviews every request and will contact you.', 'যেসব পণ্য ফেরত দিতে চান বেছে নিন। আমাদের টিম প্রতিটি অনুরোধ দেখে আপনার সাথে যোগাযোগ করবে।'],
  'od.r.window': ['Returns are accepted within {n} days of delivery.', 'ডেলিভারির {n} দিনের মধ্যে রিটার্ন নেওয়া হয়।'],
  'od.r.items': ['Items to return', 'ফেরত দেওয়ার পণ্য'],
  'od.r.qty': ['Quantity of {name}', '{name}-এর পরিমাণ'],
  'od.r.reason': ['Reason', 'কারণ'],
  'od.r.details': ['Details (optional)', 'বিস্তারিত (ঐচ্ছিক)'],
  'od.r.detailsPh': ['What is wrong with the item?', 'পণ্যে কী সমস্যা?'],
  'od.r.confirm': ['Send request', 'অনুরোধ পাঠান'],
  'od.r.done': ['Return request sent', 'রিটার্নের অনুরোধ পাঠানো হয়েছে'],
  'od.r.noLines': ['Select at least one item.', 'কমপক্ষে একটি পণ্য বাছুন।'],
  'od.r.noReason': ['Choose a reason.', 'কারণ বেছে নিন।'],
  /* pay again */
  'od.p.title': ['Send the transaction ID again', 'ট্রানজেকশন আইডি আবার পাঠান'],
  'od.p.text': ['We could not verify your payment. Check the TrxID in your payment message and the number you paid from.', 'আপনার পেমেন্ট যাচাই করা যায়নি। পেমেন্ট মেসেজের TrxID এবং যে নম্বর থেকে পাঠিয়েছেন সেটি দেখে নিন।'],
  'od.p.sender': ['Number you paid from', 'যে নম্বর থেকে টাকা পাঠিয়েছেন'],
  'od.p.trx': ['Transaction ID (TrxID)', 'ট্রানজেকশন আইডি (TrxID)'],
  'od.p.send': ['Send for verification', 'যাচাইয়ের জন্য পাঠান'],
  'od.p.done': ['Sent. We will check it again.', 'পাঠানো হয়েছে। আমরা আবার যাচাই করব।'],
});

const CANCEL_REASONS = [
  ['Ordered by mistake', 'ভুল করে অর্ডার হয়েছে'], ['Want to change the order', 'অর্ডার বদলাতে চাই'], ['Found a better price', 'অন্য জায়গায় কম দাম পেয়েছি'],
  ['Delivery takes too long', 'ডেলিভারিতে বেশি সময় লাগবে'], ['Other', 'অন্য কারণ'],
];
const RETURN_REASONS = [
  ['Damaged or defective', 'ক্ষতিগ্রস্ত বা ত্রুটিপূর্ণ'], ['Wrong item received', 'ভুল পণ্য এসেছে'], ['Not as described', 'বিবরণের সাথে মেলেনি'],
  ['Size or fit issue', 'সাইজ বা ফিট সমস্যা'], ['Changed my mind', 'মত বদলেছে'], ['Other', 'অন্য কারণ'],
];
const reasonOptions = (list, placeholder) => [{ value: '', label: placeholder }, ...list.map(([en, bn]) => ({ value: en, label: pick(en, bn) }))];

export default {
  async mount(ctx) {
    const uid = currentUid();
    const id = ctx.params.id;
    render(ctx.el, skeletonRows(4));
    loadCss('/css/pages/order.css');
    let order; let events;
    try {
      [order, events] = await Promise.all([getMyOrder(id), listOrderEvents(id, uid).catch(() => [])]);
    } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(ctx.el, errorState({ text: t('od.loadError') }));
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;
    if (!order || order.userId !== uid) {
      render(ctx.el, html`<a class="back-link" href="/account/orders">${icon('arrow-left', { size: 16 })}<span>${t('od.back')}</span></a>${emptyState({ icon: 'package', title: t('od.notFound'), text: t('od.notFoundText') })}`);
      return;
    }

    let cat = null;
    if (order.status === 'delivered') { try { cat = await loadCatalog(); } catch { cat = null; } if (ctx.signal.aborted) return; }

    const windowDays = returnWindowDays();
    const canCancel = customerCanCancel(order);
    const canReturn = customerCanRequestReturn(order, Date.now(), windowDays);
    const canPayAgain = order.payment.method !== 'cod' && order.payment.status === 'failed' && order.status === 'pending';
    const note = paymentNote(order);
    const noteTone = order.payment.status === 'failed' ? 'alert-bad' : order.payment.status === 'paid' ? 'alert-ok' : '';
    const noteIcon = order.payment.status === 'failed' ? 'alert-circle' : order.payment.status === 'paid' ? 'check-circle' : 'info';
    const reviewLink = (l) => {
      const p = cat && l.productId ? productById(cat, l.productId) : null;
      return p ? html`<a class="small" href="${productUrl(p)}#reviews">${t('od.review')}</a>` : '';
    };

    render(ctx.el, html`
      <a class="back-link" href="/account/orders">${icon('arrow-left', { size: 16 })}<span>${t('od.back')}</span></a>

      <section class="ord-card od-head" aria-labelledby="od-h">
        <div class="od-title"><h2 id="od-h" class="mono">${order.orderNumber}</h2>
          ${order.createdAtMs ? html`<p class="muted small">${t('od.placedOn', { date: fmtDateTime(order.createdAtMs) })}</p>` : ''}</div>
        <div class="od-badges">${statusBadge(order.status)}${paymentBadge(order.payment.status)}</div>
        <div class="od-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="invoice">${icon('printer', { size: 16 })}<span>${t('od.invoice')}</span></button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="again">${icon('refresh', { size: 16 })}<span>${t('od.again')}</span></button>
          ${canReturn ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="return">${icon('undo', { size: 16 })}<span>${t('od.return')}</span></button>` : ''}
          ${canCancel ? html`<button type="button" class="btn btn-danger btn-sm" data-action="cancel">${icon('x-circle', { size: 16 })}<span>${t('od.cancel')}</span></button>` : ''}
        </div>
      </section>

      ${order.isLegacy ? html`<p class="alert">${icon('info', { size: 18 })}<span>${t('od.legacy')}</span></p>` : ''}
      <section class="ord-card">${stepsHtml(order)}</section>
      ${note ? html`<p class="alert ${noteTone}">${icon(noteIcon, { size: 18 })}<span>${note}</span></p>` : ''}

      ${canPayAgain ? html`<section class="ord-card" aria-labelledby="od-pay-h"><h2 id="od-pay-h">${t('od.p.title')}</h2>
        <p class="muted small">${t('od.p.text')}</p>
        <form class="acc-form" data-form="payagain" novalidate>
          ${fieldHtml({ name: 'senderNumber', label: t('od.p.sender'), type: 'tel', required: true, inputmode: 'tel', autocomplete: 'off' })}
          ${fieldHtml({ name: 'trxId', label: t('od.p.trx'), required: true, autocomplete: 'off', attrs: { autocapitalize: 'characters', spellcheck: 'false', maxlength: 24 } })}
          <div><button type="submit" class="btn btn-primary">${t('od.p.send')}</button></div>
        </form></section>` : ''}

      <section class="ord-card" aria-labelledby="od-items-h"><h2 id="od-items-h">${t('od.items')} <span class="muted small">(${num(order.items.reduce((s, l) => s + l.qty, 0))})</span></h2>
        ${orderLinesHtml(order, { after: order.status === 'delivered' ? reviewLink : null })}${orderTotalsHtml(order)}</section>

      <div class="os-cols">
        <section class="ord-card" aria-labelledby="od-addr-h"><h2 id="od-addr-h">${t('od.address')}</h2>${addressHtml(order)}</section>
        <section class="ord-card" aria-labelledby="od-paym-h"><h2 id="od-paym-h">${t('od.payment')}</h2>${paymentHtml(order)}</section>
      </div>

      <section class="ord-card" aria-labelledby="od-hist-h"><h2 id="od-hist-h">${t('od.history')}</h2>${eventsHtml(timelineEntries(order, events))}</section>

      <p class="od-help muted">${t('od.help')} <a href="/account/support?order=${encodeURIComponent(order.orderNumber)}">${t('od.helpLink')}</a></p>`);

    /* ───────── actions ───────── */
    const reload = () => ctx.router.reload();

    const doCancel = async () => {
      const done = await formDialog({
        title: t('od.c.title'), danger: true, confirmText: t('od.c.confirm'), cancelText: t('od.c.keep'),
        body: html`<p>${t('od.c.text')}</p><form novalidate>${fieldHtml({ name: 'reason', label: t('od.c.reason'), type: 'select', options: reasonOptions(CANCEL_REASONS, t('od.c.pick')) })}</form>`,
        onSubmit: async (form) => {
          try { await cancelMyOrder(order, uid, readForm(form).reason); return true; } catch (e) { toastError(e instanceof AppError ? e.message : explainError(e)); return false; }
        },
      });
      if (done === true) { toast(t('od.c.done')); announce(t('od.c.done')); reload(); }
    };

    const doReturn = async () => {
      const done = await formDialog({
        title: t('od.r.title'), confirmText: t('od.r.confirm'),
        body: html`<p>${t('od.r.text')}</p><p class="muted small">${t('od.r.window', { n: num(windowDays) })}</p>
          <form class="od-ret" novalidate>
            <fieldset class="od-ret-lines"><legend>${t('od.r.items')}</legend>
              ${order.items.map((l) => html`<div class="od-ret-line">
                <label class="check"><input type="checkbox" name="line" value="${l.key}"><span>${l.name}${l.variantLabel ? html` <span class="muted">(${l.variantLabel})</span>` : ''}</span></label>
                <select class="select" name="qty-${l.key}" aria-label="${t('od.r.qty', { name: l.name })}">${Array.from({ length: l.qty }, (_, i) => html`<option value="${i + 1}" ${i + 1 === l.qty ? 'selected' : ''}>${num(i + 1)}</option>`)}</select>
              </div>`)}
              <div class="field-error" id="err-lines" aria-live="polite"></div>
            </fieldset>
            ${fieldHtml({ name: 'reason', label: t('od.r.reason'), type: 'select', required: true, options: reasonOptions(RETURN_REASONS, t('od.c.pick')) })}
            ${fieldHtml({ name: 'details', label: t('od.r.details'), type: 'textarea', rows: 3, placeholder: t('od.r.detailsPh'), attrs: { maxlength: 600 } })}
          </form>`,
        onSubmit: async (form) => {
          const checked = [...form.querySelectorAll('input[name="line"]:checked')];
          const v = readForm(form);
          const errors = {};
          if (!checked.length) { form.querySelector('#err-lines').textContent = t('od.r.noLines'); } else form.querySelector('#err-lines').textContent = '';
          if (!v.reason) errors.reason = t('od.r.noReason');
          showFormErrors(form, errors);
          if (!checked.length || errors.reason) return false;
          const lines = checked.map((c) => ({ key: c.value, qty: Number(form.elements[`qty-${c.value}`].value) || 1 }));
          try { await requestReturn(order, uid, { lines, reason: v.reason, details: v.details }); return true; } catch (e) { toastError(e instanceof AppError ? e.message : explainError(e)); return false; }
        },
      });
      if (done === true) { toast(t('od.r.done')); announce(t('od.r.done')); reload(); }
    };

    ctx.cleanup(bindActions(ctx.el, {
      invoice: () => printInvoice(order, settings()),
      again: () => {
        let added = 0;
        for (const l of order.items) {
          try { cart.add(l.key, l.qty); added += 1; } catch (e) { if (e instanceof AppError) { toastError(e.message); break; } throw e; }
        }
        if (added) { toast(t('od.added')); ctx.router.navigate('/cart'); }
      },
      cancel: () => doCancel(),
      return: () => doReturn(),
    }, {
      submit: {
        payagain: async (form) => {
          const v = readForm(form);
          const { ok, errors } = validateForm(v, { senderNumber: [required, phoneValidator], trxId: [required, trxValidator] });
          showFormErrors(form, errors);
          if (!ok) return;
          await withBusy(form.querySelector('[type="submit"]'), async () => {
            try { await resubmitPayment(order, uid, { trxId: v.trxId, senderNumber: v.senderNumber }); toast(t('od.p.done')); reload(); }
            catch (e) { toastError(e instanceof AppError ? e.message : explainError(e)); }
          });
        },
      },
    }));
  },
};
