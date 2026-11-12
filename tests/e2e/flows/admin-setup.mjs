/*
 * Admin "Setup & migration", clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 * The seed is a store that is already in the new structure (8 products, 3 categories, 2 shipping zones, one Super Admin),
 * so the old site's products are put into the mock database first where a scenario needs them (f.put).
 */
import { DLG, YES, text } from './helpers.mjs';

const SETUP = '/admin/#/setup';
const ROWS = '#stp-checks li';
const count = (page, sel) => page.locator(sel).count();
const LEGACY = {
  'products/old1': "({ name: 'Old Hoodie', price: 1200, oldPrice: 1500, category: 'Fashion', image: 'gallery/hoodie.webp', desc: 'Warm and soft', stock: 'In Stock', soldCount: 3, timestamp: '2026-07-01T10:00:00.000Z' })",
  'products/old2': "({ name: 'Old Watch', price: 2500, category: 'Gadgets', stock: 'Out of Stock', timestamp: '2026-07-02T10:00:00.000Z' })",
  'products/old3': "({ name: 'No Price Item', category: 'Gadgets', stock: 'In Stock', timestamp: '2026-07-03T10:00:00.000Z' })",
};
async function openSetup(f) {
  await f.goto(SETUP);
  await f.page.waitForSelector(ROWS, { timeout: 12000 });
}

export const adminSetupFlows = [
  {
    name: 'admin setup: the checklist comes from the real data and points to the page that fixes it', as: 'sa',
    async run(f) {
      const { page } = f;
      await openSetup(f);
      f.eq(await count(page, ROWS), 10, 'ten checks');
      f.eq([await count(page, `${ROWS}.stp-ok`), await count(page, `${ROWS}.stp-warn`), await count(page, `${ROWS}.stp-bad`)], [8, 2, 0], 'eight pass; the invoice address and the single Super Admin are warnings');
      f.eq(await text(page, '#stp-uid'), 'sa', 'the UID is shown');
      f.ok(await page.locator('#stp-checks li.stp-warn a[href$="#/staff"]').count() === 1, 'the Super Admin warning links to Staff');

      // zones are removed behind the app's back: re-checking finds it
      for (const key of Object.keys(await f.docs('shippingZones/'))) await f.remove(key);
      await page.click('[data-action="recheck"]');
      await page.waitForSelector(`${ROWS}.stp-bad`, { timeout: 8000 });
      f.eq(await count(page, `${ROWS}.stp-bad`), 1, 'one problem');
      f.eq(await count(page, `${ROWS}.stp-bad a[href$="#/shipping"]`), 1, 'with a link to Shipping');

      // an old-format product appears: the products check fails and the button jumps to the migration
      await f.put('products/old1', LEGACY['products/old1']);
      await page.click('[data-action="recheck"]');
      await page.waitForFunction(() => document.querySelectorAll('#stp-checks li.stp-bad').length === 2, null, { timeout: 8000 });
      await page.click('#stp-checks [data-action="goto-migrate"]');
      f.ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'mig-preview'), 'the migration button has the focus');

      // copy the UID
      await page.click('[data-action="copy-uid"]');
      await page.waitForSelector('.toast-ok', { timeout: 4000 });
      f.eq(await count(page, '#stp-errors .stp-errors li'), 0, 'no browser problems were logged');
    },
  },

  {
    name: 'admin setup: on a store that is already migrated the preview finds nothing to do', as: 'sa',
    async run(f) {
      const { page } = f;
      await openSetup(f);
      await page.click('[data-action="mig-preview"]');
      await page.waitForSelector('#stp-migrate .alert-ok', { timeout: 10000 });
      f.eq(await count(page, '[data-action="mig-run"]'), 0, 'no "run" button');
      f.eq(Object.keys(await f.docs('coupons/SHOPVERSE')).length, 0, 'and no voucher is invented');
      f.eq(Object.keys(await f.docs('auditLogs/')).length, 0, 'nothing was written');
    },
  },

  {
    name: 'admin setup: migrate the old site — preview, confirm, run; legacy fields stay; a second run does nothing', as: 'sa',
    async run(f) {
      const { page } = f;
      for (const [key, src] of Object.entries(LEGACY)) await f.put(key, src);
      await openSetup(f);
      f.eq(await count(page, `${ROWS}.stp-bad`), 1, 'the checklist already shows the old-format products');

      await page.click('[data-action="mig-preview"]');
      await page.waitForSelector('[data-action="mig-run"]', { timeout: 10000 });
      const preview = await text(page, '#stp-migrate');
      f.ok(preview.includes('3 / 11'), `three of eleven products are converted (${preview.slice(0, 160)})`);
      f.ok(preview.includes('No Price Item'), 'the product without a price is named in the notes');
      f.eq(Object.keys(await f.docs('auditLogs/')).length, 0, 'the preview writes nothing');
      f.eq((await f.doc('products/old1')).status, undefined, 'the product is still in the old format');

      await page.click('[data-action="mig-run"]');
      await page.waitForSelector(YES);
      await page.click(`${DLG} [data-no]`);
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 4000 });
      f.eq((await f.doc('products/old1')).status, undefined, 'declining the question writes nothing');

      await page.click('[data-action="mig-run"]');
      await page.waitForSelector(YES);
      await page.click(YES);
      await page.waitForSelector('#stp-migrate .alert-ok', { timeout: 15000 });

      const old1 = await f.doc('products/old1');
      f.eq([old1.status, old1.type, old1.slug, old1.price, old1.salePrice], ['published', 'simple', 'old-hoodie', 1500, 1200], 'the old price became the regular price, the discounted one the sale price');
      f.eq([old1.desc, old1.image], ['Warm and soft', 'gallery/hoodie.webp'], 'old fields are kept');
      f.eq((await f.doc('products/old3')).status, 'draft', 'a product without a price is imported as a draft');
      f.eq([(await f.doc('inventory/old1')).track, (await f.doc('inventory/old2')).track, (await f.doc('inventory/old2')).stock], [false, true, 0], '"In Stock" has no limit, "Out of Stock" is counted as 0');
      f.eq((await f.doc('slugIndex/old-hoodie')).productId, 'old1', 'slug index');
      f.ok(!!(await f.doc('coupons/SHOPVERSE')), 'the old voucher lives on as a coupon');
      f.eq(Object.values(await f.docs('auditLogs/')).map((a) => [a.action, a.actorUid]), [['migration.v2', 'sa']], 'one audit entry');
      f.eq(await count(page, `${ROWS}.stp-bad`), 0, 'the checklist has no problem left');

      // again: nothing left to do
      await page.click('[data-action="mig-preview"]');
      await page.waitForFunction(() => document.querySelector('#stp-migrate .alert-ok') && !document.querySelector('#stp-migrate [data-action="mig-run"]'), null, { timeout: 10000 });
      f.eq(await count(page, '[data-action="mig-run"]'), 0, 'a second run has nothing to do');
    },
  },

  {
    name: 'admin setup: a Store Admin sees the checklist but cannot migrate', as: 'sadm',
    async run(f) {
      const { page } = f;
      await openSetup(f);
      f.eq(await count(page, '[data-action="mig-preview"], [data-action="mig-run"]'), 0, 'no migration buttons');
      f.ok((await text(page, '#stp-migrate')).length > 40, 'the card explains who can migrate');
      f.eq(await count(page, `${ROWS}.stp-skip`), 1, 'the staff check is "not checked": a Store Admin cannot read the staff list');
      f.eq(await count(page, `${ROWS}.stp-bad`), 0, 'nothing is broken');
    },
  },
];
