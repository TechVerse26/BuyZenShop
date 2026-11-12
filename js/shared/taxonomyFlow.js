/*
 * Categories & brands — pure planners (no I/O), so the admin pages and the rules tests run the exact same code.
 *
 *   validateTaxonomyForm(kind, form, { items, id })                 → { ok, values, errors }          errors: { field: code }
 *   planTaxonomySave({ kind, creating, id, form, items, products, actor, nowMs })
 *                                                                   → { ok, id, values, action, ops, followUp } | { ok:false, error, errors? }
 *   planTaxonomyVisible({ kind, id, visible, items, actor, nowMs }) → { ok, id, action, ops }
 *   planTaxonomyRemove({ kind, id, items, refs, actor, nowMs })     → { ok, id, ops, imagePath }     refs = { products, children, coupons[] }
 *   planCategoryMove({ id, dir: 'up'|'down', items, actor, nowMs }) → { ok, id, action, ops }
 *   taxonomyCounts(kind, items, products)                           → Map id → { products, children }
 *
 * kind: 'category' (categories/<id>: name, slug, parentId, image, imagePath, icon, description, sort, visible) or
 *       'brand'    (brands/<id>:     name, slug, logo, logoPath, description, visible)
 *
 * firestore.rules only checks WHO may write categories / brands (categories.write / brands.write) and never looks at the shape, so this file
 * is the validator:  name 1–80 and unique (a category: among its siblings) · slug a–z 0–9 hyphens, unique, made from the name when left empty ·
 * a category has at most TWO levels (a sub-category cannot have children; a category with children cannot become a sub-category) ·
 * description ≤ 300 · image: https link or a path on this site (nothing else) · visible on/off.
 * The id never changes (products point at it); the slug is what the page link is made of and may change.
 *
 * What a change does to the rest of the catalog:
 *   • every write also bumps meta/catalog, so shops that cached the catalog fetch it again
 *   • a new NAME is copied into products (categoryName / brandName) — `followUp` holds those writes (many; committed in chunks after the
 *     atomic first batch). Saving again repairs anything that did not make it, because stale products are always included.
 *   • a category or brand that products point at, or a category that has sub-categories, or one a coupon is limited to, cannot be deleted
 *   • hiding a category hides its sub-categories in the shop too (the shop drops children of a hidden parent)
 * Every change is audited (category.* / brand.*).
 */
import { TS } from './ops.js';
import { roleCan } from './constants.js';
import { slugify, uniqueSlug } from './slug.js';
import { auditOp, catalogStampOp } from './orderFlow.js';

export const KINDS = Object.freeze({
  category: Object.freeze({ kind: 'category', collection: 'categories', write: 'categories.write', imageField: 'image', pathField: 'imagePath', nameOnProduct: 'categoryName', idOnProduct: 'categoryId' }),
  brand: Object.freeze({ kind: 'brand', collection: 'brands', write: 'brands.write', imageField: 'logo', pathField: 'logoPath', nameOnProduct: 'brandName', idOnProduct: 'brandId' }),
});
export const TAXONOMY_LIMITS = Object.freeze({ nameMax: 80, slugMax: 80, descMax: 300, imageMax: 1000 });
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const IMAGE_URL = /^(https:\/\/[^\s]+|\/(?!\/)[^\s]*)$/;
const IMAGE_PATH = /^site\/(categories|brands)\/[A-Za-z0-9._-]{1,200}$/;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const sameText = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();
const parentOf = (c) => (c && c.parentId) || null;
const isVisible = (c) => !!c && c.visible !== false;

/** the siblings of a category (same parent), or every brand — in the order the shop shows them */
export function siblingsOf(kind, items, parentId = null) {
  const list = kind === 'category' ? items.filter((c) => parentOf(c) === (parentId || null)) : items.slice();
  return list.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name).localeCompare(String(b.name)));
}

export function taxonomyCounts(kind, items, products = []) {
  const cfg = KINDS[kind];
  const out = new Map(items.map((c) => [c.id, { products: 0, children: 0 }]));
  for (const p of products) { const e = out.get(p[cfg.idOnProduct]); if (e) e.products += 1; }
  if (kind === 'category') for (const c of items) { const e = out.get(parentOf(c)); if (e) e.children += 1; }
  return out;
}

