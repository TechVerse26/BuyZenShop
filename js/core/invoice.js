/*
 * Printable invoice — shared by the customer's order page and the admin order page.
 *
 *   invoiceHtml(order, store)    SafeHtml for one normalised order (shared/orderModel.normalizeOrder)
 *                                store = settings(): { name, logoUrl, contact: { phone, email, address } }
 *   printInvoice(order, store)   prints just the invoice through the browser print dialog ("Save as PDF" works too)
 *
 * The sheet is appended to <body> only while printing; css/pages/invoice.css hides everything else (@media print).
 * Prices are VAT-inclusive (there is no tax line), and "paid" is shown only when staff verified the payment.
 */
import { html, render, safeUrl } from './dom.js';
import { registerBoth, t, pick } from './i18n.js';
import { money, num, fmtDate, fmtPhone } from './format.js';
import { loadCss } from './ui.js';
import { ORDER_STATUS, PAYMENT_STATUS, PAYMENT_METHODS } from '../shared/constants.js';

registerBoth({
  'inv.title': ['Invoice', 'ইনভয়েস'],
  'inv.order': ['Order', 'অর্ডার'],
  'inv.date': ['Date', 'তারিখ'],
  'inv.status': ['Order status', 'অর্ডারের অবস্থা'],
  'inv.payment': ['Payment', 'পেমেন্ট'],
  'inv.trx': ['TrxID', 'TrxID'],
  'inv.deliverTo': ['Deliver to', 'ডেলিভারির ঠিকানা'],
  'inv.item': ['Item', 'পণ্য'],
  'inv.qty': ['Qty', 'পরিমাণ'],
  'inv.unit': ['Unit price', 'একক দাম'],
  'inv.amount': ['Amount', 'মোট'],
  'inv.subtotal': ['Subtotal', 'সাবটোটাল'],
  'inv.discount': ['Discount', 'ছাড়'],
  'inv.delivery': ['Delivery', 'ডেলিভারি'],
  'inv.free': ['Free', 'ফ্রি'],
  'inv.total': ['Total', 'সর্বমোট'],
  'inv.due': ['Amount due on delivery', 'ডেলিভারির সময় প্রদেয়'],
  'inv.note': ['Prices include VAT where applicable. Thank you for shopping with us.', 'দামে প্রযোজ্য ভ্যাট অন্তর্ভুক্ত। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।'],
  'inv.aria': ['Invoice table', 'ইনভয়েসের তালিকা'],
});

const label = (map, id) => { const x = map[id]; return x ? pick(x.label, x.bn) : String(id || ''); };

export function invoiceHtml(order, store = {}) {
  const c = store.contact || {};
  const a = order.address || {};
  const x = order.totals;
  const p = order.payment;
  const addr = [a.line1, a.area, a.upazila, a.district, a.postalCode].filter(Boolean).join(', ');
  const dueOnDelivery = p.method === 'cod' && p.status !== 'paid' && order.status !== 'cancelled';
  return html`<article class="invoice" aria-label="${t('inv.title')} ${order.orderNumber}">
    <header class="invoice-head">
      <div class="invoice-brand">
        ${store.logoUrl ? html`<img src="${safeUrl(store.logoUrl)}" alt="${store.name || ''}" height="40">` : ''}
        <strong>${store.name || ''}</strong>
        <span>${[c.address, c.phone ? fmtPhone(c.phone) : '', c.email].filter(Boolean).join(' · ')}</span>
      </div>
      <div class="invoice-title"><h1>${t('inv.title')}</h1><span>${order.orderNumber}</span></div>
    </header>

    <dl class="invoice-meta">
      <div><dt>${t('inv.date')}</dt><dd>${order.createdAtMs ? fmtDate(order.createdAtMs, { month: 'long' }) : '—'}</dd></div>
      <div><dt>${t('inv.status')}</dt><dd>${label(ORDER_STATUS, order.status)}</dd></div>
      <div><dt>${t('inv.payment')}</dt><dd>${label(PAYMENT_METHODS, p.method)} — ${label(PAYMENT_STATUS, p.status)}${p.trxId ? html` · ${t('inv.trx')} ${p.trxId}` : ''}</dd></div>
    </dl>

    <section class="invoice-to"><h2>${t('inv.deliverTo')}</h2>
      <p><strong>${a.name || order.customer.name || ''}</strong><br>${fmtPhone(a.phone || order.customer.phone || '')}<br>${addr}</p></section>

    <table class="invoice-table" aria-label="${t('inv.aria')}">
      <thead><tr><th scope="col">${t('inv.item')}</th><th scope="col" class="num">${t('inv.qty')}</th><th scope="col" class="num">${t('inv.unit')}</th><th scope="col" class="num">${t('inv.amount')}</th></tr></thead>
      <tbody>${order.items.map((l) => html`<tr>
        <td>${l.name}${l.variantLabel ? html`<br><span class="invoice-sub">${l.variantLabel}</span>` : ''}${l.sku ? html`<br><span class="invoice-sub">${l.sku}</span>` : ''}</td>
        <td class="num">${num(l.qty)}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.lineTotal)}</td></tr>`)}</tbody>
    </table>

    <dl class="invoice-totals">
      <div><dt>${t('inv.subtotal')}</dt><dd>${money(x.subtotal)}</dd></div>
      ${x.discount ? html`<div><dt>${t('inv.discount')}${order.couponCode ? ` (${order.couponCode})` : ''}</dt><dd>−${money(x.discount)}</dd></div>` : ''}
      <div><dt>${t('inv.delivery')}</dt><dd>${x.shipping ? money(x.shipping) : t('inv.free')}</dd></div>
      <div class="is-total"><dt>${t('inv.total')}</dt><dd>${money(x.total)}</dd></div>
      ${dueOnDelivery ? html`<div><dt>${t('inv.due')}</dt><dd>${money(p.amountDue || x.total)}</dd></div>` : ''}
    </dl>
    <footer class="invoice-foot">${t('inv.note')}</footer>
  </article>`;
}

export async function printInvoice(order, store = {}) {
  await loadCss('/css/pages/invoice.css');
  document.querySelectorAll('.invoice-sheet').forEach((n) => n.remove());
  const sheet = document.createElement('div');
  sheet.className = 'invoice-sheet';
  render(sheet, invoiceHtml(order, store));
  document.body.appendChild(sheet);
  const root = document.documentElement;
  root.classList.add('is-printing-invoice');
  const cleanup = () => { root.classList.remove('is-printing-invoice'); sheet.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();                       // blocks in most browsers; `afterprint` removes the sheet again
}
