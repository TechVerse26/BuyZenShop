/*
 * Shipping zones (js/shared/shippingFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * Super Admin, Store Admin and Order Manager change zones in one batch with an audit entry; every other role and every customer is
 * refused by the RULES (not only by the planner); the planner enforces what the rules cannot see (bounds, one active zone per district).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateZoneForm, planZoneSave, planZoneActive, planZoneRemove, coverage, exclusiveDistricts, overlaps, ZONE_LIMITS,
} from '../../js/shared/shippingFlow.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { defaultZones } from '../../js/shared/migration.js';
import { DISTRICTS } from '../../js/shared/constants.js';
import { baseDb, commitBoth, failedOps } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const zonesOf = (db) => [...db.m.entries()].filter(([k]) => /^shippingZones\/[^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const inOrder = (...names) => DISTRICTS.filter((d) => names.includes(d));
// two districts no seeded zone holds (baseDb zones: Sirajganj · Dhaka, Bogura, Chattogram · Sylhet (switched off))
const [D1, D2] = DISTRICTS.filter((d) => !['Sirajganj', 'Dhaka', 'Bogura', 'Chattogram', 'Sylhet'].includes(d));

function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}

const good = { name: ' Rajshahi   Express ', districts: [D1, D2], fee: '90', freeOver: '', etaMin: '2', etaMax: 4, active: true };
const create = (db, over = {}, who = 'sa') => planZoneSave({ creating: true, form: { ...good, districts: [D1], ...over }, zones: zonesOf(db), actor: actor(who) });

test('validate: a good form is normalised — spaces collapsed, numbers parsed, empty free-over → null, districts in canonical order', () => {
  const v = validateZoneForm({ ...good, districts: [D2, D1, D1] }, { zones: [] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.values, { name: 'Rajshahi Express', districts: inOrder(D1, D2), fee: 90, freeOver: null, etaMin: 2, etaMax: 4, active: true });
});

test('validate: every field is bounded and says which rule it broke', () => {
  const bad = (patch, field, code) => {
    const v = validateZoneForm({ ...good, ...patch }, { zones: [] });
    assert.equal(v.ok, false, JSON.stringify(patch));
    assert.equal(v.errors[field], code, JSON.stringify(patch));
  };
  bad({ name: '' }, 'name', 'required'); bad({ name: '   ' }, 'name', 'required'); bad({ name: 'x'.repeat(61) }, 'name', 'too_long');
  bad({ districts: [] }, 'districts', 'none'); bad({ districts: undefined }, 'districts', 'none'); bad({ districts: ['Atlantis'] }, 'districts', 'bad_district');
  bad({ fee: '' }, 'fee', 'required'); bad({ fee: null }, 'fee', 'required');
  for (const fee of [-1, 5001, 12.5, 'abc', NaN]) bad({ fee }, 'fee', 'bad_fee');
  for (const freeOver of [0, -5, 1000001, 'x', 99.5]) bad({ freeOver }, 'freeOver', 'bad_free_over');
  bad({ etaMin: '' }, 'etaMin', 'required'); bad({ etaMax: null }, 'etaMax', 'required');
  for (const n of [-1, 61, 1.5, 'x']) { bad({ etaMin: n }, 'etaMin', 'bad_eta'); bad({ etaMax: n }, 'etaMax', 'bad_eta'); }
  bad({ etaMin: 5, etaMax: 2 }, 'etaMax', 'eta_order');
});

test('validate: the limits themselves are allowed', () => {
  for (const patch of [{ fee: 0 }, { fee: ZONE_LIMITS.feeMax }, { freeOver: 1 }, { freeOver: ZONE_LIMITS.freeOverMax }, { etaMin: 0, etaMax: 0 }, { etaMin: 60, etaMax: 60 }, { name: 'x'.repeat(60) }]) {
    assert.equal(validateZoneForm({ ...good, ...patch }, { zones: [] }).ok, true, JSON.stringify(patch));
  }
});

test('validate: a district belongs to ONE active zone — overlap names the zone; a switched-off zone may overlap; a zone never clashes with itself', () => {
  const zones = zonesOf(baseDb());
  const v = validateZoneForm({ ...good, districts: ['Dhaka', D1] }, { zones });
  assert.equal(v.ok, false);
  assert.equal(v.errors.districts, 'overlap');
  assert.deepEqual(v.overlap, [{ district: 'Dhaka', zoneId: 'out', zoneName: 'Outside Sirajganj' }]);
  assert.equal(validateZoneForm({ ...good, districts: ['Dhaka'], active: false }, { zones }).ok, true, 'switched off: may overlap');
  assert.equal(validateZoneForm({ ...good, name: 'Outside Sirajganj', districts: ['Dhaka', 'Bogura'] }, { zones, id: 'out' }).ok, true, 'editing the zone itself');
  assert.equal(validateZoneForm({ ...good, districts: ['Sylhet'] }, { zones }).ok, true, 'Sylhet is held by a switched-off zone only');
  assert.deepEqual(overlaps(zones, null, ['Sylhet', 'Sirajganj']).map((o) => o.zoneId), ['in']);
});

test('validate: zone names are unique, ignoring case and extra spaces', () => {
  const zones = zonesOf(baseDb());
  assert.equal(validateZoneForm({ ...good, name: ' outside   SIRAJGANJ ' }, { zones }).errors.name, 'name_taken');
  assert.equal(validateZoneForm({ ...good, name: 'Outside Sirajganj', districts: [D1] }, { zones, id: 'out' }).ok, true);
});

test('create: the id is a slug of the name, sort follows the existing zones, exactly the allowed fields, one audit entry', () => {
  const db = baseDb();
  const p = create(db);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual([p.id, p.action, p.ops.length], ['rajshahi-express', 'shipping.create', 2]);
  assert.deepEqual(Object.keys(p.ops[0].data).sort(), ['active', 'districts', 'etaMax', 'etaMin', 'fee', 'freeOver', 'name', 'sort', 'updatedAt']);
  const after = commit(db, 'sa', p.ops, 'create');
  const z = after.get('shippingZones/rajshahi-express');
  assert.deepEqual([z.name, z.fee, z.freeOver, z.etaMin, z.etaMax, z.active, z.sort, z.districts], ['Rajshahi Express', 90, null, 2, 4, true, 1, [D1]]);
  assert.deepEqual(audits(after).map((a) => [a.action, a.entity, a.entityId, a.actorRole]), [['shipping.create', 'shipping_zone', 'rajshahi-express', 'super_admin']]);
});

test('create: ids never collide (…-2), a name without letters falls back to "zone", a Bengali name still gets a usable id', () => {
  let db = baseDb();
  db = commit(db, 'sa', create(db).ops, 'first');
  const second = create(db, { name: 'Rajshahi-Express', districts: [D2] });
  assert.equal(second.ok, true);
  assert.equal(second.id, 'rajshahi-express-2');
  assert.equal(create(db, { name: '***', districts: [D2] }).id, 'zone');
  const bn = create(db, { name: 'ঢাকা সিটি', districts: [D2] });
  assert.equal(bn.ok, true);
  assert.match(bn.id, /^[a-z0-9-]{1,40}$/);
});

test('who may write zones: Super Admin, Store Admin and Order Manager; every other role is refused by the RULES themselves', () => {
  const db = baseDb();
  const p = create(db);
  const batch = (uid) => [p.ops[0], auditOp(actor(uid), { action: 'shipping.create', entity: 'shipping_zone', entityId: p.id, summary: 'forged' })];
  for (const uid of ['sa', 'sadm', 'om']) commit(db, uid, batch(uid), uid);
  for (const uid of ['pm', 'im', 'cs', 'rp']) {
    const r = commitBoth(db, { uid }, batch(uid));
    for (const [engine, res] of [['strict', r.strict], ['tolerant', r.tolerant]]) {
      assert.equal(res.allowed, false, `${uid} ${engine}`);
      assert.ok(failedOps(res).some((s) => s.includes('shippingZones/')), `${uid} ${engine}: the zone write itself must be what is refused — ${failedOps(res).join(' | ')}`);
    }
    assert.equal(create(db, {}, uid).error, 'forbidden', `${uid}: the planner refuses too`);
  }
  const customer = commitBoth(db, { uid: 'u1' }, [p.ops[0]]);
  assert.equal(customer.strict.allowed, false);
  assert.equal(customer.tolerant.allowed, false);
  assert.equal(commitBoth(db, null, [p.ops[0]]).strict.allowed, false, 'signed out');
});

test('edit: fee, free-over, delivery time and districts change in one batch; the audit entry says what changed', () => {
  let db = baseDb();
  const p = planZoneSave({
    id: 'out', zones: zonesOf(db), actor: actor('om'),
    form: { name: 'Outside Sirajganj', districts: ['Bogura', 'Chattogram'], fee: 140, freeOver: 6000, etaMin: 2, etaMax: 6, active: true },
  });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.action, 'shipping.update');
  assert.deepEqual(Object.keys(p.ops[0].data).sort(), ['active', 'districts', 'etaMax', 'etaMin', 'fee', 'freeOver', 'name', 'updatedAt'], 'sort is not touched');
  db = commit(db, 'om', p.ops, 'edit');
  const z = db.get('shippingZones/out');
  assert.deepEqual([z.fee, z.freeOver, z.etaMin, z.etaMax, z.districts], [140, 6000, 2, 6, inOrder('Bogura', 'Chattogram')]);
  const a = audits(db)[0];
  assert.equal(a.action, 'shipping.update');
  assert.match(a.summary, /fee 130 → 140/);
  assert.match(a.summary, /free over 5000 → 6000/);
  assert.match(a.summary, /−1 district \(Dhaka\)/);
  assert.deepEqual([a.before.fee, a.after.fee, a.before.districts, a.after.districts], [130, 140, 3, 2]);
});

test('edit: taking a district from another active zone is refused and names the zone; no_change; not_found', () => {
  const zones = zonesOf(baseDb());
  const grab = planZoneSave({ id: 'in', zones, actor: actor('sa'), form: { name: 'Inside Sirajganj', districts: ['Sirajganj', 'Dhaka'], fee: 70, freeOver: null, etaMin: 1, etaMax: 2, active: true } });
  assert.deepEqual([grab.ok, grab.error, grab.errors], [false, 'invalid', { districts: 'overlap' }]);
  assert.deepEqual(grab.overlap, [{ district: 'Dhaka', zoneId: 'out', zoneName: 'Outside Sirajganj' }]);
  const full = [{ id: 'z', name: 'Z', districts: ['Dhaka'], fee: 80, freeOver: null, etaMin: 1, etaMax: 2, active: true, sort: 1 }];
  assert.equal(planZoneSave({ id: 'z', zones: full, actor: actor('sa'), form: { name: ' Z ', districts: ['Dhaka'], fee: '80', freeOver: '', etaMin: 1, etaMax: 2, active: true } }).error, 'no_change');
  assert.equal(planZoneSave({ id: 'nope', zones: full, actor: actor('sa'), form: good }).error, 'not_found');
});

test('edit: switching a zone off through the form is named "deactivate"; renaming keeps the id', () => {
  const full = [{ id: 'z', name: 'Z', districts: ['Dhaka'], fee: 80, freeOver: null, etaMin: 1, etaMax: 2, active: true, sort: 1 }];
  const same = { name: 'Z', districts: ['Dhaka'], fee: 80, freeOver: null, etaMin: 1, etaMax: 2 };
  assert.equal(planZoneSave({ id: 'z', zones: full, actor: actor('sa'), form: { ...same, active: false } }).action, 'shipping.deactivate');
  const renamed = planZoneSave({ id: 'z', zones: full, actor: actor('sa'), form: { ...same, name: 'Dhaka city', active: true } });
  assert.deepEqual([renamed.id, renamed.action, renamed.ops[0].path], ['z', 'shipping.update', 'shippingZones/z']);
});

test('switch off / on: one update + one audit entry; the districts left uncovered are reported; an overlapping zone cannot be switched on', () => {
  let db = baseDb();
  const off = planZoneActive({ id: 'out', active: false, zones: zonesOf(db), actor: actor('sadm') });
  assert.equal(off.ok, true);
  assert.equal(off.action, 'shipping.deactivate');
  assert.deepEqual(off.uncovered, inOrder('Dhaka', 'Bogura', 'Chattogram'));
  assert.deepEqual(Object.keys(off.ops[0].data).sort(), ['active', 'updatedAt']);
  db = commit(db, 'sadm', off.ops, 'off');
  assert.equal(db.get('shippingZones/out').active, false);
  const on = planZoneActive({ id: 'out', active: true, zones: zonesOf(db), actor: actor('sadm') });
  assert.equal(on.action, 'shipping.activate');
  db = commit(db, 'sadm', on.ops, 'on');
  assert.equal(db.get('shippingZones/out').active, true);
  assert.equal(planZoneActive({ id: 'out', active: true, zones: zonesOf(db), actor: actor('sa') }).error, 'no_change');
  assert.deepEqual(audits(db).map((a) => a.action).sort(), ['shipping.activate', 'shipping.deactivate']);

  const clash = [{ id: 'a', name: 'A', districts: ['Dhaka'], active: true }, { id: 'b', name: 'B', districts: ['Dhaka', 'Gazipur'], active: false }];
  const r = planZoneActive({ id: 'b', active: true, zones: clash, actor: actor('sa') });
  assert.deepEqual([r.ok, r.error], [false, 'overlap']);
  assert.deepEqual(r.overlap, [{ district: 'Dhaka', zoneId: 'a', zoneName: 'A' }]);
  assert.equal(planZoneActive({ id: 'out', active: false, zones: zonesOf(db), actor: actor('pm') }).error, 'forbidden');
  assert.equal(planZoneActive({ id: 'zzz', active: false, zones: zonesOf(db), actor: actor('sa') }).error, 'not_found');
});

test('delete: only a switched-off zone; the zone document and nothing else disappears; other roles are refused by the rules', () => {
  let db = baseDb();
  const zones = zonesOf(db);
  assert.equal(planZoneRemove({ id: 'out', zones, actor: actor('sa') }).error, 'not_inactive');
  assert.equal(planZoneRemove({ id: 'zzz', zones, actor: actor('sa') }).error, 'not_found');
  assert.equal(planZoneRemove({ id: 'off', zones, actor: actor('pm') }).error, 'forbidden');
  const p = planZoneRemove({ id: 'off', zones, actor: actor('om') });
  assert.equal(p.ok, true);
  assert.equal(p.ops.length, 2);
  const forged = [p.ops[0], auditOp(actor('pm'), { action: 'shipping.delete', entity: 'shipping_zone', entityId: 'off', summary: 'forged' })];
  const denied = commitBoth(db, { uid: 'pm' }, forged);
  assert.equal(denied.strict.allowed, false);
  assert.equal(denied.tolerant.allowed, false);
  db = commit(db, 'om', p.ops, 'delete');
  assert.ok(!db.get('shippingZones/off'));
  assert.ok(db.get('shippingZones/in') && db.get('shippingZones/out'));
  assert.deepEqual(audits(db).map((a) => [a.action, a.entityId, a.after]), [['shipping.delete', 'off', undefined]].map(([a, e]) => [a, e, audits(db)[0].after]));
});

test('coverage: which districts have no active zone, and what only one zone covers', () => {
  const zones = zonesOf(baseDb());
  const c = coverage(zones);
  assert.deepEqual([c.total, c.covered, c.uncovered.length], [DISTRICTS.length, 4, DISTRICTS.length - 4]);
  assert.ok(!c.uncovered.includes('Dhaka') && c.uncovered.includes('Sylhet'), 'a switched-off zone covers nothing');
  assert.equal(c.owner.get('Bogura').id, 'out');
  assert.ok(c.byDivision.length > 0 && c.byDivision.every((g) => g.uncovered.length > 0));
  assert.deepEqual(exclusiveDistricts(zones, 'out'), inOrder('Dhaka', 'Bogura', 'Chattogram'));
  assert.deepEqual(exclusiveDistricts(zones, 'off'), [], 'a switched-off zone is nobody\'s only cover');
  assert.deepEqual(exclusiveDistricts([...zones, { id: 'x', name: 'X', districts: ['Dhaka'], active: true }], 'out'), inOrder('Bogura', 'Chattogram'));
});

test('the zones a new store starts with (shared/migration.js) pass this validator and cover every district', () => {
  const zones = defaultZones().map((z) => ({ id: z.id, ...z.data, updatedAt: undefined }));
  for (const z of zones) assert.equal(validateZoneForm(z, { zones: [], id: z.id }).ok, true, z.id);
  const c = coverage(zones);
  assert.deepEqual([c.covered, c.uncovered], [DISTRICTS.length, []]);
  assert.deepEqual(overlaps(zones, 'inside-sirajganj', zones[0].districts), []);
});
