import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT, PERIODS, isPeriod, sinceFor, normalizeEntry, showValue, flatten, diffEntry, rawJson, entityRoute, matchesFilters, tally } from '../../js/shared/auditView.js';

const NOW = Date.UTC(2026, 10, 10, 6, 0, 0);
const entry = (o = {}) => normalizeEntry(o.id || 'a1', { actorUid: 'u1', actorEmail: 'Boss@Shop.test', actorRole: 'store_admin', action: 'order.status', entity: 'order', entityId: 'SV-1', summary: 'Order SV-1: pending → confirmed', before: { status: 'pending' }, after: { status: 'confirmed' }, createdAt: { toMillis: () => NOW }, ...o });

test('periods: the chips, their time bounds and "everything"', () => {
  assert.deepEqual([...PERIODS], ['24h', '7d', '30d', 'all']);
  assert.equal(sinceFor('24h', NOW), NOW - 86400000);
  assert.equal(sinceFor('7d', NOW), NOW - 7 * 86400000);
  assert.equal(sinceFor('30d', NOW), NOW - 30 * 86400000);
  assert.equal(sinceFor('all', NOW), null);
  assert.equal(sinceFor('bogus', NOW), null);
  assert.ok(isPeriod('7d') && !isPeriod('1y') && !isPeriod(undefined));
});

test('normalizeEntry: plain fields, capped text, time in ms, missing pieces are empty', () => {
  const e = entry({ summary: 'x'.repeat(900), actorEmail: 'y'.repeat(400) });
  assert.equal(e.summary.length, 600);
  assert.equal(e.actorEmail.length, 200);
  assert.equal(e.createdMs, NOW);
  assert.deepEqual(e.before, { status: 'pending' });
  const bare = normalizeEntry('z', {});
  assert.deepEqual([bare.id, bare.action, bare.entity, bare.entityId, bare.before, bare.after, bare.createdMs], ['z', '', '', '', null, null, 0]);
});

test('showValue: null, text, numbers, times, objects and a long text cut with an ellipsis', () => {
  assert.equal(showValue(null), '—');
  assert.equal(showValue(undefined), '—');
  assert.equal(showValue(''), '""');
  assert.equal(showValue('abc'), 'abc');
  assert.equal(showValue(0), '0');
  assert.equal(showValue(false), 'false');
  assert.equal(showValue({ toMillis: () => NOW }), '2026-11-10T06:00:00.000Z');
  assert.equal(showValue(new Date(NOW)), '2026-11-10T06:00:00.000Z');
  assert.equal(showValue(['a', 1]), '["a",1]');
  const long = showValue('q'.repeat(500));
  assert.equal(long.length, AUDIT.VALUE_MAX + 1);
  assert.ok(long.endsWith('…'));
});

test('flatten: dotted paths, lists stay whole, depth is limited, an empty snapshot has no fields', () => {
  assert.deepEqual(flatten({ b: 2, a: { x: 1, y: { z: 3 } }, list: [1, 2] }), [['a.x', 1], ['a.y.z', 3], ['b', 2], ['list', [1, 2]]]);
  assert.deepEqual(flatten({ a: { b: { c: { d: { e: 1 } } } } }), [['a.b.c', { d: { e: 1 } }]]);
  assert.deepEqual(flatten(null), []);
  assert.deepEqual(flatten({}), []);
  assert.deepEqual(flatten({ a: null, b: {} }), [['a', null], ['b', {}]]);
  assert.deepEqual(flatten('text'), [['(value)', 'text']]);
});

test('diffEntry: only the fields that differ, with how they differ', () => {
  const d = diffEntry({ status: 'pending', n: 1, same: 'x' }, { status: 'confirmed', n: 1, same: 'x', extra: true });
  assert.equal(d.kind, 'changed');
  assert.deepEqual(d.rows, [
    { path: 'extra', change: 'added', before: '—', after: 'true' },
    { path: 'status', change: 'changed', before: 'pending', after: 'confirmed' },
  ]);
  const nested = diffEntry({ address: { district: 'Dhaka', area: 'A' } }, { address: { district: 'Khulna', area: 'A' } });
  assert.deepEqual(nested.rows, [{ path: 'address.district', change: 'changed', before: 'Dhaka', after: 'Khulna' }]);
  const gone = diffEntry({ a: 1, b: 2 }, { a: 1 });
  assert.deepEqual(gone.rows, [{ path: 'b', change: 'removed', before: '2', after: '—' }]);
});

