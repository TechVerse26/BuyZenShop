/*
 * Admin product management, clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   p1 Classic Cotton T-Shirt  simple, stock 25, 2 reserved by an open order      p3 Running Shoes   variable, sizes 40/41/42 (v1–v3)
 *   p7 Sold Out Sunglasses     published, stock 0                                 pd Draft Product   draft, stock 5, nothing reserved
 * Staff: sa Super Admin · sadm Store Admin · pm Product Manager (cannot adjust stock) · om Order Manager · cs Customer Support.
 * After every action the mock database is inspected (product, inventory, slug / SKU index, stock movements, cost data, audit log).
 */
import { DLG, YES, text } from './helpers.mjs';

/** a real 1×1 PNG; the editor decodes, resizes and re-encodes it exactly as it would a photo */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const NEW = '/admin/#/products/new';
const EDIT = (id) => `/admin/#/products/${id}`;
const SAVE = '#pe-form button[type="submit"]';
const ROW = '#pe-variants tbody tr';
const tsMs = (v) => (v && (v.__ts ?? v.ms)) ?? null;

const topLevel = async (f, prefix) => Object.entries(await f.docs(prefix)).filter(([k]) => k.split('/').length === 2);
const productByName = async (f, name) => (await topLevel(f, 'products/')).find(([, p]) => p.name === name);
const idOf = ([path]) => path.split('/')[1];
const sorted = (a) => [...a].sort();

