/*
 * Coupons (js/shared/couponFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * Super Admin and Store Admin change coupons in one batch with an audit entry; every other role and every customer is refused by the
 * RULES themselves; and — the point of the exercise — an order that uses a coupon the planner wrote is accepted by the ORDER rule
 * (the shape the planner stores is the shape the rules re-derive the discount from).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCouponForm, planCouponSave, planCouponActive, planCouponRemove, couponStatus, describeOffer, normalizeCode, COUPON_LIMITS,
} from '../../js/shared/couponFlow.js';
import { buildOrder } from '../../js/shared/orderBuilder.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { baseDb, commitBoth, failedOps, NOW, DAY } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const catalog = { productIds: new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']), categoryIds: new Set(['c1', 'c2', 'c3']) };

const good = {
  code: ' eid-2026 ', type: 'percent', value: '15', maxDiscount: '300', minOrder: '500', appliesTo: 'all', startsAt: null, endsAt: null,
  usageLimit: '50', perCustomerLimit: '1', description: ' Eid   offer ', excludeSaleItems: false, active: true,
};
const make = (over = {}, who = 'sa', extra = {}) => planCouponSave({ creating: true, form: { ...good, ...over }, current: null, catalog, actor: actor(who), nowMs: NOW, ...extra });

function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}

/** an order by `uid` that uses the stored coupon `code` (the same builder the storefront runs) */
function orderWith(db, code, o = {}) {
  const uid = o.uid || 'u1';
  const lines = (o.lines || [{ key: 'p1', qty: 1 }]).map((l) => ({ key: l.key, qty: l.qty, inv: db.get(`inventory/${l.key}`), name: `Item ${l.key}`, image: '' }));
  return buildOrder({
    uid, orderNumber: o.orderNumber || 'SV-261026-AAAAAA', nowMs: o.now ?? NOW,
    customer: { name: 'Rahim Uddin', phone: '01712345678', email: 'rahim@example.com' },
    address: { name: 'Rahim Uddin', phone: '01712345678', district: 'Sirajganj', upazila: 'Sadar', area: '', postalCode: '6700', line1: 'House 1, Road 2, Town', notes: '' },
    zone: { id: 'in', ...db.get('shippingZones/in') }, lines, coupon: { ...db.get(`coupons/${code}`), code }, couponUsageCount: o.usage ?? null,
    payment: { method: 'cod' }, note: '',
  });
}

test('validate: a good form is normalised — code upper-cased, numbers parsed, spaces collapsed', () => {
  const v = validateCouponForm(good, { creating: true, catalog, nowMs: NOW });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.code, 'EID-2026');
  assert.deepEqual(v.values, {
    type: 'percent', value: 15, maxDiscount: 300, minOrder: 500, appliesTo: 'all', productIds: [], categoryIds: [], excludeSaleItems: false,
    startsAt: null, endsAt: null, usageLimit: 50, perCustomerLimit: 1, customerIds: [], active: true, description: 'Eid offer',
  });
  assert.equal(normalizeCode('  a-b  '), 'A-B');
});

test('validate: free shipping ignores value and cap, a fixed coupon has no cap, empty min order means 0', () => {
  const free = validateCouponForm({ ...good, type: 'free_shipping', value: 99, maxDiscount: 10, minOrder: '' }, { creating: true });
  assert.deepEqual([free.values.value, free.values.maxDiscount, free.values.minOrder], [0, null, 0]);
  const fixed = validateCouponForm({ ...good, type: 'fixed', value: 100, maxDiscount: 50 }, { creating: true });
  assert.deepEqual([fixed.values.value, fixed.values.maxDiscount], [100, null]);
});

