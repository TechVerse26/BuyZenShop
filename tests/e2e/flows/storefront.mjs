/*
 * Storefront click-through scenarios beyond checkout and the account area (see tests/e2e/flows.mjs):
 * wishlist, order tracking, contact form, CMS pages. Seed: tests/e2e/fixtures.mjs
 *   u1 Rahim · order SV-261025-AB12CD (his)  ·  order SV-261026-EF34GH (Karim's)  ·  pages: about (published), draft-page (hidden)
 */
import { text } from './helpers.mjs';

const ORDER = 'SV-261025-AB12CD';
const OTHERS_ORDER = 'SV-261026-EF34GH';
const count = (page, sel) => page.locator(sel).count();
const wishStorage = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sv.wish.v2') || '[]'));
const settled = (page) => page.waitForFunction(() => { const m = document.querySelector('#main'); return !!m && !m.querySelector('.skeleton, .sk-line, .skeleton-card, .spinner') && m.textContent.trim().length > 0; }, null, { timeout: 12000 });
const tickets = async (f) => Object.keys(await f.docs('supportTickets/')).filter((k) => k.split('/').length === 2);

export const storefrontFlows = [
  /* ───────── wishlist ───────── */
  {
    name: 'wishlist: a guest saves, sees and removes a product', as: null,
    async run(f) {
      const { page } = f;
      const heart = '.p-wish[data-id="p1"]';
      await f.goto('/shop');
      await page.waitForSelector('.p-card');
      f.eq(await page.getAttribute(heart, 'aria-pressed'), 'false', 'the product is not saved yet');
      await page.click(heart);
      f.ok(await f.until(async () => (await page.getAttribute(heart, 'aria-pressed')) === 'true'), 'the heart shows it is saved');
      f.eq(await wishStorage(page), ['p1'], 'stored in this browser');

      await f.goto('/wishlist');
      await page.waitForSelector('.p-card');
      f.eq([await count(page, '.p-card'), await page.getAttribute('.p-card', 'data-id')], [1, 'p1'], 'the saved product is listed');
      f.eq(await count(page, '.wl > .alert a[href^="/login"]'), 1, 'a guest is told the list lives on this device only, with a sign-in link');

      await page.click(heart);
      f.ok(await f.until(async () => (await count(page, '.p-card')) === 0), 'removing the heart removes the card');
      await page.waitForSelector('.empty');
      f.eq(await wishStorage(page), [], 'storage is empty again');
      f.eq(await count(page, '.wl > .alert'), 0, 'no guest note on an empty list');
    },
  },

  {
    name: 'wishlist: a signed-in customer\'s list is stored in the account', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.goto('/shop');
      await page.waitForSelector('.p-card');
      await page.click('.p-wish[data-id="p1"]');
      f.ok(await f.until(async () => ((await f.doc('users/u1/wishlist/p1')) || {}).productId === 'p1'), 'saved to users/u1/wishlist');
      await f.goto('/wishlist');
      await page.waitForSelector('.p-card');
      f.eq(await count(page, '.wl > .alert'), 0, 'no guest note when signed in');
      await page.click('.p-wish[data-id="p1"]');
      f.ok(await f.until(async () => (await f.doc('users/u1/wishlist/p1')) === null), 'removed from the account too');
      await page.waitForSelector('.empty');
    },
  },

  {
    name: 'wishlist: saved products that no longer exist can be cleared', as: null,
    async run(f) {
      const { page } = f;
      await f.goto('/shop');
      await page.evaluate(() => localStorage.setItem('sv.wish.v2', JSON.stringify(['p1', 'gone-1', 'gone-2'])));
      await f.goto('/wishlist');
      await page.waitForSelector('.p-card');
      f.eq(await count(page, '.p-card'), 1, 'only the product that still exists is shown');
      f.eq(await count(page, '.wl > .alert-warn [data-action="prune"]'), 1, 'the unavailable ones are announced with a clear button');
      await page.click('[data-action="prune"]');
      f.ok(await f.until(async () => (await count(page, '.wl > .alert-warn')) === 0), 'the note goes away');
      f.eq(await wishStorage(page), ['p1'], 'only the real product stays saved');
    },
  },

  /* ───────── tracking ───────── */
  {
    name: 'track: the number is validated, normalised and opens the order', as: 'u1',
    async run(f) {
      const { page } = f;
      const SUBMIT = 'form[data-form="track"] [type="submit"]';
      await f.goto('/track');
      await page.waitForSelector('form[data-form="track"]');
      f.ok(await f.until(async () => (await count(page, `a[href="/track/${ORDER}"]`)) === 1), 'recent orders link straight to their tracking page');
      await page.click(SUBMIT);
      f.ok((await text(page, '#err-order')).length > 3, 'an empty number is refused');
      await page.fill('#f-order', 'oops!');
      await page.click(SUBMIT);
      f.ok((await text(page, '#err-order')).length > 3, 'a malformed number is refused');
      f.ok(page.url().endsWith('/track'), 'the page does not navigate on a malformed number');
      await page.fill('#f-order', ` ${ORDER.toLowerCase()} `);
      await page.click(SUBMIT);
      await page.waitForURL(new RegExp(`/track/${ORDER}$`), { timeout: 8000 });
      await page.waitForSelector('.trk-title');
      f.ok((await text(page, '.trk-title')).includes(ORDER), 'the order number is shown');
      f.ok((await count(page, '.ord-steps')) >= 1, 'the progress steps are shown');
      f.eq(await count(page, `a[href="/account/orders/${ORDER}"]`), 1, 'a link leads to the full order page');
    },
  },

  {
    name: 'track: the page follows a status change while it is open', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.goto(`/track/${ORDER}`);
      await page.waitForSelector('.trk-title');
      const before = await text(page, '.trk-badges .badge');
      await f.patch(`orders/${ORDER}`, "d.status = 'shipped'; d.shippedAt = Ts.fromMillis(Date.now());");
      f.ok(await f.until(async () => (await text(page, '.trk-badges .badge')) !== before), 'the status badge changed without reloading');
    },
  },

  {
    name: 'track: an unknown number and somebody else\'s order look the same', as: 'u1', denied: true,
    async run(f) {
      const { page } = f;
      for (const no of ['SV-000000-ZZZZZZ', OTHERS_ORDER]) {
        await f.goto(`/track/${no}`);
        await settled(page);
        await page.waitForSelector('#main .empty', { timeout: 8000 });
        f.eq(await count(page, '.trk-title'), 0, `${no}: no order header`);
        f.ok(!(await text(page, '#main')).includes('Leather Wallet'), `${no}: nothing about the other customer's order is shown`);
      }
    },
  },

  {
    name: 'track: guests are asked to sign in first', as: null,
    async run(f) {
      const { page } = f;
      await f.goto('/track');
      await page.waitForURL(/\/login/, { timeout: 8000 });
      f.ok(decodeURIComponent(page.url()).includes('next=/track'), 'the login URL remembers where to return');
    },
  },

  /* ───────── contact ───────── */
  {
    name: 'contact: a guest message becomes a support ticket, then the cooldown applies', as: null,
    async run(f) {
      const { page } = f;
      const SEND = 'form[data-form="contact"] [type="submit"]';
      await f.goto('/contact');
      await page.waitForSelector('form[data-form="contact"]');
      const n0 = (await tickets(f)).length;
      await page.click(SEND);
      for (const n of ['name', 'email', 'subject', 'message']) f.ok((await text(page, `#err-${n}`)).length > 3, `${n} error is shown`);
      f.eq((await tickets(f)).length, n0, 'nothing was written while the form was invalid');

      await page.fill('#f-name', 'Guest Buyer');
      await page.fill('#f-email', 'guest@example.com');
      await page.fill('#f-subject', 'Do you deliver to Rangpur?');
      await page.fill('#f-message', 'I would like to order three t-shirts.');
      await page.click(SEND);
      await page.waitForSelector('.ct-done');
      const ref = await text(page, '.ct-done .mono');
      const tk = await f.doc(`supportTickets/${ref}`);
      if (!f.ok(tk, 'the ticket was stored under the reference shown')) return;
      f.eq([tk.userId, tk.status, tk.priority, tk.lastAuthor, tk.email, tk.subject], [null, 'open', 'normal', 'customer', 'guest@example.com', 'Do you deliver to Rangpur?'], 'ticket fields');
      f.eq(await count(page, '.ct-done a[href^="/account/support/"]'), 0, 'a guest gets no link to a ticket they cannot read');

      await page.click('[data-action="again"]');
      await page.waitForSelector('form[data-form="contact"]');
      await page.fill('#f-name', 'Guest Buyer');
      await page.fill('#f-email', 'guest@example.com');
      await page.fill('#f-subject', 'Second message');
      await page.fill('#f-message', 'Sending another one right away.');
      await page.click(SEND);
      f.ok(await f.until(async () => (await count(page, '.toast-bad')) > 0), 'a second message right away is held back with a message');
      f.eq((await tickets(f)).length, n0 + 1, 'only the first message was stored');
    },
  },

  {
    name: 'contact: a filled honeypot looks like success but stores nothing', as: null,
    async run(f) {
      const { page } = f;
      await f.goto('/contact');
      await page.waitForSelector('form[data-form="contact"]');
      const n0 = (await tickets(f)).length;
      await page.fill('#f-name', 'Spam Bot');
      await page.fill('#f-email', 'bot@example.com');
      await page.fill('#f-subject', 'Cheap watches');
      await page.fill('#f-message', 'Buy now at a very low price.');
      await page.evaluate(() => { document.querySelector('input[name="website"]').value = 'http://spam.example'; });
      await page.click('form[data-form="contact"] [type="submit"]');
      await page.waitForSelector('.ct-done');
      f.eq((await tickets(f)).length, n0, 'no ticket was created');
      f.eq(await count(page, '.ct-done .mono'), 0, 'no reference number is invented');
    },
  },

  {
    name: 'contact: a signed-in customer is pre-filled and can follow the ticket', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.goto('/contact');
      await page.waitForSelector('form[data-form="contact"]');
      f.eq([await page.inputValue('#f-name'), await page.inputValue('#f-email'), await page.inputValue('#f-phone')], ['Rahim', 'rahim@example.com', '01711111111'], 'contact details are pre-filled');
      await page.fill('#f-subject', 'Gift wrapping');
      await page.fill('#f-message', 'Can you gift-wrap the watch?');
      await page.click('form[data-form="contact"] [type="submit"]');
      await page.waitForSelector('.ct-done');
      const ref = await text(page, '.ct-done .mono');
      f.eq((await f.doc(`supportTickets/${ref}`) || {}).userId, 'u1', 'the ticket belongs to the customer');
      f.eq(await count(page, `.ct-done a[href="/account/support/${ref}"]`), 1, 'a link leads to the conversation');
    },
  },

  /* ───────── CMS pages ───────── */
  {
    name: 'content: a CMS page renders its Markdown and cannot inject markup', as: null,
    async run(f) {
      const { page } = f;
      await f.patch('pages/about', "d.body = 'Hello <img src=x onerror=\"window.__pwned=1\"> world\\n\\n[click](javascript:window.__pwned=2) and [fine](https://example.com)\\n\\n## Sub heading\\n\\n- one\\n- two';");
      await f.goto('/page/about');
      await page.waitForSelector('.cms-body');
      f.eq(await text(page, '.cms h1'), 'About us', 'the page title is the heading');
      f.ok((await page.title()).includes('About us'), 'the document title carries the page title');
      f.eq([await count(page, '.cms-body h3'), await count(page, '.cms-body li')], [1, 2], 'headings and lists are rendered');
      f.eq(await count(page, '.cms-body img'), 0, 'an <img> in the text is not turned into an element');
      f.ok((await text(page, '.cms-body')).includes('<img'), 'it is shown as plain text instead');
      f.eq(await count(page, '.cms-body a[href^="javascript"]'), 0, 'a javascript: link is dropped');
      f.eq(await count(page, '.cms-body a[href="https://example.com"][rel~="noopener"]'), 1, 'an https link is kept, with rel=noopener');
      f.eq(await page.evaluate(() => window.__pwned), undefined, 'no script ran');
    },
  },

  {
    name: 'content: an unpublished, unknown or malformed page is the 404 page', as: null, denied: true,
    async run(f) {
      const { page } = f;
      for (const slug of ['draft-page', 'no-such-page', 'Bad Slug!']) {
        await f.goto(`/page/${encodeURIComponent(slug)}`);
        await settled(page);
        f.eq(await count(page, '.cms-body'), 0, `${slug}: no page body`);
        f.ok(!(await text(page, '#main')).includes('not public'), `${slug}: the hidden text is not exposed`);
      }
    },
  },
];