test('diffEntry: created, deleted, same, nothing recorded; a number is not its text', () => {
  const c = diffEntry(null, { name: 'Cap', price: 600 });
  assert.equal(c.kind, 'created');
  assert.deepEqual(c.rows.map((r) => [r.path, r.change, r.after]), [['name', 'added', 'Cap'], ['price', 'added', '600']]);
  const x = diffEntry({ name: 'Cap' }, undefined);
  assert.equal(x.kind, 'deleted');
  assert.deepEqual(x.rows.map((r) => [r.path, r.change, r.before]), [['name', 'removed', 'Cap']]);
  assert.equal(diffEntry({ a: 1 }, { a: 1 }).kind, 'same');
  assert.equal(diffEntry(null, null).kind, 'none');
  assert.equal(diffEntry(undefined, undefined).kind, 'none');
  assert.equal(diffEntry({ a: 1 }, { a: '1' }).rows.length, 1);
  assert.deepEqual(diffEntry({ list: [1, 2] }, { list: [1, 3] }).rows, [{ path: 'list', change: 'changed', before: '[1,2]', after: '[1,3]' }]);
});

test('diffEntry: a huge snapshot is capped and says how many fields are hidden', () => {
  const after = {};
  for (let i = 0; i < 100; i += 1) after[`f${String(i).padStart(3, '0')}`] = i;
  const d = diffEntry(null, after);
  assert.equal(d.rows.length, AUDIT.FIELDS_MAX);
  assert.equal(d.total, 100);
  assert.equal(d.hidden, 100 - AUDIT.FIELDS_MAX);
});

test('rawJson: both snapshots, times as ISO, capped', () => {
  const r = JSON.parse(rawJson({ at: { toMillis: () => NOW } }, null));
  assert.deepEqual(r, { before: { at: '2026-11-10T06:00:00.000Z' }, after: null });
  const big = rawJson(null, { text: 'z'.repeat(50000) });
  assert.ok(big.length <= AUDIT.RAW_MAX + 2);
  assert.ok(big.endsWith('…'));
});

test('entityRoute: the page an entry is about, only when the viewer may open it', () => {
  assert.equal(entityRoute('order', 'SV-1'), '/orders/SV-1');
  assert.equal(entityRoute('product', 'a b/c'), '/products/a%20b%2Fc');
  assert.equal(entityRoute('customer', 'uid9'), '/customers/uid9');
  assert.equal(entityRoute('ticket', 't1'), '/support/t1');
  assert.equal(entityRoute('page', 'about'), '/content/pages/about');
  assert.equal(entityRoute('coupon', 'WELCOME'), '/coupons');
  assert.equal(entityRoute('shipping_zone', 'z1'), '/shipping');
  assert.equal(entityRoute('order', ''), null, 'an order link needs its id');
  assert.equal(entityRoute('system', 'x'), null, 'unknown areas have no page');
  const only = (perm) => (p) => p === perm;
  assert.equal(entityRoute('staff', 'u1', only('orders.read')), null, 'no link to a page the viewer cannot open');
  assert.equal(entityRoute('staff', 'u1', only('staff.manage')), '/staff');
  assert.equal(entityRoute('order', 'SV-1', only('orders.read')), '/orders/SV-1');
});

test('matchesFilters: search text (any of summary, action, area, id, e-mail), area and person must all match', () => {
  const e = entry();
  assert.ok(matchesFilters(e, {}));
  assert.ok(matchesFilters(e, { q: '  CONFIRMED ' }), 'case and spaces do not matter');
  assert.ok(matchesFilters(e, { q: 'sv-1' }), 'the id');
  assert.ok(matchesFilters(e, { q: 'order.status' }), 'the action');
  assert.ok(matchesFilters(e, { q: 'boss@shop' }), 'the e-mail');
  assert.ok(!matchesFilters(e, { q: 'refund' }));
  assert.ok(matchesFilters(e, { entity: 'order' }) && !matchesFilters(e, { entity: 'product' }));
  assert.ok(matchesFilters(e, { actor: 'u1' }) && !matchesFilters(e, { actor: 'u2' }));
  assert.ok(!matchesFilters(e, { q: 'confirmed', entity: 'order', actor: 'u2' }), 'all filters apply together');
});

test('tally: distinct values, most frequent first, ties by label, empty values skipped', () => {
  const list = [entry({ id: '1', entity: 'order' }), entry({ id: '2', entity: 'product' }), entry({ id: '3', entity: 'order' }), entry({ id: '4', entity: '' }), entry({ id: '5', entity: 'coupon' })];
  assert.deepEqual(tally(list, 'entity').map((x) => [x.value, x.count]), [['order', 2], ['coupon', 1], ['product', 1]]);
  const who = [entry({ id: '1', actorUid: 'b', actorEmail: 'b@x' }), entry({ id: '2', actorUid: 'a', actorEmail: 'a@x' }), entry({ id: '3', actorUid: 'a', actorEmail: 'a@x' })];
  assert.deepEqual(tally(who, 'actorUid', (e) => e.actorEmail).map((x) => [x.value, x.label, x.count]), [['a', 'a@x', 2], ['b', 'b@x', 1]]);
});