test('validate: every field is bounded and says which rule it broke', () => {
  const bad = (patch, field, code, opts = { creating: true, catalog, nowMs: NOW }) => {
    const v = validateCouponForm({ ...good, ...patch }, opts);
    assert.equal(v.ok, false, JSON.stringify(patch));
    assert.equal(v.errors[field], code, JSON.stringify(patch));
  };
  bad({ code: '' }, 'code', 'required');
  for (const code of ['ab', 'a b c', 'x'.repeat(25), 'ÀBC', 'A_B', 'A/B']) bad({ code }, 'code', 'bad_code');
  bad({ type: 'bogus' }, 'type', 'bad_type');
  bad({ value: '' }, 'value', 'required');
  for (const value of [0, 101, 12.5, 'x', -3]) bad({ value }, 'value', 'bad_percent');
  for (const value of [0, 1000001, 2.5]) bad({ type: 'fixed', value }, 'value', 'bad_amount');
  for (const maxDiscount of [0, 1000001, 'x']) bad({ maxDiscount }, 'maxDiscount', 'bad_amount');
  for (const minOrder of [-1, 10000001, 1.5, 'x']) bad({ minOrder }, 'minOrder', 'bad_amount');
  bad({ appliesTo: 'bogus' }, 'appliesTo', 'bad_scope');
  bad({ appliesTo: 'products', productIds: [] }, 'productIds', 'none');
  bad({ appliesTo: 'categories', categoryIds: [] }, 'categoryIds', 'none');
  bad({ appliesTo: 'products', productIds: ['p1', 'nope'] }, 'productIds', 'unknown');
  bad({ appliesTo: 'categories', categoryIds: ['c1', 'nope'] }, 'categoryIds', 'unknown');
  bad({ appliesTo: 'products', productIds: Array.from({ length: COUPON_LIMITS.productsMax + 1 }, (_, i) => `p${i}`) }, 'productIds', 'too_many', { creating: true, nowMs: NOW });
  bad({ startsAt: 'x' }, 'startsAt', 'bad_date');
  bad({ endsAt: NOW + DAY, startsAt: NOW + 2 * DAY }, 'endsAt', 'end_before_start');
  bad({ endsAt: NOW }, 'endsAt', 'end_past');
  for (const usageLimit of [0, 1.5, 1000001, 'x']) bad({ usageLimit }, 'usageLimit', 'bad_limit');
  for (const perCustomerLimit of [0, 1001, 'x']) bad({ perCustomerLimit }, 'perCustomerLimit', 'bad_limit');
  bad({ customerIds: Array.from({ length: COUPON_LIMITS.customersMax + 1 }, (_, i) => `u${i}`) }, 'customerIds', 'too_many');
  bad({ customerIds: ['bad id!'] }, 'customerIds', 'bad_customer');
  bad({ description: 'x'.repeat(201) }, 'description', 'too_long');
});

test('validate: the limits themselves are allowed; an old coupon may be edited to end in the past; the limit cannot drop below the uses so far', () => {
  for (const patch of [{ value: 1 }, { value: 100 }, { maxDiscount: 1 }, { minOrder: 0 }, { usageLimit: 1 }, { perCustomerLimit: 1000 }, { description: 'x'.repeat(200) }, { endsAt: NOW + DAY, startsAt: NOW }]) {
    assert.equal(validateCouponForm({ ...good, ...patch }, { creating: true, catalog, nowMs: NOW }).ok, true, JSON.stringify(patch));
  }
  const stored = { id: 'OLD1', code: 'OLD1', usedCount: 5, active: true };
  assert.equal(validateCouponForm({ ...good, endsAt: NOW - DAY }, { current: stored, catalog, nowMs: NOW }).ok, true, 'ending in the past is fine when editing');
  assert.equal(validateCouponForm({ ...good, usageLimit: 4 }, { current: stored, catalog, nowMs: NOW }).errors.usageLimit, 'limit_below_used');
  assert.equal(validateCouponForm({ ...good, usageLimit: 5 }, { current: stored, catalog, nowMs: NOW }).ok, true);
});

test('create: exactly the documented fields, usedCount starts at 0, one audit entry, Super Admin and Store Admin allowed', () => {
  const db = baseDb();
  const p = make();
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual([p.code, p.action, p.ops.length], ['EID-2026', 'coupon.create', 2]);
  assert.deepEqual(Object.keys(p.ops[0].data).sort(), [
    'active', 'appliesTo', 'categoryIds', 'code', 'createdAt', 'customerIds', 'description', 'endsAt', 'excludeSaleItems', 'maxDiscount', 'minOrder',
    'perCustomerLimit', 'productIds', 'startsAt', 'type', 'updatedAt', 'usageLimit', 'usedCount', 'value',
  ]);
  for (const uid of ['sa', 'sadm']) {
    const ops = [p.ops[0], auditOp(actor(uid), { action: 'coupon.create', entity: 'coupon', entityId: p.code, summary: 'x' })];
    const after = commit(db, uid, ops, uid);
    const c = after.get('coupons/EID-2026');
    assert.deepEqual([c.code, c.type, c.value, c.maxDiscount, c.minOrder, c.usageLimit, c.perCustomerLimit, c.usedCount, c.active, c.description], ['EID-2026', 'percent', 15, 300, 500, 50, 1, 0, true, 'Eid offer']);
  }
  const done = commit(db, 'sa', p.ops, 'create');
  assert.deepEqual(audits(done).map((a) => [a.action, a.entity, a.entityId, a.actorRole]), [['coupon.create', 'coupon', 'EID-2026', 'super_admin']]);
});

