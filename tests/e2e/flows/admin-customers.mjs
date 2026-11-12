/*
 * Admin "Customers" (list, profile, restrictions, notes, newsletter, export), clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   u2 Karim (joined 20 days ago, order SV-261026-EF34GH) · u1 Rahim (30 days ago, order SV-261025-AB12CD, support request TK-261026-AAAAAA)
 * Staff: sa Super Admin · sadm Store Admin (restrict, notes, subscribers, export) · cs Customer Support · om Order Manager (read only) · pm / im / rp may not open it
 * After every action the mock database is inspected: the customer document, the notes, the newsletter, the audit log.
 * A staff member who signs in gets a customer profile of their own (like anyone who signs in), so the signed-in staff member is the newest row of the list.
 * (The browser runs with a Bengali locale: assert on the page structure and the database, not on words.)
 */
import fs from 'node:fs';
import { DLG, YES, text, snap } from './helpers.mjs';

const LIST = '/admin/#/customers';
const one = (id) => `/admin/#/customers/${id}`;
const wait = (page, fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 8000 });
const settledList = (page) => wait(page, () => { const r = document.querySelector('#cus-results'); return !!r && !r.querySelector('.spinner'); });
const profileReady = (page) => wait(page, () => !!document.querySelector('#cus-head h1')
  && ['#cus-orders-body', '#cus-tickets-body', '#cus-notes-wrap'].every((s) => { const el = document.querySelector(s); return !el || !el.querySelector('.spinner'); }));
const rowCount = (page, n) => wait(page, (k) => document.querySelectorAll('#cus-table tbody tr').length === k, n);
const rows = (page) => page.locator('#cus-table tbody tr').count();
const names = (page) => page.locator('#cus-table tbody tr .cus-name').allInnerTexts();
/** waits until the table lists exactly these names (a plain row count is already true for the previous search) */
const shows = (page, want) => wait(page, (w) => JSON.stringify([...document.querySelectorAll('#cus-table tbody tr .cus-name')].map((a) => a.textContent.trim())) === JSON.stringify(w), want);
const count = (page, sel) => page.locator(sel).count();
const latin = (s) => String(s ?? '').replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
const digits = (s) => latin(s).replace(/\D/g, '');
const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const auditsOf = async (f, re) => Object.values(await f.docs('auditLogs/')).filter((a) => re.test(a.action)).map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(byJson);
const tsMs = (v) => (v && (v.ms ?? v.__ts ?? null));
const errorText = (page, name) => wait(page, (sel) => ((document.querySelector(sel) || {}).textContent || '').trim().length > 0, `#err-${name}`);
const note = (text_, ago = 3600000) => `({ text: ${JSON.stringify(text_)}, authorUid: 'sadm', authorEmail: 'sadm@example.com', createdAt: new Ts(Date.now() - ${ago}) })`;
const subscriber = (email, source, ago) => `({ email: '${email}', source: '${source}', createdAt: new Ts(Date.now() - ${ago}) })`;

