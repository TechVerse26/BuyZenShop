/*
 * Access-control matrix: who may read / write what. Evaluated against the real firestore.rules text.
 * Reads (single documents AND list queries, evaluated against the query constraints) and all writes must agree in BOTH engine modes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TS } from '../../js/shared/ops.js';
import { baseDb, commitBoth, failedOps, NOW, strictEngine, tolerantEngine } from './harness.mjs';
import { Ts } from './rules-engine.mjs';

const ROLES = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const ALL_STAFF = Object.keys(ROLES);

function db0() {
  const db = baseDb();
  db.set('products/ph', { name: 'Hidden', slug: 'hidden', status: 'archived', type: 'simple', price: 1 });
  db.set('productPrivate/p1', { costPrice: 400 });
  db.set('categories/c1', { name: 'Shirts', slug: 'shirts', visible: true });
  db.set('categories/ch', { name: 'Secret', slug: 'secret', visible: false });
  db.set('brands/b1', { name: 'Brand', slug: 'brand', visible: true });
  db.set('pages/about', { title: 'About', visible: true, body: 'x' });
  db.set('pages/draft', { title: 'Draft', visible: false, body: 'x' });
  db.set('content/home', { sections: [] });
  db.set('meta/catalog', { version: 1 });
  db.set('settings/public', { storeName: 'Shop Verse' });
  db.set('settings/private', { invoiceFooter: 'x' });
  db.set('orders/SV-261026-AAAAAA', { userId: 'u1', status: 'pending', payment: { status: 'unpaid' } });
  db.set('reviews/p1__u1', { productId: 'p1', userId: 'u1', status: 'pending', rating: 5, title: 'Great', text: 'Great shirt', helpfulCount: 0 });
  db.set('reviews/p1__u2', { productId: 'p1', userId: 'u2', status: 'approved', rating: 4, title: 'Good', text: 'Good shirt', helpfulCount: 0 });
  db.set('supportTickets/t1', { userId: 'u1', status: 'open', subject: 'Hi', message: 'Hello there' });
  db.set('suppliers/s1', { name: 'ACME' });
  db.set('users/u1/addresses/a1', { name: 'Rahim', phone: '01712345678', district: 'Dhaka', line1: 'Road 1, House 2' });
  db.set('userPrivate/u1', { note: 'vip' });
  db.set('auditLogs/l1', { action: 'x' });
  db.set('activity_logs/old1', { action: 'legacy' });
  db.set('newsletter/a@b.co', { email: 'a@b.co', source: 'footer' });
  return db;
}

const who = (id) => (id === 'anon' ? null : { uid: id });

function readCase(label, key, allowed, denied, kind = 'get', constraints) {
  test(`read ${label}`, () => {
    const db = db0();
    for (const id of allowed) {
      const r = tolerantEngine.read({ db, auth: who(id), now: NOW, key, kind, constraints });
      assert.equal(r.allowed, true, `${id} should read ${key}: ${r.error}`);
      // strict mode (an evaluation error denies) too: legitimate staff / owner queries must not depend on error absorption
      const st = strictEngine.read({ db, auth: who(id), now: NOW, key, kind, constraints });
      assert.equal(st.allowed, true, `${id} strict ${kind} ${key}: ${st.error}`);
    }
    for (const id of denied) {
      const t = tolerantEngine.read({ db, auth: who(id), now: NOW, key, kind, constraints });
      assert.equal(t.allowed, false, `${id} must NOT read ${key}`);
      assert.equal(strictEngine.read({ db, auth: who(id), now: NOW, key, kind, constraints }).allowed, false, `${id} strict ${kind} ${key}`);
    }
  });
}

function writeCase(label, ops, allowed, denied, mutateDb) {
  test(`write ${label}`, () => {
    for (const id of allowed) {
      const db = db0(); if (mutateDb) mutateDb(db);
      const r = commitBoth(db, who(id), ops);
      assert.equal(r.strict.allowed, true, `${id} should write (${label}) strict: ${failedOps(r.strict).join(' | ')}`);
      assert.equal(r.tolerant.allowed, true, `${id} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
    }
    for (const id of denied) {
      const db = db0(); if (mutateDb) mutateDb(db);
      const r = commitBoth(db, who(id), ops);
      assert.equal(r.strict.allowed, false, `${id} must NOT write (${label}) strict`);
      assert.equal(r.tolerant.allowed, false, `${id} must NOT write (${label}) tolerant`);
    }
  });
}

const everyoneBut = (list) => ['anon', 'u1', 'u2', ...ALL_STAFF, 'off', 'nobody'].filter((x) => !list.includes(x));

/* ───────────────────────── public reads ───────────────────────── */

