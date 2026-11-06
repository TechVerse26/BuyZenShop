/*
 * Product planners (js/shared/productFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * create (simple / variable / 40 variants), update (live stock is never overwritten), slug + SKU index upkeep,
 * uniqueness answers, validation, bulk status, delete — and the negative: every role without the permission is refused,
 * both by the planner and (for forged batches) by the rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planProductSave, planProductStatus, planProductDelete, cleanProductForm, validateProductForm } from '../../js/shared/productFlow.js';
import { chunkOps } from '../../js/shared/ops.js';
import { normalizeProduct } from '../../js/shared/productModel.js';
import { baseDb, commitBoth, failedOps, NOW } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });

/** pre in chunks of ≤ 18, then the core as one atomic batch — exactly what js/admin/data/products.js does */
function apply(db, uid, plan, label) {
  assert.equal(plan.ok, true, `${label}: ${plan.error} ${JSON.stringify(plan.errors || {})} ${JSON.stringify(plan.variantErrors || {})}`);
  let cur = db;
  for (const chunk of chunkOps(plan.pre, 18)) {
    const r = commitBoth(cur, { uid }, chunk);
    assert.equal(r.strict.allowed, true, `${label} pre strict: ${failedOps(r.strict).join(' | ')}`);
    assert.equal(r.tolerant.allowed, true, `${label} pre tolerant: ${failedOps(r.tolerant).join(' | ')}`);
    cur = r.strict.dbAfter;
  }
  assert.ok(plan.core.length <= 8, `${label}: the core batch has ${plan.core.length} ops`);
  const r = commitBoth(cur, { uid }, plan.core);
  assert.equal(r.strict.allowed, true, `${label} core strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} core tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}
const refusedBatch = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine accepted it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine accepted it`);
};

const simple = (over = {}) => ({
  name: 'Canvas Tote Bag', slug: '', status: 'published', type: 'simple', categoryId: 'c1', brandId: '', sku: 'TOTE-1',
  price: 900, salePrice: 800, saleStart: null, saleEnd: null, shortDescription: 'Sturdy everyday tote', description: 'Heavy canvas.\n\n- 12 oz', highlights: ['Heavy canvas', ''],
  specs: [{ label: 'Material', value: 'Cotton' }, { label: '', value: 'x' }], tags: ['Bag', 'bag', ' Tote '], images: [], featured: false, seoTitle: '', seoDescription: '',
  track: true, allowBackorder: false, maxPerOrder: 5, lowStockThreshold: 3, stock: 12, ...over,
});
const variable = (over = {}) => ({
  ...simple({ sku: '', price: null, salePrice: null, stock: 0 }), name: 'Running Shorts', type: 'variable',
  options: [{ name: 'Size', values: ['S', 'M', 'L'] }, { name: 'Color', values: ['Red', 'Blue'] }],
  variants: ['S', 'M', 'L'].flatMap((s, i) => ['Red', 'Blue'].map((c, j) => ({ id: `v${i}${j}`, optionValues: { Size: s, Color: c }, sku: `RS-${s}-${c}`.toUpperCase(), price: 1500 + i * 100, salePrice: j === 1 ? 1400 + i * 100 : null, stock: 4 + i, active: true }))),
  ...over,
});

