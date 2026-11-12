/*
 * Cart page — /cart
 * Lines come from data/cart.js (key + quantity only); names, pictures, prices and stock come from the catalog, with the
 * inventory of the cart's items re-read from Firestore when the page opens. Anything that would stop checkout (sold out,
 * removed, quantity above stock) is shown on its line with a one-tap fix. Shipping and coupons are applied at checkout.
 */
import { html, render, bindActions, setMeta, safeUrl } from '../../core/dom.js';
import { registerBoth, t, tn, pick } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, emptyState, errorState, confirmDialog, toast, toastError, announce } from '../../core/ui.js';
import { explainError } from '../../core/errors.js';
import { money, num } from '../../core/format.js';
import { cart, resolveCart } from '../../data/cart.js';
import { loadCatalog, refreshInventory } from '../../data/catalog.js';
import { enabledPayments } from '../../data/settings.js';
import { isSignedIn } from '../../data/auth.js';
import { assetUrl } from '../../shared/productModel.js';
import { LIMITS } from '../../shared/constants.js';
import { productUrl } from '../lib/links.js';

registerBoth({
  'cartp.title': ['Shopping cart', 'আপনার কার্ট'],
  'cartp.items_one': ['{n} item', '{n}টি পণ্য'],
  'cartp.items_other': ['{n} items', '{n}টি পণ্য'],
  'cartp.empty': ['Your cart is empty', 'আপনার কার্ট খালি'],
  'cartp.emptyText': ['Add something you like and it will wait for you here.', 'পছন্দের কিছু যোগ করুন, এখানেই থাকবে।'],
  'cartp.shop': ['Start shopping', 'শপিং শুরু করুন'],
  'cartp.loadError': ['Your cart could not be loaded.', 'কার্ট লোড করা যায়নি।'],
  'cartp.qty': ['Quantity of {name}', '{name}-এর পরিমাণ'],
  'cartp.dec': ['Decrease quantity', 'পরিমাণ কমান'],
  'cartp.inc': ['Increase quantity', 'পরিমাণ বাড়ান'],
  'cartp.remove': ['Remove', 'সরান'],
  'cartp.removed': ['{name} removed', '{name} সরানো হয়েছে'],
  'cartp.each': ['{price} each', 'প্রতিটি {price}'],
  'cartp.gone': ['This item is no longer available.', 'এই পণ্যটি আর পাওয়া যাচ্ছে না।'],
  'cartp.out': ['Out of stock right now.', 'এই মুহূর্তে স্টকে নেই।'],
  'cartp.limited': ['Only {n} available.', 'মাত্র {n}টি আছে।'],
  'cartp.setMax': ['Set to {n}', '{n}টিতে নামান'],
  'cartp.priceChanged': ['Price changed from {from} to {to}.', 'দাম বদলেছে: {from} থেকে {to}।'],
  'cartp.accept': ['OK', 'ঠিক আছে'],
  'cartp.summary': ['Order summary', 'অর্ডারের সারাংশ'],
  'cartp.subtotal': ['Subtotal', 'সাবটোটাল'],
  'cartp.later': ['Delivery charge and coupons are applied at checkout.', 'ডেলিভারি চার্জ ও কুপন চেকআউটে যোগ হবে।'],
  'cartp.fix': ['Fix the highlighted items to continue.', 'এগিয়ে যেতে চিহ্নিত পণ্যগুলো ঠিক করুন।'],
  'cartp.tooMany': ['One order can hold up to {n} different items. Remove {extra} to continue.', 'একটি অর্ডারে সর্বোচ্চ {n}টি ভিন্ন পণ্য থাকতে পারে। এগোতে {extra}টি সরান।'],
  'cartp.checkout': ['Proceed to checkout', 'চেকআউটে যান'],
  'cartp.signInNote': ['You will be asked to sign in before placing the order.', 'অর্ডার দেওয়ার আগে লগইন করতে হবে।'],
  'cartp.continue': ['Continue shopping', 'আরও কেনাকাটা করুন'],
  'cartp.clear': ['Clear cart', 'কার্ট খালি করুন'],
  'cartp.clearAsk': ['Remove everything from your cart?', 'কার্টের সব পণ্য সরাবেন?'],
  'cartp.pay': ['You can pay with', 'পেমেন্ট করা যাবে'],
});

