/*
 * Staff-side product planners (pure: no I/O, the same code runs in the browser and in the rules tests).
 *
 *   cleanProductForm(raw)                  → normalised form (trimmed text, integer money, bounded lists)
 *   validateProductForm(form)              → { ok, errors: { field: code }, variantErrors: { index: { field: code } } }
 *   planProductSave({ mode, id, form, existing, unique, actor, nowMs, names })
 *        → { ok, pre, core, ops, id, slug } | { ok:false, error, errors?, variantErrors? }
 *        pre  = inventory documents, SKU index, stock movements: idempotent, committed in chunks of ≤ 18 BEFORE the core
 *        core = the product document, slugIndex, productPrivate, catalog stamp and audit entry: ONE atomic batch (≤ 8 ops)
 *   planProductStatus({ products, status, actor, nowMs })      bulk publish / unpublish / archive → { ok, chunks, skipped }
 *   planProductDelete({ id, existing, actor, nowMs })          refuses while stock is reserved by open orders (archive instead)
 *
 * Rules these mirror (firestore.rules validProduct): name 1–200, slug pattern ≤ 120, status draft|published|archived, type simple|variable,
 * integer price 0–1e8, salePrice null or below price, ≤ 90 keys. Existing inventory documents are never given a new `stock` here:
 * stock of an existing unit changes only through the inventory page (which writes a movement), so a product edit cannot overwrite
 * units that customers reserved in the meantime.
 */
import { TS, clean } from './ops.js';
import { APP, LIMITS, PATTERNS, roleCan } from './constants.js';
import { slugify } from './slug.js';
import { lineKey } from './id.js';
import { isLegacyProduct } from './productModel.js';
import { auditOp, catalogStampOp, movementOp } from './orderFlow.js';

export const PRODUCT_LIMITS = Object.freeze({
  name: 200, slug: 120, shortDescription: 300, description: 20000, highlights: 10, highlightLen: 120, specs: 20, specLabel: 40, specValue: 120,
  tags: 15, tagLen: 30, optionName: 30, optionValues: 12, optionValue: 40, seoTitle: 70, seoDescription: 160, alt: 140, supplier: 120, notes: 1000,
});
export const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const VARIANT_ID_RE = /^[A-Za-z0-9]{1,16}$/;
export const skuKey = (s) => String(s || '').trim().toUpperCase();

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const para = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const money = (v) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const ms = (v) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const uniq = (list) => [...new Set(list)];
const dateOrNull = (v) => (v ? new Date(v) : null);

