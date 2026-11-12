/*
 * Admin-side planners against the REAL firestore.rules text (strict AND tolerant engine, see harness.mjs):
 * order notes, tracking updates and the return-request bookkeeping. Every batch the admin pages can send must be
 * accepted for the roles that may send it and refused for the others — and must stay inside the access-call budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrder } from '../../js/shared/orderBuilder.js';
import { planOrderNote, planShippingUpdate, planStatusChange, planCustomerReturn, ORDER_NOTE_MAX } from '../../js/shared/orderFlow.js';
import { normalizeOrder } from '../../js/shared/orderModel.js';
import { baseDb, commitBoth, failedOps, NOW, DAY } from './harness.mjs';

const actor = (uid, role) => ({ uid, email: `${uid}@x.test`, role });
const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };

function placeOrder(db) {
  const lines = [{ key: 'p1', qty: 2, inv: db.get('inventory/p1'), name: 'Item p1', image: '' }];
  const zone = { id: 'in', ...db.get('shippingZones/in') };
  const b = buildOrder({
    uid: 'u1', orderNumber: 'SV-261026-AAAAAA', nowMs: NOW,
    customer: { name: 'Rahim Uddin', phone: '01712345678', email: 'rahim@example.com' },
    address: { name: 'Rahim Uddin', phone: '01712345678', district: zone.districts[0], upazila: 'Sadar', area: '', postalCode: '6700', line1: 'House 1, Road 2, Town', notes: '' },
    zone, lines, coupon: null, couponUsageCount: null, payment: { method: 'cod' }, note: '',
  });
  const r = commitBoth(db, { uid: 'u1' }, b.ops);
  assert.equal(r.strict.allowed, true, failedOps(r.strict).join(' | '));
  return { db: r.strict.dbAfter, id: b.orderNumber };
}

const load = (db, id) => normalizeOrder(id, db.get(`orders/${id}`));
const accepted = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r;
};
const refused = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine accepted it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine accepted it`);
};

test('internal note: roles with orders.update or support.reply may add it; the customer may not', () => {
  const { db, id } = placeOrder(baseDb());
  const order = load(db, id);
  for (const uid of ['sa', 'sadm', 'om', 'cs']) {
    const plan = planOrderNote({ order, actor: actor(uid, ROLE[uid]), text: 'Customer asked to deliver after 5pm', visibility: 'internal' });
    assert.equal(plan.ok, true, `${uid}: ${plan.message}`);
    assert.equal(plan.ops.some((o) => o.path.startsWith('users/')), false, 'an internal note sends no notification');
    accepted(db, uid, plan.ops, `note by ${uid}`);
  }
  for (const uid of ['rp', 'im', 'pm']) {
    assert.equal(planOrderNote({ order, actor: actor(uid, ROLE[uid]), text: 'x', visibility: 'internal' }).ok, false, `${uid} may not add notes`);
  }
  // a forged batch from roles the planner refuses is also refused by the rules
  const forged = planOrderNote({ order, actor: actor('om', ROLE.om), text: 'x', visibility: 'internal' }).ops;
  for (const uid of ['rp', 'im', 'pm', 'u1', 'u2']) refused(db, uid, forged, `forged note by ${uid}`);
});

test('customer-visible note also notifies the customer, in the same batch', () => {
  const { db, id } = placeOrder(baseDb());
  const plan = planOrderNote({ order: load(db, id), actor: actor('cs', ROLE.cs), text: 'We will call you tomorrow', visibility: 'customer' });
  assert.equal(plan.ok, true);
  const n = plan.ops.find((o) => o.path.startsWith('users/u1/notifications/'));
  assert.ok(n, 'a notification op exists');
  assert.equal(n.data.read, false);
  const ev = plan.ops.find((o) => o.path.includes('/events/'));
  assert.equal(ev.data.visibility, 'customer');
  accepted(db, 'cs', plan.ops, 'customer-visible note');
});

test('notes: empty and over-long text are refused by the planner', () => {
  const { db, id } = placeOrder(baseDb());
  const order = load(db, id);
  assert.equal(planOrderNote({ order, actor: actor('om', ROLE.om), text: '   ' }).error, 'empty');
  assert.equal(planOrderNote({ order, actor: actor('om', ROLE.om), text: 'x'.repeat(ORDER_NOTE_MAX + 1) }).error, 'too_long');
  assert.equal(planOrderNote({ order, actor: actor('om', ROLE.om), text: 'x'.repeat(ORDER_NOTE_MAX) }).ok, true);
});

test('tracking details: only roles with orders.update; bad links and empty input are refused', () => {
  let { db, id } = placeOrder(baseDb());
  const om = actor('om', ROLE.om);
  // confirm first so the order is in a normal working state
  const confirm = planStatusChange({ order: load(db, id), to: 'confirmed', actor: om, nowMs: NOW + 1000, invByKey: { p1: db.get('inventory/p1') } });
  db = accepted(db, 'om', confirm.ops, 'confirm').strict.dbAfter;

  const plan = planShippingUpdate({ order: load(db, id), actor: om, shipping: { carrier: 'Pathao', trackingNo: 'PX-1', trackingUrl: 'https://track.example.com/PX-1' } });
  assert.equal(plan.ok, true, plan.message);
  const r = accepted(db, 'om', plan.ops, 'tracking');
  assert.equal(r.strict.dbAfter.get(`orders/${id}`).shipping.trackingNo, 'PX-1');

  assert.equal(planShippingUpdate({ order: load(db, id), actor: om, shipping: { carrier: 'X', trackingUrl: 'javascript:alert(1)' } }).error, 'bad_url');
  assert.equal(planShippingUpdate({ order: load(db, id), actor: om, shipping: { carrier: '', trackingNo: '', trackingUrl: '' } }).error, 'empty');
  for (const uid of ['cs', 'rp', 'im', 'pm']) assert.equal(planShippingUpdate({ order: load(db, id), actor: actor(uid, ROLE[uid]), shipping: { carrier: 'X' } }).ok, false, `${uid} may not edit tracking`);
  for (const uid of ['cs', 'rp', 'im', 'pm', 'u1']) refused(db, uid, plan.ops, `forged tracking by ${uid}`);
});

test('a cancelled order accepts no further tracking changes', () => {
  let { db, id } = placeOrder(baseDb());
  const sadm = actor('sadm', ROLE.sadm);
  const cancel = planStatusChange({ order: load(db, id), to: 'cancelled', actor: sadm, nowMs: NOW + 1000, invByKey: { p1: db.get('inventory/p1') }, options: { cancelReason: 'test' } });
  db = accepted(db, 'sadm', cancel.ops, 'cancel').strict.dbAfter;
  assert.equal(planShippingUpdate({ order: load(db, id), actor: sadm, shipping: { carrier: 'X' } }).error, 'closed_order');
});

test('return request: the returns/{id} document follows the staff decision in the same batch', () => {
  const closeOut = (to, want) => {
    let { db, id } = placeOrder(baseDb());
    const sadm = actor('sadm', ROLE.sadm);
    // walk to delivered
    for (const step of ['confirmed', 'processing', 'shipped', 'delivered']) {
      const p = planStatusChange({ order: load(db, id), to: step, actor: sadm, nowMs: NOW + 1000, invByKey: { p1: db.get('inventory/p1') } });
      assert.equal(p.ok, true, `${step}: ${p.message}`);
      db = accepted(db, 'sadm', p.ops, step).strict.dbAfter;
    }
    db.get(`orders/${id}`).deliveredAt = { ms: NOW - DAY, toMillis: () => NOW - DAY };
    const ret = planCustomerReturn({ order: load(db, id), uid: 'u1', lines: [{ key: 'p1', qty: 1 }], reason: 'Wrong size', details: '', nowMs: NOW });
    assert.equal(ret.ok, true, ret.message);
    db = accepted(db, 'u1', ret.ops, 'customer return request').strict.dbAfter;
    assert.equal(db.get(`returns/${id}`).status, 'requested');

    const plan = planStatusChange({ order: load(db, id), to, actor: sadm, nowMs: NOW + 9000, invByKey: { p1: db.get('inventory/p1') }, options: { returnDocExists: true, restock: true } });
    assert.equal(plan.ok, true, plan.message);
    assert.equal(plan.ops.filter((o) => o.path === `returns/${id}`).length, 1, 'exactly one returns update');
    const r = accepted(db, 'sadm', plan.ops, `return → ${to}`);
    assert.equal(r.strict.dbAfter.get(`returns/${id}`).status, want);
    // without the flag the planner leaves the returns document alone (it might not exist)
    const plain = planStatusChange({ order: load(db, id), to, actor: sadm, nowMs: NOW + 9000, invByKey: { p1: db.get('inventory/p1') } });
    assert.equal(plain.ops.some((o) => o.path === `returns/${id}`), false);
  };
  closeOut('refund_pending', 'approved');
  closeOut('returned', 'received');
  closeOut('delivered', 'rejected');
});
