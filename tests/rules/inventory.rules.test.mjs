/*
 * Manual stock planners (js/shared/inventoryFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * add / remove / set with their movement, audit entry and catalog stamp, the CSV stock count in atomic chunks,
 * the reservation recount — and the negative: roles without inventory.adjust, impossible numbers, forged batches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planStockChange, parseStockCsv, planStockImport, planReservationFix, UNITS_PER_CHUNK, IMPORT_MAX_ROWS } from '../../js/shared/inventoryFlow.js';
import { TS, inc } from '../../js/shared/ops.js';
import { baseDb, commitBoth, failedOps, inventoryDoc, NOW } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });

function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}
const refused = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine accepted it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine accepted it`);
};
const movements = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('inventoryMovements/')).map(([, v]) => v);
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const inv = (db, key) => db.get(`inventory/${key}`);
const change = (over) => planStockChange({ key: 'p1', inv: inventoryDoc(), mode: 'add', qty: 5, reason: 'restock', actor: actor('im'), nowMs: NOW, ...over });

test('add: the stock goes up by an increment, with a movement, a catalog stamp and an audit entry — in one batch', () => {
  const db = baseDb();
  const p = change({});
  assert.deepEqual([p.ok, p.before, p.after, p.delta], [true, 10, 15, 5]);
  assert.equal(p.ops.length, 4);
  assert.deepEqual(p.ops[0].data.stock, inc(5), 'an increment keeps a concurrent change by someone else');
  const after = commit(db, 'im', p.ops, 'add');
  assert.deepEqual([inv(after, 'p1').stock, inv(after, 'p1').reserved], [15, 0], 'stock changed, reservation untouched');
  const [m] = movements(after);
  assert.deepEqual([m.key, m.type, m.delta, m.stockAfter, m.refType, m.actorUid, m.productId, m.sku], ['p1', 'restock', 5, 15, 'manual', 'im', 'p1', 'SKU-1']);
  assert.deepEqual(audits(after).map((a) => [a.action, a.entityId, a.actorRole]), [['inventory.adjust', 'p1', 'inventory_manager']]);
  assert.ok(after.get('meta/catalog'), 'storefront caches refresh');
});

test('remove and set: a stock count writes the counted number, a removal an increment; both are logged', () => {
  const db = baseDb();
  const r = change({ mode: 'remove', qty: 4, reason: 'damage', note: 'Water damage', actor: actor('sadm') });
  assert.deepEqual([r.after, r.delta], [6, -4]);
  assert.deepEqual(r.ops[0].data.stock, inc(-4));
  let after = commit(db, 'sadm', r.ops, 'remove');
  assert.equal(inv(after, 'p1').stock, 6);
  assert.deepEqual([movements(after)[0].type, movements(after)[0].note], ['damage', 'Water damage']);

  const s = change({ mode: 'set', qty: 12, reason: 'count', actor: actor('sa') });
  assert.equal(s.ops[0].data.stock, 12, 'the counted number itself is written');
  after = commit(db, 'sa', s.ops, 'set');
  assert.equal(inv(after, 'p1').stock, 12);
  assert.deepEqual([movements(after)[0].type, movements(after)[0].delta, movements(after)[0].stockAfter], ['count', 2, 12]);
  const zero = change({ mode: 'set', qty: 0, reason: 'count', actor: actor('im') });
  assert.equal(commit(db, 'im', zero.ops, 'set to zero').get('inventory/p1').stock, 0, 'a count of zero is valid');
});

test('impossible changes are refused by the planner with a code', () => {
  const code = (over) => change(over).error;
  assert.equal(code({ mode: 'remove', qty: 11, reason: 'loss' }), 'below_zero');
  assert.equal(code({ qty: 0 }), 'bad_qty');
  assert.equal(code({ qty: 1.5 }), 'bad_qty');
  assert.equal(code({ qty: -2 }), 'bad_qty');
  assert.equal(code({ qty: '' }), 'bad_qty');
  assert.equal(code({ qty: 'abc' }), 'bad_qty');
  assert.equal(code({ qty: null }), 'bad_qty');
  assert.equal(code({ mode: 'set', qty: 10, reason: 'count' }), 'no_change', 'a count equal to the stock changes nothing');
  assert.equal(code({ mode: 'set', qty: -1, reason: 'count' }), 'bad_qty');
  assert.equal(code({ qty: 2000000 }), 'too_big');
  assert.equal(code({ reason: 'other' }), 'note_required');
  assert.equal(code({ reason: 'other', note: '   ' }), 'note_required');
  assert.equal(change({ reason: 'other', note: 'Gift from supplier' }).ok, true);
  assert.equal(code({ reason: 'damage' }), 'bad_reason', 'damage is a reason for removing stock, not adding it');
  assert.equal(code({ mode: 'swap' }), 'bad_mode');
  assert.equal(code({ inv: inventoryDoc({ track: false }) }), 'untracked');
  assert.equal(code({ inv: null }), 'no_inventory');
  assert.equal(code({ inv: { ...inventoryDoc(), _legacy: true } }), 'no_inventory', 'an old-format product has no inventory document yet');
  assert.equal(change({ qty: ' 7 ' }).after, 17, 'typed numbers with spaces are accepted');
  assert.equal(change({ note: 'x'.repeat(500) }).ops[1].data.note.length, 300, 'the note is cut to 300 characters');
});

test('roles: only inventory.adjust can change stock; forged batches are refused by the rules', () => {
  const db = baseDb();
  for (const uid of ['pm', 'om', 'cs', 'rp']) assert.equal(change({ actor: actor(uid) }).error, 'forbidden', `${uid} is refused by the planner`);
  for (const uid of ['sa', 'sadm', 'im']) assert.equal(change({ actor: actor(uid) }).ok, true, `${uid} may adjust stock`);
  // forged: a product manager may update inventory documents (products.write) but cannot write the movement that must go with it
  const ok = change({});
  refused(db, 'pm', ok.ops, 'pm forging a stock batch');
  refused(db, 'rp', ok.ops, 'reporting forging a stock batch');
  refused(db, 'u1', ok.ops, 'a customer forging a stock batch');
  refused(db, 'u1', [ok.ops[0]], 'a customer changing stock alone');
  // a movement can never be edited or deleted afterwards
  const after = commit(db, 'im', ok.ops, 'add');
  const id = [...after.m.keys()].find((k) => k.startsWith('inventoryMovements/'));
  refused(after, 'sa', [{ op: 'update', path: id, data: { delta: 999 } }], 'editing a movement');
  refused(after, 'sa', [{ op: 'delete', path: id }], 'deleting a movement');
  // an inactive staff member is nobody
  const off = new Map(); void off;
  refused(db, 'off', ok.ops, 'a deactivated store admin');
});

/* ───────────────────────── CSV ───────────────────────── */

