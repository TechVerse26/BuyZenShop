/*
 * Categories & brands (js/shared/taxonomyFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * Super Admin, Store Admin and Product Manager write categories / brands (+ the products carrying the old name, + meta/catalog stamp, + an audit entry);
 * every other role and every customer is refused by the RULES (not only by the planner); the planner enforces what the rules cannot see
 * (names, unique slugs, two levels, safe image links, what may be deleted).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTaxonomyForm, planTaxonomySave, planTaxonomyVisible, planTaxonomyRemove, planCategoryMove, taxonomyCounts, siblingsOf, TAXONOMY_LIMITS,
} from '../../js/shared/taxonomyFlow.js';
import { chunkOps } from '../../js/shared/ops.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { baseDb, commitBoth, failedOps, NOW } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const all = (db, coll) => [...db.m.entries()].filter(([k]) => k.startsWith(`${coll}/`) && k.split('/').length === 2).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const plain = { image: '', imagePath: '', icon: '', description: '', visible: true };

function taxDb() {
  const db = baseDb();
  const set = (k, v) => db.m.set(k, v);
  set('categories/c1', { name: 'Clothing', slug: 'clothing', parentId: null, ...plain, sort: 1 });
  set('categories/c2', { name: 'Accessories', slug: 'accessories', parentId: null, ...plain, sort: 2 });
  set('categories/c3', { name: 'Watches', slug: 'watches', parentId: 'c2', ...plain, sort: 1 });
  set('brands/b1', { name: 'Nordic', slug: 'nordic', logo: '', logoPath: '', description: '', visible: true });
  set('brands/b2', { name: 'Chronos', slug: 'chronos', logo: '', logoPath: '', description: '', visible: true });
  const product = (name, categoryId, brandId, status = 'published') => ({
    name, slug: name.toLowerCase().replace(/\W+/g, '-'), status, type: 'simple', price: 1000, salePrice: null, categoryId, categoryName: categoryId === 'c1' ? 'Clothing' : 'Accessories', brandId, brandName: brandId === 'b1' ? 'Nordic' : 'Chronos', sku: name,
  });
  set('products/p1', product('Shirt', 'c1', 'b1'));
  set('products/p2', product('Cap', 'c1', 'b1'));
  set('products/pd', product('Draft Tee', 'c1', 'b1', 'draft'));
  set('products/p3', product('Wallet', 'c2', 'b2'));
  return db;
}
const cats = (db) => all(db, 'categories');
const brands = (db) => all(db, 'brands');
const prods = (db) => all(db, 'products');

function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}
function commitAll(db, uid, ops, label) {
  let cur = db;
  chunkOps(ops, 18).forEach((chunk, i) => { cur = commit(cur, uid, chunk, `${label} #${i + 1}`); });
  return cur;
}
const save = (db, kind, over = {}, who = 'sa') => planTaxonomySave({
  kind, creating: true, form: { name: 'Shoes', ...over }, items: all(db, kind === 'category' ? 'categories' : 'brands'), products: prods(db), actor: actor(who), nowMs: NOW,
});
const edit = (db, kind, id, over = {}, who = 'sa') => {
  const items = all(db, kind === 'category' ? 'categories' : 'brands');
  const cur = items.find((c) => c.id === id) || {};
  const form = kind === 'category'
    ? { name: cur.name, slug: cur.slug, parentId: cur.parentId || '', description: cur.description, image: cur.image, imagePath: cur.imagePath, visible: cur.visible }
    : { name: cur.name, slug: cur.slug, description: cur.description, image: cur.logo, imagePath: cur.logoPath, visible: cur.visible };
  return planTaxonomySave({ kind, id, form: { ...form, ...over }, items, products: prods(db), actor: actor(who), nowMs: NOW });
};

test('validate: a good form is normalised — spaces collapsed, slug made from the name, empty parent → null; a brand uses logo / logoPath', () => {
  const db = taxDb();
  const v = validateTaxonomyForm('category', { name: '  Men   Shoes ', slug: '', parentId: '', description: ' a   b ', image: '', visible: true }, { items: cats(db) });
  assert.equal(v.ok, true);
  assert.deepEqual(v.values, { name: 'Men Shoes', slug: 'men-shoes', parentId: null, description: 'a b', image: '', imagePath: '', visible: true });
  const b = validateTaxonomyForm('brand', { name: 'Acme', image: 'https://img.test/a.webp', imagePath: 'site/brands/a.webp' }, { items: brands(db) });
  assert.deepEqual(b.values, { name: 'Acme', slug: 'acme', description: '', logo: 'https://img.test/a.webp', logoPath: 'site/brands/a.webp', visible: true });
});

test('validate: names are required, bounded and unique — a category among its siblings, a brand among all brands; the limits themselves are fine', () => {
  const db = taxDb();
  const bad = (kind, form, field, code, id = null) => {
    const v = validateTaxonomyForm(kind, form, { items: all(db, kind === 'category' ? 'categories' : 'brands'), id });
    assert.equal(v.ok, false, JSON.stringify(form));
    assert.equal(v.errors[field], code, JSON.stringify(form));
  };
  bad('category', { name: '' }, 'name', 'required'); bad('category', { name: '   ' }, 'name', 'required');
  bad('category', { name: 'x'.repeat(81) }, 'name', 'too_long');
  bad('category', { name: ' clothing ' }, 'name', 'name_taken');
  bad('category', { name: 'WATCHES', parentId: 'c2' }, 'name', 'name_taken');
  bad('brand', { name: ' NORDIC' }, 'name', 'name_taken');
  assert.equal(validateTaxonomyForm('category', { name: 'Watches' }, { items: cats(db) }).ok, true, 'the same name under ANOTHER parent is fine');
  assert.equal(validateTaxonomyForm('category', { name: 'Clothing' }, { items: cats(db), id: 'c1' }).ok, true, 'a category never clashes with itself');
  assert.equal(validateTaxonomyForm('category', { name: 'x'.repeat(TAXONOMY_LIMITS.nameMax) }, { items: cats(db) }).ok, true);
  bad('category', { name: 'Fine', description: 'x'.repeat(301) }, 'description', 'too_long');
  assert.equal(validateTaxonomyForm('category', { name: 'Fine', description: 'x'.repeat(300) }, { items: cats(db) }).ok, true);
});

test('validate: slugs are a–z 0–9 and hyphens, unique, and made from the name (with -2, -3 …) when left empty', () => {
  const db = taxDb();
  const v = (form, id = null) => validateTaxonomyForm('category', { name: 'Fine', ...form }, { items: cats(db), id });
  for (const slug of ['Bad Slug', 'under_score', '-lead', 'trail-', 'a--b', 'x'.repeat(81), 'ঢাকা']) assert.equal(v({ slug }).errors.slug, 'bad_slug', slug);
  assert.equal(v({ slug: 'clothing' }).errors.slug, 'slug_taken');
  assert.equal(v({ slug: 'CLOTHING' }).errors.slug, 'slug_taken', 'case is ignored');
  assert.equal(v({ slug: 'clothing' }, 'c1').ok, true, 'its own slug is fine');
  assert.equal(v({ slug: 'a1-b2' }).values.slug, 'a1-b2');
  assert.equal(validateTaxonomyForm('category', { name: 'Clothing!' }, { items: cats(db) }).values.slug, 'clothing-2', 'a taken slug gets a number');
  assert.match(validateTaxonomyForm('category', { name: 'ঢাকা সিটি' }, { items: cats(db) }).values.slug, /^[a-z0-9-]+$/, 'a Bengali name still gets a usable slug');
  assert.equal(validateTaxonomyForm('category', { name: '***' }, { items: cats(db) }).values.slug, 'category', 'a name without letters falls back to the kind');
});

test('validate: a category has at most two levels — no unknown or own parent, no sub-category as parent, no children under a category that has children', () => {
  const db = taxDb();
  const v = (form, id = null) => validateTaxonomyForm('category', { name: 'Fine', ...form }, { items: cats(db), id });
  assert.equal(v({ parentId: 'c1' }).values.parentId, 'c1');
  assert.equal(v({ parentId: '' }).values.parentId, null);
  assert.equal(v({ parentId: 'nope' }).errors.parentId, 'bad_parent');
  assert.equal(v({ parentId: 'c1' }, 'c1').errors.parentId, 'bad_parent', 'itself');
  assert.equal(v({ parentId: 'c3' }).errors.parentId, 'too_deep', 'Watches is already a sub-category');
  assert.equal(v({ parentId: 'c1' }, 'c2').errors.parentId, 'has_children', 'Accessories has Watches under it');
  assert.equal(v({ parentId: 'c1' }, 'c3').ok, true, 'a sub-category may move to another parent');
  assert.equal(validateTaxonomyForm('brand', { name: 'Acme', parentId: 'c1' }, { items: brands(db) }).values.parentId, undefined, 'brands have no parent');
});

test('validate: an image is an https link or a path on this site — nothing else — and its storage path must be ours', () => {
  const db = taxDb();
  const v = (form) => validateTaxonomyForm('category', { name: 'Fine', ...form }, { items: cats(db) });
  for (const image of ['javascript:alert(1)', '//evil.test/x.png', 'http://x.test/a.png', 'data:image/png;base64,AAAA', 'ftp://x/a.png', 'blob:http://x/1', 'a b.png', 'x.png']) {
    assert.equal(v({ image }).errors.image, 'bad_image', image);
  }
  for (const image of ['https://firebasestorage.googleapis.com/v0/b/x/o/site%2Fcategories%2Fa.webp?alt=media', '/gallery/a.webp']) assert.equal(v({ image }).ok, true, image);
  assert.equal(v({ image: `https://x.test/${'a'.repeat(1001)}` }).errors.image, 'bad_image');
  assert.equal(v({ image: '/a.webp', imagePath: '../../etc/passwd' }).errors.image, 'bad_image');
  assert.equal(v({ image: '/a.webp', imagePath: 'products/p1/a.webp' }).errors.image, 'bad_image', 'only site/categories and site/brands');
  assert.equal(v({ image: '/a.webp', imagePath: 'site/categories/a.webp' }).values.imagePath, 'site/categories/a.webp');
  assert.equal(v({ image: '', imagePath: 'site/categories/a.webp' }).values.imagePath, '', 'no image → no storage path');
});

test('create: ids come from the slug, sort follows the siblings, exactly the documented fields, audit entry and catalog stamp — for Super Admin, Store Admin and Product Manager', () => {
  for (const who of ['sa', 'sadm', 'pm']) {
    let db = taxDb();
    const top = save(db, 'category', { name: 'Shoes' }, who);
    assert.equal(top.ok, true, JSON.stringify(top));
    assert.deepEqual([top.id, top.action, top.ops.length, top.followUp], ['shoes', 'category.create', 3, []]);
    assert.deepEqual(Object.keys(top.ops[0].data).sort(), ['createdAt', 'description', 'icon', 'image', 'imagePath', 'name', 'parentId', 'slug', 'sort', 'updatedAt', 'visible']);
    db = commit(db, who, top.ops, `${who} category`);
    assert.equal(db.get('categories/shoes').sort, 3, 'after Clothing (1) and Accessories (2)');
    const sub = save(db, 'category', { name: 'Straps', parentId: 'c2' }, who);
    db = commit(db, who, sub.ops, `${who} sub`);
    assert.deepEqual([db.get('categories/straps').parentId, db.get('categories/straps').sort], ['c2', 2], 'next to Watches (1) under Accessories');
    const br = save(db, 'brand', { name: 'Acme', description: 'Tools' }, who);
    assert.deepEqual(Object.keys(br.ops[0].data).sort(), ['createdAt', 'description', 'logo', 'logoPath', 'name', 'slug', 'updatedAt', 'visible']);
    db = commit(db, who, br.ops, `${who} brand`);
    assert.deepEqual([db.get('brands/acme').name, db.get('brands/acme').description, db.get('brands/acme').visible], ['Acme', 'Tools', true]);
    assert.equal(db.get('meta/catalog').version, NOW, 'the catalog stamp moved');
    assert.deepEqual(audits(db).map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(),
      [['brand.create', 'acme', who, ROLE[who]], ['category.create', 'shoes', who, ROLE[who]], ['category.create', 'straps', who, ROLE[who]]]);
  }
});

test('create: an id never collides (…-2) even when an older category kept a different slug', () => {
  let db = taxDb();
  db.m.set('categories/shoes', { name: 'Old', slug: 'old-link', parentId: null, ...plain, sort: 9 });
  const p = save(db, 'category', { name: 'Shoes' });
  assert.equal(p.ok, true);
  assert.equal(p.values.slug, 'shoes');
  assert.equal(p.id, 'shoes-2');
  db = commit(db, 'sa', p.ops, 'create');
  assert.equal(db.get('categories/shoes-2').slug, 'shoes');
});

test('who may write: Super Admin, Store Admin, Product Manager; every other role and every customer is refused by the RULES themselves', () => {
  const db = taxDb();
  for (const kind of ['category', 'brand']) {
    const p = save(db, kind, { name: 'Forged' });
    const batch = (uid) => [p.ops[0], auditOp(actor(uid) || { uid, email: `${uid}@x.test`, role: 'customer' }, { action: `${kind}.create`, entity: kind, entityId: p.id, summary: 'forged' }), p.ops[2]];
    for (const uid of ['sa', 'sadm', 'pm']) commit(db, uid, batch(uid), `${kind} ${uid}`);
    for (const uid of ['om', 'im', 'cs', 'rp', 'u1']) {
      const r = commitBoth(db, { uid }, batch(uid));
      assert.equal(r.strict.allowed, false, `${kind} ${uid} strict`);
      assert.equal(r.tolerant.allowed, false, `${kind} ${uid} tolerant`);
      assert.equal(planTaxonomySave({ kind, creating: true, form: { name: 'Forged' }, items: [], actor: actor(uid) || { uid, role: 'customer' } }).error, 'forbidden', `${kind} ${uid} planner`);
    }
  }
});

test('rename: the new name is copied into every product of the category (drafts too) in chunks, the atomic first batch holds the category, its audit entry and the stamp', () => {
  let db = taxDb();
  const p = edit(db, 'category', 'c1', { name: 'Apparel' }, 'pm');
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual([p.action, p.ops.length, p.renamed], ['category.update', 3, 3]);
  assert.equal(p.ops[0].data.slug, undefined, 'only what changed is written');
  assert.deepEqual(p.followUp.slice(0, -1).map((o) => o.path).sort(), ['products/p1', 'products/p2', 'products/pd']);
  db = commit(db, 'pm', p.ops, 'first batch');
  assert.equal(db.get('categories/c1').name, 'Apparel');
  assert.equal(db.get('products/p1').categoryName, 'Clothing', 'the products are not rewritten yet');
  db = commitAll(db, 'pm', p.followUp, 'follow-up');
  for (const id of ['p1', 'p2', 'pd']) assert.equal(db.get(`products/${id}`).categoryName, 'Apparel', id);
  assert.equal(db.get('products/p3').categoryName, 'Accessories', 'products of other categories are untouched');
  assert.deepEqual([db.get('products/p1').name, db.get('products/p1').price, db.get('products/p1').status, db.get('products/p1').brandName], ['Shirt', 1000, 'published', 'Nordic'], 'and nothing else changed on the product');
  assert.deepEqual(audits(db).map((a) => [a.action, a.entityId, a.actorRole]), [['category.update', 'c1', 'product_manager']]);
  assert.equal(edit(db, 'category', 'c1', {}, 'pm').error, 'no_change', 'saving the same values again does nothing');
});

test('rename: an unfinished rename is repaired by saving again — stale products are always included', () => {
  let db = taxDb();
  const p = edit(db, 'brand', 'b1', { name: 'Nordic Co' }, 'sadm');
  db = commit(db, 'sadm', p.ops, 'first batch only');                       // the follow-up never ran
  assert.equal(db.get('products/p1').brandName, 'Nordic');
  const again = edit(db, 'brand', 'b1', {}, 'sadm');
  assert.equal(again.ok, true, 'not "no change": three products are stale');
  assert.deepEqual([again.ops.length, again.followUp.length, again.renamed], [2, 4, 3], 'audit + stamp, then three products + stamp');
  assert.equal(again.ops.some((o) => o.op === 'update' && o.path === 'brands/b1'), false, 'the brand itself is not rewritten');
  db = commitAll(db, 'sadm', [...again.ops, ...again.followUp], 'repair');
  for (const id of ['p1', 'p2', 'pd']) assert.equal(db.get(`products/${id}`).brandName, 'Nordic Co', id);
  assert.equal(edit(db, 'brand', 'b1', {}, 'sadm').error, 'no_change');
});

test('rename: a hundred products are copied in chunks the rules accept', () => {
  let db = taxDb();
  for (let i = 0; i < 100; i++) db.m.set(`products/x${i}`, { name: `Item ${i}`, slug: `item-${i}`, status: 'published', type: 'simple', price: 500, categoryId: 'c2', categoryName: 'Accessories', brandId: 'b2', brandName: 'Chronos' });
  const p = edit(db, 'category', 'c2', { name: 'Gear' }, 'sadm');
  assert.equal(p.followUp.length, 102, 'p3 + 100 items + stamp');
  assert.ok(chunkOps(p.followUp, 18).length >= 6);
  db = commit(db, 'sadm', p.ops, 'first');
  db = commitAll(db, 'sadm', p.followUp, 'rest');
  assert.equal(prods(db).filter((x) => x.categoryId === 'c2' && x.categoryName === 'Gear').length, 101);
});

test('edit: slug, description, image and visibility change only those fields; a move to another parent puts the category last there; moving under a parent needs it free of children', () => {
  let db = taxDb();
  const p = edit(db, 'category', 'c1', { slug: 'apparel', description: 'All wear', image: '/gallery/a.webp', imagePath: '', visible: false }, 'sa');
  assert.deepEqual(Object.keys(p.ops[0].data).sort(), ['description', 'image', 'slug', 'updatedAt', 'visible']);
  assert.deepEqual(p.followUp, [], 'no rename → no product writes');
  db = commit(db, 'sa', p.ops, 'edit');
  assert.deepEqual([db.get('categories/c1').slug, db.get('categories/c1').image, db.get('categories/c1').visible, db.get('categories/c1').name], ['apparel', '/gallery/a.webp', false, 'Clothing']);

  const mv = edit(db, 'category', 'c1', { parentId: 'c2' }, 'sa');
  assert.equal(mv.ok, true);
  assert.equal(mv.ops[0].data.sort, 2, 'after Watches (1) under Accessories');
  db = commit(db, 'sa', mv.ops, 'move');
  assert.deepEqual([db.get('categories/c1').parentId, db.get('categories/c1').sort], ['c2', 2]);
  assert.equal(edit(taxDb(), 'category', 'c2', { parentId: 'c1' }, 'sa').errors?.parentId, 'has_children', 'Accessories has Watches under it');
  assert.equal(edit(db, 'category', 'c2', { parentId: 'c1' }, 'sa').errors?.parentId, 'too_deep', 'and Clothing is a sub-category by now');
  const clash = edit(db, 'category', 'c3', { slug: 'accessories' }, 'sa');
  assert.deepEqual([clash.error, clash.errors.slug], ['invalid', 'slug_taken']);
  assert.equal(edit(db, 'category', 'zzz', {}, 'sa').error, 'not_found');
});

test('visibility: hide / show with an audit entry and a stamp; the same state again is no change', () => {
  let db = taxDb();
  const items = () => cats(db);
  const hide = planTaxonomyVisible({ kind: 'category', id: 'c2', visible: false, items: items(), actor: actor('sadm'), nowMs: NOW });
  assert.deepEqual([hide.ok, hide.action, hide.ops.length], [true, 'category.hide', 3]);
  db = commit(db, 'sadm', hide.ops, 'hide');
  assert.equal(db.get('categories/c2').visible, false);
  assert.equal(planTaxonomyVisible({ kind: 'category', id: 'c2', visible: false, items: items(), actor: actor('sadm') }).error, 'no_change');
  const show = planTaxonomyVisible({ kind: 'category', id: 'c2', visible: true, items: items(), actor: actor('sadm'), nowMs: NOW });
  db = commit(db, 'sadm', show.ops, 'show');
  assert.equal(db.get('categories/c2').visible, true);
  const bh = planTaxonomyVisible({ kind: 'brand', id: 'b1', visible: false, items: brands(db), actor: actor('pm'), nowMs: NOW });
  db = commit(db, 'pm', bh.ops, 'brand hide');
  assert.deepEqual(audits(db).map((a) => a.action).sort(), ['brand.hide', 'category.hide', 'category.show']);
  assert.equal(planTaxonomyVisible({ kind: 'brand', id: 'b1', visible: true, items: brands(db), actor: actor('om') }).error, 'forbidden');
});

test('delete: refused while sub-categories, products or a coupon scope point at it; otherwise one atomic batch (document, audit, stamp) that hands back the image to clean up', () => {
  let db = taxDb();
  const rm = (kind, id, refs = {}, who = 'sa') => planTaxonomyRemove({ kind, id, items: all(db, kind === 'category' ? 'categories' : 'brands'), refs, actor: actor(who), nowMs: NOW });
  assert.deepEqual([rm('category', 'c2').error, rm('category', 'c2').count], ['has_children', 1]);
  assert.deepEqual([rm('category', 'c1', { products: 3 }).error, rm('category', 'c1', { products: 3 }).count], ['in_use', 3]);
  assert.deepEqual([rm('brand', 'b1', { products: 1 }).error], ['in_use']);
  assert.deepEqual([rm('category', 'c3', { coupons: ['CAT2'] }).error, rm('category', 'c3', { coupons: ['CAT2'] }).coupons], ['coupon_scope', ['CAT2']]);
  assert.equal(rm('category', 'zzz').error, 'not_found');
  assert.equal(rm('brand', 'b2', {}, 'om').error, 'forbidden');

  db.m.set('brands/b3', { name: 'Unused', slug: 'unused', logo: 'https://img.test/x.webp', logoPath: 'site/brands/x.webp', description: '', visible: true });
  const p = rm('brand', 'b3', {}, 'pm');
  assert.deepEqual([p.ok, p.imagePath, p.ops.length], [true, 'site/brands/x.webp', 3]);
  const forced = commitBoth(db, { uid: 'om' }, [p.ops[0], auditOp(actor('om'), { action: 'brand.delete', entity: 'brand', entityId: 'b3', summary: 'forged' }), p.ops[2]]);
  assert.equal(forced.strict.allowed, false, 'an Order Manager is refused by the rules');
  assert.equal(forced.tolerant.allowed, false);
  db = commit(db, 'pm', p.ops, 'delete');
  assert.equal(db.get('brands/b3'), undefined);
  assert.deepEqual(audits(db).map((a) => [a.action, a.entityId, a.actorRole]), [['brand.delete', 'b3', 'product_manager']]);
  db = commit(db, 'sa', rm('category', 'c3').ops, 'delete sub-category');
  assert.equal(db.get('categories/c3'), undefined);
});

test('counts: products per category / brand and sub-categories per category', () => {
  const db = taxDb();
  const c = taxonomyCounts('category', cats(db), prods(db));
  assert.deepEqual([c.get('c1'), c.get('c2'), c.get('c3')], [{ products: 3, children: 0 }, { products: 1, children: 1 }, { products: 0, children: 0 }]);
  const b = taxonomyCounts('brand', brands(db), prods(db));
  assert.deepEqual([b.get('b1'), b.get('b2')], [{ products: 3, children: 0 }, { products: 1, children: 0 }]);
});

test('reorder: a category swaps with its neighbour; all siblings are renumbered 1…n, so duplicates heal; the ends cannot move further; sub-categories move among their own siblings', () => {
  let db = taxDb();
  const mv = (id, dir, who = 'sa') => planCategoryMove({ id, dir, items: cats(db), actor: actor(who), nowMs: NOW });
  assert.equal(mv('c1', 'up').error, 'no_change');
  assert.equal(mv('c2', 'down').error, 'no_change');
  assert.equal(mv('c3', 'up').error, 'no_change', 'the only sub-category');
  const down = mv('c1', 'down', 'pm');
  assert.deepEqual([down.ok, down.action, down.ops.length], [true, 'category.reorder', 4], 'two sort updates, audit, stamp');
  db = commit(db, 'pm', down.ops, 'down');
  assert.deepEqual([db.get('categories/c1').sort, db.get('categories/c2').sort], [2, 1]);
  assert.deepEqual(siblingsOf('category', cats(db), null).map((c) => c.id), ['c2', 'c1']);

  db = taxDb();
  for (const [id, name] of [['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]) db.m.set(`categories/${id}`, { name, slug: id, parentId: 'c1', ...plain, sort: 1 });
  const up = mv('c', 'up', 'sadm');
  assert.deepEqual(up.ops.filter((o) => o.op === 'update').map((o) => [o.path, o.data.sort]).sort(), [['categories/b', 3], ['categories/c', 2]], 'a stays 1, c takes 2, b 3');
  db = commit(db, 'sadm', up.ops, 'heal');
  assert.deepEqual(siblingsOf('category', cats(db), 'c1').map((c) => c.id), ['a', 'c', 'b']);
  assert.equal(mv('c', 'up', 'om').error, 'forbidden');
  const forced = commitBoth(db, { uid: 'om' }, [...up.ops.slice(0, -2), auditOp(actor('om'), { action: 'category.reorder', entity: 'category', entityId: 'c', summary: 'forged' }), up.ops.at(-1)]);
  assert.equal(forced.strict.allowed, false, 'and the rules refuse an Order Manager');
  assert.equal(forced.tolerant.allowed, false);
});
