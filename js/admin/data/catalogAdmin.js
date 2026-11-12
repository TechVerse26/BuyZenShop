/*
 * Staff-side catalog reads: every product (drafts and archived too), all inventory documents, categories and brands.
 * The catalog of a small shop is a few hundred documents, so it is loaded in bulk and cached for a minute; pages that
 * write call invalidateAdminCatalog() (or loadAdminCatalog({ force: true })) afterwards.
 *
 *   const cat = await loadAdminCatalog();
 *   cat.products      raw product docs [{ id, ...data }]
 *   cat.inv           { [inventoryKey]: { id, ...data } }
 *   cat.categories / cat.brands   [{ id, ...data }]  and  cat.catById / cat.brandById
 *   viewProducts(cat) → ProductView[]   (shared/productModel.normalizeProduct: units, stock state, prices …)
 *   unitRows(cat)     → one row per sellable unit (simple product or variant), for the inventory page
 */
import { listDocs } from '../../data/db.js';
import { normalizeProduct } from '../../shared/productModel.js';
import { stockState, availableQty } from '../../shared/pricing.js';

const TTL = 60 * 1000;
let cache = null;

const byId = (list) => Object.fromEntries(list.map((d) => [d.id, d]));

export async function loadAdminCatalog({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL) return cache;
  const [p, i, c, b] = await Promise.all([
    listDocs('products', { limit: 1000 }),
    listDocs('inventory', { limit: 4000 }),
    listDocs('categories', { limit: 500 }),
    listDocs('brands', { limit: 500 }),
  ]);
  const inv = byId(i.docs);
  cache = {
    at: Date.now(),
    products: p.docs,
    productById: byId(p.docs),
    inv,
    categories: c.docs.slice().sort((x, y) => (Number(x.sort) || 0) - (Number(y.sort) || 0) || String(x.name).localeCompare(String(y.name))),
    brands: b.docs.slice().sort((x, y) => String(x.name).localeCompare(String(y.name))),
    catById: byId(c.docs),
    brandById: byId(b.docs),
    truncated: p.size >= 1000 || i.size >= 4000,
  };
  return cache;
}

export const invalidateAdminCatalog = () => { cache = null; };

export function viewProducts(cat) {
  const ctx = { categories: cat.catById, brands: cat.brandById };
  return cat.products.map((d) => normalizeProduct(d.id, d, cat.inv, ctx));
}

/** One row per sellable unit: { product, unit, inv, key, state, available, tracked }. Archived products are included. */
export function unitRows(cat, views = viewProducts(cat)) {
  const rows = [];
  for (const product of views) {
    for (const unit of product.units) {
      const inv = unit.inv;
      rows.push({
        product, unit, inv, key: unit.key,
        tracked: !!(inv && inv.track === true),
        state: stockState(inv),
        available: inv ? availableQty(inv) : 0,
      });
    }
  }
  return rows;
}

/** Counts used by the dashboard: tracked units on published products that are low / out. */
export function stockCounts(cat) {
  const rows = unitRows(cat).filter((r) => r.product.status === 'published' && r.tracked && r.inv && r.inv.active !== false);
  return { low: rows.filter((r) => r.state === 'low').length, out: rows.filter((r) => r.state === 'out').length, tracked: rows.length };
}