const units = (db) => [...db.m.entries()].filter(([k]) => /^inventory\/[^/]+$/.test(k)).map(([k, v]) => ({ key: k.split('/')[1], sku: v.sku, name: `Unit ${k.split('/')[1]}`, inv: v }));

test('stock CSV: the page\'s own export can be edited and read back; other layouts are rejected with a reason', () => {
  const sheet = '﻿Key,SKU,Product,Variant,Stock,Reserved\r\np1,SKU-1,"Shirt, blue",,25,2\r\np3__v1,SKU-3,Shoes,"40",7,0\r\n';
  const p = parseStockCsv(sheet);
  assert.equal(p.ok, true);
  assert.deepEqual(p.rows, [{ line: 2, ref: 'SKU-1', count: '25' }, { line: 3, ref: 'SKU-3', count: '7' }]);
  assert.deepEqual(parseStockCsv('key,qty\np1,3\n').rows, [{ line: 2, ref: 'p1', count: '3' }], 'a key column works without SKUs');
  assert.deepEqual(parseStockCsv('sku,stock\n,4\n').rows, [{ line: 2, ref: '', count: '4' }]);
  assert.equal(parseStockCsv('').error, 'empty');
  assert.equal(parseStockCsv('sku,stock\n').error, 'empty');
  assert.equal(parseStockCsv('name,price\nA,1\n').error, 'bad_header');
  assert.equal(parseStockCsv('sku,price\nA,1\n').error, 'bad_header');
  const big = `sku,stock\n${Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `S${i},1`).join('\n')}`;
  assert.deepEqual([parseStockCsv(big).error, parseStockCsv(big).max], ['too_many', IMPORT_MAX_ROWS]);
});

