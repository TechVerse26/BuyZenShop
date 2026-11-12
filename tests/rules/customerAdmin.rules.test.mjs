/*
 * Customers (js/shared/customerFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * Super Admin and Store Admin (customers.write) restrict / lift a restriction, write and delete internal notes, remove newsletter subscribers;
 * Order Manager and Customer Support (customers.read) may read notes but change nothing; everyone else and every customer is refused by the RULES.
 * A restriction needs a reason and the server time, staff change nothing else on a customer, a customer never restricts anyone, notes are never edited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRestrict, planUnrestrict, planNoteAdd, planNoteDelete, planSubscriberRemove, planExport, CUSTOMER } from '../../js/shared/customerFlow.js';
import { normalizeCustomer, normalizeNote, normalizeSubscriber } from '../../js/shared/customerModel.js';
import { TS } from '../../js/shared/ops.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { baseDb, commitBoth, failedOps, strictEngine, tolerantEngine, NOW, DAY } from './harness.mjs';
import { Ts } from './rules-engine.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const WRITERS = ['sa', 'sadm'];
const READERS_ONLY = ['om', 'cs'];
const NO_ACCESS = ['pm', 'im', 'rp'];
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const under = (db, prefix) => [...db.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ id: k.split('/').pop(), ...v }));
const cust = (db, id) => normalizeCustomer(id, db.get(`users/${id}`));

function crmDb() {
  const db = baseDb();
  db.set('userPrivate/u1/notes/n1', { text: 'Prefers calls after 5 pm.', authorUid: 'sadm', authorEmail: 'sadm@x.test', createdAt: new Ts(NOW - DAY) });
  db.set('newsletter/a@example.com', { email: 'a@example.com', source: 'footer', createdAt: new Ts(NOW - DAY) });
  return db;
}
function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}
const refused = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine allowed it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine allowed it`);
};
/** the same writes, but with an audit entry that honestly names `who` — so a refusal is about the data, never about a forged audit entry */
const forge = (plan, who) => plan.ops.map((o) => (o.path.startsWith('auditLogs/') ? auditOp(actor(who), { action: 'customer.test', entity: 'customer', entityId: 'u1', summary: 'forged' }) : o));
const readable = (db, uid, key, kind = 'get') => {
  const a = uid === 'anon' ? null : { uid };
  const q = kind === 'list' ? { key: `${key}/__query__`, constraints: {} } : { key };   // a list read is checked against the collection's "query" document
  const t = tolerantEngine.read({ db, auth: a, now: NOW, kind, ...q });
  const s = strictEngine.read({ db, auth: a, now: NOW, kind, ...q });
  assert.equal(t.allowed, s.allowed, `${uid} ${key}: the two engines disagree`);
  return s.allowed;
};

/* ───────────────────────── restrict ───────────────────────── */

test('restrict: Super Admin and Store Admin set the flags with the server time, tidy the reason and leave one audit entry', () => {
  for (const who of WRITERS) {
    const db = crmDb();
    const plan = planRestrict({ customer: cust(db, 'u1'), reason: '  Two fake   orders \n in a week ', actor: actor(who) });
    assert.equal(plan.ok, true);
    const after = commit(db, who, plan.ops, `restrict by ${who}`);
    const u = cust(after, 'u1');
    assert.equal(u.restricted, true);
    assert.equal(u.restrictedReason, 'Two fake orders in a week');
    assert.equal(u.restrictedMs, NOW);
    assert.equal(after.get('users/u1').displayName, 'Rahim', 'nothing else on the customer changes');
    const log = audits(after);
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].action, log[0].entity, log[0].entityId, log[0].actorUid, log[0].actorRole], ['customer.restrict', 'customer', 'u1', who, ROLE[who]]);
    assert.deepEqual(log[0].after, { restricted: true, reason: 'Two fake orders in a week' });
  }
});

