/*
 * Admin "Categories" and "Brands", clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   categories: c1 Clothing (top, 1) · c2 Accessories (top, 2) · c3 Watches (under c2)       brands: b1 Nordic · b2 Chronos
 *   products: Clothing has several (a draft among them), Accessories several, Watches one (p5)       brands: b1 has p1 and p2, b2 has p5
 *   roles: sa Super Admin · sadm Store Admin · pm Product Manager (all three write) · om Order Manager (reads only)
 */
import { DLG, YES, text, snap } from './helpers.mjs';

const CATS = '/admin/#/categories';
const BRANDS = '/admin/#/brands';
const MENU = (id) => `[data-action="row-menu"][data-id="${id}"]`;
const FORM = `${DLG} form[data-form="taxonomy"]`;
const ROWS = '#tax-table tbody tr';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const closed = (page) => page.waitForSelector(DLG, { state: 'detached', timeout: 8000 }).then(() => true, () => false);
const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const audits = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => /^(category|brand)\./.test(a.action))
  .map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(byJson);
const calm = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((el) => el.remove()));
const errorOf = (page, field) => text(page, `#err-${field}`);
const wait = (page, fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 8000 });
const rowCount = (page, n) => wait(page, (k) => document.querySelectorAll('#tax-table tbody tr').length === k, n);
const names = (page) => page.locator(`${ROWS} .t`).allInnerTexts();

async function open(f, url = CATS) {
  await f.goto(url);
  await f.page.waitForSelector(ROWS, { timeout: 12000 });
}
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
async function upload(page, name = 'photo.png') {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(`${FORM} [data-img="pick"]`)]);
  await chooser.setFiles({ name, mimeType: 'image/png', buffer: PNG });
  await wait(page, () => /^https:\/\/mock-storage\.test\//.test(document.querySelector('input[name="image"]')?.value || ''));
}

