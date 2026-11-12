/*
 * Order placement / cancellation / staff lifecycle against the REAL firestore.rules text,
 * evaluated by the rules interpreter (tests/rules/rules-engine.mjs) in two error modes:
 *   strict   – any evaluation error denies (legitimate requests must pass here)
 *   tolerant – `true || error` is true like production (forged requests must still be denied here)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrder } from '../../js/shared/orderBuilder.js';
import { planCustomerCancel, planStatusChange, planPaymentAction, planCustomerReturn, planRefund } from '../../js/shared/orderFlow.js';
import { normalizeOrder } from '../../js/shared/orderModel.js';
import { TS } from '../../js/shared/ops.js';
import { baseDb, commitBoth, failedOps, NOW, DAY, strictEngine, toWrites } from './harness.mjs';

const clone = (v) => structuredClone(v);

function mk(db, o = {}) {
  const uid = o.uid || 'u1';
  const lines = (o.lines || [{ key: 'p1', qty: 1 }]).map((l) => ({ key: l.key, qty: l.qty, inv: db.get(`inventory/${l.key}`), name: `Item ${l.key}`, image: '' }));
  const zoneId = o.zone || 'in';
  const zone = { id: zoneId, ...db.get(`shippingZones/${zoneId}`) };
  const district = o.district || zone.districts[0];
  const coupon = o.coupon ? { ...db.get(`coupons/${o.coupon}`), code: o.coupon } : null;
  return buildOrder({
    uid, orderNumber: o.orderNumber || 'SV-261026-AAAAAA', nowMs: o.now ?? NOW,
    customer: { name: 'Rahim Uddin', phone: '01712345678', email: 'rahim@example.com' },
    address: { name: 'Rahim Uddin', phone: '01712345678', district, upazila: 'Sadar', area: '', postalCode: '6700', line1: 'House 1, Road 2, Town', notes: '' },
    zone, lines, coupon, couponUsageCount: o.usage ?? null,
    payment: o.payment || { method: 'cod' }, note: 'please call',
  });
}

const orderOp = (ops) => ops.find((o) => o.path.startsWith('orders/'));

function expectOk(db, uid, ops, label = '') {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r;
}
function expectDenied(db, uid, ops, label = '') {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine allowed a forged request`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant (production-like) engine allowed a forged request`);
  return r;
}

/* ───────────────────────── honest orders ───────────────────────── */

test('honest COD order, one line, inside zone → allowed', () => {
  const db = baseDb();
  const b = mk(db);
  assert.equal(b.totals.total, 1000 + 70);
  expectOk(db, 'u1', b.ops, 'cod');
});

test('honest order uses the sale price and reserves the stock', () => {
  const db = baseDb();
  const b = mk(db, { lines: [{ key: 'p2', qty: 2 }] });
  assert.equal(b.order.items.p2.unitPrice, 1500);
  const r = expectOk(db, 'u1', b.ops);
  assert.equal(r.strict.dbAfter.get('inventory/p2').reserved, 2);
  assert.equal(r.strict.dbAfter.get('users/u1').lastOrderAt.ms, NOW);
});

test('worst case: 5 lines + percent coupon + bKash → allowed and inside the call budgets', () => {
  const db = baseDb();
  const b = mk(db, {
    zone: 'out', district: 'Dhaka', coupon: 'WELCOME10',
    lines: [{ key: 'p1', qty: 1 }, { key: 'p2', qty: 1 }, { key: 'p3__v1', qty: 2 }, { key: 'p4', qty: 1 }, { key: 'p5', qty: 3 }],
    payment: { method: 'bkash', trxId: '8n7a6d5ee3', senderNumber: '01812345678' },
  });
  assert.equal(b.ops.length, 5 + 1 + 1 + 1 + 1 + 1);
  const r = expectOk(db, 'u1', b.ops, 'worst case');
  const perOp = Math.max(...r.strict.results.map((x) => x.calls));
  console.log(`      budget: max ${perOp} access calls per write, ${r.strict.totalCalls} per batch (limits 10 / 20)`);
  assert.ok(perOp <= 10);
  assert.ok(r.strict.totalCalls <= 20);
  assert.equal(b.totals.discount, 200); // 10% of 6000+ capped at 200
  assert.equal(r.strict.dbAfter.get('coupons/WELCOME10').usedCount, 1);
  assert.equal(r.strict.dbAfter.get('couponUsage/WELCOME10__u1').count, 1);
  assert.equal(r.strict.dbAfter.get('paymentTrx/8N7A6D5EE3').orderId, 'SV-261026-AAAAAA');
});