export const adminCustomersFlows = [
  {
    name: 'admin customers: the list shows real customers newest first and searches name, e-mail and phone; Super Admin may export', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.goto(LIST);
      await settledList(page);
      f.eq(await names(page), ['Super Admin', 'Karim', 'Rahim'], 'the newest account comes first (your own profile, then Karim, then Rahim)');
      f.ok((await page.locator('#cus-table tbody tr a.cus-name').nth(1).getAttribute('href')).endsWith('#/customers/u2'), 'the name opens the profile');
      f.eq(latin(await page.locator('#cus-tab-all .cus-n').innerText()), '3', 'the tab counts the loaded customers');
      f.eq(await count(page, '#cus-table .badge-bad'), 0, 'nobody is restricted');
      f.eq(await count(page, '[data-action="export"]'), 1, 'Super Admin may export');
      f.eq(await count(page, '[data-action="more"]'), 0, 'everyone is loaded, so there is no "load more"');
      await snap(f, 'admin-customers-list');

      await page.fill('#q', 'rahim');
      await shows(page, ['Rahim']);
      await page.fill('#q', 'KARIM@example');
      await shows(page, ['Karim']);
      await page.fill('#q', '01822');
      await shows(page, ['Karim']);
      await page.fill('#q', '+8801711111111');
      await shows(page, ['Rahim']);
      await page.fill('#q', 'nobody-at-all');
      await wait(page, () => !document.querySelector('#cus-table'));
      f.eq(await count(page, '#cus-results .empty'), 1, 'a search without a match says so');
      await page.fill('#q', '');
      await shows(page, ['Super Admin', 'Karim', 'Rahim']);
    },
  },
  {
    name: 'admin customers: beyond the loaded page an exact e-mail or phone still finds the customer; "load more" brings the rest', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.mock();
      await page.evaluate(() => {
        for (let i = 0; i < 105; i++) window.__MOCK__.put(`users/fill${String(i).padStart(3, '0')}`, (Ts) => ({ displayName: `Filler ${i}`, email: `fill${i}@example.com`, createdAt: new Ts(Date.now() - i * 1000) }));
      });
      await f.goto(LIST);
      await settledList(page);
      f.eq(latin(await page.locator('#cus-tab-all .cus-n').innerText()), '100+', 'the first 100 are loaded, the tab says there are more');
      f.eq(await rows(page), 25, 'the table pages through what is loaded');
      f.eq(await count(page, '[data-action="more"]'), 1, 'there is a "load more"');
      f.eq(await count(page, '#cus-results .alert-info'), 1, 'and a note on how to find anyone');

      await page.fill('#q', 'karim@example.com');
      await shows(page, ['Karim']);
      await page.fill('#q', '01711111111');
      await shows(page, ['Rahim']);
      await page.fill('#q', 'nobody@example.com');
      await page.waitForTimeout(900);
      f.eq(await count(page, '#cus-table'), 0, 'an address nobody has finds nothing');
      f.eq(await count(page, '#cus-results .spinner'), 0, 'and the search is over');

      await page.fill('#q', '');
      await wait(page, () => document.querySelectorAll('#cus-table tbody tr').length === 25);
      await page.click('[data-action="more"]');
      await wait(page, () => document.querySelector('#cus-tab-all .cus-n') && document.querySelector('#cus-tab-all .cus-n').textContent.trim().replace(/[০-৯]/g, (c) => '০১২৩৪৫৬৭৮৯'.indexOf(c)) === '108');
      f.eq(await count(page, '[data-action="more"]'), 0, 'everyone is loaded now (105 + Karim + Rahim + your own profile)');
    },
  },
  {
    name: 'admin customer: the profile shows the real orders and the numbers computed from them, the support requests, the latest address and the contact links', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.mock();
      await f.patch('orders/SV-261025-AB12CD', "d.status = 'delivered';");
      await f.goto(one('u1'));
      await profileReady(page);
      const order = await f.doc('orders/SV-261025-AB12CD');
      f.eq(await count(page, '#cus-orders-table tbody tr'), 1, 'the customer has one order');
      f.ok((await page.locator('#cus-orders-table tbody tr a').first().getAttribute('href')).endsWith('#/orders/SV-261025-AB12CD'), 'it links to the order');
      const kpi = await page.locator('#cus-kpis .stat-value').allInnerTexts();
      f.eq(kpi.length, 4, 'four numbers');
      f.eq(latin(kpi[0]), '1', 'orders');
      f.eq(digits(kpi[1]), String(order.totals.total), 'spent = the total of the delivered order');
      f.eq(digits(kpi[2]), String(order.totals.total), 'with one order the average is that order');
      f.eq(await count(page, '#cus-tickets-list li'), 1, 'one support request');
      f.ok((await page.locator('#cus-tickets-list a').first().getAttribute('href')).endsWith('#/support/TK-261026-AAAAAA'), 'it links to the request');
      f.ok((await text(page, '#cus-side')).includes('House 1, Road 2, Test Area'), 'the latest delivery address comes from the latest order');
      f.eq(await count(page, '#cus-side a[href^="mailto:"]'), 1, 'e-mail link');
      f.eq(await count(page, '#cus-side a[href^="tel:"]'), 1, 'phone link');
      f.eq(await count(page, '#cus-notes-empty'), 1, 'no notes yet');
      f.eq(await count(page, '#cus-head .badge-bad'), 0, 'not restricted');
      await snap(f, 'admin-customer-profile');
    },
  },
  {
    name: 'admin customer: restricting needs a reason, is stored with who and when, shows in the list, and can be lifted', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(one('u1'));
      await profileReady(page);
      f.eq(await count(page, '[data-action="restrict"]'), 1, 'a restrict button');
      f.eq(await count(page, '[data-action="lift"]'), 0, 'and no lift button');
      await page.click('[data-action="restrict"]');
      await page.waitForSelector(`${DLG} #f-reason`);
      await snap(f, 'admin-customer-restrict-dialog');
      await page.click(YES);
      await errorText(page, 'reason');
      f.eq(await count(page, DLG), 1, 'an empty reason keeps the dialog open');
      await page.fill(`${DLG} #f-reason`, 'ab');
      await page.click(YES);
      await page.waitForTimeout(400);
      f.eq(await count(page, DLG), 1, 'two characters are not a reason');
      f.ok(!(await f.doc('users/u1')).restricted, 'nothing is stored yet');
      f.eq(await auditsOf(f, /^customer\./), [], 'and nothing is audited');

      await page.fill(`${DLG} #f-reason`, '  Two fake   orders in a week ');
      await page.click(YES);
      await page.waitForSelector(DLG, { state: 'detached' });
      await wait(page, () => !!document.querySelector('[data-action="lift"]'));
      const u = await f.doc('users/u1');
      f.eq([u.restricted, u.restrictedReason], [true, 'Two fake orders in a week'], 'the flags and the tidied reason are stored');
      f.ok(tsMs(u.restrictedAt) > 0, 'with the server time');
      f.eq(u.displayName, 'Rahim', 'nothing else about the customer changed');
      f.eq(await auditsOf(f, /^customer\./), [['customer.restrict', 'u1', 'sadm', 'store_admin']], 'one audit entry');
      f.eq(await count(page, '#cus-head .badge-bad'), 1, 'the profile is marked');
      f.ok((await text(page, '#cus-side')).includes('Two fake orders in a week'), 'the reason is shown to staff');
      f.eq(await count(page, '[data-action="restrict"]'), 0, 'no restrict button any more');
      await snap(f, 'admin-customer-restricted');

      await f.goto(LIST);
      await settledList(page);
      f.eq(await count(page, '#cus-table .badge-bad'), 1, 'the list marks the restricted customer');
      await page.click('#cus-tab-restricted');
      await rowCount(page, 1);
      f.eq(await names(page), ['Rahim'], 'the Restricted tab lists exactly that customer');

      await f.goto(one('u1'));
      await profileReady(page);
      await page.click('[data-action="lift"]');
      await page.click(YES);
      await wait(page, () => !!document.querySelector('[data-action="restrict"]'));
      const v = await f.doc('users/u1');
      f.eq([v.restricted, 'restrictedReason' in v, 'restrictedAt' in v], [false, false, false], 'the restriction and its reason are gone');
      f.eq(await auditsOf(f, /^customer\./), [['customer.restrict', 'u1', 'sadm', 'store_admin'], ['customer.unrestrict', 'u1', 'sadm', 'store_admin']], 'both changes are audited');
      f.eq(await count(page, '#cus-head .badge-bad'), 0, 'the mark is gone');
    },
  },
  {
    name: 'admin customer: your own account has no restrict button', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.mock();
      f.ok(await f.until(async () => !!(await f.doc('users/sa'))), 'signing in created your own customer profile');
      await f.goto(one('sa'));
      await profileReady(page);
      f.eq(await count(page, '#cus-head h1'), 1, 'the profile opens');
      f.eq(await count(page, '[data-action="restrict"]'), 0, 'but you cannot restrict yourself');
    },
  },
  {
    name: 'admin customer notes: written, listed newest first, deleted; the audit log records the act, never the words', as: 'sadm',
    async run(f) {
      const { page } = f;
      await f.goto(one('u2'));
      await profileReady(page);
      f.eq(await count(page, '#cus-notes-empty'), 1, 'no notes yet');
      await page.click('[data-action="note-add"]');
      await errorText(page, 'text');
      f.eq(Object.keys(await f.docs('userPrivate/u2/notes/')).length, 0, 'an empty note is not stored');

      await page.fill('#f-text', '  Leave the parcel\n with the neighbour.  ');
      await page.click('[data-action="note-add"]');
      await wait(page, () => document.querySelectorAll('#cus-notes-list li.cus-note').length === 1);
      const stored = Object.values(await f.docs('userPrivate/u2/notes/'));
      f.eq(stored.length, 1, 'one note stored');
      f.eq([stored[0].text, stored[0].authorUid], ['Leave the parcel\nwith the neighbour.', 'sadm'], 'tidied, with the author');
      f.eq(await page.inputValue('#f-text'), '', 'the box is cleared for the next note');

      await page.fill('#f-text', 'Second note');
      await page.click('[data-action="note-add"]');
      await wait(page, () => document.querySelectorAll('#cus-notes-list li.cus-note').length === 2);
      f.ok((await text(page, '#cus-notes-list li:first-child')).includes('Second note'), 'the newest note is on top');
      f.eq(await auditsOf(f, /^customer\./), [['customer.note_add', 'u2', 'sadm', 'store_admin'], ['customer.note_add', 'u2', 'sadm', 'store_admin']], 'each note is audited');
      f.ok(!JSON.stringify(Object.values(await f.docs('auditLogs/'))).includes('neighbour'), 'the audit log never carries the note');
      await snap(f, 'admin-customer-notes');

      await page.click('#cus-notes-list li:first-child [data-action="note-del"]');
      await page.click(YES);
      await wait(page, () => document.querySelectorAll('#cus-notes-list li.cus-note').length === 1);
      const left = Object.values(await f.docs('userPrivate/u2/notes/'));
      f.eq(left.map((n) => n.text), ['Leave the parcel\nwith the neighbour.'], 'the right note was deleted');
      f.eq((await auditsOf(f, /^customer\.note_delete$/)).length, 1, 'the deletion is audited');
    },
  },
  {
    name: 'admin customers newsletter: subscribers newest first, searchable, removable (audited without the full address); both exports leave an audit entry', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.put('newsletter/anna@example.com', subscriber('anna@example.com', 'home', 3 * 86400000));
      await f.put('newsletter/bob@example.org', subscriber('bob@example.org', 'footer', 86400000));
      await f.put('newsletter/cara@example.com', subscriber('cara@example.com', 'custom-form', 3600000));
      await f.goto(LIST);
      await settledList(page);
      await page.click('#cus-tab-newsletter');
      await rowCount(page, 3);
      f.eq(await names(page), ['cara@example.com', 'bob@example.org', 'anna@example.com'], 'newest first');
      f.eq(latin(await page.locator('#cus-tab-newsletter .cus-n').innerText()), '3', 'the tab counts them');
      await snap(f, 'admin-customers-newsletter');
      await page.fill('#q', 'example.org');
      await shows(page, ['bob@example.org']);
      await page.fill('#q', '');
      await shows(page, ['cara@example.com', 'bob@example.org', 'anna@example.com']);

      const [subs] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
      f.ok(/^subscribers-newsletter-\d{4}-\d{2}-\d{2}\.csv$/.test(subs.suggestedFilename()), `file name: ${subs.suggestedFilename()}`);
      const csv = fs.readFileSync(await subs.path(), 'utf8');
      f.ok(csv.includes('E-mail,Source,Subscribed (Dhaka)'), 'the sheet has its columns');
      f.ok(['cara@example.com', 'bob@example.org', 'anna@example.com'].every((e) => csv.includes(e)), 'every subscriber is in it');
      f.eq(await auditsOf(f, /\.export$/), [['newsletter.export', 'csv', 'sa', 'super_admin']], 'the export is audited');
      f.eq(Object.values(await f.docs('auditLogs/')).find((a) => a.action === 'newsletter.export').after, { count: 3 }, 'with the number of rows, not the data');

      await page.click('#cus-tab-all');
      await rowCount(page, 3);
      const [all] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
      const csv2 = fs.readFileSync(await all.path(), 'utf8');
      f.ok(csv2.includes('Name,E-mail,Phone,Joined (Dhaka),Last order (Dhaka),Status,Restriction reason,Customer ID'), 'the customer sheet has its columns');
      f.ok(csv2.includes('rahim@example.com') && csv2.includes('karim@example.com'), 'both customers are in it');
      f.eq((await auditsOf(f, /^customer\.export$/)).length, 1, 'the customer export is audited too');

      await page.click('#cus-tab-newsletter');
      await rowCount(page, 3);
      await page.click('[data-action="unsub"][data-id="bob@example.org"]');
      await page.click(YES);
      await rowCount(page, 2);
      f.eq(await f.doc('newsletter/bob@example.org'), null, 'the subscriber is gone');
      f.eq(await names(page), ['cara@example.com', 'anna@example.com'], 'and gone from the list');
      const removed = Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'newsletter.remove');
      f.eq(removed.length, 1, 'the removal is audited');
      f.ok(!JSON.stringify(removed).includes('bob@example.org'), 'without keeping the full address');
    },
  },
  {
    name: 'admin customers: Customer Support reads everything but cannot restrict, write notes, remove subscribers or export', as: 'cs',
    async run(f) {
      const { page } = f;
      await f.put('userPrivate/u1/notes/n1', note('Prefers calls after 5 pm.'));
      await f.put('newsletter/anna@example.com', subscriber('anna@example.com', 'home', 86400000));
      await f.goto(LIST);
      await settledList(page);
      f.eq(await rows(page), 3, 'the customers are listed (and your own profile)');
      f.eq(await count(page, '[data-action="export"]'), 0, 'no export');
      await page.click('#cus-tab-newsletter');
      await rowCount(page, 1);
      f.eq(await count(page, '[data-action="unsub"]'), 0, 'no remove button');

      await f.goto(one('u1'));
      await profileReady(page);
      f.eq(await count(page, '#cus-orders-table tbody tr'), 1, 'orders are visible');
      f.eq(await count(page, '#cus-tickets-list li'), 1, 'support requests are visible');
      f.eq(await count(page, '#cus-notes-list li.cus-note'), 1, 'the note is readable');
      f.eq(await count(page, 'form[data-form="note"]'), 0, 'but there is no box to write one');
      f.eq(await count(page, '#cus-note-form .alert-info'), 1, 'a hint says so');
      f.eq(await count(page, '[data-action="note-del"]'), 0, 'no delete button');
      f.eq(await count(page, '[data-action="restrict"]'), 0, 'no restrict button');
    },
  },
  {
    name: 'admin customers: the Order Manager reads the profile (orders and requests) but changes nothing', as: 'om',
    async run(f) {
      const { page } = f;
      await f.goto(one('u2'));
      await profileReady(page);
      f.eq(await count(page, '#cus-orders-table tbody tr'), 1, 'the order is visible');
      f.eq(await count(page, '[data-action="restrict"], [data-action="note-add"], [data-action="note-del"]'), 0, 'no way to change anything');
    },
  },
  {
    name: 'admin customer: an unknown customer says so and links back', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.goto(one('nobody'));
      await wait(page, () => !!document.querySelector('.cus .back-link'));
      f.eq(await count(page, '#cus-head'), 0, 'no profile is drawn');
      f.eq(await count(page, '.cus .empty'), 1, 'an explanation instead');
      f.ok((await page.locator('.cus .back-link').getAttribute('href')).endsWith('#/customers'), 'a link back to the list');
    },
  },
  ...['pm', 'im', 'rp'].map((as) => ({
    name: `admin customers: the ${as === 'pm' ? 'Product Manager' : as === 'im' ? 'Inventory Manager' : 'Reporting'} role cannot open the page`, as,
    async run(f) {
      await f.goto(LIST);
      await f.page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await count(f.page, '#cus-table'), 0, 'no customer is shown');
    },
  })),
];