readCase('settings/public is public', 'settings/public', ['anon', 'u1', 'sa'], []);
readCase('settings/private is staff only', 'settings/private', ['sa', 'sadm'], everyoneBut(['sa', 'sadm']));
readCase('published product is public', 'products/p1', ['anon', 'u1'], []);
readCase('draft/archived products only for staff with products.read', 'products/pd', ['sa', 'sadm', 'pm', 'om', 'im', 'cs', 'rp'], ['anon', 'u1', 'off']);
readCase('products list needs the published filter', 'products/__query__', ['anon', 'u1'], [], 'list', { status: 'published' });
readCase('unfiltered product list is refused to customers, fine for staff', 'products/__query__', ['sa', 'pm'], ['anon', 'u1'], 'list', {});
readCase('inventory is public', 'inventory/p1', ['anon', 'u1'], []);
readCase('hidden category: staff with products.read only', 'categories/ch', ['sa', 'pm', 'om', 'im', 'cs', 'rp'], ['anon', 'u1', 'off']);
readCase('visible category', 'categories/c1', ['anon'], []);
readCase('visible page public / hidden page for content editors', 'pages/draft', ['sa', 'sadm', 'pm'], ['anon', 'u1', 'om', 'cs']);
readCase('public page', 'pages/about', ['anon'], []);
readCase('home content, catalog stamp, shipping zones are public', 'content/home', ['anon'], []);
readCase('catalog stamp', 'meta/catalog', ['anon'], []);
readCase('shipping zone', 'shippingZones/in', ['anon'], []);
readCase('cost prices need costs.read', 'productPrivate/p1', ['sa', 'sadm', 'pm', 'im'], everyoneBut(['sa', 'sadm', 'pm', 'im']));
readCase('coupon document needs a signed-in user', 'coupons/WELCOME10', ['u1', 'sa'], ['anon']);
readCase('coupon list only for coupons.read', 'coupons/__query__', ['sa', 'sadm', 'pm', 'om'], ['anon', 'u1', 'cs', 'im', 'rp'], 'list', {});

/* staff list queries used by the admin pages (no userId / status constraint at all) */
readCase('orders list: staff with orders.read, unconstrained', 'orders/__query__', ['sa', 'sadm', 'om', 'cs', 'rp'], ['anon', 'u1', 'pm', 'im'], 'list', {});
readCase('orders list: a customer must filter by their own userId', 'orders/__query__', ['u1'], ['u2', 'anon'], 'list', { userId: 'u1' });
readCase('orders list: staff equality filters (status, payment.status)', 'orders/__query__', ['sa', 'om'], ['u1', 'anon', 'pm'], 'list', { status: 'pending' });
readCase('reviews list for moderation (status filter only)', 'reviews/__query__', ['sa', 'sadm', 'pm', 'cs'], ['anon', 'u1', 'om', 'rp'], 'list', { status: 'pending' });
readCase('approved reviews of a product are public', 'reviews/__query__', ['anon', 'u1'], [], 'list', { productId: 'p1', status: 'approved' });
readCase('support tickets list: support staff, unconstrained', 'supportTickets/__query__', ['sa', 'sadm', 'om', 'cs'], ['anon', 'u1', 'pm', 'im', 'rp'], 'list', {});
readCase('own support tickets', 'supportTickets/__query__', ['u1'], ['u2', 'anon'], 'list', { userId: 'u1' });
readCase('categories list: staff see hidden ones, the public only visible ones', 'categories/__query__', ['sa', 'pm', 'om', 'cs', 'rp'], ['anon', 'u1'], 'list', {});
readCase('visible categories are public', 'categories/__query__', ['anon', 'u1'], [], 'list', { visible: true });
readCase('brands list: staff see hidden ones', 'brands/__query__', ['sa', 'pm', 'om'], ['anon', 'u1'], 'list', {});
readCase('pages list: content editors see drafts, the public only visible', 'pages/__query__', ['sa', 'sadm', 'pm'], ['anon', 'u1', 'om', 'cs'], 'list', {});
readCase('visible pages are public', 'pages/__query__', ['anon'], [], 'list', { visible: true });
readCase('inventory movements: inventory.read roles', 'inventoryMovements/m1', ['sa', 'sadm', 'pm', 'om', 'im', 'rp'], ['anon', 'u1', 'cs'], 'list', {});
readCase('returns and refunds lists', 'returns/__query__', ['sa', 'sadm', 'om', 'cs', 'rp'], ['anon', 'u1', 'pm'], 'list', {});
readCase('refunds list', 'refunds/__query__', ['sa', 'sadm', 'om', 'cs', 'rp'], ['anon', 'u1', 'pm'], 'list', {});
readCase('order timeline (all events) for staff', 'orders/SV-261026-AAAAAA/events/__query__', ['sa', 'om', 'cs', 'rp'], ['anon', 'u1', 'pm'], 'list', {});
readCase('order timeline for the owner needs both filters', 'orders/SV-261026-AAAAAA/events/__query__', ['u1'], ['u2', 'anon'], 'list', { userId: 'u1', visibility: 'customer' });
readCase('audit log list', 'auditLogs/__query__', ['sa', 'sadm'], everyoneBut(['sa', 'sadm']), 'list', {});
readCase('staff list is staff.manage', 'staff/__query__', ['sa'], everyoneBut(['sa']), 'list', {});