/** Turns whatever the editor collected into the shape that is validated and written. */
export function cleanProductForm(raw = {}) {
  const type = raw.type === 'variable' ? 'variable' : 'simple';
  const name = text(raw.name, PRODUCT_LIMITS.name);
  const slug = slugify(String(raw.slug || '').trim() || name, { max: PRODUCT_LIMITS.slug });
  const options = type === 'variable'
    ? (Array.isArray(raw.options) ? raw.options : []).map((o) => ({
      name: text(o && o.name, PRODUCT_LIMITS.optionName),
      values: uniq((Array.isArray(o && o.values) ? o.values : []).map((v) => text(v, PRODUCT_LIMITS.optionValue)).filter(Boolean)),
    })).filter((o) => o.name || o.values.length)
    : [];
  const variants = type === 'variable'
    ? (Array.isArray(raw.variants) ? raw.variants : []).map((v) => ({
      id: String((v && v.id) || '').trim(),
      optionValues: Object.fromEntries(Object.entries((v && v.optionValues) || {}).map(([k, x]) => [text(k, PRODUCT_LIMITS.optionName), text(x, PRODUCT_LIMITS.optionValue)])),
      sku: String((v && v.sku) || '').trim(),
      price: money(v && v.price),
      salePrice: money(v && v.salePrice),
      stock: money(v && v.stock) ?? 0,
      active: !(v && v.active === false),
      image: String((v && v.image) || '').slice(0, 600),
    }))
    : [];
  return {
    name, slug,
    status: ['draft', 'published', 'archived'].includes(raw.status) ? raw.status : 'draft',
    type,
    categoryId: String(raw.categoryId || '').trim(),
    brandId: String(raw.brandId || '').trim(),
    sku: type === 'simple' ? String(raw.sku || '').trim() : '',
    price: money(raw.price),
    salePrice: money(raw.salePrice),
    saleStart: ms(raw.saleStart),
    saleEnd: ms(raw.saleEnd),
    shortDescription: text(raw.shortDescription, PRODUCT_LIMITS.shortDescription),
    description: para(raw.description, PRODUCT_LIMITS.description),
    highlights: (Array.isArray(raw.highlights) ? raw.highlights : []).map((h) => text(h, PRODUCT_LIMITS.highlightLen)).filter(Boolean).slice(0, PRODUCT_LIMITS.highlights),
    specs: (Array.isArray(raw.specs) ? raw.specs : []).map((s) => ({ label: text(s && s.label, PRODUCT_LIMITS.specLabel), value: text(s && s.value, PRODUCT_LIMITS.specValue) })).filter((s) => s.label && s.value).slice(0, PRODUCT_LIMITS.specs),
    tags: uniq((Array.isArray(raw.tags) ? raw.tags : []).map((x) => text(x, PRODUCT_LIMITS.tagLen).toLowerCase()).filter(Boolean)).slice(0, PRODUCT_LIMITS.tags),
    images: (Array.isArray(raw.images) ? raw.images : []).filter((i) => i && i.url).slice(0, LIMITS.MAX_IMAGES).map((i) => clean({
      id: i.id ? String(i.id).slice(0, 40) : undefined, url: String(i.url).slice(0, 800), thumb: i.thumb ? String(i.thumb).slice(0, 800) : undefined,
      alt: text(i.alt, PRODUCT_LIMITS.alt), w: Number.isFinite(i.w) ? i.w : undefined, h: Number.isFinite(i.h) ? i.h : undefined,
      path: i.path ? String(i.path).slice(0, 300) : undefined, thumbPath: i.thumbPath ? String(i.thumbPath).slice(0, 300) : undefined,
    })),
    icon: text(raw.icon, 40),
    featured: raw.featured === true,
    seoTitle: text(raw.seoTitle, PRODUCT_LIMITS.seoTitle),
    seoDescription: text(raw.seoDescription, PRODUCT_LIMITS.seoDescription),
    track: raw.track !== false,
    allowBackorder: raw.allowBackorder === true,
    maxPerOrder: money(raw.maxPerOrder) ?? 10,
    lowStockThreshold: money(raw.lowStockThreshold),
    stock: money(raw.stock) ?? 0,
    options, variants,
    cost: raw.cost === undefined ? undefined : {
      costPrice: money(raw.cost && raw.cost.costPrice),
      supplier: text(raw.cost && raw.cost.supplier, PRODUCT_LIMITS.supplier),
      notes: para(raw.cost && raw.cost.notes, PRODUCT_LIMITS.notes),
    },
  };
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/** Error codes (the editor maps each to a translated message): required, too_long, bad_slug, bad_price, bad_sale, sale_dates, bad_sku, dup_sku … */
export function validateProductForm(f) {
  const errors = {};
  const variantErrors = {};
  const e = (k, code) => { if (!errors[k]) errors[k] = code; };
  if (!f.name) e('name', 'required');
  if (!f.slug) e('slug', 'required'); else if (!PATTERNS.slug.test(f.slug) || f.slug.length > PRODUCT_LIMITS.slug) e('slug', 'bad_slug');
  if (f.categoryId && !/^[A-Za-z0-9_-]{1,80}$/.test(f.categoryId)) e('categoryId', 'bad_value');
  if (f.saleStart && f.saleEnd && f.saleStart >= f.saleEnd) e('saleEnd', 'sale_dates');
  if (!isInt(f.maxPerOrder, 1, LIMITS.MAX_QTY_PER_LINE)) e('maxPerOrder', 'bad_max_per_order');
  if (f.lowStockThreshold !== null && !isInt(f.lowStockThreshold, 0, 9999)) e('lowStockThreshold', 'bad_number');

  if (f.type === 'simple') {
    if (!isInt(f.price, 1, LIMITS.MAX_PRICE)) e('price', 'bad_price');
    if (f.salePrice !== null && !(isInt(f.salePrice, 1, LIMITS.MAX_PRICE) && isInt(f.price, 1, LIMITS.MAX_PRICE) && f.salePrice < f.price)) e('salePrice', 'bad_sale');
    if (f.sku && !SKU_RE.test(f.sku)) e('sku', 'bad_sku');
    if (!isInt(f.stock, 0, 1000000)) e('stock', 'bad_number');
  } else {
    if (!f.options.length) e('options', 'no_options');
    if (f.options.length > LIMITS.MAX_OPTIONS) e('options', 'too_many');
    const names = f.options.map((o) => o.name.toLowerCase());
    if (f.options.some((o) => !o.name || !o.values.length)) e('options', 'option_incomplete');
    else if (new Set(names).size !== names.length) e('options', 'option_dup');
    if (f.options.some((o) => o.values.length > PRODUCT_LIMITS.optionValues)) e('options', 'too_many_values');
    if (f.variants.length > LIMITS.MAX_VARIANTS) e('variants', 'too_many');
    const active = f.variants.filter((v) => v.active);
    if (!active.length) e('variants', 'no_variants');
    const seenIds = new Set();
    const seenCombos = new Set();
    const seenSkus = new Set();
    f.variants.forEach((v, i) => {
      const ve = {};
      if (!VARIANT_ID_RE.test(v.id) || seenIds.has(v.id)) ve.id = 'bad_value';
      seenIds.add(v.id);
      if (v.sku) {
        if (!SKU_RE.test(v.sku)) ve.sku = 'bad_sku';
        else if (seenSkus.has(skuKey(v.sku))) ve.sku = 'dup_sku';
        seenSkus.add(skuKey(v.sku));
      }
      if (v.active) {
        if (!isInt(v.price, 1, LIMITS.MAX_PRICE)) ve.price = 'bad_price';
        if (v.salePrice !== null && !(isInt(v.salePrice, 1, LIMITS.MAX_PRICE) && isInt(v.price, 1, LIMITS.MAX_PRICE) && v.salePrice < v.price)) ve.salePrice = 'bad_sale';
        const complete = f.options.length > 0 && f.options.every((o) => o.values.includes(v.optionValues[o.name]));
        if (!complete) ve.optionValues = 'variant_incomplete';
        else {
          const combo = f.options.map((o) => v.optionValues[o.name]).join('\u0001');
          if (seenCombos.has(combo)) ve.optionValues = 'dup_combo';
          seenCombos.add(combo);
        }
      }
      if (!isInt(v.stock, 0, 1000000)) ve.stock = 'bad_number';
      if (Object.keys(ve).length) variantErrors[i] = ve;
    });
  }
  if (f.status === 'published' && !f.categoryId) { /* allowed: shown as "Uncategorised" in the store */ }
  if (f.cost && f.cost.costPrice !== null && !(Number.isFinite(f.cost.costPrice) && f.cost.costPrice >= 0 && f.cost.costPrice <= LIMITS.MAX_PRICE)) e('costPrice', 'bad_price');
  return { ok: !Object.keys(errors).length && !Object.keys(variantErrors).length, errors, variantErrors };
}

/** The sellable units of a cleaned form: one for a simple product, one per variant otherwise. */
export function unitsOf(id, f) {
  if (f.type === 'simple') return [{ key: lineKey(id, null), variantId: null, sku: f.sku, price: f.price, salePrice: f.salePrice, stock: f.stock, active: true }];
  return f.variants.map((v) => ({ key: lineKey(id, v.id), variantId: v.id, sku: v.sku, price: v.price, salePrice: v.salePrice, stock: v.stock, active: v.active }));
}

const briefOf = (d) => (d ? { status: d.status ?? null, price: d.price ?? null, slug: d.slug ?? null, name: d.name ?? null } : null);

/**
 * @param {{mode:'create'|'update', id:string, form:object, existing?:{product:object, inv:Object<string,object>}|null,
 *          unique?:{slugOwner?:string|null, skuOwners?:Object<string,{productId:string}>}, actor:{uid:string,email?:string,role:string}, nowMs:number,
 *          names?:{category?:string, brand?:string}}} p
 */
export function planProductSave({ mode, id, form, existing = null, unique = {}, actor, nowMs, names = {} }) {
  if (!roleCan(actor.role, 'products.write')) return fail('forbidden');
  if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || id.includes('__')) return fail('bad_id');
  if (mode === 'update' && !existing) return fail('not_found');
  if (mode === 'update' && isLegacyProduct(existing.product)) return fail('legacy');
  const f = cleanProductForm(form);
  const v = validateProductForm(f);

  // uniqueness is checked together with the basic rules, so the person sees every problem in one go; a field keeps its first (more basic) error
  const errors = { ...v.errors };
  const variantErrors = Object.fromEntries(Object.entries(v.variantErrors).map(([i, e]) => [i, { ...e }]));
  if (unique.slugOwner && unique.slugOwner !== id && !errors.slug) errors.slug = 'slug_taken';
  const owners = unique.skuOwners || {};
  const takenBy = (sku) => { const o = sku ? owners[skuKey(sku)] : null; return !!o && o.productId !== id; };
  if (f.type === 'simple') { if (takenBy(f.sku) && !errors.sku) errors.sku = 'sku_taken'; }
  else f.variants.forEach((x, i) => { if (takenBy(x.sku) && !(variantErrors[i] && variantErrors[i].sku)) (variantErrors[i] ||= {}).sku = 'sku_taken'; });
  if (Object.keys(errors).length || Object.keys(variantErrors).length) return fail('invalid', { errors, variantErrors });

  const old = existing ? existing.product : null;
  const oldInv = existing ? existing.inv || {} : {};
  const canMove = roleCan(actor.role, 'inventory.adjust');

  // existing variants the form dropped stay in the document as inactive (their ids appear on old orders and inventory documents)
  if (f.type === 'variable' && old && Array.isArray(old.variants)) {
    for (const ov of old.variants) {
      if (!f.variants.some((x) => x.id === ov.id)) f.variants.push({ id: ov.id, optionValues: ov.optionValues || {}, sku: ov.sku || '', price: oldInv[lineKey(id, ov.id)]?.price ?? 1, salePrice: null, stock: 0, active: false, image: ov.image || '' });
    }
    if (f.variants.length > LIMITS.MAX_VARIANTS) return fail('invalid', { errors: { variants: 'too_many' }, variantErrors: {} });
  }

  const units = unitsOf(id, f);
  const pre = [];
  const core = [];

  /* ---- inventory (one document per sellable unit) ---- */
  for (const u of units) {
    const prev = oldInv[u.key];
    const common = {
      categoryId: f.categoryId, sku: u.sku, price: u.price ?? prev?.price ?? 1, salePrice: u.active ? u.salePrice : null,
      saleStart: dateOrNull(f.saleStart), saleEnd: dateOrNull(f.saleEnd),
      track: f.track, allowBackorder: f.allowBackorder, maxPerOrder: f.maxPerOrder, active: u.active, lowStockThreshold: f.lowStockThreshold, updatedAt: TS,
    };
    if (prev) {
      pre.push({ op: 'update', path: `inventory/${u.key}`, data: common });
    } else {
      pre.push({ op: 'set', path: `inventory/${u.key}`, data: { productId: id, variantId: u.variantId, ...common, stock: f.track ? u.stock : 0, reserved: 0 } });
      if (canMove && f.track && u.stock > 0) pre.push(movementOp(actor, { key: u.key, inv: { productId: id, variantId: u.variantId, sku: u.sku, stock: 0 }, type: 'initial', delta: u.stock, note: 'Stock entered when the product was created' }));
    }
  }

  /* ---- SKU index ---- */
  const wantedSkus = new Map(units.filter((u) => u.sku).map((u) => [skuKey(u.sku), { productId: id, variantId: u.variantId }]));
  const oldSkus = new Set();
  if (old) {
    if (old.sku) oldSkus.add(skuKey(old.sku));
    for (const ov of old.variants || []) if (ov.sku) oldSkus.add(skuKey(ov.sku));
  }
  for (const [k, data] of wantedSkus) pre.push({ op: 'set', path: `skuIndex/${k}`, data });
  for (const k of oldSkus) if (!wantedSkus.has(k)) pre.push({ op: 'delete', path: `skuIndex/${k}` });

  /* ---- product document ---- */
  const activeVariants = f.variants.filter((x) => x.active);
  const basePrice = f.type === 'simple' ? f.price : Math.min(...activeVariants.map((x) => x.price));
  const baseSale = f.type === 'simple' ? f.salePrice : null;
  const doc = {
    name: f.name, slug: f.slug, status: f.status, type: f.type,
    categoryId: f.categoryId, categoryName: names.category || '', brandId: f.brandId, brandName: names.brand || '',
    price: basePrice, salePrice: baseSale, saleStart: dateOrNull(f.saleStart), saleEnd: dateOrNull(f.saleEnd), sku: f.sku,
    images: f.images, icon: f.icon, shortDescription: f.shortDescription, description: f.description,
    highlights: f.highlights, specs: f.specs, tags: f.tags,
    options: f.options,
    variants: f.variants.map((x) => clean({ id: x.id, optionValues: x.optionValues, sku: x.sku, image: x.image, active: x.active })),
    featured: f.featured, seoTitle: f.seoTitle, seoDescription: f.seoDescription,
    updatedAt: TS, schemaVersion: APP.schemaVersion,
  };
  if (mode === 'create') core.push({ op: 'set', path: `products/${id}`, data: { ...doc, soldCount: 0, ratingAvg: 0, ratingCount: 0, ratingSum: 0, createdAt: TS } });
  else core.push({ op: 'update', path: `products/${id}`, data: doc });

  /* ---- slug index ---- */
  core.push({ op: 'set', path: `slugIndex/${f.slug}`, data: { productId: id } });
  if (old && old.slug && old.slug !== f.slug) core.push({ op: 'delete', path: `slugIndex/${old.slug}` });

  /* ---- private data (cost) ---- */
  if (f.cost !== undefined && roleCan(actor.role, 'costs.read')) {
    core.push({ op: 'set', path: `productPrivate/${id}`, data: { costPrice: f.cost.costPrice, supplier: f.cost.supplier, notes: f.cost.notes, updatedAt: TS } });
  }

  core.push(catalogStampOp(nowMs));
  core.push(auditOp(actor, {
    action: mode === 'create' ? 'product.create' : 'product.update', entity: 'product', entityId: id,
    summary: `Product "${f.name}" ${mode === 'create' ? 'created' : 'updated'} (${f.status})`, before: briefOf(old), after: briefOf({ ...doc }),
  }));
  return { ok: true, id, slug: f.slug, pre, core, ops: [...pre, ...core], units: units.length };
}

