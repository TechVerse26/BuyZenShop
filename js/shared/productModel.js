/*
 * Uniform view model for products.
 *
 * Firestore holds a product in up to three places:
 *   products/{id}                 public product document (content, options, variants, images)
 *   inventory/{id | id__variant}  authoritative price / stock for every sellable unit (public read)
 *   productPrivate/{id}           staff-only (cost price …)
 * The storefront joins the first two; legacy documents (pre-upgrade: image, oldPrice, category string,
 * stock "In Stock"/"Out of Stock") are adapted here so they keep displaying until migrated.
 */

import { effectivePrice, isOnSale, stockState, availableQty, maxOrderQty, discountPercent, toMillis } from './pricing.js';
import { lineKey } from './id.js';
import { slugify } from './slug.js';

export const isLegacyProduct = (d) => !d || d.status === undefined || d.type === undefined;

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Legacy products store relative image paths ("gallery/x.webp") that only worked on the single-page
 * old site. The storefront now has nested URLs (/product/slug), so make them root-relative.
 */
export function assetUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(s)) return s;     // scheme:, //host, /root-relative
  return '/' + s.replace(/^\.\//, '');
}

/** Legacy → new-style raw shape (no I/O, no id generation beyond the document id). */
export function upgradeLegacyProduct(id, d) {
  const cur = Number(d.price) || 0;
  const old = Number(d.oldPrice) || 0;
  const hasOld = old > cur;
  const img = d.imageUrl || d.image || '';
  return {
    name: d.name || 'Product',
    slug: slugify(d.name || '') || `p-${String(id).slice(0, 8).toLowerCase()}`,
    status: 'published',
    type: 'simple',
    categoryId: '',
    categoryName: d.category || 'Others',
    brandId: '', brandName: '',
    price: hasOld ? old : cur,
    salePrice: hasOld ? cur : null,
    images: img ? [{ url: assetUrl(img), alt: d.name || '' }] : [],
    icon: d.icon || '',
    shortDescription: '',
    description: d.desc || '',
    soldCount: Number(d.soldCount) || 0,
    ratingAvg: Number(d.rating) || 0,
    ratingCount: Number(d.ratingCount) || 0,
    legacyStock: d.stock || 'In Stock',
    createdAt: d.timestamp || null,
    _legacy: true,
  };
}

/**
 * @param {string} id
 * @param {object} data   products/{id}
 * @param {Object<string,object>} invByKey   inventory docs by key
 * @param {{categories?:Object<string,object>, brands?:Object<string,object>, nowMs?:number, lowDefault?:number}} [ctx]
 */
