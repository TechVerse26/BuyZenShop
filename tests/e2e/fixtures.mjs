/*
 * Seed data for the browser tests: a small but complete store (catalog, inventory, zones, coupons, CMS pages, staff, customers,
 * two real orders placed through the production order builder + the real security rules).
 *   buildSeed() → { docs: { 'collection/id': data }, users: [...], signedInAs: null, orderNumbers: [...], ticketId }
 * Timestamps serialise as { __ts: ms } (the mock revives them). Login: customer rahim@example.com / password1,
 * super admin admin@example.com / password1 (see `users` below for the other staff roles).
 */
import { MemDb, Ts } from '../rules/rules-engine.mjs';
import { inventoryDoc, strictEngine, toWrites, NOW, DAY } from '../rules/harness.mjs';
import { defaultSettingsPublic, defaultSettingsPrivate, defaultHome, defaultZones } from '../../js/shared/migration.js';
import { buildOrder } from '../../js/shared/orderBuilder.js';
import { isSentinel } from '../../js/shared/ops.js';

const ts = (ms) => new Ts(ms);
const toDb = (v) => {
  if (isSentinel(v)) return v.$op === 'ts' ? ts(NOW) : v.$op === 'inc' ? v.n : undefined;
  if (Array.isArray(v)) return v.map(toDb);
  if (v && typeof v === 'object' && !(v instanceof Ts)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const y = toDb(x); if (y !== undefined) o[k] = y; }
    return o;
  }
  return v;
};

export const AUTH_USERS = [
  { uid: 'u1', email: 'rahim@example.com', password: 'password1', displayName: 'Rahim' },
  { uid: 'u2', email: 'karim@example.com', password: 'password1', displayName: 'Karim' },
  { uid: 'sa', email: 'admin@example.com', password: 'password1', displayName: 'Super Admin' },
  { uid: 'sadm', email: 'store@example.com', password: 'password1', displayName: 'Store Admin' },
  { uid: 'pm', email: 'products@example.com', password: 'password1', displayName: 'Product Manager' },
  { uid: 'om', email: 'orders@example.com', password: 'password1', displayName: 'Order Manager' },
  { uid: 'im', email: 'inventory@example.com', password: 'password1', displayName: 'Inventory Manager' },
  { uid: 'cs', email: 'support@example.com', password: 'password1', displayName: 'Support Agent' },
  { uid: 'rp', email: 'reports@example.com', password: 'password1', displayName: 'Reporting' },
];

const CATS = {
  c1: { name: 'Clothing', slug: 'clothing', parentId: null, sort: 1 },
  c2: { name: 'Accessories', slug: 'accessories', parentId: null, sort: 2 },
  c3: { name: 'Watches', slug: 'watches', parentId: 'c2', sort: 1 },
};
const BRANDS = { b1: { name: 'Nordic', slug: 'nordic' }, b2: { name: 'Chronos', slug: 'chronos' } };
const IMG = (file, alt) => [{ id: 'i1', url: `/gallery/${file}`, thumb: `/gallery/${file}`, alt, w: 800, h: 800, path: '', thumbPath: '' }];
const SHIRT = IMG('argentina-home-t-shirt.webp', 'Cotton t-shirt');
const WATCH = IMG('watch-cut.webp', 'Sports watch');

