/*
 * Coupons data for the Coupons page. The rules of the game live in shared/couponFlow.js; this module only does I/O.
 *
 *   await loadCoupons()                          → [{ id, code, type, value, … }] newest first
 *   await loadScope()                            → { products: [{ id, name, sku, categoryId }], categories: [{ id, name, parentId }] }  (what a coupon can be limited to)
 *   await customerLabels(uids)                   → Map uid → e-mail (or the uid itself when the account has none)
 *   await saveCoupon({ creating, code, form })   one atomic batch: the coupon + an audit entry; form.customers = e-mails or UIDs, one per entry
 *   await setCouponActive({ code, active })
 *   await removeCoupon({ code })                 only a coupon that was never used
 *
 * The coupon is always re-read just before a change, so a stale list cannot overwrite a newer usage count.
 * A refusal is thrown as an AppError carrying `.errors` ({ field: message }) when a form field is at fault.
 */
import { listDocs, getDocDataSafe } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { loadCatalog } from '../../data/catalog.js';
import { actor } from '../../data/auth.js';
import { findAccountByEmail } from './staff.js';
import { planCouponSave, planCouponActive, planCouponRemove, normalizeCode } from '../../shared/couponFlow.js';
import { toMillis } from '../../shared/pricing.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t, has } from '../../core/i18n.js';

registerBoth({
  'cpn.err.forbidden': ['You are not allowed to change coupons.', 'কুপন বদলানোর অনুমতি আপনার নেই।'],
  'cpn.err.not_found': ['This coupon no longer exists. Reload the page.', 'এই কুপনটি আর নেই। পেজ রিলোড করুন।'],
  'cpn.err.exists': ['A coupon with this code already exists.', 'এই কোডে আগে থেকেই একটি কুপন আছে।'],
  'cpn.err.used': ['This coupon has already been used, so it cannot be deleted. Switch it off instead.', 'এই কুপন ইতিমধ্যে ব্যবহার হয়েছে, তাই মোছা যাবে না। বরং বন্ধ করে রাখুন।'],
  'cpn.err.no_change': ['Nothing was changed.', 'কিছুই বদলানো হয়নি।'],
  'cpn.err.invalid': ['Please fix the highlighted fields.', 'চিহ্নিত ঘরগুলো ঠিক করুন।'],
  'cpn.fe.required': ['This field is required.', 'এই ঘরটি পূরণ করতে হবে।'],
  'cpn.fe.bad_code': ['Use 3–24 capital letters, digits or hyphens, no spaces.', '৩–২৪টি ইংরেজি বড় হাতের অক্ষর, সংখ্যা বা হাইফেন ব্যবহার করুন, ফাঁকা জায়গা নয়।'],
  'cpn.fe.exists': ['A coupon with this code already exists.', 'এই কোডে আগে থেকেই একটি কুপন আছে।'],
  'cpn.fe.bad_type': ['Choose the kind of coupon.', 'কুপনের ধরন বাছুন।'],
  'cpn.fe.bad_percent': ['Enter a whole percentage from 1 to 100.', '১ থেকে ১০০-এর মধ্যে পূর্ণ শতাংশ দিন।'],
  'cpn.fe.bad_amount': ['Enter a whole amount of taka (not negative, not too large).', 'পূর্ণ টাকার অঙ্ক দিন (ঋণাত্মক নয়, খুব বড়ও নয়)।'],
  'cpn.fe.bad_scope': ['Choose what the coupon applies to.', 'কুপন কীসের জন্য প্রযোজ্য তা বাছুন।'],
  'cpn.fe.none': ['Choose at least one.', 'কমপক্ষে একটি বাছুন।'],
  'cpn.fe.too_many': ['Too many selected.', 'অনেকগুলো বাছাই করা হয়েছে।'],
  'cpn.fe.unknown': ['Some of the selected items no longer exist. Untick them.', 'বাছাই করা কিছু আইটেম আর নেই। সেগুলোর টিক তুলে দিন।'],
  'cpn.fe.bad_date': ['Enter a valid date and time.', 'সঠিক তারিখ ও সময় দিন।'],
  'cpn.fe.end_before_start': ['The end must be after the start.', 'শেষের সময় শুরুর পরে হতে হবে।'],
  'cpn.fe.end_past': ['A new coupon cannot end in the past.', 'নতুন কুপনের শেষ সময় অতীতে হতে পারে না।'],
  'cpn.fe.bad_limit': ['Leave empty, or enter a whole number from 1.', 'ফাঁকা রাখুন, অথবা ১ বা তার বেশি পূর্ণ সংখ্যা দিন।'],
  'cpn.fe.limit_below_used': ['The coupon was already used more often than this. Enter at least the number of uses so far.', 'কুপনটি এর চেয়ে বেশিবার ব্যবহার হয়ে গেছে। এখন পর্যন্ত ব্যবহারের সংখ্যার সমান বা বেশি দিন।'],
  'cpn.fe.bad_customer': ['One of the entries is not a valid account.', 'একটি এন্ট্রি সঠিক অ্যাকাউন্ট নয়।'],
  'cpn.fe.unknown_customers': ['No account found for: {list}. They must have signed up on the store first.', 'এদের অ্যাকাউন্ট পাওয়া যায়নি: {list}। আগে স্টোরে সাইন-আপ করতে হবে।'],
  'cpn.fe.too_long': ['That is too long (200 characters at most).', 'অনেক লম্বা (সর্বোচ্চ ২০০ অক্ষর)।'],
});