/* ───────────────────────── private data ───────────────────────── */

readCase('own user document', 'users/u1', ['u1', 'sa', 'sadm', 'om', 'cs'], ['u2', 'anon', 'pm', 'im', 'rp']);
readCase('user list is staff only', 'users/__query__', ['sa', 'sadm', 'om', 'cs'], ['u1', 'anon', 'pm'], 'list', {});
readCase('own addresses', 'users/u1/addresses/a1', ['u1'], ['u2', 'anon', 'sa', 'om']);
readCase('userPrivate (staff notes about customers)', 'userPrivate/u1', ['sa', 'sadm', 'om', 'cs'], ['u1', 'anon', 'pm']);
readCase('orders: owner and orders.read roles', 'orders/SV-261026-AAAAAA', ['u1', 'sa', 'sadm', 'om', 'cs', 'rp'], ['u2', 'anon', 'pm', 'im']);
readCase('approved review is public, pending only owner/moderators', 'reviews/p1__u1', ['u1', 'sa', 'sadm', 'pm', 'cs'], ['u2', 'anon', 'om', 'im', 'rp']);
readCase('approved review public', 'reviews/p1__u2', ['anon', 'u1'], []);
readCase('support ticket: owner and support staff', 'supportTickets/t1', ['u1', 'sa', 'sadm', 'om', 'cs'], ['u2', 'anon', 'pm', 'im', 'rp']);
readCase('audit log', 'auditLogs/l1', ['sa', 'sadm'], everyoneBut(['sa', 'sadm']));
readCase('legacy activity log is read-only for auditors', 'activity_logs/old1', ['sa', 'sadm'], everyoneBut(['sa', 'sadm']));
readCase('suppliers need inventory.read', 'suppliers/s1', ['sa', 'sadm', 'pm', 'om', 'im', 'rp'], ['anon', 'u1', 'cs']);
readCase('newsletter list is customers.read', 'newsletter/a@b.co', ['sa', 'sadm', 'om', 'cs'], ['anon', 'u1', 'pm']);
readCase('staff document: self or staff.manage', 'staff/om', ['om', 'sa'], ['sadm', 'u1', 'anon', 'pm']);
readCase('unknown collections are denied', 'secrets/x', [], ['anon', 'u1', 'sa', 'sadm']);
readCase('legacy top-level notifications are no longer accessible', 'notifications/x', [], ['anon', 'u1', 'sa']);

/* ───────────────────────── staff writes ───────────────────────── */

