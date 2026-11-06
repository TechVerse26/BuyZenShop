/*
 * Reviews: documents produced by shared/reviewModel.js and the writes issued by data/reviews.js, evaluated against the REAL
 * firestore.rules text (strict engine: any evaluation error denies; tolerant engine: production-like). Also unit-tests the pure model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewDoc, findVerifiedLine, reviewId, ratingFields, summarize, sortReviews, validateReview, publicName, normalizeReview, cleanReviewInput } from '../../js/shared/reviewModel.js';
import { normalizeOrder } from '../../js/shared/orderModel.js';
import { TS, inc } from '../../js/shared/ops.js';
import { baseDb, commitBoth, failedOps, NOW, DAY } from './harness.mjs';
import { Ts } from './rules-engine.mjs';

const line = (pid) => ({ productId: pid, variantId: null, name: `Item ${pid}`, image: '', sku: pid, qty: 1, unitPrice: 1000, lineTotal: 1000 });

function db0() {
  const db = baseDb();
  db.set('users/u3', { displayName: 'Nadia Rahman', createdAt: new Ts(NOW - 30 * DAY) });
  db.set('orders/SV-261020-DELIV1', { schemaVersion: 2, userId: 'u3', status: 'delivered', itemOrder: ['p1'], items: { p1: line('p1') }, totals: { total: 1070 }, createdAt: new Ts(NOW - 10 * DAY), deliveredAt: new Ts(NOW - 5 * DAY) });
  db.set('orders/SV-261024-PEND01', { schemaVersion: 2, userId: 'u3', status: 'pending', itemOrder: ['p5'], items: { p5: line('p5') }, totals: { total: 500 }, createdAt: new Ts(NOW - DAY) });
  db.set('reviews/p1__u2', { productId: 'p1', userId: 'u2', userName: 'Karim K.', rating: 4, title: 'Good', text: 'Good shirt', status: 'approved', verified: false, orderNumber: '', lineKey: '', helpfulCount: 0, createdAt: new Ts(NOW - DAY), updatedAt: new Ts(NOW - DAY) });
  db.set('reviews/p1__u3', { productId: 'p1', userId: 'u3', userName: 'Nadia R.', rating: 5, title: 'Great', text: 'Great shirt', status: 'pending', verified: true, orderNumber: 'SV-261020-DELIV1', lineKey: 'p1', helpfulCount: 0, createdAt: new Ts(NOW - DAY), updatedAt: new Ts(NOW - DAY) });
  return db;
}
const ok = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
};
const denied = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine allowed it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine allowed it`);
};
const orderOf = (db, id) => normalizeOrder(id, db.get(`orders/${id}`));

/* ───────────────────────── creating ───────────────────────── */

test('an unverified review built by the model is accepted as pending', () => {
  const db = db0();
  db.delete?.('reviews/p1__u3');
  const doc = buildReviewDoc({ productId: 'p5', uid: 'u3', userName: publicName('Nadia Rahman'), rating: 4, title: 'Nice watch', text: 'Looks good on the wrist.' });
  assert.equal(doc.status, 'pending'); assert.equal(doc.verified, false); assert.equal(doc.helpfulCount, 0);
  ok(db, 'u3', [{ op: 'set', path: `reviews/${reviewId('p5', 'u3')}`, data: doc }], 'create');
});

test('a verified purchase is found for a delivered order and accepted', () => {
  const db = db0();
  const found = findVerifiedLine([orderOf(db, 'SV-261020-DELIV1'), orderOf(db, 'SV-261024-PEND01')], 'p1');
  assert.deepEqual(found, { orderNumber: 'SV-261020-DELIV1', lineKey: 'p1' });
  const doc = buildReviewDoc({ productId: 'p1', uid: 'u3', userName: 'Nadia R.', rating: 5, title: 'Great shirt', text: 'Fits well.', verified: true, ...found });
  const fresh = db0(); fresh.delete?.('reviews/p1__u3');
  ok(fresh, 'u3', [{ op: 'set', path: 'reviews/p1__u3', data: doc }], 'verified create');
});

