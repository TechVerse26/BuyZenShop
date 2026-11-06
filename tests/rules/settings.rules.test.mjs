/*
 * Store settings (js/shared/settingsFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * a deep merge keeps what the page does not know about, every change is audited with old → new, only settings.write may save,
 * the private document is read by settings.read only — and every field is validated before anything is written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsToForm, validateSettingsForm, planSettingsSave, SETTINGS_LIMITS } from '../../js/shared/settingsFlow.js';
import { defaultSettingsPublic, defaultSettingsPrivate } from '../../js/shared/migration.js';
import { baseDb, commitBoth, failedOps, NOW, strictEngine, tolerantEngine } from './harness.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const stored = (d) => { const { createdAt, updatedAt, ...rest } = d; return JSON.parse(JSON.stringify(rest)); };

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

/** a store whose settings documents already exist (as the migration writes them) */
function storeDb() {
  const db = baseDb();
  db.set('settings/public', stored(defaultSettingsPublic()));
  db.set('settings/private', stored(defaultSettingsPrivate()));
  return db;
}
const formOf = (db, over = {}) => ({ ...settingsToForm(db.get('settings/public'), db.get('settings/private')), ...over });
const plan = (db, over = {}, who = 'sadm') => planSettingsSave({ form: formOf(db, over), current: { pub: db.get('settings/public') || null, priv: db.get('settings/private') || null }, actor: actor(who), nowMs: NOW });

test('the migration defaults survive the round trip through the form: saving an untouched page changes nothing', () => {
  const db = storeDb();
  const v = validateSettingsForm(formOf(db));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(plan(db).error, 'no_change');
  assert.equal(v.pub.contact.whatsapp, '8801957329211', 'a local number is stored in the international form the storefront links to');
  assert.equal(formOf(db).contact_whatsapp, '01957329211', 'and shown in the local form');
});

