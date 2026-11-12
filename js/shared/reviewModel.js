/*
 * Product reviews — pure helpers shared by the storefront and the admin moderation page.
 *
 *   reviews/{PRODUCTID__UID}   one review per customer per product (the document id enforces it)
 *     { productId, userId, userName, rating 1–5, title, text, status: pending|approved|rejected,
 *       verified, orderNumber, lineKey, helpfulCount, createdAt, updatedAt,
 *       moderatedBy, moderatedAt, moderationNote   ← added by a moderator (shared/reviewFlow.js); never by the customer }
 *
 * `verified` is only ever true for a delivered order that contains the product — the security rules read that order
 * (`orders/{orderNumber}.items[lineKey].productId`), so a customer cannot claim it for something they did not buy.
 * The shapes below mirror the field lists and length limits in firestore.rules; the rules stay the authority.
 *
 *   validateReview(input)            → { rating?, title?, text? }   codes: required | short | long   ({} = valid)
 *   buildReviewDoc({...})            → document for the first write (status 'pending')
 *   findVerifiedLine(orders, pid)    → { orderNumber, lineKey } | null     (newest delivered, non-legacy order)
 *   summarize(reviews)               → { count, avg, dist: [n1..n5] }
 *   ratingFields(approvedReviews)    → { ratingSum, ratingCount, ratingAvg }  (what moderators write back to the product)
 */
import { TS } from './ops.js';
import { toMillis } from './pricing.js';

export const REVIEW_LIMITS = Object.freeze({ TITLE_MIN: 2, TITLE_MAX: 100, TEXT_MIN: 5, TEXT_MAX: 1000, NAME_MAX: 80, REASON_MIN: 2, REASON_MAX: 200 });

export const REVIEW_STATUS = Object.freeze({
  pending: { label: 'Pending', bn: 'অপেক্ষমাণ', tone: 'warn' },
  approved: { label: 'Approved', bn: 'অনুমোদিত', tone: 'ok' },
  rejected: { label: 'Rejected', bn: 'বাতিল', tone: 'bad' },
});

export const reviewId = (productId, uid) => `${productId}__${uid}`;

const clamp = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Public display name: first name + last initial ("Rahim K."). Never the email. */
export function publicName(displayName) {
  const parts = String(displayName ?? '').replace(/[<>]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts[0].includes('@')) return '';
  if (parts.length === 1) return parts[0].slice(0, REVIEW_LIMITS.NAME_MAX);
  const last = [...parts[parts.length - 1]][0] || '';
  return `${parts[0]} ${last}.`.slice(0, REVIEW_LIMITS.NAME_MAX);
}

export function cleanReviewInput(i = {}) {
  const rating = Math.round(Number(i.rating));
  return {
    rating: Number.isFinite(rating) ? rating : 0,
    title: clamp(i.title, REVIEW_LIMITS.TITLE_MAX + 20),
    text: String(i.text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, REVIEW_LIMITS.TEXT_MAX + 50),
  };
}

export function validateReview(input = {}) {
  const i = cleanReviewInput(input);
  const e = {};
  if (!(i.rating >= 1 && i.rating <= 5)) e.rating = 'required';
  if (!i.title) e.title = 'required';
  else if (i.title.length < REVIEW_LIMITS.TITLE_MIN) e.title = 'short';
  else if (i.title.length > REVIEW_LIMITS.TITLE_MAX) e.title = 'long';
  if (!i.text) e.text = 'required';
  else if (i.text.length < REVIEW_LIMITS.TEXT_MIN) e.text = 'short';
  else if (i.text.length > REVIEW_LIMITS.TEXT_MAX) e.text = 'long';
  return e;
}

export function buildReviewDoc({ productId, uid, userName = '', rating, title, text, verified = false, orderNumber = '', lineKey = '' }) {
  const i = cleanReviewInput({ rating, title, text });
  return {
    productId, userId: uid, userName: String(userName).slice(0, REVIEW_LIMITS.NAME_MAX),
    rating: i.rating, title: i.title, text: i.text,
    status: 'pending', verified: verified === true,
    orderNumber: verified ? String(orderNumber) : '', lineKey: verified ? String(lineKey) : '',
    helpfulCount: 0, createdAt: TS, updatedAt: TS,
  };
}

/** Document → view model. */
export function normalizeReview(id, d = {}) {
  return {
    id, productId: d.productId || '', userId: d.userId || '', userName: d.userName || '',
    rating: Math.max(0, Math.min(5, Math.round(Number(d.rating) || 0))),
    title: d.title || '', text: d.text || '',
    status: REVIEW_STATUS[d.status] ? d.status : 'pending',
    verified: d.verified === true, orderNumber: d.orderNumber || '', lineKey: d.lineKey || '',
    helpfulCount: Math.max(0, Number(d.helpfulCount) || 0),
    note: typeof d.moderationNote === 'string' ? d.moderationNote : '',        // the reason a moderator gave when rejecting (shown to the author)
    moderatedMs: toMillis(d.moderatedAt),
    createdMs: toMillis(d.createdAt), updatedMs: toMillis(d.updatedAt),
  };
}

/** The newest delivered, schema-2 order that contains the product (legacy orders have no line map, so the rules cannot verify them). */
export function findVerifiedLine(orders, productId) {
  const list = (orders || []).filter((o) => o && !o.isLegacy && o.status === 'delivered')
    .sort((a, b) => (b.deliveredAtMs || b.createdAtMs || 0) - (a.deliveredAtMs || a.createdAtMs || 0));
  for (const o of list) {
    const line = (o.items || []).find((l) => l.productId === productId);
    if (line && line.key) return { orderNumber: o.id, lineKey: line.key };
  }
  return null;
}

export function summarize(reviews) {
  const dist = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const r of reviews || []) { if (r.rating >= 1 && r.rating <= 5) { dist[r.rating - 1] += 1; sum += r.rating; } }
  const count = dist.reduce((a, b) => a + b, 0);
  return { count, avg: count ? Math.round((sum / count) * 10) / 10 : 0, dist };
}

/** Fields a moderator writes back to products/{id} after an approval change (only approved reviews count). */
export function ratingFields(approved) {
  const list = (approved || []).filter((r) => r.rating >= 1 && r.rating <= 5);
  const ratingSum = list.reduce((s, r) => s + r.rating, 0);
  const ratingCount = list.length;
  return { ratingSum, ratingCount, ratingAvg: ratingCount ? Math.round((ratingSum / ratingCount) * 100) / 100 : 0 };
}

export const REVIEW_SORTS = Object.freeze(['newest', 'helpful', 'highest', 'lowest']);

export function sortReviews(list, mode = 'newest') {
  const by = {
    newest: (a, b) => b.createdMs - a.createdMs,
    helpful: (a, b) => b.helpfulCount - a.helpfulCount || b.createdMs - a.createdMs,
    highest: (a, b) => b.rating - a.rating || b.createdMs - a.createdMs,
    lowest: (a, b) => a.rating - b.rating || b.createdMs - a.createdMs,
  }[mode] || ((a, b) => b.createdMs - a.createdMs);
  return list.slice().sort(by);
}
