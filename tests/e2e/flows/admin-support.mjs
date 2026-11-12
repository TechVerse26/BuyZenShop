/*
 * Admin "Support" (the queue and one request), clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs + these requests
 *   open      URG    guest, urgent, "Payment not showing" (1 hour)         OLD    Karim (account), order SV-261026-EF34GH, 3 conversation messages (3 days; waiting since yesterday)
 *             PHN    guest with only a phone number (5 hours)              NEW    Rahim (account) "Change address" (20 minutes)
 *   answered  the fixture's "Delivery question"                            closed  CLS  "Old question"
 *   queue order: urgent first, then the longest waiting → URG, OLD, PHN, NEW
 *   roles: cs Customer Support · sadm Store Admin · sa Super Admin (answer) · om Order Manager (reads) · pm / im / rp may not open it
 */
import { text, snap } from './helpers.mjs';

const LIST = '/admin/#/support';
const H = 3600000;
const D = 86400000;
const ID = { old: 'TK-261101-OLD111', urgent: 'TK-261104-URG222', fresh: 'TK-261105-NEW333', phone: 'TK-261105-PHN555', closed: 'TK-261030-CLS444' };
const ROW = '#tkm-table tbody tr';
const wait = (page, fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 8000 });
const settled = (page) => wait(page, () => { const r = document.querySelector('#tkm-results'); return !!r && !r.querySelector('.spinner'); });
const ago = (ms) => `new Ts(Date.now() - ${ms})`;
const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const audits = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => /^ticket\./.test(a.action))
  .map((a) => [a.action, a.entityId, a.actorUid, a.actorRole]).sort(byJson);
const ticket = (over) => `({ userId: 'u1', name: 'Rahim', email: 'rahim@example.com', phone: '01711111111', subject: 'S', message: 'M', orderNumber: '',
  status: 'open', priority: 'normal', lastAuthor: 'customer', createdAt: ${ago(D)}, updatedAt: ${ago(D)}, ...${over} })`;

async function seed(f) {
  await f.put(`supportTickets/${ID.old}`, ticket(`{ userId: 'u2', name: 'Karim', email: 'karim@example.com', phone: '01822222222', subject: 'Refund for wallet',
    message: 'I want to return the wallet.\\nHow do I do it?', orderNumber: 'SV-261026-EF34GH', createdAt: ${ago(3 * D)}, updatedAt: ${ago(D)} }`));
  await f.put(`supportTickets/${ID.old}/messages/m1`, `({ authorType: 'staff', authorUid: 'cs', text: 'Please send us a photo of the wallet.', createdAt: ${ago(2 * D)} })`);
  await f.put(`supportTickets/${ID.old}/messages/m2`, `({ authorType: 'customer', authorUid: 'u2', text: 'I sent the photo by e-mail.', createdAt: ${ago(D)} })`);
  await f.put(`supportTickets/${ID.urgent}`, ticket(`{ userId: null, name: 'Guest Gita', email: 'gita@example.com', phone: '', subject: 'Payment not showing',
    message: 'I paid by bKash but the order is still unpaid.', priority: 'urgent', createdAt: ${ago(H)}, updatedAt: ${ago(H)} }`));
  await f.put(`supportTickets/${ID.phone}`, ticket(`{ userId: null, name: 'Phone Pia', email: '', phone: '01833333333', subject: 'Call me please',
    message: 'I prefer a phone call.', createdAt: ${ago(5 * H)}, updatedAt: ${ago(5 * H)} }`));
  await f.put(`supportTickets/${ID.fresh}`, ticket(`{ subject: 'Change address', message: 'Can I change my delivery address?', createdAt: ${ago(H / 3)}, updatedAt: ${ago(H / 3)} }`));
  await f.put(`supportTickets/${ID.closed}`, ticket(`{ subject: 'Old question', message: 'Do you ship to Dhaka?', status: 'closed', lastAuthor: 'staff', createdAt: ${ago(5 * D)}, updatedAt: ${ago(4 * D)} }`));
  await f.put(`supportTickets/${ID.closed}/messages/m1`, `({ authorType: 'staff', authorUid: 'cs', text: 'Yes, we do.', createdAt: ${ago(4 * D)} })`);
}
const field = async (f, id) => f.doc(`supportTickets/${id}`);
const messagesOf = async (f, id) => Object.values(await f.docs(`supportTickets/${id}/messages/`));
const tsMs = (v) => (v && (v.ms ?? v.__ts ?? null));

