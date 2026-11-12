/*
 * Staff-side product reads and writes for the admin pages. Pure rules live in shared/productFlow.js; this module only does I/O.
 *
 *   await loadProductForEdit(id)        → { product, inv: {key: doc}, cost: doc|null } | null        (fresh reads, not the 60 s catalog cache)
 *   await saveProduct({ mode, id, form, existing, names })     uniqueness reads → planner → inventory/index chunks → ONE atomic core batch
 *   await setProductsStatus(products, 'published' | 'draft' | 'archived')
 *   await deleteProduct(id)             refused while open orders hold reserved stock
 *   newProductId()
 *
 * A save is not one batch for big variable products (a batch may touch 20 documents): the idempotent part — inventory documents, SKU index,
 * stock movement — goes first in chunks, then the product document, slug index, cost data, catalog stamp and audit entry land together.
 * If the second step fails, a repeat of the save completes it; until then the new inventory documents are simply not referenced by any product.
 */
import { getDocDataSafe } from '../../data/db.js';
import { commitAtomic, commitChunked } from '../../data/write.js';
import { actor, can } from '../../data/auth.js';
import { invalidateCatalog } from '../../data/catalog.js';
import { invalidateAdminCatalog } from './catalogAdmin.js';
import { planProductSave, planProductStatus, planProductDelete, cleanProductForm, skuKey, unitsOf } from '../../shared/productFlow.js';
import { lineKey, autoId } from '../../shared/id.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t, has } from '../../core/i18n.js';

registerBoth({
  'pd.err.forbidden': ['Your role cannot change products.', 'আপনার রোল দিয়ে প্রোডাক্ট বদলানো যাবে না।'],
  'pd.err.legacy': ['This product is still in the old format. Run the migration first (Setup page), then edit it.', 'এই প্রোডাক্ট এখনো পুরনো ফরম্যাটে আছে। আগে মাইগ্রেশন চালান (সেটআপ পেজ), তারপর এডিট করুন।'],
  'pd.err.has_reservations': ['Open orders still hold stock of this product. Archive it instead, or finish those orders first.', 'খোলা অর্ডারে এই প্রোডাক্টের স্টক আটকে আছে। বরং আর্কাইভ করুন, অথবা আগে ওই অর্ডারগুলো শেষ করুন।'],
  'pd.err.not_found': ['The product was not found.', 'প্রোডাক্টটি পাওয়া যায়নি।'],
  'pd.err.bad_id': ['The product id is not valid.', 'প্রোডাক্ট আইডি সঠিক নয়।'],
  'pd.err.invalid': ['Some fields need attention.', 'কিছু ঘর ঠিক করা দরকার।'],
  'pd.err.bad_status': ['Unknown status.', 'অজানা অবস্থা।'],
});

export const newProductId = () => autoId(20);

function explain(res) {
  const key = `pd.err.${res.error}`;
  return new AppError(res.error, has(key) ? t(key) : res.message || res.error, { errors: res.errors || {}, variantErrors: res.variantErrors || {} });
}
const refresh = () => { invalidateAdminCatalog(); invalidateCatalog(); };

export async function loadProductForEdit(id) {
  const product = await getDocDataSafe(`products/${id}`);
  if (!product) return null;
  const keys = product.type === 'variable' && Array.isArray(product.variants) ? product.variants.map((v) => lineKey(id, v.id)) : [id];
  const [docs, cost] = await Promise.all([
    Promise.all(keys.map((k) => getDocDataSafe(`inventory/${k}`))),
    can('costs.read') ? getDocDataSafe(`productPrivate/${id}`) : Promise.resolve(null),
  ]);
  const inv = {};
  keys.forEach((k, i) => { if (docs[i]) inv[k] = docs[i]; });
  return { product, inv, cost };
}

async function uniquenessOf(id, f) {
  const skus = [...new Set(unitsOf(id, f).map((u) => (u.sku ? skuKey(u.sku) : '')).filter(Boolean))];
  const [slugDoc, skuDocs] = await Promise.all([
    f.slug ? getDocDataSafe(`slugIndex/${f.slug}`) : Promise.resolve(null),
    Promise.all(skus.map((k) => getDocDataSafe(`skuIndex/${k}`))),
  ]);
  const skuOwners = {};
  skus.forEach((k, i) => { if (skuDocs[i]) skuOwners[k] = { productId: skuDocs[i].productId, variantId: skuDocs[i].variantId ?? null }; });
  return { slugOwner: slugDoc ? slugDoc.productId : null, skuOwners };
}

export async function saveProduct({ mode, id, form, existing = null, names = {} }) {
  const f = cleanProductForm(form);
  const unique = await uniquenessOf(id, f);
  const plan = planProductSave({ mode, id, form, existing, unique, actor: actor(), nowMs: Date.now(), names });
  if (!plan.ok) throw explain(plan);
  await commitChunked(plan.pre);
  await commitAtomic(plan.core);
  refresh();
  return plan;
}

export async function setProductsStatus(products, status) {
  const plan = planProductStatus({ products, status, actor: actor(), nowMs: Date.now() });
  if (!plan.ok) throw explain(plan);
  for (const chunk of plan.chunks) await commitAtomic(chunk);
  refresh();
  return plan;
}

export async function deleteProduct(id) {
  const existing = await loadProductForEdit(id);
  if (!existing) throw explain({ error: 'not_found' });
  const plan = planProductDelete({ id, existing: { product: existing.product, inv: existing.inv }, actor: actor(), nowMs: Date.now() });
  if (!plan.ok) throw explain(plan);
  await commitChunked(plan.pre);
  await commitAtomic(plan.core);
  refresh();
  return { images: existing.product.images || [] };
}
