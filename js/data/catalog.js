/*
 * Storefront catalog: categories, brands, published products and their inventory, loaded in bulk
 * (the catalog is small) so search, filtering and sorting are instant and run in the browser.
 *
 * Caching
 *   - meta/catalog holds a version stamp bumped by every staff catalog write. Content (categories,
 *     brands, products) is cached in localStorage and reused while the stamp is unchanged.
 *   - Inventory (price / stock / reserved) changes with every order, so it is cached for only 2 minutes
 *     and ALWAYS re-read from Firestore at cart / checkout time (refreshInventory).
 *
 *   const cat = await loadCatalog();            // { products: ProductView[], categories, brands, inv, … }
 *   queryProducts(cat, { q, categoryId, brandId, min, max, onSale, inStock, sort })
 *   productBySlug(cat, slug), productById(cat, id), relatedProducts(cat, p, 8)
 *
 * ProductView is the shape returned by shared/productModel.normalizeProduct().
 */
import { getDocData, listDocs, serializeDoc } from './db.js';
import { normalizeProduct, buildCategoryTree, descendantIds } from '../shared/productModel.js';
import { buildIndex, search as runSearch, suggest as runSuggest } from '../shared/search.js';
import { local } from '../core/storage.js';
import { reportError } from '../core/errors.js';
import { LIMITS, STORAGE_KEYS } from '../shared/constants.js';

const KEY_INV = 'sv.inv.v2';
const INV_TTL = 2 * 60 * 1000;
const MEM_TTL = 60 * 1000;

let mem = null;
let inflight = null;

function build(content, invByKey, lowDefault = 5) {
  const categories = (content.categories || []).filter((c) => c.visible !== false)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name)));
  const brands = (content.brands || []).filter((b) => b.visible !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const catById = Object.fromEntries(categories.map((c) => [c.id, c]));
  const brandById = Object.fromEntries(brands.map((b) => [b.id, b]));
  const products = (content.products || [])
    .filter((p) => (p.status ?? 'published') === 'published')
    .map((p) => normalizeProduct(p.id, p, invByKey, { categories: catById, brands: brandById, lowDefault }));
  const byId = new Map(products.map((p) => [p.id, p]));
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const countByCat = {};
  for (const p of products) if (p.categoryId) countByCat[p.categoryId] = (countByCat[p.categoryId] || 0) + 1;
  return {
    loadedAt: Date.now(), version: content.version ?? 0, stale: !!content.stale,
    categories, brands, categoryTree: buildCategoryTree(categories), catById, brandById,
    products, byId, bySlug, inv: invByKey, countByCat,
    _content: content, _index: null,
  };
}

async function fetchContent() {
  const [cats, brs, prods] = await Promise.all([
    listDocs('categories', { where: [['visible', '==', true]] }),
    listDocs('brands', { where: [['visible', '==', true]] }),
    listDocs('products', { where: [['status', '==', 'published']] }),
  ]);
  return { categories: cats.docs.map(serializeDoc), brands: brs.docs.map(serializeDoc), products: prods.docs.map(serializeDoc) };
}

async function fetchInventory() {
  const { docs } = await listDocs('inventory');
  const items = {};
  for (const d of docs) { const { id, ...rest } = serializeDoc(d); items[id] = rest; }
  return items;
}

export async function loadCatalog({ force = false } = {}) {
  if (!force && mem && Date.now() - mem.loadedAt < MEM_TTL) return mem;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const cachedContent = !force ? local.get(STORAGE_KEYS.catalog) : null;
      const cachedInv = !force ? local.get(KEY_INV) : null;

      let version = null;                                   // null = could not check the stamp (offline)
      try { const meta = await getDocData('meta/catalog'); version = meta ? Number(meta.version) || 0 : 0; } catch { version = null; }

      let content; let stale = false;
      const contentUsable = cachedContent && cachedContent.products && Date.now() - cachedContent.savedAt < LIMITS.CATALOG_CACHE_TTL_MS;
      if (contentUsable && (version === null || cachedContent.version === version)) {
        content = cachedContent; stale = version === null;
      } else {
        try {
          content = { ...(await fetchContent()), version: version ?? 0, savedAt: Date.now() };
          local.set(STORAGE_KEYS.catalog, content);
        } catch (e) {
          if (cachedContent && cachedContent.products) { content = cachedContent; stale = true; reportError(e, 'catalog.content (using cache)'); } else throw e;
        }
      }

      let inv;
      if (cachedInv && Date.now() - cachedInv.savedAt < INV_TTL) inv = cachedInv.items;
      else {
        try { inv = await fetchInventory(); local.set(KEY_INV, { savedAt: Date.now(), items: inv }); } catch (e) {
          if (cachedInv) { inv = cachedInv.items; stale = true; reportError(e, 'catalog.inventory (using cache)'); } else throw e;
        }
      }
      mem = build({ ...content, stale }, inv);
      return mem;
    } finally { inflight = null; }
  })();
  return inflight;
}

export const getCatalog = () => mem;
export function invalidateCatalog() { mem = null; local.remove(STORAGE_KEYS.catalog); local.remove(KEY_INV); }

/**
 * Re-read inventory documents straight from Firestore (authoritative price / stock) for the given
 * keys and rebuild the view. Used by the cart, product page and checkout. Returns the new catalog.
 */