test('a change is a deep merge: other fields stay, one audit entry names old and new value', () => {
  const db = storeDb();
  const before = JSON.parse(JSON.stringify(db.get('settings/public')));
  const p = plan(db, { pay_bkash_number: '01711-223344', pay_nagad_enabled: false, announcement_ignored: 'x', ann_enabled: true, ann_text: 'Eid sale — free delivery over ৳2000', ann_link: '/shop' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.changed.sort(), ['announcement.enabled', 'announcement.link', 'announcement.text', 'payments.bkash.number', 'payments.nagad.enabled']);
  const after = commit(db, 'sadm', p.ops, 'save');
  const pub = after.get('settings/public');
  assert.deepEqual([pub.payments.bkash.number, pub.payments.nagad.enabled, pub.announcement.text], ['01711223344', false, 'Eid sale — free delivery over ৳2000']);
  assert.deepEqual([pub.payments.bkash.accountType, pub.payments.nagad.number, pub.contact, pub.social], [before.payments.bkash.accountType, before.payments.nagad.number, before.contact, before.social], 'nothing else was touched');
  assert.ok(after.get('settings/public').updatedAt, 'updatedAt is set');
  const [a] = audits(after);
  assert.deepEqual([a.action, a.entityId, a.actorRole], ['settings.update', 'public', 'store_admin']);
  assert.equal(a.before['payments/bkash/number'], before.payments.bkash.number);
  assert.equal(a.after['payments/bkash/number'], '01711223344');
  assert.ok(a.summary.includes('payments.bkash.number'));
  assert.equal(after.has('settings/private') && JSON.stringify(after.get('settings/private')) === JSON.stringify(db.get('settings/private')), true, 'the private document was not written');
});

test('the private document: threshold, notification e-mails and invoice details; the e-mail list is audited as "changed" only', () => {
  const db = storeDb();
  const p = plan(db, { lowStockThreshold: 8, notifyEmails: 'Boss@Example.com, ops@example.com\nboss@example.com', inv_address: 'Barakuthi, Sirajganj', inv_businessName: 'Shop Verse' });
  assert.equal(p.ok, true);
  const after = commit(db, 'sadm', p.ops, 'private');
  const priv = after.get('settings/private');
  assert.deepEqual([priv.lowStockThreshold, priv.notifyEmails, priv.invoice.address], [8, ['boss@example.com', 'ops@example.com'], 'Barakuthi, Sirajganj']);
  const [a] = audits(after);
  assert.equal(a.entityId, 'private');
  assert.equal(a.after.notifyEmails, 'changed');
  assert.equal(JSON.stringify(a).includes('boss@example.com'), false, 'no e-mail address is copied into the audit log');
  assert.deepEqual(after.get('settings/public'), db.get('settings/public'), 'the public document was not written');
});

test('the first save on an empty database creates both documents', () => {
  const db = baseDb();
  assert.equal(db.has('settings/public'), false);
  const form = settingsToForm({}, {});
  const p = planSettingsSave({ form: { ...form, storeName: 'Shop Verse', pay_cod_enabled: true }, current: { pub: null, priv: null }, actor: actor('sa'), nowMs: NOW });
  assert.equal(p.ok, true, JSON.stringify(p));
  const after = commit(db, 'sa', p.ops, 'first save');
  assert.ok(after.get('settings/public').createdAt && after.get('settings/private').createdAt);
  assert.equal(after.get('settings/public').storeName, 'Shop Verse');
});

test('only settings.write may save; reads: public for everyone, private for settings.read', () => {
  const db = storeDb();
  const p = plan(db, { tagline: 'New' });
  for (const uid of ['pm', 'om', 'im', 'cs', 'rp', 'off', 'u1']) {
    refused(db, uid, [p.ops[0]], `${uid} writing settings/public`);
    refused(db, uid, [{ op: 'set', path: 'settings/private', merge: true, data: { lowStockThreshold: 1 } }], `${uid} writing settings/private`);
  }
  for (const uid of ['pm', 'om', 'im', 'cs', 'rp']) assert.equal(plan(db, { tagline: 'New' }, uid).error, 'forbidden', `${uid}: the planner refuses first`);
  commit(db, 'sa', plan(db, { tagline: 'By super admin' }, 'sa').ops, 'super admin saves');

  const read = (auth, key) => [strictEngine, tolerantEngine].map((e) => e.read({ db, auth, now: NOW, key }).allowed);
  assert.deepEqual(read(null, 'settings/public'), [true, true], 'the storefront reads it signed out');
  assert.deepEqual(read(null, 'settings/private'), [false, false]);
  for (const [uid, may] of [['sa', true], ['sadm', true], ['pm', false], ['om', false], ['im', false], ['cs', false], ['rp', false], ['u1', false]]) assert.deepEqual(read({ uid }, 'settings/private'), [may, may], `${uid} reads settings/private`);
});

test('validation: every field is explained by a code, nothing is written', () => {
  const db = storeDb();
  const bad = (over, field, code) => { const v = validateSettingsForm(formOf(db, over)); assert.equal(v.ok, false, `${field}=${JSON.stringify(over[field])} should be refused`); assert.equal(v.errors[field], code, `${field}: ${JSON.stringify(v.errors)}`); };
  bad({ storeName: '  ' }, 'storeName', 'required');
  bad({ storeName: 'x'.repeat(61) }, 'storeName', 'too_long');
  bad({ orderPrefix: 'a' }, 'orderPrefix', 'bad_prefix');
  bad({ orderPrefix: 'TOOLONG1' }, 'orderPrefix', 'bad_prefix');
  bad({ contact_whatsapp: '12345' }, 'contact_whatsapp', 'bad_phone');
  bad({ contact_phone: 'abc' }, 'contact_phone', 'bad_phone');
  bad({ contact_email: 'nope' }, 'contact_email', 'bad_email');
  bad({ social_facebook: 'http://facebook.com/x' }, 'social_facebook', 'bad_url');
  bad({ social_youtube: 'javascript:alert(1)' }, 'social_youtube', 'bad_url');
  bad({ logoUrl: '//evil.example/x.png' }, 'logoUrl', 'bad_url');
  bad({ ann_link: 'not a link' }, 'ann_link', 'bad_url');
  bad({ pay_bkash_enabled: true, pay_bkash_number: '' }, 'pay_bkash_number', 'required');
  bad({ pay_nagad_number: '0123' }, 'pay_nagad_number', 'bad_phone');
  bad({ pay_cod_enabled: false, pay_bkash_enabled: false, pay_nagad_enabled: false }, 'pay_cod_enabled', 'none_enabled');
  bad({ returnWindowDays: 61 }, 'returnWindowDays', 'range');
  bad({ returnWindowDays: 1.5 }, 'returnWindowDays', 'range');
  bad({ ann_enabled: true, ann_text: '' }, 'ann_text', 'required');
  bad({ ann_text: 'x'.repeat(SETTINGS_LIMITS.announcement + 1) }, 'ann_text', 'too_long');
  bad({ tawk_enabled: true, tawk_propertyId: '' }, 'tawk_propertyId', 'required');
  bad({ tawk_widgetId: '../evil' }, 'tawk_widgetId', 'bad_id');
  bad({ lowStockThreshold: -1 }, 'lowStockThreshold', 'range');
  bad({ notifyEmails: 'a@b.test, nope' }, 'notifyEmails', 'bad_email');
  bad({ notifyEmails: 'a@b.test b@b.test c@b.test d@b.test e@b.test f@b.test' }, 'notifyEmails', 'too_many');
  const ok = validateSettingsForm(formOf(db, { orderPrefix: 'sv2', contact_whatsapp: '+8801711-223344', logoUrl: '/assets/logo.png', ann_link: 'https://example.com/sale', pay_bkash_type: 'Hacker' }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual([ok.pub.orderPrefix, ok.pub.contact.whatsapp, ok.pub.payments.bkash.accountType], ['SV2', '8801711223344', 'Personal'], 'normalised: upper case, international number, known account type only');
  assert.equal(plan(db, { storeName: '' }).error, 'invalid', 'nothing is planned for an invalid form');
});
