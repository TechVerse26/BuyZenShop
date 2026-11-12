/*
 * Admin "Staff & roles", clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   staff: sa Super Admin (the person signed in here) · sadm Store Admin · pm · om · im · cs · rp
 *   customer accounts that can be turned into staff: u1 Rahim (rahim@example.com) · u2 Karim (karim@example.com)
 */
import { DLG, YES, text } from './helpers.mjs';

const STAFF = '/admin/#/staff';
const MENU = (uid) => `[data-action="row-menu"][data-uid="${uid}"]`;
const closed = (page) => page.waitForSelector(DLG, { state: 'detached', timeout: 8000 }).then(() => true, () => false);
const audits = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => a.action.startsWith('staff.')).map((a) => [a.action, a.entityId, a.actorUid]);

async function openStaff(f) {
  await f.goto(STAFF);
  await f.page.waitForSelector('#stf-table tbody tr', { timeout: 12000 });
}
async function pickMenu(f, uid, index) {
  await f.page.click(MENU(uid));
  await f.page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 4000 });
  await f.page.locator('[role="menu"] [role="menuitem"]').nth(index).click();
}

export const adminStaffFlows = [
  {
    name: 'admin staff: add a member (found by e-mail), change the role, switch off, switch on, remove', as: 'sa',
    async run(f) {
      const { page } = f;
      await openStaff(f);
      f.eq(await page.locator('#stf-table tbody tr').count(), 7, 'the seven seeded members are listed');
      f.ok((await text(page, `#stf-table tr:has(${MENU('sa')})`)).length > 0 && (await page.locator(`#stf-table tr:has(${MENU('sa')}) .badge`).count()) >= 2, 'the signed-in person is marked "You"');

      // add: look the account up by e-mail, the rest is filled in
      await page.click('[data-action="add"]');
      await page.waitForSelector(`${DLG} form[data-form="staff-add"]`);
      await page.fill('#f-lookup', 'nobody@example.com');
      await page.click('[data-find]');
      await page.waitForFunction(() => document.querySelector('#stf-found')?.textContent.trim().length > 10, null, { timeout: 6000 });
      f.eq(await page.inputValue('#f-uid'), '', 'an unknown e-mail fills nothing');
      await page.fill('#f-lookup', 'Rahim@Example.com');
      await page.click('[data-find]');
      await page.waitForFunction(() => document.querySelector('#f-uid')?.value === 'u1', null, { timeout: 6000 });
      f.eq([await page.inputValue('#f-email'), await page.inputValue('#f-name')], ['rahim@example.com', 'Rahim'], 'uid, e-mail and name come from the account');
      await page.click(YES);
      await page.waitForSelector('#err-role:not(:empty)', { timeout: 6000 });
      f.eq(Object.keys(await f.docs('staff/')).includes('staff/u1'), false, 'a role must be chosen first');
      await page.selectOption('#f-role', 'order_manager');
      f.ok((await text(page, '#stf-role-about')).length > 5, 'the role is described under the list');
      await page.click(YES);
      f.ok(await closed(page), 'the dialog closed');
      const s = await f.doc('staff/u1');
      f.eq([s.role, s.active, s.email, s.name, s.createdBy], ['order_manager', true, 'rahim@example.com', 'Rahim', 'sa'], 'the staff record has exactly what was entered');
      f.eq(Object.keys(s).sort(), ['active', 'createdAt', 'createdBy', 'email', 'name', 'role', 'updatedAt'], 'and nothing else');
      f.eq(await audits(f), [['staff.create', 'u1', 'sa']], 'one audit entry');
      await page.waitForSelector(MENU('u1'));
      f.eq(await page.locator('#stf-table tbody tr').count(), 8, 'the list shows the new member');

      // the same account cannot be added twice
      await page.click('[data-action="add"]');
      await page.waitForSelector(`${DLG} form[data-form="staff-add"]`);
      await page.fill('#f-uid', 'u1'); await page.fill('#f-email', 'rahim@example.com'); await page.selectOption('#f-role', 'reporting');
      await page.click(YES);
      await page.waitForSelector('#err-uid:not(:empty)', { timeout: 6000 });
      f.eq((await f.doc('staff/u1')).role, 'order_manager', 'the existing record is untouched');
      await page.fill('#f-uid', 'a/b'); await page.click(YES);
      await page.waitForFunction(() => document.querySelector('#err-uid')?.textContent.length > 20, null, { timeout: 6000 });
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page), 'cancel closes the dialog');

      // change the role and the name
      await pickMenu(f, 'u1', 0);
      await page.waitForSelector(`${DLG} form[data-form="staff-edit"]`);
      await page.selectOption('#f-role', 'inventory_manager');
      await page.fill('#f-name', 'Rahim Uddin');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('staff/u1')).role === 'inventory_manager'), 'the role changed');
      f.eq((await f.doc('staff/u1')).name, 'Rahim Uddin', 'and the name');
      f.ok(await closed(page), 'the dialog closed');

      // switch off (asks first), then it can be removed
      await pickMenu(f, 'u1', 1);
      await page.waitForSelector(YES);
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page), 'declining the question changes nothing');
      f.eq((await f.doc('staff/u1')).active, true, 'still active');
      await pickMenu(f, 'u1', 1);
      await page.waitForSelector(YES);
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('staff/u1')).active === false), 'switched off');
      await page.waitForFunction(() => document.querySelector('tr:has([data-uid="u1"]) .badge')?.parentElement?.textContent.length > 0, null, { timeout: 4000 });
      await pickMenu(f, 'u1', 1);
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 4000 });
      f.ok(await f.until(async () => (await f.doc('staff/u1')).active === true), 'switched on again, without a question');

      await pickMenu(f, 'u1', 1);
      await page.waitForSelector(YES);
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('staff/u1')).active === false), 'off again');
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 4000 });
      await page.click(MENU('u1'));
      await page.waitForSelector('[role="menu"] [role="menuitem"]');
      f.eq(await page.locator('[role="menu"] [role="menuitem"]').count(), 3, 'a switched-off member can also be removed');
      await page.locator('[role="menu"] [role="menuitem"]').nth(2).click();
      await page.waitForSelector(YES);
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('staff/u1')) === undefined || (await f.doc('staff/u1')) === null), 'the record is gone');
      f.eq(await page.locator('#stf-table tbody tr').count(), 7, 'and so is the row');
      f.eq((await audits(f)).map((a) => a[0]).sort(), ['staff.activate', 'staff.create', 'staff.deactivate', 'staff.deactivate', 'staff.remove', 'staff.role'], 'every step is in the audit log');
    },
  },

  {
    name: 'admin staff: you cannot change your own role or switch yourself off', as: 'sa',
    async run(f) {
      const { page } = f;
      await openStaff(f);
      await page.click(MENU('sa'));
      await page.waitForSelector('[role="menu"] [role="menuitem"]');
      f.eq(await page.locator('[role="menu"] [role="menuitem"]').count(), 1, 'the menu of your own row only offers "Edit"');
      await page.locator('[role="menu"] [role="menuitem"]').first().click();
      await page.waitForSelector(`${DLG} form[data-form="staff-edit"]`);
      f.eq([await page.locator('#f-role').isDisabled(), await page.locator('#f-active').isDisabled()], [true, true], 'role and the on/off switch are locked');
      await page.fill('#f-name', 'Owner');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('staff/sa')).name === 'Owner'), 'the name can be changed');
      f.eq([(await f.doc('staff/sa')).role, (await f.doc('staff/sa')).active], ['super_admin', true], 'the role and the switch stayed');
      f.ok(await closed(page), 'closed');
      // another member of staff can be demoted by you
      await pickMenu(f, 'sadm', 0);
      await page.waitForSelector(`${DLG} form[data-form="staff-edit"]`);
      await page.selectOption('#f-role', 'reporting');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('staff/sadm')).role === 'reporting'), 'someone else can be changed');
      f.eq((await audits(f)).map((a) => a[0]).sort(), ['staff.role', 'staff.update'], 'both are audited');
    },
  },

  {
    name: 'admin staff: the roles list shows what each role may do', as: 'sa',
    async run(f) {
      const { page } = f;
      await openStaff(f);
      f.eq(await page.locator('.accordion > details').count(), 7, 'seven roles');
      await page.locator('.accordion > details').first().locator('summary').click();
      f.ok((await text(page, '.accordion > details:first-child .acc-body')).length > 10, 'Super Admin: everything');
      f.eq(await page.locator('.accordion > details:first-child .stf-perms').count(), 0, 'no long list for Super Admin');
      await page.locator('.accordion > details').nth(5).locator('summary').click();
      f.ok(await page.locator('.accordion > details:nth-child(6) .stf-perms li').count() >= 4, 'a role with limits lists its permissions');
      f.eq(await page.locator('.accordion > details:nth-child(7) .stf-perms li').count() > 0, true, 'every role lists something');
    },
  },

  {
    name: 'admin staff: only a Super Admin reaches the page', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(STAFF);
      await page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await page.locator('#stf-table').count(), 0, 'no staff list');
      f.eq(await page.locator('a[href$="#/staff"]').count(), 0, 'and no menu item for it');
    },
  },
];
