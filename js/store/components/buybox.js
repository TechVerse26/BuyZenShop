/*
 * Buy box of the product page: price, option pickers, stock line, quantity, add to cart / buy now, wishlist, share,
 * delivery facts and the sticky mobile bar. Every number comes from the product view (catalog + inventory); the cart
 * re-reads inventory at checkout and firestore.rules re-derive price and stock when the order is written.
 *
 *   const box = mountBuyBox(el, product, { onImage(url), onVariant(variantId|null), initialVariant, eta: {min,max}|null, navigate(path) });
 *   box.selectedVariant()  → variant id or ''      box.dispose()
 */
import { html, render, bindActions, copyText, aria } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { toast, toastError, announce, priceHtml } from '../../core/ui.js';
import { explainError } from '../../core/errors.js';
import { num, pct } from '../../core/format.js';
import { cart } from '../../data/cart.js';
import { wishlist } from '../../data/wishlist.js';
import { settings } from '../../data/settings.js';
import { effectivePrice, isOnSale, discountPercent, availableQty, maxOrderQty, stockState } from '../../shared/pricing.js';
import { findUnit, optionValueAvailable, assetUrl } from '../../shared/productModel.js';
import { productUrl, absoluteUrl } from '../lib/links.js';

registerBoth({
  'pdp.qty': ['Quantity', 'পরিমাণ'],
  'pdp.dec': ['Decrease quantity', 'পরিমাণ কমান'],
  'pdp.inc': ['Increase quantity', 'পরিমাণ বাড়ান'],
  'pdp.add': ['Add to cart', 'কার্টে যোগ করুন'],
  'pdp.buy': ['Buy now', 'এখনই কিনুন'],
  'pdp.soldOut': ['Out of stock', 'স্টক শেষ'],
  'pdp.inStock': ['In stock', 'স্টকে আছে'],
  'pdp.low': ['Only {n} left', 'মাত্র {n}টি বাকি'],
  'pdp.backorder': ['Backorder — ships when restocked', 'ব্যাকঅর্ডার — স্টক এলে পাঠানো হবে'],
  'pdp.unavailable': ['Currently unavailable', 'এই মুহূর্তে পাওয়া যাচ্ছে না'],
  'pdp.noCombo': ['This combination is not available.', 'এই কম্বিনেশনটি পাওয়া যাচ্ছে না।'],
  'pdp.choose': ['Please choose: {names}', 'বেছে নিন: {names}'],
  'pdp.max': ['Maximum {n} per order', 'প্রতি অর্ডারে সর্বোচ্চ {n}টি'],
  'pdp.onlyN': ['Only {n} available', 'মাত্র {n}টি আছে'],
  'pdp.added': ['Added to cart', 'কার্টে যোগ হয়েছে'],
  'pdp.viewCart': ['View cart', 'কার্ট দেখুন'],
  'pdp.save': ['Save', 'পছন্দের তালিকায়'],
  'pdp.saved': ['Saved', 'সংরক্ষিত'],
  'pdp.wishAdded': ['Saved to your wishlist', 'পছন্দের তালিকায় রাখা হয়েছে'],
  'pdp.wishRemoved': ['Removed from your wishlist', 'পছন্দের তালিকা থেকে সরানো হয়েছে'],
  'pdp.share': ['Share', 'শেয়ার'],
  'pdp.copied': ['Link copied', 'লিংক কপি হয়েছে'],
  'pdp.fact.cod': ['Cash on Delivery available', 'ক্যাশ অন ডেলিভারি আছে'],
  'pdp.fact.returns': ['{n}-day return window', '{n} দিনের মধ্যে রিটার্ন'],
  'pdp.fact.eta': ['Delivery in {min}–{max} days', '{min}–{max} দিনে ডেলিভারি'],
  'pdp.fact.eta1': ['Delivery in {n} days', '{n} দিনে ডেলিভারি'],
});

const STOCK_ICON = { in_stock: 'check-circle', low: 'alert-triangle', backorder: 'clock', out: 'x-circle', unavailable: 'x-circle' };