test('restrict: every other role is refused by the planner AND by the rules', () => {
  for (const who of [...READERS_ONLY, ...NO_ACCESS]) {
    const db = crmDb();
    assert.equal(planRestrict({ customer: cust(db, 'u1'), reason: 'Fraud', actor: actor(who) }).error, 'forbidden', who);
    const real = planRestrict({ customer: cust(db, 'u1'), reason: 'Fraud', actor: actor('sa') });
    refused(db, who, forge(real, who), `restrict by ${who}`);
  }
});

test('restrict: the RULES insist on a reason of 3–200 characters and on the server time', () => {
  const db = crmDb();
  const flags = (over) => [{ op: 'update', path: 'users/u1', data: { restricted: true, restrictedReason: 'Fake orders', restrictedAt: TS, updatedAt: TS, ...over } }];
  commit(db, 'sa', flags({}), 'control: a proper restriction');
  refused(db, 'sa', flags({ restrictedReason: undefined }), 'no reason');
  refused(db, 'sa', flags({ restrictedReason: '' }), 'empty reason');
  refused(db, 'sa', flags({ restrictedReason: 'ab' }), 'two characters');
  refused(db, 'sa', flags({ restrictedReason: 'x'.repeat(201) }), '201 characters');
  refused(db, 'sa', flags({ restrictedAt: new Ts(NOW - 1000) }), 'a client clock instead of the server time');
  refused(db, 'sa', flags({ restricted: 'yes' }), 'not a boolean');
  commit(db, 'sa', flags({ restrictedReason: 'x'.repeat(200) }), '200 characters is fine');
});

test('restrict: staff change nothing else on a customer', () => {
  const db = crmDb();
  refused(db, 'sa', [{ op: 'update', path: 'users/u1', data: { displayName: 'Hacked', updatedAt: TS } }], 'rename');
  refused(db, 'sa', [{ op: 'update', path: 'users/u1', data: { restricted: true, restrictedReason: 'Fraud', restrictedAt: TS, email: 'x@y.z', updatedAt: TS } }], 'flags plus e-mail');
  refused(db, 'sa', [{ op: 'update', path: 'users/u1', data: { lastOrderAt: TS } }], 'lastOrderAt');
  refused(db, 'sa', [{ op: 'delete', path: 'users/u1' }], 'delete a customer');
});

test('restrict: a customer cannot restrict anybody, not even themselves', () => {
  const db = crmDb();
  const flags = [{ op: 'update', path: 'users/u1', data: { restricted: true, restrictedReason: 'Fraud', restrictedAt: TS, updatedAt: TS } }];
  refused(db, 'u1', flags, 'own account');
  refused(db, 'u2', flags, "someone else's account");
});

test('restrict: the planner refuses a missing reason, yourself and an account that is already restricted', () => {
  const db = crmDb();
  const c = cust(db, 'u1');
  assert.deepEqual(planRestrict({ customer: c, reason: '   ', actor: actor('sa') }), { ok: false, error: 'invalid', errors: { reason: 'required' } });
  assert.deepEqual(planRestrict({ customer: c, reason: 'ab', actor: actor('sa') }).errors, { reason: 'too_short' });
  assert.deepEqual(planRestrict({ customer: c, reason: 'x'.repeat(CUSTOMER.REASON_MAX + 1), actor: actor('sa') }).errors, { reason: 'too_long' });
  assert.equal(planRestrict({ customer: { ...c, id: 'sa' }, reason: 'Fraud', actor: actor('sa') }).error, 'self');
  assert.equal(planRestrict({ customer: cust(db, 'ur'), reason: 'Fraud', actor: actor('sa') }).error, 'no_change');
  assert.equal(planRestrict({ customer: null, reason: 'Fraud', actor: actor('sa') }).error, 'not_found');
});

/* ───────────────────────── lift ───────────────────────── */

test('lift: the flags go, the checkout works again, one audit entry keeps the old reason', () => {
  for (const who of WRITERS) {
    const db = crmDb();
    db.set('users/ur', { ...db.get('users/ur'), restrictedReason: 'Fake orders', restrictedAt: new Ts(NOW - DAY) });
    const plan = planUnrestrict({ customer: cust(db, 'ur'), actor: actor(who) });
    assert.equal(plan.ok, true);
    const after = commit(db, who, plan.ops, `lift by ${who}`);
    const u = after.get('users/ur');
    assert.equal(u.restricted, false);
    assert.equal('restrictedReason' in u, false);
    assert.equal('restrictedAt' in u, false);
    const [log] = audits(after);
    assert.deepEqual([log.action, log.before], ['customer.unrestrict', { restricted: true, reason: 'Fake orders' }]);
  }
});

