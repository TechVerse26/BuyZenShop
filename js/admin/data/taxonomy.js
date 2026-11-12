/*
 * Categories & brands data for the admin pages. The rules of the game live in shared/taxonomyFlow.js; this module only does I/O.
 *
 *   await loadTaxonomy(kind)                → { items, products }   items fresh from Firestore; products = the cached admin catalog, slimmed to what counting needs
 *   await reloadItems(kind)                 → items                  after a write (the product list does not change by writing a category)
 *   await saveTaxonomy({ kind, creating, id, form })      one atomic batch (document + audit + stamp), then the product names in chunks
 *   await setTaxonomyVisible({ kind, id, visible })
 *   await removeTaxonomy({ kind, id })      refuses while sub-categories, products or a coupon point at it (checked just now, not from the list)
 *   await moveCategory({ id, dir })
 *   await uploadTaxonomyImage(kind, file)  → { url, path }           discardUpload(path)  best effort, never throws
 *
 * kind: 'category' | 'brand'. A refusal is thrown as an AppError carrying `.errors` ({ field: message }) when a form field is at fault.
 */
import { listDocs } from '../../data/db.js';
import { commitAtomic, commitChunked } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { invalidateCatalog } from '../../data/catalog.js';
import { loadAdminCatalog, invalidateAdminCatalog } from './catalogAdmin.js';
import { uploadSiteImage, deleteStoragePath } from '../lib/images.js';
import { KINDS, planTaxonomySave, planTaxonomyVisible, planTaxonomyRemove, planCategoryMove } from '../../shared/taxonomyFlow.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t, has } from '../../core/i18n.js';

registerBoth({
  'tax.err.forbidden': ['You are not allowed to change this.', 'এটি বদলানোর অনুমতি আপনার নেই।'],
  'tax.err.not_found': ['This item no longer exists. Reload the page.', 'এই আইটেমটি আর নেই। পেজ রিলোড করুন।'],
  'tax.err.no_change': ['Nothing was changed.', 'কিছুই বদলানো হয়নি।'],
  'tax.err.invalid': ['Please fix the highlighted fields.', 'চিহ্নিত ঘরগুলো ঠিক করুন।'],
  'tax.err.has_children': ['It has {n} sub-categories. Move or delete them first.', 'এর {n}টি সাব-ক্যাটাগরি আছে। আগে সেগুলো সরান বা মুছুন।'],
  'tax.err.in_use.category': ['{n} products are in this category. Move them to another category first.', 'এই ক্যাটাগরিতে {n}টি পণ্য আছে। আগে সেগুলো অন্য ক্যাটাগরিতে সরান।'],
  'tax.err.in_use.brand': ['{n} products have this brand. Change their brand first.', '{n}টি পণ্য এই ব্র্যান্ডের। আগে সেগুলোর ব্র্যান্ড বদলান।'],
  'tax.err.coupon_scope': ['The coupon {list} is limited to this category. Change that coupon first.', '{list} কুপনটি এই ক্যাটাগরির জন্য সীমিত। আগে সেই কুপন বদলান।'],
  'tax.err.partial': ['Saved, but {n} products still show the old name. Save again to finish.', 'সংরক্ষিত হয়েছে, কিন্তু {n}টি পণ্যে এখনও পুরনো নাম আছে। শেষ করতে আবার সংরক্ষণ করুন।'],
  'tax.fe.required': ['This field is required.', 'এই ঘরটি পূরণ করতে হবে।'],
  'tax.fe.too_long': ['That is too long.', 'অনেক লম্বা হয়ে গেছে।'],
  'tax.fe.name_taken': ['This name is already used here.', 'এই নামটি এখানে আগে থেকেই আছে।'],
  'tax.fe.bad_slug': ['Use small letters, digits and single hyphens (80 characters at most).', 'ইংরেজি ছোট হাতের অক্ষর, সংখ্যা ও একক হাইফেন ব্যবহার করুন (সর্বোচ্চ ৮০ অক্ষর)।'],
  'tax.fe.slug_taken': ['This link is already used. Choose another.', 'এই লিংকটি আগে থেকেই ব্যবহার হচ্ছে। অন্যটি বাছুন।'],
  'tax.fe.bad_parent': ['Choose a category from the list.', 'তালিকা থেকে একটি ক্যাটাগরি বাছুন।'],
  'tax.fe.too_deep': ['Sub-categories go only two levels deep. Choose a top-level category.', 'সাব-ক্যাটাগরি সর্বোচ্চ দুই স্তর। একটি টপ-লেভেল ক্যাটাগরি বাছুন।'],
  'tax.fe.has_children': ['This category has sub-categories, so it cannot go under another one.', 'এই ক্যাটাগরির সাব-ক্যাটাগরি আছে, তাই এটি অন্যের নিচে যেতে পারে না।'],
  'tax.fe.bad_image': ['The image link is not valid. Upload the image again.', 'ছবির লিংকটি সঠিক নয়। ছবিটি আবার আপলোড করুন।'],
});

