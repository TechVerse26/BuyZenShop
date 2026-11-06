/*
 * Reviews (customer side). Document shapes and limits live in shared/reviewModel.js and firestore.rules.
 *
 *   await loadApprovedReviews(productId)                → ReviewView[]   (approved only; sort client-side)
 *   await getMyReview(productId, uid)                   → ReviewView | null   (any status — the rules let owners read their own)
 *   await submitReview({ product, uid, user, rating, title, text })   → creates a 'pending' review (verified when a delivered order has the product)
 *   await editMyReview(review, uid, patch) / deleteMyReview(review, uid)     (only while pending — the rules enforce it)
 *   await voteHelpful(review, uid)   (+1, once per person: votes/{uid} is created in the same batch)
 *   await reportReview(review, uid, reason)
 *   hasVoted(id) / hasReported(id)   device-local memory so buttons stay disabled after reload
 */
import { listDocs } from './db.js';
import { commitAtomic } from './write.js';
import { listMyOrders } from './orders.js';
import { TS, inc } from '../shared/ops.js';
import { local } from '../core/storage.js';
import { AppError } from '../core/errors.js';
import { registerBoth, t } from '../core/i18n.js';
import { REVIEW_LIMITS, reviewId, normalizeReview, validateReview, cleanReviewInput, buildReviewDoc, findVerifiedLine, publicName } from '../shared/reviewModel.js';

registerBoth({
  'rev.err.fix': ['Please fix the highlighted fields.', 'হাইলাইট করা ঘরগুলো ঠিক করুন।'],
  'rev.err.reason': ['Tell us briefly what is wrong (2–200 characters).', 'সংক্ষেপে সমস্যাটা লিখুন (২–২০০ অক্ষর)।'],
});

const VOTES_KEY = 'sv.review.votes';
const REPORTS_KEY = 'sv.review.reports';
const remembered = (key) => new Set(local.get(key, []));
const remember = (key, id) => { const s = remembered(key); s.add(id); local.set(key, [...s].slice(-300)); };
export const hasVoted = (id) => remembered(VOTES_KEY).has(id);
export const hasReported = (id) => remembered(REPORTS_KEY).has(id);

export async function loadApprovedReviews(productId, max = 100) {
  const { docs } = await listDocs('reviews', { where: [['productId', '==', productId], ['status', '==', 'approved']], limit: max });
  return docs.map((d) => { const { id, ...rest } = d; return normalizeReview(id, rest); });
}

export async function getMyReview(productId, uid) {
  const { docs } = await listDocs('reviews', { where: [['userId', '==', uid], ['productId', '==', productId]], limit: 1 });
  if (!docs.length) return null;
  const { id, ...rest } = docs[0];
  return normalizeReview(id, rest);
}

async function verifiedLineFor(uid, productId) {
  try { return findVerifiedLine(await listMyOrders(uid), productId); } catch { return null; }   // no orders readable → simply unverified
}

function assertValid(input) {
  const errs = validateReview(input);
  if (Object.keys(errs).length) throw new AppError('validation', t('rev.err.fix'), { fields: errs });
}

export async function submitReview({ product, uid, user, rating, title, text }) {
  assertValid({ rating, title, text });
  const line = await verifiedLineFor(uid, product.id);
  const doc = buildReviewDoc({
    productId: product.id, uid, userName: publicName(user?.displayName), rating, title, text,
    verified: !!line, orderNumber: line?.orderNumber || '', lineKey: line?.lineKey || '',
  });
  await commitAtomic([{ op: 'set', path: `reviews/${reviewId(product.id, uid)}`, data: doc }]);
}

export async function editMyReview(review, uid, patch) {
  assertValid(patch);
  const i = cleanReviewInput(patch);
  await commitAtomic([{ op: 'update', path: `reviews/${reviewId(review.productId, uid)}`, data: { rating: i.rating, title: i.title, text: i.text, updatedAt: TS } }]);
}

export async function deleteMyReview(review, uid) {
  await commitAtomic([{ op: 'delete', path: `reviews/${reviewId(review.productId, uid)}` }]);
}

export async function voteHelpful(review, uid) {
  try {
    await commitAtomic([
      { op: 'set', path: `reviews/${review.id}/votes/${uid}`, data: { createdAt: TS } },
      { op: 'update', path: `reviews/${review.id}`, data: { helpfulCount: inc(1) } },
    ]);
  } catch (e) {
    if (/permission-denied|insufficient permissions/i.test(`${e?.code} ${e?.message}`)) { remember(VOTES_KEY, review.id); return false; }   // already voted (e.g. on another device)
    throw e;
  }
  remember(VOTES_KEY, review.id);
  return true;
}

export async function reportReview(review, uid, reason) {
  const r = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (r.length < REVIEW_LIMITS.REASON_MIN || r.length > REVIEW_LIMITS.REASON_MAX) throw new AppError('validation', t('rev.err.reason'), { fields: { reason: t('rev.err.reason') } });
  try {
    await commitAtomic([{ op: 'set', path: `reviewReports/${review.id}__${uid}`, data: { reviewId: review.id, productId: review.productId, reporterId: uid, reason: r, createdAt: TS } }]);
  } catch (e) {
    if (/permission-denied|insufficient permissions/i.test(`${e?.code} ${e?.message}`)) { remember(REPORTS_KEY, review.id); return false; }   // already reported
    throw e;
  }
  remember(REPORTS_KEY, review.id);
  return true;
}
