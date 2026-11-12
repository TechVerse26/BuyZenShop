/*
 * Review moderation (js/shared/reviewFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * Super Admin, Store Admin, Product Manager and Customer Support moderate reviews (+ product rating fields, + meta/catalog stamp, + an audit entry);
 * every other role and every customer is refused by the RULES, and a moderator can write nothing but the three rating fields on a product.
 * The planner keeps the numbers honest: a review counts only while approved, and every change in or out of "approved" rewrites the product's rating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planReviewModeration, planReviewDelete, planReportsDismiss, nextRating, groupReports, filterReviews, orderReviews, MODERATION,
} from '../../js/shared/reviewFlow.js';
import { normalizeReview } from '../../js/shared/reviewModel.js';
import { chunkOps, TS } from '../../js/shared/ops.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { baseDb, commitBoth, failedOps, NOW, DAY } from './harness.mjs';
import { Ts } from './rules-engine.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const MODERATORS = ['sa', 'sadm', 'pm', 'cs'];
const OTHERS = ['om', 'im', 'rp'];
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const review = (db, id) => normalizeReview(id, db.get(`reviews/${id}`));
const approvedOf = (db, productId) => [...db.m.entries()]
  .filter(([k, v]) => k.startsWith('reviews/') && k.split('/').length === 2 && v.productId === productId && v.status === 'approved')
  .map(([k, v]) => ({ id: k.split('/')[1], rating: v.rating }));
const reportIdsOf = (db, reviewId) => [...db.m.entries()].filter(([k, v]) => k.startsWith('reviewReports/') && v.reviewId === reviewId).map(([k]) => k.split('/')[1]);

const rdoc = (productId, userId, rating, status, over = {}) => ({
  productId, userId, userName: `${userId} K.`, rating, title: `Title ${userId}`, text: `Text of ${userId}`, status, verified: false, orderNumber: '', lineKey: '',
  helpfulCount: 0, createdAt: new Ts(NOW - DAY), updatedAt: new Ts(NOW - DAY), ...over,
});

/** p1 has two approved reviews (5 and 4) and the stored aggregate says so; plus one pending (2) and one rejected (1); the draft product pd has a pending one. */
function modDb() {
  const db = baseDb();
  db.set('products/p1', { name: 'Test Shirt', slug: 'test-shirt', status: 'published', type: 'simple', price: 1000, salePrice: null, ratingSum: 9, ratingCount: 2, ratingAvg: 4.5 });
  db.set('reviews/p1__u1', rdoc('p1', 'u1', 5, 'approved'));
  db.set('reviews/p1__u2', rdoc('p1', 'u2', 4, 'approved'));
  db.set('reviews/p1__ur', rdoc('p1', 'ur', 2, 'pending'));
  db.set('reviews/p1__uc', rdoc('p1', 'uc', 1, 'rejected'));
  db.set('reviews/pd__u1', rdoc('pd', 'u1', 3, 'pending'));
  db.set('reviewReports/p1__u2__u1', { reviewId: 'p1__u2', productId: 'p1', reporterId: 'u1', reason: 'Spam link', createdAt: new Ts(NOW - 3600000) });
  db.set('reviewReports/p1__u2__ur', { reviewId: 'p1__u2', productId: 'p1', reporterId: 'ur', reason: 'Not about the product', createdAt: new Ts(NOW - 60000) });
  return db;
}

