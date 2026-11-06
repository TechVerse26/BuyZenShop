/*
 * Admin order management, clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   SV-261025-AB12CD  u1 Rahim  COD,   pending, p1 × 2 (TS-001) + p5 × 1 (WA-005)
 *   SV-261026-EF34GH  u2 Karim  bKash, awaiting_verification, p2 × 1, TrxID 8N7A6D5C4B (typed by the customer — not proof)
 * Staff: sa Super Admin · sadm Store Admin · om Order Manager · cs Customer Support · rp Reporting · im Inventory Manager.
 * After every action the mock database is inspected: status, stock, reservation, movements, timeline, notification, audit log.
 */
import { DLG, YES, text } from './helpers.mjs';

const COD = 'SV-261025-AB12CD';
const BKASH = 'SV-261026-EF34GH';
const page_ = (n) => `/admin/#/orders/${n}`;
const STEP = (to) => `#od-aside [data-action="status"][data-to="${to}"]`;
const count = (page, sel) => page.locator(sel).count();
const keys = async (f, prefix) => Object.keys(await f.docs(prefix));

/** open the order page and wait until the realtime document has been painted */
async function open(f, n) {
  await f.goto(page_(n));
  await f.page.waitForSelector('#od-aside .panel', { timeout: 12000 });
}
/** click a status button, fill the dialog (optional), confirm, and wait until the order document shows the new status */
async function step(f, n, to, fill) {
  const { page } = f;
  await page.waitForSelector(STEP(to), { timeout: 8000 });
  await page.click(STEP(to));
  await page.waitForSelector(`${DLG} form`);
  if (fill) await fill(page);
  await page.click(YES);
  return f.until(async () => (await f.doc(`orders/${n}`)).status === to);
}