async function openList(f) {
  await seed(f);
  await f.goto(LIST);
  await f.page.waitForSelector('#tkm-tabs-wrap [role="tab"]', { timeout: 12000 });
  await settled(f.page);
}
async function openTicket(f, id) {
  await seed(f);
  await f.goto(`/admin/#/support/${id}`);
  await f.page.waitForSelector('#tkm-thread .tkm-msg', { timeout: 12000 });
}
async function go(f, tab) {
  await f.page.click(`#tkm-tab-${tab}`);
  await wait(f.page, (k) => document.querySelector(`#tkm-tab-${k}`)?.getAttribute('aria-selected') === 'true' && !document.querySelector('#tkm-results .spinner'), tab);
}
const subjects = (page) => page.locator(`${ROW} .tkm-subject`).allInnerTexts();
const bubbles = (page) => page.locator('#tkm-thread .tkm-msg').evaluateAll((els) => els.map((el) => [el.classList.contains('is-staff') ? 'staff' : 'customer', el.querySelector('.tkm-msg-text').textContent.trim()]));
const reply = async (page, value) => { await page.fill('#f-text', value); };

export const adminSupportFlows = [
  {
    name: 'admin support: the open queue lists urgent first, then the longest waiting; every row says who, how to reach them and whether they have an account', as: 'cs',
    async run(f) {
      const { page } = f;
      await openList(f);
      f.eq(await subjects(page), ['Payment not showing', 'Refund for wallet', 'Call me please', 'Change address'], 'urgent, then the longest waiting');
      f.eq(await page.locator('#tkm-tab-open .tkm-n').innerText(), '4', 'the open tab counts them');
      f.eq(await page.locator('#tkm-tab-answered .tkm-n').count(), 0, 'a list that has not been opened has no number');
      const first = page.locator(ROW).nth(0);
      f.eq(await first.locator('.badge-bad').count(), 1, 'the urgent badge');
      f.ok((await first.innerText()).includes(ID.urgent) && (await first.innerText()).includes('gita@example.com'), 'ticket number and contact');
      f.ok((await first.innerText()).includes('No account') || (await first.innerText()).includes('অ্যাকাউন্ট নেই'), 'a guest is marked');
      const second = page.locator(ROW).nth(1);
      f.ok((await second.innerText()).includes('SV-261026-EF34GH'), 'the order number is shown');
      f.eq(await second.locator('.badge').count(), 1, 'a customer with an account has no "no account" badge — only the priority');
      f.eq(await page.locator(`${ROW} a.tkm-subject`).first().getAttribute('href'), `/admin/#/support/${ID.urgent}`, 'the subject opens the request');
      await snap(f, 'admin-support-list');
      f.eq(await audits(f), [], 'looking changes nothing');
    },
  },
  {
    name: 'admin support: search (subject, message, name, e-mail, phone, ticket and order number), the priority filter and the Answered / Closed tabs', as: 'sa',
    async run(f) {
      const { page } = f;
      await openList(f);
      const search = async (v) => { await page.fill('#q', v); await page.waitForTimeout(450); };
      await search('gita@example');
      f.eq(await subjects(page), ['Payment not showing'], 'by e-mail');
      await search('wallet');
      f.eq(await subjects(page), ['Refund for wallet'], 'by subject / message');
      await search('SV-261026');
      f.eq(await subjects(page), ['Refund for wallet'], 'by order number');
      await search('01833');
      f.eq(await subjects(page), ['Call me please'], 'by phone');
      await search('karim');
      f.eq(await subjects(page), ['Refund for wallet'], 'by name');
      await search(ID.fresh.toLowerCase());
      f.eq(await subjects(page), ['Change address'], 'by ticket number');
      await search('nothing like this');
      f.eq(await page.locator('#tkm-results .empty').count(), 1, '"nothing matches"');
      await search('');
      await page.selectOption('#tkm-priority', 'urgent');
      f.eq(await subjects(page), ['Payment not showing'], 'priority filter');
      await page.selectOption('#tkm-priority', '');
      await go(f, 'answered');
      f.eq(await subjects(page), ['Delivery question'], 'the fixture\'s answered request');
      await go(f, 'closed');
      f.eq(await subjects(page), ['Old question']);
      f.eq(await page.locator('#tkm-tab-closed .tkm-n').innerText(), '1');
      f.eq(await page.locator('#tkm-tab-open .tkm-n').innerText(), '4', 'the counts stay');
      await go(f, 'open');
      f.eq((await subjects(page)).length, 4, 'back on the open tab nothing leaked from the filters');
    },
  },
  {
    name: 'admin support: a request shows the whole conversation, who wrote it, how to reach the customer and the order; a guest is warned that replies cannot be read here', as: 'cs',
    async run(f) {
      const { page } = f;
      await openTicket(f, ID.old);
      f.eq(await bubbles(page), [['customer', 'I want to return the wallet.\nHow do I do it?'], ['staff', 'Please send us a photo of the wallet.'], ['customer', 'I sent the photo by e-mail.']], 'oldest first, the first message first');
      f.ok((await text(page, '#tkm-thread .is-customer strong')).includes('Karim'), 'the customer is named');
      f.eq(await page.locator('.tkm-msg.is-staff strong').innerText(), await page.locator('.tkm-msg.is-staff strong').innerText());
      f.eq(await page.locator('.tkm-msg.is-staff strong').count(), 1);
      f.eq(await page.locator('#tkm-side a[href="mailto:karim@example.com"]').count(), 1, 'e-mail link');
      f.eq(await page.locator('#tkm-side a[href="tel:01822222222"]').count(), 1, 'phone link');
      f.eq(await page.locator('#tkm-side a[href*="/orders/SV-261026-EF34GH"]').count(), 1, 'link to the order');
      f.eq(await page.locator('#tkm-side a[href*="/customers/u2"]').count(), 1, 'link to the customer (Customer Support may read customers)');
      f.eq([await page.inputValue('#f-status'), await page.inputValue('#f-priority')], ['open', 'normal'], 'selectors show the stored values');
      f.eq(await page.locator('#tkm-hint .alert-warn').count(), 0, 'an account holder reads replies in their account');
      f.eq(await page.locator('input[name="email"]').isChecked(), false, 'no e-mail by default');
      await snap(f, 'admin-support-ticket');

      await f.goto(`/admin/#/support/${ID.urgent}`);
      await page.waitForSelector('#tkm-thread .tkm-msg', { timeout: 12000 });
      await wait(page, (id) => document.querySelector('.tkm-badges') && document.querySelector('#tkm-head .mono')?.textContent === id, ID.urgent);
      f.eq(await page.locator('#tkm-hint .alert-warn').count(), 1, 'a guest cannot read replies here');
      f.eq(await page.locator('input[name="email"]').isChecked(), true, 'so the e-mail option is on by default');
      f.eq(await page.locator('#tkm-side .badge').count() >= 1, true, 'and the guest is marked');

      await f.goto(`/admin/#/support/${ID.phone}`);
      await wait(page, (id) => document.querySelector('#tkm-head .mono')?.textContent === id, ID.phone);
      f.eq(await page.locator('input[name="email"]').count(), 0, 'no address, no e-mail option');
      f.ok((await text(page, '#tkm-hint .alert-warn')).includes('01833333333'), 'the phone number is shown instead');
      f.eq(await audits(f), []);
    },
  },
  {
    name: 'admin support: replying answers the request, adds the message as staff, notifies a customer with an account, audits it — and the customer reads it in their account', as: 'cs',
    async run(f) {
      const { page } = f;
      await openTicket(f, ID.old);
      await page.click('[data-action="send"]');
      await page.waitForSelector('#err-text:not(:empty)', { timeout: 4000 });
      f.eq((await messagesOf(f, ID.old)).length, 2, 'an empty reply writes nothing');
      await reply(page, '  Thank you. We will arrange the pickup tomorrow.\n\nPlease keep the box.  ');
      f.ok((await text(page, '#tkm-count')).includes('2000'), 'the counter shows the limit');
      await page.click('[data-action="send"]');
      await wait(page, () => document.querySelectorAll('#tkm-thread .tkm-msg').length === 4);
      f.eq(await page.inputValue('#f-text'), '', 'the box is cleared');
      f.eq((await bubbles(page))[3], ['staff', 'Thank you. We will arrange the pickup tomorrow.\n\nPlease keep the box.'], 'tidied and shown as the team');
      f.eq(await page.locator('.tkm-msg.is-staff strong').last().innerText().then((s) => s.length > 0), true);
      const k = await field(f, ID.old);
      f.eq([k.status, k.lastAuthor, k.subject], ['answered', 'staff', 'Refund for wallet'], 'answered; nothing else changed');
      const msgs = (await messagesOf(f, ID.old)).filter((m) => m.text.startsWith('Thank you'));
      f.eq(msgs.map((m) => [m.authorType, m.authorUid]), [['staff', 'cs']], 'written under the staff uid');
      const notes = Object.values(await f.docs('users/u2/notifications/'));
      f.eq(notes.map((n) => [n.kind, n.ticketId, n.read]), [['support', ID.old, false]], 'the customer is told in the app');
      f.eq(Object.keys(await f.docs('mail/')).length, 0, 'no e-mail was asked for');
      f.eq(await audits(f), [['ticket.reply', ID.old, 'cs', 'customer_support']]);
      f.eq(await page.locator('#tkm-head .badge-info').count(), 1, 'the head says "answered"');
      f.eq(await page.locator('#f-status').inputValue(), 'answered', 'and so does the selector');

      // the customer's side
      await f.collect();
      await page.evaluate(() => { window.__MOCK__.signIn('u2'); location.assign('/account/notifications'); });
      await page.waitForSelector('.ntf a[href^="/account/support/"]', { timeout: 15000 });
      f.eq(await page.locator('.ntf a[href^="/account/support/"]').count(), 1, 'the notice links to the request');
      await page.click('.ntf a[href^="/account/support/"]');
      await page.waitForSelector('.tk-msg.is-staff', { timeout: 15000 });
      f.ok((await text(page, '.tk-msg.is-staff:last-of-type .tk-msg-text')).includes('arrange the pickup'), 'the customer reads the reply');
    },
  },
  {
    name: 'admin support: "send and close" to a guest queues the e-mail (the box is on by default), writes no in-app notice and closes the request', as: 'sadm',
    async run(f) {
      const { page } = f;
      await openTicket(f, ID.urgent);
      await reply(page, 'We found your payment and confirmed the order. Sorry for the wait.');
      await page.click('[data-action="send-close"]');
      await wait(page, () => document.querySelectorAll('#tkm-thread .tkm-msg').length === 2);
      const k = await field(f, ID.urgent);
      f.eq([k.status, k.lastAuthor], ['closed', 'staff']);
      const mails = Object.values(await f.docs('mail/'));
      f.eq(mails.length, 1, 'one e-mail is queued');
      f.eq(mails[0].to, ['gita@example.com'], 'to the guest');
      f.eq(mails[0].message.subject, `Re: Payment not showing [${ID.urgent}]`);
      f.ok(mails[0].message.text.includes('We found your payment') && mails[0].message.text.includes(`Reference: ${ID.urgent}`), 'the reply and the reference');
      f.eq([mails[0].kind, mails[0].refId, mails[0].queuedBy], ['ticket_reply', ID.urgent, 'sadm']);
      f.eq(Object.keys(await f.docs('users/')).filter((p) => p.includes('/notifications/') && p.includes('gita')).length, 0, 'a guest has no notifications');
      f.eq(await audits(f), [['ticket.reply', ID.urgent, 'sadm', 'store_admin']]);
      f.eq(await page.locator('#tkm-head .badge-neutral, #tkm-head .badge:not([class*="badge-"])').count() >= 1, true, 'closed');
      f.eq(await page.inputValue('#f-status'), 'closed');
      await snap(f, 'admin-support-closed');
    },
  },
  {
    name: 'admin support: status and priority are changed from the side panel — each is audited, priority leaves the last-activity time alone, and a closed request can be re-opened', as: 'sa',
    async run(f) {
      const { page } = f;
      await openTicket(f, ID.old);
      const before = tsMs((await field(f, ID.old)).updatedAt);
      await page.selectOption('#f-priority', 'high');
      await wait(page, () => document.querySelector('#f-priority')?.value === 'high' && !document.querySelector('#f-priority').disabled);
      const afterPriority = await field(f, ID.old);
      f.eq(afterPriority.priority, 'high');
      f.eq(tsMs(afterPriority.updatedAt), before, 'priority is not customer-visible activity');
      f.eq(await page.locator('#tkm-head .badge-warn').count(), 2, 'open (amber) and high (amber)');
      await page.selectOption('#f-status', 'closed');
      await wait(page, () => document.querySelector('#f-status')?.value === 'closed' && !document.querySelector('#f-status').disabled);
      const closed = await field(f, ID.old);
      f.eq(closed.status, 'closed');
      f.ok(tsMs(closed.updatedAt) > before, 'a status change is activity');
      await page.selectOption('#f-status', 'open');
      await wait(page, () => document.querySelector('#f-status')?.value === 'open' && !document.querySelector('#f-status').disabled);
      f.eq((await field(f, ID.old)).status, 'open', 're-opened');
      f.eq(await audits(f), [['ticket.priority', ID.old, 'sa', 'super_admin'], ['ticket.status', ID.old, 'sa', 'super_admin'], ['ticket.status', ID.old, 'sa', 'super_admin']].sort(byJson));
      f.eq(await page.locator('#toasts .toast-bad').count(), 0, 'no error');
    },
  },
  {
    name: 'admin support: an Order Manager can read a request but has no reply box and no selectors', as: 'om',
    async run(f) {
      const { page } = f;
      await openTicket(f, ID.old);
      f.eq((await bubbles(page)).length, 3, 'the conversation is there');
      f.eq(await page.locator('form[data-form="reply"]').count(), 0, 'no reply box');
      f.eq(await page.locator('#f-status, #f-priority').count(), 0, 'no selectors');
      f.eq(await page.locator('#tkm-reply .alert-info').count(), 1, 'a note says why');
      f.eq(await page.locator('#tkm-side a[href*="/customers/"]').count(), 1, 'the Order Manager may read customers');
      f.eq(await page.locator('#tkm-side a[href*="/orders/"]').count(), 1, 'and open the order');
      f.eq(await audits(f), []);
    },
  },
  {
    name: 'admin support: a request that does not exist says so', as: 'cs',
    async run(f) {
      await seed(f);
      await f.goto('/admin/#/support/TK-000000-NOPE00');
      await f.page.waitForSelector('.empty', { timeout: 12000 });
      f.eq(await f.page.locator('.tkm-msg').count(), 0, 'no conversation');
    },
  },
  ...['pm', 'im', 'rp'].flatMap((as) => ['/support', `/support/${ID.old}`].map((path) => ({
    name: `admin support: the ${as === 'pm' ? 'Product Manager' : as === 'im' ? 'Inventory Manager' : 'Reporting'} role cannot open ${path === '/support' ? 'the queue' : 'a request'}`, as,
    async run(f) {
      await f.goto(`/admin/#${path}`);
      await f.page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await f.page.locator('.tkm-msg, #tkm-table').count(), 0, 'nothing is shown');
    },
  }))),
];
