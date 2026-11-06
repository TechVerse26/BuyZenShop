/*
 * "My account" click-through scenarios (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   u1  Rahim · saved address a1 (default) · order SV-261025-AB12CD (COD, pending: p1 × 2 + p5 × 1)
 *       notifications n1 (unread, links to that order), n2 (unread), n3 (read)
 *       ticket TK-261026-AAAAAA answered by the team (message m1)
 */
import { ready, placeAndWait, cartLines, text, DLG, YES } from './helpers.mjs';

const ORDER = 'SV-261025-AB12CD';
const TICKET = 'TK-261026-AAAAAA';
const lastSegment = (page) => decodeURIComponent(new URL(page.url()).pathname.split('/').pop());
const count = (page, sel) => page.locator(sel).count();

export const accountFlows = [
  {
    name: 'account: profile is validated, saved and shown', as: 'u1',
    async run(f) {
      const { page } = f;
      const SUBMIT = 'form[data-form="profile"] [type="submit"]';
      await f.goto('/account');
      await page.waitForSelector('form[data-form="profile"]');
      await page.fill('#f-displayName', '');
      await page.click(SUBMIT);
      f.ok((await text(page, '#err-displayName')).length > 3, 'an empty name is refused');
      f.eq((await f.doc('users/u1')).displayName, 'Rahim', 'nothing was written while the form was invalid');
      await page.fill('#f-displayName', 'Rahim Uddin');
      await page.fill('#f-phone', '01911223344');
      await page.uncheck('#f-notifyEmail');
      await page.click(SUBMIT);
      f.ok(await f.until(async () => (await f.doc('users/u1')).displayName === 'Rahim Uddin'), 'the name was saved');
      const u = await f.doc('users/u1');
      f.eq([u.phone, u.notifyPrefs], ['01911223344', { email: false }], 'phone and the e-mail preference were saved');
      f.ok((await text(page, '.acc-hello-text h2')).includes('Rahim Uddin'), 'the greeting shows the new name');
      f.eq(await text(page, '.acc-avatar'), 'RU', 'the avatar initials follow the name');
    },
  },

  {
    name: 'account: address book — add, default, edit, delete', as: 'u1',
    async run(f) {
      const { page } = f;
      const addresses = async () => f.docs('users/u1/addresses/');
      await f.goto('/account/addresses');
      await page.waitForSelector('.adr-card');
      f.eq(await count(page, '.adr-card'), 1, 'one saved address');
      f.ok((await text(page, '.adr-card.is-default')).includes('Home'), 'it is the default one');

      /* add — invalid first */
      await page.click('[data-action="add"]');
      await page.waitForSelector(`${DLG} form`);
      f.eq(await count(page, `${DLG} #f-isDefault`), 1, 'a second address can be made the default');
      await page.click(YES);
      for (const n of ['name', 'phone', 'district', 'line1']) f.ok((await text(page, `#err-${n}`)).length > 3, `${n} error is shown`);
      f.eq(Object.keys(await addresses()).length, 1, 'nothing was written while the form was invalid');
      await page.fill('#f-label', 'Office');
      await page.fill('#f-name', 'Salma Akter');
      await page.fill('#f-phone', '01812-345678');
      await page.selectOption('#f-district', 'Dhaka');
      await page.fill('#f-line1', 'Flat 4B, House 9, Road 5, Dhanmondi');
      await page.check('#f-isDefault');
      await page.click(YES);
      await page.waitForFunction(() => document.querySelectorAll('.adr-card').length === 2);
      let all = await addresses();
      const newId = Object.keys(all).find((k) => k !== 'users/u1/addresses/a1');
      f.eq([all[newId].label, all[newId].phone, all[newId].district, all[newId].isDefault], ['Office', '01812345678', 'Dhaka', true], 'the new address is stored (phone normalised) and is the default');
      f.eq(all['users/u1/addresses/a1'].isDefault, false, 'the previous default was cleared');
      f.eq((await f.doc('users/u1')).defaultAddressId, newId.split('/').pop(), 'the profile points at the new default');
      f.ok((await text(page, '.adr-card.is-default')).includes('Office'), 'the Office card carries the default badge');

      /* make the old one default again */
      await page.click('.adr-card:not(.is-default) [data-action="default"]');
      await page.waitForFunction(() => /Home/.test(document.querySelector('.adr-card.is-default')?.textContent || ''));
      f.eq((await f.doc('users/u1')).defaultAddressId, 'a1', 'default switched back to Home');

      /* edit the default one: there is no "make default" box for it */
      await page.click('.adr-card.is-default [data-action="edit"]');
      await page.waitForSelector(`${DLG} form`);
      f.eq(await count(page, `${DLG} #f-isDefault`), 0, 'the default address has no "make default" box');
      f.eq(await page.inputValue('#f-district'), 'Sirajganj', 'the form is pre-filled');
      await page.fill('#f-label', 'Family home');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc('users/u1/addresses/a1')).label === 'Family home'), 'the edit was saved');
      f.eq((await f.doc('users/u1/addresses/a1')).isDefault, true, 'it is still the default');

      /* delete the other one, then the last one */
      await page.waitForFunction(() => /Family home/.test(document.querySelector('.adr-card.is-default')?.textContent || ''));
      await page.click('.adr-card:not(.is-default) [data-action="del"]');
      await page.click(YES);
      await page.waitForFunction(() => document.querySelectorAll('.adr-card').length === 1);
      f.eq(Object.keys(await addresses()).length, 1, 'the Office address was deleted');
      await page.click('.adr-card [data-action="del"]');
      await page.click(YES);
      await page.waitForSelector('.empty');
      f.eq(Object.keys(await addresses()).length, 0, 'the last address was deleted');
      f.eq((await f.doc('users/u1')).defaultAddressId, undefined, 'the profile no longer points at a deleted address');
    },
  },

  {
    name: 'account: notifications — read, open an order, mark all, delete', as: 'u1',
    async run(f) {
      const { page } = f;
      const unread = () => count(page, '.ntf.is-unread');
      const read = async (id) => (await f.doc(`users/u1/notifications/${id}`) || {}).read;
      await f.goto('/account/notifications');
      await page.waitForSelector('.ntf');
      f.eq([await count(page, '.ntf'), await unread()], [3, 2], 'three notifications, two unread');

      await page.click('[data-action="read"][data-id="n2"]');
      f.ok(await f.until(async () => (await read('n2')) === true), 'marking one read is stored');
      f.ok(await f.until(async () => (await unread()) === 1), 'the list updates live');

      await page.click('a[data-action="open"][data-id="n1"]');
      await page.waitForURL(new RegExp(`/account/orders/${ORDER}$`), { timeout: 8000 });
      f.ok(await f.until(async () => (await read('n1')) === true), 'opening the linked order marks the notification read');

      await f.patch('users/u1/notifications/n3', 'd.read = false;');
      await f.goto('/account/notifications');
      await page.waitForSelector('.ntf');
      f.eq(await unread(), 1, 'one unread again');
      await page.click('[data-action="readAll"]');
      f.ok(await f.until(async () => (await read('n3')) === true), 'mark all as read is stored');
      f.ok(await f.until(async () => (await count(page, '[data-action="readAll"]')) === 0), 'the "mark all" button goes away');

      await page.click('[data-action="del"][data-id="n3"]');
      f.ok(await f.until(async () => (await f.doc('users/u1/notifications/n3')) === null), 'a deleted notification is gone');
      f.eq(await count(page, '.ntf'), 2, 'two notifications remain');
    },
  },

  {
    name: 'account: support — new request, conversation, reply', as: 'u1',
    async run(f) {
      const { page } = f;
      const tickets = async () => Object.keys(await f.docs('supportTickets/')).filter((k) => k.split('/').length === 2);
      await f.goto('/account/support');
      await page.waitForSelector('.tk-row');
      f.eq(await count(page, '.tk-row'), 1, 'the seeded request is listed');
      f.ok((await text(page, '.tk-flag')).length > 3, 'a reply from the team is flagged');

      await page.click('[data-action="new"]');
      await page.waitForSelector(`${DLG} form`);
      f.eq(await page.inputValue('#f-phone'), '01711111111', 'the phone number is pre-filled from the profile');
      await page.click(YES);
      f.ok((await text(page, '#err-subject')).length > 3, 'subject error is shown');
      f.ok((await text(page, '#err-message')).length > 3, 'message error is shown');
      f.eq((await tickets()).length, 1, 'nothing was written while the form was invalid');
      await page.fill('#f-subject', 'Wrong size delivered');
      await page.fill('#f-message', 'I ordered size 42 but received 41.\nPlease advise.');
      await page.selectOption('#f-orderNumber', ORDER);
      await page.click(YES);
      await page.waitForURL(/\/account\/support\/TK-/, { timeout: 8000 });
      const id = lastSegment(page);
      const tk = await f.doc(`supportTickets/${id}`);
      if (!f.ok(tk, 'the request was stored')) return;
      f.eq([tk.userId, tk.status, tk.priority, tk.lastAuthor, tk.subject, tk.orderNumber, tk.email, tk.phone],
        ['u1', 'open', 'normal', 'customer', 'Wrong size delivered', ORDER, 'rahim@example.com', '01711111111'], 'ticket fields');
      await page.waitForSelector('.tk-msg');
      f.eq(await count(page, '.tk-msg'), 1, 'the conversation starts with the customer\'s own message');
      f.ok((await text(page, '.tk-msg-text')).includes('received 41'), 'the message text is shown');

      await page.click('form[data-form="reply"] [type="submit"]');
      f.ok((await text(page, '#err-text')).length > 3, 'an empty reply is refused');
      await page.fill('#f-text', 'Any update?');
      await page.click('form[data-form="reply"] [type="submit"]');
      await page.waitForFunction(() => document.querySelectorAll('.tk-msg').length === 2);
      const msgs = await f.docs(`supportTickets/${id}/messages/`);
      f.eq(Object.values(msgs).map((m) => [m.authorType, m.authorUid, m.text]), [['customer', 'u1', 'Any update?']], 'the reply was stored');
    },
  },

  {
    name: 'account: support — a reply from the team, a closed request is re-opened', as: 'u1',
    async run(f) {
      const { page } = f;
      const path = `supportTickets/${TICKET}`;
      await f.goto(`/account/support/${TICKET}`);
      await page.waitForSelector('.tk-msg');
      f.eq(await count(page, '.tk-msg'), 2, 'the customer\'s message and the team reply');
      f.eq([await count(page, '.tk-msg.is-me'), await count(page, '.tk-msg.is-staff')], [1, 1], 'one message from each side');
      f.ok((await text(page, '.tk-msg.is-staff')).includes('ships tomorrow'), 'the team reply is shown');
      await page.fill('#f-text', 'Thank you!');
      await page.click('form[data-form="reply"] [type="submit"]');
      await page.waitForFunction(() => document.querySelectorAll('.tk-msg').length === 3);
      f.eq([(await f.doc(path)).status, (await f.doc(path)).lastAuthor], ['open', 'customer'], 'a reply re-opens an answered request');

      await f.patch(path, "d.status = 'closed'; d.lastAuthor = 'staff';");
      await f.goto(`/account/support/${TICKET}`);
      await page.waitForSelector('.tk-msg');
      await page.fill('#f-text', 'One more question.');
      await page.click('form[data-form="reply"] [type="submit"]');
      await page.waitForFunction(() => document.querySelectorAll('.tk-msg').length === 4);
      f.eq([(await f.doc(path)).status, (await f.doc(path)).lastAuthor], ['open', 'customer'], 'a reply re-opens a closed request');
    },
  },

  {
    name: 'account: support — "contact support" from an order pre-fills the form', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.goto(`/account/support?order=${ORDER}`);
      await page.waitForSelector(`${DLG} form`);
      f.eq(await page.inputValue('#f-orderNumber'), ORDER, 'the order is pre-selected');
      f.ok((await page.inputValue('#f-subject')).includes(ORDER), 'the subject mentions the order');
      f.ok(!page.url().includes('order='), 'the query string is cleared so a reload does not reopen the form');
      await page.fill('#f-message', 'Please call me before delivery.');
      await page.click(YES);
      await page.waitForURL(/\/account\/support\/TK-/, { timeout: 8000 });
      f.eq((await f.doc(`supportTickets/${lastSegment(page)}`)).orderNumber, ORDER, 'the ticket refers to the order');
    },
  },

  {
    name: 'account: support — a request that is not yours is not shown', as: 'u1', denied: true,
    async run(f) {
      const { page } = f;
      await f.goto('/account/support/TK-000000-ZZZZZZ');
      await page.waitForSelector('.empty');
      f.eq(await count(page, 'form[data-form="reply"]'), 0, 'no reply form for a request that cannot be read');
    },
  },

  {
    name: 'account: a pending order can be cancelled and its stock is released', as: 'u1',
    async run(f) {
      const { page } = f;
      const inv0 = await f.docs('inventory/');
      await f.goto(`/account/orders/${ORDER}`);
      await page.waitForSelector('[data-action="cancel"]');
      await page.click('[data-action="cancel"]');
      await page.waitForSelector(`${DLG} select[name="reason"]`);
      await page.selectOption(`${DLG} select[name="reason"]`, 'Ordered by mistake');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc(`orders/${ORDER}`)).status === 'cancelled'), 'the order is cancelled');
      const o = await f.doc(`orders/${ORDER}`);
      f.eq(o.cancelReason, 'Ordered by mistake', 'the reason is stored');
      const inv1 = await f.docs('inventory/');
      f.eq(inv0['inventory/p1'].reserved - inv1['inventory/p1'].reserved, 2, 'p1 stock released');
      f.eq(inv0['inventory/p5'].reserved - inv1['inventory/p5'].reserved, 1, 'p5 stock released');
      f.ok(await f.until(async () => (await count(page, '[data-action="cancel"]')) === 0), 'the cancel button is gone after cancelling');
    },
  },

  {
    name: 'account: an order that is already confirmed cannot be cancelled online', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.patch(`orders/${ORDER}`, "d.status = 'confirmed';");
      await f.goto(`/account/orders/${ORDER}`);
      await page.waitForSelector('[data-action="invoice"]');
      f.eq(await count(page, '[data-action="cancel"]'), 0, 'no cancel button');
      f.eq(await count(page, '[data-action="return"]'), 0, 'no return button before delivery');
    },
  },

  {
    name: 'account: a delivered order can be returned inside the window', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.patch(`orders/${ORDER}`, "d.status = 'delivered'; d.deliveredAt = Ts.fromMillis(Date.now() - 2 * 86400000);");
      await f.goto(`/account/orders/${ORDER}`);
      await page.waitForSelector('[data-action="return"]');
      f.eq(await count(page, '[data-action="cancel"]'), 0, 'a delivered order has no cancel button');
      await page.click('[data-action="return"]');
      await page.waitForSelector(`${DLG} input[name="line"]`);
      await page.click(YES);
      f.ok((await text(page, '#err-lines')).length > 3, 'choosing no item is refused');
      f.ok((await text(page, '#err-reason')).length > 3, 'choosing no reason is refused');
      f.eq(await f.doc(`returns/${ORDER}`), null, 'nothing was written while the form was invalid');
      await page.check(`${DLG} input[name="line"][value="p1"]`);
      await page.selectOption(`${DLG} select[name="qty-p1"]`, '1');
      await page.selectOption(`${DLG} select[name="reason"]`, 'Damaged or defective');
      await page.fill(`${DLG} textarea[name="details"]`, 'The seam came apart after one wash.');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc(`orders/${ORDER}`)).status === 'return_requested'), 'the order moves to "return requested"');
      const r = await f.doc(`returns/${ORDER}`);
      if (!f.ok(r, 'the return request was stored')) return;
      f.eq([r.userId, r.status, r.reason, r.lines], ['u1', 'requested', 'Damaged or defective', [{ key: 'p1', qty: 1 }]], 'return fields');
      f.ok(await f.until(async () => (await count(page, '[data-action="return"]')) === 0), 'the return button is gone afterwards');
    },
  },

  {
    name: 'account: returns are not offered after the return window', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.patch(`orders/${ORDER}`, 'd.status = "delivered"; d.deliveredAt = Ts.fromMillis(Date.now() - 10 * 86400000);');
      await f.goto(`/account/orders/${ORDER}`);
      await page.waitForSelector('[data-action="invoice"]');
      f.eq(await count(page, '[data-action="return"]'), 0, 'ten days after delivery the 7-day window has closed');
    },
  },

  {
    name: 'account: a failed mobile-money payment can be sent again', as: 'u1', cart: [{ key: 'p1', qty: 1 }], denied: true,
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      await page.check('input[name="method"][value="bkash"]');
      await page.fill('#f-senderNumber', '01812345678');
      await page.fill('#f-trxId', 'OLD1TRX23');
      const n = await placeAndWait(page);
      await f.patch(`orders/${n}`, "d.payment.status = 'failed';");              // staff could not find the money
      await f.goto(`/account/orders/${n}`);
      await page.waitForSelector('form[data-form="payagain"]');
      const SEND = 'form[data-form="payagain"] [type="submit"]';

      await page.click(SEND);
      f.ok((await text(page, '#err-trxId')).length > 3, 'an empty TrxID is refused');
      await page.fill('#f-senderNumber', '01812345678');
      await page.fill('#f-trxId', '8N7A6D5C4B');                                  // belongs to another customer's order
      await page.click(SEND);
      f.ok(await f.until(async () => (await count(page, '.toast-bad')) > 0), 'a message explains that the TrxID was refused');
      f.eq((await f.doc(`orders/${n}`)).payment.status, 'failed', 'the order is unchanged');

      await page.fill('#f-trxId', 'new9-trx88');
      await page.click(SEND);
      f.ok(await f.until(async () => (await f.doc(`orders/${n}`)).payment.status === 'awaiting_verification'), 'the corrected payment is awaiting verification again');
      const o = await f.doc(`orders/${n}`);
      f.eq([o.payment.trxId, o.payment.senderNumber], ['NEW9TRX88', '01812345678'], 'new TrxID stored in normal form');
      f.eq((await f.doc('paymentTrx/NEW9TRX88') || {}).orderId, n, 'the new TrxID is reserved for this order');
      f.ok(await f.until(async () => (await count(page, 'form[data-form="payagain"]')) === 0), 'the form is gone after sending');
    },
  },

  {
    name: 'account: buy again puts the items back in the cart', as: 'u1',
    async run(f) {
      const { page } = f;
      await f.goto(`/account/orders/${ORDER}`);
      await page.waitForSelector('[data-action="again"]');
      f.eq(await cartLines(page), 0, 'the cart starts empty');
      await page.click('[data-action="again"]');
      await page.waitForURL(/\/cart$/, { timeout: 8000 });
      f.eq(await cartLines(page), 2, 'both lines of the order are in the cart');
    },
  },
];

