/* The legacy → v2 migration must be accepted by the real rules (as Super Admin), be idempotent, and keep legacy data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planMigration } from '../../js/shared/migration.js';
import { chunkOps } from '../../js/shared/ops.js';
import { normalizeProduct } from '../../js/shared/productModel.js';
import { LIMITS } from '../../js/shared/constants.js';
import { MemDb, Ts } from './rules-engine.mjs';
import { commitBoth, failedOps, NOW } from './harness.mjs';

const actor = { uid: 'sa', email: 'sa@x.test', role: 'super_admin' };

function legacyDb() {
  const db = new MemDb();
  db.set('staff/sa', { role: 'super_admin', active: true });
  db.set('staff/om', { role: 'order_manager', active: true });
  const P = (id, d) => db.set(`products/${id}`, { timestamp: '2026-07-01T10:00:00.000Z', ...d });
  P('prod1', { name: 'Argentina Home T-Shirt', price: 650, oldPrice: 850, category: 'Fashion', image: 'gallery/argentina-home-t-shirt.webp', desc: 'Soft cotton\nGood fit', stock: 'In Stock', soldCount: 12, rating: 4.5, ratingCount: 8, icon: 'fa-solid fa-shirt' });
  P('prod2', { name: 'Smart Watch', price: 2500, category: 'Gadgets', imageUrl: 'gallery/watch-cut.webp', stock: 'Out of Stock' });
  P('prod3', { name: 'স্মার্ট বোতল', price: 300, category: 'Fashion', stock: 'In Stock' });
  P('prod4', { name: 'No price item', category: 'Gadgets', stock: 'In Stock' });
  P('prod5', { name: 'Fractional', price: 99.5, stock: 'In Stock' });
  P('prod6', { name: 'Smart Watch', price: 1800, category: 'Gadgets' }); // duplicate name → unique slug
  db.set('orders/order_1', { userId: 'ua', voucherCode: 'SHOPVERSE', status: 'Delivered', timestamp: '2026-08-01T00:00:00.000Z', totalAmount: 100 });
  db.set('orders/order_2', { userId: 'ub', voucherCode: 'None', status: 'Pending', timestamp: '2026-08-02T00:00:00.000Z', totalAmount: 100 });
  db.set('orders/order_3', { userId: 'uc', voucherCode: 'SHOPVERSE', status: 'Pending', timestamp: '2026-08-03T00:00:00.000Z', totalAmount: 100 });
  return db;
}

function existingOf(db) {
  const list = (prefix) => db.keys().filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => ({ id: k.slice(prefix.length), data: db.get(k) }));
  return {
    categories: list('categories/'), zones: list('shippingZones/'),
    slugIndex: new Set(list('slugIndex/').map((x) => x.id)), inventoryKeys: new Set(list('inventory/').map((x) => x.id)),
    settingsPublic: db.get('settings/public') || null, settingsPrivate: db.get('settings/private') || null, home: db.get('content/home') || null,
    couponCodes: new Set(list('coupons/').map((x) => x.id)), couponUsageIds: new Set(list('couponUsage/').map((x) => x.id)),
  };
}

function run(db) {
  const products = db.keys().filter((k) => /^products\/[^/]+$/.test(k)).map((k) => ({ id: k.split('/')[1], data: db.get(k) }));
  const legacyOrders = db.keys().filter((k) => /^orders\/[^/]+$/.test(k)).map((k) => ({ id: k.split('/')[1], data: db.get(k) }));
  const plan = planMigration({ products, legacyOrders, existing: existingOf(db), actor, nowMs: NOW });
  let cur = db;
  let batches = 0, maxCalls = 0;
  for (const chunk of chunkOps(plan.ops, LIMITS.ADMIN_BATCH_OPS)) {
    const r = commitBoth(cur, { uid: 'sa' }, chunk);
    assert.equal(r.strict.allowed, true, `strict: ${failedOps(r.strict).join(' | ')}`);
    assert.equal(r.tolerant.allowed, true, `tolerant: ${failedOps(r.tolerant).join(' | ')}`);
    maxCalls = Math.max(maxCalls, r.strict.totalCalls);
    cur = r.strict.dbAfter; batches++;
  }
  return { plan, db: cur, batches, maxCalls };
}

test('migration is accepted by the rules and converts every legacy product', () => {
  const { plan, db, batches, maxCalls } = run(legacyDb());
  console.log(`      migration: ${plan.ops.length} writes in ${batches} batches (max ${maxCalls} access calls per batch)`);
  assert.equal(plan.report.products.migrated, 6);
  assert.equal(plan.report.products.drafted, 1); // "No price item"

  const p1 = db.get('products/prod1');
  assert.equal(p1.status, 'published');
  assert.equal(p1.price, 850);
  assert.equal(p1.salePrice, 650);
  assert.equal(p1.image, 'gallery/argentina-home-t-shirt.webp', 'legacy fields are preserved');
  assert.equal(p1.oldPrice, 850);
  assert.equal(p1.images[0].url, '/gallery/argentina-home-t-shirt.webp', 'relative legacy paths become root-relative (the storefront has nested URLs)');
  assert.equal(p1.categoryName, 'Fashion');
  assert.ok(db.has(`categories/${p1.categoryId}`));
  assert.equal(db.get('inventory/prod1').price, 850);
  assert.equal(db.get('inventory/prod1').salePrice, 650);
  assert.equal(db.get('inventory/prod1').track, false, 'legacy "In Stock" has no quantity → untracked');
  assert.equal(db.get('inventory/prod2').track, true);
  assert.equal(db.get('inventory/prod2').stock, 0);
  assert.equal(db.get('products/prod4').status, 'draft');
  assert.equal(db.get('products/prod5').price, 100);
  const slugs = ['prod1', 'prod2', 'prod3', 'prod4', 'prod5', 'prod6'].map((id) => db.get(`products/${id}`).slug);
  assert.equal(new Set(slugs).size, 6, 'slugs are unique');
  assert.match(slugs[2], /^[a-z0-9]+(-[a-z0-9]+)*$/, 'Bengali name still yields a valid slug');
  assert.ok(db.has('settings/public') && db.has('settings/private') && db.has('content/home'));
  assert.equal(db.get('shippingZones/inside-sirajganj').fee, 70);
  assert.equal(db.get('shippingZones/outside-sirajganj').fee, 130);
  assert.ok(!db.get('shippingZones/outside-sirajganj').districts.includes('Sirajganj'));
  assert.equal(db.get('shippingZones/outside-sirajganj').districts.length, 63);
  assert.equal(db.get('coupons/SHOPVERSE').usedCount, 2);
  assert.ok(db.has('couponUsage/SHOPVERSE__ua') && db.has('couponUsage/SHOPVERSE__uc') && !db.has('couponUsage/SHOPVERSE__ub'));
  assert.ok(maxCalls <= 20);
});

test('migrated products display correctly through the view model', () => {
  const { db } = run(legacyDb());
  const inv = {};
  for (const k of db.keys()) if (/^inventory\/[^/]+$/.test(k)) inv[k.split('/')[1]] = db.get(k);
  const view = normalizeProduct('prod1', db.get('products/prod1'), inv, { nowMs: NOW });
  assert.equal(view.minPrice, 650);
  assert.equal(view.regularMin, 850);
  assert.equal(view.onSale, true);
  assert.equal(view.discountPct, 24);
  assert.equal(view.inStock, true);
  const out = normalizeProduct('prod2', db.get('products/prod2'), inv, { nowMs: NOW });
  assert.equal(out.stockState, 'out');
});

test('legacy products display before migration (pre-upgrade documents)', () => {
  const db = legacyDb();
  const v = normalizeProduct('prod1', db.get('products/prod1'), {}, { nowMs: NOW });
  assert.equal(v.isLegacy, true);
  assert.equal(v.minPrice, 650);
  assert.equal(v.regularMin, 850);
  assert.equal(v.image, '/gallery/argentina-home-t-shirt.webp');
  assert.equal(normalizeProduct('prod2', db.get('products/prod2'), {}, { nowMs: NOW }).stockState, 'out');
});

test('running the migration again does nothing', () => {
  const first = run(legacyDb());
  const second = planMigration({
    products: first.db.keys().filter((k) => /^products\/[^/]+$/.test(k)).map((k) => ({ id: k.split('/')[1], data: first.db.get(k) })),
    legacyOrders: [], existing: existingOf(first.db), actor, nowMs: NOW,
  });
  assert.equal(second.nothingToDo, true, JSON.stringify(second.ops.map((o) => o.path)));
});

test('only users with the right permissions can run it (order manager is refused)', () => {
  const db = legacyDb();
  const products = db.keys().filter((k) => /^products\/[^/]+$/.test(k)).map((k) => ({ id: k.split('/')[1], data: db.get(k) }));
  const plan = planMigration({ products, legacyOrders: [], existing: existingOf(db), actor, nowMs: NOW });
  const chunk = plan.ops.slice(0, 10);
  const r = commitBoth(db, { uid: 'om' }, chunk);
  assert.equal(r.strict.allowed, false);
  assert.equal(r.tolerant.allowed, false);
});

test('a fresh install gets the defaults, but not a voucher it never had', () => {
  const db = new MemDb();
  db.set('staff/sa', { role: 'super_admin', active: true });
  const { plan, db: after } = run(db);
  assert.equal(plan.nothingToDo, false, 'settings, homepage layout and shipping zones are still created');
  assert.equal(plan.report.coupon.created, false);
  assert.equal(after.has('coupons/SHOPVERSE'), false);
  assert.ok(after.has('settings/public') && after.has('settings/private') && after.has('content/home') && after.has('shippingZones/inside-sirajganj'));
  assert.equal(run(after).plan.nothingToDo, true, 'and a second run finds nothing to do');
});