test('simple product: created by a product manager, readable by the storefront model', () => {
  const db = baseDb();
  const plan = planProductSave({ mode: 'create', id: 'ptote', form: simple(), actor: actor('pm'), nowMs: NOW, names: { category: 'Clothing' } });
  assert.equal(plan.slug, 'canvas-tote-bag', 'the slug comes from the name');
  assert.equal(plan.pre.some((o) => o.path.startsWith('inventoryMovements/')), false, 'a product manager has no inventory.adjust, so no movement is written (it would be denied)');
  const after = apply(db, 'pm', plan, 'create simple');
  const p = after.get('products/ptote');
  assert.deepEqual([p.name, p.type, p.status, p.price, p.salePrice, p.categoryName, p.schemaVersion], ['Canvas Tote Bag', 'simple', 'published', 900, 800, 'Clothing', 2]);
  assert.deepEqual(p.highlights, ['Heavy canvas'], 'blank highlight rows are dropped');
  assert.deepEqual(p.specs, [{ label: 'Material', value: 'Cotton' }], 'half-filled spec rows are dropped');
  assert.deepEqual(p.tags, ['bag', 'tote'], 'tags are lower-cased and de-duplicated');
  assert.deepEqual([p.soldCount, p.ratingCount], [0, 0], 'a new product starts with no sales and no ratings');
  const inv = after.get('inventory/ptote');
  assert.deepEqual([inv.stock, inv.reserved, inv.price, inv.salePrice, inv.categoryId, inv.track, inv.maxPerOrder, inv.lowStockThreshold], [12, 0, 900, 800, 'c1', true, 5, 3]);
  assert.deepEqual(after.get('skuIndex/TOTE-1'), { productId: 'ptote', variantId: null });
  assert.deepEqual(after.get('slugIndex/canvas-tote-bag'), { productId: 'ptote' });
  assert.ok(after.get('meta/catalog'), 'catalog stamp written');
  const audit = [...after.keys()].filter((k) => k.startsWith('auditLogs/')).map((k) => after.get(k));
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].actorUid, audit[0].actorRole, audit[0].entityId], ['product.create', 'pm', 'product_manager', 'ptote']);
  const view = normalizeProduct('ptote', p, { ptote: inv });
  assert.deepEqual([view.units.length, view.minPrice, view.stockState], [1, 800, 'in_stock']);
});

test('initial stock is logged as a movement when the actor may adjust inventory', () => {
  const db = baseDb();
  const plan = planProductSave({ mode: 'create', id: 'ptote', form: simple(), actor: actor('sadm'), nowMs: NOW });
  const mv = plan.pre.filter((o) => o.path.startsWith('inventoryMovements/'));
  assert.equal(mv.length, 1);
  assert.deepEqual([mv[0].data.type, mv[0].data.delta, mv[0].data.stockAfter], ['initial', 12, 12]);
  const after = apply(db, 'sadm', plan, 'create with movement');
  assert.equal([...after.keys()].filter((k) => k.startsWith('inventoryMovements/')).length, 1);
});

test('an untracked product gets no stock number and no movement', () => {
  const plan = planProductSave({ mode: 'create', id: 'pu', form: simple({ track: false, stock: 40, sku: '' }), actor: actor('sadm'), nowMs: NOW });
  assert.equal(plan.pre.some((o) => o.path.startsWith('inventoryMovements/')), false);
  const inv = plan.pre.find((o) => o.path === 'inventory/pu').data;
  assert.deepEqual([inv.track, inv.stock], [false, 0]);
  assert.equal(plan.pre.some((o) => o.path.startsWith('skuIndex/')), false, 'no SKU → no index entry');
  apply(baseDb(), 'sadm', plan, 'untracked');
});

test('variable product: one inventory document per variant, sale price per variant, product price = cheapest active variant', () => {
  const db = baseDb();
  const plan = planProductSave({ mode: 'create', id: 'pshorts', form: variable(), actor: actor('sadm'), nowMs: NOW });
  const after = apply(db, 'sadm', plan, 'create variable');
  const keys = [...after.keys()].filter((k) => k.startsWith('inventory/pshorts__'));
  assert.equal(keys.length, 6);
  assert.equal(after.get('products/pshorts').price, 1500);
  assert.equal(after.get('products/pshorts').salePrice, null);
  assert.deepEqual([after.get('inventory/pshorts__v01').price, after.get('inventory/pshorts__v01').salePrice, after.get('inventory/pshorts__v01').stock], [1500, 1400, 4]);
  assert.equal([...after.keys()].filter((k) => k.startsWith('skuIndex/RS-')).length, 6);
  const invBy = Object.fromEntries(keys.map((k) => [k.slice('inventory/'.length), after.get(k)]));
  const view = normalizeProduct('pshorts', after.get('products/pshorts'), invBy);
  assert.equal(view.units.length, 6);
  assert.equal(view.minPrice, 1400);
});