test('who may write coupons: only Super Admin and Store Admin — everyone else is refused by the RULES themselves', () => {
  const db = baseDb();
  const p = make();
  for (const uid of ['pm', 'om', 'im', 'cs', 'rp']) {
    const r = commitBoth(db, { uid }, [p.ops[0], auditOp(actor(uid), { action: 'coupon.create', entity: 'coupon', entityId: p.code, summary: 'forged' })]);
    for (const [engine, res] of [['strict', r.strict], ['tolerant', r.tolerant]]) {
      assert.equal(res.allowed, false, `${uid} ${engine}`);
      assert.ok(failedOps(res).some((s) => s.includes('coupons/')), `${uid} ${engine}: the coupon write itself must be what is refused — ${failedOps(res).join(' | ')}`);
    }
    assert.equal(make({}, uid).error, 'forbidden', `${uid}: the planner refuses too`);
  }
  assert.equal(commitBoth(db, { uid: 'u1' }, [p.ops[0]]).strict.allowed, false, 'a customer');
  assert.equal(commitBoth(db, { uid: 'u1' }, [p.ops[0]]).tolerant.allowed, false, 'a customer (tolerant)');
});

test('create: a code that already exists is refused (it would overwrite the usage count)', () => {
  const db = baseDb();
  const r = planCouponSave({ creating: true, form: { ...good, code: 'welcome10' }, current: { id: 'WELCOME10', ...db.get('coupons/WELCOME10') }, catalog, actor: actor('sa'), nowMs: NOW });
  assert.deepEqual([r.ok, r.error, r.errors], [false, 'exists', { code: 'exists' }]);
});

/* every kind of coupon the planner can write must be accepted at checkout by the order rule */
const KINDS = [
  ['percent with a cap', { code: 'PCT15', type: 'percent', value: 15, maxDiscount: 100, minOrder: 500 }, {}],
  ['percent without a cap', { code: 'PCT20', type: 'percent', value: 20, maxDiscount: '', minOrder: '' }, {}],
  ['fixed amount', { code: 'FIX100', type: 'fixed', value: 100, maxDiscount: null }, {}],
  ['free shipping', { code: 'SHIP0', type: 'free_shipping', value: '' }, { free: true }],
  ['limited to a category', { code: 'CATC2', type: 'percent', value: 10, appliesTo: 'categories', categoryIds: ['c2'] }, { lines: [{ key: 'p1', qty: 1 }, { key: 'p4', qty: 2 }] }],
  ['limited to a product', { code: 'PRODP1', type: 'fixed', value: 50, appliesTo: 'products', productIds: ['p1'] }, { lines: [{ key: 'p1', qty: 1 }, { key: 'p4', qty: 1 }] }],
  ['excluding sale items', { code: 'NOSALE2', type: 'percent', value: 10, excludeSaleItems: true }, { lines: [{ key: 'p1', qty: 1 }, { key: 'p2', qty: 1 }] }],
  ['only for one customer', { code: 'ONLYU1', customerIds: ['u1'] }, {}],
  ['inside a date window', { code: 'WINDOW', startsAt: NOW - DAY, endsAt: NOW + DAY }, {}],
];
for (const [name, over, how] of KINDS) {
  test(`checkout accepts what the planner stores: ${name}`, () => {
    let db = baseDb();
    const p = make(over);
    assert.equal(p.ok, true, JSON.stringify(p));
    db = commit(db, 'sa', p.ops, 'create');
    const b = orderWith(db, p.code, { lines: how.lines });
    if (how.free) assert.equal(b.totals.shipping, 0, 'free shipping really is free');
    else assert.ok(b.totals.discount > 0, 'the coupon gives a discount');
    const r = commitBoth(db, { uid: 'u1' }, b.ops);
    assert.equal(r.strict.allowed, true, `strict: ${failedOps(r.strict).join(' | ')}`);
    assert.equal(r.tolerant.allowed, true, `tolerant: ${failedOps(r.tolerant).join(' | ')}`);
    assert.equal(r.strict.dbAfter.get(`coupons/${p.code}`).usedCount, 1, 'checkout counted the use');
  });
}