async function openEditor(f, path) {
  await f.goto(path);
  await f.page.waitForSelector('#pe-form', { timeout: 12000 });
}
/** click "save" on a new product and wait until the editor has moved on to the saved product's own page */
async function saveNew(f, name) {
  await f.page.click(SAVE);
  await f.page.waitForFunction((n) => /^#\/products\/(?!new([?]|$))[^/?]+$/.test(location.hash) && document.querySelector('#pe-page h1')?.textContent.trim() === n, name, { timeout: 12000 });
}
/** click "save" on an existing product; resolves once the editor has re-mounted with the stored values (the dirty marker is gone) */
async function saveEdit(f) {
  await f.page.click(SAVE);
  await f.page.waitForFunction(() => document.querySelector('#pe-dirty') && document.querySelector('#pe-dirty').textContent.trim() === '' && !document.querySelector('.toast-bad'), null, { timeout: 12000 });
  await f.page.waitForTimeout(150);
}
/** type into an option field and leave it (the editor reacts on "change") */
async function setOption(page, i, name, values) {
  await page.fill(`#opt-name-${i}`, name);
  await page.press(`#opt-name-${i}`, 'Tab');
  await page.fill(`#opt-values-${i}`, values);
  await page.press(`#opt-values-${i}`, 'Tab');
}
const rows = (page) => page.locator(ROW).count();
const waitRows = (page, n) => page.waitForFunction(([sel, k]) => document.querySelectorAll(sel).length === k, [ROW, n], { timeout: 6000 });

export const adminProductFlows = [
  {
    name: 'admin products: create a simple product — slug follows the name, stock, indexes, cost and audit land together', as: 'sadm',
    async run(f) {
      const { page } = f;
      await openEditor(f, NEW);
      const stampBefore = JSON.stringify(await f.doc('meta/catalog'));
      await page.fill('#f-name', 'Test Mug');
      f.eq(await page.inputValue('#f-slug'), 'test-mug', 'the slug follows the name while it has not been touched');
      await page.selectOption('#f-categoryId', 'c2');
      await page.selectOption('#f-brandId', 'b1');
      await page.selectOption('#f-status', 'published');
      await page.fill('#f-price', '750');
      await page.fill('#f-salePrice', '600');
      await page.fill('#f-saleStart', '2026-12-01T10:00');
      await page.fill('#f-saleEnd', '2026-12-05T18:30');
      await page.fill('#f-sku', 'MUG-001');
      await page.fill('#f-stock', '12');
      await page.fill('#f-maxPerOrder', '4');
      await page.fill('#f-shortDescription', 'A sturdy ceramic mug.');
      await page.fill('#f-description', '## Details\n\n- Holds 350 ml');
      await page.fill('#f-highlights', 'Dishwasher safe\n\nHolds 350 ml');
      await page.fill('#f-tags', 'Mug, kitchen, MUG');
      await page.fill('#f-costPrice', '300');
      await page.fill('#f-supplier', 'Dhaka Ceramics');
      await saveNew(f, 'Test Mug');

      const entry = await productByName(f, 'Test Mug');
      f.ok(!!entry, 'the product document exists');
      if (!entry) return;
      const id = idOf(entry);
      const p = entry[1];
      const cat = await f.doc('categories/c2');
      const brand = await f.doc('brands/b1');
      f.eq([p.slug, p.status, p.type, p.price, p.salePrice, p.sku], ['test-mug', 'published', 'simple', 750, 600, 'MUG-001'], 'name, address, status, prices and SKU are stored');
      f.eq([p.categoryId, p.categoryName, p.brandId, p.brandName], ['c2', cat.name, 'b1', brand.name], 'category and brand are stored with their display names');
      f.eq([p.shortDescription, p.highlights, p.tags], ['A sturdy ceramic mug.', ['Dishwasher safe', 'Holds 350 ml'], ['mug', 'kitchen']], 'blank lines are dropped from the highlights and duplicate tags are merged');
      f.eq([p.soldCount, p.ratingCount, p.ratingAvg], [0, 0, 0], 'a new product starts with zero sales and no rating');
      f.eq([tsMs(p.saleStart), tsMs(p.saleEnd)], [Date.UTC(2026, 11, 1, 4, 0), Date.UTC(2026, 11, 5, 12, 30)], 'sale dates typed as Bangladesh time are stored as the right instants');

      const inv = await f.doc(`inventory/${id}`);
      f.eq([inv.productId, inv.price, inv.salePrice, inv.stock, inv.reserved, inv.track, inv.maxPerOrder, inv.sku, inv.active], [id, 750, 600, 12, 0, true, 4, 'MUG-001', true], 'the inventory document carries the trusted price and the starting stock');
      f.eq((await f.doc('slugIndex/test-mug')).productId, id, 'the slug index points at the product');
      const sku = await f.doc('skuIndex/MUG-001');
      f.eq([sku.productId, sku.variantId], [id, null], 'the SKU index points at the product');
      f.eq((await f.doc(`productPrivate/${id}`)).costPrice, 300, 'the cost price is in the staff-only document');
      f.ok(!('costPrice' in p), 'and not in the public product');
      const moves = Object.values(await f.docs('inventoryMovements/')).filter((m) => m.productId === id);
      f.eq(moves.map((m) => [m.type, m.delta, m.stockAfter]), [['initial', 12, 12]], 'the starting stock is logged as one movement');
      f.ok(JSON.stringify(await f.doc('meta/catalog')) !== stampBefore, 'the catalog version moved so storefront caches refresh');
      const audit = Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'product.create' && a.entityId === id);
      f.eq(audit.map((a) => [a.actorUid, a.actorRole]), [['sadm', 'store_admin']], 'the audit log names the actor and the role');

      // the new page is the product's own editor now
      f.eq(await page.locator('#f-type').count(), 0, 'the product type is fixed after creation');
      f.ok((await text(page, '#pe-form')).length > 100, 'the saved product opens in the editor');

      // and it is live in the store
      await f.goto('/product/test-mug');
      await page.waitForSelector('h1', { timeout: 12000 });
      f.ok((await text(page, 'h1')).includes('Test Mug'), 'the storefront shows the new product');
      f.ok((await text(page, '#main')).includes('600'), 'at its sale price');
    },
  },

  {
    name: 'admin products: validation — nothing is written until every field is right', as: 'pm',
    async run(f) {
      const { page } = f;
      await openEditor(f, NEW);
      const before = (await topLevel(f, 'products/')).length;

      await page.click(SAVE);
      await page.waitForSelector('#err-name:not(:empty)', { timeout: 6000 });
      f.ok((await text(page, '#err-name')).length > 3, 'a missing name is reported under the field');
      f.ok((await text(page, '#err-price')).length > 3, 'a missing price is reported under the field');
      f.ok(page.url().includes('products/new'), 'the editor stays where it is');

      await page.fill('#f-name', 'Another Shirt');
      await page.fill('#f-slug', 'classic-cotton-t-shirt');
      await page.fill('#f-price', '100');
      await page.fill('#f-salePrice', '150');
      await page.fill('#f-sku', 'ts-001');
      await page.click(SAVE);
      await page.waitForSelector('#err-slug:not(:empty)', { timeout: 6000 });
      f.ok((await text(page, '#err-slug')).length > 3, 'an address that another product uses is refused');
      f.ok((await text(page, '#err-sku')).length > 3, 'a SKU another product uses is refused, whatever its letter case');
      f.ok((await text(page, '#err-salePrice')).length > 3, 'a sale price that is not below the price is refused');
      f.eq((await topLevel(f, 'products/')).length, before, 'no product was written');
      f.eq(Object.keys(await f.docs('slugIndex/')).includes('slugIndex/another-shirt'), false, 'and no index entry either');

      await page.fill('#f-slug', 'Another  Shirt!!');                     // typed carelessly: the editor tidies it into a valid address
      await page.fill('#f-salePrice', '80');
      await page.fill('#f-sku', 'TS-002');
      await page.fill('#f-stock', '4');
      await saveNew(f, 'Another Shirt');
      const entry = await productByName(f, 'Another Shirt');
      f.ok(!!entry, 'once the fields are right the product is saved');
      if (entry) f.eq([entry[1].slug, entry[1].price, entry[1].salePrice, entry[1].status], ['another-shirt', 100, 80, 'draft'], 'with a tidied address, as a draft by default');
      // a product manager cannot adjust stock, so no movement is logged — the editor must not even try (the rules would refuse it)
      f.eq(Object.values(await f.docs('inventoryMovements/')).filter((m) => entry && m.productId === idOf(entry)).length, 0, 'a role without stock rights writes no stock movement');
    },
  },

  {
    name: 'admin products: variable product — options become variants, errors are listed, switched-off variants stay', as: 'sadm',
    async run(f) {
      const { page } = f;
      await openEditor(f, NEW);
      await page.fill('#f-name', 'Hoodie');
      await page.selectOption('#f-type', 'variable');
      await page.waitForSelector('#pe-variants');
      f.eq(await page.inputValue('#f-name'), 'Hoodie', 'switching the type keeps what was typed');
      f.eq(await page.locator('#f-price').count(), 0, 'a product with variants has no single price field');

      await page.click('[data-action="optAdd"]');
      await setOption(page, 0, 'Size', 'S, M, L');
      await waitRows(page, 3);
      await page.click('[data-action="optAdd"]');
      await setOption(page, 1, 'Colour', 'Black, White, Black');
      await waitRows(page, 6);
      f.eq(await rows(page), 6, 'every combination of size and colour has a variant row (duplicate values are merged)');

      await page.click(SAVE);
      await page.waitForSelector('#pe-variants-err .alert', { timeout: 6000 });
      f.ok((await page.locator('#pe-variants-err li').count()) >= 6, 'a missing price is listed for each variant');
      f.eq(await page.locator('#pe-variants [aria-invalid="true"]').count(), 6, 'and each price field is marked');
      f.ok(!(await productByName(f, 'Hoodie')), 'nothing was saved');

      const prices = page.locator('#pe-variants input[data-k="price"]');
      const stocks = page.locator('#pe-variants input[data-k="stock"]');
      for (let i = 0; i < 6; i++) { await prices.nth(i).fill(String(2000 + i * 100)); await stocks.nth(i).fill('5'); }
      await page.locator('#pe-variants input[data-k="sku"]').first().fill('HOOD-S-BLK');
      await page.locator(`${ROW}:nth-child(6) [data-change="vActive"]`).uncheck();
      await saveNew(f, 'Hoodie');

      const entry = await productByName(f, 'Hoodie');
      f.ok(!!entry, 'the product was saved');
      if (!entry) return;
      const id = idOf(entry);
      const p = entry[1];
      f.eq([p.type, p.slug, p.variants.length, p.variants.filter((v) => v.active).length], ['variable', 'hoodie', 6, 5], 'six variants, one of them switched off');
      f.eq(p.price, 2000, 'the product price is the cheapest variant that is on sale');
      f.eq(p.options.map((o) => [o.name, o.values]), [['Size', ['S', 'M', 'L']], ['Colour', ['Black', 'White']]], 'options are stored without duplicates');
      const inv = Object.entries(await f.docs(`inventory/${id}__`));
      f.eq(inv.length, 6, 'one inventory document per variant');
      f.eq(sorted(inv.map(([, d]) => d.price)), [2000, 2100, 2200, 2300, 2400, 2500], 'each variant has its own trusted price');
      f.eq(inv.filter(([, d]) => d.active === false).length, 1, 'the switched-off variant is inactive in inventory too');
      f.eq((await f.doc('skuIndex/HOOD-S-BLK')).productId, id, 'a variant SKU is indexed');
      f.eq(await rows(page), 6, 'the saved product shows the same six variants');
      f.eq(await page.locator('#pe-variants input[data-k="stock"]').count(), 0, 'stock of saved variants is shown, not edited here');
    },
  },

  {
    name: 'admin products: edit a variable product — new variant added, removed value switches its variant off, stock untouched', as: 'pm',
    async run(f) {
      const { page } = f;
      const before = Object.fromEntries(Object.entries(await f.docs('inventory/p3__')).map(([k, d]) => [k.split('/')[1], d]));
      await openEditor(f, EDIT('p3'));
      await waitRows(page, 3);
      f.eq(await page.locator('#pe-variants input[data-k="stock"]').count(), 0, 'existing variants do not offer a stock field');
      f.eq(await page.locator('#f-type').count(), 0, 'the type cannot be changed');

      await page.fill('#opt-values-0', '40, 41, 42, 43');
      await page.press('#opt-values-0', 'Tab');
      await waitRows(page, 4);
      f.eq(await page.locator('#pe-variants input[data-k="stock"]').count(), 1, 'only the new variant takes a starting stock');
      await page.locator('#pe-variants input[data-k="price"]').last().fill('3000');
      await page.locator('#pe-variants input[data-k="stock"]').last().fill('7');

      // take a size out and put it back: the variant is switched off, then on again
      await page.fill('#opt-values-0', '41, 42, 43');
      await page.press('#opt-values-0', 'Tab');
      await waitRows(page, 4);
      f.eq(await page.locator(`${ROW}:nth-child(1) [data-change="vActive"]`).isChecked(), false, 'a size that is no longer offered is switched off');
      await page.fill('#opt-values-0', '40, 41, 42, 43');
      await page.press('#opt-values-0', 'Tab');
      await waitRows(page, 4);
      f.eq(await page.locator(`${ROW}:nth-child(1) [data-change="vActive"]`).isChecked(), true, 'typing it back switches it on again');
      await page.fill('#opt-values-0', '41, 42, 43');
      await page.press('#opt-values-0', 'Tab');
      await waitRows(page, 4);
      await saveEdit(f);

      const p = await f.doc('products/p3');
      f.eq(p.variants.length, 4, 'the product has four variants — the old ones are never deleted');
      f.eq(p.variants.filter((v) => !v.active).map((v) => v.id), ['v1'], 'only the size that was taken out is off');
      const now = Object.fromEntries(Object.entries(await f.docs('inventory/p3__')).map(([k, d]) => [k.split('/')[1], d]));
      f.eq(Object.keys(now).length, 4, 'the new variant has an inventory document');
      for (const k of ['p3__v1', 'p3__v2', 'p3__v3']) f.eq([now[k].stock, now[k].reserved], [before[k].stock, before[k].reserved], `stock and reservation of ${k} are exactly as before`);
      f.eq(now.p3__v1.active, false, 'the inventory document of the switched-off variant is inactive');
      const fresh = Object.entries(now).find(([k]) => !before[k]);
      f.eq([fresh[1].stock, fresh[1].price, fresh[1].active], [7, 3000, true], 'the new variant has its starting stock and price');
      f.eq(p.price, 2900, 'the product price is the cheapest variant still on sale');
      f.eq(Object.values(await f.docs('inventoryMovements/')).filter((m) => m.productId === 'p3').length, 0, 'a role without stock rights writes no stock movement');
    },
  },

  {
    name: 'admin products: edit a simple product — price and name change, stock and reservation are left alone', as: 'sadm',
    async run(f) {
      const { page } = f;
      const inv0 = await f.doc('inventory/p1');
      const moves0 = Object.keys(await f.docs('inventoryMovements/')).length;
      await openEditor(f, EDIT('p1'));
      f.eq(await page.inputValue('#f-slug'), 'classic-cotton-t-shirt', 'the stored address is shown');
      f.eq(await page.locator('#f-stock').count(), 0, 'the stock of an existing product is not an input here');
      f.ok((await text(page, '#pe-form')).includes(String(inv0.stock)), 'the current stock is shown');
      await page.fill('#f-name', 'Classic Cotton Tee');
      f.eq(await page.inputValue('#f-slug'), 'classic-cotton-t-shirt', 'renaming an existing product does not move its address');
      await page.fill('#f-price', '1100');
      await page.fill('#f-salePrice', '900');
      await saveEdit(f);

      let p = await f.doc('products/p1');
      f.eq([p.name, p.slug, p.price, p.salePrice], ['Classic Cotton Tee', 'classic-cotton-t-shirt', 1100, 900], 'the product document has the new values');
      const inv = await f.doc('inventory/p1');
      f.eq([inv.price, inv.salePrice], [1100, 900], 'the trusted price in inventory follows');
      f.eq([inv.stock, inv.reserved], [inv0.stock, inv0.reserved], 'stock and the units held by the open order did not change');
      f.eq(Object.keys(await f.docs('inventoryMovements/')).length, moves0, 'no stock movement was written');
      f.eq(await page.inputValue('#f-price'), '1100', 'the editor shows what was stored');
      f.ok(Object.values(await f.docs('auditLogs/')).some((a) => a.action === 'product.update' && a.entityId === 'p1' && a.before.price === 1200 && a.after.price === 1100), 'the audit log keeps the old and the new price');

      // change the address: the index moves with it
      await page.fill('#f-slug', 'classic-tee');
      await saveEdit(f);
      p = await f.doc('products/p1');
      f.eq(p.slug, 'classic-tee', 'the address changed');
      f.eq((await f.doc('slugIndex/classic-tee')).productId, 'p1', 'the new address is indexed');
      f.eq(await f.doc('slugIndex/classic-cotton-t-shirt'), null, 'the old address is released');
      await f.goto('/product/classic-tee');
      await page.waitForSelector('h1', { timeout: 12000 });
      f.ok((await text(page, 'h1')).includes('Classic Cotton Tee'), 'the storefront serves the product at the new address');
    },
  },

  {
    name: 'admin products: images — upload, alt text, cover, remove (files are deleted after the save)', as: 'sadm',
    async run(f) {
      const { page } = f;
      await openEditor(f, NEW);
      await page.fill('#f-name', 'Photo Lamp');
      await page.fill('#f-price', '999');
      await page.fill('#f-sku', 'LMP-1');
      await page.fill('#f-stock', '3');
      const pick = async () => {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="imgAdd"]')]);
        await chooser.setFiles({ name: 'lamp.png', mimeType: 'image/png', buffer: PNG });
      };
      await pick();
      await page.waitForFunction(() => document.querySelectorAll('#pe-images .pe-img').length === 1, null, { timeout: 12000 });
      await page.fill('#pe-images input[data-input="imgAlt"]', 'A brass table lamp');
      await saveNew(f, 'Photo Lamp');

      const entry = await productByName(f, 'Photo Lamp');
      f.ok(!!entry, 'the product was saved');
      if (!entry) return;
      const id = idOf(entry);
      const first = entry[1].images[0];
      f.eq(entry[1].images.length, 1, 'one image is stored');
      f.eq(first.alt, 'A brass table lamp', 'with its description');
      f.ok(first.path.startsWith(`products/${id}/`) && first.thumbPath.startsWith(`products/${id}/`), 'under the product\'s folder in Storage');
      const has = (p) => page.evaluate((x) => window.__MOCK__.files.has(x), p);
      f.ok((await has(first.path)) && (await has(first.thumbPath)), 'a large and a thumbnail file were uploaded');

      // second image, make it the cover
      await pick();
      await page.waitForFunction(() => document.querySelectorAll('#pe-images .pe-img').length === 2, null, { timeout: 12000 });
      await page.click('[data-action="imgCover"][data-i="1"]');
      await saveEdit(f);
      let p = await f.doc(`products/${id}`);
      f.eq(p.images.length, 2, 'two images are stored');
      f.ok(p.images[1].id === first.id && p.images[0].id !== first.id, 'the new image is first (the cover) and the old one second');
      const second = p.images[0];

      // remove the old one: its files go only after the product no longer lists it
      await page.click('[data-action="imgRemove"][data-i="1"]');
      f.ok(await has(first.path), 'before saving, the file is still there');
      await saveEdit(f);
      p = await f.doc(`products/${id}`);
      f.eq(p.images.map((i) => i.id), [second.id], 'only the remaining image is stored');
      f.ok(await f.until(async () => !(await has(first.path)) && !(await has(first.thumbPath)), 4000), 'the removed image\'s files were deleted from Storage');
      f.ok((await has(second.path)), 'the remaining image\'s files are untouched');
    },
  },

  {
    name: 'admin products: duplicate — a draft copy without images, SKU or stock', as: 'pm',
    async run(f) {
      const { page } = f;
      await openEditor(f, EDIT('p1'));
      await page.click('a[href*="products/new?from=p1"]');
      await page.waitForSelector('#f-type', { timeout: 12000 });
      f.eq(await page.inputValue('#f-name'), 'Classic Cotton T-Shirt (copy)', 'the copy is named after the original');
      f.eq([await page.inputValue('#f-status'), await page.inputValue('#f-sku'), await page.inputValue('#f-slug'), await page.inputValue('#f-stock')], ['draft', '', '', '0'], 'a draft with no SKU, address or stock');
      f.eq(await page.locator('#pe-images .pe-img').count(), 0, 'and no images');
      f.ok((await page.inputValue('#f-highlights')).includes('100% cotton'), 'but the text content is copied');
      await page.fill('#f-sku', 'TS-001-B');
      await page.fill('#f-stock', '5');
      await saveNew(f, 'Classic Cotton T-Shirt (copy)');
      const entry = await productByName(f, 'Classic Cotton T-Shirt (copy)');
      f.ok(!!entry, 'the copy was saved');
      if (entry) {
        f.eq([entry[1].slug, entry[1].status, entry[1].sku], ['classic-cotton-t-shirt-copy', 'draft', 'TS-001-B'], 'with its own address and SKU');
        f.eq(entry[1].highlights, ['100% cotton', 'Relaxed fit'], 'and the copied highlights');
      }
      f.eq((await f.doc('products/p1')).name, 'Classic Cotton T-Shirt', 'the original is unchanged');
    },
  },

  {
    name: 'admin products: list — bulk archive, delete a draft, refuse to delete a product with reserved stock', as: 'pm',
    async run(f) {
      const { page } = f;
      await f.goto('/admin/#/products');
      await page.waitForSelector('[data-change="toggle"][data-id="pd"]', { timeout: 12000 });
      await page.check('[data-change="toggle"][data-id="pd"]');
      await page.check('[data-change="toggle"][data-id="p7"]');
      await page.click('[data-action="bulk"][data-to="archived"]');
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('products/pd')).status === 'archived' && (await f.doc('products/p7')).status === 'archived'), 'both products are archived');
      f.eq((await f.doc('products/p1')).status, 'published', 'other products are untouched');
      const audit = Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'product.status');
      f.eq(audit.length, 1, 'one audit entry for the bulk change');
      await f.goto('/shop');
      await page.waitForSelector('#main a[href*="/product/"]', { timeout: 12000 });
      f.eq(await page.locator('#main a[href="/product/sold-out-sunglasses"]').count(), 0, 'an archived product disappears from the store');

      // delete the archived draft: product, inventory, address and SKU index all go
      await f.goto('/admin/#/products');
      await page.waitForSelector('[data-action="row-menu"][data-id="pd"]', { timeout: 12000 });
      await page.click('[data-action="row-menu"][data-id="pd"]');
      await page.click('[role="menu"] button[role="menuitem"][style*="danger"]');
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('products/pd')) === null), 'the product is deleted');
      f.eq([await f.doc('inventory/pd'), await f.doc('slugIndex/draft-product'), await f.doc('skuIndex/DR-000')], [null, null, null], 'with its inventory document and both index entries');
      f.ok(Object.values(await f.docs('auditLogs/')).some((a) => a.action === 'product.delete' && a.entityId === 'pd'), 'the deletion is in the audit log');

      // p1 has two units held by an open order
      await page.click('[data-action="row-menu"][data-id="p1"]');
      await page.click('[role="menu"] button[role="menuitem"][style*="danger"]');
      await page.waitForSelector(`${DLG} [data-yes]`);
      await page.click(YES);
      await page.waitForSelector('.toast-bad', { timeout: 6000 });
      f.ok(!!(await f.doc('products/p1')) && !!(await f.doc('inventory/p1')), 'a product whose stock is held by an open order cannot be deleted');
    },
  },

  {
    name: 'admin products: old-format products are listed but not editable until migrated', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.patch('products/p4', 'delete d.type; delete d.status;');
      await f.goto('/admin/#/products/p4');
      await page.waitForSelector('.admin-content .empty', { timeout: 12000 });
      f.eq(await page.locator('#pe-form').count(), 0, 'there is no form for an old-format product');
      f.ok(await page.locator('.admin-content .empty a[href*="setup"]').count() > 0, 'a super admin is pointed to the Setup page');
      await f.goto('/admin/#/products');
      await page.waitForSelector('[data-change="toggle"][data-id="p4"]', { timeout: 12000 });
      f.ok(await page.locator('.alert-warn a[href*="setup"]').count() > 0, 'the list warns about old-format products');
    },
  },

  {
    name: 'admin products: roles — an order manager may look but not touch; a new product is out of reach', as: 'om',
    async run(f) {
      const { page } = f;
      await f.goto('/admin/#/products/p1');
      await page.waitForSelector('#pe-form', { timeout: 12000 });
      f.eq(await page.locator('#pe-form fieldset[disabled]').count(), 1, 'every field is disabled');
      f.eq(await page.locator(SAVE).count(), 0, 'there is no save button');
      f.eq(await page.locator('[data-action="imgAdd"], [data-action="optAdd"], [data-action="specAdd"]').count(), 0, 'no upload or add buttons');
      f.eq(await page.locator('#f-costPrice').count(), 0, 'the private cost panel is not shown to a role without cost access');
      await f.goto('/admin/#/products/new');
      await page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await page.locator('#pe-form').count(), 0, 'the new-product page redirects to "no access"');
    },
  },
];