/** A home page that uses every section type, so the browser tests render all of them. */
function richHome() {
  const base = defaultHome();
  const slide = (id, title, text, image, tone, link) => ({ id, image, title, text, cta: 'Shop now', link, tone, alt: title });
  const sections = [
    { id: 'hero1', type: 'hero', enabled: true, title: '', autoplay: false, interval: 6, slides: [
      slide('s1', 'New season arrivals', 'Fresh styles, delivered across Bangladesh.', '/gallery/argentina-home-t-shirt.webp', 'dark', '/shop'),
      slide('s2', 'Watches that last', 'Water resistant, built for everyday wear.', '/gallery/watch-cut.webp', 'light', '/category/watches'),
    ] },
    { id: 'trust1', type: 'trust', enabled: true, title: '', items: [
      { icon: 'truck', title: 'Nationwide delivery', text: 'Dhaka in 1–2 days' },
      { icon: 'wallet', title: 'Cash on Delivery', text: 'Pay when it arrives' },
      { icon: 'undo', title: 'Easy returns', text: '7 days, no fuss' },
      { icon: 'headset', title: 'Real support', text: 'WhatsApp and phone' },
    ] },
    ...base.sections.filter((s) => s.type === 'categories'),
    { id: 'banners1', type: 'banners', enabled: true, title: 'Featured', columns: 2, items: [
      { id: 'b1', image: '/gallery/watch-cut.webp', title: 'Watch sale', text: 'Up to 20% off', cta: 'View', link: '/category/watches', alt: 'Watch sale' },
      { id: 'b2', image: '/gallery/argentina-home-t-shirt.webp', title: 'Everyday tees', text: '', cta: '', link: '/category/clothing', alt: 'Everyday tees' },
    ] },
    ...base.sections.filter((s) => s.type === 'products'),
    { id: 'sale1', type: 'products', enabled: true, title: 'On sale', source: 'sale', categoryId: '', productIds: [], limit: 4, viewAllLink: '/shop?sale=1', endsAt: null },
    { id: 'brands1', type: 'brands', enabled: true, title: 'Brands', limit: 12 },
    { id: 'rich1', type: 'richText', enabled: true, title: 'Why Shop Verse', body: 'We ship **everywhere** in Bangladesh.\n\n- Honest prices\n- Tracked orders', align: 'start' },
    { id: 'news1', type: 'newsletter', enabled: true, title: '', text: '' },
  ];
  return { ...base, sections };
}

function product(o) {
  return {
    name: o.name, slug: o.slug, status: o.status || 'published', type: o.type || 'simple',
    categoryId: o.cat, categoryName: CATS[o.cat].name, brandId: o.brand || null, brandName: o.brand ? BRANDS[o.brand].name : '',
    price: o.price, salePrice: o.sale ?? null, saleStart: null, saleEnd: null, sku: o.sku, images: o.images || SHIRT, icon: '',
    shortDescription: o.short || '', description: o.desc || '', highlights: o.highlights || [], specs: o.specs || [], tags: o.tags || [],
    options: o.options || [], variants: o.variants || [], featured: !!o.featured, soldCount: o.sold || 0,
    ratingAvg: 0, ratingCount: 0, ratingSum: 0, seoTitle: '', seoDescription: '',
    createdAt: ts(NOW - (o.age || 1) * DAY), updatedAt: ts(NOW), schemaVersion: 2,
  };
}

