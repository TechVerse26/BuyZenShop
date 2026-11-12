/*
 * Admin "Shipping zones", clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   shippingZones: inside-sirajganj (Sirajganj · 70 · 1–2 days, sort 1) · outside-sirajganj (the other 63 districts · 130 · 2–5 days, sort 2), both active
 *   staff: sa Super Admin · sadm Store Admin · pm · om Order Manager · im · cs · rp
 */
import { DLG, YES, text, snap } from './helpers.mjs';

const SHIP = '/admin/#/shipping';
const IN = 'inside-sirajganj';
const OUT = 'outside-sirajganj';
const MENU = (id) => `[data-action="row-menu"][data-id="${id}"]`;
const D = (name) => `input[data-district="${name}"]`;
const FORM = `${DLG} form[data-form="zone"]`;
const closed = (page) => page.waitForSelector(DLG, { state: 'detached', timeout: 8000 }).then(() => true, () => false);
const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const audits = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => a.action.startsWith('shipping.'))
  .map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(byJson);
const zoneCount = async (f) => Object.keys(await f.docs('shippingZones/')).length;

async function openShipping(f) {
  await f.goto(SHIP);
  await f.page.waitForSelector('#shz-table tbody tr', { timeout: 12000 });
}
// on a phone a toast from the previous step can sit on top of the next button: clear it (the step that needed it has already looked at it)
const calm = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((el) => el.remove()));
async function pickMenu(f, id, index) {
  await calm(f.page);
  await f.page.click(MENU(id));
  await f.page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 4000 });
  await f.page.locator('[role="menu"] [role="menuitem"]').nth(index).click();
}
async function openAdd(f) {
  await f.page.click('[data-action="add"]');
  await f.page.waitForSelector(FORM);
}
const fillZone = async (page, values) => { for (const [k, v] of Object.entries(values)) await page.fill(`#f-${k}`, String(v)); };