test('untracked product (made to order) is orderable and never reserves', () => {
  const db = baseDb();
  const b = mk(db, { lines: [{ key: 'p4', qty: 3 }] });
  const r = expectOk(db, 'u1', b.ops);
  assert.equal(r.strict.dbAfter.get('inventory/p4').reserved, 0);
});

test('backorder item may be reserved beyond stock', () => {
  const db = baseDb();
  const b = mk(db, { lines: [{ key: 'p6', qty: 3 }] });
  const r = expectOk(db, 'u1', b.ops);
  assert.equal(r.strict.dbAfter.get('inventory/p6').reserved, 3);
});

test('free-shipping coupon, fixed coupon, category coupon, existing usage record', () => {
  const db = baseDb();
  expectOk(db, 'u1', mk(db, { coupon: 'SHIPFREE' }).ops, 'free shipping');
  expectOk(db, 'u1', mk(db, { coupon: 'FIXED100' }).ops, 'fixed');
  const cat = mk(db, { coupon: 'CAT2', lines: [{ key: 'p1', qty: 1 }, { key: 'p4', qty: 2 }] });
  assert.equal(cat.totals.eligibleSubtotal, 600);
  assert.equal(cat.totals.discount, 120);
  expectOk(db, 'u1', cat.ops, 'category');
  db.set('couponUsage/FIXED100__u1', { code: 'FIXED100', userId: 'u1', count: 1, lastOrderId: 'SV-260101-OLDORD', updatedAt: { ms: 1, toMillis: () => 1 } });
});

test('free shipping above the zone threshold', () => {
  const db = baseDb();
  const b = mk(db, { zone: 'out', district: 'Bogura', lines: [{ key: 'p5', qty: 5 }, { key: 'p1', qty: 3 }] });
  assert.equal(b.totals.shipping, 0);
  expectOk(db, 'u1', b.ops);
});

/* ───────────────────────── forged orders ───────────────────────── */

const attack = (name, fn, setup) => test(`attack: ${name} → denied`, () => {
  const db = baseDb();
  if (setup) setup(db);
  const b = mk(db, setup?.opts);
  const ops = clone(b.ops);
  const ret = fn(ops, db, b);
  expectDenied(ret?.db || db, ret?.uid || 'u1', ret?.ops || ops, name);
});

attack('forged unit price', (ops) => { const o = orderOp(ops).data; o.items.p1.unitPrice = 1; o.items.p1.lineTotal = 1; o.totals.subtotal = 1; o.totals.total = 71; o.payment.amountDue = 71; });
attack('forged line total only', (ops) => { orderOp(ops).data.items.p1.lineTotal = 10; });
attack('forged grand total', (ops) => { orderOp(ops).data.totals.total = 100; orderOp(ops).data.payment.amountDue = 100; });
attack('free shipping without right', (ops) => { const t = orderOp(ops).data.totals; t.shipping = 0; t.total = 1000; orderOp(ops).data.payment.amountDue = 1000; });
attack('discount without coupon', (ops) => { const t = orderOp(ops).data.totals; t.discount = 500; t.eligibleSubtotal = 1000; t.total = 570; orderOp(ops).data.payment.amountDue = 570; });
attack('regular price lie (claims sale price is regular)', (ops) => { orderOp(ops).data.items.p1.regularPrice = 900; });
attack('someone else as buyer', (ops) => { orderOp(ops).data.userId = 'u2'; });
attack('order already paid', (ops) => { orderOp(ops).data.payment.status = 'paid'; });
attack('order already confirmed', (ops) => { orderOp(ops).data.status = 'confirmed'; });
attack('extra unknown field on the order', (ops) => { orderOp(ops).data.adminNote = 'free'; });
attack('client supplied createdAt', (ops) => { orderOp(ops).data.createdAt = new Date(NOW - 3 * DAY); });
attack('skip the stock reservation', (ops) => ops.splice(ops.findIndex((o) => o.path === 'inventory/p1'), 1));
attack('reserve less stock than ordered', (ops) => { ops.find((o) => o.path === 'inventory/p1').data.reserved = { $op: 'inc', n: 0 }; }, null);
attack('reserve with wrong order id', (ops) => { ops.find((o) => o.path === 'inventory/p1').data.lastOrderId = 'SV-261026-ZZZZZZ'; });
attack('price field of inventory tampered in the same batch', (ops) => { ops.find((o) => o.path === 'inventory/p1').data.price = 1; });
attack('zone that does not serve the district', (ops) => { orderOp(ops).data.address.district = 'Sylhet'; });
attack('inactive shipping zone', (ops) => { const o = orderOp(ops).data; o.zoneId = 'off'; o.zoneName = 'Closed zone'; o.address.district = 'Sylhet'; });
attack('wrong zone name', (ops) => { orderOp(ops).data.zoneName = 'Free zone'; });
attack('invalid phone', (ops) => { orderOp(ops).data.customer.phone = '12345'; });
attack('order id not in the allowed format', (ops) => { const o = ops.find((x) => x.path.startsWith('orders/')); o.path = 'orders/order_12345'; });
attack('more than five lines', (ops, db) => {
  const o = orderOp(ops).data;
  o.itemOrder = ['p1', 'p2', 'p3__v1', 'p4', 'p5', 'p6'];
  for (const k of o.itemOrder) o.items[k] = { ...(o.items[k] || o.items.p1), productId: k.split('__')[0], variantId: null, lineTotal: 0, unitPrice: 0 };
});
attack('quantity above the per-order maximum', (ops) => { const l = orderOp(ops).data.items.p1; l.qty = 6; l.lineTotal = 6000; });
attack('inactive product', (ops, db) => {
  const it = clone(orderOp(ops).data.items.p1);
  const o = orderOp(ops).data;
  delete o.items.p1; o.items.pinactive = { ...it, productId: 'pinactive' }; o.itemOrder = ['pinactive'];
  const inv = ops.find((x) => x.path === 'inventory/p1'); inv.path = 'inventory/pinactive';
});
attack('cod order with a trx id', (ops) => { orderOp(ops).data.payment.trxId = 'ABC123456'; });
attack('stock beyond availability', (ops) => { ops.find((o) => o.path === 'inventory/p1').data.reserved = { $op: 'inc', n: 11 }; const l = orderOp(ops).data.items.p1; l.qty = 11; l.lineTotal = 11000; }, null);

