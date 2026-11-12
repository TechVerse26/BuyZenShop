/*
 * Content for the admin pages: the home page layout (content/home) and the CMS pages (pages/{slug}). The rules of the game live in shared/contentFlow.js;
 * this module only does I/O.
 *
 *   await loadHomeDoc()                    → { exists, sections, updatedMs }   `exists:false` = never saved here, `sections` is then the standard layout visitors see
 *   await saveHome(sections)               → the sanitised sections that were stored        (throws AppError: invalid (`problems`) · no_change · forbidden)
 *   await loadPages()                      → pages [{ slug, title, body, visible, footer, sort, seoTitle, seoDescription, updatedAtMs }] by sort, then title
 *   await loadPageDoc(slug)                → page | null
 *   await savePage({ page, isNew })        → the plan (id, action)                          (throws: invalid (`errors`) · exists · not_found · no_change · forbidden)
 *   await setPageFlag({ slug, field, value }) · deletePage(slug)
 *   await pickerData()                     → { products, categories }      what the home editor offers to pick from
 *   await uploadHomeImage(file)            → { url, path }                 a picture for a slide or banner (Storage site/banners/…)
 *
 * Every write re-reads what it changes first, so what is planned is what is stored right now.
 */
import { listDocs, getDocDataSafe } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { toMillis } from '../../shared/pricing.js';
import { normalizeHome, normalizePage } from '../../shared/contentModel.js';
import { planHomeSave, planPageSave, planPageFlag, planPageDelete } from '../../shared/contentFlow.js';
import { uploadSiteImage } from '../lib/images.js';
import { loadScope } from './coupons.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t } from '../../core/i18n.js';

registerBoth({
  'chm.err.forbidden': ['You are not allowed to edit the content.', 'কনটেন্ট বদলানোর অনুমতি আপনার নেই।'],
  'chm.err.invalid': ['Check the fields marked in red and try again.', 'লাল চিহ্নিত ঘরগুলো দেখে আবার চেষ্টা করুন।'],
  'chm.err.no_change': ['Nothing has changed since the last save.', 'শেষ সংরক্ষণের পর কিছুই বদলায়নি।'],
  'chm.err.exists': ['A page with this address already exists.', 'এই ঠিকানায় আগে থেকেই একটি পেজ আছে।'],
  'chm.err.not_found': ['This page no longer exists. Reload the list.', 'এই পেজটি আর নেই। তালিকা রিলোড করুন।'],
});

const refusal = (plan) => new AppError(plan.error, t(`chm.err.${plan.error}`) || plan.error, { ...(plan.problems ? { problems: plan.problems } : {}), ...(plan.errors ? { errors: plan.errors } : {}) });
const run = async (plan) => { if (!plan.ok) throw refusal(plan); await commitAtomic(plan.ops); return plan; };

export async function loadHomeDoc() {
  const d = await getDocDataSafe('content/home');
  const exists = !!d && Array.isArray(d.sections);
  return { exists, sections: normalizeHome(exists ? d : null).sections, updatedMs: exists ? toMillis(d.updatedAt) || 0 : 0 };
}

export async function saveHome(sections) {
  const d = await getDocDataSafe('content/home');
  const before = d && Array.isArray(d.sections) ? d.sections : null;
  return (await run(planHomeSave({ sections, before, actor: actor() }))).sections;
}

export async function loadPages() {
  const r = await listDocs('pages', { limit: 200 });
  return r.docs.map((d) => normalizePage(d.id, d)).sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
}

export async function loadPageDoc(slug) {
  const d = await getDocDataSafe(`pages/${slug}`);
  return d ? normalizePage(slug, d) : null;
}

export async function savePage({ page, isNew }) {
  const slug = String(page.slug || '').trim();
  const existing = slug && /^[a-z0-9-]+$/.test(slug) ? await getDocDataSafe(`pages/${slug}`) : null;
  return run(planPageSave({ page, existing, isNew, actor: actor() }));
}

export async function setPageFlag({ slug, field, value }) {
  const page = await loadPageDoc(slug);
  return run(planPageFlag({ page, field, value, actor: actor() }));
}

export async function deletePage(slug) {
  const page = await loadPageDoc(slug);
  return run(planPageDelete({ page, actor: actor() }));
}

export const pickerData = () => loadScope();

export const uploadHomeImage = (file) => uploadSiteImage('banners', file, { maxSide: 1920, quality: 0.84 });