export function mountBuyBox(el, product, { onImage, onVariant, initialVariant = '', eta = null, navigate } = {}) {
  const variable = product.type === 'variable' && product.options.length > 0;
  const st = { chosen: {}, qty: 1, error: '', saved: wishlist.has(product.id), barOn: false };

  const first = initialVariant ? product.units.find((u) => u.variantId === initialVariant) : null;
  if (first) st.chosen = { ...first.optionValues };
  else for (const o of product.options) if (o.values.length === 1) st.chosen[o.name] = o.values[0];

  const missing = () => product.options.filter((o) => !st.chosen[o.name]).map((o) => o.name);
  const unit = () => (!variable ? product.units[0] || null : (missing().length ? null : findUnit(product, st.chosen)));

  const view = () => {
    const u = unit();
    const inv = u ? u.inv : null;
    const now = Date.now();
    return {
      u, inv,
      state: u ? stockState(inv) : null,
      price: u && inv && inv.active !== false ? { now: effectivePrice(inv, now), old: isOnSale(inv, now) ? inv.price : null, off: discountPercent(inv, now) } : null,
      max: u ? maxOrderQty(inv) : 0,
    };
  };

  render(el, html`<div data-box></div><div class="pdp-bar" data-bar></div>`);
  const box = el.querySelector('[data-box]');
  const bar = el.querySelector('[data-bar]');

  /* ───────── markup ───────── */
  const priceBlock = (v) => (v.price
    ? html`${priceHtml({ now: v.price.now, old: v.price.old, size: 'price-lg' })}${v.price.old ? html`<span class="badge badge-sale">-${pct(v.price.off)}</span>` : ''}`
    : priceHtml({ now: product.minPrice, from: product.maxPrice > product.minPrice, size: 'price-lg' }));

  const optionsHtml = () => product.options.map((o) => {
    const val = st.chosen[o.name];
    return html`<fieldset class="opt" data-opt="${o.name}">
      <legend class="opt-label">${o.name}${val ? html`<span class="opt-val">${val}</span>` : ''}</legend>
      <div class="opt-values">${o.values.map((x) => {
        const ok = optionValueAvailable(product, o.name, x, st.chosen);
        return html`<button type="button" class="opt-btn ${val === x ? 'is-on' : ''} ${ok ? '' : 'is-out'}" data-action="pick" data-opt="${o.name}" data-val="${x}" data-fkey="o:${o.name}:${x}" aria-pressed="${aria(val === x)}" ${ok ? '' : html`aria-label="${x}, ${t('pdp.soldOut')}"`}>${x}</button>`;
      })}</div>
    </fieldset>`;
  });

  const stockLine = (v) => {
    if (!v.state) return '';
    const text = v.state === 'low' ? t('pdp.low', { n: num(availableQty(v.inv)) })
      : v.state === 'in_stock' ? t('pdp.inStock') : v.state === 'backorder' ? t('pdp.backorder')
        : v.state === 'out' ? t('pdp.soldOut') : t('pdp.unavailable');
    return html`<p class="pdp-stock is-${v.state}">${icon(STOCK_ICON[v.state], { size: 18 })}<span>${text}</span></p>`;
  };

  const limitHint = (v) => {
    if (!v.u || v.max < 1 || st.qty < v.max) return '';
    const stockLimited = Number.isFinite(availableQty(v.inv)) && availableQty(v.inv) <= v.max;
    return html`<p class="pdp-limit" role="status">${stockLimited ? t('pdp.onlyN', { n: num(v.max) }) : t('pdp.max', { n: num(v.max) })}</p>`;
  };

  const factsHtml = () => {
    const s = settings();
    const facts = [];
    if (s.payments && s.payments.cod && s.payments.cod.enabled) facts.push(['wallet', t('pdp.fact.cod')]);
    if (eta) facts.push(['truck', eta.min === eta.max ? t('pdp.fact.eta1', { n: num(eta.min) }) : t('pdp.fact.eta', { min: num(eta.min), max: num(eta.max) })]);
    const d = Number(s.checkout && s.checkout.returnWindowDays) || 0;
    if (d > 0) facts.push(['undo', t('pdp.fact.returns', { n: num(d) })]);
    return facts.length ? html`<ul class="pdp-facts">${facts.map(([ic, text]) => html`<li>${icon(ic, { size: 18 })}<span>${text}</span></li>`)}</ul>` : '';
  };

  const boxHtml = (v) => {
    const soldOut = !!v.u && v.max < 1;
    return html`
      <div class="pdp-price" aria-live="polite">${priceBlock(v)}</div>
      ${variable ? html`<div class="pdp-opts">${optionsHtml()}${st.error ? html`<p class="field-error" role="alert">${st.error}</p>` : ''}</div>` : ''}
      ${stockLine(v)}
      <div class="pdp-buy">
        <div class="qty" role="group" aria-label="${t('pdp.qty')}">
          <button type="button" data-action="dec" data-fkey="dec" aria-label="${t('pdp.dec')}" ${st.qty <= 1 ? 'disabled' : ''}>${icon('minus', { size: 18 })}</button>
          <output aria-live="polite">${num(st.qty)}</output>
          <button type="button" data-action="inc" data-fkey="inc" aria-label="${t('pdp.inc')}" ${st.qty >= Math.max(1, v.max) && v.u ? 'disabled' : ''}>${icon('plus', { size: 18 })}</button>
        </div>
        ${soldOut
    ? html`<button type="button" class="btn btn-primary btn-lg pdp-add" disabled>${t('pdp.soldOut')}</button>`
    : html`<button type="button" class="btn btn-primary btn-lg pdp-add" data-action="add" data-fkey="add">${icon('cart', { size: 20 })}<span>${t('pdp.add')}</span></button>
          <button type="button" class="btn btn-secondary btn-lg pdp-now" data-action="buy">${t('pdp.buy')}</button>`}
      </div>
      ${limitHint(v)}
      <div class="pdp-aux">
        <button type="button" class="btn btn-ghost" data-action="wish" data-fkey="wish" aria-pressed="${aria(st.saved)}">${icon('heart', { size: 18, fill: st.saved })}<span>${st.saved ? t('pdp.saved') : t('pdp.save')}</span></button>
        <button type="button" class="btn btn-ghost" data-action="share">${icon('share', { size: 18 })}<span>${t('pdp.share')}</span></button>
      </div>
      ${factsHtml()}`;
  };

  const barHtml = (v) => html`<div class="container pdp-bar-in">
    <div class="pdp-bar-price">${v.price ? priceHtml({ now: v.price.now, old: v.price.old }) : priceHtml({ now: product.minPrice, from: product.maxPrice > product.minPrice })}</div>
    ${v.u && v.max < 1
    ? html`<button type="button" class="btn btn-primary" disabled>${t('pdp.soldOut')}</button>`
    : html`<button type="button" class="btn btn-primary" data-action="add">${icon('cart', { size: 18 })}<span>${t('pdp.add')}</span></button>`}
  </div>`;

  /* ───────── painting ───────── */
  let io = null;
  const watchCta = () => {
    if (!('IntersectionObserver' in window)) return;
    if (io) io.disconnect();
    const target = el.querySelector('.pdp-buy');
    if (!target) return;
    io = new IntersectionObserver(([e]) => { st.barOn = !e.isIntersecting; bar.classList.toggle('is-on', st.barOn); }, { threshold: 0 });
    io.observe(target);
  };
  const paint = () => {
    const active = document.activeElement;
    const keep = active && el.contains(active) ? active.dataset.fkey : '';
    const v = view();
    st.qty = Math.max(1, Math.min(st.qty, Math.max(1, v.max)));
    render(box, boxHtml(v));
    render(bar, barHtml(v));
    bar.classList.toggle('is-on', st.barOn);
    if (keep) { const n = [...el.querySelectorAll('[data-fkey]')].find((x) => x.dataset.fkey === keep); if (n) n.focus({ preventScroll: true }); }
    watchCta();
  };

  /* ───────── behaviour ───────── */
  const add = ({ go = false } = {}) => {
    const v = view();
    if (variable && !v.u) {
      const miss = missing();
      st.error = miss.length ? t('pdp.choose', { names: miss.join(', ') }) : t('pdp.noCombo');
      paint();
      announce(st.error);
      const group = [...el.querySelectorAll('[data-opt]')].find((g) => g.tagName === 'FIELDSET' && (!miss.length || g.dataset.opt === miss[0]));
      const btn = group && group.querySelector('.opt-btn');
      if (btn) btn.focus();
      return;
    }
    if (!v.u || v.max < 1) { toastError(t('pdp.soldOut')); return; }
    try { cart.add(v.u.key, st.qty, { price: v.price ? v.price.now : undefined }); } catch (e) { toastError(explainError(e)); return; }
    if (go) { if (navigate) navigate('/checkout'); return; }
    toast(t('pdp.added'), { action: { label: t('pdp.viewCart'), onClick: () => { if (navigate) navigate('/cart'); } } });
  };

  const off = bindActions(el, {
    pick: (b) => {
      st.chosen = { ...st.chosen, [b.dataset.opt]: b.dataset.val };
      st.error = ''; st.qty = 1;
      const u = unit();
      if (u && u.image && onImage) onImage(assetUrl(u.image));
      if (onVariant) onVariant(u ? u.variantId : null);
      paint();
    },
    dec: () => { st.qty = Math.max(1, st.qty - 1); paint(); },
    inc: () => { st.qty = Math.min(Math.max(1, view().max), st.qty + 1); paint(); },
    add: () => add(),
    buy: () => add({ go: true }),
    wish: () => { st.saved = wishlist.toggle(product.id); toast(st.saved ? t('pdp.wishAdded') : t('pdp.wishRemoved')); paint(); },
    share: async () => {
      const url = absoluteUrl(productUrl(product));
      if (navigator.share) { try { await navigator.share({ title: product.name, url }); } catch { /* cancelled */ } return; }
      if (await copyText(url)) toast(t('pdp.copied'));
    },
  });
  const offWish = wishlist.subscribe(() => { const s = wishlist.has(product.id); if (s !== st.saved) { st.saved = s; paint(); } });

  paint();
  return {
    selectedVariant: () => { const u = unit(); return u && u.variantId ? u.variantId : ''; },
    dispose() { off(); offWish(); if (io) io.disconnect(); },
  };
}
