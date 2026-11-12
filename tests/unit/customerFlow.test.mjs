/* Customers — the pure parts of js/shared/customerFlow.js and customerModel.js: search, lookups, order totals, tidy text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCustomers, orderCustomers, lookupKind, filterSubscribers, summarizeCustomerOrders, planNoteAdd, planRestrict, CUSTOMER } from '../../js/shared/customerFlow.js';
import { normalizeCustomer, normalizeNote, normalizeSubscriber } from '../../js/shared/customerModel.js';

const SA = { uid: 'sa', email: 'sa@x.test', role: 'super_admin' };
const list = [
  { id: 'u1', name: 'Rahim Uddin', email: 'rahim@example.com', phone: '01711111111', restricted: false, joinedMs: 100 },
  { id: 'u2', name: 'Karim', email: 'karim@example.com', phone: '01822-222222', restricted: true, joinedMs: 300 },
  { id: 'u3', name: '', email: 'nadia@example.com', phone: '', restricted: false, joinedMs: 300 },
];

test('normalizeCustomer: missing times are 0, restricted is true only for the boolean true', () => {
  const c = normalizeCustomer('u9', { displayName: 'Nadia', restricted: 'yes', createdAt: { ms: 5 } });
  assert.deepEqual(c, { id: 'u9', name: 'Nadia', email: '', phone: '', photoURL: '', joinedMs: 5, lastLoginMs: 0, lastOrderMs: 0, restricted: false, restrictedReason: '', restrictedMs: 0 });
  assert.equal(normalizeCustomer('u9', { restricted: true }).restricted, true);
  assert.deepEqual(normalizeNote('n', {}), { id: 'n', text: '', authorUid: '', authorEmail: '', createdMs: 0 });
  assert.equal(normalizeSubscriber('a@b.co', { source: 'footer' }).email, 'a@b.co');
});

test('filterCustomers: name, e-mail, id, phone fragments (also Bengali digits and +880) and the restricted filter', () => {
  const ids = (o) => filterCustomers(list, o).map((c) => c.id);
  assert.deepEqual(ids({}), ['u1', 'u2', 'u3']);
  assert.deepEqual(ids({ q: 'RAHIM' }), ['u1']);
  assert.deepEqual(ids({ q: 'example.com' }), ['u1', 'u2', 'u3']);
  assert.deepEqual(ids({ q: '0171' }), ['u1']);
  assert.deepEqual(ids({ q: '০১৮২২' }), ['u2'], 'Bengali digits');
  assert.deepEqual(ids({ q: '+8801822222222' }), ['u2'], 'international form');
  assert.deepEqual(ids({ q: '01' }), [], 'under three digits is not a phone search');
  assert.deepEqual(ids({ status: 'restricted' }), ['u2']);
  assert.deepEqual(ids({ q: 'karim', status: 'restricted' }), ['u2']);
  assert.deepEqual(ids({ q: 'karim', status: '' }), ['u2']);
  assert.deepEqual(ids({ q: 'nobody' }), []);
});

test('orderCustomers: newest first, ties by id, input untouched', () => {
  const before = JSON.stringify(list);
  assert.deepEqual(orderCustomers(list).map((c) => c.id), ['u2', 'u3', 'u1']);
  assert.equal(JSON.stringify(list), before);
});

test('lookupKind: an e-mail or a Bangladesh mobile number names one customer, anything else does not', () => {
  assert.deepEqual(lookupKind('  Rahim@Example.COM '), { field: 'email', value: 'rahim@example.com' });
  assert.deepEqual(lookupKind('01711111111'), { field: 'phone', value: '01711111111' });
  assert.deepEqual(lookupKind('+880 1711-111111'), { field: 'phone', value: '01711111111' });
  assert.deepEqual(lookupKind('০১৭' + '১'.repeat(8)), { field: 'phone', value: '01711111111' }, 'Bengali digits');
  for (const q of ['', 'rahim', 'rahim@', '12345', '@example.com', 'a b@c.de']) assert.equal(lookupKind(q), null, JSON.stringify(q));
});

test('filterSubscribers: e-mail or source', () => {
  const subs = [{ id: 'a@x.co', email: 'a@x.co', source: 'footer' }, { id: 'b@y.co', email: 'b@y.co', source: 'checkout' }];
  assert.deepEqual(filterSubscribers(subs, 'Y.CO').map((s) => s.id), ['b@y.co']);
  assert.deepEqual(filterSubscribers(subs, 'footer').map((s) => s.id), ['a@x.co']);
  assert.equal(filterSubscribers(subs, '').length, 2);
});

test('summarizeCustomerOrders: sales are the revenue statuses only, cancelled orders are counted apart, first and last order', () => {
  const o = (status, total, createdAtMs, qty = 1) => ({ status, totals: { total }, createdAtMs, items: [{ qty }], payment: { status: 'unpaid' } });
  const s = summarizeCustomerOrders([o('delivered', 1000, 200), o('cancelled', 500, 300), o('pending', 400, 100), o('delivered', 2000, 500, 2)]);
  assert.equal(s.orders, 4);
  assert.equal(s.cancelled, 1);
  assert.equal(s.completed >= 2, true);
  assert.equal(s.spent >= 3000, true, 'both delivered orders count');
  assert.equal(s.spent <= 3400, true, 'a cancelled order never counts');
  assert.deepEqual([s.firstMs, s.lastMs], [100, 500]);
  assert.deepEqual(summarizeCustomerOrders([]), { orders: 0, completed: 0, cancelled: 0, spent: 0, average: 0, firstMs: 0, lastMs: 0 });
});

test('notes and reasons are tidied: whitespace collapses, blank lines are capped, limits are exact', () => {
  const c = { id: 'u1', name: 'Rahim' };
  const note = (text, extra) => planNoteAdd({ customer: c, text, actor: SA, noteId: 'N', ...extra });
  assert.equal(note('  a   b \r\n\r\n\r\n\r\n c ').ops[0].data.text, 'a b\n\nc');
  assert.equal(note('   ').errors.text, 'required');
  assert.equal(note('x'.repeat(CUSTOMER.NOTE_MAX)).ok, true);
  assert.equal(note('x'.repeat(CUSTOMER.NOTE_MAX + 1)).errors.text, 'too_long');
  assert.equal(note('hello', { count: CUSTOMER.NOTES_MAX }).error, 'too_many');
  assert.equal(note('hello', { count: CUSTOMER.NOTES_MAX - 1 }).ok, true);
  assert.equal(planRestrict({ customer: c, reason: 'x'.repeat(CUSTOMER.REASON_MAX), actor: SA }).ok, true);
  assert.equal(planRestrict({ customer: c, reason: 'abc', actor: SA }).ok, true);
});