test('attack: ordering more than the available stock → denied', () => {
  const db = baseDb();
  db.get('inventory/p1').reserved = 8; // 2 left
  const b = mk(db, { lines: [{ key: 'p2', qty: 3 }] }); // p2 stock 3 – fine
  expectOk(db, 'u1', b.ops);
  const ops = clone(mk(db).ops); // 1 unit of p1 is fine
  const ops3 = clone(ops);
  ops3.find((o) => o.path === 'inventory/p1').data.reserved = { $op: 'inc', n: 3 };
  const o = orderOp(ops3).data; o.items.p1.qty = 3; o.items.p1.lineTotal = 3000; o.totals.subtotal = 3000; o.totals.total = 3070; o.payment.amountDue = 3070;
  expectDenied(db, 'u1', ops3, 'oversell');
});

test('attack: replaying an old order id to reserve stock again → denied', () => {
  const db = baseDb();
  const first = mk(db, { orderNumber: 'SV-261026-AAAAAA' });
  const r = expectOk(db, 'u1', first.ops);
  const after = r.strict.dbAfter;
  // later (after the cooldown) the attacker reuses the old order id in an inventory-only batch
  const replay = [{ op: 'update', path: 'inventory/p1', data: { reserved: { $op: 'inc', n: 1 }, lastOrderId: 'SV-261026-AAAAAA' } }];
  const res = commitBoth(after, { uid: 'u1' }, replay, NOW + 60000);
  assert.equal(res.strict.allowed, false);
  assert.equal(res.tolerant.allowed, false);
});

test('attack: customer edits inventory directly (price, stock, reserved without order)', () => {
  const db = baseDb();
  for (const data of [{ price: 1 }, { stock: 9999 }, { reserved: 0 }, { active: false }]) {
    const res = commitBoth(db, { uid: 'u1' }, [{ op: 'update', path: 'inventory/p1', data }]);
    assert.equal(res.strict.allowed, false, JSON.stringify(data));
    assert.equal(res.tolerant.allowed, false, JSON.stringify(data));
  }
});

/* ───────────────────────── coupons ───────────────────────── */