test('lift: other roles are refused; an account that is not restricted has nothing to lift', () => {
  for (const who of [...READERS_ONLY, ...NO_ACCESS]) {
    const db = crmDb();
    assert.equal(planUnrestrict({ customer: cust(db, 'ur'), actor: actor(who) }).error, 'forbidden');
    refused(db, who, forge(planUnrestrict({ customer: cust(db, 'ur'), actor: actor('sa') }), who), `lift by ${who}`);
  }
  assert.equal(planUnrestrict({ customer: cust(crmDb(), 'u1'), actor: actor('sa') }).error, 'no_change');
});

/* ───────────────────────── notes ───────────────────────── */

test('notes: Super Admin and Store Admin write one; the audit entry records that it was written, never what it says', () => {
  for (const who of WRITERS) {
    const db = crmDb();
    const plan = planNoteAdd({ customer: cust(db, 'u2'), text: '  Asked us to leave the parcel\r\nwith the neighbour.  ', actor: actor(who), noteId: 'N9' });
    assert.equal(plan.ok, true);
    const after = commit(db, who, plan.ops, `note by ${who}`);
    const note = normalizeNote('N9', after.get('userPrivate/u2/notes/N9'));
    assert.deepEqual([note.text, note.authorUid, note.authorEmail, note.createdMs], ['Asked us to leave the parcel\nwith the neighbour.', who, `${who}@x.test`, NOW]);
    const log = audits(after);
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'customer.note_add');
    assert.deepEqual(log[0].after, { length: note.text.length });
    assert.equal(JSON.stringify(log).includes('neighbour'), false, 'the audit log never carries the note');
  }
});

test('notes: the other roles are refused by the planner and by the rules', () => {
  for (const who of [...READERS_ONLY, ...NO_ACCESS]) {
    const db = crmDb();
    assert.equal(planNoteAdd({ customer: cust(db, 'u1'), text: 'hi', actor: actor(who) }).error, 'forbidden');
    const real = planNoteAdd({ customer: cust(db, 'u1'), text: 'hi', actor: actor('sa'), noteId: 'X1' });
    refused(db, who, forge(real, who), `note by ${who}`);
  }
});

test('notes: only people with customers.read can read them — never the customer', () => {
  const db = crmDb();
  for (const who of ['sa', 'sadm', 'om', 'cs']) {
    assert.equal(readable(db, who, 'userPrivate/u1/notes/n1'), true, `${who} reads a note`);
    assert.equal(readable(db, who, 'userPrivate/u1/notes', 'list'), true, `${who} lists the notes`);
  }
  for (const who of ['pm', 'im', 'rp', 'u1', 'u2', 'anon', 'off']) {
    assert.equal(readable(db, who, 'userPrivate/u1/notes/n1'), false, `${who} must not read a note`);
    assert.equal(readable(db, who, 'userPrivate/u1/notes', 'list'), false, `${who} must not list the notes`);
  }
});

test('notes: the shape is enforced — own uid, server time, 1–1000 characters, no extra keys, never edited', () => {
  const db = crmDb();
  const note = (over) => [{ op: 'set', path: 'userPrivate/u1/notes/N2', data: { text: 'Call back', authorUid: 'sa', authorEmail: 'sa@x.test', createdAt: TS, ...over } }];
  commit(db, 'sa', note({}), 'control');
  refused(db, 'sa', note({ authorUid: 'sadm' }), "someone else's name on it");
  refused(db, 'sa', note({ text: '' }), 'empty');
  refused(db, 'sa', note({ text: 'x'.repeat(1001) }), '1001 characters');
  refused(db, 'sa', note({ pinned: true }), 'an extra key');
  refused(db, 'sa', note({ createdAt: new Ts(NOW - DAY) }), 'a back-dated note');
  commit(db, 'sa', note({ text: 'x'.repeat(1000) }), '1000 characters is fine');
  for (const who of ['sa', 'sadm']) refused(db, who, [{ op: 'update', path: 'userPrivate/u1/notes/n1', data: { text: 'edited' } }], `edit by ${who}`);
});