test('a pending order does not make a purchase verifiable, and forging it is refused', () => {
  const db = db0();
  assert.equal(findVerifiedLine([orderOf(db, 'SV-261024-PEND01')], 'p5'), null);
  const forged = buildReviewDoc({ productId: 'p5', uid: 'u3', userName: 'Nadia R.', rating: 5, title: 'Great watch', text: 'Fits well.', verified: true, orderNumber: 'SV-261024-PEND01', lineKey: 'p5' });
  denied(db, 'u3', [{ op: 'set', path: 'reviews/p5__u3', data: forged }], 'forged verified');
});

test("claiming someone else's delivered order is refused", () => {
  const db = db0();
  db.set('users/u1', { displayName: 'Rahim', createdAt: new Ts(NOW - 30 * DAY) });
  const forged = buildReviewDoc({ productId: 'p1', uid: 'u1', userName: 'Rahim', rating: 5, title: 'Great shirt', text: 'Fits well.', verified: true, orderNumber: 'SV-261020-DELIV1', lineKey: 'p1' });
  denied(db, 'u1', [{ op: 'set', path: 'reviews/p1__u1', data: forged }], "someone else's order");
});

test('legacy (array-items) orders cannot be verified by the rules, so the model skips them', () => {
  const legacy = normalizeOrder('OLD-1', { status: 'Delivered', userId: 'u3', items: [{ id: 'p1', name: 'x', qty: 1, price: 10 }], timestamp: '2026-01-01T00:00:00Z' });
  assert.equal(legacy.isLegacy, true);
  assert.equal(findVerifiedLine([legacy], 'p1'), null);
});

test('a review cannot be created as approved, with a bad rating, or under another id', () => {
  const db = db0(); db.delete?.('reviews/p1__u3');
  const base = buildReviewDoc({ productId: 'p1', uid: 'u3', userName: 'Nadia R.', rating: 5, title: 'Great', text: 'Great shirt' });
  denied(db, 'u3', [{ op: 'set', path: 'reviews/p1__u3', data: { ...base, status: 'approved' } }], 'self-approve');
  denied(db, 'u3', [{ op: 'set', path: 'reviews/p1__u3', data: { ...base, rating: 6 } }], 'rating 6');
  denied(db, 'u3', [{ op: 'set', path: 'reviews/p1__u3', data: { ...base, helpfulCount: 40 } }], 'inflated helpful count');
  denied(db, 'u3', [{ op: 'set', path: 'reviews/p1__other', data: base }], 'someone else’s id');
  denied(db, 'u3', [{ op: 'set', path: 'reviews/p1__u3', data: { ...base, extra: 1 } }], 'unknown field');
});

/* ───────────────────────── editing, deleting ───────────────────────── */

test('the author may edit and delete a pending review, but not an approved one', () => {
  const db = db0();
  ok(db, 'u3', [{ op: 'update', path: 'reviews/p1__u3', data: { rating: 4, title: 'Better title', text: 'Edited text here', updatedAt: TS } }], 'edit pending');
  denied(db, 'u3', [{ op: 'update', path: 'reviews/p1__u3', data: { status: 'approved', updatedAt: TS } }], 'self-approve by update');
  denied(db, 'u3', [{ op: 'update', path: 'reviews/p1__u3', data: { verified: false, updatedAt: TS } }], 'change verified flag');
  ok(db, 'u3', [{ op: 'delete', path: 'reviews/p1__u3' }], 'delete pending');
  db.set('reviews/p1__u3', { ...db.get('reviews/p1__u3'), status: 'approved' });
  denied(db, 'u3', [{ op: 'update', path: 'reviews/p1__u3', data: { rating: 1, title: 'Changed', text: 'Changed mind', updatedAt: TS } }], 'edit approved');
  denied(db, 'u3', [{ op: 'delete', path: 'reviews/p1__u3' }], 'delete approved');
  denied(db, 'u1', [{ op: 'update', path: 'reviews/p1__u3', data: { rating: 1, title: 'Hijack', text: 'Hijacked text', updatedAt: TS } }], 'edit by a stranger');
});

/* ───────────────────────── helpful votes and reports ───────────────────────── */

