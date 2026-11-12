/*
 * Order confirmation — /order-success/:id   (sign-in required)
 * Reads the order back from Firestore (never from the checkout page's memory), so what is shown is what was stored.
 */
import { html, render, bindActions, setMeta, copyText } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, emptyState, errorState, toast, statusBadge, paymentBadge } from '../../core/ui.js';
import { money, num } from '../../core/format.js';
import { getMyOrder } from '../../data/orders.js';
import { orderLinesHtml, orderTotalsHtml, addressHtml, paymentHtml, paymentNote, methodName } from '../components/orderParts.js';

registerBoth({
  'os.title': ['Order placed', 'অর্ডার সম্পন্ন'],
  'os.thanks': ['Thank you, {name}!', 'ধন্যবাদ, {name}!'],
  'os.thanksNoName': ['Thank you!', 'ধন্যবাদ!'],
  'os.placed': ['Your order has been placed.', 'আপনার অর্ডার জমা হয়েছে।'],
  'os.number': ['Order number', 'অর্ডার নম্বর'],
  'os.copy': ['Copy order number', 'অর্ডার নম্বর কপি করুন'],
  'os.copied': ['Order number copied', 'অর্ডার নম্বর কপি হয়েছে'],
  'os.next': ['What happens next', 'এরপর কী হবে'],
  'os.cod1': ['We confirm your order by phone or message.', 'আমরা ফোন বা মেসেজে আপনার অর্ডার নিশ্চিত করব।'],
  'os.cod2': ['We pack it and send it to {district}.', 'প্যাক করে {district}-এ পাঠানো হবে।'],
  'os.cod3': ['Pay {amount} in cash to the courier on delivery.', 'ডেলিভারির সময় কুরিয়ারকে {amount} নগদে দিন।'],
  'os.mm1': ['Our team checks your {method} payment (TrxID {trx}).', 'আমাদের টিম আপনার {method} পেমেন্ট (TrxID {trx}) মিলিয়ে দেখবে।'],
  'os.mm2': ['When it is verified the order is confirmed and packed.', 'যাচাই হলে অর্ডার নিশ্চিত হবে এবং প্যাক করা হবে।'],
  'os.mm3': ['If we cannot verify it, we contact you. You can also send the TrxID again from My orders.', 'যাচাই করতে না পারলে আমরা যোগাযোগ করব। চাইলে "আমার অর্ডার" থেকে আবার TrxID পাঠাতে পারবেন।'],
  'os.items': ['Items', 'পণ্য'],
  'os.address': ['Delivery address', 'ডেলিভারির ঠিকানা'],
  'os.payment': ['Payment', 'পেমেন্ট'],
  'os.view': ['View order', 'অর্ডার দেখুন'],
  'os.continue': ['Continue shopping', 'কেনাকাটা চালিয়ে যান'],
  'os.missing': ['We could not find this order', 'এই অর্ডারটি খুঁজে পাওয়া যায়নি'],
  'os.missingText': ['It may belong to a different account. Check My orders, or contact us with your order number.', 'এটি অন্য অ্যাকাউন্টের হতে পারে। "আমার অর্ডার" দেখুন, অথবা অর্ডার নম্বরসহ আমাদের জানান।'],
  'os.myOrders': ['My orders', 'আমার অর্ডার'],
  'os.loadError': ['The order could not be loaded.', 'অর্ডারটি লোড করা যায়নি।'],
});

export default {
  async mount(ctx) {
    loadCss('/css/pages/order.css');
    setMeta({ title: t('os.title'), noindex: true });
    const id = ctx.params.id;
    render(ctx.el, html`<div class="container page" aria-busy="true"><div class="skeleton" style="height:260px;border-radius:var(--r-lg)"></div></div>`);
    let order;
    try { order = await getMyOrder(id); } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(ctx.el, html`<div class="container page">${errorState({ text: t('os.loadError') })}</div>`);
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;
    if (!order) {
      render(ctx.el, html`<div class="container page">${emptyState({ icon: 'package', title: t('os.missing'), text: t('os.missingText'), action: { href: '/account/orders', label: t('os.myOrders') } })}</div>`);
      return;
    }

    const first = String((order.address && order.address.name) || order.customer.name || '').trim().split(/\s+/)[0] || '';
    const mobile = order.payment.method !== 'cod';
    const next = mobile
      ? [t('os.mm1', { method: methodName(order.payment.method), trx: order.payment.trxId }), t('os.mm2'), t('os.mm3')]
      : [t('os.cod1'), t('os.cod2', { district: (order.address && order.address.district) || '' }), t('os.cod3', { amount: money(order.payment.amountDue || order.totals.total) })];
    const note = paymentNote(order);

    render(ctx.el, html`<div class="container page"><div class="os">
      <section class="os-hero" aria-labelledby="os-h">
        <span class="os-tick" aria-hidden="true">${icon('check', { size: 30 })}</span>
        <h1 id="os-h">${first ? t('os.thanks', { name: first }) : t('os.thanksNoName')}</h1>
        <p>${t('os.placed')}</p>
        <div class="os-number"><span class="muted">${t('os.number')}</span><strong>${order.orderNumber}</strong>
          <button type="button" class="btn btn-secondary btn-sm" data-action="copy" aria-label="${t('os.copy')}">${icon('copy', { size: 14 })}</button></div>
        <div class="os-badges">${statusBadge(order.status)}${paymentBadge(order.payment.status)}</div>
        ${note ? html`<p>${note}</p>` : ''}
      </section>

      <section class="ord-card" aria-labelledby="os-next-h"><h2 id="os-next-h">${t('os.next')}</h2>
        <ol class="os-next">${next.map((n) => html`<li>${n}</li>`)}</ol></section>

      <section class="ord-card" aria-labelledby="os-items-h"><h2 id="os-items-h">${t('os.items')} <span class="muted small">(${num(order.items.reduce((s, l) => s + l.qty, 0))})</span></h2>
        ${orderLinesHtml(order)}${orderTotalsHtml(order)}</section>

      <div class="os-cols">
        <section class="ord-card" aria-labelledby="os-addr-h"><h2 id="os-addr-h">${t('os.address')}</h2>${addressHtml(order)}</section>
        <section class="ord-card" aria-labelledby="os-pay-h"><h2 id="os-pay-h">${t('os.payment')}</h2>${paymentHtml(order)}</section>
      </div>

      <div class="os-actions">
        <a class="btn btn-primary" href="/account/orders/${order.id}">${t('os.view')}</a>
        <a class="btn btn-secondary" href="/shop">${t('os.continue')}</a>
      </div>
    </div></div>`);

    ctx.cleanup(bindActions(ctx.el, { copy: async () => { if (await copyText(order.orderNumber)) toast(t('os.copied')); } }));
  },
};
