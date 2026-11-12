/* The price / stock / coupon / shipping maths the checkout shows. firestore.rules re-derives the same numbers (tests/rules/orders.rules.test.mjs),
 * so these tests pin the formulas themselves: integer taka, floors, caps, and the order the rules apply them in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMillis, isOnSale, effectivePrice, discountPercent, availableQty, maxOrderQty, stockState,
  lineEligible, couponDiscount, checkCoupon, baseShipping, zoneForDistrict, computeTotals, freeShippingGap,
} from '../../js/shared/pricing.js';

const NOW = Date.UTC(2026, 5, 1, 6, 0, 0);
const DAY = 86400000;

test('toMillis reads every timestamp shape and nothing else', () => {
  assert.equal(toMillis(null), null);
  assert.equal(toMillis(undefined), null);
  assert.equal(toMillis(''), null);
  assert.equal(toMillis(5), 5);
  assert.equal(toMillis(new Date(7)), 7);
  assert.equal(toMillis('2026-06-01T00:00:00Z'), Date.UTC(2026, 5, 1));
  assert.equal(toMillis('not a date'), null);
  assert.equal(toMillis({ toMillis: () => 9 }), 9);
  assert.equal(toMillis({ seconds: 2, nanoseconds: 5e6 }), 2005);
  assert.equal(toMillis({ ms: 11 }), 11);
  assert.equal(toMillis({}), null);
});

test('a sale applies only inside its window and only when it is really cheaper', () => {
  const inv = { price: 1000, salePrice: 800, saleStart: NOW - DAY, saleEnd: NOW + DAY };
  assert.equal(isOnSale(inv, NOW), true);
  assert.equal(effectivePrice(inv, NOW), 800);
  assert.equal(discountPercent(inv, NOW), 20);

  assert.equal(isOnSale({ ...inv, saleStart: NOW + 1 }, NOW), false, 'not started');
  assert.equal(isOnSale({ ...inv, saleEnd: NOW }, NOW), false, 'the end instant is already over');
  assert.equal(isOnSale({ ...inv, saleStart: NOW }, NOW), true, 'the start instant counts');
  assert.equal(isOnSale({ ...inv, saleStart: null, saleEnd: null }, NOW), true, 'open-ended sale');
  assert.equal(isOnSale({ ...inv, salePrice: 1000 }, NOW), false, 'equal price is not a sale');
  assert.equal(isOnSale({ ...inv, salePrice: 1200 }, NOW), false, 'higher "sale" price is not a sale');
  assert.equal(isOnSale({ ...inv, salePrice: null }, NOW), false);
  assert.equal(isOnSale(null, NOW), false);
  assert.equal(effectivePrice({ ...inv, saleEnd: NOW - 1 }, NOW), 1000);
  assert.equal(discountPercent({ price: 0, salePrice: 0 }, NOW), 0);
  assert.equal(discountPercent({ price: 999, salePrice: 666, saleStart: null, saleEnd: null }, NOW), 33, 'rounded to a whole percent');
});

test('available quantity: untracked and backorder are unlimited, reservations reduce stock, inactive is zero', () => {
  assert.equal(availableQty(null), 0);
  assert.equal(availableQty({ active: false, track: true, stock: 9 }), 0);
  assert.equal(availableQty({ track: false, stock: 0 }), Infinity);
  assert.equal(availableQty({ track: true, allowBackorder: true, stock: 0 }), Infinity);
  assert.equal(availableQty({ track: true, stock: 10, reserved: 3 }), 7);
  assert.equal(availableQty({ track: true, stock: 2, reserved: 5 }), 0, 'never negative');
});

test('the per-order limit is the smallest of the product limit, the global cap (50) and the stock', () => {
  assert.equal(maxOrderQty({ track: true, stock: 100, reserved: 0 }), 50);
  assert.equal(maxOrderQty({ track: true, stock: 100, reserved: 0, maxPerOrder: 3 }), 3);
  assert.equal(maxOrderQty({ track: true, stock: 2, reserved: 0, maxPerOrder: 10 }), 2);
  assert.equal(maxOrderQty({ track: false, maxPerOrder: 80 }), 50);
  assert.equal(maxOrderQty({ track: true, stock: 0, reserved: 0 }), 0);
});

test('stock states: unavailable, in stock, low, out, backorder', () => {
  assert.equal(stockState(null), 'unavailable');
  assert.equal(stockState({ active: false }), 'unavailable');
  assert.equal(stockState({ track: false }), 'in_stock');
  assert.equal(stockState({ track: true, stock: 50, reserved: 0 }), 'in_stock');
  assert.equal(stockState({ track: true, stock: 5, reserved: 0 }), 'low', 'default threshold is 5');
  assert.equal(stockState({ track: true, stock: 6, reserved: 0 }), 'in_stock');
  assert.equal(stockState({ track: true, stock: 8, reserved: 0, lowStockThreshold: 10 }), 'low', 'own threshold wins');
  assert.equal(stockState({ track: true, stock: 5, reserved: 5 }), 'out');
  assert.equal(stockState({ track: true, stock: 0, reserved: 0, allowBackorder: true }), 'backorder');
});

test('coupon discount: percent floors and respects the cap, fixed never exceeds the goods, free shipping is not a discount', () => {
  assert.equal(couponDiscount(null, 1000), 0);
  assert.equal(couponDiscount({ type: 'percent', value: 10 }, 999), 99, 'floor(99.9)');
  assert.equal(couponDiscount({ type: 'percent', value: 50, maxDiscount: 100 }, 1000), 100);
  assert.equal(couponDiscount({ type: 'percent', value: 5, maxDiscount: 100 }, 1000), 50, 'under the cap → untouched');
  assert.equal(couponDiscount({ type: 'percent', value: 100, maxDiscount: null }, 321), 321);
  assert.equal(couponDiscount({ type: 'fixed', value: 200 }, 1000), 200);
  assert.equal(couponDiscount({ type: 'fixed', value: 500 }, 300), 300, 'cannot make the goods negative');
  assert.equal(couponDiscount({ type: 'fixed', value: 300 }, 300), 300);
  assert.equal(couponDiscount({ type: 'free_shipping', value: 0 }, 1000), 0);
});

test('which lines a coupon covers: everything, chosen products, chosen categories, minus sale items when asked', () => {
  const line = { productId: 'p1', categoryId: 'c1', unitPrice: 90, regularPrice: 100 };
  const full = { productId: 'p2', categoryId: 'c2', unitPrice: 50, regularPrice: 50 };
  assert.equal(lineEligible(line, null), false);
  assert.equal(lineEligible(line, { appliesTo: 'all' }), true);
  assert.equal(lineEligible(line, { appliesTo: 'products', productIds: ['p1'] }), true);
  assert.equal(lineEligible(line, { appliesTo: 'products', productIds: ['p9'] }), false);
  assert.equal(lineEligible(line, { appliesTo: 'categories', categoryIds: ['c1'] }), true);
  assert.equal(lineEligible(line, { appliesTo: 'categories', categoryIds: ['c9'] }), false);
  assert.equal(lineEligible(line, { appliesTo: 'categories' }), false, 'missing list = nothing');
  assert.equal(lineEligible(line, { appliesTo: 'all', excludeSaleItems: true }), false, 'a discounted line is excluded');
  assert.equal(lineEligible(full, { appliesTo: 'all', excludeSaleItems: true }), true);
  assert.equal(lineEligible(line, { appliesTo: 'whatever' }), false, 'unknown scope covers nothing');
});

test('coupon eligibility gives one precise reason, checked in a fixed order', () => {
  const c = { active: true, minOrder: 500, usageLimit: 10, usedCount: 3, perCustomerLimit: 1, customerIds: [] };
  assert.deepEqual(checkCoupon(c, { subtotal: 600, uid: 'u', nowMs: NOW }), { ok: true });
  assert.deepEqual(checkCoupon(null, { subtotal: 600 }), { ok: false, reason: 'not_found' });
  assert.equal(checkCoupon({ ...c, active: false }, { subtotal: 600, nowMs: NOW }).reason, 'inactive');
  assert.equal(checkCoupon({ ...c, active: 'yes' }, { subtotal: 600, nowMs: NOW }).reason, 'inactive', 'only a real true counts');
  assert.equal(checkCoupon({ ...c, startsAt: NOW + 1 }, { subtotal: 600, nowMs: NOW }).reason, 'not_started');
  assert.equal(checkCoupon({ ...c, endsAt: NOW }, { subtotal: 600, nowMs: NOW }).reason, 'expired');
  assert.deepEqual(checkCoupon(c, { subtotal: 499, nowMs: NOW }), { ok: false, reason: 'min_order', min: 500 });
  assert.equal(checkCoupon({ ...c, customerIds: ['other'] }, { subtotal: 600, uid: 'u', nowMs: NOW }).reason, 'customer_only');
  assert.equal(checkCoupon({ ...c, customerIds: ['u'] }, { subtotal: 600, uid: 'u', nowMs: NOW }).ok, true);
  assert.equal(checkCoupon({ ...c, usedCount: 10 }, { subtotal: 600, nowMs: NOW }).reason, 'usage_limit');
  assert.equal(checkCoupon(c, { subtotal: 600, nowMs: NOW, usedByUser: 1 }).reason, 'per_customer_limit');
  assert.equal(checkCoupon({ ...c, usageLimit: null, perCustomerLimit: null, usedCount: 999 }, { subtotal: 600, nowMs: NOW, usedByUser: 99 }).ok, true, 'null = unlimited');
});

test('shipping: the zone fee, free from the threshold, nothing without a zone; zones match by district and skip inactive ones', () => {
  assert.equal(baseShipping(null, 1000), 0);
  assert.equal(baseShipping({ fee: 120, freeOver: null }, 100000), 120);
  assert.equal(baseShipping({ fee: 120, freeOver: 2000 }, 1999), 120);
  assert.equal(baseShipping({ fee: 120, freeOver: 2000 }, 2000), 0, 'the threshold itself is free');
  assert.equal(freeShippingGap(null, 5), null);
  assert.equal(freeShippingGap({ freeOver: null }, 5), null);
  assert.equal(freeShippingGap({ freeOver: 2000 }, 1500), 500);
  assert.equal(freeShippingGap({ freeOver: 2000 }, 2500), 0);

  const zones = [
    { id: 'a', districts: ['Dhaka'], active: false },
    { id: 'b', districts: ['Dhaka', 'Gazipur'], active: true },
    { id: 'c', districts: ['Sirajganj'] },
  ];
  assert.equal(zoneForDistrict(zones, 'Dhaka').id, 'b', 'an inactive zone is skipped');
  assert.equal(zoneForDistrict(zones, 'Sirajganj').id, 'c', 'active defaults to on');
  assert.equal(zoneForDistrict(zones, 'Bandarban'), null);
  assert.equal(zoneForDistrict(null, 'Dhaka'), null);
});

const L = (productId, unitPrice, qty, extra = {}) => ({ productId, categoryId: 'c1', unitPrice, regularPrice: extra.regularPrice ?? unitPrice, qty });
const ZONE = { fee: 100, freeOver: 3000 };

test('totals without a coupon: lines add up, shipping follows the goods total', () => {
  const r = computeTotals({ lines: [L('p1', 250, 2), L('p2', 100, 1)], zone: ZONE, nowMs: NOW });
  assert.deepEqual(r.totals, { subtotal: 600, eligibleSubtotal: 0, discount: 0, shipping: 100, tax: 0, total: 700 });
  assert.deepEqual(r.lines.map((l) => l.lineTotal), [500, 100]);
  assert.deepEqual(r.coupon, { ok: false, reason: 'none' });
  assert.equal(r.appliedCoupon, null);
  const big = computeTotals({ lines: [L('p1', 3000, 1)], zone: ZONE, nowMs: NOW });
  assert.equal(big.totals.shipping, 0);
  assert.equal(big.totals.total, 3000);
});

test('totals with a percent coupon: only eligible lines are discounted, and free shipping is judged after the discount', () => {
  const coupon = { code: 'TEN', active: true, type: 'percent', value: 10, appliesTo: 'products', productIds: ['p1'], minOrder: 0, excludeSaleItems: false };
  const r = computeTotals({ lines: [L('p1', 1000, 2), L('p2', 1000, 1)], coupon, zone: ZONE, nowMs: NOW, uid: 'u' });
  assert.deepEqual(r.totals, { subtotal: 3000, eligibleSubtotal: 2000, discount: 200, shipping: 100, tax: 0, total: 2900 });
  assert.equal(r.coupon.ok, true);
  assert.equal(r.appliedCoupon, coupon);
  assert.equal(r.totals.total, r.totals.subtotal - r.totals.discount + r.totals.shipping);
});

test('totals with a free-shipping coupon: no discount, no shipping fee', () => {
  const coupon = { code: 'SHIP', active: true, type: 'free_shipping', value: 0, appliesTo: 'all', minOrder: 0 };
  const r = computeTotals({ lines: [L('p1', 400, 1)], coupon, zone: ZONE, nowMs: NOW });
  assert.deepEqual(r.totals, { subtotal: 400, eligibleSubtotal: 400, discount: 0, shipping: 0, tax: 0, total: 400 });
});

test('a coupon that cannot be used leaves the totals untouched and says why', () => {
  const base = { code: 'X', active: true, type: 'fixed', value: 50, appliesTo: 'products', productIds: ['zzz'], minOrder: 0 };
  const none = computeTotals({ lines: [L('p1', 400, 1)], coupon: base, zone: ZONE, nowMs: NOW });
  assert.equal(none.coupon.reason, 'no_eligible_items');
  assert.equal(none.totals.discount, 0);
  assert.equal(none.appliedCoupon, null);

  const expired = computeTotals({ lines: [L('p1', 400, 1)], coupon: { ...base, appliesTo: 'all', endsAt: NOW - 1 }, zone: ZONE, nowMs: NOW });
  assert.equal(expired.coupon.reason, 'expired');
  assert.equal(expired.totals.total, 500);
});

test('a fixed coupon larger than the eligible goods never produces a negative total', () => {
  const coupon = { code: 'BIG', active: true, type: 'fixed', value: 9999, appliesTo: 'all', minOrder: 0 };
  const r = computeTotals({ lines: [L('p1', 300, 1)], coupon, zone: { fee: 0, freeOver: null }, nowMs: NOW });
  assert.equal(r.totals.discount, 300);
  assert.equal(r.totals.total, 0);
});
