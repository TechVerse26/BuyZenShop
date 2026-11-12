/*
 * Admin "Reviews" (moderation), clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs + the reviews below
 *   pending   p2__u2 "Perfect size" (verified, 2 days old) · p2__u1 "Too small for my cards" (5 days) · p5__u1 "Okay watch" (1 day)     → the queue is oldest first
 *   approved  p1__u1 "Lovely fabric" 5★ (verified, 10 days) · p1__u2 "Good value" 4★ (8 days, 3 helpful, 2 reports)    product p1 holds rating 9 / 2 / 4.5
 *   rejected  p4__u2 "Rubbish" 1★ (reason "Abusive language")           reports: p1__u2 twice, p1__u1 once
 *   roles: cs Customer Support (moderates, cannot edit products) · pm Product Manager · sadm Store Admin · sa Super Admin · om / rp may not open it
 */
import { DLG, YES, text, snap } from './helpers.mjs';

const URL = '/admin/#/reviews';
const CARD = '.rvm-card';
const one = (id) => `${CARD}[data-id="${id}"]`;
const DAY = 86400000;
const calm = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((el) => el.remove()));
const wait = (page, fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 8000 });
const settled = (page) => wait(page, () => { const r = document.querySelector('#rvm-results'); return !!r && !r.querySelector('.spinner'); });
const titles = (page) => page.locator(`${CARD} .rvm-title`).allInnerTexts();
const ids = (page) => page.locator(CARD).evaluateAll((els) => els.map((el) => el.dataset.id));
const countOf = (page, id) => page.locator(CARD).count().then(() => page.locator(`#rvm-tab-${id} .rvm-n`).allInnerTexts()).then((a) => (a.length ? a[0].trim() : null));
const closed = (page) => page.waitForSelector(DLG, { state: 'detached', timeout: 8000 }).then(() => true, () => false);
const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const audits = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => /^review\./.test(a.action))
  .map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(byJson);

const review = (productId, uid, rating, status, title, text, ageDays, extra = '{}') => `({
  productId: '${productId}', userId: '${uid}', userName: '${uid.toUpperCase()} K.', rating: ${rating}, title: ${JSON.stringify(title)}, text: ${JSON.stringify(text)},
  status: '${status}', verified: false, orderNumber: '', lineKey: '', helpfulCount: 0,
  createdAt: new Ts(Date.now() - ${ageDays} * ${DAY}), updatedAt: new Ts(Date.now() - ${ageDays} * ${DAY}), ...${extra} })`;
const report = (reviewId, productId, reporter, reason, agoMs) => `({ reviewId: '${reviewId}', productId: '${productId}', reporterId: '${reporter}', reason: ${JSON.stringify(reason)}, createdAt: new Ts(Date.now() - ${agoMs}) })`;

async function seed(f) {
  await f.put('reviews/p2__u1', review('p2', 'u1', 2, 'pending', 'Too small for my cards', 'Only four cards fit.\nThe leather is thin.', 5));
  await f.put('reviews/p2__u2', review('p2', 'u2', 5, 'pending', 'Perfect size', 'Fits in my front pocket.', 2, '{ verified: true, orderNumber: \'SV-261026-EF34GH\', lineKey: \'p2\' }'));
  await f.put('reviews/p5__u1', review('p5', 'u1', 3, 'pending', 'Okay watch', 'Does the job.', 1));
  await f.put('reviews/p1__u1', review('p1', 'u1', 5, 'approved', 'Lovely fabric', 'Soft and breathable.', 10, '{ verified: true, orderNumber: \'SV-261025-AB12CD\', lineKey: \'p1\' }'));
  await f.put('reviews/p1__u2', review('p1', 'u2', 4, 'approved', 'Good value', 'Worth the price.', 8, '{ helpfulCount: 3 }'));
  await f.put('reviews/p4__u2', review('p4', 'u2', 1, 'rejected', 'Rubbish', 'Rude words here.', 9, "{ moderationNote: 'Abusive language', moderatedBy: 'sa' }"));
  await f.put('reviewReports/p1__u2__u1', report('p1__u2', 'p1', 'u1', 'Looks like spam', 3 * 3600000));
  await f.put('reviewReports/p1__u2__ur', report('p1__u2', 'p1', 'ur', 'Not about this product', 3600000));
  await f.put('reviewReports/p1__u1__u2', report('p1__u1', 'p1', 'u2', 'The photo is not theirs', 7200000));
  await f.patch('products/p1', 'd.ratingSum = 9; d.ratingCount = 2; d.ratingAvg = 4.5;');
}
const rating = async (f, pid) => { const p = await f.doc(`products/${pid}`); return [p.ratingSum, p.ratingCount, p.ratingAvg]; };
const stamp = async (f) => ((await f.doc('meta/catalog')) || {}).version || 0;