const product = { name: 'New Shirt', slug: 'new-shirt', status: 'draft', type: 'simple', price: 500, salePrice: null };
writeCase('create product', [{ op: 'set', path: 'products/pn', data: product }], ['sa', 'sadm', 'pm'], everyoneBut(['sa', 'sadm', 'pm']));
writeCase('product with a bad slug is refused', [{ op: 'set', path: 'products/pn', data: { ...product, slug: 'Bad Slug!' } }], [], ['sa', 'sadm', 'pm']);
writeCase('product with sale price above regular price refused', [{ op: 'set', path: 'products/pn', data: { ...product, salePrice: 900 } }], [], ['sa', 'pm']);
writeCase('product with a negative price refused', [{ op: 'set', path: 'products/pn', data: { ...product, price: -5 } }], [], ['sa', 'pm']);
writeCase('delete product needs products.delete', [{ op: 'delete', path: 'products/p1' }], ['sa', 'sadm', 'pm'], ['om', 'im', 'cs', 'rp', 'u1', 'anon']);
writeCase('rating aggregate may be written by review moderators', [{ op: 'update', path: 'products/p1', data: { ratingAvg: 4.5, ratingCount: 2, ratingSum: 9, updatedAt: TS } }], ['sa', 'sadm', 'pm', 'cs'], ['om', 'im', 'rp', 'u1', 'anon']);
writeCase('but moderators cannot change the price via the rating path', [{ op: 'update', path: 'products/p1', data: { price: 1, ratingAvg: 4.5 } }], [], ['cs', 'om', 'u1']);
writeCase('inventory price/stock: catalog & inventory roles only', [{ op: 'update', path: 'inventory/p1', data: { price: 1200, stock: 99, updatedAt: TS } }], ['sa', 'sadm', 'pm', 'im'], ['om', 'cs', 'rp', 'u1', 'anon']);
writeCase('order managers may only touch stock counters', [{ op: 'update', path: 'inventory/p1', data: { stock: 9, reserved: 1, updatedAt: TS } }], ['sa', 'sadm', 'pm', 'im', 'om'], ['cs', 'rp', 'u1']);
writeCase('inventory movements are immutable (create ok, update/delete never)', [{ op: 'set', path: 'inventoryMovements/m1', data: { key: 'p1', type: 'adjust', delta: 1, createdAt: TS } }], ['sa', 'sadm', 'im', 'om'], ['pm', 'cs', 'rp', 'u1', 'anon']);
writeCase('movements cannot be edited', [{ op: 'update', path: 'inventoryMovements/m1', data: { delta: 5 } }], [], ALL_STAFF, (db) => db.set('inventoryMovements/m1', { key: 'p1', delta: 1 }));
writeCase('categories', [{ op: 'set', path: 'categories/cn', data: { name: 'New', slug: 'new', visible: true } }], ['sa', 'sadm', 'pm'], ['om', 'im', 'cs', 'rp', 'u1']);
writeCase('coupons', [{ op: 'set', path: 'coupons/NEW1', data: { code: 'NEW1', type: 'percent', value: 5, active: true } }], ['sa', 'sadm'], ['pm', 'om', 'im', 'cs', 'rp', 'u1', 'anon']);
writeCase('shipping zones', [{ op: 'update', path: 'shippingZones/in', data: { fee: 80 } }], ['sa', 'sadm', 'om'], ['pm', 'im', 'cs', 'rp', 'u1']);
writeCase('settings', [{ op: 'update', path: 'settings/public', data: { storeName: 'X' } }], ['sa', 'sadm'], ['pm', 'om', 'im', 'cs', 'rp', 'u1', 'anon']);
writeCase('homepage content', [{ op: 'set', path: 'content/home', data: { sections: [] } }], ['sa', 'sadm', 'pm'], ['om', 'im', 'cs', 'rp', 'u1', 'anon']);
writeCase('static pages', [{ op: 'set', path: 'pages/terms', data: { title: 'T', body: '', visible: true, footer: true, sort: 0, seoTitle: '', seoDescription: '', updatedAt: TS } }], ['sa', 'sadm', 'pm'], ['om', 'cs', 'u1']);
writeCase('catalog stamp may be bumped by catalog / order staff', [{ op: 'set', path: 'meta/catalog', merge: true, data: { version: 2, updatedAt: TS } }], ['sa', 'sadm', 'pm', 'im', 'om', 'cs'], ['rp', 'u1', 'anon']);
writeCase('mail outbox', [{ op: 'set', path: 'mail/m1', data: { to: 'a@b.co', message: { subject: 's', text: 't' } } }], ['sa', 'sadm', 'om', 'cs'], ['pm', 'im', 'rp', 'u1', 'anon']);
writeCase('review moderation', [{ op: 'update', path: 'reviews/p1__u1', data: { status: 'approved', updatedAt: TS } }], ['sa', 'sadm', 'pm', 'cs'], ['om', 'im', 'rp', 'u2', 'anon']);
writeCase('support reply message', [{ op: 'set', path: 'supportTickets/t1/messages/m1', data: { authorType: 'staff', authorUid: 'cs', text: 'Hello', createdAt: TS } }], ['cs'], ['u2', 'anon', 'om'].concat(['rp']));
writeCase('suppliers', [{ op: 'set', path: 'suppliers/s2', data: { name: 'B' } }], ['sa', 'sadm', 'im'], ['pm', 'om', 'cs', 'rp', 'u1']);

