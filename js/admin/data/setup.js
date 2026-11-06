/*
 * I/O for the Setup & migration page. The rules of the game live in shared/readiness.js and shared/migration.js.
 *
 *   await gatherSnapshot()          → the plain snapshot evaluateReadiness() needs (a collection this role may not read is `undefined`)
 *   await previewMigration()        → the migration plan for the data as it is right now (nothing is written)  — needs migrate.run
 *   await runMigration(plan, { onProgress })    commits the plan in atomic chunks of 18 operations, in order
 *
 * The migration is non-destructive and idempotent (see shared/migration.js): an interrupted run is simply started again — it
 * re-reads the data, finds what is already converted and continues.
 */
import { getDocData, listDocs } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor, can } from '../../data/auth.js';
import { invalidateCatalog } from '../../data/catalog.js';
import { planMigration } from '../../shared/migration.js';
import { chunkOps } from '../../shared/ops.js';
import { LIMITS, LEGACY } from '../../shared/constants.js';
import { AppError, isPermissionDenied } from '../../core/errors.js';
import { registerBoth, t } from '../../core/i18n.js';
import { invalidateAdminCatalog } from './catalogAdmin.js';

registerBoth({
  'stp.err.forbidden': ['Only a Super Admin can run the migration.', 'শুধু সুপার অ্যাডমিন মাইগ্রেশন চালাতে পারেন।'],
  'stp.err.too_many': ['There are more documents than this screen can read safely in one go ({what}). Contact the developer before migrating.', 'এই স্ক্রিন একবারে নিরাপদে পড়ার চেয়ে বেশি ডকুমেন্ট আছে ({what})। মাইগ্রেশনের আগে ডেভেলপারের সাথে কথা বলুন।'],
});

const LIMIT = { products: 1000, inventory: 4000, categories: 500, orders: 2000, coupons: 500, usage: 5000, slugs: 3000 };

/** `undefined` when this role is not allowed to read it (anything else — a network failure, say — is thrown). */
async function attempt(fn) {
  try { return await fn(); } catch (e) { if (isPermissionDenied(e)) return undefined; throw e; }
}
const docOrNull = async (path) => { const d = await getDocData(path); return d || null; };
const raw = (d) => { const { id, ...rest } = d; return { id, data: rest }; };

/** Reads only what this role is allowed to read (a denied read is noise in the console and a failed request in the log). */
export async function gatherSnapshot() {
  const mayCatalog = can('products.read');
  const [settings, priv, home, zones, categories, products, inventory, staff] = await Promise.all([
    docOrNull('settings/public'),
    can('settings.read') ? attempt(() => docOrNull('settings/private')) : undefined,
    docOrNull('content/home'),
    attempt(() => listDocs('shippingZones', { limit: 200 })),
    mayCatalog ? attempt(() => listDocs('categories', { limit: LIMIT.categories })) : undefined,
    mayCatalog ? attempt(() => listDocs('products', { limit: LIMIT.products })) : undefined,
    mayCatalog ? attempt(() => listDocs('inventory', { limit: LIMIT.inventory })) : undefined,
    can('staff.manage') ? attempt(() => listDocs('staff', { limit: 200 })) : undefined,
  ]);
  return {
    settings, private: priv, home,
    zones: zones && zones.docs, categories: categories && categories.docs, products: products && products.docs,
    inventoryIds: inventory && inventory.docs.map((d) => d.id), staff: staff && staff.docs,
    truncated: !!(products && products.size >= LIMIT.products),
  };
}

export async function previewMigration() {
  if (!can('migrate.run')) throw new AppError('forbidden', t('stp.err.forbidden'));
  const [products, orders, categories, zones, slugs, inventory, coupons, usage, pub, priv, home] = await Promise.all([
    listDocs('products', { limit: LIMIT.products }),
    listDocs('orders', { where: [['voucherCode', '==', LEGACY.voucherCode]], limit: LIMIT.orders }),
    listDocs('categories', { limit: LIMIT.categories }),
    listDocs('shippingZones', { limit: 200 }),
    listDocs('slugIndex', { limit: LIMIT.slugs }),
    listDocs('inventory', { limit: LIMIT.inventory }),
    listDocs('coupons', { limit: LIMIT.coupons }),
    listDocs('couponUsage', { where: [['code', '==', LEGACY.voucherCode]], limit: LIMIT.usage }),
    docOrNull('settings/public'), docOrNull('settings/private'), docOrNull('content/home'),
  ]);
  for (const [name, list, max] of [['products', products, LIMIT.products], ['inventory', inventory, LIMIT.inventory], ['orders', orders, LIMIT.orders], ['categories', categories, LIMIT.categories], ['slugs', slugs, LIMIT.slugs]]) {
    if (list.size >= max) throw new AppError('too_many', t('stp.err.too_many', { what: `${name} ≥ ${max}` }));
  }
  return planMigration({
    products: products.docs.map(raw),
    legacyOrders: orders.docs.map(raw),
    existing: {
      categories: categories.docs.map(raw), zones: zones.docs.map(raw),
      slugIndex: new Set(slugs.docs.map((d) => d.id)), inventoryKeys: new Set(inventory.docs.map((d) => d.id)),
      settingsPublic: pub, settingsPrivate: priv, home,
      couponCodes: new Set(coupons.docs.map((d) => d.id)), couponUsageIds: new Set(usage.docs.map((d) => d.id)),
    },
    actor: actor(), nowMs: Date.now(),
  });
}

/** Sequential atomic chunks; on failure the error says how many chunks were written (`chunksDone`) — start again, it continues. */
export async function runMigration(plan, { onProgress } = {}) {
  if (!can('migrate.run')) throw new AppError('forbidden', t('stp.err.forbidden'));
  const chunks = chunkOps(plan.ops, LIMITS.ADMIN_BATCH_OPS);
  let done = 0;
  try {
    for (const chunk of chunks) { await commitAtomic(chunk); done += 1; if (onProgress) onProgress(done, chunks.length); }
  } catch (e) { e.chunksDone = done; throw e; } finally { if (done) { invalidateAdminCatalog(); invalidateCatalog(); } }
  return { done, total: chunks.length };
}
