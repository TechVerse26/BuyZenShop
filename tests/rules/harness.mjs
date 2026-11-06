/*
 * Test harness around the rules interpreter: fixtures + conversion of abstract ops
 * (js/shared/ops.js) into rules-engine batch writes.
 */
import fs from 'node:fs';
import { RulesEngine, MemDb, Ts, FieldValue } from './rules-engine.mjs';
import { isSentinel } from '../../js/shared/ops.js';

export const RULES_TEXT = fs.readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
export const strictEngine = new RulesEngine(RULES_TEXT);
export const tolerantEngine = new RulesEngine(RULES_TEXT, { tolerant: true });

export const NOW = Date.UTC(2026, 9, 26, 5, 0, 0); // 26 Oct 2026, 11:00 Dhaka
export const DAY = 86400000;

function convert(v) {
  if (isSentinel(v)) {
    if (v.$op === 'ts') return FieldValue.serverTimestamp();
    if (v.$op === 'inc') return FieldValue.increment(v.n);
    if (v.$op === 'del') return FieldValue.deleteField();
  }
  if (v instanceof Date) return new Ts(v.getTime());
  if (Array.isArray(v)) return v.map(convert);
  if (v && typeof v === 'object' && !(v instanceof Ts)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = convert(x);
    return o;
  }
  return v;
}

export function toWrites(ops) {
  return ops.map((o) => ({ op: o.op, key: o.path, data: o.data === undefined ? undefined : convert(o.data), merge: !!o.merge }));
}

/** Evaluate ops as one atomic batch with BOTH engines. Returns {strict, tolerant}. */
export function commitBoth(db, auth, ops, now = NOW) {
  const writes = toWrites(ops);
  return {
    strict: strictEngine.evaluateBatch({ db, auth, now, writes }),
    tolerant: tolerantEngine.evaluateBatch({ db, auth, now, writes }),
  };
}

export const failedOps = (r) => r.results.filter((x) => !x.allowed).map((x) => `${x.op} ${x.key}: ${x.error || 'denied'}`);

/* ───────────────────────── fixtures ───────────────────────── */

const ts = (ms) => new Ts(ms);

export function inventoryDoc(over = {}) {
  return {
    productId: 'p1', variantId: null, categoryId: 'c1', sku: 'SKU-1',
    price: 1000, salePrice: null, saleStart: null, saleEnd: null,
    stock: 10, reserved: 0, track: true, allowBackorder: false, maxPerOrder: 5, active: true,
    ...over,
  };
}

export function baseDb(now = NOW) {
  const db = new MemDb();
  const set = (k, v) => db.set(k, v);

  // staff
  set('staff/sa', { role: 'super_admin', active: true, email: 'sa@x.test' });
  set('staff/sadm', { role: 'store_admin', active: true });
  set('staff/pm', { role: 'product_manager', active: true });
  set('staff/om', { role: 'order_manager', active: true });
  set('staff/im', { role: 'inventory_manager', active: true });
  set('staff/cs', { role: 'customer_support', active: true });
  set('staff/rp', { role: 'reporting', active: true });
  set('staff/off', { role: 'store_admin', active: false });

  // customers
  set('users/u1', { displayName: 'Rahim', email: 'rahim@example.com', createdAt: ts(now - 30 * DAY) });
  set('users/u2', { displayName: 'Karim', email: 'karim@example.com', createdAt: ts(now - 30 * DAY) });
  set('users/ur', { displayName: 'Restricted', createdAt: ts(now - 30 * DAY), restricted: true });
  set('users/uc', { displayName: 'Cooling', createdAt: ts(now - 30 * DAY), lastOrderAt: ts(now - 5000) });

  // shipping
  set('shippingZones/in', { name: 'Inside Sirajganj', districts: ['Sirajganj'], fee: 70, freeOver: null, active: true });
  set('shippingZones/out', { name: 'Outside Sirajganj', districts: ['Dhaka', 'Bogura', 'Chattogram'], fee: 130, freeOver: 5000, active: true });
  set('shippingZones/off', { name: 'Closed zone', districts: ['Sylhet'], fee: 200, freeOver: null, active: false });

  // catalog: public product docs + inventory
  set('products/p1', { name: 'Test Shirt', slug: 'test-shirt', status: 'published', type: 'simple', price: 1000, salePrice: null });
  set('products/pd', { name: 'Draft', slug: 'draft', status: 'draft', type: 'simple', price: 500 });
  set('inventory/p1', inventoryDoc());
  set('inventory/p2', inventoryDoc({ productId: 'p2', categoryId: 'c2', sku: 'SKU-2', price: 2000, salePrice: 1500, stock: 3 }));
  set('inventory/p3__v1', inventoryDoc({ productId: 'p3', variantId: 'v1', categoryId: 'c1', sku: 'SKU-3', price: 800, stock: 20 }));
  set('inventory/p4', inventoryDoc({ productId: 'p4', categoryId: 'c2', sku: 'SKU-4', price: 300, track: false, stock: 0 }));
  set('inventory/p5', inventoryDoc({ productId: 'p5', categoryId: 'c3', sku: 'SKU-5', price: 450, stock: 50 }));
  set('inventory/p6', inventoryDoc({ productId: 'p6', categoryId: 'c3', sku: 'SKU-6', price: 450, stock: 1, allowBackorder: true }));
  set('inventory/pinactive', inventoryDoc({ productId: 'pinactive', sku: 'X', active: false }));

  // coupons
  const coupon = (code, over = {}) => ({
    code, type: 'percent', value: 10, maxDiscount: 200, minOrder: 500, appliesTo: 'all', productIds: [], categoryIds: [],
    excludeSaleItems: false, startsAt: null, endsAt: null, usageLimit: 100, usedCount: 0, perCustomerLimit: 1, customerIds: [], active: true, ...over,
  });
  set('coupons/WELCOME10', coupon('WELCOME10'));
  set('coupons/SHIPFREE', coupon('SHIPFREE', { type: 'free_shipping', value: 0, maxDiscount: null }));
  set('coupons/CAT2', coupon('CAT2', { appliesTo: 'categories', categoryIds: ['c2'], value: 20, maxDiscount: null }));
  set('coupons/FIXED100', coupon('FIXED100', { type: 'fixed', value: 100, maxDiscount: null, perCustomerLimit: null }));
  set('coupons/OLD', coupon('OLD', { endsAt: ts(now - DAY) }));
  set('coupons/FUTURE', coupon('FUTURE', { startsAt: ts(now + DAY) }));
  set('coupons/OFF', coupon('OFF', { active: false }));
  set('coupons/VIP', coupon('VIP', { customerIds: ['u2'] }));
  set('coupons/USED', coupon('USED', { usageLimit: 1, usedCount: 1 }));
  set('coupons/NOSALE', coupon('NOSALE', { excludeSaleItems: true }));
  return db;
}

export const asCustomer = (uid = 'u1') => ({ uid });
export const asStaff = (uid) => ({ uid });

/** Convenience: inventory docs as the order builder expects them. */
export function invOf(db, key) { return db.get(`inventory/${key}`); }
