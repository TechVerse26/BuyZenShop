/* The setup checklist: every verdict comes from the snapshot it is given — and what a role cannot read is skipped, never "ok". */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReadiness, summarize } from '../../js/shared/readiness.js';
import { defaultSettingsPublic, defaultSettingsPrivate, defaultZones } from '../../js/shared/migration.js';
import { DISTRICTS } from '../../js/shared/constants.js';

const settings = (over = {}) => ({ ...defaultSettingsPublic(), ...over });
const zones = () => [{ id: 'all', name: 'Everywhere', districts: [...DISTRICTS], fee: 100, active: true }];
const product = (id, over = {}) => ({ id, name: id, status: 'published', type: 'simple', price: 100, ...over });
const good = () => ({
  settings: settings(), private: { ...defaultSettingsPrivate(), invoice: { businessName: 'Shop', address: 'Sirajganj', phone: '', note: '' } },
  home: { sections: [{ id: 'a', type: 'hero' }] }, zones: zones(), categories: [{ id: 'c1', visible: true }],
  products: [product('p1'), product('p2', { type: 'variable', variants: [{ id: 'v1' }, { id: 'v2' }] })],
  inventoryIds: ['p1', 'p2__v1', 'p2__v2'],
  staff: [{ id: 'a', role: 'super_admin', active: true }, { id: 'b', role: 'super_admin', active: true }, { id: 'c', role: 'order_manager', active: true }],
});
const by = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test('a fully set up store passes every check', () => {
  const checks = evaluateReadiness(good());
  assert.deepEqual(summarize(checks), { ok: checks.length, warn: 0, bad: 0, skip: 0, total: checks.length });
  assert.deepEqual(checks.map((c) => c.id), ['settings', 'contact', 'payments', 'shipping', 'categories', 'products', 'inventory', 'home', 'invoice', 'staff']);
});

test('an empty database says what to do first: migrate', () => {
  const c = by(evaluateReadiness({ settings: null, home: null, zones: [], categories: [], products: [], inventoryIds: [], private: null, staff: [{ id: 'a', role: 'super_admin', active: true }] }));
  assert.deepEqual([c.settings.status, c.settings.fix], ['bad', 'migrate']);
  assert.deepEqual([c.shipping.status, c.shipping.fix], ['bad', 'shipping']);
  assert.equal(c.categories.status, 'warn');
  assert.equal(c.products.status, 'warn', 'no published product yet');
  assert.deepEqual([c.home.status, c.home.fix], ['warn', 'migrate']);
  assert.equal(c.staff.status, 'warn', 'a single Super Admin is a risk');
  assert.equal(c.contact, undefined, 'contact and payments need the settings document');
});

test('old-format products block the store until migrated; missing stock records are counted per unit', () => {
  const s = good();
  s.products = [{ id: 'old1', name: 'Old', price: 100 }, { id: 'old2', name: 'Old 2', price: 5, stock: 'Out of Stock' }, product('p1')];
  let c = by(evaluateReadiness(s));
  assert.deepEqual([c.products.status, c.products.params.legacy, c.products.fix], ['bad', 2, 'migrate']);
  s.products = [product('p1'), product('p2', { type: 'variable', variants: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3', active: false }] })];
  s.inventoryIds = ['p2__v1'];
  c = by(evaluateReadiness(s));
  assert.deepEqual([c.inventory.status, c.inventory.params.missing, c.inventory.fix], ['bad', 2, 'migrate'], 'p1 and p2__v2 are missing; the switched-off v3 is not counted');
  s.products = [product('p2', { type: 'variable', variants: [{ id: 'v1' }, { id: 'v2' }] })];
  s.inventoryIds = ['p2__v1'];
  assert.equal(by(evaluateReadiness(s)).inventory.fix, 'products', 'a missing variant is repaired in the product editor, not by the migration');
});

test('payments: at least one method, and wallets need a valid number', () => {
  const s = good();
  s.settings = settings({ payments: { cod: { enabled: false }, bkash: { enabled: false }, nagad: { enabled: false } } });
  assert.deepEqual([by(evaluateReadiness(s)).payments.status, by(evaluateReadiness(s)).payments.params.reason], ['bad', 'none']);
  s.settings = settings({ payments: { cod: { enabled: true }, bkash: { enabled: true, number: '' }, nagad: { enabled: true, number: '01712-345678' } } });
  const p = by(evaluateReadiness(s)).payments;
  assert.deepEqual([p.status, p.params.reason, p.params.methods], ['bad', 'number', 'bkash']);
  s.settings = settings({ payments: { cod: { enabled: true }, bkash: { enabled: false, number: '' }, nagad: { enabled: false } } });
  assert.equal(by(evaluateReadiness(s)).payments.status, 'ok', 'cash on delivery alone is fine');
});

test('shipping: no active zone is a problem, uncovered districts are a warning', () => {
  const s = good();
  s.zones = [{ id: 'z', districts: ['Dhaka', 'Sirajganj'], active: true }, { id: 'off', districts: [...DISTRICTS], active: false }];
  const c = by(evaluateReadiness(s)).shipping;
  assert.deepEqual([c.status, c.params.zones, c.params.uncovered], ['warn', 1, DISTRICTS.length - 2]);
  s.zones = [{ id: 'off', districts: [...DISTRICTS], active: false }];
  assert.equal(by(evaluateReadiness(s)).shipping.status, 'bad');
  // the zones the migration creates cover every district
  s.zones = defaultZones().map((z) => ({ id: z.id, ...z.data }));
  assert.equal(by(evaluateReadiness(s)).shipping.status, 'ok');
});

test('a role that cannot read something gets "skip", never a false "ok"', () => {
  const c = by(evaluateReadiness({ settings: settings(), home: { sections: [{}] }, zones: [], categories: undefined, products: undefined, inventoryIds: undefined, private: undefined, staff: undefined }));
  for (const id of ['categories', 'products', 'inventory', 'invoice', 'staff']) assert.equal(c[id].status, 'skip', id);
  assert.equal(c.shipping.status, 'bad', 'zones are public, so they were read');
  assert.equal(summarize(Object.values(c)).skip, 5);
});

test('staff: no active Super Admin is a problem; two or more is healthy', () => {
  const s = good();
  s.staff = [{ id: 'a', role: 'super_admin', active: false }, { id: 'b', role: 'store_admin', active: true }];
  assert.equal(by(evaluateReadiness(s)).staff.status, 'bad');
  s.staff = [{ id: 'a', role: 'super_admin', active: true }];
  assert.equal(by(evaluateReadiness(s)).staff.status, 'warn');
});
