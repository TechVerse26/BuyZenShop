/*
 * Legacy → v2 migration planner (pure; the admin "Setup & migration" page executes the ops).
 *
 * Principles
 *  - Non-destructive: legacy fields (image, oldPrice, desc, stock …) are left in place; new fields are ADDED.
 *  - Idempotent: running it twice produces no duplicate work. Products that already have status+type are skipped.
 *  - Honest: nothing is invented. Stock quantities did not exist in the legacy data, so "In Stock" products
 *    become *untracked* (no limit) until someone enters counts, and "Out of Stock" products become tracked with 0.
 *  - Every written document must pass firestore.rules for a Super Admin (tests/rules/migration.rules.test.mjs).
 */

import { LEGACY, DISTRICTS, LIMITS, APP } from './constants.js';
import { TS } from './ops.js';
import { slugify, uniqueSlug } from './slug.js';
import { isLegacyProduct, assetUrl } from './productModel.js';
import { auditOp, catalogStampOp } from './orderFlow.js';
import { defaultHomeSections } from './contentModel.js';

const clip = (v, n) => String(v ?? '').slice(0, n);

export function defaultSettingsPublic() {
  return {
    storeName: 'Shop Verse',
    tagline: '',
    logoUrl: '',
    currency: APP.currency,
    orderPrefix: 'SV',
    contact: { whatsapp: '8801957329211', email: 'imran.info.me@gmail.com', phone: '', address: '' },
    social: { facebook: 'https://www.facebook.com/shopverseweb', instagram: '', youtube: '', tiktok: '' },
    payments: {
      cod: { enabled: true },
      bkash: { enabled: true, number: '01334108089', accountType: 'Personal', note: '' },
      nagad: { enabled: true, number: '01334108089', accountType: 'Personal', note: '' },
    },
    checkout: { guestCheckout: false, returnWindowDays: 7 },
    integrations: { tawk: { enabled: true, propertyId: LEGACY.tawk.propertyId, widgetId: LEGACY.tawk.widgetId } },
    announcement: { enabled: false, text: '', link: '' },
    seo: { title: 'Shop Verse', description: '' },
    ui: { banglaDigits: false },
    createdAt: TS,
    updatedAt: TS,
  };
}

export function defaultSettingsPrivate() {
  return { lowStockThreshold: 5, notifyEmails: [], invoice: { businessName: 'Shop Verse', address: '', phone: '', note: '' }, createdAt: TS, updatedAt: TS };
}

/** Homepage layout. Sections render from live data; no copy is invented here. */
export function defaultHome() {
  return { sections: defaultHomeSections(), updatedAt: TS };
}

export function defaultZones() {
  const others = DISTRICTS.filter((d) => d !== LEGACY.homeDistrict);
  return [
    { id: 'inside-sirajganj', data: { name: LEGACY.insideZoneName, districts: [LEGACY.homeDistrict], fee: LEGACY.insideZoneFee, freeOver: null, etaMin: 1, etaMax: 2, active: true, sort: 1, updatedAt: TS } },
    { id: 'outside-sirajganj', data: { name: LEGACY.outsideZoneName, districts: others, fee: LEGACY.outsideZoneFee, freeOver: null, etaMin: 2, etaMax: 5, active: true, sort: 2, updatedAt: TS } },
  ];
}

const intPrice = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };

/**
 * @param {object} p
 * @param {Array<{id,data}>} p.products           every document in products/
 * @param {Array<{id,data}>} [p.legacyOrders]     orders with voucherCode (for coupon usage backfill)
 * @param {object} p.existing  { categories:[{id,data}], zones:[{id}], slugIndex:Set, inventoryKeys:Set, settingsPublic, settingsPrivate, home, couponCodes:Set, couponUsageIds:Set }
 * @param {{uid,email,role}} p.actor
 * @param {number} p.nowMs
 */