test('stock import: every row gets a verdict, only real changes are written, in atomic chunks the rules accept', () => {
  const db = baseDb();
  const rows = [
    { line: 2, ref: 'sku-1', count: '25' },        // change (lower-case SKU)
    { line: 3, ref: 'SKU-2', count: '3' },         // same
    { line: 4, ref: 'p3__v1', count: '0' },        // change (by key)
    { line: 5, ref: 'NOPE', count: '1' },          // unknown
    { line: 6, ref: 'SKU-4', count: '5' },         // untracked
    { line: 7, ref: 'SKU-5', count: '-3' },        // bad number
    { line: 8, ref: 'X', count: '1.5' },            // bad number (a switched-off unit is still counted)
    { line: 9, ref: 'SKU-1', count: '30' },        // duplicate of line 2
    { line: 10, ref: '', count: '3' },             // no reference
    { line: 11, ref: 'SKU-6', count: '2' },        // change
  ];
  const plan = planStockImport({ rows, units: units(db), actor: actor('im'), nowMs: NOW });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.items.map((i) => [i.line, i.status, i.error]), [
    [2, 'change', ''], [3, 'same', ''], [4, 'change', ''], [5, 'error', 'unknown'], [6, 'error', 'untracked'], [7, 'error', 'bad_qty'],
    [8, 'error', 'bad_qty'], [9, 'error', 'duplicate'], [10, 'error', 'no_ref'], [11, 'change', ''],
  ]);
  assert.deepEqual([plan.changes, plan.same, plan.errors], [3, 1, 6]);
  assert.deepEqual(plan.items.filter((i) => i.status === 'change').map((i) => [i.key, i.before, i.after, i.delta]), [['p1', 10, 25, 15], ['p3__v1', 20, 0, -20], ['p6', 1, 2, 1]]);
  assert.equal(plan.chunks.length, 1);
  let cur = db;
  for (const c of plan.chunks) { assert.ok(c.length <= 18, `chunk of ${c.length} ops`); cur = commit(cur, 'im', c, 'import chunk'); }
  assert.deepEqual([inv(cur, 'p1').stock, inv(cur, 'p3__v1').stock, inv(cur, 'p6').stock, inv(cur, 'p2').stock], [25, 0, 2, 3]);
  assert.deepEqual(movements(cur).map((m) => [m.key, m.type, m.delta]).sort(), [['p1', 'count', 15], ['p3__v1', 'count', -20], ['p6', 'count', 1]]);
  assert.deepEqual(audits(cur).map((a) => a.action), ['inventory.import']);
  // importing the same file again finds nothing to do (the numbers are absolute, so a repeated or resumed import cannot double-count)
  const again = planStockImport({ rows, units: units(cur), actor: actor('im'), nowMs: NOW });
  assert.deepEqual([again.changes, again.chunks.length], [0, 0]);
  assert.equal(again.same, 4, 'the three imported units and the unchanged one all match the file now');
});