/* ───────────────────────── staff management & audit ───────────────────────── */

const staffDoc = { role: 'order_manager', active: true, email: 'new@x.test', name: 'New', createdAt: TS, updatedAt: TS, createdBy: 'sa' };
writeCase('only super admin manages staff', [{ op: 'set', path: 'staff/newbie', data: staffDoc }], ['sa'], everyoneBut(['sa']));
writeCase('staff with an invented role refused', [{ op: 'set', path: 'staff/newbie', data: { ...staffDoc, role: 'god' } }], [], ['sa']);
writeCase('staff doc with extra keys refused', [{ op: 'set', path: 'staff/newbie', data: { ...staffDoc, perms: ['*'] } }], [], ['sa']);
writeCase('nobody can promote themselves', [{ op: 'update', path: 'staff/om', data: { role: 'super_admin' } }], ['sa'], everyoneBut(['sa']));
writeCase('a customer cannot create their own staff doc', [{ op: 'set', path: 'staff/u1', data: { role: 'super_admin', active: true } }], [], ['u1', 'anon', 'sadm']);

const audit = (uid, role) => ({ op: 'set', path: 'auditLogs/a1', data: { actorUid: uid, actorEmail: 'x', actorRole: role, action: 'test', entity: 'x', entityId: '1', summary: 's', before: null, after: null, createdAt: TS } });
test('audit log: any active staff may append their own entry; nobody may edit or delete', () => {
  for (const id of ALL_STAFF) {
    const r = commitBoth(db0(), who(id), [audit(id, ROLES[id])]);
    assert.equal(r.strict.allowed, true, `${id}: ${failedOps(r.strict).join('|')}`);
  }
  for (const id of ['anon', 'u1', 'off']) assert.equal(commitBoth(db0(), who(id), [audit(id, 'super_admin')]).tolerant.allowed, false, id);
  // wrong role claim, wrong actor, back-dated
  assert.equal(commitBoth(db0(), who('om'), [audit('om', 'super_admin')]).tolerant.allowed, false, 'role claim');
  assert.equal(commitBoth(db0(), who('om'), [audit('sa', 'order_manager')]).tolerant.allowed, false, 'actor spoof');
  const back = audit('om', 'order_manager'); back.data.createdAt = new Date(NOW - 86400000);
  assert.equal(commitBoth(db0(), who('om'), [back]).tolerant.allowed, false, 'back-dated');
  for (const id of ALL_STAFF) {
    assert.equal(commitBoth(db0(), who(id), [{ op: 'update', path: 'auditLogs/l1', data: { action: 'edited' } }]).tolerant.allowed, false, `${id} edit audit`);
    assert.equal(commitBoth(db0(), who(id), [{ op: 'delete', path: 'auditLogs/l1' }]).tolerant.allowed, false, `${id} delete audit`);
    assert.equal(commitBoth(db0(), who(id), [{ op: 'set', path: 'activity_logs/n1', data: { a: 1 } }]).tolerant.allowed, false, `${id} write legacy log`);
  }
});

test('inactive staff lose all access immediately', () => {
  const db = db0();
  for (const key of ['products/pd', 'orders/SV-261026-AAAAAA', 'settings/private', 'auditLogs/l1']) {
    assert.equal(strictEngine.read({ db, auth: { uid: 'off' }, now: NOW, key }).allowed, false, key);
  }
  assert.equal(commitBoth(db, { uid: 'off' }, [{ op: 'update', path: 'settings/public', data: { storeName: 'x' } }]).tolerant.allowed, false);
});

/* ───────────────────────── customer writes ───────────────────────── */