const couponCase = (name, code, extra = {}) => test(`coupon: ${name} → denied`, () => {
  const db = baseDb();
  const b = (() => {
    // build the order ignoring client-side eligibility so the RULES have to refuse it
    const coupon = { ...db.get(`coupons/${code}`), code };
    const zone = { id: 'in', ...db.get('shippingZones/in') };
    return buildOrder({
      uid: extra.uid || 'u1', orderNumber: 'SV-261026-AAAAAA', nowMs: NOW,
      customer: { name: 'Rahim Uddin', phone: '01712345678' },
      address: { name: 'Rahim Uddin', phone: '01712345678', district: 'Sirajganj', line1: 'House 1, Road 2' },
      zone, lines: [{ key: 'p1', qty: 1, inv: db.get('inventory/p1'), name: 'Item' }],
      coupon: { ...coupon, active: true, startsAt: null, endsAt: null, customerIds: [], usageLimit: null, minOrder: 0 }, couponUsageCount: null,
      payment: { method: 'cod' },
    });
  })();
  expectDenied(db, extra.uid || 'u1', b.ops, name);
});
couponCase('expired', 'OLD');
couponCase('not yet started', 'FUTURE');
couponCase('disabled', 'OFF');
couponCase('restricted to another customer', 'VIP');
couponCase('usage limit already reached', 'USED');

test('coupon: below the minimum order → denied by rules', () => {
  const db = baseDb();
  db.get('coupons/WELCOME10').minOrder = 5000;
  const coupon = { ...db.get('coupons/WELCOME10'), code: 'WELCOME10', minOrder: 0 };
  const b = buildOrder({
    uid: 'u1', orderNumber: 'SV-261026-AAAAAA', nowMs: NOW,
    customer: { name: 'Rahim Uddin', phone: '01712345678' },
    address: { name: 'Rahim Uddin', phone: '01712345678', district: 'Sirajganj', line1: 'House 1, Road 2' },
    zone: { id: 'in', ...db.get('shippingZones/in') }, lines: [{ key: 'p1', qty: 1, inv: db.get('inventory/p1'), name: 'Item' }],
    coupon, couponUsageCount: null, payment: { method: 'cod' },
  });
  expectDenied(db, 'u1', b.ops, 'min order');
});

test('coupon: per-customer limit (second use) → denied; builder refuses too', () => {
  const db = baseDb();
  const first = mk(db, { coupon: 'WELCOME10' });
  const r = expectOk(db, 'u1', first.ops);
  const after = r.strict.dbAfter;
  assert.throws(() => mk(after, { coupon: 'WELCOME10', usage: 1, orderNumber: 'SV-261026-BBBBBB', now: NOW + 60000 }), /Coupon cannot be applied/);
  // force it past the client check
  const second = mk(after, { coupon: 'WELCOME10', usage: 0, orderNumber: 'SV-261026-BBBBBB', now: NOW + 60000 });
  const forged = clone(second.ops);
  forged.find((o) => o.path.startsWith('couponUsage/')).op = 'update';
  forged.find((o) => o.path.startsWith('couponUsage/')).data.count = 2;
  const res = commitBoth(after, { uid: 'u1' }, forged, NOW + 60000);
  assert.equal(res.strict.allowed, false);
  assert.equal(res.tolerant.allowed, false);
});

test('coupon: same code cannot be redeemed without the usage record', () => {
  const db = baseDb();
  const b = mk(db, { coupon: 'WELCOME10' });
  const ops = clone(b.ops).filter((o) => !o.path.startsWith('couponUsage/'));
  expectDenied(db, 'u1', ops, 'no usage record');
});

test('coupon: bumping usedCount without an order → denied', () => {
  const db = baseDb();
  const r = commitBoth(db, { uid: 'u1' }, [{ op: 'update', path: 'coupons/WELCOME10', data: { usedCount: { $op: 'inc', n: 1 }, lastOrderId: 'SV-261026-AAAAAA' } }]);
  assert.equal(r.strict.allowed, false);
  assert.equal(r.tolerant.allowed, false);
});

/* ───────────────────────── payment ───────────────────────── */

test('manual payment: reusing a TrxID of another order → denied', () => {
  const db = baseDb();
  const a = mk(db, { payment: { method: 'bkash', trxId: 'TRX1234567', senderNumber: '01812345678' }, orderNumber: 'SV-261026-AAAAAA' });
  const r = expectOk(db, 'u1', a.ops);
  const after = r.strict.dbAfter;
  after.get('users/u2'); // exists
  const b = mk(after, { uid: 'u2', payment: { method: 'bkash', trxId: 'trx1234567', senderNumber: '01912345678' }, orderNumber: 'SV-261026-BBBBBB', now: NOW + 60000 });
  const res = commitBoth(after, { uid: 'u2' }, b.ops, NOW + 60000);
  assert.equal(res.strict.allowed, false, 'duplicate trx accepted');
  assert.equal(res.tolerant.allowed, false);
});

