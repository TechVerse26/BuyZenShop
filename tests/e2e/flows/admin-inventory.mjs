/*
 * Admin inventory, clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   p1 TS-001 Classic Cotton T-Shirt stock 25, 2 held by the open order · p2 WL-002 stock 3, 1 held · p5 WA-005 stock 50, 1 held
 *   p3__v1..v3 RS-003-40/41/42 stock 10/10/0 · p4 PC-004 not tracked · p6 CP-006 stock 1 (backorder) · p7 SG-007 stock 0
 * Staff: im Inventory Manager · sadm Store Admin · pm Product Manager (reads stock, cannot change it) · cs Customer Support (no inventory access).
 * After every action the mock database is inspected: stock, held units, movement log, audit log.
 */
import fs from 'node:fs';
import { DLG, YES, text } from './helpers.mjs';

const INV = '/admin/#/inventory';
const MENU_BTN = (key) => `[data-action="row-menu"][data-key="${key}"]`;
const movesOf = async (f, key) => Object.values(await f.docs('inventoryMovements/')).filter((m) => m.key === key);
const rowCount = (page) => page.locator('#inv-body tbody tr').count();
/** the dialog closes after the page reloaded its numbers, a moment after the database write */
const closed = (page) => page.waitForSelector(DLG, { state: 'detached', timeout: 8000 }).then(() => true, () => false);

async function openInv(f, query = '') {
  await f.goto(INV + query);
  await f.page.waitForSelector('#inv-body tbody tr, #inv-body .empty', { timeout: 12000 });
}
/** row menu → "Adjust stock" → wait for the dialog form */
async function openAdjust(f, key) {
  const { page } = f;
  await page.click(MENU_BTN(key));
  await page.click('[role="menu"] button[role="menuitem"]');
  await page.waitForSelector(`${DLG} form[data-adjust]`);
}
async function submitAdjust(f, key, until) {
  await f.page.click(YES);
  return f.until(async () => until(await f.doc(`inventory/${key}`)));
}

