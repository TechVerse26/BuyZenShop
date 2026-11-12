/*
 * Admin "Coupons", clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   coupons: WELCOME10 (10 %, up to 200, min order 500, 100 uses, 1 per customer, live, never used)
 *   staff: sa Super Admin · sadm Store Admin · pm Product Manager · om Order Manager · im · cs · rp   (coupons.read: sa sadm pm om · coupons.write: sa sadm)
 *   customers: u1 rahim@example.com · u2 karim@example.com        categories c1 c2 c3 · published products p1 p2 p3 p4 p5 p6 p7
 */
import { DLG, YES, text, snap } from './helpers.mjs';

const PAGE = '/admin/#/coupons';
const MENU = (id) => `[data-action="row-menu"][data-id="${id}"]`;
const FORM = `${DLG} form[data-form="coupon"]`;
const ROWS = '#cpn-table tbody tr';
const DAY = 86400000;
const closed = (page) => page.waitForSelector(DLG, { state: 'detached', timeout: 8000 }).then(() => true, () => false);
const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const audits = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => a.action.startsWith('coupon.'))
  .map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(byJson);
const couponCount = async (f) => Object.keys(await f.docs('coupons/')).length;
const tsMs = (v) => (v && (v.__ts ?? v.ms)) ?? null;                                  // a stored timestamp as the harness hands it back
const dhaka = (offsetMs) => new Date(Date.now() + 6 * 3600000 + offsetMs).toISOString().slice(0, 16);   // what a <input type=datetime-local> holds for "Dhaka now + offset"
const seed = (f, id, fields) => f.put(`coupons/${id}`, `({ code: '${id}', type: 'fixed', value: 100, maxDiscount: null, minOrder: 0, appliesTo: 'all', productIds: [], categoryIds: [], excludeSaleItems: false, startsAt: null, endsAt: null, usageLimit: null, usedCount: 0, perCustomerLimit: null, customerIds: [], active: true, description: '', createdAt: new Ts(Date.now() - 5 * 86400000), updatedAt: new Ts(Date.now() - 5 * 86400000), ...${fields} })`);

async function openCoupons(f) {
  await f.goto(PAGE);
  await f.page.waitForSelector(ROWS, { timeout: 12000 });
}
// on a phone a toast from the previous step can sit on top of the next button: clear it (the step that needed it has already looked at it)
const calm = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((el) => el.remove()));
async function menuItems(f, id) {
  await calm(f.page);
  await f.page.click(MENU(id));
  await f.page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 4000 });
  return f.page.locator('[role="menu"] [role="menuitem"]').count();
}
async function pickMenu(f, id, index) {
  await menuItems(f, id);
  await f.page.locator('[role="menu"] [role="menuitem"]').nth(index).click();
}
async function openAdd(f) {
  await f.page.click('[data-action="add"]');
  await f.page.waitForSelector(FORM);
}
const fill = async (page, values) => { for (const [k, v] of Object.entries(values)) await page.fill(`#f-${k}`, String(v)); };
const errorOf = (page, field) => text(page, `#err-${field}`);
const hasError = async (f, fields, why) => { for (const k of fields) f.ok((await errorOf(f.page, k)).length > 3, `#${k}: ${why}`); };