const userDoc = { displayName: 'New User', email: 'n@x.co', createdAt: TS };
writeCase('create own profile', [{ op: 'set', path: 'users/newuser', data: userDoc }], ['newuser'], ['u1', 'anon'], (db) => db.delete('users/newuser'));
writeCase('profile with privileged flags refused', [{ op: 'set', path: 'users/newuser', data: { ...userDoc, restricted: false } }], [], ['newuser']);
writeCase('profile update (name/phone)', [{ op: 'update', path: 'users/u1', data: { displayName: 'Rahim U', phone: '01712345678', updatedAt: TS } }], ['u1'], ['u2', 'anon']);
writeCase('customers cannot lift their own restriction', [{ op: 'update', path: 'users/ur', data: { restricted: false } }], ['sa', 'sadm'], ['ur', 'u1', 'om']);
writeCase('customers cannot reset the order cooldown', [{ op: 'update', path: 'users/uc', data: { lastOrderAt: new Date(NOW - 99999999) } }], [], ['uc']);
writeCase('address book', [{ op: 'set', path: 'users/u1/addresses/a2', data: { name: 'Rahim', phone: '01712345678', district: 'Dhaka', line1: 'Road 5, House 6', isDefault: true, updatedAt: TS } }], ['u1'], ['u2', 'anon', 'sa']);
writeCase('address with a bad phone refused', [{ op: 'set', path: 'users/u1/addresses/a2', data: { name: 'Rahim', phone: '123', district: 'Dhaka', line1: 'Road 5, House 6' } }], [], ['u1']);
writeCase('wishlist', [{ op: 'set', path: 'users/u1/wishlist/p1', data: { productId: 'p1', addedAt: TS } }], ['u1'], ['u2', 'anon']);
writeCase('wishlist entry must match its id', [{ op: 'set', path: 'users/u1/wishlist/p1', data: { productId: 'p2', addedAt: TS } }], [], ['u1']);
writeCase('server-side cart', [{ op: 'set', path: 'users/u1/cart/main', data: { items: { p1: 2 }, updatedAt: TS } }], ['u1'], ['u2', 'anon']);
writeCase('notifications: staff create, owner marks read', [{ op: 'set', path: 'users/u1/notifications/n1', data: { title: 'Hi', read: false, createdAt: TS } }], ['sa', 'sadm', 'om', 'cs'], ['u1', 'u2', 'pm', 'anon']);

const review = { productId: 'p1', userId: 'u3', userName: 'U3', rating: 5, title: 'Nice', text: 'Really nice product', status: 'pending', verified: false, orderNumber: '', lineKey: '', helpfulCount: 0, createdAt: TS, updatedAt: TS };
writeCase('review create (unverified)', [{ op: 'set', path: 'reviews/p1__u3', data: review }], ['u3'], ['u1', 'anon'], (db) => db.set('users/u3', { displayName: 'U3', createdAt: new Ts(NOW) }));
writeCase('self-approved review refused', [{ op: 'set', path: 'reviews/p1__u3', data: { ...review, status: 'approved' } }], [], ['u3']);
writeCase('rating outside 1–5 refused', [{ op: 'set', path: 'reviews/p1__u3', data: { ...review, rating: 9 } }], [], ['u3']);
writeCase('fake "verified purchase" refused', [{ op: 'set', path: 'reviews/p1__u3', data: { ...review, verified: true, orderNumber: 'SV-261026-AAAAAA', lineKey: 'p1' } }], [], ['u3']);
writeCase('review id must be PRODUCT__UID (one per customer)', [{ op: 'set', path: 'reviews/p1__other', data: review }], [], ['u3']);
writeCase('verified review for a delivered order', [{ op: 'set', path: 'reviews/p1__u1v', data: { ...review, userId: 'u1', verified: true, orderNumber: 'SV-261026-AAAAAA', lineKey: 'p1' } }], [], ['u1']);
test('verified review is accepted only when the order is delivered and contains the product', () => {
  const db = db0();
  const key = 'reviews/p1__u1';
  db.delete(key);
  const data = { ...review, userId: 'u1', userName: 'Rahim', verified: true, orderNumber: 'SV-261026-AAAAAA', lineKey: 'p1' };
  assert.equal(commitBoth(db, { uid: 'u1' }, [{ op: 'set', path: key, data }]).tolerant.allowed, false, 'pending order');
  db.set('orders/SV-261026-AAAAAA', { userId: 'u1', status: 'delivered', items: { p1: { productId: 'p1' } } });
  const r = commitBoth(db, { uid: 'u1' }, [{ op: 'set', path: key, data }]);
  assert.equal(r.strict.allowed, true, failedOps(r.strict).join('|'));
  db.get('orders/SV-261026-AAAAAA').items = { p9: { productId: 'p9' } };
  assert.equal(commitBoth(db, { uid: 'u1' }, [{ op: 'set', path: key, data }]).tolerant.allowed, false, 'product not in order');
});

