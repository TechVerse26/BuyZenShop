/*
 * Review moderation data for the admin page. The rules of the game live in shared/reviewFlow.js; this module only does I/O.
 *
 *   await loadReviewList(status)        → { items: ReviewView[], capped }   'pending' | 'approved' | 'rejected' — one equality query, at most LIST_CAP
 *   await loadReports()                 → { grouped: Map reviewId → [{ id, reason, createdMs }], capped }
 *   await loadReviewsByIds(ids)         → ReviewView[]                      (reviews that no longer exist are skipped)
 *   await productNames()                → { [productId]: name }             from the cached admin catalog
 *   await moderateReview({ id, to, note })    approve / reject (+ reason) / back to pending: the review, the product's rating, the audit entry
 *   await deleteReview({ id })                the review, its reports, the product's rating, the audit entry
 *   await dismissReports({ id })              deletes the reports filed against an approved review and keeps the review
 *
 * Every write re-reads the review, the product's approved reviews and the review's reports first, so what is planned is what is stored right now,
 * not what the list on screen showed. A refusal is thrown as an AppError with a message for the screen.
 */
import { listDocs, getDocDataSafe } from '../../data/db.js';
import { commitAtomic, commitChunked } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { invalidateCatalog } from '../../data/catalog.js';
import { loadAdminCatalog, invalidateAdminCatalog } from './catalogAdmin.js';
import { normalizeReview } from '../../shared/reviewModel.js';
import { planReviewModeration, planReviewDelete, planReportsDismiss, groupReports } from '../../shared/reviewFlow.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t } from '../../core/i18n.js';

registerBoth({
  'rvm.err.forbidden': ['You are not allowed to moderate reviews.', 'রিভিউ মডারেট করার অনুমতি আপনার নেই।'],
  'rvm.err.not_found': ['This review no longer exists. Reload the list.', 'এই রিভিউটি আর নেই। তালিকা রিলোড করুন।'],
  'rvm.err.no_change': ['Someone already changed this review. Reload the list.', 'রিভিউটি ইতিমধ্যে বদলানো হয়েছে। তালিকা রিলোড করুন।'],
  'rvm.err.bad_status': ['That is not a valid status.', 'এটি সঠিক অবস্থা নয়।'],
  'rvm.err.invalid': ['The reason is too long (200 characters at most).', 'কারণ অনেক লম্বা (সর্বোচ্চ ২০০ অক্ষর)।'],
  'rvm.err.no_reports': ['There are no reports to dismiss.', 'বাতিল করার মতো কোনো রিপোর্ট নেই।'],
});

export const LIST_CAP = 200;
export const APPROVED_CAP = 1000;
export const REPORTS_CAP = 300;
const REPORTED_MAX = 60;

const refusal = (plan) => new AppError(plan.error, t(`rvm.err.${plan.error}`) || plan.error, plan.errors ? { errors: plan.errors } : {});

export async function loadReviewList(status) {
  const r = await listDocs('reviews', { where: [['status', '==', status]], limit: LIST_CAP });
  return { items: r.docs.map((d) => normalizeReview(d.id, d)), capped: r.size >= LIST_CAP };
}

export async function loadReports() {
  const r = await listDocs('reviewReports', { limit: REPORTS_CAP });
  return { grouped: groupReports(r.docs), capped: r.size >= REPORTS_CAP };
}

export async function loadReviewsByIds(ids) {
  const unique = [...new Set(ids)].slice(0, REPORTED_MAX);
  const list = await Promise.all(unique.map(async (id) => {
    const d = await getDocDataSafe(`reviews/${id}`);
    return d ? normalizeReview(id, d) : null;
  }));
  return list.filter(Boolean);
}

export async function productNames() {
  const cat = await loadAdminCatalog();
  return Object.fromEntries(cat.products.map((p) => [p.id, p.name || p.id]));
}

/** What the planners need, read just now. `light`: only the review and its reports (dismissing does not touch the rating). */
async function context(id, { light = false } = {}) {
  const raw = await getDocDataSafe(`reviews/${id}`);
  if (!raw) throw new AppError('not_found', t('rvm.err.not_found'));
  const review = normalizeReview(id, raw);
  const [reports, approved, product] = await Promise.all([
    listDocs('reviewReports', { where: [['reviewId', '==', id]], limit: REPORTS_CAP }),
    light ? null : listDocs('reviews', { where: [['productId', '==', review.productId], ['status', '==', 'approved']], limit: APPROVED_CAP }),
    getDocDataSafe(`products/${review.productId}`),
  ]);
  return {
    review,
    reportIds: reports.docs.map((d) => d.id),
    approved: approved ? approved.docs.map((d) => ({ id: d.id, rating: normalizeReview(d.id, d).rating })) : [],
    approvedCapped: !!approved && approved.size >= APPROVED_CAP,
    productRating: product ? { ratingSum: product.ratingSum, ratingCount: product.ratingCount } : null,
    productExists: !!product,
    productName: product ? product.name || '' : '',
  };
}

async function run(plan) {
  if (!plan.ok) throw refusal(plan);
  await commitAtomic(plan.ops);
  if (plan.followUp && plan.followUp.length) {
    // reports beyond the first batch: the review itself is already done, so a failure here only leaves some reports behind
    try { await commitChunked(plan.followUp); } catch (e) { console.warn('review reports not fully cleared', e && e.code); }
  }
  if (plan.rating) { invalidateAdminCatalog(); invalidateCatalog(); }
  return plan;
}

export async function moderateReview({ id, to, note = '' }) {
  const c = await context(id);
  return run(planReviewModeration({ ...c, to, note, actor: actor(), nowMs: Date.now() }));
}

export async function deleteReview({ id }) {
  const c = await context(id);
  return run(planReviewDelete({ ...c, actor: actor(), nowMs: Date.now() }));
}

export async function dismissReports({ id }) {
  const c = await context(id, { light: true });
  return run(planReportsDismiss({ review: c.review, reportIds: c.reportIds, productName: c.productName, actor: actor() }));
}