test('stock import: a big count needs several chunks, each within the batch limit', () => {
  const db = baseDb();
  const many = {};
  for (let i = 0; i < 30; i++) many[`inventory/bulk${i}`] = inventoryDoc({ productId: `bulk${i}`, sku: `BULK-${i}`, stock: 1 });
  for (const [k, v] of Object.entries(many)) db.set(k, v);
  const rows = Array.from({ length: 30 }, (_, i) => ({ line: i + 2, ref: `BULK-${i}`, count: String(100 + i) }));
  const plan = planStockImport({ rows, units: units(db), actor: actor('sadm'), nowMs: NOW });
  assert.equal(plan.changes, 30);
  assert.equal(plan.chunks.length, Math.ceil(30 / UNITS_PER_CHUNK));
  let cur = db;
  for (const c of plan.chunks) { assert.ok(c.length <= 18); cur = commit(cur, 'sadm', c, 'bulk chunk'); }
  assert.equal(inv(cur, 'bulk29').stock, 129);
  assert.equal(movements(cur).length, 30);
  assert.equal(audits(cur).length, plan.chunks.length, 'one audit entry per chunk');
  for (const uid of ['pm', 'om', 'cs', 'rp']) assert.equal(planStockImport({ rows, units: units(db), actor: actor(uid), nowMs: NOW }).error, 'forbidden');
  refused(db, 'pm', plan.chunks[0], 'pm forging an import chunk');
});

/* ───────────────────────── reservation recount ───────────────────────── */

test('reservation recount: reserved follows the open orders, every correction is logged, chunks stay atomic', () => {
  const db = baseDb();
  db.set('inventory/p1', inventoryDoc({ stock: 10, reserved: 5 }));            // drift: only 2 are really held
  db.set('inventory/p2', inventoryDoc({ productId: 'p2', sku: 'SKU-2', stock: 3, reserved: 0 }));   // drift: 1 is held
  db.set('inventory/p5', inventoryDoc({ productId: 'p5', sku: 'SKU-5', stock: 50, reserved: 4 }));  // correct
  const orders = [
    { isLegacy: false, status: 'pending', items: [{ key: 'p1', qty: 2 }, { key: 'p5', qty: 1 }] },
    { isLegacy: false, status: 'packed', items: [{ key: 'p2', qty: 1 }, { key: 'p5', qty: 3 }] },
    { isLegacy: false, status: 'shipped', items: [{ key: 'p1', qty: 9 }] },      // shipped: no longer reserved
    { isLegacy: true, status: 'pending', items: [{ key: 'p1', qty: 9 }] },       // legacy orders never reserved anything
  ];
  const invByKey = Object.fromEntries(units(db).map((u) => [u.key, u.inv]));
  const plan = planReservationFix({ orders, invByKey, actor: actor('sadm'), nowMs: NOW });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.diffs.map((d) => [d.key, d.have, d.want]).sort(), [['p1', 5, 2], ['p2', 0, 1]]);
  let cur = db;
  for (const c of plan.chunks) { assert.ok(c.length <= 18); cur = commit(cur, 'sadm', c, 'recount chunk'); }
  assert.deepEqual([inv(cur, 'p1').reserved, inv(cur, 'p2').reserved, inv(cur, 'p5').reserved], [2, 1, 4]);
  assert.deepEqual([inv(cur, 'p1').stock, inv(cur, 'p2').stock], [10, 3], 'physical stock is never touched by a recount');
  assert.deepEqual(movements(cur).map((m) => [m.key, m.type, m.delta, m.reservedDelta]).sort(), [['p1', 'reserve_fix', 0, -3], ['p2', 'reserve_fix', 0, 1]]);
  assert.deepEqual(audits(cur).map((a) => a.action), ['inventory.recount']);
  assert.deepEqual(planReservationFix({ orders, invByKey: Object.fromEntries(units(cur).map((u) => [u.key, u.inv])), actor: actor('sadm'), nowMs: NOW }).chunks, [], 'a second recount finds nothing to fix');
  for (const uid of ['pm', 'om', 'cs', 'rp']) assert.equal(planReservationFix({ orders, invByKey, actor: actor(uid), nowMs: NOW }).error, 'forbidden');
});

test('sentinels used by the planners are plain operations (TS, inc) the harness understands', () => {
  assert.equal(TS.$op, 'ts');
  assert.deepEqual(inc(3), { $op: 'inc', n: 3 });
});
