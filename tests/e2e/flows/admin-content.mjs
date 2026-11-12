/*
 * Admin "Content" (the home page editor, the pages list, the page editor), clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   content/home = a rich layout (hero1 with two slides, trust1, cats, banners1, new, best, sale1, brands1, rich1, news1) · pages about (shown, in the footer) and draft-page (hidden)
 * Who may: Super Admin · Store Admin · Product Manager (content.write). Order Manager, Inventory Manager, Customer Support and Reporting may not open any of it.
 * After every action the mock database is inspected (content/home, pages/*, the audit log) and, where it matters, the shop itself is opened to see what visitors get.
 * (The browser runs with a Bengali locale: assert on the page structure and the database, not on words.)
 */
import { DLG, YES, text, snap } from './helpers.mjs';

const HOME = '/admin/#/content';
const LIST = '/admin/#/content/pages';
const NEW = '/admin/#/content/pages/new';
const EDIT = (slug) => `/admin/#/content/pages/${slug}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const wait = (page, fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 8000 });
const count = (page, sel) => page.locator(sel).count();
const homeReady = (page) => wait(page, () => !!document.querySelector('#chm-list .chm-list, #chm-list .empty'));
const secIds = (page) => page.locator('.chm-sec').evaluateAll((els) => els.map((e) => e.dataset.id));
const savedHome = async (f) => ((await f.doc('content/home')) || { sections: [] }).sections;
const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const auditsOf = async (f, re) => Object.values(await f.docs('auditLogs/')).filter((a) => re.test(a.action)).map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(byJson);
const latin = (v) => String(v ?? '').replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
const tsMs = (v) => (v && (v.ms ?? v.__ts ?? null));
const errorText = (page, name) => wait(page, (sel) => ((document.querySelector(sel) || {}).textContent || '').trim().length > 0, `#err-${name}`);
const tableReady = (page) => wait(page, () => !!document.querySelector('#cpg-table, #cpg-body .empty'));
const editorReady = (page) => wait(page, () => !!document.querySelector('form[data-form="page"]') || !!document.querySelector('.cpe .back-link'));
const row = (slug) => `#cpg-table tbody tr[data-slug="${slug}"]`;
const flip = (page, input) => page.click(`${input} + .track`);
const focusedFlag = (page) => page.evaluate(() => (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.flag : null));
const openCard = (page, id) => page.click(`.chm-sec[data-id="${id}"] [data-action="toggle"]`);
const upload = async (page, btnSel, inputSel) => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(btnSel)]);
  await chooser.setFiles({ name: 'slide.png', mimeType: 'image/png', buffer: PNG });
  await wait(page, (s) => /^https:\/\/mock-storage\.test\//.test((document.querySelector(s) || {}).value || ''), inputSel);
};
const BODY = '## Rates\n\n- Dhaka 60 taka\n- Outside Dhaka 120 taka\n\n<script>window.__xss = 1</script>\n\n[bad](javascript:alert(1)) and [good](https://example.com)';

