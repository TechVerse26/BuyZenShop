/*
 * Small helpers shared by the catalog pages (products, inventory, dashboard tiles).
 *
 *   stockBadge('low')                      → badge in the right tone, translated
 *   productStock(view)                     → { tracked, available, state }   for a ProductView from shared/productModel.normalizeProduct
 *   productPriceHtml(view)                 → "৳1,400" / "৳1,400 – ৳1,600" with the regular price struck through while on sale
 *   PRODUCT_CSV_HEADERS + productCsvRow(view)
 */
import { html } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { badge } from '../../core/ui.js';
import { money } from '../../core/format.js';

registerBoth({
  'stk.in_stock': ['In stock', 'স্টকে আছে'],
  'stk.low': ['Low stock', 'স্টক কম'],
  'stk.out': ['Out of stock', 'স্টক শেষ'],
  'stk.backorder': ['Backorder', 'ব্যাকঅর্ডার'],
  'stk.unavailable': ['Unavailable', 'অনুপলব্ধ'],
  'stk.untracked': ['Not tracked', 'স্টক ট্র্যাক হয় না'],
});

const TONE = { in_stock: 'ok', low: 'warn', out: 'bad', backorder: 'info', unavailable: 'neutral', untracked: 'neutral' };
export const stockBadge = (state) => badge(t(`stk.${state}`), TONE[state] || 'neutral');

/** `available` is the physical count (stock − reserved) of the tracked units; untracked and backorder units have no finite number. */
export function productStock(view) {
  const tracked = view.units.filter((u) => u.inv && u.inv.active !== false && u.inv.track === true);
  const available = tracked.reduce((s, u) => s + Math.max(0, (u.inv.stock || 0) - (u.inv.reserved || 0)), 0);
  return { tracked: tracked.length > 0, available, state: view.stockState };
}

export function productPriceHtml(view) {
  const range = view.maxPrice > view.minPrice ? `${money(view.minPrice)} – ${money(view.maxPrice)}` : money(view.minPrice);
  return html`<span class="nowrap strong">${range}</span>${view.onSale && view.regularMin > view.minPrice ? html`<span class="cell-sub"><s>${money(view.regularMin)}</s></span>` : ''}`;
}

export const PRODUCT_CSV_HEADERS = ['ID', 'Name', 'Slug', 'Status', 'Type', 'Category', 'Brand', 'SKU', 'Price', 'Lowest selling price', 'Stock available', 'Tracked', 'Variants'];
export function productCsvRow(v) {
  const s = productStock(v);
  return [v.id, v.name, v.slug, v.status, v.type, v.categoryName, v.brandName, v.units.map((u) => u.sku).filter(Boolean).join(' / '), v.regularMin, v.minPrice, s.tracked ? s.available : '', s.tracked ? 'yes' : 'no', v.type === 'variable' ? v.units.length : ''];
}