export async function refreshInventory(keys) {
  const base = mem || await loadCatalog();
  const list = [...new Set(keys)].slice(0, 60);
  const docs = await Promise.all(list.map((k) => getDocData(`inventory/${k}`).catch(() => null)));
  const inv = { ...base.inv };
  list.forEach((k, i) => { const d = docs[i]; if (d) { const { id, ...rest } = serializeDoc(d); inv[id] = rest; } else delete inv[k]; });
  local.set(KEY_INV, { savedAt: Date.now(), items: inv });
  mem = build(base._content, inv);
  return mem;
}

/* ───────────────────────── lookups ───────────────────────── */

export const productById = (cat, id) => cat?.byId.get(id) || null;
export const productBySlug = (cat, slug) => cat?.bySlug.get(slug) || null;
export const categoryBySlug = (cat, slug) => cat?.categories.find((c) => c.slug === slug) || null;
export const brandBySlug = (cat, slug) => cat?.brands.find((b) => b.slug === slug) || null;
export function categoryPath(cat, categoryId) {
  const out = []; let cur = cat?.catById[categoryId]; let guard = 0;
  while (cur && guard++ < 6) { out.unshift(cur); cur = cur.parentId ? cat.catById[cur.parentId] : null; }
  return out;
}

/* ───────────────────────── query / sort ───────────────────────── */

export const SORTS = ['relevance', 'newest', 'popular', 'rating', 'price_asc', 'price_desc', 'name'];

/**
 * Filter + sort the published products.
 * @param {object} o { q, categoryId (includes sub-categories), brandId, min, max, onSale, inStock, featured, tag, sort }
 * @returns {ProductView[]}
 */
export function queryProducts(cat, o = {}) {
  if (!cat) return [];
  const { q = '', categoryId = '', brandId = '', min = null, max = null, onSale = false, inStock = false, featured = false, tag = '' } = o;
  let list = cat.products;
  let order = null;
  if (q && q.trim()) {
    if (!cat._index) cat._index = buildIndex(cat.products);
    const hits = runSearch(cat._index, q, { limit: 500 });
    order = new Map(hits.map((h, i) => [h.id, i]));
    list = hits.map((h) => cat.byId.get(h.id)).filter(Boolean);
  }
  if (categoryId) { const ids = new Set(descendantIds(cat.categories, categoryId)); list = list.filter((p) => ids.has(p.categoryId)); }
  if (brandId) list = list.filter((p) => p.brandId === brandId);
  if (min !== null && min !== '' && Number.isFinite(Number(min))) list = list.filter((p) => p.maxPrice >= Number(min));
  if (max !== null && max !== '' && Number.isFinite(Number(max))) list = list.filter((p) => p.minPrice <= Number(max));
  if (onSale) list = list.filter((p) => p.onSale);
  if (inStock) list = list.filter((p) => p.inStock);
  if (featured) list = list.filter((p) => p.featured);
  if (tag) list = list.filter((p) => p.tags.includes(tag));

  let sort = o.sort || (order ? 'relevance' : 'newest');
  if (sort === 'relevance' && !order) sort = 'newest';
  const cmp = {
    relevance: (a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9),
    newest: (a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0),
    popular: (a, b) => b.soldCount - a.soldCount || b.ratingCount - a.ratingCount,
    rating: (a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount,
    price_asc: (a, b) => a.minPrice - b.minPrice,
    price_desc: (a, b) => b.minPrice - a.minPrice,
    name: (a, b) => String(a.name).localeCompare(String(b.name)),
  }[sort] || (() => 0);
  return [...list].sort(cmp);
}

export function suggestProducts(cat, q, limit = 6) { return cat ? runSuggest(cat.products, q, limit) : []; }

export function priceBounds(products) {
  if (!products.length) return { min: 0, max: 0 };
  return { min: Math.min(...products.map((p) => p.minPrice)), max: Math.max(...products.map((p) => p.maxPrice)) };
}

export function relatedProducts(cat, product, n = 8) {
  if (!cat || !product) return [];
  const same = cat.products.filter((p) => p.id !== product.id && p.categoryId && p.categoryId === product.categoryId);
  const brand = cat.products.filter((p) => p.id !== product.id && p.brandId && p.brandId === product.brandId && p.categoryId !== product.categoryId);
  const rest = cat.products.filter((p) => p.id !== product.id && !same.includes(p) && !brand.includes(p));
  return [...same, ...brand, ...rest].slice(0, n);
}
export const newestProducts = (cat, n = 8) => queryProducts(cat, { sort: 'newest' }).slice(0, n);
export const bestSellers = (cat, n = 8) => queryProducts(cat, { sort: 'popular' }).filter((p) => p.soldCount > 0).slice(0, n);
export const saleProducts = (cat, n = 8) => queryProducts(cat, { onSale: true, sort: 'popular' }).slice(0, n);
export const featuredProducts = (cat, n = 8) => queryProducts(cat, { featured: true }).slice(0, n);

/* ───────────────────────── recently viewed ───────────────────────── */

export function recentlyViewed() { return local.get(STORAGE_KEYS.recent, []); }
export function pushRecentlyViewed(id) {
  const list = [id, ...recentlyViewed().filter((x) => x !== id)].slice(0, 12);
  local.set(STORAGE_KEYS.recent, list);
}