test('"helpful" is one vote per person, never on your own review', () => {
  const db = db0();
  const vote = (rid, uid) => [{ op: 'set', path: `reviews/${rid}/votes/${uid}`, data: { createdAt: TS } }, { op: 'update', path: `reviews/${rid}`, data: { helpfulCount: inc(1) } }];
  ok(db, 'u3', vote('p1__u2', 'u3'), 'vote');
  denied(db, 'u2', vote('p1__u2', 'u2'), 'vote on own review');
  denied(db, 'u3', [{ op: 'update', path: 'reviews/p1__u2', data: { helpfulCount: inc(5) } }], 'bump by 5');
  denied(db, 'u3', [{ op: 'update', path: 'reviews/p1__u2', data: { helpfulCount: inc(1) } }], 'bump without a vote document');
  db.set('reviews/p1__u2/votes/u3', { createdAt: new Ts(NOW) });
  denied(db, 'u3', vote('p1__u2', 'u3'), 'second vote');
});

test('reports: one per person per review, reason 2–200 characters', () => {
  const db = db0();
  const report = (reason, uid = 'u3') => [{ op: 'set', path: `reviewReports/p1__u2__${uid}`, data: { reviewId: 'p1__u2', productId: 'p1', reporterId: uid, reason, createdAt: TS } }];
  ok(db, 'u3', report('Looks like spam'), 'report');
  denied(db, 'u3', report('x'), 'reason too short');
  denied(db, 'u3', report('y'.repeat(201)), 'reason too long');
  denied(db, 'u3', report('Looks like spam', 'u1'), 'report as somebody else');
  db.set('reviewReports/p1__u2__u3', { reviewId: 'p1__u2', productId: 'p1', reporterId: 'u3', reason: 'Spam', createdAt: new Ts(NOW) });
  denied(db, 'u3', report('Looks like spam again'), 'second report by the same person');
});

/* ───────────────────────── pure model ───────────────────────── */

test('validateReview reports required / short / long per field', () => {
  assert.deepEqual(validateReview({ rating: 0, title: '', text: '' }), { rating: 'required', title: 'required', text: 'required' });
  assert.deepEqual(validateReview({ rating: 5, title: 'A', text: 'abc' }), { title: 'short', text: 'short' });
  assert.deepEqual(validateReview({ rating: 5, title: 'x'.repeat(101), text: 'y'.repeat(2000) }), { title: 'long', text: 'long' });
  assert.deepEqual(validateReview({ rating: 5, title: 'Nice', text: 'Works well.' }), {});
  assert.equal(cleanReviewInput({ rating: '4.6', title: '  a   b  ', text: ' hi  there ' }).rating, 5);
  assert.equal(cleanReviewInput({ title: '  a   b  ' }).title, 'a b');
});

test('publicName shows first name + last initial and never an email', () => {
  assert.equal(publicName('Nadia Rahman'), 'Nadia R.');
  assert.equal(publicName('Mary Jane Watson'), 'Mary W.');
  assert.equal(publicName('Rahim'), 'Rahim');
  assert.equal(publicName('a@b.co'), '');
  assert.equal(publicName(''), '');
  assert.equal(publicName(null), '');
});

test('summarize / ratingFields / sortReviews', () => {
  const list = [5, 4, 4].map((rating, i) => normalizeReview(`r${i}`, { rating, status: 'approved', helpfulCount: i, createdAt: new Ts(NOW + i) }));
  assert.deepEqual(summarize(list), { count: 3, avg: 4.3, dist: [0, 0, 0, 2, 1] });
  assert.deepEqual(ratingFields(list), { ratingSum: 13, ratingCount: 3, ratingAvg: 4.33 });
  assert.deepEqual(ratingFields([]), { ratingSum: 0, ratingCount: 0, ratingAvg: 0 });
  assert.deepEqual(sortReviews(list, 'newest').map((r) => r.id), ['r2', 'r1', 'r0']);
  assert.deepEqual(sortReviews(list, 'highest').map((r) => r.id), ['r0', 'r2', 'r1']);
  assert.deepEqual(sortReviews(list, 'lowest').map((r) => r.id), ['r2', 'r1', 'r0']);
  assert.deepEqual(sortReviews(list, 'helpful').map((r) => r.id), ['r2', 'r1', 'r0']);
});