export const adminShippingFlows = [
  {
    name: 'admin shipping: zones are listed, coverage is complete, the picker greys out districts another active zone has', as: 'sa',
    async run(f) {
      const { page } = f;
      await openShipping(f);
      f.eq(await page.locator('#shz-table tbody tr').count(), 2, 'the two seeded zones are listed');
      f.eq(await page.locator('#shz-cover.alert-ok').count(), 1, 'every district is covered: the green note');
      await openAdd(f);
      f.eq(await page.locator('input[data-district]').count(), 64, 'all 64 districts can be picked');
      f.eq(await page.locator('input[data-district]:disabled').count(), 64, 'all of them belong to an active zone, so none can be taken');
      await snap(f, 'shipping-dialog-top');
      await page.locator('#shz-pick').scrollIntoViewIfNeeded();
      await snap(f, 'shipping-dialog-picker-held');
      await page.uncheck('#f-active');
      f.eq(await page.locator('input[data-district]:disabled').count(), 0, 'a zone that is switched off may hold any district');
      const first = page.locator('.shz-div').first();
      await first.locator('[data-pick="all"]').click();
      f.ok((await first.locator('input[data-district]:checked').count()) >= 8, 'select all ticks every district of the division');
      f.ok((await text(page, '#shz-count')).length > 3, 'the counter is shown');
      await first.locator('[data-pick="none"]').click();
      f.eq(await first.locator('input[data-district]:checked').count(), 0, 'clear unticks them');
      await page.check('#f-active');
      f.eq(await page.locator('input[data-district]:disabled').count(), 64, 'switching the zone on greys them out again');
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page), 'cancel closes the dialog');
      f.eq(await zoneCount(f), 2, 'nothing was saved');
    },
  },
  {
    name: 'admin shipping: take Dhaka out of the big zone and give it its own — coverage warns in between, both changes are audited', as: 'sa',
    async run(f) {
      const { page } = f;
      await openShipping(f);
      await pickMenu(f, OUT, 0);
      await page.waitForSelector(FORM);
      f.eq(await page.locator('input[data-district]:checked').count(), 63, 'the zone ticks its 63 districts');
      f.eq([await page.inputValue('#f-fee'), await page.inputValue('#f-etaMin'), await page.inputValue('#f-etaMax'), await page.inputValue('#f-freeOver')], ['130', '2', '5', ''], 'the form shows the saved values');
      await page.uncheck(D('Dhaka'));
      await page.click(YES);
      f.ok(await closed(page), 'saved');
      const out = await f.doc(`shippingZones/${OUT}`);
      f.eq([out.districts.length, out.districts.includes('Dhaka'), out.fee, out.active, out.sort], [62, false, 130, true, 2], 'Dhaka left the zone; the rest is untouched');
      await page.waitForSelector('#shz-cover.alert-warn', { timeout: 6000 });
      await page.click('#shz-cover summary');
      f.ok((await text(page, '#shz-cover details')).length > 10, 'the uncovered districts can be listed');

      await openAdd(f);
      await fillZone(page, { name: ' Dhaka   City ', fee: 80, freeOver: 3000, etaMin: 1, etaMax: 2 });
      f.eq(await page.locator('input[data-district]:disabled').count(), 63, 'only Dhaka is free to take');
      await page.check(D('Dhaka'));
      await page.click(YES);
      f.ok(await closed(page), 'created');
      const z = await f.doc('shippingZones/dhaka-city');
      f.eq([z.name, z.districts, z.fee, z.freeOver, z.etaMin, z.etaMax, z.active, z.sort], ['Dhaka City', ['Dhaka'], 80, 3000, 1, 2, true, 3], 'the new zone has exactly what was entered');
      f.eq(Object.keys(z).sort(), ['active', 'districts', 'etaMax', 'etaMin', 'fee', 'freeOver', 'name', 'sort', 'updatedAt'], 'and nothing else');
      await page.waitForSelector('#shz-cover.alert-ok', { timeout: 6000 });
      f.eq(await page.locator('#shz-table tbody tr').count(), 3, 'three zones are listed');
      f.eq(await audits(f), [['shipping.create', 'dhaka-city', 'sa', 'super_admin'], ['shipping.update', OUT, 'sa', 'super_admin']].sort(byJson), 'one audit entry per change');
    },
  },
  {
    name: 'admin shipping: every rule shows its message next to the field and nothing is saved', as: 'sa',
    async run(f) {
      const { page } = f;
      await openShipping(f);
      await openAdd(f);
      await page.click(YES);
      await page.waitForSelector('#err-districts:not(:empty)', { timeout: 6000 });
      for (const field of ['name', 'fee', 'etaMin', 'etaMax', 'districts']) f.ok((await text(page, `#err-${field}`)).length > 3, `#${field} says what is missing`);
      f.eq(await zoneCount(f), 2, 'nothing was saved');
      await snap(f, 'shipping-dialog-errors');

      const taken = (await f.doc(`shippingZones/${OUT}`)).name;
      await fillZone(page, { name: taken.toUpperCase(), fee: 99999, etaMin: 5, etaMax: 2 });
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-etaMax')?.textContent.length || 0) > 3, null, { timeout: 6000 });
      for (const field of ['name', 'fee', 'etaMax']) f.ok((await text(page, `#err-${field}`)).length > 3, `#${field}: a name that exists, a fee out of range, a slowest time below the fastest`);
      f.eq(await text(page, '#err-etaMin'), '', 'a valid field shows no message');

      // a district the big zone already has: allowed while this zone is switched off, refused once it is switched on
      await fillZone(page, { name: 'Test zone', fee: 50, etaMin: 1, etaMax: 2 });
      await page.uncheck('#f-active');
      await page.check(D('Dhaka'));
      await page.check('#f-active');
      f.eq(await page.locator(`${D('Dhaka')}:disabled`).count(), 0, 'an already ticked district can still be unticked');
      await page.click(YES);
      await page.waitForFunction(() => (document.querySelector('#err-districts')?.textContent.length || 0) > 10, null, { timeout: 6000 });
      f.eq(await text(page, '#err-name'), '', 'the name is fine now');
      f.eq(await zoneCount(f), 2, 'still nothing saved');
      f.eq((await f.doc(`shippingZones/${OUT}`)).districts.includes('Dhaka'), true, 'and Dhaka is still in the big zone');
      f.eq(await page.locator(DLG).count(), 1, 'the dialog stays open');
      await page.uncheck('#f-active');
      await page.click(YES);
      f.ok(await closed(page), 'switched off, the same zone is accepted');
      const z = await f.doc('shippingZones/test-zone');
      f.eq([z.active, z.districts], [false, ['Dhaka']], 'a switched-off zone may hold Dhaka');
    },
  },
  {
    name: 'admin shipping: switching off asks first and names the uncovered districts; a clashing zone cannot be switched on; only a switched-off zone is deleted', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.put('shippingZones/dhaka-spare', "({ name: 'Dhaka spare', districts: ['Dhaka'], fee: 99, freeOver: null, etaMin: 1, etaMax: 2, active: false, sort: 3, updatedAt: new Ts(Date.now()) })");
      await openShipping(f);
      f.eq(await page.locator('#shz-table tbody tr').count(), 3, 'three zones');
      await page.click(MENU(OUT));
      await page.waitForSelector('[role="menu"] [role="menuitem"]');
      f.eq(await page.locator('[role="menu"] [role="menuitem"]').count(), 2, 'an active zone offers edit and switch off, but no delete');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="menu"]', { state: 'detached', timeout: 4000 });

      await pickMenu(f, 'dhaka-spare', 1);
      await page.waitForSelector('#toasts .toast-bad', { timeout: 6000 });
      f.eq((await f.doc('shippingZones/dhaka-spare')).active, false, 'Dhaka is held by the big zone: the spare zone stays off');
      f.eq((await audits(f)).length, 0, 'and nothing was audited');

      await pickMenu(f, IN, 1);
      await page.waitForSelector(`${DLG} [data-no]`);
      f.ok((await text(page, DLG)).length > 40, 'the confirmation explains the consequence');
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page));
      f.eq((await f.doc(`shippingZones/${IN}`)).active, true, 'cancel leaves it on');
      await pickMenu(f, IN, 1);
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(`${DLG} [data-yes]`);
      f.ok(await f.until(async () => (await f.doc(`shippingZones/${IN}`)).active === false), 'it is switched off');
      await page.waitForSelector('#shz-cover.alert-warn', { timeout: 6000 });
      await pickMenu(f, IN, 1);
      f.ok(await f.until(async () => (await f.doc(`shippingZones/${IN}`)).active === true), 'and on again, without a question');
      await page.waitForSelector('#shz-cover.alert-ok', { timeout: 6000 });

      await pickMenu(f, 'dhaka-spare', 2);
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(`${DLG} [data-yes]`);
      f.ok(await f.until(async () => (await zoneCount(f)) === 2), 'the switched-off zone is deleted');
      await page.waitForFunction(() => document.querySelectorAll('#shz-table tbody tr').length === 2, null, { timeout: 6000 });
      f.eq(await audits(f), [['shipping.activate', IN, 'sa', 'super_admin'], ['shipping.deactivate', IN, 'sa', 'super_admin'], ['shipping.delete', 'dhaka-spare', 'sa', 'super_admin']].sort(byJson), 'each change is audited');
    },
  },
  {
    name: 'admin shipping: an Order Manager can change a zone, and saving without a change writes nothing', as: 'om',
    async run(f) {
      const { page } = f;
      await openShipping(f);
      await pickMenu(f, IN, 0);
      await page.waitForSelector(FORM);
      f.eq([await page.inputValue('#f-fee'), await page.inputValue('#f-etaMin'), await page.inputValue('#f-etaMax'), await page.inputValue('#f-freeOver')], ['70', '1', '2', ''], 'the form shows the saved values');
      await fillZone(page, { fee: 85, freeOver: 2500, etaMax: 3 });
      await page.click(YES);
      f.ok(await closed(page), 'saved');
      const z = await f.doc(`shippingZones/${IN}`);
      f.eq([z.fee, z.freeOver, z.etaMin, z.etaMax, z.districts, z.active, z.sort], [85, 2500, 1, 3, ['Sirajganj'], true, 1], 'the changed values are stored, the others stay');
      f.eq(await audits(f), [['shipping.update', IN, 'om', 'order_manager']], 'one audit entry, by the Order Manager');
      await pickMenu(f, IN, 0);
      await page.waitForSelector(FORM);
      await page.click(YES);
      f.ok(await closed(page), 'saving the same values just closes the dialog');
      f.eq((await audits(f)).length, 1, 'and writes nothing');
    },
  },
  ...['pm', 'cs'].map((role) => ({
    name: `admin shipping: ${role} cannot open the page`, as: role,
    async run(f) {
      const { page } = f;
      await f.goto(SHIP);
      await page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await page.locator('#shz-table').count(), 0, 'no zone list');
      f.eq(await page.locator('a[href$="#/shipping"]').count(), 0, 'and no menu item for it');
    },
  })),
];
