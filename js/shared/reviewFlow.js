/*
 * Review moderation — pure planners (no I/O), so the admin Reviews page and the rules tests run the exact same code.
 *
 *   planReviewModeration({ review, to, note, approved, approvedCapped, productRating, productExists, productName, reportIds, actor, nowMs })
 *        → { ok, id, action, ops, followUp, rating, reportsCleared } | { ok:false, error, errors? }
 *        to: 'approved' | 'rejected' | 'pending'       (error codes: forbidden · not_found · bad_status · no_change · invalid)
 *   planReviewDelete({ review, approved, approvedCapped, productRating, productExists, productName, reportIds, actor, nowMs })   → same shape
 *   planReportsDismiss({ review, reportIds, productName, actor })      → { ok, id, action, ops, followUp }      (error: no_reports)
 *   nextRating({ review, wasApproved, willBeApproved, approved, approvedCapped, productRating })   → { ratingSum, ratingCount, ratingAvg }
 *   groupReports(reports)                                  → Map reviewId → [{ id, reason, createdMs }]   newest first
 *   filterReviews(list, { q, rating, verified, names })    → list          orderReviews(list, status) → sorted copy
 *
 * `review` is a view from reviewModel.normalizeReview. `approved` is the FRESH list [{ id, rating }] of the product's approved reviews,
 * `reportIds` the document ids of the reports filed against the review (reviewReports/{reviewId__reporterUid}).
 *
 * firestore.rules lets everyone with reviews.moderate (Super Admin, Store Admin, Product Manager, Customer Support) change a review in any way and
 * change ONLY ratingSum / ratingCount / ratingAvg on a product. So this file is what keeps the numbers honest:
 *   • a review counts towards the product's rating only while it is APPROVED. Every change in or out of "approved" (approve, reject, back to pending,
 *     delete) rewrites the three rating fields from the fresh list of approved reviews — self-healing: a wrong number is repaired the next time any
 *     review of that product is moderated. When the product has more approved reviews than one read can return (`approvedCapped`), the stored
 *     aggregate is adjusted instead.
 *   • moderation stamps the review (moderatedBy, moderatedAt, moderationNote = the reason of a rejection, shown to the author) and never touches
 *     what the customer wrote; a rejection / deletion also clears the reports filed against the review (they are answered)
 *   • any change that rewrites the rating also bumps meta/catalog so shops that cached the catalog fetch the new stars
 *   • every change is audited: review.approve / review.reject / review.pending / review.delete / review.reports_dismiss
 * Reports beyond what fits in the first atomic batch go to `followUp` (committed in chunks afterwards; a failure there only leaves reports behind).
 */
import { TS } from './ops.js';
import { roleCan } from './constants.js';
import { auditOp, catalogStampOp } from './orderFlow.js';
import { REVIEW_LIMITS, REVIEW_STATUS, ratingFields } from './reviewModel.js';
import { toMillis } from './pricing.js';

export const MODERATION = Object.freeze({ PERM: 'reviews.moderate', NOTE_MAX: REVIEW_LIMITS.REASON_MAX, REPORTS_IN_BATCH: 12 });

const ACTION = Object.freeze({ approved: 'review.approve', rejected: 'review.reject', pending: 'review.pending' });
const VERB = Object.freeze({ approved: 'approved', rejected: 'rejected', pending: 'moved back to pending' });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const cleanNote = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const round2 = (n) => Math.round(n * 100) / 100;
const idList = (ids) => [...new Set((ids || []).filter((x) => typeof x === 'string' && x && !x.includes('/')))];
const allowed = (actor) => !!actor && roleCan(actor.role, MODERATION.PERM);
const describe = (r, productName) => `review "${String(r.title || '').slice(0, 60)}" by ${r.userName || 'a customer'} (${r.rating}/5) on ${productName || r.productId}`;

/** The product's rating fields after `review` stops / starts counting. */
export function nextRating({ review, wasApproved, willBeApproved, approved = [], approvedCapped = false, productRating = null }) {
  if (approvedCapped) {
    let sum = Math.max(0, Number(productRating && productRating.ratingSum) || 0);
    let count = Math.max(0, Number(productRating && productRating.ratingCount) || 0);
    if (wasApproved && !willBeApproved) { sum -= review.rating; count -= 1; }
    if (!wasApproved && willBeApproved) { sum += review.rating; count += 1; }
    count = Math.max(0, count);
    sum = count ? Math.max(0, sum) : 0;
    return { ratingSum: sum, ratingCount: count, ratingAvg: count ? round2(sum / count) : 0 };
  }
  const others = (approved || []).filter((r) => r && r.id !== review.id);
  return ratingFields(willBeApproved ? [...others, { id: review.id, rating: review.rating }] : others);
}

/** Split report deletions into what joins the atomic batch and what follows in chunks. */
function reportOps(ids) {
  const ops = ids.map((id) => ({ op: 'delete', path: `reviewReports/${id}` }));
  return { inBatch: ops.slice(0, MODERATION.REPORTS_IN_BATCH), followUp: ops.slice(MODERATION.REPORTS_IN_BATCH) };
}