test('the maximum of 40 variants needs several chunks, each accepted; the core stays small', () => {
  const sizes = Array.from({ length: 10 }, (_, i) => `S${i}`);
  const colors = ['A', 'B', 'C', 'D'];
  const variants = sizes.flatMap((s, i) => colors.map((c, j) => ({ id: `x${i}${j}`, optionValues: { Size: s, Color: c }, sku: `BIG-${s}-${c}`, price: 1000, salePrice: null, stock: 1, active: true })));
  const form = variable({ name: 'Big matrix', options: [{ name: 'Size', values: sizes }, { name: 'Color', values: colors }], variants });
  const plan = planProductSave({ mode: 'create', id: 'pbig', form, actor: actor('sadm'), nowMs: NOW });
  assert.ok(plan.pre.length > 18, `expected a multi-chunk job, got ${plan.pre.length} pre ops`);
  assert.ok(plan.core.length <= 8);
  const after = apply(baseDb(), 'sadm', plan, '40 variants');
  assert.equal([...after.keys()].filter((k) => k.startsWith('inventory/pbig__')).length, 40);
  const tooMany = planProductSave({ mode: 'create', id: 'pbig2', form: { ...form, variants: [...variants, { id: 'zz', optionValues: { Size: 'S0', Color: 'A' }, sku: '', price: 1, active: true }] }, actor: actor('sadm'), nowMs: NOW });
  assert.equal(tooMany.error, 'invalid');
  assert.equal(tooMany.errors.variants, 'too_many');
});

test('update: price and text change, but live stock and reservations are never overwritten', () => {
  let db = apply(baseDb(), 'sadm', planProductSave({ mode: 'create', id: 'ptote', form: simple(), actor: actor('sadm'), nowMs: NOW }), 'create');
  // customers reserved 2 units and an inventory adjustment moved the stock in the meantime
  const inv = db.get('inventory/ptote'); inv.stock = 7; inv.reserved = 2; db.set('inventory/ptote', inv);
  const existing = { product: db.get('products/ptote'), inv: { ptote: db.get('inventory/ptote') } };
  const plan = planProductSave({ mode: 'update', id: 'ptote', form: simple({ price: 950, salePrice: null, description: 'Updated text', stock: 999, sku: 'TOTE-2', name: 'Canvas Tote XL' }), existing, actor: actor('pm'), nowMs: NOW + 1000 });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.pre.some((o) => o.path === 'inventory/ptote' && o.op === 'update' && 'stock' in o.data), false, 'the update must not carry a stock field');
  db = apply(db, 'pm', plan, 'update');
  assert.deepEqual([db.get('inventory/ptote').stock, db.get('inventory/ptote').reserved], [7, 2]);
  assert.deepEqual([db.get('inventory/ptote').price, db.get('inventory/ptote').salePrice, db.get('inventory/ptote').sku], [950, null, 'TOTE-2']);
  assert.deepEqual([db.get('products/ptote').price, db.get('products/ptote').name, db.get('products/ptote').soldCount], [950, 'Canvas Tote XL', 0], 'counters are untouched');
  assert.equal(db.get('products/ptote').createdAt.toMillis(), NOW, 'createdAt is untouched');
  assert.equal(db.get('skuIndex/TOTE-1'), undefined, 'the old SKU is released');
  assert.deepEqual(db.get('skuIndex/TOTE-2'), { productId: 'ptote', variantId: null });
});

test('update: renaming the slug moves the slug index entry; a category change reaches the inventory documents', () => {
  let db = apply(baseDb(), 'sadm', planProductSave({ mode: 'create', id: 'ptote', form: simple(), actor: actor('sadm'), nowMs: NOW }), 'create');
  const existing = { product: db.get('products/ptote'), inv: { ptote: db.get('inventory/ptote') } };
  const plan = planProductSave({ mode: 'update', id: 'ptote', form: simple({ slug: 'tote-bag-xl', categoryId: 'c2' }), existing, actor: actor('sadm'), nowMs: NOW + 1000 });
  db = apply(db, 'sadm', plan, 'rename');
  assert.equal(db.get('slugIndex/canvas-tote-bag'), undefined);
  assert.deepEqual(db.get('slugIndex/tote-bag-xl'), { productId: 'ptote' });
  assert.equal(db.get('inventory/ptote').categoryId, 'c2', 'checkout and coupons read the category from the inventory document');
});

