/*
 * Admin "Settings", clicked through in Chromium (see tests/e2e/flows.mjs). Seed: tests/e2e/fixtures.mjs
 *   settings/public: Shop Verse · bKash and Nagad 01334108089 · announcement on ("Test announcement …", link /shop) · settings/private: threshold 5
 * The rules that judge every write here are the real firestore.rules (the mock evaluates them), so a write the rules would refuse fails the scenario.
 */
import { DLG, YES, text } from './helpers.mjs';

const SETTINGS = '/admin/#/settings';
const FORM = '#cfg-form';
const settingsAudits = async (f) => Object.values(await f.docs('auditLogs/')).filter((a) => a.action === 'settings.update');
const closed = (page) => page.waitForSelector(DLG, { state: 'detached', timeout: 8000 }).then(() => true, () => false);

async function openSettings(f) {
  await f.goto(SETTINGS);
  await f.page.waitForSelector(FORM, { timeout: 12000 });
}
const save = (page) => page.click(`${FORM} [type="submit"]`);
const err = (page, name) => page.textContent(`#err-${name}`).then((s) => (s || '').trim());

export const adminSettingsFlows = [
  {
    name: 'admin settings: the form shows what is saved; a changed payment number and announcement are merged in and audited old → new', as: 'sa',
    async run(f) {
      const { page } = f;
      await openSettings(f);
      f.eq(await page.inputValue('#f-storeName'), 'Shop Verse', 'the store name comes from settings/public');
      f.eq([await page.inputValue('#f-pay_bkash_number'), await page.inputValue('#f-pay_nagad_number')], ['01334108089', '01334108089'], 'payment numbers are shown in the local format');
      f.eq(await page.isChecked('#f-ann_enabled'), true, 'the seeded announcement is on');
      f.eq(await page.inputValue('#f-lowStockThreshold'), '5', 'the private threshold is shown to a Super Admin');
      f.eq((await text(page, '#cfg-dirty')), '', 'nothing is marked as unsaved yet');
      const privateBefore = JSON.stringify(await f.doc('settings/private'));

      await page.fill('#f-pay_bkash_number', '017 1234 5678');
      f.ok((await text(page, '#cfg-dirty')).length > 3, 'typing marks the form as unsaved');
      await page.fill('#f-ann_text', '  Eid sale — 10% off  ');
      await save(page);
      await page.waitForSelector('.toast-ok', { timeout: 8000 });

      const pub = await f.doc('settings/public');
      f.eq(pub.payments.bkash.number, '01712345678', 'the number is stored without spaces');
      f.eq(pub.payments.nagad.number, '01334108089', 'a deep merge keeps the Nagad number');
      f.eq([pub.payments.bkash.enabled, pub.payments.bkash.accountType], [true, 'Personal'], 'and the rest of the bKash map');
      f.eq([pub.announcement.text, pub.announcement.link, pub.announcement.enabled], ['Eid sale — 10% off', '/shop', true], 'the text is trimmed, the link stays');
      f.eq(pub.storeName, 'Shop Verse', 'untouched fields stay');
      f.eq(JSON.stringify(await f.doc('settings/private')), privateBefore, 'settings/private was not written when nothing private changed');

      const audits = await settingsAudits(f);
      f.eq(audits.length, 1, 'exactly one audit entry');
      f.eq([audits[0].actorUid, audits[0].actorRole, audits[0].entity, audits[0].entityId], ['sa', 'super_admin', 'settings', 'public'], 'who changed what');
      f.eq(audits[0].before['payments/bkash/number'], '01334108089', 'the old number is on record');
      f.eq(audits[0].after['payments/bkash/number'], '01712345678', 'and the new one');
      f.eq(Object.keys(audits[0].after).sort(), ['announcement/text', 'payments/bkash/number'], 'only the two changed fields are listed');
      f.eq((await text(page, '#cfg-dirty')), '', 'the unsaved marker is gone after saving');
      f.eq(await page.inputValue('#f-pay_bkash_number'), '01712345678', 'the form shows the saved value');
    },
  },

  {
    name: 'admin settings: invalid values are refused beside the field and nothing is written', as: 'sa',
    async run(f) {
      const { page } = f;
      await openSettings(f);
      const bad = {
        '#f-storeName': '', '#f-orderPrefix': 'a b!', '#f-contact_email': 'not-an-email', '#f-contact_whatsapp': '123',
        '#f-social_facebook': 'http://facebook.com/shop', '#f-pay_bkash_number': '12345', '#f-returnWindowDays': '999',
        '#f-ann_link': 'javascript:alert(1)', '#f-tawk_propertyId': 'not valid!', '#f-lowStockThreshold': '-3', '#f-notifyEmails': 'one@example.com\nbroken',
      };
      for (const [sel, v] of Object.entries(bad)) await page.fill(sel, v);
      await save(page);
      await page.waitForSelector('.toast-bad', { timeout: 8000 });
      for (const name of ['storeName', 'orderPrefix', 'contact_email', 'contact_whatsapp', 'social_facebook', 'pay_bkash_number', 'returnWindowDays', 'ann_link', 'tawk_propertyId', 'lowStockThreshold', 'notifyEmails']) {
        f.ok((await err(page, name)).length > 3, `${name}: an error is shown next to the field`);
      }
      f.eq(await page.getAttribute('#f-contact_email', 'aria-invalid'), 'true', 'the field is marked invalid for screen readers');
      f.eq((await f.doc('settings/public')).payments.bkash.number, '01334108089', 'nothing was written');
      f.eq((await settingsAudits(f)).length, 0, 'and nothing was audited');

      // fixing the fields clears the errors and the save goes through
      await page.fill('#f-storeName', 'Shop Verse BD');
      await page.fill('#f-orderPrefix', 'sv');
      await page.fill('#f-contact_email', 'Hello@Example.com');
      await page.fill('#f-contact_whatsapp', '01712345678');
      await page.fill('#f-social_facebook', 'https://facebook.com/shopverse');
      await page.fill('#f-pay_bkash_number', '01812345678');
      await page.fill('#f-returnWindowDays', '14');
      await page.fill('#f-ann_link', '/shop?sale=1');
      await page.fill('#f-tawk_propertyId', 'abc123def456');
      await page.fill('#f-lowStockThreshold', '8');
      await page.fill('#f-notifyEmails', 'One@Example.com\ntwo@example.com, one@example.com');
      await save(page);
      await page.waitForSelector('.toast-ok', { timeout: 8000 });
      const pub = await f.doc('settings/public');
      f.eq([pub.storeName, pub.orderPrefix, pub.contact.email, pub.contact.whatsapp], ['Shop Verse BD', 'SV', 'hello@example.com', '8801712345678'], 'cleaned values are stored (prefix upper-case, e-mail lower-case, WhatsApp international)');
      f.eq([pub.checkout.returnWindowDays, pub.announcement.link, pub.integrations.tawk.propertyId], [14, '/shop?sale=1', 'abc123def456'], 'numbers are numbers');
      const priv = await f.doc('settings/private');
      f.eq([priv.lowStockThreshold, priv.notifyEmails], [8, ['one@example.com', 'two@example.com']], 'the private document is updated, the address list de-duplicated');
      const audits = await settingsAudits(f);
      f.eq(audits.length, 1, 'one audit entry for the whole save');
      f.eq(audits[0].before.notifyEmails, 'changed', 'the e-mail list is audited as "changed" only');
      f.ok(!JSON.stringify(audits[0]).includes('one@example.com'), 'and the addresses are not copied into the log');
    },
  },

  {
    name: 'admin settings: at least one payment method must stay on; unchanged saves say so', as: 'sa',
    async run(f) {
      const { page } = f;
      await openSettings(f);
      await save(page);
      await page.waitForSelector('.toast-info', { timeout: 6000 });
      f.eq((await settingsAudits(f)).length, 0, 'saving an untouched form writes nothing');

      await page.uncheck('#f-pay_cod_enabled');
      await page.uncheck('#f-pay_bkash_enabled');
      await page.uncheck('#f-pay_nagad_enabled');
      await save(page);
      await page.waitForSelector('.toast-bad', { timeout: 6000 });
      f.ok((await err(page, 'pay_cod_enabled')).length > 3, 'the error explains that nobody could check out');
      f.eq((await f.doc('settings/public')).payments.cod.enabled, true, 'nothing was written');

      // a wallet that is on needs its number
      await page.check('#f-pay_nagad_enabled');
      await page.fill('#f-pay_nagad_number', '');
      await save(page);
      await page.waitForFunction(() => document.querySelector('#err-pay_nagad_number')?.textContent.trim().length > 3, null, { timeout: 6000 });
      f.eq((await f.doc('settings/public')).payments.nagad.number, '01334108089', 'still the old number');
    },
  },

  {
    name: 'admin settings: discarding asks first and restores the saved values', as: 'sa',
    async run(f) {
      const { page } = f;
      await openSettings(f);
      await page.fill('#f-storeName', 'Something else');
      await page.fill('#f-tagline', 'A new tagline');
      await page.click('[data-action="discard"]');
      await page.waitForSelector(YES);
      await page.click(`${DLG} [data-no]`);
      f.ok(await closed(page), 'the question closed');
      f.eq(await page.inputValue('#f-storeName'), 'Something else', 'declining keeps the edits');
      await page.click('[data-action="discard"]');
      await page.waitForSelector(YES);
      await page.click(YES);
      await page.waitForFunction(() => document.querySelector('#f-storeName')?.value === 'Shop Verse', null, { timeout: 4000 });
      f.eq(await page.inputValue('#f-tagline'), '', 'the other edit is gone too');
      f.eq((await text(page, '#cfg-dirty')), '', 'and the unsaved marker');
      f.eq((await settingsAudits(f)).length, 0, 'nothing was written');
    },
  },

  {
    name: 'admin settings: a Store Admin can change settings; the audit entry carries the role', as: 'sadm',
    async run(f) {
      const { page } = f;
      await openSettings(f);
      await page.fill('#f-tagline', 'Everyday things, delivered');
      await page.fill('#f-inv_businessName', 'Shop Verse Ltd');
      await save(page);
      await page.waitForSelector('.toast-ok', { timeout: 8000 });
      f.eq((await f.doc('settings/public')).tagline, 'Everyday things, delivered', 'the public document is updated');
      f.eq((await f.doc('settings/private')).invoice.businessName, 'Shop Verse Ltd', 'the private one too (Store Admin has settings.write)');
      const audits = await settingsAudits(f);
      f.eq(audits.map((a) => [a.actorUid, a.actorRole]), [['sadm', 'store_admin']], 'the entry names the person and the role');
    },
  },

  {
    name: 'admin settings: on a store without settings the first save creates them', as: 'sa',
    async run(f) {
      const { page } = f;
      await f.remove('settings/public');
      await f.remove('settings/private');
      await openSettings(f);
      f.eq(await page.locator(`${FORM} .alert-info`).count(), 1, 'a notice says the settings do not exist yet');
      f.eq(await page.inputValue('#f-storeName'), '', 'the store name is empty');
      f.eq(await page.isChecked('#f-pay_cod_enabled'), true, 'cash on delivery is on by default, so the form can be saved');
      await save(page);
      await page.waitForFunction(() => document.querySelector('#err-storeName')?.textContent.trim().length > 3, null, { timeout: 6000 });
      await page.fill('#f-storeName', 'My Shop');
      await save(page);
      await page.waitForSelector('.toast-ok', { timeout: 8000 });
      const pub = await f.doc('settings/public');
      const priv = await f.doc('settings/private');
      f.eq([pub.storeName, pub.orderPrefix, pub.payments.cod.enabled, pub.checkout.returnWindowDays], ['My Shop', 'SV', true, 7], 'settings/public exists');
      f.ok(!!pub.createdAt && !!pub.updatedAt, 'with createdAt and updatedAt');
      f.eq([priv.lowStockThreshold, priv.notifyEmails], [5, []], 'and so does settings/private');
      f.eq(await page.locator(`${FORM} .alert-info`).count(), 0, 'the notice is gone after saving');
    },
  },

  {
    name: 'admin settings: roles without settings access are sent to "forbidden"', as: 'om',
    async run(f) {
      const { page } = f;
      await f.goto(SETTINGS);
      await page.waitForFunction(() => location.hash.startsWith('#/forbidden'), null, { timeout: 12000 });
      f.eq(await page.locator(FORM).count(), 0, 'no settings form');
      f.eq(await page.locator('a[href$="#/settings"]').count(), 0, 'and no menu item for it');
    },
  },
];