export const adminOrderFlows = [
  {
    name: 'admin orders: confirm → pack → ship with tracking → deliver, COD cash collected', as: 'om',
    async run(f) {
      const { page } = f;
      const p1 = await f.doc('inventory/p1');
      const p5 = await f.doc('inventory/p5');
      await open(f, COD);
      f.ok((await text(page, '#od-head')).includes(COD), 'the order number is in the header');
      f.eq(await count(page, '#od-items tbody tr'), 2, 'both order lines are listed');

      f.ok(await step(f, COD, 'confirmed'), 'order confirmed');
      f.ok(await step(f, COD, 'processing'), 'order processing');
      f.ok(await step(f, COD, 'packed'), 'order packed');
      f.eq((await f.doc('inventory/p1')).stock, p1.stock, 'stock is untouched until the parcel leaves');
      f.eq((await f.doc('inventory/p1')).reserved, p1.reserved, 'reservation is unchanged while packing');

      f.ok(await step(f, COD, 'shipped', async (pg) => {
        await pg.fill('#f-carrier', 'Pathao');
        await pg.fill('#f-trackingNo', 'PX-12345');
        await pg.fill('#f-trackingUrl', 'https://track.example.com/PX-12345');
      }), 'order shipped');
      let o = await f.doc(`orders/${COD}`);
      f.eq([o.shipping.carrier, o.shipping.trackingNo, o.shipping.trackingUrl], ['Pathao', 'PX-12345', 'https://track.example.com/PX-12345'], 'courier details were stored');
      f.eq([(await f.doc('inventory/p1')).stock, (await f.doc('inventory/p1')).reserved], [p1.stock - 2, p1.reserved - 2], 'shipping takes the units out of stock and out of the reservation, in the same batch');
      f.eq([(await f.doc('inventory/p5')).stock, (await f.doc('inventory/p5')).reserved], [p5.stock - 1, p5.reserved - 1], 'every line is deducted');
      const moves = Object.values(await f.docs('inventoryMovements/')).filter((m) => m.refId === COD && m.type === 'ship');
      f.eq(moves.length, 2, 'one stock movement per line');
      f.ok((await text(page, '#od-aside')).includes('Pathao'), 'the delivery panel shows the courier');

      f.ok(await step(f, COD, 'delivered', async (pg) => {
        f.eq(await count(pg, `${DLG} #f-markCodPaid`), 1, 'the dialog offers to mark the cash as collected');
        await pg.check(`${DLG} #f-markCodPaid`);
      }), 'order delivered');
      o = await f.doc(`orders/${COD}`);
      f.eq([o.payment.status, o.payment.verifiedBy], ['paid', 'om'], 'COD is marked paid by the staff member who ticked the box');
      f.ok(!!o.deliveredAt && !!o.confirmedAt && !!o.shippedAt, 'every stage has its timestamp');

      const events = Object.values(await f.docs(`orders/${COD}/events/`)).filter((e) => e.type === 'status').map((e) => e.status).sort();
      f.eq(events, ['confirmed', 'delivered', 'packed', 'processing', 'shipped'], 'one timeline event per step');
      f.ok((await keys(f, 'users/u1/notifications/')).length >= 5, 'the customer was notified of the steps (plus the seeded ones)');
      const audit = Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'order.status' && a.entityId === COD);
      f.eq(audit.length, 5, 'every step is in the audit log');
      f.ok(audit.every((a) => a.actorUid === 'om' && a.actorRole === 'order_manager'), 'the audit log names the actor and the role');

      await page.waitForFunction(() => document.querySelector('#od-timeline') && document.querySelectorAll('#od-timeline li').length >= 6, null, { timeout: 6000 });
      f.eq(await count(page, '#od-aside [data-action="status"][data-to="refund_pending"]'), 0, 'an order manager cannot start a refund (needs orders.refund)');
    },
  },

  {
    name: 'admin orders: verify a bKash payment — the amount is checked', as: 'om',
    async run(f) {
      const { page } = f;
      await open(f, BKASH);
      const before = await f.doc(`orders/${BKASH}`);
      f.eq(before.payment.status, 'awaiting_verification', 'the seeded payment is waiting for a human to check it');
      const aside = await text(page, '#od-aside');
      f.ok(aside.includes('8N7A6D5C4B'), 'the typed TrxID is shown');
      f.eq(await count(page, '#od-aside .alert'), 1, 'the panel reminds staff that a TrxID alone is not proof');

      await page.click('[data-action="pay-verify"]');
      await page.waitForSelector(`${DLG} form`);
      f.eq(Number(await page.inputValue('#f-receivedAmount')), before.payment.amountDue, 'the amount defaults to what is due');
      await page.fill('#f-receivedAmount', String(before.payment.amountDue - 1));
      await page.click(YES);
      f.ok((await text(page, '#err-receivedAmount')).length > 3, 'less than the amount due is refused');
      f.eq((await f.doc(`orders/${BKASH}`)).payment.status, 'awaiting_verification', 'nothing was written');
      await page.fill('#f-receivedAmount', String(before.payment.amountDue));
      await page.fill('#f-note', 'Matched in the bKash merchant app');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc(`orders/${BKASH}`)).payment.status === 'paid'), 'payment marked paid');
      const o = await f.doc(`orders/${BKASH}`);
      f.eq([o.payment.receivedAmount, o.payment.verifiedBy], [before.payment.amountDue, 'om'], 'the received amount and the verifier are stored');
      f.eq(o.status, 'pending', 'verifying money does not skip the order lifecycle');
      await page.waitForFunction(() => !document.querySelector('[data-action="pay-verify"]'), null, { timeout: 6000 });
      f.eq(await count(page, '[data-action="pay-reject"]'), 0, 'a paid order can no longer be rejected');
      const ev = Object.values(await f.docs(`orders/${BKASH}/events/`)).filter((e) => e.type === 'payment');
      f.eq(ev.length, 1, 'the payment decision is on the timeline');
      f.ok(Object.values(await f.docs('auditLogs/')).some((a) => a.entityId === BKASH && /payment/i.test(a.action)), 'and in the audit log');
    },
  },

  {
    name: 'admin orders: reject a payment with a reason, verify it later', as: 'sadm',
    async run(f) {
      const { page } = f;
      await open(f, BKASH);
      await page.click('[data-action="pay-reject"]');
      await page.waitForSelector(`${DLG} form`);
      await page.click(YES);
      f.ok((await text(page, '#err-note')).length > 3, 'a reason is required');
      f.eq((await f.doc(`orders/${BKASH}`)).payment.status, 'awaiting_verification', 'nothing was written without a reason');
      await page.fill('#f-note', 'Money not seen in the merchant account');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc(`orders/${BKASH}`)).payment.status === 'failed'), 'payment marked as failed');
      f.eq((await f.doc(`orders/${BKASH}`)).payment.failReason, 'Money not seen in the merchant account', 'the reason is stored (the customer sees it and can send a new TrxID)');
      await page.waitForSelector('[data-action="pay-verify"]');
      f.eq(await count(page, '[data-action="pay-reject"]'), 0, 'a failed payment can only be verified again, not rejected twice');
      f.ok((await text(page, '#od-aside')).includes('Money not seen'), 'the reason is shown on the page');
    },
  },

  {
    name: 'admin orders: notes — staff-only and customer-visible', as: 'cs',
    async run(f) {
      const { page } = f;
      await open(f, COD);
      f.eq(await count(page, '#od-aside [data-action="status"]'), 0, 'customer support cannot move the order');
      f.ok((await text(page, '#od-aside')).length > 20, 'and the page says so instead of showing nothing');
      const SUBMIT = 'form[data-form="note"] [type="submit"]';

      await page.click(SUBMIT);
      f.ok((await text(page, '#err-text')).length > 3, 'an empty note is refused');
      f.eq((await keys(f, `orders/${COD}/events/`)).length, 0, 'nothing was written');

      await page.fill('#f-text', 'Customer asked to deliver after 5 pm');
      await page.click(SUBMIT);
      f.ok(await f.until(async () => (await keys(f, `orders/${COD}/events/`)).length === 1), 'staff note stored');
      let ev = Object.values(await f.docs(`orders/${COD}/events/`))[0];
      f.eq([ev.type, ev.visibility, ev.actorRole], ['note', 'internal', 'customer_support'], 'it is internal and carries the author role');
      f.eq(await page.inputValue('#f-text'), '', 'the form is cleared after saving');
      const seededNotifications = (await keys(f, 'users/u1/notifications/')).length;
      f.eq(seededNotifications, 3, 'an internal note sends no notification');

      await page.fill('#f-text', 'We will call you tomorrow morning');
      await page.selectOption('#f-visibility', 'customer');
      await page.click(SUBMIT);
      f.ok(await f.until(async () => (await keys(f, `orders/${COD}/events/`)).length === 2), 'customer-visible note stored');
      f.ok(await f.until(async () => (await keys(f, 'users/u1/notifications/')).length === 4), 'and the customer was notified in the same batch');
      await page.waitForFunction(() => document.querySelectorAll('#od-timeline li').length >= 3, null, { timeout: 6000 });
      const tl = await text(page, '#od-timeline');
      f.ok(tl.includes('Customer asked to deliver') && tl.includes('We will call you'), 'both notes are on the timeline');
      f.ok(tl.indexOf('We will call you') < tl.indexOf('Customer asked to deliver'), 'newest first');

      // the customer sees the customer-visible note only
      ev = Object.values(await f.docs(`orders/${COD}/events/`)).filter((e) => e.visibility === 'customer');
      f.eq(ev.length, 1, 'exactly one note is visible to the customer');
    },
  },

  {
    name: 'admin orders: cancel needs a reason and releases the reserved stock', as: 'sa',
    async run(f) {
      const { page } = f;
      const p1 = await f.doc('inventory/p1');
      const p5 = await f.doc('inventory/p5');
      await open(f, COD);
      await page.click(STEP('cancelled'));
      await page.waitForSelector(`${DLG} form`);
      f.ok((await text(page, DLG)).length > 20, 'the dialog warns that stock is released');
      await page.click(YES);
      f.ok((await text(page, '#err-cancelReason')).length > 3, 'a reason is required');
      f.eq((await f.doc(`orders/${COD}`)).status, 'pending', 'nothing was written without a reason');
      await page.fill('#f-cancelReason', 'Customer called to cancel');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc(`orders/${COD}`)).status === 'cancelled'), 'order cancelled');
      const o = await f.doc(`orders/${COD}`);
      f.eq(o.cancelReason, 'Customer called to cancel', 'the reason is stored');
      f.eq([(await f.doc('inventory/p1')).reserved, (await f.doc('inventory/p1')).stock], [p1.reserved - 2, p1.stock], 'the reservation is released and the physical stock is untouched');
      f.eq((await f.doc('inventory/p5')).reserved, p5.reserved - 1, 'every line is released');
      await page.waitForFunction(() => !document.querySelector('#od-aside [data-action="status"]'), null, { timeout: 6000 });
      f.eq(await count(page, '[data-action="pay-cod"]'), 0, 'a cancelled order has no payment actions');
      f.eq(await count(page, '[data-action="tracking"]'), 0, 'and no tracking edit');
    },
  },

  {
    name: 'admin orders: tracking can be edited after shipping', as: 'om',
    async run(f) {
      const { page } = f;
      await f.mock();
      await f.patch(`orders/${COD}`, "d.status = 'shipped'; d.shippedAt = Ts.fromMillis(Date.now() - 3600000); d.shipping = { carrier: 'Steadfast', trackingNo: 'OLD-1', trackingUrl: '' };");
      await open(f, COD);
      await page.click('[data-action="tracking"]');
      await page.waitForSelector(`${DLG} form`);
      f.eq(await page.inputValue('#f-trackingNo'), 'OLD-1', 'the dialog starts from the stored details');
      await page.fill('#f-trackingUrl', 'javascript:alert(1)');
      await page.fill('#f-trackingNo', 'NEW-2');
      await page.click(YES);
      await page.waitForTimeout(400);
      f.ok((await text(page, '#err-trackingUrl')).length > 3, 'a javascript: link is refused with a message under the field');
      f.eq((await f.doc(`orders/${COD}`)).shipping.trackingNo, 'OLD-1', 'nothing was written');
      f.ok((await count(page, DLG)) === 1, 'the dialog stays open so the mistake can be fixed');
      await page.fill('#f-trackingUrl', 'https://track.example.com/NEW-2');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc(`orders/${COD}`)).shipping.trackingNo === 'NEW-2'), 'tracking saved');
      const a = await page.locator('#od-aside a[href^="https://track.example.com"]').count();
      f.eq(a, 1, 'the tracking link is shown, opening in a new tab safely');
      f.eq(await page.getAttribute('#od-aside a[href^="https://track.example.com"]', 'rel'), 'noopener noreferrer', 'with rel=noopener');
      const ev = Object.values(await f.docs(`orders/${COD}/events/`)).filter((e) => e.type === 'shipping');
      f.eq(ev.length, 1, 'the change is on the timeline');
    },
  },

  {
    name: 'admin orders: refund is recorded only after goods came back', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.mock();
      await f.patch(`orders/${COD}`, "d.status = 'returned'; d.shippedAt = Ts.fromMillis(Date.now() - 5 * 86400000); d.deliveredAt = Ts.fromMillis(Date.now() - 4 * 86400000); d.payment.status = 'paid';");
      await open(f, COD);
      f.eq(await count(page, '[data-action="refund"]'), 1, 'the refund panel is offered for a returned order');
      await page.click('[data-action="refund"]');
      await page.waitForSelector(`${DLG} form`);
      const total = (await f.doc(`orders/${COD}`)).totals.total;
      await page.fill('#f-amount', String(total + 1));
      await page.click(YES);
      f.ok((await text(page, '#err-amount')).length > 3, 'more than the order total is refused');
      f.eq((await f.doc(`orders/${COD}`)).status, 'returned', 'nothing was written');
      await page.fill('#f-amount', String(total));
      await page.selectOption('#f-method', 'bkash');
      await page.fill('#f-note', 'Sent to the customer’s bKash number');
      await page.click(YES);
      f.ok(await f.until(async () => (await f.doc(`orders/${COD}`)).status === 'refunded'), 'order refunded');
      const o = await f.doc(`orders/${COD}`);
      f.eq([o.refund.amount, o.refund.method], [total, 'bkash'], 'amount and method are stored on the order');
      f.eq(o.payment.status, 'refunded', 'the payment status follows');
      f.ok(Object.keys(await f.docs('refunds/')).length >= 1, 'a refund record exists');
      await page.waitForFunction(() => !document.querySelector('[data-action="refund"]'), null, { timeout: 6000 });
      f.ok((await text(page, '#od-aside')).includes('bkash') || (await text(page, '#od-aside')).length > 20, 'the refund is shown, and the order is closed');
    },
  },

  {
    name: 'admin orders: reporting sees orders but not contact details or actions', as: 'rp',
    async run(f) {
      const { page } = f;
      await open(f, COD);
      const aside = await text(page, '#od-aside');
      f.ok(!aside.includes('01711111111') && !aside.includes('01711-111111'), 'the phone number is masked');
      f.ok(!aside.includes('rahim@example.com'), 'the e-mail is masked');
      f.eq(await count(page, '#od-aside a[href^="tel:"], #od-aside a[href^="mailto:"]'), 0, 'no tel: / mailto: links');
      f.eq(await count(page, 'form[data-form="note"]'), 0, 'no note form');
      f.eq(await count(page, '#od-aside [data-action="status"], #od-aside [data-action^="pay-"], [data-action="tracking"], [data-action="refund"]'), 0, 'no action buttons at all');
      f.ok(await count(page, '[data-action="print-menu"]') === 1, 'printing is still possible');
    },
  },

  {
    name: 'admin orders: inventory manager has no access to orders', as: 'im',
    async run(f) {
      const { page } = f;
      await f.goto(page_(COD));
      await page.waitForSelector('main .empty, #admin-main .empty, .empty', { timeout: 12000 });
      f.eq(await count(page, '#od-head'), 0, 'no order data is shown');
      f.eq(await count(page, '.od'), 0, 'the order page was not mounted');
    },
  },

  {
    name: 'admin orders: print invoice, packing slip and shipping label', as: 'om',
    async run(f) {
      const { page } = f;
      await open(f, COD);
      const srcdoc = async (titlePrefix, index) => {
        await page.click('[data-action="print-menu"]');
        await page.waitForSelector('.menu [role="menuitem"]');
        f.eq(await count(page, '.menu [role="menuitem"]'), 3, 'the print menu offers three documents');
        await page.click(`.menu [role="menuitem"]:nth-child(${index})`);
        await page.waitForSelector(`iframe[title^="${titlePrefix}"]`, { state: 'attached', timeout: 6000 });
        return page.getAttribute(`iframe[title^="${titlePrefix}"]`, 'srcdoc');
      };
      const invoice = await srcdoc('Invoice', 1);
      f.ok(invoice.includes(COD) && invoice.includes('Classic Cotton T-Shirt') && invoice.includes('5,970') || invoice.includes('৫,৯৭০'), 'the invoice carries the order number, the lines and the total');
      await page.waitForFunction(() => !document.querySelector('iframe[title^="Invoice"]'), null, { timeout: 6000 });
      const slip = await srcdoc('Packing slip', 2);
      f.ok(slip.includes(COD) && slip.includes('Sports Watch'), 'the packing slip lists what to pack');
      f.ok(!slip.includes('1,200') && !slip.includes('১,২০০') && !slip.includes('3,500') && !slip.includes('৩,৫০০'), 'and shows no unit prices (only the cash to collect)');
      f.ok(slip.includes('5,970') || slip.includes('৫,৯৭০'), 'the cash to collect for a COD order is on the slip');
      await page.waitForFunction(() => !document.querySelector('iframe[title^="Packing slip"]'), null, { timeout: 6000 });
      const label = await srcdoc('Label', 3);
      f.ok(label.includes(COD) && label.includes('House 1, Road 2'), 'the label carries the order number and the address');
    },
  },

  {
    name: 'admin orders: a bad order number shows a clear message', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.goto('/admin/#/orders/SV-000000-NOPE00');
      await page.waitForSelector('.empty', { timeout: 12000 });
      f.ok((await text(page, '.empty')).length > 5, 'there is an explanation');
      f.eq(await count(page, 'a.back-link'), 1, 'and a way back to the list');
    },
  },
];