async function open(f, tab = null) {
  await seed(f);
  await f.goto(URL);
  await f.page.waitForSelector('#rvm-tabs-wrap [role="tab"]', { timeout: 12000 });
  await settled(f.page);
  if (tab) await go(f, tab);
}
async function go(f, tab) {
  await f.page.click(`#rvm-tab-${tab}`);
  await wait(f.page, (k) => document.querySelector(`#rvm-tab-${k}`)?.getAttribute('aria-selected') === 'true' && !document.querySelector('#rvm-results .spinner'), tab);
}
async function menuItems(f, id) {
  await calm(f.page);
  await f.page.click(`${one(id)} [data-action="row-menu"]`);
  await f.page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 4000 });
  return f.page.locator('[role="menu"] [role="menuitem"]').count();
}
const cardCount = (page, n) => wait(page, (k) => document.querySelectorAll('.rvm-card').length === k, n);

export const adminReviewsFlows = [
  {
    name: 'admin reviews: the queue is oldest first, shows product, verified and tab counts; a pending review offers approve, reject and delete only', as: 'cs',
    async run(f) {
      const { page } = f;
      await open(f);
      f.eq(await titles(page), ['Too small for my cards', 'Perfect size', 'Okay watch'], 'oldest first, so nothing waits forever');
      f.eq(await countOf(page, 'pending'), '3', 'the pending tab counts them');
      f.eq(await countOf(page, 'reported'), '2', 'two reviews have reports');
      f.eq(await countOf(page, 'approved'), null, 'a list that has not been opened has no number');
      const name = (await f.doc('products/p2')).name;
      f.ok((await text(page, one('p2__u1'))).includes(name), 'the product name is shown');
      f.eq(await page.locator(`${CARD} .badge-ok`).count(), 1, 'one verified purchase');
      f.eq(await page.locator(`${one('p2__u2')} .badge-ok`).count(), 1, 'it is "Perfect size"');
      f.ok((await page.locator(`${one('p2__u1')} .rvm-text`).innerText()).includes('\n'), 'line breaks of the text are kept');
      f.eq(await page.locator(`${one('p2__u1')} [data-action="approve"], ${one('p2__u1')} [data-action="reject"]`).count(), 2, 'approve and reject');
      f.eq(await page.locator(`${one('p2__u1')} [data-action="dismiss"]`).count(), 0, 'nothing to dismiss');
      f.eq(await menuItems(f, 'p2__u1'), 1, 'only "delete" — it is already pending');
      await page.keyboard.press('Escape');
      f.eq(await audits(f), [], 'looking changes nothing');
      await snap(f, 'admin-reviews-pending');
    },
  },
  {
    name: 'admin reviews: approving publishes the review, recounts the product rating, stamps the shop catalog and audits it (Customer Support may)', as: 'cs',
    async run(f) {
      const { page } = f;
      await open(f);
      const before = await stamp(f);
      f.eq(await rating(f, 'p2'), [0, 0, 0], 'no rating yet');
      await page.click(`${one('p2__u2')} [data-action="approve"]`);
      await cardCount(page, 2);
      const r = await f.doc('reviews/p2__u2');
      f.eq([r.status, r.moderatedBy, !!r.moderatedAt, r.moderationNote], ['approved', 'cs', true, ''], 'approved, and who did it');
      f.eq(r.text, 'Fits in my front pocket.', 'what the customer wrote is untouched');
      f.eq(await rating(f, 'p2'), [5, 1, 5], 'the product rating counts it');
      f.ok((await stamp(f)) > before, 'shops that cached the catalog will fetch the new stars');
      f.eq(await audits(f), [['review.approve', 'p2__u2', 'cs', 'customer_support']], 'one audit entry');
      f.eq(await countOf(page, 'pending'), '2', 'the tab count follows');
      f.eq(await page.locator('#toasts .toast-bad').count(), 0, 'no error');
      await go(f, 'approved');
      f.ok((await ids(page)).includes('p2__u2'), 'it is in the approved list now');
    },
  },
  {
    name: 'admin reviews: rejecting asks for an optional reason, keeps it for the author and leaves the rating and catalog alone when the review was never approved', as: 'pm',
    async run(f) {
      const { page } = f;
      await open(f);
      const before = await stamp(f);
      await page.click(`${one('p2__u1')} [data-action="reject"]`);
      await page.waitForSelector(`${DLG} form[data-form="reject"]`, { timeout: 4000 });
      f.eq(await page.locator(`${DLG} textarea[name="note"]`).getAttribute('maxlength'), '200', 'the reason is limited to 200 characters');
      await snap(f, 'admin-reviews-reject');
      await page.fill(`${DLG} textarea[name="note"]`, '  Not   about the product ');
      await page.click(YES);
      f.ok(await closed(page), 'the dialog closes');
      await cardCount(page, 2);
      const r = await f.doc('reviews/p2__u1');
      f.eq([r.status, r.moderationNote, r.moderatedBy], ['rejected', 'Not about the product', 'pm'], 'rejected with a tidy reason');
      f.eq(await rating(f, 'p2'), [0, 0, 0], 'a pending review never counted');
      f.eq(await stamp(f), before, 'so the catalog is not touched');
      f.eq(await audits(f), [['review.reject', 'p2__u1', 'pm', 'product_manager']]);
      await go(f, 'rejected');
      f.eq((await ids(page)).sort(), ['p2__u1', 'p4__u2'], 'both rejected reviews');
      f.ok((await text(page, one('p2__u1'))).includes('Not about the product'), 'the reason is shown to staff');
      f.eq(await page.locator(`${one('p4__u2')} .rvm-reason`).count(), 1, 'the seeded one shows its reason too');
      f.eq(await page.locator(`${one('p2__u1')} [data-action="reject"]`).count(), 0, 'no "reject" on a rejected review');
      f.eq(await menuItems(f, 'p2__u1'), 2, 'back to pending, delete');
    },
  },
  {
    name: 'admin reviews: rejecting an approved review takes it off the rating and clears its reports; the reports of other reviews stay', as: 'sadm',
    async run(f) {
      const { page } = f;
      await open(f, 'approved');
      f.eq(await titles(page), ['Good value', 'Lovely fabric'], 'newest first');
      f.eq(await page.locator(`${one('p1__u2')} .badge-bad`).count(), 1, 'the report count badge');
      f.ok((await text(page, one('p1__u2'))).includes('3'), 'helpful votes are shown');
      f.eq(await page.locator(`${one('p1__u2')} .rvm-reports li`).count(), 2, 'both reasons are listed');
      f.eq(await page.locator(`${one('p1__u2')} [data-action="dismiss"]`).count(), 1, 'dismiss is offered');
      await page.click(`${one('p1__u2')} [data-action="reject"]`);
      await page.waitForSelector(`${DLG} form[data-form="reject"]`, { timeout: 4000 });
      await page.click(YES);                                         // no reason
      f.ok(await closed(page));
      await cardCount(page, 1);
      f.eq(await rating(f, 'p1'), [5, 1, 5], 'only the 5-star review counts now');
      f.eq((await f.doc('reviews/p1__u2')).status, 'rejected');
      f.eq(Object.keys(await f.docs('reviewReports/')), ['reviewReports/p1__u1__u2'], 'the two reports of the rejected review are gone, the other stays');
      f.eq(await audits(f), [['review.reject', 'p1__u2', 'sadm', 'store_admin']]);
      f.eq(await countOf(page, 'reported'), '1', 'the reported tab follows');
    },
  },
  {
    name: 'admin reviews: "move back to pending" and "delete" from the row menu — the rating is recomputed each time and a delete asks first', as: 'sa',
    async run(f) {
      const { page } = f;
      await open(f, 'approved');
      f.eq(await menuItems(f, 'p1__u1'), 2, 'back to pending, delete');
      await page.locator('[role="menu"] [role="menuitem"]').nth(0).click();
      await cardCount(page, 1);
      f.eq((await f.doc('reviews/p1__u1')).status, 'pending');
      f.eq(await rating(f, 'p1'), [4, 1, 4], 'one approved review is left');
      await calm(page);
      f.eq(await menuItems(f, 'p1__u2'), 2);
      await page.locator('[role="menu"] [role="menuitem"]').nth(1).click();
      await page.waitForSelector(DLG, { timeout: 4000 });
      await snap(f, 'admin-reviews-delete');
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page), 'cancel closes it');
      f.ok(!!(await f.doc('reviews/p1__u2')), 'cancel deletes nothing');
      await calm(page);
      await menuItems(f, 'p1__u2');
      await page.locator('[role="menu"] [role="menuitem"]').nth(1).click();
      await page.waitForSelector(DLG, { timeout: 4000 });
      await page.click(YES);
      await cardCount(page, 0);
      f.eq(await f.doc('reviews/p1__u2'), null, 'the review is gone');
      f.eq(Object.keys(await f.docs('reviewReports/')), ['reviewReports/p1__u1__u2'], 'with its reports');
      f.eq(await rating(f, 'p1'), [0, 0, 0], 'no approved review is left, so the rating is zero');
      f.eq(await audits(f), [['review.delete', 'p1__u2', 'sa', 'super_admin'], ['review.pending', 'p1__u1', 'sa', 'super_admin']].sort(byJson));
      f.eq(await page.locator('#rvm-results .empty').count(), 1, 'an empty state, not a blank page');
    },
  },
  {
    name: 'admin reviews: the Reported tab lists flagged reviews of any status, most reports first; dismissing keeps the review', as: 'cs',
    async run(f) {
      const { page } = f;
      await open(f, 'reported');
      f.eq(await ids(page), ['p1__u2', 'p1__u1'], 'two reports before one');
      f.eq(await page.locator(`${one('p1__u2')} .rvm-reports li`).count(), 2);
      f.ok((await text(page, one('p1__u2'))).includes('Not about this product'), 'the reasons are shown');
      f.eq(await page.locator(`${CARD} .badge-ok`).count(), 3, 'status "approved" on both cards + verified on the first fabric review');
      await snap(f, 'admin-reviews-reported');
      await page.click(`${one('p1__u2')} [data-action="dismiss"]`);
      await page.waitForSelector(DLG, { timeout: 4000 });
      await page.click(YES);
      await cardCount(page, 1);
      f.eq((await f.doc('reviews/p1__u2')).status, 'approved', 'the review stays approved');
      f.eq(await rating(f, 'p1'), [9, 2, 4.5], 'and the rating is untouched');
      f.eq(Object.keys(await f.docs('reviewReports/')), ['reviewReports/p1__u1__u2'], 'its reports are deleted');
      f.eq(await audits(f), [['review.reports_dismiss', 'p1__u2', 'cs', 'customer_support']]);
      f.eq(await countOf(page, 'reported'), '1');
      f.eq(await page.locator(`${one('p1__u2')}`).count(), 0, 'it left the reported tab');
    },
  },
  {
    name: 'admin reviews: search (title, text, customer, product) and the star / purchase filters work on the open tab', as: 'sa',
    async run(f) {
      const { page } = f;
      await open(f);
      const search = async (v) => { await page.fill('#q', v); await page.waitForTimeout(450); };
      await search('perfect');
      f.eq(await ids(page), ['p2__u2'], 'by title');
      await search('four cards');
      f.eq(await ids(page), ['p2__u1'], 'by text');
      await search((await f.doc('products/p2')).name.toLowerCase());
      f.eq((await ids(page)).sort(), ['p2__u1', 'p2__u2'], 'by product name');
      await search('u1 k.');
      f.eq((await ids(page)).sort(), ['p2__u1', 'p5__u1'], 'by customer');
      await search('nothing like this');
      f.eq(await page.locator('#rvm-results .empty').count(), 1, '"nothing matches"');
      await search('');
      f.eq((await ids(page)).length, 3);
      await page.selectOption('#rvm-rating', '5');
      f.eq(await ids(page), ['p2__u2'], 'five stars');
      await page.selectOption('#rvm-rating', '0');
      await page.selectOption('#rvm-verified', 'yes');
      f.eq(await ids(page), ['p2__u2'], 'verified purchases');
      await page.selectOption('#rvm-verified', 'no');
      f.eq((await ids(page)).sort(), ['p2__u1', 'p5__u1'], 'not verified');
      await page.selectOption('#rvm-verified', '');
      f.eq((await ids(page)).length, 3, 'filters reset');
      await go(f, 'approved');
      f.eq((await ids(page)).length, 2, 'filters did not leak into another tab');
    },
  },
  {
    name: 'admin reviews: a long queue shows 20 at a time with "show more", and the tab count says how many there are', as: 'sa',
    async run(f) {
      const { page } = f;
      await seed(f);
      for (let i = 1; i <= 23; i += 1) await f.put(`reviews/p6__x${i}`, review('p6', `x${i}`, 4, 'pending', `Bulk ${i}`, 'Fine.', 20 + i));
      await f.goto(URL);
      await page.waitForSelector(CARD, { timeout: 12000 });
      f.eq(await page.locator(CARD).count(), 20, 'twenty first');
      f.eq(await countOf(page, 'pending'), '26', '23 + 3 waiting');
      await page.click('[data-action="more"]');
      await cardCount(page, 26);
      f.eq(await page.locator('[data-action="more"]').count(), 0, 'nothing more to show');
      const t0 = await titles(page);
      f.eq(t0[0], 'Bulk 23', 'the oldest first');
    },
  },
  {
    name: 'admin reviews: someone else got there first — the stale card is refused with a message and the list reloads, nothing is written twice', as: 'sa',
    async run(f) {
      const { page } = f;
      await open(f);
      await f.patch('reviews/p5__u1', "d.status = 'approved';");                // another moderator approved it meanwhile
      await page.click(`${one('p5__u1')} [data-action="approve"]`);
      await page.waitForSelector('#toasts .toast-bad', { timeout: 6000 });
      await cardCount(page, 2);
      f.eq(await audits(f), [], 'nothing was written by this click');
      f.eq(await rating(f, 'p5'), [0, 0, 0], 'the product rating was not touched');
      f.eq(await countOf(page, 'pending'), '2', 'the list reloaded');
    },
  },
  {
    name: 'admin reviews: a review whose product was deleted can still be moderated (no product write) and says so', as: 'sa',
    async run(f) {
      const { page } = f;
      await seed(f);
      await f.put('reviews/gone__u1', review('gone', 'u1', 4, 'pending', 'Orphan', 'The product is gone.', 30));
      await f.goto(URL);
      await page.waitForSelector(CARD, { timeout: 12000 });
      f.eq((await ids(page))[0], 'gone__u1', 'the oldest');
      f.eq(await page.locator(`${one('gone__u1')} .rvm-gone`).count(), 1, '"this product no longer exists"');
      f.eq(await page.locator(`${one('gone__u1')} a`).count(), 0, 'and no link');
      await page.click(`${one('gone__u1')} [data-action="approve"]`);
      await cardCount(page, 3);
      f.eq((await f.doc('reviews/gone__u1')).status, 'approved');
      f.eq(await audits(f), [['review.approve', 'gone__u1', 'sa', 'super_admin']]);
    },
  },
  {
    name: 'admin reviews: the author sees why their review was not published (the moderator\'s reason), on the product page', as: 'u2',
    async run(f) {
      const { page } = f;
      await seed(f);
      await f.goto('/product/phone-case');
      await page.waitForSelector('.rev-mine .rev-note', { timeout: 15000 });
      f.ok((await text(page, '.rev-mine .rev-note')).includes('Abusive language'), 'the reason is shown');
      f.eq(await page.locator('.rev-mine [data-action="edit"]').count(), 0, 'a rejected review cannot be edited');
    },
  },
  ...['om', 'rp', 'im'].map((as) => ({
    name: `admin reviews: the ${as === 'om' ? 'Order Manager' : as === 'rp' ? 'Reporting' : 'Inventory Manager'} role cannot open the page`, as,
    async run(f) {
      await f.goto(URL);
      await f.page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await f.page.locator(CARD).count(), 0, 'no review is shown');
    },
  })),
];