test('notes: Super Admin and Store Admin delete one (audited), the others cannot', () => {
  for (const who of WRITERS) {
    const db = crmDb();
    const note = normalizeNote('n1', db.get('userPrivate/u1/notes/n1'));
    const plan = planNoteDelete({ customer: cust(db, 'u1'), note, actor: actor(who) });
    assert.equal(plan.ok, true);
    const after = commit(db, who, plan.ops, `delete by ${who}`);
    assert.equal(after.get('userPrivate/u1/notes/n1'), undefined);
    const [log] = audits(after);
    assert.deepEqual([log.action, log.before], ['customer.note_delete', { authorUid: 'sadm', length: note.text.length }]);
    assert.equal(JSON.stringify(log).includes('calls after'), false);
  }
  for (const who of [...READERS_ONLY, ...NO_ACCESS]) {
    const db = crmDb();
    const note = normalizeNote('n1', db.get('userPrivate/u1/notes/n1'));
    assert.equal(planNoteDelete({ customer: cust(db, 'u1'), note, actor: actor(who) }).error, 'forbidden');
    refused(db, who, forge(planNoteDelete({ customer: cust(db, 'u1'), note, actor: actor('sa') }), who), `delete by ${who}`);
  }
});

/* ───────────────────────── newsletter + export ───────────────────────── */

test('newsletter: Super Admin and Store Admin remove a subscriber (the audit entry hides most of the address); the others cannot', () => {
  for (const who of WRITERS) {
    const db = crmDb();
    const sub = normalizeSubscriber('a@example.com', db.get('newsletter/a@example.com'));
    const plan = planSubscriberRemove({ subscriber: sub, actor: actor(who) });
    assert.equal(plan.ok, true);
    const after = commit(db, who, plan.ops, `remove by ${who}`);
    assert.equal(after.get('newsletter/a@example.com'), undefined);
    const [log] = audits(after);
    assert.equal(log.action, 'newsletter.remove');
    assert.equal(JSON.stringify(log).includes('a@example.com'), false, 'the full address is not kept in the audit log');
  }
  for (const who of [...READERS_ONLY, ...NO_ACCESS, 'u1']) {
    const db = crmDb();
    const sub = normalizeSubscriber('a@example.com', db.get('newsletter/a@example.com'));
    if (who !== 'u1') assert.equal(planSubscriberRemove({ subscriber: sub, actor: actor(who) }).error, 'forbidden');
    refused(db, who, [{ op: 'delete', path: 'newsletter/a@example.com' }], `remove by ${who}`);
  }
});

test('export: only roles with customers.read AND reports.export — one audit entry, no data', () => {
  for (const who of WRITERS) {
    const db = crmDb();
    const plan = planExport({ kind: 'customers', count: 42, actor: actor(who) });
    assert.equal(plan.ok, true);
    const after = commit(db, who, plan.ops, `export by ${who}`);
    const [log] = audits(after);
    assert.deepEqual([log.action, log.entity, log.after], ['customer.export', 'customer', { count: 42 }]);
  }
  for (const who of [...READERS_ONLY, ...NO_ACCESS]) assert.equal(planExport({ kind: 'customers', count: 1, actor: actor(who) }).error, 'forbidden', `${who}: reporting has reports.export but not customers.read; the rest have no export right`);
  assert.equal(planExport({ kind: 'orders', count: 1, actor: actor('sa') }).error, 'invalid');
  assert.equal(planExport({ kind: 'subscribers', count: -1, actor: actor('sa') }).error, 'invalid');
  assert.equal(planExport({ kind: 'subscribers', count: 3, actor: actor('sadm') }).action, 'newsletter.export');
});