export const adminContentFlows = [
  /* ───────────────────────── home page editor ───────────────────────── */
  {
    name: 'admin content home: lists the saved sections in the saved order; a card opens to show its fields', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.goto(HOME);
      await homeReady(page);
      const stored = await savedHome(f);
      f.eq(await secIds(page), stored.map((s) => s.id), 'every saved section is listed, in the saved order');
      f.eq(await page.locator('.chm-sec').evaluateAll((els) => els.map((e) => e.dataset.type)), stored.map((s) => s.type), 'each with its type');
      f.eq(await count(page, '#chm-never'), 0, 'the layout was saved before, so there is no "never saved" note');
      f.ok(await page.locator('[data-action="save"]').isDisabled(), 'nothing changed: Save is off');
      f.ok(await page.locator('[data-action="discard"]').isDisabled(), 'and so is Discard');
      f.eq(await count(page, '.chm-sec-body:not([hidden])'), 0, 'every card starts closed');
      await snap(f, 'admin-home-editor-closed');
      await openCard(page, 'hero1');
      f.eq(await page.getAttribute('.chm-sec[data-id="hero1"] [data-action="toggle"]', 'aria-expanded'), 'true', 'the card says it is open');
      f.eq(await count(page, '#chm-body-hero1 .chm-item'), 2, 'the hero shows its two slides');
      f.eq(await count(page, '#chm-body-hero1 .chm-thumb img'), 2, 'each slide shows a preview of its picture');
      f.eq(await page.inputValue('#f-hero1-slides0-title'), 'New season arrivals', 'the saved title is in the field');
      await snap(f, 'admin-home-editor-hero');
      await openCard(page, 'hero1');
      f.eq(await page.getAttribute('.chm-sec[data-id="hero1"] [data-action="toggle"]', 'aria-expanded'), 'false', 'a second click closes it');
      f.eq(await count(page, '#chm-body-hero1:not([hidden])'), 0, 'and hides the fields');
    },
  },
  {
    name: 'admin content home: moving, hiding and deleting sections changes nothing until Save; Save writes the new layout and an audit entry', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(HOME);
      await homeReady(page);
      const before = await secIds(page);
      const at = before.indexOf('trust1');
      f.ok(at > 0 && before.includes('news1') && before.includes('rich1'), 'the seed has the sections this test needs');
      await page.click('[data-action="up"][data-id="trust1"]');
      f.eq((await secIds(page)).indexOf('trust1'), at - 1, 'the section moved up by one');
      f.eq(await page.evaluate(() => document.activeElement && document.activeElement.dataset.id), 'trust1', 'keyboard focus stays with the moved section');
      f.ok(!(await page.locator('[data-action="save"]').isDisabled()), 'Save is on now');
      f.ok((await text(page, '#chm-dirty')).length > 0, 'the unsaved note is shown');
      await flip(page, '.chm-sec[data-id="rich1"] input[data-f="enabled"]');
      await wait(page, () => !!document.querySelector('.chm-sec[data-id="rich1"].is-off'));
      f.eq(await page.evaluate(() => document.activeElement && document.activeElement.dataset.f), 'enabled', 'focus returns to the switch after the card is redrawn');
      await page.click('[data-action="del"][data-id="news1"]');
      await page.click(YES);
      await wait(page, () => !document.querySelector('.chm-sec[data-id="news1"]'));
      f.eq((await savedHome(f)).map((s) => s.id), before, 'nothing reached the database yet');
      await snap(f, 'admin-home-editor-changed');
      await page.click('[data-action="save"]');
      f.ok(await f.until(async () => (await savedHome(f)).length === before.length - 1), 'Save writes the new layout');
      const want = before.filter((id) => id !== 'news1');
      [want[at - 1], want[at]] = [want[at], want[at - 1]];
      const after = await savedHome(f);
      f.eq(after.map((s) => s.id), want, 'the stored order is the order on screen, without the deleted section');
      f.eq(after.find((s) => s.id === 'rich1').enabled, false, 'the hidden section is stored as hidden');
      f.eq(await auditsOf(f, /^content\./), [['content.home_save', 'home', 'sadm', 'store_admin']], 'one audit entry');
      await wait(page, () => document.querySelector('[data-action="save"]').disabled);
      f.eq((await text(page, '#chm-dirty')), '', 'the unsaved note is gone after saving');
    },
  },
  {
    name: 'admin content home: a home page that was never saved shows the standard layout with a note; saving stores it', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.mock();
      await f.remove('content/home');
      await f.goto(HOME);
      await homeReady(page);
      f.eq(await count(page, '#chm-never'), 1, 'the note explains that visitors see the standard layout');
      f.eq(await secIds(page), ['cats', 'new', 'best', 'trust', 'news'], 'the standard layout is listed');
      f.ok(!(await page.locator('[data-action="save"]').isDisabled()), 'Save is on, so it can be stored as it is');
      f.ok(await page.locator('[data-action="discard"]').isDisabled(), 'Discard has nothing to undo');
      await page.click('[data-action="save"]');
      f.ok(await f.until(async () => (await savedHome(f)).length === 5), 'the standard layout is stored');
      f.eq((await savedHome(f)).map((s) => s.id), ['cats', 'new', 'best', 'trust', 'news'], 'in the same order');
      await wait(page, () => !document.querySelector('#chm-never'));
      f.eq(await auditsOf(f, /^content\./), [['content.home_save', 'home', 'sa', 'super_admin']], 'audited');
    },
  },
  {
    name: 'admin content home: discarding puts every field back to what is saved', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.goto(HOME);
      await homeReady(page);
      const stored = JSON.stringify(await savedHome(f));
      await openCard(page, 'hero1');
      await page.fill('#f-hero1-slides0-title', 'Something else');
      f.ok((await text(page, '#chm-dirty')).length > 0, 'the edit counts as an unsaved change');
      f.ok(await page.locator('[data-action="discard"]').isEnabled(), 'Discard is on');
      await page.click('[data-action="discard"]');
      await page.click(`${DLG} [data-no]`);
      f.eq(await page.inputValue('#f-hero1-slides0-title'), 'Something else', 'answering No keeps the edit');
      await page.click('[data-action="discard"]');
      await page.click(YES);
      await wait(page, () => !document.querySelector('.chm-sec-body:not([hidden])'));
      f.eq(await text(page, '#chm-dirty'), '', 'no unsaved note');
      await openCard(page, 'hero1');
      f.eq(await page.inputValue('#f-hero1-slides0-title'), 'New season arrivals', 'the saved title is back');
      f.eq(JSON.stringify(await savedHome(f)), stored, 'the database was never touched');
    },
  },
  {
    name: 'admin content home: a new section needs usable pictures and links before it can be saved; sections that exist once are not offered twice', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(HOME);
      await homeReady(page);
      const n = (await secIds(page)).length;
      await page.click('#chm-add');
      await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 4000 });
      f.eq(await count(page, '[role="menu"] [role="menuitem"]'), 5, 'hero, trust badges and newsletter exist already (once only), the other five types are offered');
      await page.locator('[role="menu"] [role="menuitem"]').nth(0).click();            // promo banners
      await wait(page, (k) => document.querySelectorAll('.chm-sec').length === k, n + 1);
      const id = (await secIds(page)).pop();
      f.eq(await page.getAttribute(`.chm-sec[data-id="${id}"]`, 'data-type'), 'banners', 'a promo-banner section was added at the end');
      f.eq(await page.getAttribute(`.chm-sec[data-id="${id}"] [data-action="toggle"]`, 'aria-expanded'), 'true', 'and opened for editing');
      await page.click(`#chm-body-${id} [data-action="item-add"]`);
      f.eq(await count(page, `#chm-body-${id} .chm-item`), 1, 'one empty banner');
      await page.click('[data-action="save"]');
      await wait(page, () => !!document.querySelector('#chm-problems li'));
      f.ok((await count(page, '#chm-problems li')) >= 1, 'the missing picture is listed');
      f.eq((await savedHome(f)).length, n, 'nothing was written');
      await snap(f, 'admin-home-editor-problems');
      await page.fill(`#f-${id}-items0-image`, '/gallery/watch-cut.webp');
      await page.fill(`#f-${id}-items0-link`, 'javascript:alert(1)');
      await wait(page, () => document.querySelectorAll('#chm-problems li').length === 1);
      await page.click('[data-action="save"]');
      f.eq((await savedHome(f)).length, n, 'a link that is not allowed still blocks saving');
      await page.fill(`#f-${id}-items0-link`, '/shop');
      await wait(page, () => !document.querySelector('#chm-problems'));
      await page.click('[data-action="save"]');
      f.ok(await f.until(async () => (await savedHome(f)).length === n + 1), 'with a picture and a good link it is saved');
      const saved = (await savedHome(f)).pop();
      f.eq([saved.type, saved.items.length, saved.items[0].image, saved.items[0].link], ['banners', 1, '/gallery/watch-cut.webp', '/shop'], 'stored as typed');
    },
  },
  {
    name: 'admin content home: a product row can be hand-picked or follow a category, and a category row can be hand-picked', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.goto(HOME);
      await homeReady(page);
      await openCard(page, 'new');
      await page.selectOption('#f-new-source', 'manual');
      await wait(page, () => !!document.querySelector('#f-new-q'));
      f.eq(await count(page, '#f-new-limit'), 0, 'a hand-picked row has no "how many" box');
      f.eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'f-new-source', 'focus stays on the select');
      await page.fill('#f-new-q', 'watch');
      await wait(page, () => document.querySelectorAll('#chm-res-new li').length === 1);
      f.ok((await text(page, '#chm-res-new li')).includes('Sports Watch'), 'the search finds the product by name');
      await page.click('#chm-res-new [data-action="pick-add"]');
      await wait(page, () => document.querySelectorAll('#chm-body-new .chm-chosen li').length === 1);
      await page.fill('#f-new-q', 'watch');
      await wait(page, () => document.querySelectorAll('#chm-res-new li.muted').length === 1);
      f.eq(await count(page, '#chm-res-new [data-action="pick-add"]'), 0, 'a chosen product is not offered again');
      await page.click('[data-action="save"]');
      f.ok(await f.until(async () => ((await savedHome(f)).find((s) => s.id === 'new') || {}).source === 'manual'), 'saved');
      const manual = (await savedHome(f)).find((s) => s.id === 'new');
      f.eq([manual.source, manual.productIds], ['manual', ['p5']], 'the chosen product is stored');

      await page.selectOption('#f-new-source', 'category');
      await wait(page, () => !!document.querySelector('#f-new-categoryId'));
      await page.selectOption('#f-new-categoryId', 'c1');
      f.ok((await text(page, '#chm-sum-new')).includes('Clothing'), 'the card summary names the category');
      await openCard(page, 'cats');
      await page.click('input[data-pick="categoryIds"][data-s="cats"][data-id="c1"]');
      await page.click('input[data-pick="categoryIds"][data-s="cats"][data-id="c2"]');
      await page.click('[data-action="save"]');
      f.ok(await f.until(async () => ((await savedHome(f)).find((s) => s.id === 'cats') || {}).categoryIds?.length === 2), 'saved');
      const after = await savedHome(f);
      const cat = after.find((s) => s.id === 'new');
      f.eq([cat.source, cat.categoryId], ['category', 'c1'], 'the row follows the chosen category');
      f.eq(after.find((s) => s.id === 'cats').categoryIds.slice().sort(), ['c1', 'c2'], 'the hand-picked categories are stored');
      f.eq(await auditsOf(f, /^content\./), [['content.home_save', 'home', 'sa', 'super_admin'], ['content.home_save', 'home', 'sa', 'super_admin']], 'each save is audited');
    },
  },
  {
    name: 'admin content home: a Product Manager can add, reorder and remove slides and upload a picture; the shop follows what was saved', as: 'pm',
    async run(f) {
      const { page } = f;
      await f.goto('/');
      await page.waitForSelector('section.hero', { timeout: 12000 });
      await f.goto(HOME);
      await homeReady(page);
      await openCard(page, 'hero1');
      await page.click('[data-action="item-add"][data-s="hero1"]');
      f.eq(await count(page, '#chm-body-hero1 .chm-item'), 3, 'a third, empty slide');
      await upload(page, '[data-action="img-up"][data-s="hero1"][data-i="2"][data-f="image"]', '#f-hero1-slides2-image');
      await page.fill('#f-hero1-slides2-title', 'Third slide');
      await page.fill('#f-hero1-slides2-link', '/shop');
      f.eq(await count(page, '#chm-body-hero1 .chm-item:nth-of-type(3) .chm-thumb img'), 1, 'the uploaded picture is previewed');
      await page.click('[data-action="item-up"][data-s="hero1"][data-i="2"]');
      f.eq(await page.inputValue('#f-hero1-slides1-title'), 'Third slide', 'the slide moved up');
      await page.click('[data-action="item-del"][data-s="hero1"][data-i="2"]');
      f.eq(await count(page, '#chm-body-hero1 .chm-item'), 2, 'the slide that moved down was removed');
      await page.click('[data-action="save"]');
      f.ok(await f.until(async () => (await auditsOf(f, /^content\./)).length === 1), 'saved');
      const slides = (await savedHome(f)).find((s) => s.id === 'hero1').slides;
      f.eq(slides.map((s) => s.title), ['New season arrivals', 'Third slide'], 'the slides are stored in the new order, without the removed one');
      f.ok(/^https:\/\/mock-storage\.test\//.test(slides[1].image), 'with the uploaded picture');
      f.eq(await auditsOf(f, /^content\./), [['content.home_save', 'home', 'pm', 'product_manager']], 'audited as Product Manager');

      // the shop: delete the hero and the next visit has none
      await page.click('[data-action="del"][data-id="hero1"]');
      await page.click(YES);
      await page.click('[data-action="save"]');
      f.ok(await f.until(async () => !(await savedHome(f)).some((s) => s.id === 'hero1')), 'the hero is gone from the layout');
      await f.goto('/');
      await page.waitForSelector('section.section', { timeout: 12000 });
      f.eq(await count(page, 'section.hero'), 0, 'visitors see no hero any more');
    },
  },

  /* ───────────────────────── pages list ───────────────────────── */
  {
    name: 'admin content pages: every page is listed, also hidden ones; the two switches save at once and are audited', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(LIST);
      await tableReady(page);
      f.eq(await page.locator('#cpg-table tbody tr').evaluateAll((els) => els.map((e) => e.dataset.slug)), ['about', 'draft-page'], 'both pages, in their order');
      f.ok(await page.isChecked(`${row('about')} input[data-flag="visible"]`) && await page.isChecked(`${row('about')} input[data-flag="footer"]`), 'About is shown and in the footer');
      f.ok(!(await page.isChecked(`${row('draft-page')} input[data-flag="visible"]`)), 'the draft is hidden');
      f.eq(await count(page, `${row('draft-page')} .badge`), 1, 'a hidden page is marked');
      f.eq(await count(page, `${row('about')} .badge`), 0, 'a shown page is not');
      f.eq(await count(page, `${row('about')} a[target="_blank"]`), 1, 'only a shown page links to the shop');
      f.eq(await count(page, `${row('draft-page')} a[target="_blank"]`), 0, 'a hidden page does not');
      await snap(f, 'admin-pages-list');
      await flip(page, `${row('draft-page')} input[data-flag="visible"]`);
      f.ok(await f.until(async () => (await f.doc('pages/draft-page')).visible === true), 'showing the draft is saved at once');
      await wait(page, (sel) => !document.querySelector(sel), `${row('draft-page')} .badge`);
      f.eq(await focusedFlag(page), 'visible', 'focus stays on the switch after the row is redrawn');
      f.eq((await f.doc('pages/draft-page')).footer, false, 'the footer switch was not touched');
      await flip(page, `${row('about')} input[data-flag="footer"]`);
      f.ok(await f.until(async () => (await f.doc('pages/about')).footer === false), 'taking About out of the footer is saved');
      await flip(page, `${row('about')} input[data-flag="visible"]`);
      f.ok(await f.until(async () => (await f.doc('pages/about')).visible === false), 'hiding About is saved');
      f.eq(await auditsOf(f, /^page\./), [['page.footer_off', 'about', 'sadm', 'store_admin'], ['page.hide', 'about', 'sadm', 'store_admin'], ['page.show', 'draft-page', 'sadm', 'store_admin']], 'each switch is audited');
      f.ok(await page.isChecked(`${row('draft-page')} input[data-flag="visible"]`) && !(await page.isChecked(`${row('about')} input[data-flag="visible"]`)), 'the list shows the stored state');
    },
  },
  {
    name: 'admin content pages: deleting asks first, removes the page and is audited', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(LIST);
      await tableReady(page);
      await page.click(`${row('draft-page')} [data-action="del"]`);
      await page.click(`${DLG} [data-no]`);
      f.ok(!!(await f.doc('pages/draft-page')), 'answering No keeps the page');
      await page.click(`${row('draft-page')} [data-action="del"]`);
      await page.click(YES);
      await wait(page, (sel) => !document.querySelector(sel), row('draft-page'));
      f.eq(await f.doc('pages/draft-page'), null, 'the page is gone from the database');
      f.ok(!!(await f.doc('pages/about')), 'the other page is untouched');
      f.eq(await auditsOf(f, /^page\./), [['page.delete', 'draft-page', 'sadm', 'store_admin']], 'one audit entry');
    },
  },
  {
    name: 'admin content pages: with no page at all the list explains and offers to create one', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.mock();
      await f.remove('pages/about');
      await f.remove('pages/draft-page');
      await f.goto(LIST);
      await tableReady(page);
      f.eq(await count(page, '#cpg-table'), 0, 'no table');
      f.eq(await count(page, '#cpg-body .empty'), 1, 'an explanation instead');
      f.ok((await page.getAttribute('#cpg-new', 'href')).endsWith('#/content/pages/new'), 'a way to create the first page');
    },
  },
  {
    name: 'admin content pages: what is switched here is what visitors get in the shop (page and footer)', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto('/page/about');
      await page.waitForSelector('article.cms h1', { timeout: 12000 });
      await page.waitForSelector('.ftr a[href="/page/about"]', { timeout: 8000 });
      await f.goto(LIST);
      await tableReady(page);
      await flip(page, `${row('about')} input[data-flag="visible"]`);
      f.ok(await f.until(async () => (await f.doc('pages/about')).visible === false), 'hidden in the admin');
      await f.goto('/page/about');
      await page.waitForSelector('.container.page.nf', { timeout: 12000 });
      f.eq(await count(page, 'article.cms'), 0, 'visitors get "not found" for a hidden page');
      await f.goto(LIST);
      await tableReady(page);
      await flip(page, `${row('about')} input[data-flag="visible"]`);
      f.ok(await f.until(async () => (await f.doc('pages/about')).visible === true), 'shown again');
      await flip(page, `${row('about')} input[data-flag="footer"]`);
      f.ok(await f.until(async () => (await f.doc('pages/about')).footer === false), 'taken out of the footer');
      await f.goto('/page/about');
      await page.waitForSelector('article.cms h1', { timeout: 12000 });
      await page.waitForSelector('.ftr', { timeout: 8000 });
      await page.waitForTimeout(800);
      f.eq(await count(page, '.ftr a[href="/page/about"]'), 0, 'the page is still reachable but no longer in the footer');
    },
  },

  /* ───────────────────────── page editor ───────────────────────── */
  {
    name: 'admin content page editor: a new page suggests its address, checks the fields, previews Markdown safely and saves', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(NEW);
      await editorReady(page);
      f.eq(await count(page, '#cpe-slug-fixed'), 0, 'a new page chooses its address');
      await page.fill('#f-title', 'Delivery Policy');
      f.eq(await page.inputValue('#f-slug'), 'delivery-policy', 'the address is suggested from the title');
      f.ok((await text(page, '#cpe-dirty')).length > 0, 'the unsaved note appears');
      await page.fill('#f-slug', 'Bad Slug!');
      await page.fill('#f-title', '');
      await page.click('#cpe-save');
      await errorText(page, 'slug');
      await errorText(page, 'title');
      f.eq(await page.getAttribute('#f-slug', 'aria-invalid'), 'true', 'the address field is marked invalid');
      f.eq(Object.keys(await f.docs('pages/')).sort(), ['pages/about', 'pages/draft-page'], 'nothing was written');
      await page.fill('#f-title', 'Delivery Policy');
      f.eq(await page.inputValue('#f-slug'), 'Bad Slug!', 'a typed address is not overwritten by the title any more');
      await page.fill('#f-slug', 'delivery-policy');
      await page.fill('#f-body', BODY);
      f.ok(/^\d+\s*\/\s*30,?000$/.test(latin(await text(page, '#cpe-count-body'))), 'a character counter');
      await page.click('#cpe-tab-preview');
      await wait(page, () => !document.querySelector('#cpe-preview').hidden);
      f.ok(await page.locator('#cpe-write').evaluate((el) => el.hidden), 'the preview replaces the editor');
      f.eq(await count(page, '#cpe-preview h2.cpe-pv-title'), 1, 'the page title is shown above the text');
      f.eq(await count(page, '#cpe-preview .prose h3'), 1, 'the Markdown heading is rendered (the shop shifts headings one level down: ## becomes h3)');
      f.eq(await count(page, '#cpe-preview li'), 2, 'and the list');
      f.eq(await count(page, '#cpe-preview script'), 0, 'a script in the text is not turned into a script');
      f.ok((await text(page, '#cpe-preview')).includes('<script>'), 'it is shown as plain text instead');
      f.eq(await count(page, '#cpe-preview a[href^="javascript" i]'), 0, 'a javascript: link is not a link');
      f.eq(await count(page, '#cpe-preview a[href="https://example.com"]'), 1, 'a normal link is');
      f.eq(await page.evaluate(() => window.__xss === undefined), true, 'nothing ran');
      await snap(f, 'admin-page-preview');
      await page.keyboard.press('Home');
      f.eq(await page.getAttribute('#cpe-tab-write', 'aria-selected'), 'true', 'the Home key goes back to the first tab');
      await flip(page, '#f-visible');
      await page.fill('#f-sort', '3');
      await page.fill('#f-seoTitle', 'Delivery rates');
      await snap(f, 'admin-page-editor');
      await page.click('#cpe-save');
      await wait(page, () => location.hash === '#/content/pages/delivery-policy');
      await wait(page, () => !!document.querySelector('#cpe-slug-fixed'));
      const doc = await f.doc('pages/delivery-policy');
      f.eq({ title: doc.title, body: doc.body, visible: doc.visible, footer: doc.footer, sort: doc.sort, seoTitle: doc.seoTitle, seoDescription: doc.seoDescription },
        { title: 'Delivery Policy', body: BODY, visible: true, footer: true, sort: 3, seoTitle: 'Delivery rates', seoDescription: '' }, 'stored as typed');
      f.ok(tsMs(doc.updatedAt) > 0, 'with a server timestamp');
      f.eq(await count(page, '#f-slug'), 0, 'afterwards the address can no longer be changed');
      f.eq(await auditsOf(f, /^page\./), [['page.create', 'delivery-policy', 'sadm', 'store_admin']], 'one audit entry');
      await f.goto('/page/delivery-policy');
      await page.waitForSelector('article.cms h1', { timeout: 12000 });
      f.eq(await count(page, 'article.cms h3'), 1, 'the shop shows the new page with its heading');
    },
  },
  {
    name: 'admin content page editor: an address that exists or is reserved is refused and nothing is overwritten', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(NEW);
      await editorReady(page);
      await page.fill('#f-title', 'Another about');
      await page.fill('#f-slug', 'about');
      await page.click('#cpe-save');
      await errorText(page, 'slug');
      const first = await text(page, '#err-slug');
      f.eq((await f.doc('pages/about')).title, 'About us', 'the existing page is untouched');
      await page.fill('#f-slug', 'new');
      await page.click('#cpe-save');
      await page.waitForFunction((m) => { const s = (document.querySelector('#err-slug').textContent || '').trim(); return s && s !== m; }, first, { timeout: 8000 });
      f.eq(await f.doc('pages/new'), null, 'the reserved address was not written');
      f.eq(await auditsOf(f, /^page\./), [], 'no audit entry for a refused save');
    },
  },
  {
    name: 'admin content page editor: editing saves only real changes; the address is fixed; the header follows', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(EDIT('about'));
      await editorReady(page);
      f.eq(await page.inputValue('#f-title'), 'About us', 'the saved title');
      f.ok((await page.inputValue('#f-body')).includes('Who we are'), 'and the saved text');
      f.eq(await count(page, '#f-slug'), 0, 'the address is not an input');
      f.ok((await text(page, '#cpe-slug-fixed')).includes('/page/about'), 'but is shown');
      const sa = tsMs((await f.doc('pages/about')).updatedAt);
      await page.click('#cpe-save');
      await page.waitForTimeout(700);
      f.eq(await auditsOf(f, /^page\./), [], 'saving without a change writes nothing');
      f.eq(tsMs((await f.doc('pages/about')).updatedAt), sa, 'and does not touch the timestamp');
      await page.fill('#f-title', 'About Shop Verse');
      await page.fill('#f-seoDescription', 'Who we are and how we deliver.');
      await page.click('#cpe-save');
      f.ok(await f.until(async () => (await f.doc('pages/about')).title === 'About Shop Verse'), 'the change is saved');
      const doc = await f.doc('pages/about');
      f.eq([doc.seoDescription, doc.visible, doc.footer, doc.sort], ['Who we are and how we deliver.', true, true, 1], 'the other fields keep their values');
      f.ok(tsMs(doc.updatedAt) > sa, 'the timestamp moved on');
      f.eq(await auditsOf(f, /^page\./), [['page.update', 'about', 'sadm', 'store_admin']], 'one audit entry');
      await wait(page, () => (document.querySelector('#cpe-head h1').textContent || '').includes('About Shop Verse'));
      f.eq(await text(page, '#cpe-dirty'), '', 'no unsaved note after saving');
    },
  },
  {
    name: 'admin content page editor: an unknown address says so and links back', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.goto(EDIT('nobody'));
      await editorReady(page);
      f.eq(await count(page, 'form[data-form="page"]'), 0, 'no form is drawn');
      f.ok((await page.locator('.cpe .back-link').getAttribute('href')).endsWith('#/content/pages'), 'a link back to the list');
    },
  },
  {
    name: 'admin content page editor: a Product Manager can create a page', as: 'pm',
    async run(f) {
      const { page } = f;
      await f.goto(NEW);
      await editorReady(page);
      await page.fill('#f-title', 'Privacy notice');
      await page.fill('#f-body', 'We only keep what an order needs.');
      await page.click('#cpe-save');
      await wait(page, () => location.hash === '#/content/pages/privacy-notice');
      const doc = await f.doc('pages/privacy-notice');
      f.eq([doc.title, doc.visible, doc.footer], ['Privacy notice', false, true], 'stored: hidden until it is switched on, footer on by default');
      f.eq(await auditsOf(f, /^page\./), [['page.create', 'privacy-notice', 'pm', 'product_manager']], 'audited as Product Manager');
    },
  },

  /* ───────────────────────── who may not ───────────────────────── */
  ...[['om', 'Order Manager'], ['im', 'Inventory Manager'], ['cs', 'Customer Support'], ['rp', 'Reporting']].map(([as, label]) => ({
    name: `admin content: the ${label} role cannot open the home editor or the pages`, as,
    async run(f) {
      for (const path of [HOME, LIST, NEW, EDIT('about')]) {
        await f.goto(path);
        await f.page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
        f.eq(await count(f.page, '.chm, .cpg, .cpe'), 0, `nothing of ${path} is shown`);
      }
    },
  })),
];