export function normalizeProduct(id, data, invByKey = {}, ctx = {}) {
  const nowMs = ctx.nowMs ?? Date.now();
  const raw = isLegacyProduct(data) ? upgradeLegacyProduct(id, data || {}) : data;
  const legacy = !!raw._legacy;
  const cat = ctx.categories?.[raw.categoryId];
  const brand = ctx.brands?.[raw.brandId];

  const options = arr(raw.options);
  const variantDefs = arr(raw.variants);
  const units = [];
  if (raw.type === 'variable' && variantDefs.length) {
    for (const v of variantDefs) {
      if (v.active === false) continue;
      const key = lineKey(id, v.id);
      const inv = invByKey[key] || null;
      units.push({
        key, variantId: v.id, sku: v.sku || inv?.sku || '', optionValues: v.optionValues || {},
        label: Object.values(v.optionValues || {}).join(' / '), image: v.image || '', inv,
      });
    }
  } else {
    const inv = invByKey[id] || (legacy ? legacyInventory(id, raw) : null);
    units.push({ key: id, variantId: null, sku: raw.sku || inv?.sku || '', optionValues: {}, label: '', image: '', inv });
  }

  const priced = units.filter((u) => u.inv && u.inv.active !== false);
  const prices = priced.map((u) => effectivePrice(u.inv, nowMs));
  const regulars = priced.map((u) => u.inv.price);
  const minPrice = prices.length ? Math.min(...prices) : (raw.salePrice ?? raw.price ?? 0);
  const maxPrice = prices.length ? Math.max(...prices) : minPrice;
  const regularMin = regulars.length ? Math.min(...regulars) : (raw.price ?? 0);
  const onSale = priced.some((u) => isOnSale(u.inv, nowMs));
  const best = priced.reduce((m, u) => Math.max(m, discountPercent(u.inv, nowMs)), 0);

  // product-level stock state: best state across units
  const rank = { in_stock: 0, low: 1, backorder: 2, out: 3, unavailable: 4 };
  let state = 'unavailable';
  for (const u of units) {
    const st = stockState(u.inv, ctx.lowDefault ?? 5);
    if (rank[st] < rank[state]) state = st;
  }
  const availableTotal = units.reduce((s, u) => s + (u.inv ? availableQty(u.inv) : 0), 0);

  const images = arr(raw.images).filter((i) => i && i.url).map((i) => ({ ...i, url: assetUrl(i.url) }));
  return {
    id,
    slug: raw.slug || id,
    name: raw.name || 'Product',
    status: raw.status || 'published',
    type: raw.type || 'simple',
    isLegacy: legacy,
    categoryId: raw.categoryId || '',
    categoryName: cat?.name || raw.categoryName || '',
    categorySlug: cat?.slug || slugify(raw.categoryName || ''),
    brandId: raw.brandId || '',
    brandName: brand?.name || raw.brandName || '',
    images,
    image: images[0]?.url || '',
    thumb: images[0]?.thumb ? assetUrl(images[0].thumb) : (images[0]?.url || ''),
    icon: raw.icon || '',
    shortDescription: raw.shortDescription || '',
    description: raw.description || '',
    highlights: arr(raw.highlights),
    specs: arr(raw.specs),
    tags: arr(raw.tags),
    options,
    units,
    sku: units[0]?.sku || '',
    minPrice, maxPrice, regularMin, onSale, discountPct: best,
    stockState: state,
    inStock: state === 'in_stock' || state === 'low' || state === 'backorder',
    availableTotal,
    ratingAvg: Number(raw.ratingAvg) || 0,
    ratingCount: Number(raw.ratingCount) || 0,
    soldCount: Number(raw.soldCount) || 0,
    featured: raw.featured === true,
    createdAtMs: toMillis(raw.createdAt),
    seoTitle: raw.seoTitle || '',
    seoDescription: raw.seoDescription || '',
    raw,
  };
}

/** Inventory view for a legacy product that has no inventory document yet (read-only, display only). */
function legacyInventory(id, raw) {
  const out = /out of stock/i.test(raw.legacyStock || '');
  return {
    productId: id, variantId: null, categoryId: '', sku: '', price: raw.price, salePrice: raw.salePrice ?? null, saleStart: null, saleEnd: null,
    stock: 0, reserved: 0, track: out, allowBackorder: false, maxPerOrder: 10, active: true, _legacy: true,
  };
}

/** Pick the sellable unit (variant) matching a set of chosen option values, or null. */
export function findUnit(product, chosen) {
  if (product.type !== 'variable') return product.units[0] || null;
  return product.units.find((u) => Object.entries(chosen || {}).every(([k, v]) => u.optionValues[k] === v)
    && Object.keys(u.optionValues).length === Object.keys(chosen || {}).length) || null;
}

/** For one option value, is there at least one purchasable unit given the other selections? */
export function optionValueAvailable(product, optionName, value, chosen) {
  const want = { ...chosen, [optionName]: value };
  return product.units.some((u) => Object.entries(want).every(([k, v]) => u.optionValues[k] === v) && u.inv && u.inv.active !== false
    && availableQty(u.inv) > 0);
}

export { maxOrderQty };

/* ───────────────────────── categories ───────────────────────── */

export function buildCategoryTree(categories) {
  const byId = Object.fromEntries(categories.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const c of Object.values(byId)) {
    if (c.parentId && byId[c.parentId]) byId[c.parentId].children.push(c);
    else roots.push(c);
  }
  const sort = (list) => { list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name))); list.forEach((c) => sort(c.children)); };
  sort(roots);
  return roots;
}

/** Ids of a category and all its descendants (for "show everything under Men"). */
export function descendantIds(categories, rootId) {
  const kids = {};
  for (const c of categories) (kids[c.parentId || ''] ||= []).push(c.id);
  const out = [];
  const walk = (id) => { out.push(id); (kids[id] || []).forEach(walk); };
  walk(rootId);
  return out;
}