test('update: variants the form dropped stay as inactive (their ids live on in old orders); new variants get stock', () => {
  let db = apply(baseDb(), 'sadm', planProductSave({ mode: 'create', id: 'pshorts', form: variable(), actor: actor('sadm'), nowMs: NOW }), 'create');
  const invAll = Object.fromEntries([...db.keys()].filter((k) => k.startsWith('inventory/pshorts__')).map((k) => [k.slice(10), db.get(k)]));
  const existing = { product: db.get('products/pshorts'), inv: invAll };
  const form = variable();
  form.variants = form.variants.filter((v) => v.id !== 'v00');                                             // dropped by the form
  form.options = [{ name: 'Size', values: ['S', 'M', 'L'] }, { name: 'Color', values: ['Red', 'Blue', 'Green'] }];
  form.variants.push({ id: 'vnew', optionValues: { Size: 'S', Color: 'Green' }, sku: 'RS-S-GREEN', price: 1600, salePrice: null, stock: 9, active: true });
  const plan = planProductSave({ mode: 'update', id: 'pshorts', form, existing, actor: actor('sadm'), nowMs: NOW + 1000 });
  db = apply(db, 'sadm', plan, 'update variants');
  const dropped = db.get('products/pshorts').variants.find((v) => v.id === 'v00');
  assert.equal(dropped.active, false);
  assert.equal(db.get('inventory/pshorts__v00').active, false);
  assert.equal(db.get('inventory/pshorts__vnew').stock, 9);
  assert.equal(db.get('inventory/pshorts__v01').stock, 4, 'existing variants keep their stock');
});

test('roles: only products.write can save; forged batches from other roles are refused by the rules', () => {
  const db = baseDb();
  const good = planProductSave({ mode: 'create', id: 'ptote', form: simple(), actor: actor('sadm'), nowMs: NOW });
  for (const uid of ['om', 'im', 'cs', 'rp']) {
    assert.equal(planProductSave({ mode: 'create', id: 'ptote', form: simple(), actor: actor(uid), nowMs: NOW }).error, 'forbidden', `${uid} is refused by the planner`);
    refusedBatch(db, uid, good.core, `core forged by ${uid}`);
    refusedBatch(db, uid, good.pre.filter((o) => o.path.startsWith('inventory/')), `inventory forged by ${uid}`);
  }
  refusedBatch(db, 'u1', good.core, 'core forged by a customer');
  refusedBatch(db, 'u1', good.pre.filter((o) => o.path.startsWith('inventory/')), 'inventory forged by a customer');
});

test('uniqueness answers from the data layer become field errors', () => {
  const base = { mode: 'create', id: 'ptote', form: simple(), actor: actor('pm'), nowMs: NOW };
  assert.equal(planProductSave({ ...base, unique: { slugOwner: 'other' } }).errors.slug, 'slug_taken');
  assert.equal(planProductSave({ ...base, unique: { slugOwner: 'ptote' } }).ok, true, 'the slug already belongs to this product');
  assert.equal(planProductSave({ ...base, unique: { skuOwners: { 'TOTE-1': { productId: 'other' } } } }).errors.sku, 'sku_taken');
  assert.equal(planProductSave({ ...base, unique: { skuOwners: { 'TOTE-1': { productId: 'ptote' } } } }).ok, true);
  const v = planProductSave({ mode: 'create', id: 'pshorts', form: variable(), actor: actor('pm'), nowMs: NOW, unique: { skuOwners: { 'RS-M-BLUE': { productId: 'other' } } } });
  assert.equal(v.error, 'invalid');
  assert.deepEqual(Object.values(v.variantErrors).map((x) => x.sku), ['sku_taken']);
});

test('uniqueness and basic errors are reported together, and a basic error is never replaced by a uniqueness one', () => {
  const unique = { slugOwner: 'other', skuOwners: { 'TOTE-1': { productId: 'other' } } };
  const together = planProductSave({ mode: 'create', id: 'ptote', form: simple({ salePrice: 950, name: '' , slug: 'taken-slug' }), actor: actor('pm'), nowMs: NOW, unique });
  assert.equal(together.error, 'invalid');
  assert.deepEqual(together.errors, { name: 'required', slug: 'slug_taken', salePrice: 'bad_sale', sku: 'sku_taken' }, 'all four problems come back in one answer');
  const basic = planProductSave({ mode: 'create', id: 'ptote', form: simple({ slug: 'Not A Slug!', sku: 'bad sku!' }), actor: actor('pm'), nowMs: NOW, unique: { slugOwner: 'other', skuOwners: { 'BAD SKU!': { productId: 'other' } } } });
  assert.equal(basic.errors.sku, 'bad_sku', 'a malformed SKU stays a format error');
  const shorts = variable();
  shorts.variants[0].price = null;                                     // basic error on variant 0 …
  shorts.variants[0].sku = '';
  const mixed = planProductSave({ mode: 'create', id: 'pshorts', form: shorts, actor: actor('pm'), nowMs: NOW, unique: { skuOwners: { 'RS-M-BLUE': { productId: 'other' } } } });
  const byIndex = mixed.variantErrors;
  assert.equal(byIndex[0].price, 'bad_price', 'variant 0 keeps its price error');
  assert.deepEqual(Object.values(byIndex).filter((e) => e.sku).map((e) => e.sku), ['sku_taken'], '… while the taken SKU of another variant is reported in the same answer');
});

