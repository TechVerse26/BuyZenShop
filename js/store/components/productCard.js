/*
 * Product card (grid item) + the delegated handlers that make its buttons work.
 *
 *   render(el, html`<div class="product-grid">${products.map((p) => productCard(p))}</div>`);
 *   const off = bindProductCards(el);        // call once per container; returns a disposer
 *
 * The whole card is one link (stretched ::after on the name); the wishlist heart and the quick-add
 * button sit above it. Variable products send people to the product page to pick options.
 */
import { html, bindActions, safeUrl, aria } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, registerBoth } from '../../core/i18n.js';
import { badge, stars, priceHtml, toast, toastError } from '../../core/ui.js';
import { pct } from '../../core/format.js';
import { cart } from '../../data/cart.js';
import { wishlist } from '../../data/wishlist.js';
import { getCatalog } from '../../data/catalog.js';
import { AppError, explainError } from '../../core/errors.js';
import { productUrl, go } from '../lib/links.js';

registerBoth({
  'card.add': ['Add to cart', 'কার্টে যোগ করুন'],
  'card.options': ['Choose options', 'অপশন বাছুন'],
  'card.wish': ['Add to wishlist', 'উইশলিস্টে রাখুন'],
  'card.unwish': ['Remove from wishlist', 'উইশলিস্ট থেকে সরান'],
  'cart.added': ['Added to cart', 'কার্টে যোগ হয়েছে'],
  'cart.view': ['View cart', 'কার্ট দেখুন'],
  'card.noImage': ['No image', 'ছবি নেই'],
});

export function productCard(p, { priority = false } = {}) {
  const href = productUrl(p);
  const ranged = p.type === 'variable' && p.minPrice !== p.maxPrice;
  const saved = wishlist.has(p.id);
  const canQuickAdd = p.inStock && p.type !== 'variable';
  const stockFlag = !p.inStock ? badge(t('common.outOfStock')) : p.stockState === 'low' ? badge(t('common.lowStock'), 'warn') : '';
  return html`<article class="p-card" data-id="${p.id}">
    <a class="p-media ${p.image ? '' : 'is-empty'}" href="${href}" tabindex="-1" aria-hidden="true">${p.image
      ? html`<img src="${safeUrl(p.thumb || p.image)}" alt="" width="400" height="400" loading="${priority ? 'eager' : 'lazy'}" decoding="async">`
      : icon('image')}</a>
    <div class="p-flags">${p.onSale ? badge(`-${pct(p.discountPct)}`, 'sale') : ''}${stockFlag}</div>
    <button type="button" class="p-wish" data-action="wish" data-id="${p.id}" aria-pressed="${aria(saved)}" aria-label="${saved ? t('card.unwish') : t('card.wish')}">${icon('heart')}</button>
    <div class="p-body">
      ${p.categoryName ? html`<div class="p-cat">${p.categoryName}</div>` : ''}
      <a class="p-name clamp-2" href="${href}">${p.name}</a>
      ${p.ratingCount > 0 ? stars(p.ratingAvg, { count: p.ratingCount, size: 14 }) : ''}
      <div class="p-foot">
        ${priceHtml({ now: p.minPrice, old: p.onSale && !ranged ? p.regularMin : null, from: ranged })}
        ${canQuickAdd
          ? html`<button type="button" class="btn btn-secondary btn-icon p-add" data-action="quick-add" data-id="${p.id}" aria-label="${t('card.add')}: ${p.name}">${icon('plus')}</button>`
          : (p.inStock ? html`<a class="btn btn-secondary btn-sm p-add" href="${href}">${t('card.options')}</a>` : '')}
      </div>
    </div>
  </article>`;
}

export function productGrid(products, { dense = false, priority = 4 } = {}) {
  return html`<div class="product-grid ${dense ? 'dense' : ''}">${products.map((p, i) => productCard(p, { priority: i < priority }))}</div>`;
}

/** Toggle every heart for `id` currently on the page. */
function syncHearts(id, on) {
  document.querySelectorAll(`.p-wish[data-id="${CSS.escape(id)}"]`).forEach((b) => {
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? t('card.unwish') : t('card.wish'));
  });
}

export function bindProductCards(root) {
  return bindActions(root, {
    wish: async (el) => {
      const id = el.dataset.id;
      const on = await wishlist.toggle(id);
      syncHearts(id, on);
      toast(on ? t('card.wish') + ' ✓' : t('card.unwish'), { timeout: 1800 });
    },
    'quick-add': (el) => {
      const p = getCatalog()?.byId.get(el.dataset.id);
      const unit = p?.units[0];
      if (!p || !unit || !unit.inv) return;
      try {
        cart.add(unit.key, 1, { price: p.minPrice });
        toast(t('cart.added'), { action: { label: t('cart.view'), onClick: () => go('/cart') } });
      } catch (e) {
        toastError(e instanceof AppError ? e.message : explainError(e));
      }
    },
  });
}