test('checkout refuses what the coupon forbids: another customer, a usage limit already reached, a window that has not begun', () => {
  let db = baseDb();
  db = commit(db, 'sa', make({ code: 'ONLYU1', customerIds: ['u1'] }).ops, 'private');
  assert.throws(() => orderWith(db, 'ONLYU1', { uid: 'u2' }), /Coupon cannot be applied/);
  db = commit(db, 'sa', make({ code: 'ONCE', usageLimit: 1 }).ops, 'once');
  const first = orderWith(db, 'ONCE');
  db = commit(db, 'u1', first.ops, 'first order');
  assert.throws(() => orderWith(db, 'ONCE', { uid: 'u2', orderNumber: 'SV-261026-BBBBBB' }), /Coupon cannot be applied/);
  db = commit(db, 'sa', make({ code: 'SOON', startsAt: NOW + DAY, endsAt: NOW + 2 * DAY }).ops, 'later');
  assert.throws(() => orderWith(db, 'SOON'), /Coupon cannot be applied/);
});

test('edit: usedCount, lastOrderId, createdAt and the code are never touched; the audit entry says what changed; no_change; limit below uses', () => {
  let db = baseDb();
  db = commit(db, 'sa', make({ code: 'EDIT1' }).ops, 'create');
  db = commit(db, 'u1', orderWith(db, 'EDIT1').ops, 'one use');
  const stored = { id: 'EDIT1', ...db.get('coupons/EDIT1') };
  assert.equal(stored.usedCount, 1);
  const form = { type: 'percent', value: 20, maxDiscount: 300, minOrder: 500, appliesTo: 'all', usageLimit: 80, perCustomerLimit: 1, description: 'Eid offer', active: true };
  const p = planCouponSave({ form, current: stored, catalog, actor: actor('sadm'), nowMs: NOW });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.action, 'coupon.update');
  assert.deepEqual(Object.keys(p.ops[0].data).sort(), [
    'active', 'appliesTo', 'categoryIds', 'customerIds', 'description', 'endsAt', 'excludeSaleItems', 'maxDiscount', 'minOrder', 'perCustomerLimit',
    'productIds', 'startsAt', 'type', 'updatedAt', 'usageLimit', 'value',
  ]);
  db = commit(db, 'sadm', p.ops, 'edit');
  const c = db.get('coupons/EDIT1');
  assert.deepEqual([c.value, c.usageLimit, c.usedCount, c.code, c.lastOrderId], [20, 80, 1, 'EDIT1', 'SV-261026-AAAAAA']);
  const a = audits(db).find((x) => x.action === 'coupon.update');
  assert.match(a.summary, /offer 15% off, max 300 → 20% off, max 300/);
  assert.match(a.summary, /usage limit 50 → 80/);

  const again = planCouponSave({ form, current: { id: 'EDIT1', ...db.get('coupons/EDIT1') }, catalog, actor: actor('sa'), nowMs: NOW });
  assert.equal(again.error, 'no_change');
  const used3 = { ...stored, usedCount: 3 };
  assert.equal(planCouponSave({ form: { ...form, usageLimit: 2 }, current: used3, catalog, actor: actor('sa'), nowMs: NOW }).errors.usageLimit, 'limit_below_used');
  assert.equal(planCouponSave({ form, current: null, catalog, actor: actor('sa') }).error, 'not_found');
});

test('edit: switching the scope or the dates is described in the audit entry', () => {
  let db = baseDb();
  db = commit(db, 'sa', make({ code: 'SCOPE1' }).ops, 'create');
  const stored = { id: 'SCOPE1', ...db.get('coupons/SCOPE1') };
  const p = planCouponSave({
    form: { type: 'percent', value: 15, maxDiscount: 300, minOrder: 500, appliesTo: 'categories', categoryIds: ['c2'], startsAt: NOW + DAY, endsAt: NOW + 5 * DAY, usageLimit: 50, perCustomerLimit: 1, description: 'Eid offer', active: true, excludeSaleItems: true },
    current: stored, catalog, actor: actor('sa'), nowMs: NOW,
  });
  assert.equal(p.ok, true, JSON.stringify(p));
  db = commit(db, 'sa', p.ops, 'edit');
  const s = audits(db).find((x) => x.action === 'coupon.update').summary;
  assert.match(s, /applies to all → categories/);
  assert.match(s, /sale items excluded/);
  assert.match(s, /starts none → /);
  assert.match(s, /ends none → /);
  const c = db.get('coupons/SCOPE1');
  assert.deepEqual([c.appliesTo, c.categoryIds, c.excludeSaleItems, c.startsAt.toMillis(), c.endsAt.toMillis()], ['categories', ['c2'], true, NOW + DAY, NOW + 5 * DAY]);
});

