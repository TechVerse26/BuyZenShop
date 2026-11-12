/*
 * Customer click-through scenarios (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   u1  Rahim, saved address a1 in Sirajganj (delivery ৳70)         WELCOME10 = 10 %, max ৳200, min ৳500, once per customer
 *   p1 ৳1200 (25 in stock) · p5 ৳3500 (50) · Dhaka = outside Sirajganj (delivery ৳130)
 *   seeded order of u2 holds TrxID 8N7A6D5C4B
 */
import { BTN, ready, placeAndWait, topLevelOrders, cartLines, text } from './helpers.mjs';

const CART2 = [{ key: 'p1', qty: 2 }, { key: 'p5', qty: 1 }];            // 2 × 1200 + 3500 = 5900

export const customerFlows = [
  {
    name: 'checkout: COD order with the saved address', as: 'u1', cart: CART2,
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      const inv0 = await f.docs('inventory/');
      f.ok(await page.isChecked('input[name="addr"][value="a1"]'), 'the default saved address is pre-selected');
      f.ok((await text(page, '#co-delivery')).includes('Inside Sirajganj'), 'delivery zone for Sirajganj is shown');
      f.ok((await text(page, BTN)).includes('5,970'), `the button shows the total (got "${await text(page, BTN)}")`);
      const n0 = (await topLevelOrders(f)).length;
      const n = await placeAndWait(page);
      const o = await f.doc(`orders/${n}`);
      if (!f.ok(o, 'the order document exists')) return;
      f.eq([o.userId, o.status, o.payment.method, o.payment.status], ['u1', 'pending', 'cod', 'unpaid'], 'owner / status / payment');
      f.eq([o.totals.subtotal, o.totals.shipping, o.totals.discount, o.totals.total], [5900, 70, 0, 5970], 'totals');
      f.eq(o.itemOrder.length, 2, 'two lines');
      f.eq((await topLevelOrders(f)).length, n0 + 1, 'exactly one order was created');
      const inv1 = await f.docs('inventory/');
      f.eq(inv1['inventory/p1'].reserved - inv0['inventory/p1'].reserved, 2, 'p1 stock reserved');
      f.eq(inv1['inventory/p5'].reserved - inv0['inventory/p5'].reserved, 1, 'p5 stock reserved');
      f.ok(await f.doc('users/u1').then((u) => !!u.lastOrderAt), 'the order cooldown stamp was written');
      f.eq(await text(page, '.os-number strong'), n, 'the success page shows the order number');
      f.eq(await cartLines(page), 0, 'the cart is empty after ordering');
    },
  },

  {
    name: 'checkout: a double click creates one order', as: 'u1', cart: [{ key: 'p1', qty: 1 }],
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      const n0 = (await topLevelOrders(f)).length;
      await page.dblclick(BTN);
      await page.waitForURL(/\/order-success\//, { timeout: 15000 });
      f.eq((await topLevelOrders(f)).length, n0 + 1, 'exactly one order after a double click');
    },
  },

  {
    name: 'checkout: new address — errors first, then a Dhaka order', as: 'u1', cart: [{ key: 'p1', qty: 1 }],
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      await page.check('input[name="addr"][value="new"]');
      await ready(page);
      await page.fill('#f-name', '');
      const n0 = (await topLevelOrders(f)).length;
      await page.click(BTN);
      f.ok((await text(page, '#err-name')).length > 3, 'name error is shown');
      f.ok((await text(page, '#err-district')).length > 3, 'district error is shown');
      f.ok((await text(page, '#err-line1')).length > 3, 'address error is shown');
      f.eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'f-name', 'focus moves to the first invalid field');
      f.eq((await topLevelOrders(f)).length, n0, 'nothing was written while the form was invalid');
      await page.fill('#f-name', 'Salma Akter');
      await page.selectOption('#f-district', 'Dhaka');
      await page.fill('#f-line1', 'Flat 4B, House 9, Road 5, Dhanmondi');
      f.ok(!(await page.isChecked('#f-saveAddress')), 'a returning customer must opt in to saving another address');
      await page.check('#f-saveAddress');
      await ready(page);
      f.ok((await text(page, '#co-delivery')).includes('Outside Sirajganj'), 'outside zone is shown for Dhaka');
      f.ok((await text(page, BTN)).includes('1,330'), `total is 1200 + 130 (got "${await text(page, BTN)}")`);
      const n = await placeAndWait(page);
      const o = await f.doc(`orders/${n}`);
      f.eq([o.address.district, o.address.name, o.totals.shipping, o.totals.total], ['Dhaka', 'Salma Akter', 130, 1330], 'address and totals stored');
      f.ok(await f.until(async () => Object.keys(await f.docs('users/u1/addresses/')).length === 2), 'the new address was saved to the address book');
    },
  },

  {
    name: 'checkout: bKash order is stored as awaiting verification', as: 'u1', cart: CART2,
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      await page.check('input[name="method"][value="bkash"]');
      await page.waitForSelector('#co-steps');
      const steps = await text(page, '#co-steps');
      f.ok(steps.includes('01334108089'), 'the shop bKash number is shown');
      f.ok(steps.includes('5,970'), 'the amount to send is the order total');
      f.ok((await text(page, '.co-verify')).length > 40, 'the "payment is verified by our team" note is shown');
      await page.click(BTN);                                                   // empty TrxID → inline errors, nothing written
      f.ok((await text(page, '#err-trxId')).length > 3, 'TrxID error is shown');
      f.ok((await text(page, '#err-senderNumber')).length > 3, 'sender number error is shown');
      await page.fill('#f-senderNumber', '01812345678');
      await page.fill('#f-trxId', ' ab-c1 23xy9 ');
      const n = await placeAndWait(page);
      const o = await f.doc(`orders/${n}`);
      f.eq([o.payment.method, o.payment.status, o.payment.trxId, o.payment.senderNumber], ['bkash', 'awaiting_verification', 'ABC123XY9', '01812345678'], 'payment stored, TrxID normalised');
      f.eq((await f.doc('paymentTrx/ABC123XY9') || {}).orderId, n, 'the TrxID is reserved for this order');
      f.ok(!(await text(page, '.os-hero')).includes('Paid'), 'the success page does not claim the order is paid');
    },
  },

  {
    name: 'checkout: a TrxID already used elsewhere is refused, a corrected one works', as: 'u1', cart: [{ key: 'p1', qty: 1 }], denied: true,
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      await page.check('input[name="method"][value="nagad"]');
      await page.fill('#f-senderNumber', '01912345678');
      await page.fill('#f-trxId', '8N7A6D5C4B');                              // belongs to another customer's order
      const n0 = (await topLevelOrders(f)).length;
      await page.click(BTN);
      f.ok(await f.until(async () => (await text(page, '#err-trxId')).length > 10), 'the TrxID field explains the refusal');
      f.ok(page.url().endsWith('/checkout'), 'the customer stays on the checkout page');
      f.eq((await topLevelOrders(f)).length, n0, 'no order was created');
      await page.fill('#f-trxId', '5K4J3H2G1F');
      await ready(page);
      const n = await placeAndWait(page);
      f.eq((await topLevelOrders(f)).length, n0 + 1, 'the corrected TrxID creates exactly one order');
      f.eq((await f.doc(`orders/${n}`)).payment.trxId, '5K4J3H2G1F', 'the corrected TrxID is stored');
    },
  },

  {
    name: 'checkout: coupon — wrong code, right code, usage recorded', as: 'u1', cart: CART2,
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      await page.fill('#co-coupon', 'nope123');
      await page.press('#co-coupon', 'Enter');
      f.ok(await f.until(async () => (await text(page, '#co-coupon-err')).length > 3), 'an unknown coupon is explained');
      await page.fill('#co-coupon', 'welcome10');
      await page.press('#co-coupon', 'Enter');
      await page.waitForSelector('.co-coupon-on');
      await ready(page);
      f.ok((await text(page, '.co-totals')).includes('200'), 'the discount line shows ৳200 (10 % capped)');
      f.ok((await text(page, BTN)).includes('5,770'), `total is 5900 − 200 + 70 (got "${await text(page, BTN)}")`);
      const n = await placeAndWait(page);
      const o = await f.doc(`orders/${n}`);
      f.eq([o.couponCode, o.totals.discount, o.totals.total], ['WELCOME10', 200, 5770], 'coupon stored on the order');
      f.eq((await f.doc('coupons/WELCOME10')).usedCount, 1, 'coupon usedCount incremented');
      f.eq((await f.doc('couponUsage/WELCOME10__u1') || {}).count, 1, 'per-customer usage recorded');
    },
  },

  {
    name: 'checkout: a price that changed while checking out needs a second confirmation', as: 'u1', cart: CART2,
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      await f.patch('inventory/p1', 'd.price = 1300;');                         // staff raised the price in the meantime
      const n0 = (await topLevelOrders(f)).length;
      await page.click(BTN);
      f.ok(await f.until(async () => (await text(page, '#co-totals')).includes('6,170')), 'the page shows the new total (2 × 1300 + 3500 + 70)');
      f.ok((await text(page, '#co-totals .alert-bad')).length > 10, 'a message explains that prices changed');
      f.eq((await topLevelOrders(f)).length, n0, 'no order was placed at a total the customer had not seen');
      const n = await placeAndWait(page);
      f.eq((await f.doc(`orders/${n}`)).totals.total, 6170, 'the confirmed order uses the new price');
    },
  },

  {
    name: 'checkout: an item that sold out blocks the order', as: 'u1', cart: CART2,
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await ready(page);
      await f.patch('inventory/p5', 'd.stock = 0;');
      const n0 = (await topLevelOrders(f)).length;
      await page.click(BTN);
      f.ok(await f.until(async () => (await page.locator('#co-totals .alert-warn').count()) > 0), 'the sold-out item is listed');
      f.ok(await page.locator(BTN).isDisabled(), 'the order button is disabled until the cart is fixed');
      f.eq((await topLevelOrders(f)).length, n0, 'no order was created');
    },
  },

  {
    name: 'checkout: guests are sent to sign in and come back', as: null, cart: [{ key: 'p1', qty: 1 }],
    async run(f) {
      const { page } = f;
      await f.goto('/checkout');
      await page.waitForURL(/\/login/, { timeout: 8000 });
      f.ok(decodeURIComponent(page.url()).includes('next=/checkout'), 'the login URL remembers where to return');
      await page.waitForSelector('form[data-form="signin"]');
      await page.fill('#f-email', 'rahim@example.com');
      await page.fill('#f-password', 'password1');
      await page.click('form[data-form="signin"] button[type="submit"]');
      await page.waitForURL(/\/checkout$/, { timeout: 10000 });
      await ready(page);
      f.ok((await page.locator('#co-form').count()) === 1, 'the checkout form is shown after signing in');
    },
  },
];