test('review helpful votes: once per customer, only on approved reviews, not on your own', () => {
  const db = db0();
  const vote = (uid) => [
    { op: 'update', path: 'reviews/p1__u2', data: { helpfulCount: { $op: 'inc', n: 1 } } },
    { op: 'set', path: `reviews/p1__u2/votes/${uid}`, data: { createdAt: TS } },
  ];
  let r = commitBoth(db, { uid: 'u1' }, vote('u1'));
  assert.equal(r.strict.allowed, true, failedOps(r.strict).join('|'));
  const after = r.strict.dbAfter;
  assert.equal(commitBoth(after, { uid: 'u1' }, vote('u1')).tolerant.allowed, false, 'second vote');
  assert.equal(commitBoth(db, { uid: 'u2' }, vote('u2')).tolerant.allowed, false, 'own review');
  assert.equal(commitBoth(db, { uid: 'u1' }, [{ op: 'update', path: 'reviews/p1__u2', data: { helpfulCount: { $op: 'inc', n: 5 } } }]).tolerant.allowed, false, 'stuffing without vote doc');
  assert.equal(commitBoth(db, { uid: 'u1' }, [{ op: 'update', path: 'reviews/p1__u1', data: { helpfulCount: { $op: 'inc', n: 1 } } }]).tolerant.allowed, false, 'pending review');
});

const ticket = { userId: 'u1', name: 'Rahim', email: 'r@x.co', phone: '', subject: 'Where is my order', message: 'It is late', orderNumber: '', status: 'open', priority: 'normal', createdAt: TS, updatedAt: TS, lastAuthor: 'customer' };
writeCase('support ticket by a signed-in customer', [{ op: 'set', path: 'supportTickets/tn', data: ticket }], ['u1'], ['u2']);
writeCase('guest ticket (no account)', [{ op: 'set', path: 'supportTickets/tg', data: { ...ticket, userId: null } }], ['anon'], ['u1']);
writeCase('ticket cannot be created as already solved or high priority', [{ op: 'set', path: 'supportTickets/tn', data: { ...ticket, status: 'closed', priority: 'urgent' } }], [], ['u1']);
writeCase('customer message on own ticket', [{ op: 'set', path: 'supportTickets/t1/messages/m2', data: { authorType: 'customer', authorUid: 'u1', text: 'Any update?', createdAt: TS } }], ['u1'], ['u2', 'anon']);
writeCase('customer cannot impersonate staff in a ticket', [{ op: 'set', path: 'supportTickets/t1/messages/m2', data: { authorType: 'staff', authorUid: 'u1', text: 'Refund approved', createdAt: TS } }], [], ['u1']);

writeCase('newsletter subscription', [{ op: 'set', path: 'newsletter/new@x.co', data: { email: 'new@x.co', source: 'footer', createdAt: TS } }], ['anon', 'u1'], []);
writeCase('newsletter email must match the id', [{ op: 'set', path: 'newsletter/new@x.co', data: { email: 'other@x.co', source: 'footer', createdAt: TS } }], [], ['anon']);
writeCase('review reports', [{ op: 'set', path: 'reviewReports/p1__u2__u1', data: { reviewId: 'p1__u2', productId: 'p1', reporterId: 'u1', reason: 'spam', createdAt: TS } }], [], []);
test('review report: one per reporter, reporter must be the caller', () => {
  const db = db0();
  const data = { reviewId: 'p1__u2', productId: 'p1', reporterId: 'u1', reason: 'spam content', createdAt: TS };
  assert.equal(commitBoth(db, { uid: 'u1' }, [{ op: 'set', path: 'reviewReports/p1__u2__u1', data }]).strict.allowed, true);
  assert.equal(commitBoth(db, { uid: 'u2' }, [{ op: 'set', path: 'reviewReports/p1__u2__u1', data }]).tolerant.allowed, false);
  assert.equal(commitBoth(db, { uid: 'u1' }, [{ op: 'set', path: 'reviewReports/p1__u2__other', data }]).tolerant.allowed, false);
});

test('nobody can delete orders, audit logs or movements', () => {
  for (const id of ['sa', 'sadm', 'om', 'u1']) {
    assert.equal(commitBoth(db0(), who(id), [{ op: 'delete', path: 'orders/SV-261026-AAAAAA' }]).tolerant.allowed, false, `${id} delete order`);
  }
});