export function buildSeed() {
  const db = new MemDb();
  const set = (k, v) => db.set(k, toDb(v));

  /* staff + customers */
  for (const [uid, role] of [['sa', 'super_admin'], ['sadm', 'store_admin'], ['pm', 'product_manager'], ['om', 'order_manager'], ['im', 'inventory_manager'], ['cs', 'customer_support'], ['rp', 'reporting']]) {
    const u = AUTH_USERS.find((x) => x.uid === uid);
    set(`staff/${uid}`, { role, active: true, email: u.email, name: u.displayName, createdAt: ts(NOW - 60 * DAY) });
  }
  set('users/u1', { displayName: 'Rahim', email: 'rahim@example.com', phone: '01711111111', createdAt: ts(NOW - 30 * DAY), defaultAddressId: 'a1' });
  set('users/u2', { displayName: 'Karim', email: 'karim@example.com', phone: '01822222222', createdAt: ts(NOW - 20 * DAY) });
  set('users/u1/addresses/a1', { label: 'Home', name: 'Rahim', phone: '01711111111', district: 'Sirajganj', upazila: 'Sirajganj Sadar', area: 'Barakuthi', postalCode: '6700', line1: 'House 12, Road 3, Barakuthi', isDefault: true, updatedAt: ts(NOW - DAY) });

  /* store configuration */
  set('settings/public', { ...defaultSettingsPublic(), announcement: { enabled: true, text: 'Test announcement — free delivery on selected items', link: '/shop' } });
  set('settings/private', defaultSettingsPrivate());
  set('content/home', richHome());
  set('meta/catalog', { version: 1, updatedAt: ts(NOW) });
  for (const z of defaultZones()) set(`shippingZones/${z.id}`, z.data);
  set('pages/about', { title: 'About us', body: '## Who we are\n\nWe sell everyday things online and deliver across Bangladesh.\n\n- Cash on Delivery\n- bKash and Nagad', visible: true, footer: true, sort: 1, seoTitle: '', seoDescription: '', updatedAt: ts(NOW) });
  set('pages/draft-page', { title: 'Hidden draft', body: 'not public', visible: false, footer: false, sort: 2, seoTitle: '', seoDescription: '', updatedAt: ts(NOW) });

  /* catalog */
  for (const [id, c] of Object.entries(CATS)) set(`categories/${id}`, { ...c, image: '', icon: '', description: '', visible: true, createdAt: ts(NOW - 40 * DAY), updatedAt: ts(NOW - 40 * DAY) });
  for (const [id, b] of Object.entries(BRANDS)) set(`brands/${id}`, { ...b, logo: '', description: '', visible: true, createdAt: ts(NOW - 40 * DAY), updatedAt: ts(NOW - 40 * DAY) });

  const P = [
    ['p1', { name: 'Classic Cotton T-Shirt', slug: 'classic-cotton-t-shirt', cat: 'c1', brand: 'b1', price: 1200, sku: 'TS-001', featured: true, sold: 14, age: 3, short: 'Soft everyday cotton tee.', desc: 'Breathable cotton with a relaxed fit.\n\n- 100% cotton\n- Machine washable', highlights: ['100% cotton', 'Relaxed fit'], specs: [{ label: 'Material', value: 'Cotton' }], tags: ['tee', 'cotton'] }, { stock: 25 }],
    ['p2', { name: 'Leather Wallet', slug: 'leather-wallet', cat: 'c2', brand: 'b1', price: 1800, sale: 1500, sku: 'WL-002', sold: 6, age: 5, short: 'Slim wallet with six card slots.' }, { stock: 3 }],
    ['p4', { name: 'Phone Case', slug: 'phone-case', cat: 'c2', price: 450, sku: 'PC-004', age: 9 }, { stock: 0, track: false }],
    ['p5', { name: 'Sports Watch', slug: 'sports-watch', cat: 'c3', brand: 'b2', price: 3500, sku: 'WA-005', images: WATCH, featured: true, sold: 9, age: 2, short: 'Water resistant, 30 m.' }, { stock: 50 }],
    ['p6', { name: 'Backorder Cap', slug: 'backorder-cap', cat: 'c1', price: 600, sku: 'CP-006', age: 12 }, { stock: 1, allowBackorder: true }],
    ['p7', { name: 'Sold Out Sunglasses', slug: 'sold-out-sunglasses', cat: 'c2', price: 900, sku: 'SG-007', age: 20 }, { stock: 0 }],
    ['pd', { name: 'Draft Product', slug: 'draft-product', cat: 'c1', price: 500, sku: 'DR-000', status: 'draft' }, { stock: 5 }],
  ];
  for (const [id, o, inv] of P) {
    set(`products/${id}`, product(o));
    set(`inventory/${id}`, inventoryDoc({ productId: id, categoryId: o.cat, sku: o.sku, price: o.price, salePrice: o.sale ?? null, ...inv }));
    set(`slugIndex/${o.slug}`, { productId: id });                                   // what the product editor / the migration keep for address and SKU uniqueness
    set(`skuIndex/${o.sku.toUpperCase()}`, { productId: id, variantId: null });
  }
  const sizes = ['40', '41', '42'];
  set('products/p3', product({
    name: 'Running Shoes', slug: 'running-shoes', cat: 'c1', brand: 'b2', type: 'variable', price: 2800, sku: 'RS-003', sold: 4, age: 7,
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((s, i) => ({ id: `v${i + 1}`, optionValues: { Size: s }, sku: `RS-003-${s}`, image: '', active: true })),
    short: 'Light daily trainers.',
  }));
  sizes.forEach((s, i) => set(`inventory/p3__v${i + 1}`, inventoryDoc({ productId: 'p3', variantId: `v${i + 1}`, categoryId: 'c1', sku: `RS-003-${s}`, price: 2800 + i * 100, stock: i === 2 ? 0 : 10 })));
  set('slugIndex/running-shoes', { productId: 'p3' });
  sizes.forEach((s, i) => set(`skuIndex/RS-003-${s}`, { productId: 'p3', variantId: `v${i + 1}` }));

  /* coupons */
  set('coupons/WELCOME10', { code: 'WELCOME10', type: 'percent', value: 10, maxDiscount: 200, minOrder: 500, appliesTo: 'all', productIds: [], categoryIds: [], excludeSaleItems: false, startsAt: null, endsAt: null, usageLimit: 100, usedCount: 0, perCustomerLimit: 1, customerIds: [], active: true });

  /* support ticket answered by the team (like real data: the customer's first message lives on the ticket, replies are message documents) */
  const ticketId = 'TK-261026-AAAAAA';
  const answeredAt = ts(NOW - DAY + 2 * 3600000);
  set(`supportTickets/${ticketId}`, { userId: 'u1', name: 'Rahim', email: 'rahim@example.com', phone: '01711111111', subject: 'Delivery question', message: 'When will my order arrive?', orderNumber: '', status: 'answered', priority: 'normal', lastAuthor: 'staff', createdAt: ts(NOW - DAY), updatedAt: answeredAt });
  set(`supportTickets/${ticketId}/messages/m1`, { authorType: 'staff', authorUid: 'cs', text: 'Your order ships tomorrow.', createdAt: answeredAt });

  /* in-app notifications of u1: two unread (one links to an order), one read */
  set('users/u1/notifications/n1', { title: 'Order confirmed', body: 'We have received your order and will pack it soon.', kind: 'order', orderNumber: 'SV-261025-AB12CD', read: false, createdAt: ts(NOW - 3 * 3600000) });
  set('users/u1/notifications/n2', { title: 'Welcome to Shop Verse', body: 'Thanks for creating an account.', kind: 'info', orderNumber: '', read: false, createdAt: ts(NOW - DAY) });
  set('users/u1/notifications/n3', { title: 'Delivery update', body: 'Your parcel is on its way.', kind: 'order', orderNumber: '', read: true, createdAt: ts(NOW - 2 * DAY) });

  /* two orders, placed exactly as the storefront does (order builder + rules in one atomic batch) */
  const zones = Object.fromEntries(defaultZones().map((z) => [z.id, { id: z.id, ...toDb(z.data) }]));
  const orderNumbers = [];
  const place = (uid, orderNumber, nowMs, lineSpecs, payment, district) => {
    const user = db.get(`users/${uid}`);
    const built = buildOrder({
      uid, orderNumber, nowMs,
      customer: { name: user.displayName, phone: user.phone, email: user.email },
      address: { name: user.displayName, phone: user.phone, district, upazila: '', area: '', postalCode: '', line1: 'House 1, Road 2, Test Area', notes: '' },
      zone: district === 'Sirajganj' ? zones['inside-sirajganj'] : zones['outside-sirajganj'],
      lines: lineSpecs.map((l) => ({ key: l.key, inv: db.get(`inventory/${l.key}`), qty: l.qty, name: l.name })),
      coupon: null, couponUsageCount: 0, payment, note: '',
    });
    const r = strictEngine.evaluateBatch({ db, auth: { uid }, now: nowMs, writes: toWrites(built.ops) });
    if (!r.allowed) throw new Error(`fixture order ${orderNumber} was rejected by the rules: ${r.results.filter((x) => !x.allowed).map((x) => `${x.op} ${x.key}: ${x.error}`).join(' | ')}`);
    for (const k of r.dbAfter.keys()) db.set(k, r.dbAfter.get(k));
    orderNumbers.push(orderNumber);
  };
  place('u1', 'SV-261025-AB12CD', NOW - 2 * DAY, [{ key: 'p1', qty: 2, name: 'Classic Cotton T-Shirt' }, { key: 'p5', qty: 1, name: 'Sports Watch' }], { method: 'cod' }, 'Sirajganj');
  place('u2', 'SV-261026-EF34GH', NOW - 3600000, [{ key: 'p2', qty: 1, name: 'Leather Wallet' }], { method: 'bkash', trxId: '8N7A6D5C4B', senderNumber: '01822222222' }, 'Dhaka');

  const docs = JSON.parse(JSON.stringify(Object.fromEntries(db.m.entries())));
  return { docs, users: AUTH_USERS, signedInAs: null, orderNumbers, ticketId };
}