test('switch off / on: one update + one audit entry; no_change; other roles are refused by the rules', () => {
  let db = baseDb();
  const stored = () => ({ id: 'WELCOME10', ...db.get('coupons/WELCOME10') });
  const off = planCouponActive({ code: 'WELCOME10', active: false, current: stored(), actor: actor('sadm') });
  assert.equal(off.action, 'coupon.deactivate');
  assert.deepEqual(Object.keys(off.ops[0].data).sort(), ['active', 'updatedAt']);
  const forged = commitBoth(db, { uid: 'om' }, [off.ops[0], auditOp(actor('om'), { action: 'coupon.deactivate', entity: 'coupon', entityId: 'WELCOME10', summary: 'forged' })]);
  assert.equal(forged.strict.allowed, false);
  assert.equal(forged.tolerant.allowed, false);
  db = commit(db, 'sadm', off.ops, 'off');
  assert.equal(db.get('coupons/WELCOME10').active, false);
  assert.equal(planCouponActive({ code: 'WELCOME10', active: false, current: stored(), actor: actor('sa') }).error, 'no_change');
  const on = planCouponActive({ code: 'WELCOME10', active: true, current: stored(), actor: actor('sa') });
  db = commit(db, 'sa', on.ops, 'on');
  assert.equal(db.get('coupons/WELCOME10').active, true);
  assert.deepEqual(audits(db).map((a) => a.action).sort(), ['coupon.activate', 'coupon.deactivate']);
  assert.equal(planCouponActive({ code: 'X', active: true, current: null, actor: actor('sa') }).error, 'not_found');
  assert.equal(planCouponActive({ code: 'WELCOME10', active: false, current: stored(), actor: actor('om') }).error, 'forbidden');
});

test('delete: only a coupon that was never used; the audit entry stays; other roles are refused by the rules', () => {
  let db = baseDb();
  db = commit(db, 'sa', make({ code: 'GONE1' }).ops, 'create');
  const stored = () => ({ id: 'GONE1', ...db.get('coupons/GONE1') });
  const p = planCouponRemove({ code: 'GONE1', current: stored(), actor: actor('sadm') });
  assert.equal(p.ok, true);
  assert.equal(planCouponRemove({ code: 'GONE1', current: stored(), actor: actor('om') }).error, 'forbidden');
  const forged = commitBoth(db, { uid: 'pm' }, [p.ops[0], auditOp(actor('pm'), { action: 'coupon.delete', entity: 'coupon', entityId: 'GONE1', summary: 'forged' })]);
  assert.equal(forged.strict.allowed, false);
  assert.equal(forged.tolerant.allowed, false);

  const used = commit(db, 'u1', orderWith(db, 'GONE1').ops, 'used once');
  assert.equal(planCouponRemove({ code: 'GONE1', current: { id: 'GONE1', ...used.get('coupons/GONE1') }, actor: actor('sa') }).error, 'used');

  db = commit(db, 'sadm', p.ops, 'delete');
  assert.ok(!db.get('coupons/GONE1'));
  assert.ok(db.get('coupons/WELCOME10'));
  assert.ok(audits(db).some((a) => a.action === 'coupon.delete' && a.entityId === 'GONE1' && a.after === null));
});

test('status: disabled beats everything, then expired, then scheduled, then exhausted', () => {
  const live = { active: true, usedCount: 0, usageLimit: 10, startsAt: null, endsAt: null };
  assert.equal(couponStatus(live, NOW), 'live');
  assert.equal(couponStatus({ ...live, active: false, endsAt: NOW - DAY }, NOW), 'disabled');
  assert.equal(couponStatus({ ...live, endsAt: NOW - 1, usedCount: 10 }, NOW), 'expired');
  assert.equal(couponStatus({ ...live, endsAt: NOW }, NOW), 'expired', 'the end instant itself is already over');
  assert.equal(couponStatus({ ...live, startsAt: NOW + 1 }, NOW), 'scheduled');
  assert.equal(couponStatus({ ...live, startsAt: NOW }, NOW), 'live', 'the start instant itself is already open');
  assert.equal(couponStatus({ ...live, usedCount: 10 }, NOW), 'exhausted');
  assert.equal(couponStatus({ ...live, usageLimit: null, usedCount: 999 }, NOW), 'live');
  assert.equal(couponStatus(null, NOW), 'disabled');
});

test('describeOffer reads like the offer', () => {
  assert.equal(describeOffer({ type: 'percent', value: 10, maxDiscount: 200 }), '10% off, max 200');
  assert.equal(describeOffer({ type: 'percent', value: 10, maxDiscount: null }), '10% off');
  assert.equal(describeOffer({ type: 'fixed', value: 100 }), '100 off');
  assert.equal(describeOffer({ type: 'free_shipping', value: 0 }), 'free shipping');
});