test('manual payment: trx id missing / malformed → denied', () => {
  const db = baseDb();
  const b = mk(db, { payment: { method: 'bkash', trxId: 'TRX1234567', senderNumber: '01812345678' } });
  for (const trx of ['', 'ab', 'has space', 'x'.repeat(30)]) {
    const ops = clone(b.ops);
    orderOp(ops).data.payment.trxId = trx;
    expectDenied(db, 'u1', ops, `trx "${trx}"`);
  }
});

test('manual payment must start as awaiting_verification (never paid)', () => {
  const db = baseDb();
  const b = mk(db, { payment: { method: 'nagad', trxId: 'NGD1234567', senderNumber: '01812345678' } });
  const ops = clone(b.ops);
  orderOp(ops).data.payment.status = 'paid';
  expectDenied(db, 'u1', ops, 'self-paid');
});

/* ───────────────────────── accounts: cooldown / restricted ───────────────────────── */

test('restricted account cannot order', () => {
  const db = baseDb();
  const b = mk(db, { uid: 'ur' });
  expectDenied(db, 'ur', b.ops, 'restricted');
});

test('cooldown: second order within 15 s denied, allowed afterwards', () => {
  const db = baseDb();
  const b1 = mk(db, { uid: 'uc' });
  expectDenied(db, 'uc', b1.ops, 'cooldown');
  const later = NOW + 20000;
  const b2 = mk(db, { uid: 'uc', now: later });
  const r = commitBoth(db, { uid: 'uc' }, b2.ops, later);
  assert.equal(r.strict.allowed, true, failedOps(r.strict).join(' | '));
});

test('anonymous user cannot order', () => {
  const db = baseDb();
  const b = mk(db);
  const r = commitBoth(db, null, b.ops);
  assert.equal(r.strict.allowed, false);
  assert.equal(r.tolerant.allowed, false);
});

/* ───────────────────────── reading orders ───────────────────────── */

function placed(db, over = {}) {
  const b = mk(db, over);
  const r = expectOk(db, over.uid || 'u1', b.ops);
  return { db: r.strict.dbAfter, b };
}

test('customers read only their own orders; staff with orders.read read all', () => {
  const { db, b } = placed(baseDb());
  const key = `orders/${b.orderNumber}`;
  for (const [uid, want] of [['u1', true], ['u2', false], ['om', true], ['rp', true], ['pm', false], ['im', false]]) {
    const r = strictEngine.read({ db, auth: { uid }, now: NOW, key });
    assert.equal(r.allowed, want, `${uid} read order`);
  }
  assert.equal(strictEngine.read({ db, auth: null, now: NOW, key }).allowed, false);
});

/* ───────────────────────── customer cancel / return ───────────────────────── */

test('customer cancels own pending order: stock released in the same batch', () => {
  const { db, b } = placed(baseDb(), { lines: [{ key: 'p1', qty: 3 }, { key: 'p4', qty: 1 }] });
  assert.equal(db.get('inventory/p1').reserved, 3);
  const order = normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  const invByKey = { p1: db.get('inventory/p1'), p4: db.get('inventory/p4') };
  const plan = planCustomerCancel({ order, uid: 'u1', reason: 'changed my mind', invByKey });
  assert.equal(plan.ok, true);
  const r = expectOk(db, 'u1', plan.ops, 'cancel');
  assert.equal(r.strict.dbAfter.get('inventory/p1').reserved, 0);
  assert.equal(r.strict.dbAfter.get(`orders/${b.orderNumber}`).status, 'cancelled');
  // cancelling twice is refused by the planner and by the rules
  const again = commitBoth(r.strict.dbAfter, { uid: 'u1' }, plan.ops, NOW + 1000);
  assert.equal(again.strict.allowed, false);
  assert.equal(again.tolerant.allowed, false);
});

test('customer cannot release more stock than the order held, nor without cancelling', () => {
  const { db, b } = placed(baseDb(), { lines: [{ key: 'p1', qty: 3 }] });
  const order = normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  const plan = planCustomerCancel({ order, uid: 'u1', reason: '', invByKey: { p1: db.get('inventory/p1') } });
  const bad = clone(plan.ops);
  bad.find((o) => o.path === 'inventory/p1').data.reserved = { $op: 'inc', n: -10 };
  expectDenied(db, 'u1', bad, 'release too much');
  const noCancel = [{ op: 'update', path: 'inventory/p1', data: { reserved: { $op: 'inc', n: -3 }, lastOrderId: b.orderNumber } }];
  expectDenied(db, 'u1', noCancel, 'release without cancel');
});