export function validateTaxonomyForm(kind, form = {}, { items = [], id = null } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) return { ok: false, errors: { name: 'required' } };
  const errors = {};
  const name = norm(form.name);
  if (!name) errors.name = 'required';
  else if (name.length > TAXONOMY_LIMITS.nameMax) errors.name = 'too_long';

  let parentId = null;
  if (kind === 'category') {
    const p = String(form.parentId ?? '').trim();
    if (p) {
      const parent = items.find((c) => c.id === p);
      if (!parent || p === id) errors.parentId = 'bad_parent';
      else if (parentOf(parent)) errors.parentId = 'too_deep';
      else if (id && items.some((c) => parentOf(c) === id)) errors.parentId = 'has_children';
      else parentId = p;
    }
  }
  if (!errors.name && items.some((c) => c.id !== id && sameText(c.name, name) && (kind === 'brand' || parentOf(c) === parentId))) errors.name = 'name_taken';

  const taken = new Set(items.filter((c) => c.id !== id).map((c) => c.slug));
  let slug = String(form.slug ?? '').trim().toLowerCase();
  if (slug) {
    if (slug.length > TAXONOMY_LIMITS.slugMax || !SLUG_PATTERN.test(slug)) errors.slug = 'bad_slug';
    else if (taken.has(slug)) errors.slug = 'slug_taken';
  } else if (!errors.name) slug = uniqueSlug(slugify(name, { max: TAXONOMY_LIMITS.slugMax }) || kind, taken);

  const description = norm(form.description);
  if (description.length > TAXONOMY_LIMITS.descMax) errors.description = 'too_long';

  const image = String(form.image ?? '').trim();
  let imagePath = String(form.imagePath ?? '').trim();
  if (image && (image.length > TAXONOMY_LIMITS.imageMax || !IMAGE_URL.test(image))) errors.image = 'bad_image';
  if (!image) imagePath = '';
  else if (imagePath && !IMAGE_PATH.test(imagePath)) errors.image = 'bad_image';

  const visible = typeof form.visible === 'boolean' ? form.visible : true;
  if (Object.keys(errors).length) return { ok: false, errors };
  const values = kind === 'category'
    ? { name, slug, parentId, description, image, imagePath, visible }
    : { name, slug, description, logo: image, logoPath: imagePath, visible };
  return { ok: true, errors, values };
}

const brief = (c) => ({ name: c.name, slug: c.slug, parentId: parentOf(c), visible: isVisible(c), sort: Number(c.sort) || 0 });
const FIELDS = {
  category: ['name', 'slug', 'parentId', 'description', 'image', 'imagePath', 'visible'],
  brand: ['name', 'slug', 'description', 'logo', 'logoPath', 'visible'],
};
const stored = (kind, c) => ({
  name: c.name, slug: c.slug, parentId: parentOf(c), description: c.description || '',
  image: c.image || '', imagePath: c.imagePath || '', logo: c.logo || '', logoPath: c.logoPath || '', visible: isVisible(c),
});

function describeChange(kind, before, after) {
  const bits = [];
  if (before.name !== after.name) bits.push(`renamed from "${before.name}"`);
  if (before.slug !== after.slug) bits.push(`link ${before.slug} → ${after.slug}`);
  if (kind === 'category' && parentOf(before) !== after.parentId) bits.push(after.parentId ? `moved under ${after.parentId}` : 'moved to the top level');
  if ((before.description || '') !== after.description) bits.push('description changed');
  const imgField = KINDS[kind].imageField;
  if ((before[imgField] || '') !== after[imgField]) bits.push(after[imgField] ? 'image changed' : 'image removed');
  if (isVisible(before) !== after.visible) bits.push(after.visible ? 'shown in the shop' : 'hidden from the shop');
  return bits.join('; ');
}

export function planTaxonomySave({ kind, creating = false, id = null, form, items = [], products = [], actor, nowMs = Date.now() }) {
  const cfg = KINDS[kind];
  if (!cfg) return fail('not_found');
  if (!actor || !roleCan(actor.role, cfg.write)) return fail('forbidden');
  const current = creating ? null : items.find((c) => c.id === id) || null;
  if (!creating && !current) return fail('not_found');
  const v = validateTaxonomyForm(kind, form, { items, id: creating ? null : id });
  if (!v.ok) return fail('invalid', { errors: v.errors });
  const { values } = v;
  const stamp = catalogStampOp(nowMs);

  if (creating) {
    const cid = uniqueSlug(values.slug, new Set(items.map((c) => c.id)));
    const base = { ...values, createdAt: TS, updatedAt: TS };
    const doc = kind === 'category'
      ? { ...base, icon: '', sort: siblingsOf(kind, items, values.parentId).reduce((m, c) => Math.max(m, Number(c.sort) || 0), 0) + 1 }
      : base;
    return {
      ok: true, id: cid, values, action: `${kind}.create`, followUp: [],
      ops: [
        { op: 'set', path: `${cfg.collection}/${cid}`, data: doc },
        auditOp(actor, { action: `${kind}.create`, entity: kind, entityId: cid, summary: `${kind === 'category' ? 'Category' : 'Brand'} "${values.name}" created`, before: null, after: brief(doc) }),
        stamp,
      ],
    };
  }

  const was = stored(kind, current);
  const changedFields = FIELDS[kind].filter((k) => was[k] !== values[k]);
  // products that still carry another name for this category / brand (a rename, or an earlier rename that did not finish)
  const stale = products.filter((p) => p[cfg.idOnProduct] === id && p[cfg.nameOnProduct] !== values.name);
  if (!changedFields.length && !stale.length) return fail('no_change');

  const ops = [];
  if (changedFields.length) {
    const data = Object.fromEntries(changedFields.map((k) => [k, values[k]]));
    if (kind === 'category' && parentOf(current) !== values.parentId) {
      data.sort = siblingsOf(kind, items.filter((c) => c.id !== id), values.parentId).reduce((m, c) => Math.max(m, Number(c.sort) || 0), 0) + 1;
    }
    ops.push({ op: 'update', path: `${cfg.collection}/${id}`, data: { ...data, updatedAt: TS } });
    const after = { ...current, ...values, ...(data.sort !== undefined ? { sort: data.sort } : {}) };
    ops.push(auditOp(actor, {
      action: `${kind}.update`, entity: kind, entityId: id,
      summary: `${kind === 'category' ? 'Category' : 'Brand'} "${values.name}": ${describeChange(kind, current, values)}`, before: brief(current), after: brief(after),
    }));
  } else {
    ops.push(auditOp(actor, {
      action: `${kind}.update`, entity: kind, entityId: id,
      summary: `${kind === 'category' ? 'Category' : 'Brand'} "${values.name}": name copied to ${stale.length} product${stale.length === 1 ? '' : 's'}`, before: brief(current), after: brief(current),
    }));
  }
  ops.push(stamp);
  const followUp = stale.length
    ? [...stale.map((p) => ({ op: 'update', path: `products/${p.id}`, data: { [cfg.nameOnProduct]: values.name, updatedAt: TS } })), catalogStampOp(nowMs)]
    : [];
  return { ok: true, id, values, action: `${kind}.update`, ops, followUp, renamed: stale.length };
}