export function planMigration({ products, legacyOrders = [], existing, actor, nowMs }) {
  const ex = {
    categories: [], zones: [], slugIndex: new Set(), inventoryKeys: new Set(), settingsPublic: null, settingsPrivate: null, home: null,
    couponCodes: new Set(), couponUsageIds: new Set(), ...existing,
  };
  const phases = [];
  const warnings = [];
  const report = {
    products: { total: products.length, migrated: 0, alreadyNew: 0, drafted: 0, tracked: 0, untracked: 0, inventoryCreated: 0 },
    categoriesCreated: 0, zonesCreated: 0, settingsCreated: false, homeCreated: false,
    coupon: { created: false, usageRecords: 0 },
    warnings,
  };

  /* ---- settings ---- */
  const settingsOps = [];
  if (!ex.settingsPublic) { settingsOps.push({ op: 'set', path: 'settings/public', data: defaultSettingsPublic() }); report.settingsCreated = true; }
  if (!ex.settingsPrivate) settingsOps.push({ op: 'set', path: 'settings/private', data: defaultSettingsPrivate() });
  if (!ex.home) { settingsOps.push({ op: 'set', path: 'content/home', data: defaultHome() }); report.homeCreated = true; }
  if (report.settingsCreated) warnings.push({ level: 'info', code: 'settings_created', text: 'Store settings were created from the old site (WhatsApp, e-mail, Facebook, bKash/Nagad number). The Nagad number was copied from the single number the old checkout showed for both wallets — please verify it in Settings.' });
  phases.push({ id: 'settings', title: 'Store settings & homepage layout', ops: settingsOps });

  /* ---- shipping zones ---- */
  const zoneOps = [];
  if (!ex.zones.length) {
    for (const z of defaultZones()) { zoneOps.push({ op: 'set', path: `shippingZones/${z.id}`, data: z.data }); report.zonesCreated++; }
    warnings.push({ level: 'info', code: 'zones_created', text: 'Shipping zones were created from the old flat rates (Sirajganj ৳70, everywhere else ৳130). Edit them in Shipping.' });
  }
  phases.push({ id: 'zones', title: 'Shipping zones', ops: zoneOps });

  /* ---- categories (derived from the legacy `category` strings) ---- */
  const catByName = new Map(ex.categories.map((c) => [String(c.data.name).toLowerCase(), c.id]));
  const catIds = new Set(ex.categories.map((c) => c.id));
  const catOps = [];
  const needCats = [...new Set(products.filter((p) => isLegacyProduct(p.data)).map((p) => clip(p.data.category || 'Others', 60).trim() || 'Others'))];
  let sortN = ex.categories.length;
  for (const name of needCats) {
    if (catByName.has(name.toLowerCase())) continue;
    const id = uniqueSlug(slugify(name) || 'category', catIds);
    catIds.add(id); catByName.set(name.toLowerCase(), id);
    catOps.push({ op: 'set', path: `categories/${id}`, data: { name, slug: id, parentId: null, image: '', icon: '', description: '', sort: ++sortN, visible: true, createdAt: TS, updatedAt: TS } });
    report.categoriesCreated++;
  }
  phases.push({ id: 'categories', title: 'Categories', ops: catOps });

  /* ---- products + inventory + slug index ---- */
  const taken = new Set(ex.slugIndex);
  for (const p of products) if (p.data.slug) taken.add(p.data.slug);
  const prodOps = [];
  for (const { id, data } of products) {
    const legacy = isLegacyProduct(data);
    if (!legacy) report.products.alreadyNew++;
    let categoryId = data.categoryId || '';
    let patch = null;
    let price = intPrice(data.price);
    let sale = null;
    let draftReason = '';
    let draftCode = '';

    if (legacy) {
      const name = clip(data.name, 200).trim();
      const oldPrice = intPrice(data.oldPrice);
      if (Number.isFinite(oldPrice) && oldPrice > price) { sale = price; price = oldPrice; }
      if (!name) { draftReason = 'no name'; draftCode = 'no_name'; }
      else if (!Number.isFinite(price) || price < 1) { draftReason = 'price is missing or zero'; draftCode = 'no_price'; }
      else if (price > LIMITS.MAX_PRICE) { draftReason = 'price is too large'; draftCode = 'price_too_large'; }
      if (!Number.isFinite(price) || price < 0 || price > LIMITS.MAX_PRICE) price = 0;
      if (sale !== null && !(sale < price)) sale = null;
      if (Number(data.price) !== Math.round(Number(data.price))) warnings.push({ level: 'warn', ref: id, code: 'price_rounded', params: { name: name || id, from: data.price, to: price }, text: `Product "${name || id}": price ${data.price} was rounded to ${price} (prices are whole taka).` });

      const catName = clip(data.category || 'Others', 60).trim() || 'Others';
      categoryId = catByName.get(catName.toLowerCase()) || '';
      const slug = uniqueSlug(slugify(name) || `p-${id.slice(0, 8).toLowerCase()}`, taken);
      taken.add(slug);
      const img = data.imageUrl || data.image || '';
      patch = {
        slug, status: draftReason ? 'draft' : 'published', type: 'simple',
        categoryId, categoryName: catName, brandId: '', brandName: '',
        price, salePrice: sale, saleStart: null, saleEnd: null, sku: '',
        images: img ? [{ url: assetUrl(String(img)), alt: name }] : [],
        shortDescription: '', description: clip(data.desc, 4000), highlights: [], specs: [], tags: [], options: [], variants: [],
        featured: false, soldCount: Number(data.soldCount) || 0,
        ratingAvg: Number(data.rating) || 0, ratingCount: Number(data.ratingCount) || 0, ratingSum: (Number(data.rating) || 0) * (Number(data.ratingCount) || 0),
        seoTitle: '', seoDescription: '',
        createdAt: data.timestamp ? new Date(data.timestamp) : TS, updatedAt: TS, migratedAt: TS, schemaVersion: APP.schemaVersion,
      };
      if (!data.name) patch.name = 'Untitled product';
      prodOps.push({ op: 'update', path: `products/${id}`, data: patch });
      prodOps.push({ op: 'set', path: `slugIndex/${slug}`, data: { productId: id } });
      report.products.migrated++;
      if (draftReason) { report.products.drafted++; warnings.push({ level: 'warn', ref: id, code: 'draft', params: { name: data.name || id, reason: draftCode }, text: `Product "${data.name || id}" was imported as a DRAFT (${draftReason}).` }); }
    } else {
      price = intPrice(data.price);
      sale = data.salePrice ?? null;
    }

    // inventory document (authoritative price / stock for checkout)
    if (!ex.inventoryKeys.has(id) && (!data.type || data.type === 'simple' || legacy)) {
      const soldOut = legacy && /out of stock/i.test(String(data.stock || ''));
      const track = !!soldOut;
      prodOps.push({
        op: 'set', path: `inventory/${id}`,
        data: {
          productId: id, variantId: null, categoryId, sku: '', price: Number.isFinite(price) ? price : 0, salePrice: sale, saleStart: null, saleEnd: null,
          stock: 0, reserved: 0, track, allowBackorder: false, maxPerOrder: 10, active: true, lowStockThreshold: 5, updatedAt: TS,
        },
      });
      report.products.inventoryCreated++;
      if (track) report.products.tracked++; else report.products.untracked++;
    }
  }
  if (report.products.untracked) {
    warnings.push({ level: 'info', code: 'untracked', params: { n: report.products.untracked }, text: `${report.products.untracked} product(s) were "In Stock" in the old site, which had no quantities. They are imported as UNTRACKED (no stock limit). Enter real counts in Inventory to enable stock control.` });
  }
  phases.push({ id: 'products', title: 'Products, inventory & slugs', ops: prodOps });

  /* ---- legacy voucher SHOPVERSE → real coupon + usage history ---- */
  const couponOps = [];
  const code = LEGACY.voucherCode;
  // The old site hard-coded this voucher. It is kept alive only when there is old data to carry over — a fresh install gets no coupon it never had.
  const hasLegacyData = products.some((p) => isLegacyProduct(p.data)) || legacyOrders.length > 0;
  if (hasLegacyData && !ex.couponCodes.has(code)) {
    const users = new Map();
    for (const o of legacyOrders) {
      if (o.data.voucherCode === code && o.data.userId) users.set(o.data.userId, o.id);
    }
    couponOps.push({
      op: 'set', path: `coupons/${code}`,
      data: {
        code, type: 'percent', value: LEGACY.voucherPercent, maxDiscount: null, minOrder: 0, appliesTo: 'all', productIds: [], categoryIds: [],
        excludeSaleItems: false, startsAt: null, endsAt: null, usageLimit: null, usedCount: users.size, perCustomerLimit: 1, customerIds: [], active: true,
        description: 'Migrated from the old site: 10% off, once per customer.', createdAt: TS, updatedAt: TS,
      },
    });
    report.coupon.created = true;
    for (const [uid, orderId] of users) {
      const usageId = `${code}__${uid}`;
      if (ex.couponUsageIds.has(usageId)) continue;
      couponOps.push({ op: 'set', path: `couponUsage/${usageId}`, data: { code, userId: uid, count: 1, lastOrderId: orderId, updatedAt: TS } });
      report.coupon.usageRecords++;
    }
  }
  phases.push({ id: 'coupon', title: 'Legacy voucher (SHOPVERSE)', ops: couponOps });

  /* ---- finishing ---- */
  const total = phases.reduce((n, ph) => n + ph.ops.length, 0);
  const closing = [];
  if (total > 0) {
    closing.push(catalogStampOp(nowMs));
    closing.push(auditOp(actor, {
      action: 'migration.v2', entity: 'system', entityId: 'migration',
      summary: `Legacy migration: ${report.products.migrated} products, ${report.categoriesCreated} categories, ${report.zonesCreated} zones`,
      after: { products: report.products.migrated, categories: report.categoriesCreated },
    }));
  }
  phases.push({ id: 'finish', title: 'Catalog stamp & audit entry', ops: closing });

  return { phases, ops: phases.flatMap((p) => p.ops), report, nothingToDo: total === 0 };
}