test('customer cannot cancel a confirmed order, or somebody else\'s', () => {
  const { db, b } = placed(baseDb());
  const confirmed = db.clone();
  confirmed.get(`orders/${b.orderNumber}`).status = 'confirmed';
  const ops = [{ op: 'update', path: `orders/${b.orderNumber}`, data: { status: 'cancelled', cancelledAt: TS, cancelReason: '', updatedAt: TS } }];
  expectDenied(confirmed, 'u1', ops, 'cancel confirmed');
  expectDenied(db, 'u2', ops, 'cancel other user order');
});

test('customer cannot tamper with status / payment / totals of own order', () => {
  const { db, b } = placed(baseDb());
  const id = `orders/${b.orderNumber}`;
  for (const data of [
    { status: 'delivered', updatedAt: TS },
    { status: 'confirmed', updatedAt: TS },
    { payment: { method: 'cod', status: 'paid', trxId: '', senderNumber: '', amountDue: 1070 }, updatedAt: TS },
    { totals: { subtotal: 1, eligibleSubtotal: 0, discount: 0, shipping: 0, tax: 0, total: 1 }, updatedAt: TS },
  ]) {
    expectDenied(db, 'u1', [{ op: 'update', path: id, data }], JSON.stringify(Object.keys(data)));
  }
  expectDenied(db, 'u1', [{ op: 'delete', path: id }], 'delete');
});

test('return request: only for the buyer of a delivered order, creates returns/{id}', () => {
  const { db, b } = placed(baseDb(), { lines: [{ key: 'p1', qty: 2 }] });
  db.get(`orders/${b.orderNumber}`).status = 'delivered';
  db.get(`orders/${b.orderNumber}`).deliveredAt = { ms: NOW - DAY, toMillis: () => NOW - DAY };
  const order = normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  const plan = planCustomerReturn({ order, uid: 'u1', lines: [{ key: 'p1', qty: 1 }], reason: 'Wrong size', details: '', nowMs: NOW });
  assert.equal(plan.ok, true, plan.message);
  expectOk(db, 'u1', plan.ops, 'return');
  expectDenied(db, 'u2', plan.ops.map((o) => ({ ...o, data: { ...o.data, ...(o.data.userId ? { userId: 'u2' } : {}) } })), 'return by stranger');
});

/* ───────────────────────── staff lifecycle ───────────────────────── */

const actor = (uid, role) => ({ uid, email: `${uid}@x.test`, role });

function staffRun(db, who, order, to, options = {}, invKeys) {
  const invByKey = {};
  for (const l of order.items) invByKey[l.key] = db.get(`inventory/${l.key}`);
  return planStatusChange({ order, to, actor: actor(who.uid, who.role), nowMs: NOW + 5000, invByKey, options });
}

test('order manager: confirm → ship (stock deducted atomically with timeline + audit) → deliver', () => {
  let { db, b } = placed(baseDb(), { lines: [{ key: 'p1', qty: 2 }, { key: 'p5', qty: 1 }] });
  const get = () => normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  const om = { uid: 'om', role: 'order_manager' };

  let plan = staffRun(db, om, get(), 'confirmed');
  assert.equal(plan.ok, true);
  let r = expectOk(db, 'om', plan.ops, 'confirm'); db = r.strict.dbAfter;

  plan = staffRun(db, om, get(), 'processing');
  assert.equal(plan.ok, true);
  r = expectOk(db, 'om', plan.ops, 'processing'); db = r.strict.dbAfter;
  assert.equal(db.get('inventory/p1').reserved, 2, 'processing does not touch stock');

  assert.equal(staffRun(db, om, get(), 'delivered', {}).ok, true, 'processing → delivered is allowed (ships implicitly)');
  plan = staffRun(db, om, get(), 'shipped', { carrier: 'Pathao', trackingNo: 'PX123' });
  assert.equal(plan.ok, true);
  r = expectOk(db, 'om', plan.ops, 'ship');
  db = r.strict.dbAfter;
  console.log(`      ship batch: ${plan.ops.length} writes, ${r.strict.totalCalls} access calls`);
  assert.equal(db.get('inventory/p1').stock, 8);
  assert.equal(db.get('inventory/p1').reserved, 0);
  assert.equal(db.get(`orders/${b.orderNumber}`).shipping.trackingNo, 'PX123');

  plan = staffRun(db, om, get(), 'delivered', { markCodPaid: false });
  assert.equal(plan.ok, true);
  r = expectOk(db, 'om', plan.ops, 'deliver'); db = r.strict.dbAfter;
  assert.equal(db.get('inventory/p1').stock, 8, 'no second deduction on delivery');
  assert.equal(db.get(`orders/${b.orderNumber}`).status, 'delivered');
});