function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}
function commitAll(db, uid, ops, label) {
  let cur = db;
  chunkOps(ops, 18).forEach((chunk, i) => { cur = commit(cur, uid, chunk, `${label} #${i + 1}`); });
  return cur;
}
const refused = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine allowed it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine allowed it`);
};
const moderate = (db, id, to, who = 'sa', over = {}) => planReviewModeration({
  review: review(db, id), to, approved: approvedOf(db, review(db, id).productId), productRating: db.get(`products/${review(db, id).productId}`),
  productExists: !!db.get(`products/${review(db, id).productId}`), reportIds: reportIdsOf(db, id), actor: actor(who), nowMs: NOW, ...over,
});
const remove = (db, id, who = 'sa', over = {}) => planReviewDelete({
  review: review(db, id), approved: approvedOf(db, review(db, id).productId), productRating: db.get(`products/${review(db, id).productId}`),
  productExists: !!db.get(`products/${review(db, id).productId}`), reportIds: reportIdsOf(db, id), actor: actor(who), nowMs: NOW, ...over,
});
const ratingOf = (db, pid) => { const p = db.get(`products/${pid}`); return { ratingSum: p.ratingSum, ratingCount: p.ratingCount, ratingAvg: p.ratingAvg }; };

test('approve: the review goes live, the product rating is recomputed from the approved reviews, the shop catalog is stamped, one audit entry is written', () => {
  const db = modDb();
  const plan = moderate(db, 'p1__ur', 'approved', 'cs');
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'review.approve');
  assert.deepEqual(plan.rating, { ratingSum: 11, ratingCount: 3, ratingAvg: 3.67 });
  const after = commit(db, 'cs', plan.ops, 'approve');
  const r = after.get('reviews/p1__ur');
  assert.equal(r.status, 'approved');
  assert.equal(r.moderatedBy, 'cs');
  assert.ok(r.moderatedAt, 'moderatedAt is stamped');
  assert.equal(r.moderationNote, '');
  assert.equal(r.text, 'Text of ur', 'what the customer wrote is untouched');
  assert.deepEqual(ratingOf(after, 'p1'), { ratingSum: 11, ratingCount: 3, ratingAvg: 3.67 });
  assert.equal(after.get('products/p1').name, 'Test Shirt');
  assert.equal(after.get('meta/catalog').version, NOW);
  const log = audits(after);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'review.approve');
  assert.equal(log[0].actorRole, 'customer_support');
  assert.equal(log[0].entityId, 'p1__ur');
  assert.deepEqual(log[0].before, { status: 'pending' });
  assert.equal(log[0].after.status, 'approved');
});

test('reject (with a reason) after approval: the rating drops the review again; reject / pending of a review that was never approved leaves the rating and the catalog alone', () => {
  const db = modDb();
  const rej = moderate(db, 'p1__u1', 'rejected', 'pm', { note: '  Contains   a phone number ' });
  assert.equal(rej.ok, true);
  assert.deepEqual(rej.rating, { ratingSum: 4, ratingCount: 1, ratingAvg: 4 });
  let after = commit(db, 'pm', rej.ops, 'reject approved');
  assert.equal(after.get('reviews/p1__u1').status, 'rejected');
  assert.equal(after.get('reviews/p1__u1').moderationNote, 'Contains a phone number');
  assert.deepEqual(ratingOf(after, 'p1'), { ratingSum: 4, ratingCount: 1, ratingAvg: 4 });
  assert.equal(audits(after)[0].action, 'review.reject');

  const quiet = moderate(db, 'p1__ur', 'rejected', 'sadm', { note: 'Off topic' });
  assert.equal(quiet.rating, null, 'a pending review never counted, so nothing is recomputed');
  assert.equal(quiet.ops.some((o) => o.path.startsWith('products/') || o.path === 'meta/catalog'), false);
  after = commit(db, 'sadm', quiet.ops, 'reject pending');
  assert.deepEqual(ratingOf(after, 'p1'), { ratingSum: 9, ratingCount: 2, ratingAvg: 4.5 });
  assert.equal(after.get('meta/catalog'), undefined);

  const back = moderate(db, 'p1__uc', 'pending', 'sa');
  assert.equal(back.action, 'review.pending');
  assert.equal(back.rating, null);
  after = commit(db, 'sa', back.ops, 'rejected → pending');
  assert.equal(after.get('reviews/p1__uc').status, 'pending');
  assert.equal(after.get('reviews/p1__uc').moderationNote, '');
});

test('approved → pending takes it off the rating; rejected → approved puts it on; the note is kept only for a rejection', () => {
  const db = modDb();
  const down = moderate(db, 'p1__u2', 'pending', 'sa', { note: 'ignored' });
  assert.deepEqual(down.rating, { ratingSum: 5, ratingCount: 1, ratingAvg: 5 });
  assert.equal(commit(db, 'sa', down.ops, 'unapprove').get('reviews/p1__u2').moderationNote, '');
  const up = moderate(db, 'p1__uc', 'approved', 'sa');
  assert.deepEqual(up.rating, { ratingSum: 10, ratingCount: 3, ratingAvg: 3.33 });
  assert.deepEqual(ratingOf(commit(db, 'sa', up.ops, 'approve rejected'), 'p1'), { ratingSum: 10, ratingCount: 3, ratingAvg: 3.33 });
});

test('rejecting a reported review answers its reports (they are deleted in the same batch) and says so in the audit entry', () => {
  const db = modDb();
  const plan = moderate(db, 'p1__u2', 'rejected', 'cs', { note: 'Spam' });
  assert.equal(plan.reportsCleared, 2);
  assert.equal(plan.ops.filter((o) => o.op === 'delete' && o.path.startsWith('reviewReports/')).length, 2);
  const after = commit(db, 'cs', plan.ops, 'reject reported');
  assert.deepEqual(reportIdsOf(after, 'p1__u2'), []);
  assert.match(audits(after)[0].summary, /2 reports cleared/);
  assert.match(audits(after)[0].summary, /Spam/);
});

test('delete: removes the review and its reports; an approved one is also taken off the rating; a pending one is not', () => {
  const db = modDb();
  const plan = remove(db, 'p1__u2', 'sadm');
  assert.equal(plan.action, 'review.delete');
  assert.deepEqual(plan.rating, { ratingSum: 5, ratingCount: 1, ratingAvg: 5 });
  const after = commit(db, 'sadm', plan.ops, 'delete approved');
  assert.equal(after.get('reviews/p1__u2'), undefined);
  assert.deepEqual(reportIdsOf(after, 'p1__u2'), []);
  assert.deepEqual(ratingOf(after, 'p1'), { ratingSum: 5, ratingCount: 1, ratingAvg: 5 });
  assert.equal(audits(after)[0].before.text, 'Text of u2', 'the audit entry keeps what was removed');
  assert.equal(audits(after)[0].before.userId, 'u2');

  const pend = remove(db, 'p1__ur', 'pm');
  assert.equal(pend.rating, null);
  const after2 = commit(db, 'pm', pend.ops, 'delete pending');
  assert.equal(after2.get('reviews/p1__ur'), undefined);
  assert.deepEqual(ratingOf(after2, 'p1'), { ratingSum: 9, ratingCount: 2, ratingAvg: 4.5 });
});

test('deleting the last approved review resets the rating to zero', () => {
  const db = modDb();
  let cur = commit(db, 'sa', remove(db, 'p1__u1', 'sa').ops, 'first');
  cur = commit(cur, 'sa', remove(cur, 'p1__u2', 'sa').ops, 'second');
  assert.deepEqual(ratingOf(cur, 'p1'), { ratingSum: 0, ratingCount: 0, ratingAvg: 0 });
});

test('a wrong stored rating is repaired by the next moderation (the number comes from the reviews, not from the old number)', () => {
  const db = modDb();
  db.set('products/p1', { ...db.get('products/p1'), ratingSum: 99, ratingCount: 40, ratingAvg: 2.47 });
  const plan = moderate(db, 'p1__ur', 'approved', 'sa');
  assert.deepEqual(plan.rating, { ratingSum: 11, ratingCount: 3, ratingAvg: 3.67 });
  assert.deepEqual(ratingOf(commit(db, 'sa', plan.ops, 'repair'), 'p1'), { ratingSum: 11, ratingCount: 3, ratingAvg: 3.67 });
});

test('a product that no longer exists: the review is still moderated, the batch has no product write', () => {
  const db = modDb();
  db.set('reviews/gone__u1', rdoc('gone', 'u1', 4, 'approved'));
  const plan = moderate(db, 'gone__u1', 'rejected', 'sa');
  assert.equal(plan.ok, true);
  assert.equal(plan.rating, null);
  assert.equal(plan.ops.some((o) => o.path.startsWith('products/')), false);
  assert.equal(commit(db, 'sa', plan.ops, 'no product').get('reviews/gone__u1').status, 'rejected');
  const del = remove(db, 'gone__u1', 'sa');
  assert.equal(commit(db, 'sa', del.ops, 'delete no product').get('reviews/gone__u1'), undefined);
});

test('nextRating: from the fresh list (even when it does or does not contain the review) and, when capped, from the stored aggregate', () => {
  const r = { id: 'r9', rating: 3 };
  const list = [{ id: 'a', rating: 5 }, { id: 'b', rating: 4 }];
  assert.deepEqual(nextRating({ review: r, wasApproved: false, willBeApproved: true, approved: list }), { ratingSum: 12, ratingCount: 3, ratingAvg: 4 });
  assert.deepEqual(nextRating({ review: r, wasApproved: false, willBeApproved: true, approved: [...list, r] }), { ratingSum: 12, ratingCount: 3, ratingAvg: 4 }, 'a list that already holds it is not double counted');
  assert.deepEqual(nextRating({ review: r, wasApproved: true, willBeApproved: false, approved: [...list, r] }), { ratingSum: 9, ratingCount: 2, ratingAvg: 4.5 });
  const cap = { review: r, approvedCapped: true, productRating: { ratingSum: 4000, ratingCount: 1000 }, approved: [] };
  assert.deepEqual(nextRating({ ...cap, wasApproved: false, willBeApproved: true }), { ratingSum: 4003, ratingCount: 1001, ratingAvg: 4 });
  assert.deepEqual(nextRating({ ...cap, wasApproved: true, willBeApproved: false }), { ratingSum: 3997, ratingCount: 999, ratingAvg: 4 });
  assert.deepEqual(nextRating({ review: r, wasApproved: true, willBeApproved: false, approvedCapped: true, productRating: null }), { ratingSum: 0, ratingCount: 0, ratingAvg: 0 }, 'never negative');
});

test('moderators: the four roles with reviews.moderate may; every other role is refused by the planner AND by the rules', () => {
  const db = modDb();
  for (const who of MODERATORS) {
    const plan = moderate(db, 'p1__ur', 'approved', who);
    assert.equal(plan.ok, true, who);
    commit(db, who, plan.ops, `approve as ${who}`);
    const del = remove(db, 'p1__uc', who);
    assert.equal(del.ok, true, who);
    commit(db, who, del.ops, `delete as ${who}`);
  }
  for (const who of OTHERS) {
    assert.equal(moderate(db, 'p1__ur', 'approved', who).error, 'forbidden', who);
    assert.equal(remove(db, 'p1__uc', who).error, 'forbidden', who);
    // forge the batch a moderator would send: the rules still refuse (the audit entry is honest about who wrote it)
    const forged = moderate(db, 'p1__ur', 'approved', 'sa').ops.map((o) => (o.path.startsWith('auditLogs/')
      ? auditOp(actor(who), { action: 'review.approve', entity: 'review', entityId: 'p1__ur', summary: 'forged' }) : o));
    refused(db, who, forged, `forged approve as ${who}`);
    refused(db, who, [{ op: 'update', path: 'reviews/p1__ur', data: { status: 'approved' } }], `status flip as ${who}`);
    refused(db, who, [{ op: 'delete', path: 'reviews/p1__uc' }], `delete as ${who}`);
    refused(db, who, [{ op: 'update', path: 'products/p1', data: { ratingSum: 50, ratingCount: 10, ratingAvg: 5 } }], `rating write as ${who}`);
  }
  assert.equal(planReviewModeration({ review: review(db, 'p1__ur'), to: 'approved', actor: null }).error, 'forbidden');
});

test('customers cannot approve, reject or delete reviews (not even their own after approval), and cannot touch product ratings', () => {
  const db = modDb();
  refused(db, 'ur', [{ op: 'update', path: 'reviews/p1__ur', data: { status: 'approved' } }], 'approve own');
  refused(db, 'u1', [{ op: 'update', path: 'reviews/p1__u1', data: { status: 'rejected', moderationNote: 'x' } }], 'reject own approved');
  refused(db, 'u1', [{ op: 'delete', path: 'reviews/p1__u1' }], 'delete own approved');
  refused(db, 'u1', [{ op: 'update', path: 'products/p1', data: { ratingSum: 50, ratingCount: 10, ratingAvg: 5 } }], 'rate own product up');
  refused(db, 'u1', [{ op: 'delete', path: 'reviewReports/p1__u2__u1' }], 'delete own report');
});

test('Customer Support (moderator without products.write) can write ONLY the three rating fields on a product — price, name or status are refused', () => {
  const db = modDb();
  const rating = { ratingSum: 11, ratingCount: 3, ratingAvg: 3.67 };
  commit(db, 'cs', [{ op: 'update', path: 'products/p1', data: rating }], 'rating only');
  for (const extra of [{ status: 'archived' }, { price: 1 }, { name: 'Hacked' }, { salePrice: 1 }, { updatedAt: TS, name: 'Hacked' }]) {
    refused(db, 'cs', [{ op: 'update', path: 'products/p1', data: { ...rating, ...extra } }], `rating + ${Object.keys(extra)[0]}`);
  }
  refused(db, 'cs', [{ op: 'update', path: 'products/p1', data: { name: 'Hacked' } }], 'rename');
  refused(db, 'cs', [{ op: 'delete', path: 'products/p1' }], 'delete the product');
  // the review planner itself only ever writes those three fields on a product
  const plan = moderate(db, 'p1__ur', 'approved', 'cs');
  const productWrite = plan.ops.find((o) => o.path === 'products/p1');
  assert.deepEqual(Object.keys(productWrite.data).sort(), ['ratingAvg', 'ratingCount', 'ratingSum']);
});

test('planner refusals: unknown status, nothing to change, a missing review, a note that is too long', () => {
  const db = modDb();
  assert.equal(moderate(db, 'p1__ur', 'banana').error, 'bad_status');
  assert.equal(moderate(db, 'p1__ur', 'pending').error, 'no_change');
  assert.equal(moderate(db, 'p1__u1', 'approved').error, 'no_change');
  assert.equal(planReviewModeration({ review: null, to: 'approved', actor: actor('sa') }).error, 'not_found');
  assert.equal(planReviewDelete({ review: { id: '', productId: 'p1' }, actor: actor('sa') }).error, 'not_found');
  const long = moderate(db, 'p1__ur', 'rejected', 'sa', { note: 'x'.repeat(MODERATION.NOTE_MAX + 1) });
  assert.equal(long.error, 'invalid');
  assert.deepEqual(long.errors, { note: 'too_long' });
  assert.equal(moderate(db, 'p1__ur', 'rejected', 'sa', { note: 'x'.repeat(MODERATION.NOTE_MAX) }).ok, true);
  assert.equal(moderate(db, 'p1__ur', 'rejected', 'sa', { note: '' }).ok, true, 'the reason is optional');
});

test('dismiss reports: deletes the reports, keeps the review as it is, audits it; refused for other roles and when there is nothing to dismiss', () => {
  const db = modDb();
  const plan = planReportsDismiss({ review: review(db, 'p1__u2'), reportIds: reportIdsOf(db, 'p1__u2'), actor: actor('cs') });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'review.reports_dismiss');
  const after = commit(db, 'cs', plan.ops, 'dismiss');
  assert.deepEqual(reportIdsOf(after, 'p1__u2'), []);
  assert.equal(after.get('reviews/p1__u2').status, 'approved');
  assert.deepEqual(ratingOf(after, 'p1'), { ratingSum: 9, ratingCount: 2, ratingAvg: 4.5 });
  assert.equal(audits(after)[0].action, 'review.reports_dismiss');
  assert.equal(planReportsDismiss({ review: review(db, 'p1__u2'), reportIds: [], actor: actor('cs') }).error, 'no_reports');
  assert.equal(planReportsDismiss({ review: review(db, 'p1__u2'), reportIds: ['x'], actor: actor('om') }).error, 'forbidden');
  refused(db, 'om', [{ op: 'delete', path: 'reviewReports/p1__u2__u1' }], 'dismiss as om');
});

test('many reports: the first batch stays inside the 18-operation limit; the rest follow in chunks and everything is gone afterwards', () => {
  const db = modDb();
  for (let i = 0; i < 30; i += 1) db.set(`reviewReports/p1__u2__x${i}`, { reviewId: 'p1__u2', productId: 'p1', reporterId: `x${i}`, reason: 'Spam', createdAt: new Ts(NOW - i * 1000) });
  const plan = moderate(db, 'p1__u2', 'rejected', 'sa', { note: 'Spam' });
  assert.equal(plan.reportsCleared, 32);
  assert.ok(plan.ops.length <= 18, `first batch has ${plan.ops.length} operations`);
  assert.ok(plan.followUp.length > 0);
  let cur = commit(db, 'sa', plan.ops, 'atomic part');
  assert.equal(cur.get('reviews/p1__u2').status, 'rejected');
  cur = commitAll(cur, 'sa', plan.followUp, 'follow-up');
  assert.deepEqual(reportIdsOf(cur, 'p1__u2'), []);
  const dismiss = planReportsDismiss({ review: review(db, 'p1__u2'), reportIds: reportIdsOf(db, 'p1__u2'), actor: actor('sa') });
  assert.ok(dismiss.ops.length <= 18);
  cur = commitAll(commit(db, 'sa', dismiss.ops, 'dismiss atomic'), 'sa', dismiss.followUp, 'dismiss follow-up');
  assert.deepEqual(reportIdsOf(cur, 'p1__u2'), []);
});

test('report ids are sanitised (no duplicates, no paths) so a bad id cannot aim a delete at another collection', () => {
  const db = modDb();
  const plan = planReportsDismiss({ review: review(db, 'p1__u2'), reportIds: ['p1__u2__u1', 'p1__u2__u1', 'products/p1', '', null, 42], actor: actor('sa') });
  assert.deepEqual(plan.ops.filter((o) => o.op === 'delete').map((o) => o.path), ['reviewReports/p1__u2__u1']);
});

test('groupReports / filterReviews / orderReviews', () => {
  const db = modDb();
  const reports = [...db.m.entries()].filter(([k]) => k.startsWith('reviewReports/')).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  const grouped = groupReports([...reports, { id: 'bad' }, null]);
  assert.equal(grouped.size, 1);
  assert.deepEqual(grouped.get('p1__u2').map((r) => r.reason), ['Not about the product', 'Spam link'], 'newest first');

  const list = ['p1__u1', 'p1__u2', 'p1__ur', 'p1__uc'].map((id) => review(db, id));
  list[0] = { ...list[0], verified: true, createdMs: 3 };
  list[1] = { ...list[1], createdMs: 2 };
  list[2] = { ...list[2], createdMs: 1 };
  list[3] = { ...list[3], createdMs: 4 };
  assert.equal(filterReviews(list, { rating: 5 }).length, 1);
  assert.equal(filterReviews(list, { verified: 'yes' }).length, 1);
  assert.equal(filterReviews(list, { verified: 'no' }).length, 3);
  assert.equal(filterReviews(list, { q: 'TEXT OF U2' }).length, 1);
  assert.equal(filterReviews(list, { q: 'shirt', names: { p1: 'Test Shirt' } }).length, 4, 'matches the product name');
  assert.equal(filterReviews(list, { q: 'nothing like this' }).length, 0);
  assert.deepEqual(orderReviews(list, 'pending').map((r) => r.id), ['p1__ur', 'p1__u2', 'p1__u1', 'p1__uc'], 'the queue: oldest first');
  assert.deepEqual(orderReviews(list, 'approved').map((r) => r.id), ['p1__uc', 'p1__u1', 'p1__u2', 'p1__ur'], 'archives: newest first');
});

test('a moderation sets TS for moderatedAt (server time), never a client clock', () => {
  const db = modDb();
  const op = moderate(db, 'p1__ur', 'approved', 'sa').ops[0];
  assert.equal(op.data.moderatedAt, TS);
});
