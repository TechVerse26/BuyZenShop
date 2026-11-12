/*
 * The audit log viewer (js/admin/pages/audit.js) against the REAL firestore.rules, strict AND tolerant engine:
 * the page lists `auditLogs` newest first (optionally from a point in time) — only audit.read may do that, and nobody may change or remove an entry afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planReportExport, resolveRange } from '../../js/shared/reportFlow.js';
import { baseDb, commitBoth, strictEngine, tolerantEngine, NOW } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', rp: 'reporting' };
const RANGE = resolveRange({ preset: '7d', nowMs: NOW });
const listable = (db, uid) => {
  const a = uid === 'anon' ? null : { uid };
  const t = tolerantEngine.read({ db, auth: a, now: NOW, kind: 'list', key: 'auditLogs/__query__', constraints: {} });
  const s = strictEngine.read({ db, auth: a, now: NOW, kind: 'list', key: 'auditLogs/__query__', constraints: {} });
  assert.equal(t.allowed, s.allowed, `${uid}: the two engines disagree`);
  return s.allowed;
};

test('listing the audit log: Super Admin and Store Admin only — nobody else, not even a Reporting user who wrote an entry', () => {
  const db = baseDb();
  const plan = planReportExport({ kind: 'orders', count: 3, range: RANGE, actor: { uid: 'rp', email: 'rp@x.test', role: ROLE.rp } });
  const after = commitBoth(db, { uid: 'rp' }, plan.ops).strict.dbAfter;
  for (const uid of ['sa', 'sadm']) assert.equal(listable(after, uid), true, `${uid} lists the log`);
  for (const uid of ['pm', 'om', 'im', 'cs', 'rp', 'u1', 'u2', 'anon']) assert.equal(listable(after, uid), false, `${uid} may not list the log`);
});

test('an entry cannot be edited or deleted afterwards — by nobody, Super Admin included', () => {
  const db = baseDb();
  const plan = planReportExport({ kind: 'orders', count: 3, range: RANGE, actor: { uid: 'sa', email: 'sa@x.test', role: ROLE.sa } });
  const written = commitBoth(db, { uid: 'sa' }, plan.ops);
  assert.equal(written.strict.allowed, true);
  const after = written.strict.dbAfter;
  const path = [...after.m.keys()].find((k) => k.startsWith('auditLogs/'));
  for (const uid of ['sa', 'sadm']) {
    const edit = commitBoth(after, { uid }, [{ op: 'update', path, data: { summary: 'tampered' } }]);
    const drop = commitBoth(after, { uid }, [{ op: 'delete', path }]);
    assert.equal(edit.strict.allowed || edit.tolerant.allowed, false, `${uid} edits an entry`);
    assert.equal(drop.strict.allowed || drop.tolerant.allowed, false, `${uid} deletes an entry`);
  }
});