test('validation: prices, sale rules, SKU format, duplicate combinations, sale dates', () => {
  const errs = (over) => validateProductForm(cleanProductForm(simple(over))).errors;
  assert.equal(errs({ name: '   ' }).name, 'required');
  assert.equal(errs({ price: 0 }).price, 'bad_price');
  assert.equal(errs({ price: 10.5 }).price, 'bad_price');
  assert.equal(errs({ price: 1e9 }).price, 'bad_price');
  assert.equal(errs({ price: '' }).price, 'bad_price');
  assert.equal(errs({ salePrice: 900 }).salePrice, 'bad_sale', 'a sale price equal to the price is not a sale');
  assert.equal(errs({ salePrice: 1000 }).salePrice, 'bad_sale');
  assert.equal(errs({ sku: 'bad sku!' }).sku, 'bad_sku');
  assert.equal(errs({ saleStart: 2000, saleEnd: 1000 }).saleEnd, 'sale_dates');
  assert.equal(errs({ maxPerOrder: 0 }).maxPerOrder, 'bad_max_per_order');
  assert.equal(errs({ maxPerOrder: 51 }).maxPerOrder, 'bad_max_per_order');
  assert.equal(errs({ stock: -1 }).stock, 'bad_number');
  assert.deepEqual(errs({}), {}, 'the default form is valid');

  const v = (mut) => { const f = variable(); mut(f); return validateProductForm(cleanProductForm(f)); };
  assert.equal(v((f) => { f.options = []; f.variants = []; }).errors.options, 'no_options');
  assert.equal(v((f) => { f.variants.forEach((x) => { x.active = false; }); }).errors.variants, 'no_variants');
  assert.equal(v((f) => { f.variants[1].optionValues = { ...f.variants[0].optionValues }; }).variantErrors[1].optionValues, 'dup_combo');
  assert.equal(v((f) => { f.variants[0].optionValues = { Size: 'XXL', Color: 'Red' }; }).variantErrors[0].optionValues, 'variant_incomplete');
  assert.equal(v((f) => { f.variants[2].sku = f.variants[3].sku; }).variantErrors[3].sku, 'dup_sku');
  assert.equal(v((f) => { f.variants[0].price = 0; }).variantErrors[0].price, 'bad_price');
  assert.equal(v((f) => { f.variants[0].salePrice = 5000; }).variantErrors[0].salePrice, 'bad_sale');
  assert.equal(v((f) => { f.options.push({ name: 'size', values: ['x'] }); }).errors.options, 'option_dup', 'option names compare case-insensitively');
  assert.equal(validateProductForm(cleanProductForm(variable())).ok, true);
});

test('the planner never writes invalid data even if the editor forgot to check', () => {
  const plan = planProductSave({ mode: 'create', id: 'ptote', form: simple({ price: 500, salePrice: 600 }), actor: actor('sadm'), nowMs: NOW });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'invalid');
  assert.equal(planProductSave({ mode: 'create', id: 'a__b', form: simple(), actor: actor('sadm'), nowMs: NOW }).error, 'bad_id');
  assert.equal(planProductSave({ mode: 'update', id: 'ptote', form: simple(), existing: null, actor: actor('sadm'), nowMs: NOW }).error, 'not_found');
});

test('an old-format product must be migrated first (the rules need status and type on the document)', () => {
  const existing = { product: { name: 'Old thing', price: 100, image: 'gallery/x.webp' }, inv: {} };
  assert.equal(planProductSave({ mode: 'update', id: 'old1', form: simple(), existing, actor: actor('sadm'), nowMs: NOW }).error, 'legacy');
});