export const adminTaxonomyFlows = [
  {
    name: 'admin categories: a tree with product counts, status and the right menu for each row; search; the arrows stop at the ends', as: 'pm',
    async run(f) {
      const { page } = f;
      await open(f);
      f.eq(await names(page), ['Clothing', 'Accessories', 'Watches'], 'top level first, each sub-category right under its parent');
      f.eq(await page.locator(`${ROWS}.tax-child`).count(), 1, 'Watches is indented');
      const inCat = async (id) => Object.values(await f.docs('products/')).filter((p) => p.categoryId === id).length;
      const shown = async (i) => Number((await page.locator(ROWS).nth(i).locator('td').nth(1).innerText()).match(/\d+/)?.[0]);
      f.eq([await shown(0), await shown(1), await shown(2)], [await inCat('c1'), await inCat('c2'), await inCat('c3')], 'each row counts the products of its category (drafts included)');
      f.ok((await inCat('c1')) >= 3 && (await inCat('c3')) === 1, 'and the seed really has several in Clothing and one in Watches');
      f.eq(await page.locator(`${ROWS} .badge-ok`).count(), 3, 'all three are visible');
      f.eq(await menuItems(f, 'c1'), 3, 'Clothing: edit, add sub-category, hide — no delete, products use it');
      await page.keyboard.press('Escape');
      f.eq(await menuItems(f, 'c3'), 2, 'Watches: edit, hide — no sub-category under a sub-category, no delete');
      await page.keyboard.press('Escape');
      f.eq(await menuItems(f, 'c2'), 3, 'Accessories: edit, add sub-category, hide');
      await page.keyboard.press('Escape');
      const arrow = (id, dir) => page.locator(`[data-action="move"][data-id="${id}"][data-dir="${dir}"]`);
      f.eq([await arrow('c1', 'up').isDisabled(), await arrow('c1', 'down').isDisabled()], [true, false], 'the first top-level category cannot go up');
      f.eq([await arrow('c2', 'up').isDisabled(), await arrow('c2', 'down').isDisabled()], [false, true], 'the last cannot go down');
      f.eq([await arrow('c3', 'up').isDisabled(), await arrow('c3', 'down').isDisabled()], [true, true], 'the only sub-category cannot move at all');
      await snap(f, 'taxonomy-list');
      await page.fill('#q', 'watch');
      await rowCount(page, 1);
      f.eq(await names(page), ['Watches'], 'the search finds Watches');
      f.eq(await page.locator('[data-action="move"]').count(), 0, 'while searching there are no arrows (the order would be misleading)');
      await page.fill('#q', 'zzz nothing');
      await page.waitForSelector('#tax-table', { state: 'detached', timeout: 6000 });
      await page.fill('#q', '');
      await rowCount(page, 3);
      f.eq(await audits(f), [], 'looking changes nothing');
    },
  },
  {
    name: 'admin categories: create one with an uploaded image — stored exactly, listed with its picture, audited; then remove the image', as: 'sadm',
    async run(f) {
      const { page } = f;
      await open(f);
      await page.click('[data-action="add"]');
      await page.waitForSelector(FORM);
      f.eq(await page.locator('#f-parentId option').count(), 3, 'none + the two top-level categories (not Watches)');
      f.eq(await page.locator(`${FORM} [data-img="clear"]`).evaluate((el) => el.hidden), true, 'nothing to remove yet');
      await page.fill('#f-name', '  Shoes   & Boots ');
      await page.fill('#f-description', 'Everything for the feet');
      await upload(page);
      f.eq(await page.locator(`${FORM} [data-img-box] img`).count(), 1, 'the preview shows the upload');
      f.eq(await page.locator(`${FORM} [data-img="clear"]`).evaluate((el) => el.hidden), false, 'and it can be removed');
      await snap(f, 'taxonomy-new');
      await page.click(YES);
      f.ok(await closed(page), 'created');
      const entries = Object.entries(await f.docs('categories/')).map(([k, v]) => [k.replace(/^categories\//, ''), v]).filter(([id]) => !['c1', 'c2', 'c3'].includes(id));
      f.eq(entries.length, 1, 'one new category');
      const [id, c] = entries[0];
      f.ok(/^shoes/.test(id) && /^[a-z0-9-]+$/.test(id), 'the id is made from the name');
      f.eq([c.name, c.slug, c.parentId, c.description, c.visible, c.sort, c.icon], ['Shoes & Boots', id, null, 'Everything for the feet', true, 3, ''], 'the fields as entered; it goes last');
      f.ok(/^https:\/\/mock-storage\.test\//.test(c.image) && /^site\/categories\/[\w.-]+$/.test(c.imagePath), 'the image link and its storage path');
      f.eq(Object.keys(c).sort(), ['createdAt', 'description', 'icon', 'image', 'imagePath', 'name', 'parentId', 'slug', 'sort', 'updatedAt', 'visible'], 'and nothing else');
      await rowCount(page, 4);
      f.eq((await names(page)).at(-1), 'Shoes & Boots', 'listed last');
      f.eq(await page.locator(`${ROWS} .tax-thumb img`).count(), 1, 'with its picture');
      f.eq(await audits(f), [['category.create', id, 'sadm', 'store_admin']], 'one audit entry');

      await pickMenu(f, id, 0);
      await page.waitForSelector(FORM);
      f.eq(await page.inputValue('#f-name'), 'Shoes & Boots', 'the form shows what was saved');
      f.eq(await page.locator(`${FORM} [data-img-box] img`).count(), 1, 'with the image');
      await page.click(`${FORM} [data-img="clear"]`);
      f.eq(await page.locator(`${FORM} [data-img-box] img`).count(), 0, 'removed from the form');
      await page.click(YES);
      f.ok(await closed(page));
      const after = await f.doc(`categories/${id}`);
      f.eq([after.image, after.imagePath], ['', ''], 'the image is gone');
      f.eq(await page.locator(`${ROWS} .tax-thumb img`).count(), 0, 'and from the list');
      f.eq((await audits(f)).map((a) => a[0]), ['category.create', 'category.update'], 'the change was audited');
    },
  },
  {
    name: 'admin categories: every rule shows its message next to the field and nothing is saved', as: 'pm',
    async run(f) {
      const { page } = f;
      await open(f);
      await page.click('[data-action="add"]');
      await page.waitForSelector(FORM);
      await page.click(YES);
      await wait(page, () => (document.querySelector('#err-name')?.textContent.length || 0) > 3);
      f.ok((await errorOf(page, 'name')).length > 3, 'a name is required');
      await page.fill('#f-name', ' clothing ');
      await page.click(YES);
      await wait(page, () => (document.querySelector('#err-name')?.textContent.length || 0) > 3);
      f.ok((await errorOf(page, 'name')).length > 3, 'a name that exists is refused (ignoring case and spaces)');
      await page.fill('#f-name', 'Bags');
      await page.fill('#f-slug', 'Bad Slug!');
      await page.click(YES);
      await wait(page, () => (document.querySelector('#err-slug')?.textContent.length || 0) > 3);
      f.eq(await errorOf(page, 'name'), '', 'the valid name shows no message');
      f.ok((await errorOf(page, 'slug')).length > 3, 'a link with spaces and punctuation is refused');
      await page.fill('#f-slug', 'accessories');
      await page.click(YES);
      await wait(page, () => /taken|আগে|ব্যবহার/.test(document.querySelector('#err-slug')?.textContent || ''));
      f.ok((await errorOf(page, 'slug')).length > 3, 'a link that another category uses is refused');
      f.eq(await page.locator(DLG).count(), 1, 'the dialog stays open');
      f.eq(Object.keys(await f.docs('categories/')).length, 3, 'nothing saved');
      await page.fill('#f-slug', '');
      await page.click(YES);
      f.ok(await closed(page), 'an empty link is made from the name');
      const bags = Object.values(await f.docs('categories/')).find((c) => c.name === 'Bags');
      f.eq(bags.slug, 'bags', 'bags');
    },
  },
  {
    name: 'admin categories: sub-category from the row menu, moving a category under another, and the parent lock', as: 'sa',
    async run(f) {
      const { page } = f;
      await open(f);
      await pickMenu(f, 'c2', 1);
      await page.waitForSelector(FORM);
      f.eq(await page.inputValue('#f-parentId'), 'c2', 'the parent is preselected');
      await page.fill('#f-name', 'Straps');
      await page.click(YES);
      f.ok(await closed(page));
      const straps = Object.entries(await f.docs('categories/')).find(([, c]) => c.name === 'Straps');   // [path, doc]
      f.eq([straps[1].parentId, straps[1].sort], ['c2', 2], 'a child of Accessories, after Watches');
      await rowCount(page, 4);
      f.eq(await page.locator(`${ROWS}.tax-child`).count(), 2, 'two indented rows');

      await pickMenu(f, 'c2', 0);
      await page.waitForSelector(FORM);
      f.eq(await page.locator('#f-parentId').isDisabled(), true, 'Accessories has sub-categories, so it cannot go under another category');
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page));

      await pickMenu(f, 'c1', 0);
      await page.waitForSelector(FORM);
      await page.selectOption('#f-parentId', 'c2');
      await page.click(YES);
      f.ok(await closed(page));
      const c1 = await f.doc('categories/c1');
      f.eq([c1.parentId, c1.sort], ['c2', 3], 'Clothing is now the third child of Accessories');
      await rowCount(page, 4);
      f.eq(await page.locator(`${ROWS}.tax-child`).count(), 3, 'three indented rows');
      f.eq((await audits(f)).map((a) => a[0]).sort(), ['category.create', 'category.update'], 'both changes audited');
    },
  },
  {
    name: 'admin categories: renaming copies the new name into the products; brands too', as: 'pm',
    async run(f) {
      const { page } = f;
      const stamp0 = (await f.doc('meta/catalog'))?.version ?? 0;
      await open(f);
      await pickMenu(f, 'c1', 0);
      await page.waitForSelector(FORM);
      f.ok((await text(page, '#hint-name')).length > 5, 'the dialog says the products will be updated');
      await page.fill('#f-name', 'Apparel');
      await page.click(YES);
      f.ok(await closed(page), 'saved');
      f.eq((await f.doc('categories/c1')).name, 'Apparel');
      for (const id of ['p1', 'p6', 'pd']) f.eq((await f.doc(`products/${id}`)).categoryName, 'Apparel', `${id} carries the new name`);
      for (const id of ['p2', 'p4', 'p5', 'p7']) f.ok(['Accessories', 'Watches'].includes((await f.doc(`products/${id}`)).categoryName), `${id} is untouched`);
      f.eq([(await f.doc('products/p1')).name, (await f.doc('products/p1')).price], ['Classic Cotton T-Shirt', 1200], 'and nothing else on the product changed');
      f.ok(((await f.doc('meta/catalog'))?.version ?? 0) > stamp0, 'the catalog stamp moved, so shops fetch the new names');
      f.eq(await audits(f), [['category.update', 'c1', 'pm', 'product_manager']], 'one audit entry');

      await open(f, BRANDS);
      f.eq(await names(page), ['Chronos', 'Nordic'], 'brands are A–Z');
      await pickMenu(f, 'b1', 0);
      await page.waitForSelector(FORM);
      f.eq(await page.locator('#f-parentId').count(), 0, 'a brand has no parent');
      await page.fill('#f-name', 'Nordic Co');
      await page.click(YES);
      f.ok(await closed(page));
      for (const id of ['p1', 'p2']) f.eq((await f.doc(`products/${id}`)).brandName, 'Nordic Co', `${id} carries the new brand name`);
      f.eq((await f.doc('products/p5')).brandName, 'Chronos', 'other brands untouched');
      f.eq((await audits(f)).map((a) => a[0]).sort(), ['brand.update', 'category.update']);
    },
  },
  {
    name: 'admin categories: hide / show (a hidden parent hides its children), move up and down with the keyboard kept in place, delete only what is unused', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.put('categories/tmp', `({ name: 'Temporary', slug: 'temporary', parentId: null, image: '', imagePath: '', icon: '', description: '', sort: 3, visible: true, createdAt: new Ts(Date.now()), updatedAt: new Ts(Date.now()) })`);
      await f.put('categories/held', `({ name: 'Held back', slug: 'held-back', parentId: null, image: '', imagePath: '', icon: '', description: '', sort: 4, visible: true, createdAt: new Ts(Date.now()), updatedAt: new Ts(Date.now()) })`);
      await f.put('coupons/HELD10', `({ code: 'HELD10', type: 'percent', value: 10, maxDiscount: null, minOrder: 0, appliesTo: 'categories', productIds: [], categoryIds: ['held'], excludeSaleItems: false, startsAt: null, endsAt: null, usageLimit: null, usedCount: 0, perCustomerLimit: null, customerIds: [], active: true, description: '', createdAt: new Ts(Date.now()), updatedAt: new Ts(Date.now()) })`);
      await open(f);
      await rowCount(page, 5);

      await pickMenu(f, 'c2', 2);
      f.ok(await f.until(async () => (await f.doc('categories/c2')).visible === false), 'Accessories hidden');
      await wait(page, () => document.querySelectorAll('#tax-table tbody .badge:not(.badge-ok)').length === 2);
      f.eq(await page.locator(`${ROWS} .badge:not(.badge-ok)`).count(), 2, 'Accessories and, with it, Watches');
      await pickMenu(f, 'c2', 2);
      f.ok(await f.until(async () => (await f.doc('categories/c2')).visible === true), 'and shown again');
      await wait(page, () => document.querySelectorAll('#tax-table tbody .badge:not(.badge-ok)').length === 0);

      await calm(page);
      await page.click('[data-action="move"][data-id="c1"][data-dir="down"]');
      f.ok(await f.until(async () => (await f.doc('categories/c1')).sort === 2 && (await f.doc('categories/c2')).sort === 1), 'Clothing and Accessories swapped');
      await wait(page, () => /^(Accessories|ঐ)/.test(document.querySelector('#tax-table tbody tr .t')?.textContent || '') || document.querySelector('#tax-table tbody tr .t')?.textContent === 'Accessories');
      f.eq((await names(page)).slice(0, 3), ['Accessories', 'Watches', 'Clothing'], 'the list follows');
      f.ok(await page.evaluate(() => document.activeElement?.matches('[data-action="move"]')), 'the focus is still on an arrow button');

      f.eq(await menuItems(f, 'tmp'), 4, 'an unused category: edit, add sub-category, hide, delete');
      await page.locator('[role="menu"] [role="menuitem"]').nth(3).click();
      await page.waitForSelector(`${DLG} [data-no]`);
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page));
      f.ok(!!(await f.doc('categories/tmp')), 'cancel keeps it');
      await pickMenu(f, 'tmp', 3);
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(`${DLG} [data-yes]`);
      f.ok(await f.until(async () => !(await f.doc('categories/tmp'))), 'deleted');
      await rowCount(page, 4);

      await pickMenu(f, 'held', 3);
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(`${DLG} [data-yes]`);
      await page.waitForSelector('#toasts .toast-bad', { timeout: 6000 });
      f.ok((await text(page, '#toasts .toast-bad')).includes('HELD10'), 'a coupon limited to the category stops the delete and is named');
      f.ok(!!(await f.doc('categories/held')), 'the category is still there');
      f.eq((await audits(f)).map((a) => a[0]).sort(), ['category.delete', 'category.hide', 'category.reorder', 'category.show'], 'every change audited, the refused delete not');
    },
  },
  {
    name: 'admin brands: create with a logo, delete only an unused brand; an Order Manager can only look', as: 'sadm',
    async run(f) {
      const { page } = f;
      await open(f, BRANDS);
      await page.click('[data-action="add"]');
      await page.waitForSelector(FORM);
      await page.fill('#f-name', 'Acme');
      await upload(page, 'logo.png');
      await page.click(YES);
      f.ok(await closed(page));
      const acme = Object.entries(await f.docs('brands/')).map(([k, v]) => [k.replace(/^brands\//, ''), v]).find(([, b]) => b.name === 'Acme');
      f.ok(!!acme, 'created');
      f.ok(/^https:\/\/mock-storage\.test\//.test(acme[1].logo) && /^site\/brands\//.test(acme[1].logoPath), 'the logo is stored as logo / logoPath');
      f.eq(Object.keys(acme[1]).sort(), ['createdAt', 'description', 'logo', 'logoPath', 'name', 'slug', 'updatedAt', 'visible'], 'exactly the brand fields');
      await rowCount(page, 3);
      f.eq(await names(page), ['Acme', 'Chronos', 'Nordic'], 'A–Z');
      f.eq(await menuItems(f, 'b2'), 2, 'Chronos has a product: edit, hide — no delete');
      await page.keyboard.press('Escape');
      await pickMenu(f, acme[0], 2);
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(`${DLG} [data-yes]`);
      f.ok(await f.until(async () => !(await f.doc(`brands/${acme[0]}`))), 'the unused brand is deleted');
      f.eq((await audits(f)).map((a) => a[0]).sort(), ['brand.create', 'brand.delete']);
    },
  },
  ...['categories', 'brands'].map((what) => ({
    name: `admin ${what}: an Order Manager can look at the list but not change it`, as: 'om',
    async run(f) {
      const { page } = f;
      await open(f, what === 'brands' ? BRANDS : CATS);
      f.eq(await page.locator('[data-action="add"]').count(), 0, 'no "new" button');
      f.eq(await page.locator('[data-action="row-menu"], [data-action="move"]').count(), 0, 'no row menu, no arrows');
      f.eq(await page.locator('.alert-info').count(), 1, 'a note explains why');
      f.ok((await page.locator(ROWS).count()) >= 2, 'the list is there');
      f.eq(await audits(f), [], 'nothing changed');
    },
  })),
];