const cfgOf = (kind) => {
  const c = KINDS[kind];
  if (!c) throw new AppError('not_found', t('tax.err.not_found'));
  return c;
};

function refusal(res) {
  const key = res.error === 'in_use' ? `tax.err.in_use.${res.kind || 'category'}` : `tax.err.${res.error}`;
  const params = { n: res.count ?? 0, list: (res.coupons || []).slice(0, 5).join(', ') };
  const errors = res.errors
    ? Object.fromEntries(Object.entries(res.errors).map(([f, code]) => [f === 'parentId' ? 'parentId' : f, t(has(`tax.fe.${code}`) ? `tax.fe.${code}` : 'tax.fe.required')]))
    : null;
  return new AppError(res.error, has(key) ? t(key, params) : res.error, errors ? { errors } : {});
}

async function commit(plan, kind) {
  if (!plan.ok) throw refusal({ ...plan, kind });
  await commitAtomic(plan.ops);
  return plan;
}
const done = () => { invalidateAdminCatalog(); invalidateCatalog(); };

export async function reloadItems(kind) {
  const cfg = cfgOf(kind);
  const { docs } = await listDocs(cfg.collection, { limit: 500 });
  return docs;
}

export async function loadTaxonomy(kind) {
  cfgOf(kind);
  const [items, cat] = await Promise.all([reloadItems(kind), loadAdminCatalog()]);
  const products = cat.products.map((p) => ({ id: p.id, categoryId: p.categoryId || '', brandId: p.brandId || '', categoryName: p.categoryName || '', brandName: p.brandName || '' }));
  return { items, products };
}

export async function saveTaxonomy({ kind, creating = false, id = null, form }) {
  const cfg = cfgOf(kind);
  const items = await reloadItems(kind);
  const products = creating ? [] : (await listDocs('products', { where: [[cfg.idOnProduct, '==', id]], limit: 1000 })).docs;
  const plan = await commit(planTaxonomySave({ kind, creating, id, form, items, products, actor: actor() }), kind);
  try {
    if (plan.followUp.length) await commitChunked(plan.followUp);
  } catch (e) {
    done();
    throw new AppError('partial', t('tax.err.partial', { n: plan.renamed }), { saved: true, cause: e });
  }
  done();
  return plan;
}

export async function setTaxonomyVisible({ kind, id, visible }) {
  cfgOf(kind);
  const items = await reloadItems(kind);
  const plan = await commit(planTaxonomyVisible({ kind, id, visible, items, actor: actor() }), kind);
  done();
  return plan;
}

export async function removeTaxonomy({ kind, id }) {
  const cfg = cfgOf(kind);
  const items = await reloadItems(kind);
  const inUse = await listDocs('products', { where: [[cfg.idOnProduct, '==', id]], limit: 1000 });
  let coupons = [];
  if (kind === 'category') {
    try {
      coupons = (await listDocs('coupons', { limit: 300 })).docs.filter((c) => c.appliesTo === 'categories' && Array.isArray(c.categoryIds) && c.categoryIds.includes(id)).map((c) => c.id);
    } catch { coupons = []; }
  }
  const plan = await commit(planTaxonomyRemove({ kind, id, items, refs: { products: inUse.docs.length, coupons }, actor: actor() }), kind);
  done();
  if (plan.imagePath) await deleteStoragePath(plan.imagePath);
  return plan;
}

export async function moveCategory({ id, dir }) {
  const items = await reloadItems('category');
  const plan = await commit(planCategoryMove({ id, dir, items, actor: actor() }), 'category');
  done();
  return plan;
}

export const uploadTaxonomyImage = (kind, file) => uploadSiteImage(kind === 'category' ? 'categories' : 'brands', file, { maxSide: 800, quality: 0.85 });
export const discardUpload = (path) => (path ? deleteStoragePath(path) : Promise.resolve());