export function planReviewModeration({
  review, to, note = '', approved = [], approvedCapped = false, productRating = null, productExists = true, productName = '', reportIds = [], actor, nowMs = Date.now(),
}) {
  if (!allowed(actor)) return fail('forbidden');
  if (!review || !review.id || !review.productId) return fail('not_found');
  if (!REVIEW_STATUS[to]) return fail('bad_status');
  if (review.status === to) return fail('no_change');
  const text = to === 'rejected' ? cleanNote(note) : '';
  if (text.length > MODERATION.NOTE_MAX) return fail('invalid', { errors: { note: 'too_long' } });

  const wasApproved = review.status === 'approved';
  const willBeApproved = to === 'approved';
  const recount = wasApproved !== willBeApproved && productExists !== false;
  const rating = recount ? nextRating({ review, wasApproved, willBeApproved, approved, approvedCapped, productRating }) : null;
  const reports = reportOps(to === 'rejected' ? idList(reportIds) : []);
  const action = ACTION[to];
  const cleared = reports.inBatch.length + reports.followUp.length;

  const ops = [
    { op: 'update', path: `reviews/${review.id}`, data: { status: to, moderatedBy: actor.uid, moderatedAt: TS, moderationNote: text } },
  ];
  if (rating) ops.push({ op: 'update', path: `products/${review.productId}`, data: { ...rating } });
  ops.push(...reports.inBatch);
  ops.push(auditOp(actor, {
    action, entity: 'review', entityId: review.id,
    summary: `${describe(review, productName)} ${VERB[to]}${text ? ` — ${text}` : ''}${cleared ? ` (${cleared} report${cleared === 1 ? '' : 's'} cleared)` : ''}`,
    before: { status: review.status },
    after: { status: to, ...(text ? { note: text } : {}), ...(rating ? { ratingCount: rating.ratingCount, ratingAvg: rating.ratingAvg } : {}) },
  }));
  if (rating) ops.push(catalogStampOp(nowMs));
  return { ok: true, id: review.id, action, ops, followUp: reports.followUp, rating, reportsCleared: cleared };
}

export function planReviewDelete({
  review, approved = [], approvedCapped = false, productRating = null, productExists = true, productName = '', reportIds = [], actor, nowMs = Date.now(),
}) {
  if (!allowed(actor)) return fail('forbidden');
  if (!review || !review.id || !review.productId) return fail('not_found');
  const wasApproved = review.status === 'approved';
  const rating = wasApproved && productExists !== false
    ? nextRating({ review, wasApproved: true, willBeApproved: false, approved, approvedCapped, productRating }) : null;
  const reports = reportOps(idList(reportIds));
  const cleared = reports.inBatch.length + reports.followUp.length;

  const ops = [{ op: 'delete', path: `reviews/${review.id}` }];
  if (rating) ops.push({ op: 'update', path: `products/${review.productId}`, data: { ...rating } });
  ops.push(...reports.inBatch);
  ops.push(auditOp(actor, {
    action: 'review.delete', entity: 'review', entityId: review.id,
    summary: `${describe(review, productName)} deleted${cleared ? ` (${cleared} report${cleared === 1 ? '' : 's'} cleared)` : ''}`,
    before: { status: review.status, rating: review.rating, title: String(review.title || '').slice(0, 100), text: String(review.text || '').slice(0, 300), userId: review.userId },
    after: rating ? { ratingCount: rating.ratingCount, ratingAvg: rating.ratingAvg } : null,
  }));
  if (rating) ops.push(catalogStampOp(nowMs));
  return { ok: true, id: review.id, action: 'review.delete', ops, followUp: reports.followUp, rating, reportsCleared: cleared };
}

export function planReportsDismiss({ review, reportIds = [], productName = '', actor }) {
  if (!allowed(actor)) return fail('forbidden');
  if (!review || !review.id) return fail('not_found');
  const ids = idList(reportIds);
  if (!ids.length) return fail('no_reports');
  const reports = reportOps(ids);
  return {
    ok: true, id: review.id, action: 'review.reports_dismiss',
    ops: [
      ...reports.inBatch,
      auditOp(actor, {
        action: 'review.reports_dismiss', entity: 'review', entityId: review.id,
        summary: `${ids.length} report${ids.length === 1 ? '' : 's'} on ${describe(review, productName)} dismissed — the review stays as it is`,
        before: { reports: ids.length }, after: { reports: 0, status: review.status },
      }),
    ],
    followUp: reports.followUp,
  };
}

/** Report documents → Map reviewId → [{ id, reason, createdMs }], newest first. */
export function groupReports(reports = []) {
  const map = new Map();
  for (const r of reports) {
    if (!r || !r.reviewId) continue;
    const list = map.get(r.reviewId) || [];
    list.push({ id: r.id, reason: String(r.reason || ''), createdMs: toMillis(r.createdAt) || 0 });
    map.set(r.reviewId, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.createdMs - a.createdMs);
  return map;
}

/** Search (title, text, reviewer, product name / id, order number), exact star filter, verified-purchase filter. */
export function filterReviews(list, { q = '', rating = 0, verified = '', names = {} } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const stars = Number(rating) || 0;
  return (list || []).filter((r) => {
    if (stars && r.rating !== stars) return false;
    if (verified === 'yes' && !r.verified) return false;
    if (verified === 'no' && r.verified) return false;
    if (!needle) return true;
    return [r.title, r.text, r.userName, names[r.productId], r.productId, r.orderNumber].some((v) => String(v || '').toLowerCase().includes(needle));
  });
}

/** The queue is worked oldest first (nothing waits forever); the archives show the newest first. */
export function orderReviews(list, status) {
  const dir = status === 'pending' ? 1 : -1;
  return (list || []).slice().sort((a, b) => dir * ((a.createdMs || 0) - (b.createdMs || 0)) || String(a.id).localeCompare(String(b.id)));
}