test('staff cancel before shipping releases the reservation; cancel after shipping is impossible', () => {
  let { db, b } = placed(baseDb(), { lines: [{ key: 'p1', qty: 4 }] });
  const get = () => normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  const sa = { uid: 'sadm', role: 'store_admin' };
  const plan = staffRun(db, sa, get(), 'cancelled', { cancelReason: 'Out of cash' });
  assert.equal(plan.ok, true);
  const r = expectOk(db, 'sadm', plan.ops, 'staff cancel');
  assert.equal(r.strict.dbAfter.get('inventory/p1').reserved, 0);
  assert.equal(r.strict.dbAfter.get('inventory/p1').stock, 10);
  // shipped orders cannot be cancelled
  db.get(`orders/${b.orderNumber}`).status = 'shipped';
  db.get(`orders/${b.orderNumber}`).shippedAt = { ms: NOW, toMillis: () => NOW };
  assert.equal(staffRun(db, sa, get(), 'cancelled').ok, false);
});

test('status transitions that skip the lifecycle are rejected by planner AND rules', () => {
  const { db, b } = placed(baseDb());
  const order = normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  const plan = staffRun(db, { uid: 'sadm', role: 'store_admin' }, order, 'delivered'); // pending → delivered not allowed
  assert.equal(plan.ok, false);
  expectDenied(db, 'sadm', [{ op: 'update', path: `orders/${b.orderNumber}`, data: { status: 'delivered', deliveredAt: TS, updatedAt: TS } }], 'skip');
  expectDenied(db, 'sadm', [{ op: 'update', path: `orders/${b.orderNumber}`, data: { status: 'refunded', updatedAt: TS } }], 'refund unpaid pending');
});

test('role boundaries on orders', () => {
  const { db, b } = placed(baseDb());
  const id = `orders/${b.orderNumber}`;
  const confirm = [{ op: 'update', path: id, data: { status: 'confirmed', confirmedAt: TS, updatedAt: TS } }];
  for (const [uid, want] of [['sa', true], ['sadm', true], ['om', true], ['pm', false], ['im', false], ['cs', false], ['rp', false], ['off', false], ['nobody', false]]) {
    const r = commitBoth(db, { uid }, confirm);
    assert.equal(r.strict.allowed, want, `${uid} confirm (strict)`);
    assert.equal(r.tolerant.allowed, want, `${uid} confirm (tolerant)`);
  }
  // customer_support lacks orders.cancel and order_manager lacks refund
  const cancel = [{ op: 'update', path: id, data: { status: 'cancelled', cancelledAt: TS, cancelReason: '', updatedAt: TS } }];
  assert.equal(commitBoth(db, { uid: 'om' }, cancel).strict.allowed, true);
  assert.equal(commitBoth(db, { uid: 'cs' }, cancel).tolerant.allowed, false);
});

test('payment verification: only roles with payments.verify; customer typed TrxID is not proof', () => {
  let { db, b } = placed(baseDb(), { payment: { method: 'bkash', trxId: 'TRX1234567', senderNumber: '01812345678' } });
  const order = normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  assert.equal(order.payment.status, 'awaiting_verification');

  const bad = planPaymentAction({ order, action: 'verify', actor: actor('cs', 'customer_support'), nowMs: NOW, receivedAmount: 1070 });
  assert.equal(bad.ok, false);
  const low = planPaymentAction({ order, action: 'verify', actor: actor('om', 'order_manager'), nowMs: NOW, receivedAmount: 500 });
  assert.equal(low.ok, false);
  const ok = planPaymentAction({ order, action: 'verify', actor: actor('om', 'order_manager'), nowMs: NOW, receivedAmount: 1070 });
  assert.equal(ok.ok, true);
  const r = expectOk(db, 'om', ok.ops, 'verify');
  assert.equal(r.strict.dbAfter.get(`orders/${b.orderNumber}`).payment.status, 'paid');
  // customer service staff cannot write payment even by forging the op
  expectDenied(db, 'cs', ok.ops, 'cs verify');
  expectDenied(db, 'u1', ok.ops, 'customer verify');
});