/** Bulk status change: each chunk is its own atomic batch with its own catalog stamp and audit entry. Old-format products are skipped (rules need `type`). */
export function planProductStatus({ products, status, actor, nowMs }) {
  if (!roleCan(actor.role, 'products.write')) return fail('forbidden');
  if (!['draft', 'published', 'archived'].includes(status)) return fail('bad_status');
  const skipped = [];
  const todo = [];
  for (const p of products) {
    if (isLegacyProduct(p.data)) skipped.push({ id: p.id, reason: 'legacy' });
    else if (p.data.status === status) skipped.push({ id: p.id, reason: 'same' });
    else todo.push(p);
  }
  const per = LIMITS.ADMIN_BATCH_OPS - 2;
  const chunks = [];
  for (let i = 0; i < todo.length; i += per) {
    const part = todo.slice(i, i + per);
    chunks.push([
      ...part.map((p) => ({ op: 'update', path: `products/${p.id}`, data: { status, updatedAt: TS } })),
      catalogStampOp(nowMs),
      auditOp(actor, { action: 'product.status', entity: 'product', entityId: part.map((p) => p.id).slice(0, 5).join(','), summary: `${part.length} product(s) set to ${status}`, before: null, after: { status, count: part.length } }),
    ]);
  }
  return { ok: true, chunks, skipped, changed: todo.length };
}