// the planner names the lists after the data (productIds…); the page names them after what the person sees
const FIELD = { productIds: 'products', categoryIds: 'categories', customerIds: 'customers' };
const ms = (v) => toMillis(v) || 0;

export async function loadCoupons() {
  const { docs } = await listDocs('coupons', { limit: 300 });
  return docs.slice().sort((a, b) => ms(b.createdAt) - ms(a.createdAt) || String(a.id).localeCompare(String(b.id)));
}

export async function loadScope() {
  const cat = await loadCatalog();
  return {
    products: (cat.products || []).map((p) => ({ id: p.id, name: p.name || p.id, sku: p.sku || '', categoryId: p.categoryId || '' })),
    categories: (cat.categories || []).map((c) => ({ id: c.id, name: c.name || c.id, parentId: c.parentId || '' })),
  };
}

export async function customerLabels(uids) {
  const out = new Map();
  await Promise.all(uids.slice(0, 50).map(async (uid) => {
    let u = null;
    try { u = await getDocDataSafe(`users/${uid}`); } catch { u = null; }
    out.set(uid, (u && u.email) || uid);
  }));
  return out;
}

async function resolveCustomers(entries) {
  const ids = [];
  const missing = [];
  for (const raw of entries || []) {
    const e = String(raw).trim();
    if (!e) continue;
    if (e.includes('@')) {
      const u = await findAccountByEmail(e);
      if (u) ids.push(u.uid); else missing.push(e);
    } else ids.push(e);
  }
  return { ids: [...new Set(ids)], missing };
}

function refusal(res) {
  const key = `cpn.err.${res.error}`;
  const errors = res.errors
    ? Object.fromEntries(Object.entries(res.errors).map(([f, code]) => [FIELD[f] || f, t(has(`cpn.fe.${code}`) ? `cpn.fe.${code}` : 'cpn.fe.required')]))
    : null;
  return new AppError(res.error, has(key) ? t(key) : res.error, errors ? { errors } : {});
}

async function commit(plan) {
  if (!plan.ok) throw refusal(plan);
  await commitAtomic(plan.ops);
  return plan;
}

export async function saveCoupon({ creating = false, code = null, form, scope = null }) {
  const key = creating ? normalizeCode(form.code) : code;
  const current = key ? await getDocDataSafe(`coupons/${key}`) : null;
  const { ids, missing } = await resolveCustomers(form.customers);
  if (missing.length) {
    throw new AppError('invalid', t('cpn.err.invalid'), { errors: { customers: t('cpn.fe.unknown_customers', { list: missing.slice(0, 5).join(', ') }) } });
  }
  const catalog = scope ? { productIds: new Set(scope.products.map((p) => p.id)), categoryIds: new Set(scope.categories.map((c) => c.id)) } : null;
  return commit(planCouponSave({ creating, form: { ...form, customerIds: ids }, current, catalog, actor: actor() }));
}

export async function setCouponActive({ code, active }) {
  return commit(planCouponActive({ code, active, current: await getDocDataSafe(`coupons/${code}`), actor: actor() }));
}

export async function removeCoupon({ code }) {
  return commit(planCouponRemove({ code, current: await getDocDataSafe(`coupons/${code}`), actor: actor() }));
}