const PAY_LABEL = { cod: ['Cash on Delivery', 'ক্যাশ অন ডেলিভারি'], bkash: ['bKash', 'বিকাশ'], nagad: ['Nagad', 'নগদ'] };

export default {
  async mount(ctx) {
    loadCss('/css/pages/cart.css');
    setMeta({ title: t('cartp.title'), noindex: true });
    let cat = null;
    const keys = cart.lines().map((l) => l.key);
    if (keys.length) {
      render(ctx.el, html`<div class="container page"><h1 class="page-title">${t('cartp.title')}</h1><div class="skeleton sk-line" style="height:120px"></div></div>`);
      try { cat = await loadCatalog(); cat = await refreshInventory(keys).catch(() => cat); } catch (e) {
        if (ctx.signal.aborted) return;
        console.error(e);
        render(ctx.el, html`<div class="container page">${errorState({ text: t('cartp.loadError') })}</div>`);
        ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
        return;
      }
      if (ctx.signal.aborted) return;
    }

    const lineHtml = (l) => {
      const bad = l.state === 'removed' || l.state === 'out';
      const href = l.product ? productUrl(l.product) : '/shop';
      const img = l.image || (l.product && l.product.image) || '';
      return html`<li class="cl ${bad ? 'is-bad' : ''}" data-key="${l.key}">
        <a class="cl-img" href="${href}" tabindex="-1" aria-hidden="true">${img ? html`<img src="${safeUrl(assetUrl(img))}" alt="" width="96" height="96" loading="lazy" decoding="async">` : icon('image', { size: 28 })}</a>
        <div class="cl-body">
          <a class="cl-name" href="${href}">${l.name}</a>
          ${l.variantLabel ? html`<p class="cl-var muted small">${l.variantLabel}</p>` : ''}
          ${l.state !== 'removed' ? html`<p class="cl-each muted small">${t('cartp.each', { price: money(l.unitPrice) })}${l.regularPrice > l.unitPrice ? html` <s>${money(l.regularPrice)}</s>` : ''}</p>` : ''}
          ${l.state === 'removed' ? html`<p class="cl-note is-bad" role="alert">${icon('alert-circle', { size: 16 })}<span>${t('cartp.gone')}</span></p>` : ''}
          ${l.state === 'out' ? html`<p class="cl-note is-bad" role="alert">${icon('alert-circle', { size: 16 })}<span>${t('cartp.out')}</span></p>` : ''}
          ${l.state === 'limited' ? html`<p class="cl-note is-warn" role="alert">${icon('alert-triangle', { size: 16 })}<span>${t('cartp.limited', { n: num(l.maxQty) })}</span><button type="button" class="btn btn-link btn-sm" data-action="setmax" data-key="${l.key}" data-n="${l.maxQty}">${t('cartp.setMax', { n: num(l.maxQty) })}</button></p>` : ''}
          ${l.priceChanged && l.state === 'ok' ? html`<p class="cl-note is-info" role="status">${icon('info', { size: 16 })}<span>${t('cartp.priceChanged', { from: money(l.priceChanged.from), to: money(l.priceChanged.to) })}</span><button type="button" class="btn btn-link btn-sm" data-action="accept" data-key="${l.key}" data-p="${l.priceChanged.to}">${t('cartp.accept')}</button></p>` : ''}
          <div class="cl-actions">
            ${l.state === 'removed' || l.state === 'out' ? '' : html`<div class="qty qty-sm" role="group" aria-label="${t('cartp.qty', { name: l.name })}">
              <button type="button" data-action="dec" data-key="${l.key}" aria-label="${t('cartp.dec')}" ${l.qty <= 1 ? 'disabled' : ''}>${icon('minus', { size: 16 })}</button>
              <output aria-live="polite">${num(l.qty)}</output>
              <button type="button" data-action="inc" data-key="${l.key}" aria-label="${t('cartp.inc')}" ${l.qty >= l.maxQty ? 'disabled' : ''}>${icon('plus', { size: 16 })}</button>
            </div>`}
            <button type="button" class="btn btn-ghost btn-sm" data-action="remove" data-key="${l.key}" data-name="${l.name}">${icon('trash', { size: 16 })}<span>${t('cartp.remove')}</span></button>
          </div>
        </div>
        <div class="cl-total">${l.state === 'ok' || l.state === 'limited' ? money(l.unitPrice * l.qty) : '—'}</div>
      </li>`;
    };

    const paint = () => {
      const r = resolveCart(cat);
      const distinct = r.lines.length;
      if (!distinct) {
        render(ctx.el, html`<div class="container page"><h1 class="page-title">${t('cartp.title')}</h1>${emptyState({ icon: 'cart', title: t('cartp.empty'), text: t('cartp.emptyText'), action: { href: '/shop', label: t('cartp.shop') } })}</div>`);
        return;
      }
      const tooMany = Math.max(0, distinct - LIMITS.MAX_LINES);
      const blocked = r.issues > 0 || tooMany > 0 || r.count < 1;
      const pays = enabledPayments().map((id) => (PAY_LABEL[id] ? pick(PAY_LABEL[id][0], PAY_LABEL[id][1]) : '')).filter(Boolean);
      render(ctx.el, html`<div class="container page">
        <h1 class="page-title">${t('cartp.title')} <span class="muted cart-count">(${tn('cartp.items', cart.count())})</span></h1>
        <div class="cart">
          <ul class="cl-list">${r.lines.map(lineHtml)}</ul>
          <aside class="cart-sum" aria-labelledby="cs-h">
            <h2 id="cs-h">${t('cartp.summary')}</h2>
            <div class="sum-row"><span>${t('cartp.subtotal')} <span class="muted small">(${tn('cartp.items', r.count)})</span></span><strong>${money(r.subtotal)}</strong></div>
            <p class="muted small">${t('cartp.later')}</p>
            ${tooMany ? html`<p class="cl-note is-warn" role="alert">${icon('alert-triangle', { size: 16 })}<span>${t('cartp.tooMany', { n: num(LIMITS.MAX_LINES), extra: num(tooMany) })}</span></p>`
    : (r.issues ? html`<p class="cl-note is-warn" role="alert">${icon('alert-triangle', { size: 16 })}<span>${t('cartp.fix')}</span></p>` : '')}
            ${blocked ? html`<button type="button" class="btn btn-primary btn-lg btn-block" disabled>${t('cartp.checkout')}</button>`
    : html`<a class="btn btn-primary btn-lg btn-block" href="/checkout">${t('cartp.checkout')}</a>`}
            ${!isSignedIn() && !blocked ? html`<p class="muted small cart-note">${icon('lock', { size: 14 })} ${t('cartp.signInNote')}</p>` : ''}
            ${pays.length ? html`<p class="muted small cart-note">${t('cartp.pay')}: ${pays.join(' · ')}</p>` : ''}
            <div class="cart-links"><a href="/shop">${t('cartp.continue')}</a><button type="button" class="btn btn-link" data-action="clear">${t('cartp.clear')}</button></div>
          </aside>
        </div>
      </div>`);
    };

    paint();
    ctx.cleanup(cart.subscribe(() => paint()));
    ctx.cleanup(bindActions(ctx.el, {
      inc: (b) => { const l = resolveCart(cat).lines.find((x) => x.key === b.dataset.key); if (l) cart.setQty(l.key, Math.min(l.maxQty || l.qty, l.qty + 1)); },
      dec: (b) => { const l = cart.lines().find((x) => x.key === b.dataset.key); if (l) cart.setQty(l.key, Math.max(1, l.qty - 1)); },
      setmax: (b) => { cart.setQty(b.dataset.key, Number(b.dataset.n)); },
      accept: (b) => { cart.acknowledgePrice(b.dataset.key, Number(b.dataset.p)); },
      remove: (b) => { cart.remove(b.dataset.key); toast(t('cartp.removed', { name: b.dataset.name })); announce(t('cartp.removed', { name: b.dataset.name })); },
      clear: async () => {
        if (!(await confirmDialog({ title: t('cartp.clearAsk'), confirmText: t('cartp.clear'), danger: true }))) return;
        try { cart.clear(); } catch (e) { toastError(explainError(e)); }
      },
    }));
  },
};