export const adminCouponsFlows = [
  {
    name: 'admin coupons: the list shows offer, conditions, uses, validity and status; search and status filter; details; delete is offered only for unused coupons', as: 'sa',
    async run(f) {
      const { page } = f;
      await seed(f, 'SOON20', `{ type: 'percent', value: 20, startsAt: new Ts(Date.now() + 3 * 86400000), description: 'Starts in three days' }`);
      await seed(f, 'OLD5', `{ endsAt: new Ts(Date.now() - 86400000) }`);
      await seed(f, 'FULL', `{ usageLimit: 3, usedCount: 3, perCustomerLimit: 1 }`);
      await seed(f, 'PAUSED', `{ active: false }`);
      await seed(f, 'SHIPFREE', `{ type: 'free_shipping', value: 0, minOrder: 2000, appliesTo: 'categories', categoryIds: ['c1'], customerIds: ['u1'], usedCount: 2, usageLimit: 10 }`);
      await openCoupons(f);
      f.eq(await page.locator(ROWS).count(), 6, 'the seeded coupon and the five added ones are listed');
      f.eq(await page.locator(`${ROWS} .badge-ok`).count(), 2, 'two are live (WELCOME10 and SHIPFREE)');
      f.eq(await page.locator(`${ROWS} .badge-info`).count(), 1, 'one is scheduled');
      f.eq(await page.locator(`${ROWS} .badge-warn`).count(), 1, 'one is used up');
      f.eq(await page.locator(`${ROWS} .badge:not(.badge-ok):not(.badge-info):not(.badge-warn)`).count(), 2, 'one expired and one switched off');
      await snap(f, 'coupons-list');

      await page.selectOption('#cpn-status', 'live');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 2, null, { timeout: 6000 });
      await page.selectOption('#cpn-status', 'scheduled');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 1, null, { timeout: 6000 });
      f.eq(await page.locator(MENU('SOON20')).count(), 1, 'the scheduled filter shows SOON20');
      await page.selectOption('#cpn-status', 'expired');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 1, null, { timeout: 6000 });
      f.eq(await page.locator(MENU('OLD5')).count(), 1, 'the expired filter shows OLD5');
      await page.selectOption('#cpn-status', '');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 6, null, { timeout: 6000 });
      await page.fill('#q', 'three days');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 1, null, { timeout: 6000 });
      f.eq(await page.locator(MENU('SOON20')).count(), 1, 'the search looks at the note too');
      await page.fill('#q', 'nothing like this');
      await page.waitForSelector('#cpn-table', { state: 'detached', timeout: 6000 });
      f.ok((await text(page, '#cpn-results')).length > 5, 'no match: an explanation instead of an empty table');
      await page.fill('#q', 'welcome');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 1, null, { timeout: 6000 });
      await page.fill('#q', '');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 6, null, { timeout: 6000 });

      f.eq(await menuItems(f, 'WELCOME10'), 4, 'an unused coupon: details, edit, switch off, delete');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="menu"]', { state: 'detached', timeout: 4000 });
      f.eq(await menuItems(f, 'FULL'), 3, 'a coupon that was used cannot be deleted: details, edit, switch off');
      await page.locator('[role="menu"] [role="menuitem"]').nth(0).click();
      await page.waitForSelector(`${DLG} dl.kv`, { timeout: 4000 });
      f.ok((await page.locator(`${DLG} dl.kv dt`).count()) >= 9, 'the details list every condition');
      await snap(f, 'coupons-details');
      await page.keyboard.press('Escape');
      f.ok(await closed(page), 'the details close');

      await pickMenu(f, 'SHIPFREE', 0);
      await page.waitForSelector(`${DLG} dl.kv`);
      f.ok((await text(page, `${DLG} dl.kv`)).includes('rahim@example.com'), 'the customer limit shows the e-mail, not the id');
      await page.keyboard.press('Escape');
      f.ok(await closed(page));
      f.eq(await couponCount(f), 6, 'looking changes nothing');
      f.eq(await audits(f), [], 'and audits nothing');
    },
  },
  {
    name: 'admin coupons: create a percentage coupon for two categories and one customer — stored exactly, audited, and listed as scheduled', as: 'sa',
    async run(f) {
      const { page } = f;
      await openCoupons(f);
      await openAdd(f);
      await snap(f, 'coupons-new-top');
      f.eq(await page.locator(`${FORM} #cpn-cats:not([hidden]), ${FORM} #cpn-prods:not([hidden])`).count(), 0, 'no picker while "all products" is chosen');
      await fill(page, { code: ' eid-26 ', description: '  Eid   offer  ', value: 15, maxDiscount: 300, minOrder: 800, usageLimit: 50, perCustomerLimit: 2 });
      const startIn = dhaka(2 * DAY);
      const endIn = dhaka(30 * DAY);
      await page.fill('#f-startsAt', startIn);
      await page.fill('#f-endsAt', endIn);
      await page.selectOption('#f-appliesTo', 'categories');
      await page.waitForSelector('#cpn-cats:not([hidden])');
      f.eq(await page.locator('#cpn-cats input[data-pick-id]').count(), 3, 'the three categories can be ticked');
      await page.check('#cpn-cats [data-pick-id="c1"]');
      await page.check('#cpn-cats [data-pick-id="c3"]');
      await page.check('#f-excludeSaleItems');
      await page.fill('#f-customers', 'Rahim@Example.com');
      await snap(f, 'coupons-new-filled');
      await page.click(YES);
      f.ok(await closed(page), 'created');
      const c = await f.doc('coupons/EID-26');
      f.ok(c, 'the code is trimmed and upper-cased');
      f.eq([c.code, c.type, c.value, c.maxDiscount, c.minOrder, c.description], ['EID-26', 'percent', 15, 300, 800, 'Eid offer'], 'offer, cap, minimum order and note');
      f.eq([c.appliesTo, [...c.categoryIds].sort(), c.productIds, c.excludeSaleItems, c.customerIds], ['categories', ['c1', 'c3'], [], true, ['u1']], 'scope and customer (the e-mail became the account id)');
      f.eq([c.usageLimit, c.perCustomerLimit, c.usedCount, c.active], [50, 2, 0, true], 'limits start at zero uses, switched on');
      const utc = (local) => new Date(`${local}:00Z`).getTime() - 6 * 3600000;               // Dhaka is UTC+6 all year
      f.eq([tsMs(c.startsAt), tsMs(c.endsAt)], [utc(startIn), utc(endIn)], 'the Dhaka times were converted to the exact instants');
      f.eq(Object.keys(c).sort(), ['active', 'appliesTo', 'categoryIds', 'code', 'createdAt', 'customerIds', 'description', 'endsAt', 'excludeSaleItems', 'maxDiscount', 'minOrder', 'perCustomerLimit', 'productIds', 'startsAt', 'type', 'updatedAt', 'usageLimit', 'usedCount', 'value'], 'and nothing else');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 2, null, { timeout: 6000 });
      f.eq(await page.locator(`${ROWS} .badge-info`).count(), 1, 'it is listed as scheduled (it starts in two days)');
      f.eq(await audits(f), [['coupon.create', 'EID-26', 'sa', 'super_admin']], 'one audit entry');

      // opening it again shows what was saved, the customer as an e-mail
      await pickMenu(f, 'EID-26', 1);
      await page.waitForSelector(FORM);
      f.eq([await page.inputValue('#f-code'), await page.inputValue('#f-value'), await page.inputValue('#f-maxDiscount'), await page.inputValue('#f-minOrder'), await page.inputValue('#f-usageLimit'), await page.inputValue('#f-perCustomerLimit')], ['EID-26', '15', '300', '800', '50', '2'], 'the form shows the stored values');
      f.eq(await page.getAttribute('#f-code', 'readonly'), '', 'the code cannot be changed');
      f.eq([await page.inputValue('#f-startsAt'), await page.inputValue('#f-endsAt')], [startIn, endIn], 'start and end show again in Dhaka time, as entered');
      f.eq((await page.inputValue('#f-customers')).toLowerCase(), 'rahim@example.com', 'the customer is shown as an e-mail');
      f.eq(await page.locator('#cpn-cats input:checked').count(), 2, 'both categories are ticked');
      f.eq(await page.locator('#cpn-prods:not([hidden])').count(), 0, 'the product picker stays hidden');
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page));
    },
  },
  {
    name: 'admin coupons: every rule shows its message next to the field, nothing is saved; free delivery ignores a leftover value', as: 'sa',
    async run(f) {
      const { page } = f;
      await openCoupons(f);
      await openAdd(f);
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-code')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      await hasError(f, ['code', 'value'], 'says what is missing');
      f.eq(await couponCount(f), 1, 'nothing was saved');
      await snap(f, 'coupons-new-errors');

      await fill(page, { code: 'bad code!', value: 150 });
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-value')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      await hasError(f, ['code', 'value'], 'a code with a space and a percentage above 100');

      await fill(page, { code: 'welcome10', value: 10 });
      await page.click(YES);
      await page.waitForFunction(() => /./.test(document.querySelector('#err-code')?.textContent || ''), null, { timeout: 6000 });
      f.ok((await errorOf(page, 'code')).length > 3, 'a code that already exists is refused (the check is not case sensitive)');
      f.eq(await errorOf(page, 'value'), '', 'the valid value shows no message');
      f.eq((await f.doc('coupons/WELCOME10')).value, 10, 'the existing coupon was not touched');

      await fill(page, { code: 'NEW-1', minOrder: 100, usageLimit: 0, perCustomerLimit: 0 });
      await page.fill('#f-startsAt', dhaka(5 * DAY));
      await page.fill('#f-endsAt', dhaka(2 * DAY));
      await page.selectOption('#f-appliesTo', 'products');
      await page.fill('#f-customers', 'nobody@example.com');
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-customers')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      f.ok((await errorOf(page, 'customers')).includes('nobody@example.com'), 'an e-mail without an account is named');
      f.eq(await couponCount(f), 1, 'still nothing saved');
      await page.fill('#f-customers', '');
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-products')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      await hasError(f, ['endsAt', 'usageLimit', 'perCustomerLimit', 'products'], 'an end before the start, limits below 1, no product ticked');
      await page.selectOption('#f-appliesTo', 'categories');
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-categories')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      f.ok((await errorOf(page, 'categories')).length > 3, 'no category ticked');
      await page.fill('#f-endsAt', dhaka(-DAY));
      await page.fill('#f-startsAt', '');
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-endsAt')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      f.ok((await errorOf(page, 'endsAt')).length > 3, 'a new coupon cannot end in the past');
      f.eq(await page.locator(DLG).count(), 1, 'the dialog stays open');
      f.eq(await couponCount(f), 1, 'nothing saved so far');

      // free delivery: the percentage field and the cap go away, whatever was typed in them is ignored
      await page.selectOption('#f-type', 'free_shipping');
      f.eq(await page.locator('[data-show-value]').evaluate((el) => el.hidden), true, 'no value field for free delivery');
      f.eq(await page.locator('[data-show-cap]').evaluate((el) => el.hidden), true, 'and no cap');
      await page.selectOption('#f-appliesTo', 'all');
      await page.fill('#f-endsAt', dhaka(10 * DAY));
      await fill(page, { usageLimit: 5, perCustomerLimit: 1 });
      await page.click(YES);
      f.ok(await closed(page), 'saved');
      const c = await f.doc('coupons/NEW-1');
      f.eq([c.type, c.value, c.maxDiscount, c.minOrder, c.appliesTo, c.usageLimit, c.perCustomerLimit, c.startsAt], ['free_shipping', 0, null, 100, 'all', 5, 1, null], 'free delivery stores no value, the rest as entered');
      f.eq(await audits(f), [['coupon.create', 'NEW-1', 'sa', 'super_admin']], 'one audit entry for the one coupon');
    },
  },
  {
    name: 'admin coupons: a Store Admin edits a coupon — code and usage stay, an unchanged save writes nothing, the limit cannot drop below the uses', as: 'sadm',
    async run(f) {
      const { page } = f;
      await seed(f, 'USED3', `{ type: 'percent', value: 5, usageLimit: 10, usedCount: 3, perCustomerLimit: 1 }`);
      await openCoupons(f);
      await pickMenu(f, 'WELCOME10', 1);
      await page.waitForSelector(FORM);
      f.eq([await page.inputValue('#f-value'), await page.inputValue('#f-maxDiscount'), await page.inputValue('#f-minOrder'), await page.inputValue('#f-usageLimit'), await page.inputValue('#f-perCustomerLimit'), await page.inputValue('#f-type')], ['10', '200', '500', '100', '1', 'percent'], 'the form shows the saved values');
      await fill(page, { description: 'Welcome gift', value: 12, maxDiscount: '' });
      await page.click(YES);
      f.ok(await closed(page), 'saved');
      const c = await f.doc('coupons/WELCOME10');
      f.eq([c.value, c.maxDiscount, c.description, c.minOrder, c.usageLimit, c.usedCount, c.code, c.active], [12, null, 'Welcome gift', 500, 100, 0, 'WELCOME10', true], 'the changed values are stored, the others stay');
      f.ok(c.updatedAt, 'the change is stamped');
      f.eq(await audits(f), [['coupon.update', 'WELCOME10', 'sadm', 'store_admin']], 'one audit entry, by the Store Admin');

      await pickMenu(f, 'WELCOME10', 1);
      await page.waitForSelector(FORM);
      await page.click(YES);
      f.ok(await closed(page), 'saving the same values just closes the dialog');
      f.eq((await audits(f)).length, 1, 'and writes nothing');

      await pickMenu(f, 'USED3', 1);
      await page.waitForSelector(FORM);
      await fill(page, { usageLimit: 2 });
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-usageLimit')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      f.ok((await errorOf(page, 'usageLimit')).length > 3, 'a limit below the 3 uses so far is refused');
      f.eq((await f.doc('coupons/USED3')).usageLimit, 10, 'the stored limit is untouched');
      await fill(page, { usageLimit: 3 });
      await page.click(YES);
      f.ok(await closed(page), 'a limit equal to the uses is fine');
      const u = await f.doc('coupons/USED3');
      f.eq([u.usageLimit, u.usedCount], [3, 3], 'the limit changed, the uses did not');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody .badge-warn').length === 1, null, { timeout: 6000 });
      f.eq(await page.locator(`${ROWS} .badge-warn`).count(), 1, 'the list now shows it as used up');
    },
  },
  {
    name: 'admin coupons: switch off and on without a question; delete asks first and only an unused coupon can go', as: 'sa',
    async run(f) {
      const { page } = f;
      await seed(f, 'USED1', `{ usedCount: 1 }`);
      await openCoupons(f);
      await pickMenu(f, 'WELCOME10', 2);
      f.ok(await f.until(async () => (await f.doc('coupons/WELCOME10')).active === false), 'switched off');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr .badge-ok').length === 1, null, { timeout: 6000 });
      f.eq(await page.locator(`${ROWS} .badge-ok`).count(), 1, 'only USED1 is still live');
      await pickMenu(f, 'WELCOME10', 2);
      f.ok(await f.until(async () => (await f.doc('coupons/WELCOME10')).active === true), 'and on again');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr .badge-ok').length === 2, null, { timeout: 6000 });

      f.eq(await menuItems(f, 'USED1'), 3, 'a used coupon has no delete');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="menu"]', { state: 'detached', timeout: 4000 });

      await pickMenu(f, 'WELCOME10', 3);
      await page.waitForSelector(`${DLG} [data-no]`);
      f.ok((await text(page, DLG)).length > 30, 'the confirmation says what happens');
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page));
      f.eq(await couponCount(f), 2, 'cancel keeps it');
      await pickMenu(f, 'WELCOME10', 3);
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(`${DLG} [data-yes]`);
      f.ok(await f.until(async () => (await couponCount(f)) === 1), 'the unused coupon is deleted');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-table tbody tr').length === 1, null, { timeout: 6000 });
      f.eq(await audits(f), [['coupon.deactivate', 'WELCOME10', 'sa', 'super_admin'], ['coupon.activate', 'WELCOME10', 'sa', 'super_admin'], ['coupon.delete', 'WELCOME10', 'sa', 'super_admin']].sort(byJson), 'each change is audited');
    },
  },
  {
    name: 'admin coupons: product picker — search keeps the ticks, a product that no longer exists is shown and must be unticked', as: 'sa',
    async run(f) {
      const { page } = f;
      await seed(f, 'PICK', `{ appliesTo: 'products', productIds: ['p2', 'gone-product'] }`);
      await openCoupons(f);
      await pickMenu(f, 'PICK', 1);
      await page.waitForSelector(FORM);
      f.eq(await page.locator('#cpn-prods:not([hidden])').count(), 1, 'the product picker is open for a product coupon');
      f.ok((await page.locator('#cpn-prods input[data-pick-id]').count()) >= 7, 'the published products are listed');
      f.eq(await page.locator('#cpn-prods input[data-pick-id]:checked').count(), 2, 'the two stored products are ticked');
      f.eq(await page.locator('#cpn-prods input[data-pick-id="gone-product"]').count(), 1, 'one that is no longer in the catalog is still listed');
      await page.locator('#cpn-prods').scrollIntoViewIfNeeded();
      await snap(f, 'coupons-picker');
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-products')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      f.ok((await errorOf(page, 'products')).length > 3, 'saving with the missing product is refused with an explanation');
      f.eq((await f.doc('coupons/PICK')).productIds, ['p2', 'gone-product'], 'nothing was saved');
      await page.uncheck('#cpn-prods [data-pick-id="gone-product"]');

      await page.fill('#cpn-pq', 'watch');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-prods input[data-pick-id]').length >= 1 && document.querySelectorAll('#cpn-prods input[data-pick-id]').length <= 3, null, { timeout: 6000 });
      f.eq(await page.locator('#cpn-prods input[data-pick-id="p5"]').count(), 1, 'the search finds the Sports Watch');
      await page.check('#cpn-prods [data-pick-id="p5"]');
      await page.fill('#cpn-pq', 'no such product anywhere');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-prods input[data-pick-id]').length === 0, null, { timeout: 6000 });
      await page.fill('#cpn-pq', '');
      await page.waitForFunction(() => document.querySelectorAll('#cpn-prods input[data-pick-id]').length >= 7, null, { timeout: 6000 });
      f.eq(await page.locator('#cpn-prods input[data-pick-id]:checked').count(), 2, 'the ticks survived the search (the wallet and the watch)');
      await page.click(YES);
      f.ok(await closed(page), 'saved');
      f.eq([...(await f.doc('coupons/PICK')).productIds].sort(), ['p2', 'p5'], 'exactly the two ticked products');
      f.eq(await audits(f), [['coupon.update', 'PICK', 'sa', 'super_admin']], 'audited');
    },
  },
  {
    name: 'admin coupons: an Order Manager can look at every coupon but not change anything', as: 'om',
    async run(f) {
      const { page } = f;
      await seed(f, 'VIP', `{ customerIds: ['u2'], usedCount: 1 }`);
      await openCoupons(f);
      f.eq(await page.locator(ROWS).count(), 2, 'both coupons are listed');
      f.eq(await page.locator('[data-action="add"]').count(), 0, 'there is no "new coupon" button');
      f.eq(await page.locator('.alert-info').count(), 1, 'a note explains why');
      f.eq(await menuItems(f, 'WELCOME10'), 1, 'the row menu offers details only');
      await page.locator('[role="menu"] [role="menuitem"]').nth(0).click();
      await page.waitForSelector(`${DLG} dl.kv`);
      await page.keyboard.press('Escape');
      f.ok(await closed(page));
      await pickMenu(f, 'VIP', 0);
      await page.waitForSelector(`${DLG} dl.kv`);
      f.ok((await text(page, `${DLG} dl.kv`)).includes('karim@example.com'), 'a customer-only coupon names the customer (the Order Manager may read customers)');
      await page.keyboard.press('Escape');
      f.ok(await closed(page));
      f.eq(await audits(f), [], 'nothing was changed');
    },
  },
  ...['im', 'cs', 'rp'].map((role) => ({
    name: `admin coupons: ${role} cannot open the page`, as: role,
    async run(f) {
      const { page } = f;
      await f.goto(PAGE);
      await page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await page.locator('#cpn-table').count(), 0, 'no coupon list');
      f.eq(await page.locator('a[href$="#/coupons"]').count(), 0, 'and no menu item for it');
    },
  })),
];
