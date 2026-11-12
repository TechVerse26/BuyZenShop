/*
 * Reports (js/shared/reportFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * a report is built in the browser from the orders the signed-in role may read (orders.read); a bulk export is one audit entry that is written before the file is handed over.
 * The planner decides WHO may export (reports.read + reports.export); the rules only guarantee that an audit entry names its real author and role, and that only audit.read reads the log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planReportExport, resolveRange } from '../../js/shared/reportFlow.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { baseDb, commitBoth, failedOps, strictEngine, tolerantEngine, NOW } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const EXPORTERS = ['sa', 'sadm', 'rp'];
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const RANGE = resolveRange({ preset: '30d', nowMs: NOW });
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const readable = (db, uid, key, kind = 'get') => {
  const a = uid === 'anon' ? null : { uid };
  const q = kind === 'list' ? { key: `${key}/__query__`, constraints: {} } : { key };
  const t = tolerantEngine.read({ db, auth: a, now: NOW, kind, ...q });
  const s = strictEngine.read({ db, auth: a, now: NOW, kind, ...q });
  assert.equal(t.allowed, s.allowed, `${uid} ${key}: the two engines disagree`);
  return s.allowed;
};

test('export audit: Super Admin, Store Admin and Reporting write one report.export entry that the rules accept — it carries the count and the period, never the rows', () => {
  for (const who of EXPORTERS) {
    const db = baseDb();
    const plan = planReportExport({ kind: 'orders', count: 12, range: RANGE, actor: actor(who) });
    assert.equal(plan.ok, true, who);
    const r = commitBoth(db, { uid: who }, plan.ops);
    assert.equal(r.strict.allowed, true, `${who} strict: ${failedOps(r.strict).join(' | ')}`);
    assert.equal(r.tolerant.allowed, true, `${who} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
    const [entry] = audits(r.strict.dbAfter);
    assert.deepEqual([entry.action, entry.entity, entry.entityId, entry.actorUid, entry.actorRole], ['report.export', 'report', 'orders', who, ROLE[who]]);
    assert.deepEqual(entry.after, { kind: 'orders', count: 12, from: RANGE.fromKey, to: RANGE.toKey });
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'actorEmail', 'actorRole', 'actorUid', 'after', 'before', 'createdAt', 'entity', 'entityId', 'summary']);
  }
});

test('export audit: an entry that names another person or another role is refused, so is one from a customer or from nobody', () => {
  const db = baseDb();
  const mine = (who, extra = {}) => ({ ...auditOp(actor(who), { action: 'report.export', entity: 'report', entityId: 'orders', summary: 'x', after: { kind: 'orders', count: 1 } }), ...extra });
  const op = (o, patch) => ({ ...o, data: { ...o.data, ...patch } });
  const refused = (uid, ops, label) => {
    const r = commitBoth(db, { uid }, ops);
    assert.equal(r.strict.allowed, false, `${label}: strict engine allowed it`);
    assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine allowed it`);
  };
  refused('rp', [op(mine('rp'), { actorRole: 'super_admin' })], 'Reporting claims to be Super Admin');
  refused('rp', [mine('sa')], 'Reporting writes an entry for Super Admin');
  refused('sadm', [op(mine('sadm'), { actorRole: 'reporting' })], 'a Store Admin with a wrong role');
  refused('u1', [mine('u1', { data: { ...mine('rp').data, actorUid: 'u1', actorRole: 'reporting' } })], 'a customer writes audit entries');
  refused('rp', [op(mine('rp'), { extra: 'field' })], 'an entry with an unknown field');
  refused('rp', [op(mine('rp'), { summary: 'x'.repeat(601) })], 'a summary over 600 characters');
});

test('what a report is built from: roles with orders.read list orders, Inventory Manager and Product Manager do not, a customer cannot list everyone’s orders', () => {
  const db = baseDb();
  for (const uid of ['sa', 'sadm', 'om', 'cs', 'rp']) assert.equal(readable(db, uid, 'orders', 'list'), true, `${uid} reads orders`);
  for (const uid of ['pm', 'im', 'u1', 'anon']) assert.equal(readable(db, uid, 'orders', 'list'), false, `${uid} may not list all orders`);
});

test('the audit log: only audit.read (Super Admin, Store Admin) reads it — a Reporting user cannot see who exported what', () => {
  const db = baseDb();
  const plan = planReportExport({ kind: 'daily', count: 7, range: RANGE, actor: actor('rp') });
  const r = commitBoth(db, { uid: 'rp' }, plan.ops);
  assert.equal(r.strict.allowed, true);
  const key = [...r.strict.dbAfter.m.keys()].find((k) => k.startsWith('auditLogs/'));
  const after = r.strict.dbAfter;
  for (const uid of ['sa', 'sadm']) assert.equal(readable(after, uid, key), true, `${uid} reads the entry`);
  for (const uid of ['rp', 'pm', 'om', 'im', 'cs', 'u1', 'anon']) assert.equal(readable(after, uid, key), false, `${uid} may not read the entry`);
});