test('rejected payment lets the customer re-submit a new TrxID (once, validated)', () => {
  let { db, b } = placed(baseDb(), { payment: { method: 'bkash', trxId: 'TRX1234567', senderNumber: '01812345678' } });
  const order = normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  const rej = planPaymentAction({ order, action: 'reject', actor: actor('om', 'order_manager'), nowMs: NOW, note: 'not found' });
  db = expectOk(db, 'om', rej.ops, 'reject').strict.dbAfter;
  const resubmit = [
    { op: 'update', path: `orders/${b.orderNumber}`, data: { payment: { method: 'bkash', status: 'awaiting_verification', trxId: 'NEWTRX99887', senderNumber: '01812345678', amountDue: 1070 }, updatedAt: TS } },
    { op: 'set', path: 'paymentTrx/NEWTRX99887', data: { orderId: b.orderNumber, userId: 'u1', method: 'bkash', createdAt: TS } },
  ];
  expectOk(db, 'u1', resubmit, 'resubmit');
  // cannot flip to paid while "resubmitting"
  const forged = clone(resubmit); forged[0].data.payment.status = 'paid';
  expectDenied(db, 'u1', forged, 'resubmit as paid');
});

test('refund flow: needs orders.refund; order_manager cannot refund', () => {
  let { db, b } = placed(baseDb(), { payment: { method: 'nagad', trxId: 'NGD1234567', senderNumber: '01812345678' } });
  db.get(`orders/${b.orderNumber}`).status = 'refund_pending';
  db.get(`orders/${b.orderNumber}`).payment.status = 'paid';
  const order = normalizeOrder(b.orderNumber, db.get(`orders/${b.orderNumber}`));
  assert.equal(planRefund({ order, actor: actor('om', 'order_manager'), amount: 1070 }).ok, false);
  const plan = planRefund({ order, actor: actor('sadm', 'store_admin'), amount: 1070, method: 'Nagad' });
  assert.equal(plan.ok, true);
  const r = expectOk(db, 'sadm', plan.ops, 'refund');
  assert.equal(r.strict.dbAfter.get(`orders/${b.orderNumber}`).status, 'refunded');
  expectDenied(db, 'om', plan.ops, 'om refund');
});

test('legacy (pre-upgrade) orders remain readable by the owner and updatable by staff', () => {
  const db = baseDb();
  db.set('orders/order_1700000000000', {
    orderId: 'order_1700000000000', userId: 'u1', userEmail: 'rahim@example.com', userName: 'Rahim', customerName: 'Rahim', customerPhone: '01712345678',
    customerAddress: 'Somewhere', items: [{ id: 'p1', name: 'Test Shirt', price: 1000, qty: 1 }], subtotal: 1000, discountAmount: 0, voucherCode: 'None',
    deliveryCharge: 70, deliveryArea: 'Inside Sirajganj', totalAmount: 1070, paymentMethod: 'Cash on Delivery', transactionId: 'N/A', status: 'Pending',
    timestamp: '2026-08-01T10:00:00.000Z',
  });
  assert.equal(strictEngine.read({ db, auth: { uid: 'u1' }, now: NOW, key: 'orders/order_1700000000000' }).allowed, true);
  assert.equal(strictEngine.read({ db, auth: { uid: 'u2' }, now: NOW, key: 'orders/order_1700000000000' }).allowed, false);
  const legacy = normalizeOrder('order_1700000000000', db.get('orders/order_1700000000000'));
  assert.equal(legacy.isLegacy, true);
  assert.equal(legacy.status, 'pending');
  const plan = planStatusChange({ order: legacy, to: 'confirmed', actor: actor('om', 'order_manager'), nowMs: NOW, invByKey: {} });
  assert.equal(plan.ok, true);
  expectOk(db, 'om', plan.ops, 'legacy confirm');
  // the customer cannot cancel a legacy order from the client (no payment object)
  assert.equal(planCustomerCancel({ order: legacy, uid: 'u1' }).ok, false);
});

test('toWrites keeps nested sentinels (payment.verifiedAt)', () => {
  const w = toWrites([{ op: 'update', path: 'orders/x', data: { payment: { verifiedAt: TS } } }]);
  assert.equal(w[0].data.payment.verifiedAt.__op, 'serverTimestamp');
});