/** Deleting removes the product, its inventory documents and index entries. Refused while open orders hold reserved stock. */
export function planProductDelete({ id, existing, actor, nowMs }) {
  if (!roleCan(actor.role, 'products.delete')) return fail('forbidden');
  if (!existing || !existing.product) return fail('not_found');
  const inv = existing.inv || {};
  if (Object.values(inv).some((i) => (Number(i.reserved) || 0) > 0)) return fail('has_reservations');
  const p = existing.product;
  const pre = [];
  for (const key of Object.keys(inv)) pre.push({ op: 'delete', path: `inventory/${key}` });
  const skus = new Set();
  if (p.sku) skus.add(skuKey(p.sku));
  for (const v of p.variants || []) if (v.sku) skus.add(skuKey(v.sku));
  for (const k of skus) pre.push({ op: 'delete', path: `skuIndex/${k}` });
  const core = [{ op: 'delete', path: `products/${id}` }];
  if (p.slug) core.push({ op: 'delete', path: `slugIndex/${p.slug}` });
  if (roleCan(actor.role, 'products.write')) core.push({ op: 'delete', path: `productPrivate/${id}` });
  core.push(catalogStampOp(nowMs));
  core.push(auditOp(actor, { action: 'product.delete', entity: 'product', entityId: id, summary: `Product "${p.name || id}" deleted`, before: briefOf(p), after: null }));
  return { ok: true, pre, core, ops: [...pre, ...core] };
}