export function planTaxonomyVisible({ kind, id, visible, items = [], actor, nowMs = Date.now() }) {
  const cfg = KINDS[kind];
  if (!cfg) return fail('not_found');
  if (!actor || !roleCan(actor.role, cfg.write)) return fail('forbidden');
  const current = items.find((c) => c.id === id) || null;
  if (!current) return fail('not_found');
  const want = visible === true;
  if (isVisible(current) === want) return fail('no_change');
  const action = `${kind}.${want ? 'show' : 'hide'}`;
  return {
    ok: true, id, action,
    ops: [
      { op: 'update', path: `${cfg.collection}/${id}`, data: { visible: want, updatedAt: TS } },
      auditOp(actor, {
        action, entity: kind, entityId: id,
        summary: `${kind === 'category' ? 'Category' : 'Brand'} "${current.name}" ${want ? 'shown in the shop' : 'hidden from the shop'}`, before: brief(current), after: { ...brief(current), visible: want },
      }),
      catalogStampOp(nowMs),
    ],
  };
}

export function planTaxonomyRemove({ kind, id, items = [], refs = {}, actor, nowMs = Date.now() }) {
  const cfg = KINDS[kind];
  if (!cfg) return fail('not_found');
  if (!actor || !roleCan(actor.role, cfg.write)) return fail('forbidden');
  const current = items.find((c) => c.id === id) || null;
  if (!current) return fail('not_found');
  const children = Number(refs.children) || (kind === 'category' ? items.filter((c) => parentOf(c) === id).length : 0);
  if (children > 0) return fail('has_children', { count: children });
  const products = Number(refs.products) || 0;
  if (products > 0) return fail('in_use', { count: products });
  const coupons = Array.isArray(refs.coupons) ? refs.coupons : [];
  if (coupons.length) return fail('coupon_scope', { coupons });
  return {
    ok: true, id, imagePath: current[cfg.pathField] || '',
    ops: [
      { op: 'delete', path: `${cfg.collection}/${id}` },
      auditOp(actor, { action: `${kind}.delete`, entity: kind, entityId: id, summary: `${kind === 'category' ? 'Category' : 'Brand'} "${current.name}" deleted`, before: brief(current), after: null }),
      catalogStampOp(nowMs),
    ],
  };
}

/** swap a category with its neighbour; every sibling is renumbered 1…n so duplicate or missing `sort` values heal on the way */
export function planCategoryMove({ id, dir, items = [], actor, nowMs = Date.now() }) {
  if (!actor || !roleCan(actor.role, KINDS.category.write)) return fail('forbidden');
  const current = items.find((c) => c.id === id) || null;
  if (!current) return fail('not_found');
  const sibs = siblingsOf('category', items, parentOf(current));
  const at = sibs.findIndex((c) => c.id === id);
  const to = dir === 'up' ? at - 1 : dir === 'down' ? at + 1 : at;
  if (to < 0 || to >= sibs.length || to === at) return fail('no_change');
  const order = sibs.slice();
  [order[at], order[to]] = [order[to], order[at]];
  const ops = [];
  order.forEach((c, i) => { if ((Number(c.sort) || 0) !== i + 1) ops.push({ op: 'update', path: `categories/${c.id}`, data: { sort: i + 1, updatedAt: TS } }); });
  const action = 'category.reorder';
  ops.push(auditOp(actor, {
    action, entity: 'category', entityId: id,
    summary: `Category "${current.name}" moved ${dir === 'up' ? 'up' : 'down'} (position ${at + 1} → ${to + 1} of ${sibs.length})`, before: { position: at + 1 }, after: { position: to + 1 },
  }));
  ops.push(catalogStampOp(nowMs));
  return { ok: true, id, action, ops };
}