test('bulk status: published ↔ archived in chunks with their own stamp and audit; old-format products are skipped', () => {
  const db = baseDb();
  db.set('products/old1', { name: 'Legacy', price: 100 });
  const products = ['p1', 'pd', 'old1'].map((id) => ({ id, data: db.get(`products/${id}`) }));
  const plan = planProductStatus({ products, status: 'archived', actor: actor('pm'), nowMs: NOW });
  assert.equal(plan.changed, 2);
  assert.deepEqual(plan.skipped, [{ id: 'old1', reason: 'legacy' }]);
  assert.equal(plan.chunks.length, 1);
  assert.ok(plan.chunks[0].length <= 18);
  const r = commitBoth(db, { uid: 'pm' }, plan.chunks[0]);
  assert.equal(r.strict.allowed, true, failedOps(r.strict).join(' | '));
  assert.equal(r.tolerant.allowed, true, failedOps(r.tolerant).join(' | '));
  assert.equal(r.strict.dbAfter.get('products/p1').status, 'archived');
  assert.equal(planProductStatus({ products: [{ id: 'p1', data: db.get('products/p1') }], status: 'published', actor: actor('pm'), nowMs: NOW }).skipped[0].reason, 'same');
  for (const uid of ['om', 'im', 'cs', 'rp']) {
    assert.equal(planProductStatus({ products, status: 'archived', actor: actor(uid), nowMs: NOW }).error, 'forbidden');
    refusedBatch(db, uid, plan.chunks[0], `bulk status forged by ${uid}`);
  }
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, data: { name: 'x', type: 'simple', status: 'draft', price: 1 } }));
  const big = planProductStatus({ products: many, status: 'published', actor: actor('sadm'), nowMs: NOW });
  assert.equal(big.chunks.length, 3);
  assert.ok(big.chunks.every((c) => c.length <= 18 && c[c.length - 2].path === 'meta/catalog'));
});

test('delete: refused while open orders hold reserved stock; otherwise everything about the product goes, atomically for the core', () => {
  let db = apply(baseDb(), 'sadm', planProductSave({ mode: 'create', id: 'pshorts', form: variable(), actor: actor('sadm'), nowMs: NOW }), 'create');
  const read = () => ({ product: db.get('products/pshorts'), inv: Object.fromEntries([...db.keys()].filter((k) => k.startsWith('inventory/pshorts__')).map((k) => [k.slice(10), db.get(k)])) });
  const held = db.get('inventory/pshorts__v00'); held.reserved = 1; db.set('inventory/pshorts__v00', held);
  assert.equal(planProductDelete({ id: 'pshorts', existing: read(), actor: actor('pm'), nowMs: NOW }).error, 'has_reservations');
  held.reserved = 0; db.set('inventory/pshorts__v00', held);
  const plan = planProductDelete({ id: 'pshorts', existing: read(), actor: actor('pm'), nowMs: NOW });
  assert.equal(plan.ok, true);
  for (const uid of ['om', 'im', 'cs', 'rp']) {
    assert.equal(planProductDelete({ id: 'pshorts', existing: read(), actor: actor(uid), nowMs: NOW }).error, 'forbidden');
    refusedBatch(db, uid, plan.core, `delete forged by ${uid}`);
  }
  db = apply(db, 'pm', plan, 'delete');
  assert.equal(db.get('products/pshorts'), undefined);
  assert.equal([...db.keys()].filter((k) => k.startsWith('inventory/pshorts__') || k.startsWith('skuIndex/RS-')).length, 0);
  assert.equal(db.get('slugIndex/running-shorts'), undefined);
  assert.equal(planProductDelete({ id: 'x', existing: null, actor: actor('pm'), nowMs: NOW }).error, 'not_found');
});

test('cost price is stored only by roles that may read costs, and only when the editor sent it', () => {
  const withCost = simple({ cost: { costPrice: 600, supplier: 'Dhaka Textiles', notes: 'MOQ 50' } });
  const a = planProductSave({ mode: 'create', id: 'ptote', form: withCost, actor: actor('pm'), nowMs: NOW });
  assert.equal(a.core.some((o) => o.path === 'productPrivate/ptote'), true);
  const after = apply(baseDb(), 'pm', a, 'with cost');
  assert.deepEqual([after.get('productPrivate/ptote').costPrice, after.get('productPrivate/ptote').supplier], [600, 'Dhaka Textiles']);
  assert.equal(planProductSave({ mode: 'create', id: 'ptote', form: simple(), actor: actor('pm'), nowMs: NOW }).core.some((o) => o.path.startsWith('productPrivate/')), false, 'no cost section in the form → nothing written');
  assert.equal(planProductSave({ mode: 'create', id: 'ptote', form: simple({ cost: { costPrice: -5 } }), actor: actor('pm'), nowMs: NOW }).errors.costPrice, 'bad_price');
});