export const adminInventoryFlows = [
  {
    name: 'admin inventory: add, remove and count — each change is one batch with its movement and audit entry', as: 'im',
    async run(f) {
      const { page } = f;
      await openInv(f, '?q=TS-001');
      f.eq(await rowCount(page), 1, 'searching by SKU finds the unit');
      f.ok((await text(page, '#inv-body tbody tr')).includes('25'), 'the stock on hand is shown');

      // add
      await openAdjust(f, 'p1');
      await page.fill('#f-qty', '5');
      f.ok((await text(page, '#inv-after')).includes('30'), 'the dialog previews the stock after the change');
      f.ok(await submitAdjust(f, 'p1', (d) => d.stock === 30), 'stock went from 25 to 30');
      let inv = await f.doc('inventory/p1');
      f.eq([inv.stock, inv.reserved], [30, 2], 'the units held by the open order are untouched');
      let moves = await movesOf(f, 'p1');
      f.eq(moves.map((m) => [m.type, m.delta, m.stockAfter, m.refType, m.actorUid]), [['restock', 5, 30, 'manual', 'im']], 'one movement with the actor');
      f.eq(Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'inventory.adjust').map((a) => [a.entityId, a.actorRole, a.before.stock, a.after.stock]), [['p1', 'inventory_manager', 25, 30]], 'and one audit entry');
      await page.waitForFunction(() => document.querySelector('#inv-body tbody tr')?.textContent.includes('30'), null, { timeout: 6000 });

      // remove: wrong numbers are explained in the dialog, nothing is written
      await openAdjust(f, 'p1');
      await page.selectOption('#f-mode', 'remove');
      f.eq(await page.locator('#f-reason option').evaluateAll((o) => o.map((x) => x.value)), ['damage', 'loss', 'correction', 'other'], 'the reasons follow the chosen action');
      await page.fill('#f-qty', '999');
      await page.click(YES);
      await page.waitForSelector('#err-qty:not(:empty)', { timeout: 6000 });
      f.eq((await f.doc('inventory/p1')).stock, 30, 'more than the stock cannot be removed');
      await page.fill('#f-qty', '3');
      await page.selectOption('#f-reason', 'other');
      await page.click(YES);
      await page.waitForSelector('#err-note:not(:empty)', { timeout: 6000 });
      f.eq((await f.doc('inventory/p1')).stock, 30, 'the reason "other" needs a note');
      await page.fill('#f-note', 'Gift to a customer');
      f.ok(await submitAdjust(f, 'p1', (d) => d.stock === 27), 'three units removed');
      moves = await movesOf(f, 'p1');
      f.ok(moves.some((m) => m.type === 'adjust' && m.delta === -3 && m.note === 'Gift to a customer'), 'the note is in the log');

      // count: fewer than the held units gets a warning
      await openAdjust(f, 'p1');
      await page.selectOption('#f-mode', 'set');
      await page.fill('#f-qty', '1');
      await page.waitForFunction(() => document.querySelector('#inv-after')?.classList.contains('text-warn'), null, { timeout: 4000 });
      f.ok(await submitAdjust(f, 'p1', (d) => d.stock === 1), 'a stock count writes the counted number');
      moves = await movesOf(f, 'p1');
      f.ok(moves.some((m) => m.type === 'count' && m.delta === -26 && m.stockAfter === 1), 'the count is logged as a change of −26');
      f.eq((await f.doc('inventory/p1')).reserved, 2, 'a count never touches the held units');
      f.ok(await closed(page), 'the dialog closed');

      // history: newest first, per unit
      await page.click('[data-action="tab"][data-tab="history"]');
      await page.waitForSelector('#inv-body .inv-log tbody tr', { timeout: 8000 });
      f.eq(await page.locator('#inv-body .inv-log tbody tr').count(), 3, 'three movements in the log');
      f.ok((await text(page, '#inv-body .inv-log tbody tr:first-child')).includes('TS-001'), 'newest first, with the SKU');
      await f.goto(`${INV}?tab=history&key=p3__v1`);
      await page.waitForSelector('#inv-body .empty, #inv-body .inv-log', { timeout: 8000 });
      f.eq(await page.locator('#inv-body .inv-log').count(), 0, 'a unit without changes has an empty history');
    },
  },

  {
    name: 'admin inventory: filters from the dashboard links and the editor link', as: 'im',
    async run(f) {
      const { page } = f;
      await openInv(f, '?filter=low');
      f.eq(await rowCount(page), 3, 'low stock: the cap, the wallet and the draft');
      await openInv(f, '?filter=out');
      f.eq(await rowCount(page), 2, 'out of stock: shoes size 42 and the sunglasses');
      await openInv(f, '?filter=untracked');
      f.eq(await rowCount(page), 1, 'not tracked: the phone case');
      await openInv(f, '?q=RS-003');
      f.eq(await rowCount(page), 3, 'a product with variants is one row per variant');
      await openInv(f, '?q=zzzz');
      f.eq(await page.locator('#inv-body .empty').count(), 1, 'nothing matches → a clear message');
      await page.click('[data-action="clear"]');
      await page.waitForFunction(() => document.querySelectorAll('#inv-body tbody tr').length > 5, null, { timeout: 6000 });
      f.ok(!page.url().includes('zzzz'), 'clearing the filters clears the address too');
    },
  },

  {
    name: 'admin inventory: export the sheet, import a counted sheet — preview first, problems are skipped', as: 'sadm',
    async run(f) {
      const { page } = f;
      await openInv(f);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
      const csv = fs.readFileSync(await download.path(), 'utf8');
      f.ok(csv.includes('Key,SKU,Product,Variant,Category,Stock,Reserved,Available,State'), 'the sheet has the expected columns');
      f.ok(/p1,TS-001,Classic Cotton T-Shirt,,[^,\n]*,25,2,23,/.test(csv), 'a row has stock, held and available');
      f.ok(/p3__v1,RS-003-40,Running Shoes,40,/.test(csv), 'variants have their own rows');

      const upload = async (content) => {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="import"]')]);
        await chooser.setFiles({ name: 'count.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
        await page.waitForSelector(`${DLG} .inv-preview`, { timeout: 8000 });
      };
      await upload('SKU,Stock\nTS-001,40\nWL-002,3\nnope-1,5\nPC-004,9\nWA-005,abc\nts-001,41\n');
      const dlg = await text(page, DLG);
      f.eq(await page.locator(`${DLG} .inv-preview tbody tr`).count(), 6, 'every row of the file gets a verdict');
      f.ok(await page.locator(`${DLG} .text-bad`).count() === 4, 'unknown SKU, not tracked, not a number and a duplicate are marked');
      f.ok(dlg.includes('40'), 'the new number is shown next to the old one');
      f.eq((await f.doc('inventory/p1')).stock, 25, 'nothing is written before the person confirms');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('inventory/p1')).stock === 40), 'the one real change was applied');
      f.eq([(await f.doc('inventory/p2')).stock, (await f.doc('inventory/p4')).stock, (await f.doc('inventory/p5')).stock], [3, 0, 50], 'problem rows and unchanged rows were left alone');
      const moves = await movesOf(f, 'p1');
      f.eq(moves.map((m) => [m.type, m.delta, m.stockAfter]), [['count', 15, 40]], 'the count is logged');
      f.eq(Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'inventory.import').length, 1, 'and audited');

      // the same file again: nothing left to do, so there is nothing to apply
      await upload('SKU,Stock\nTS-001,40\n');
      f.eq(await page.locator(`${DLG} .alert-info`).count(), 1, 'the preview says there is nothing to change');
      await page.click(YES);
      f.ok(await closed(page), 'and the button just closes it');
      f.eq((await movesOf(f, 'p1')).length, 1, 'no second movement');

      // a file in the wrong layout is explained
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="import"]')]);
      await chooser.setFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('name,price\nA,1\n') });
      await page.waitForSelector('.toast-bad', { timeout: 6000 });
      f.eq(await page.locator(DLG).count(), 0, 'no dialog for an unusable file');
    },
  },

  {
    name: 'admin inventory: "check holds" finds drift between held stock and open orders and fixes it', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.patch('inventory/p1', 'd.reserved = 9;');
      await f.patch('inventory/p3__v1', 'd.reserved = 4;');
      await openInv(f);
      await page.click('[data-action="recount"]');
      await page.waitForSelector(`${DLG} table`, { timeout: 12000 });
      f.eq(await page.locator(`${DLG} tbody tr`).count(), 2, 'two units disagree with the open orders');
      f.eq((await f.doc('inventory/p1')).reserved, 9, 'nothing is changed until the person confirms');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('inventory/p1')).reserved === 2 && (await f.doc('inventory/p3__v1')).reserved === 0), 'held units follow the open orders');
      f.eq([(await f.doc('inventory/p1')).stock, (await f.doc('inventory/p3__v1')).stock], [25, 10], 'physical stock is never touched');
      f.eq([(await f.doc('inventory/p2')).reserved, (await f.doc('inventory/p5')).reserved], [1, 1], 'units that were right stay as they were');
      const moves = Object.values(await f.docs('inventoryMovements/')).filter((m) => m.type === 'reserve_fix').map((m) => [m.key, m.delta, m.reservedDelta]).sort();
      f.eq(moves, [['p1', 0, -7], ['p3__v1', 0, -4]], 'each correction is logged');
      f.eq(Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'inventory.recount').length, 1, 'and audited');
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 6000 });
      await page.click('[data-action="recount"]');
      await page.waitForSelector(`${DLG} [data-ok]`, { timeout: 12000 });
      f.ok((await text(page, DLG)).length > 10, 'a second check finds everything in order');
    },
  },

  {
    name: 'admin inventory: a product manager can read stock but not change it', as: 'pm',
    async run(f) {
      const { page } = f;
      await openInv(f);
      f.eq(await page.locator('[data-action="export"]').count(), 1, 'the stock sheet can be exported');
      f.eq(await page.locator('[data-action="import"], [data-action="recount"]').count(), 0, 'no import and no hold check');
      await page.click(MENU_BTN('p1'));
      await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 4000 });
      const items = await page.evaluate(() => ({
        buttons: document.querySelectorAll('[role="menu"] button[role="menuitem"]').length,
        links: [...document.querySelectorAll('[role="menu"] a[role="menuitem"]')].map((a) => a.getAttribute('href')),
      }));
      f.eq(items.buttons, 0, 'the row menu has no "adjust" item');
      f.eq(items.links.length, 2, `but it still links to the history and the product (${JSON.stringify(items.links)})`);
    },
  },

  {
    name: 'admin inventory: customer support has no access to stock', as: 'cs',
    async run(f) {
      const { page } = f;
      await f.goto(INV);
      await page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await page.locator('#inv-body').count(), 0, 'the inventory page is not shown');
    },
  },
];
