/*
 * Staff & roles (js/shared/staffFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * a Super Admin adds, changes, switches off and removes staff in one batch with an audit entry;
 * nobody else can; the document shape is fixed; the planner refuses the lock-out mistakes the rules cannot see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planStaffSave, planStaffRemove, validateStaffForm, lastActiveSuperAdmin, permissionMatrix, STAFF_UID_PATTERN } from '../../js/shared/staffFlow.js';
import { TS } from '../../js/shared/ops.js';
import { ROLE_IDS, PERMISSION_IDS, roleCan } from '../../js/shared/constants.js';
import { baseDb, commitBoth, failedOps, NOW, strictEngine, tolerantEngine } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] || (uid === 'sa2' ? 'super_admin' : undefined) });
const staffList = (db) => [...db.m.entries()].filter(([k]) => /^staff\/[^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);

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
const create = (db, over = {}, who = 'sa') => planStaffSave({
  creating: true, form: { uid: 'newstaff0001', email: 'New.Person@Example.com', name: '  New   Person ', role: 'order_manager', ...over }, staff: staffList(db), actor: actor(who),
});

test('create: the document has exactly the allowed fields, the e-mail is lower-cased, one audit entry is written', () => {
  const db = baseDb();
  const p = create(db);
  assert.equal(p.ok, true);
  assert.equal(p.ops.length, 2);
  assert.deepEqual(Object.keys(p.ops[0].data).sort(), ['active', 'createdAt', 'createdBy', 'email', 'name', 'role', 'updatedAt']);
  const after = commit(db, 'sa', p.ops, 'create');
  const s = after.get('staff/newstaff0001');
  assert.deepEqual([s.role, s.active, s.email, s.name, s.createdBy], ['order_manager', true, 'new.person@example.com', 'New Person', 'sa']);
  assert.deepEqual(audits(after).map((a) => [a.action, a.entityId, a.actorRole, a.after.role]), [['staff.create', 'newstaff0001', 'super_admin', 'order_manager']]);
});

test('update: role change, switch off and switch on are accepted and named in the audit log', () => {
  let db = baseDb();
  db = commit(db, 'sa', create(db).ops, 'create');
  const current = () => ({ id: 'newstaff0001', ...db.get('staff/newstaff0001') });
  const save = (form, who = 'sa') => planStaffSave({ uid: 'newstaff0001', form, current: current(), staff: staffList(db), actor: actor(who) });

  const role = save({ email: 'new.person@example.com', name: 'New Person', role: 'store_admin', active: true });
  assert.deepEqual([role.ok, role.action], [true, 'staff.role']);
  db = commit(db, 'sa', role.ops, 'role');
  assert.equal(db.get('staff/newstaff0001').role, 'store_admin');

  const off = save({ email: 'new.person@example.com', name: 'New Person', role: 'store_admin', active: false });
  assert.equal(off.action, 'staff.deactivate');
  db = commit(db, 'sa', off.ops, 'off');
  assert.equal(db.get('staff/newstaff0001').active, false);
  assert.equal(strictEngine.read({ db, auth: { uid: 'newstaff0001' }, now: NOW, key: 'staff/newstaff0001' }).allowed, true, 'a switched-off member can still read their own record');
  assert.equal(strictEngine.read({ db, auth: { uid: 'newstaff0001' }, now: NOW, key: 'orders/SV-261026-AAAAAA' }).allowed, false, 'and nothing else');

  const on = save({ email: 'new.person@example.com', name: 'New Person', role: 'store_admin', active: true });
  assert.equal(on.action, 'staff.activate');
  db = commit(db, 'sa', on.ops, 'on');

  const name = save({ email: 'new.person@example.com', name: 'Renamed', role: 'store_admin', active: true });
  assert.equal(name.action, 'staff.update');
  db = commit(db, 'sa', name.ops, 'rename');
  assert.deepEqual(audits(db).map((a) => a.action).sort(), ['staff.activate', 'staff.create', 'staff.deactivate', 'staff.role', 'staff.update']);
  assert.equal(save({ email: 'new.person@example.com', name: 'Renamed', role: 'store_admin', active: true }).error, 'no_change');
});

test('only a Super Admin may write staff — every other role is refused, even with a perfect batch', () => {
  const db = baseDb();
  for (const uid of ['sadm', 'pm', 'om', 'im', 'cs', 'rp', 'off', 'u1']) {
    const ops = planStaffSave({ creating: true, form: { uid: 'x1234567', email: 'x@y.test', role: 'reporting' }, staff: [], actor: { uid: 'sa', email: 'sa@x.test', role: 'super_admin' } }).ops;
    const forged = ops.map((o) => (o.path.startsWith('auditLogs/') ? { ...o, data: { ...o.data, actorUid: uid, actorRole: ROLE[uid] || 'store_admin' } } : o));
    refused(db, uid, forged, `${uid} creating staff`);
  }
  // the planner itself refuses first
  assert.equal(create(db, {}, 'sadm').error, 'forbidden');
  assert.equal(planStaffRemove({ uid: 'off', current: { role: 'store_admin', active: false }, staff: [], actor: actor('om') }).error, 'forbidden');
  // privilege escalation: a store admin promoting themselves
  refused(db, 'sadm', [{ op: 'update', path: 'staff/sadm', data: { role: 'super_admin', updatedAt: TS } }], 'self-promotion');
});

test('the shape is fixed: unknown fields, bad roles and non-boolean flags are refused by the rules', () => {
  const db = baseDb();
  const base = { role: 'reporting', active: true, email: 'a@b.test', name: 'A', createdAt: TS, updatedAt: TS, createdBy: 'sa' };
  commit(db, 'sa', [{ op: 'set', path: 'staff/ok123456', data: base }], 'baseline shape is fine');
  refused(db, 'sa', [{ op: 'set', path: 'staff/bad1', data: { ...base, permissions: ['*'] } }], 'extra field');
  refused(db, 'sa', [{ op: 'set', path: 'staff/bad2', data: { ...base, role: 'owner' } }], 'unknown role');
  refused(db, 'sa', [{ op: 'set', path: 'staff/bad3', data: { ...base, active: 'yes' } }], 'active is not a boolean');
  refused(db, 'sa', [{ op: 'update', path: 'staff/om', data: { admin: true } }], 'unknown field on update');
});

test('validation: every field is explained by a code, nothing is written', () => {
  assert.deepEqual(validateStaffForm({ uid: '', email: '', role: '' }, { creating: true }).errors, { uid: 'required', email: 'required', role: 'bad_role' });
  assert.deepEqual(validateStaffForm({ uid: 'a/b', email: 'nope', role: 'reporting' }, { creating: true }).errors, { uid: 'bad_uid', email: 'bad_email' });
  assert.equal(validateStaffForm({ uid: 'abcdef', email: 'a@b.test', role: 'reporting', name: 'x'.repeat(81) }, { creating: true }).errors.name, 'too_long');
  assert.equal(validateStaffForm({ email: 'a@b.test', role: 'reporting' }, { creating: false }).ok, true, 'the uid is only checked when creating');
  assert.equal(validateStaffForm({ email: '', role: 'reporting' }, { creating: false }).ok, true, 'a record made by hand without an e-mail can still be edited');
  assert.equal(validateStaffForm({ email: 'nope', role: 'reporting' }, { creating: false }).errors.email, 'bad_email');
  for (const bad of ['.', '..', '__x__', '-abc', 'a'.repeat(129), 'a b', 'a/b']) assert.equal(STAFF_UID_PATTERN.test(bad), false, bad);
  for (const good of ['u1', 'AbCdEfGhIjKlMnOpQrStUvWxYz12', 'user_1.test']) assert.equal(STAFF_UID_PATTERN.test(good), true, good);
  const db = baseDb();
  assert.equal(create(db, { uid: 'sa' }).error, 'exists', 'an existing member cannot be "created" again');
  assert.equal(create(db, { role: 'god' }).error, 'invalid');
  const dup = planStaffSave({ creating: true, form: { uid: 'newstaff0001', email: 'a@b.test', role: 'reporting' }, staff: [{ id: 'newstaff0001', role: 'reporting', active: true }], actor: actor('sa') });
  assert.equal(dup.error, 'exists');
});

test('lock-out guards: nobody edits their own role or switch, the last Super Admin stays, only switched-off members are removed', () => {
  const db = baseDb();
  const staff = staffList(db);
  const sa = { id: 'sa', ...db.get('staff/sa') };
  const save = (uid, form, who = 'sa', list = staff) => planStaffSave({ uid, form, current: list.find((s) => s.id === uid) || null, staff: list, actor: actor(who) });

  assert.equal(save('sa', { email: 'sa@x.test', role: 'store_admin' }).error, 'self_change', 'cannot demote yourself');
  assert.equal(save('sa', { email: 'sa@x.test', role: 'super_admin', active: false }).error, 'self_change', 'cannot switch yourself off');
  assert.equal(save('sa', { email: 'sa@x.test', name: 'Me', role: 'super_admin', active: true }).ok, true, 'but you may fix your own name and e-mail');

  // a second Super Admin exists: the first may be demoted by the second, not by itself
  const two = [...staff, { id: 'sa2', role: 'super_admin', active: true, email: 'sa2@x.test' }];
  assert.equal(lastActiveSuperAdmin(two, 'sa'), false);
  assert.equal(save('sa', { email: 'sa@x.test', role: 'store_admin' }, 'sa2', two).ok, true);
  // the only Super Admin cannot be demoted, switched off or removed by anyone
  const solo = staff.filter((s) => s.role !== 'super_admin' || s.id === 'sa');
  assert.equal(lastActiveSuperAdmin(solo, 'sa'), true);
  assert.equal(planStaffSave({ uid: 'sa', form: { email: 'sa@x.test', role: 'store_admin' }, current: sa, staff: solo, actor: { uid: 'someone-else', email: 'e@x.test', role: 'super_admin' } }).error, 'last_super_admin');
  assert.equal(planStaffSave({ uid: 'sa', form: { email: 'sa@x.test', role: 'super_admin', active: false }, current: sa, staff: solo, actor: { uid: 'someone-else', email: 'e@x.test', role: 'super_admin' } }).error, 'last_super_admin');

  // removal
  const current = (uid) => staff.find((s) => s.id === uid);
  assert.equal(planStaffRemove({ uid: 'om', current: current('om'), staff, actor: actor('sa') }).error, 'not_inactive', 'switch off first');
  assert.equal(planStaffRemove({ uid: 'sa', current: sa, staff, actor: actor('sa') }).error, 'self_change');
  assert.equal(planStaffRemove({ uid: 'ghost', current: null, staff, actor: actor('sa') }).error, 'not_found');
  const rm = planStaffRemove({ uid: 'off', current: current('off'), staff, actor: actor('sa') });
  assert.equal(rm.ok, true);
  const after = commit(db, 'sa', rm.ops, 'remove');
  assert.equal(after.has('staff/off'), false);
  assert.deepEqual(audits(after).map((a) => [a.action, a.entityId, a.before.role]), [['staff.remove', 'off', 'store_admin']]);
});

test('reading: staff are listed by Super Admins only; everyone reads just their own record', () => {
  const db = baseDb();
  const read = (uid, key, kind = 'get') => ({
    strict: strictEngine.read({ db, auth: { uid }, now: NOW, key, kind }).allowed,
    tolerant: tolerantEngine.read({ db, auth: { uid }, now: NOW, key, kind }).allowed,
  });
  for (const uid of Object.keys(ROLE)) {
    const mayManage = uid === 'sa';
    assert.deepEqual(read(uid, 'staff/sa', 'list'), { strict: mayManage, tolerant: mayManage }, `${uid} lists staff`);
    assert.deepEqual(read(uid, uid === 'pm' ? 'staff/om' : 'staff/pm'), { strict: mayManage, tolerant: mayManage }, `${uid} reads someone else`);
    assert.deepEqual(read(uid, `staff/${uid}`), { strict: true, tolerant: true }, `${uid} reads their own record`);
  }
  assert.deepEqual(read('u1', 'staff/sa'), { strict: false, tolerant: false }, 'a customer reads nothing');
});

test('the reference table matches the roles: every permission is listed once, Super Admin holds all of them', () => {
  const m = permissionMatrix();
  const ids = m.flatMap((g) => g.perms.map((p) => p.id));
  assert.deepEqual([...ids].sort(), [...PERMISSION_IDS].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const g of m) for (const p of g.perms) {
    assert.deepEqual(p.roles, ROLE_IDS.filter((r) => roleCan(r, p.id)));
    assert.ok(p.roles.includes('super_admin'), `${p.id} reaches Super Admin`);
  }
  assert.deepEqual(m.find((g) => g.group === 'system').perms.find((p) => p.id === 'staff.manage').roles, ['super_admin'], 'only Super Admin manages staff');
  assert.deepEqual(m.find((g) => g.group === 'system').perms.find((p) => p.id === 'migrate.run').roles, ['super_admin'], 'only Super Admin migrates');
});
