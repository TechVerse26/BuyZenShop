/*
 * Settings — the store's name, contact details, payment numbers, return window, announcement bar, SEO defaults, invoice details,
 * notification e-mails and live chat. One form, one Save button, one batch (shared/settingsFlow.js → data/settings.js).
 *
 *   settings/public   read by every visitor — shown on the storefront (name, contact, bKash/Nagad numbers, announcement …)
 *   settings/private  staff only — low-stock threshold, notification e-mails, invoice details
 *
 * Every change is audited with the old and the new value; a changed payment number is the first thing to look for when money goes missing.
 * The rules only check settings.write; the validation (phone numbers, links, ids …) happens here before anything is written.
 */
import { html, render, bindActions, readForm, withBusy, safeUrl } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { toast, toastError, fieldHtml, confirmDialog } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { can } from '../../data/auth.js';
import { settingsToForm, ACCOUNT_TYPES, WALLETS, SETTINGS_LIMITS as L } from '../../shared/settingsFlow.js';
import { safeMount, pageHead, needs } from '../lib/ui.js';
import { loadSettingsDocs, saveSettings } from '../data/settings.js';
import { pickFiles, uploadSiteImage } from '../lib/images.js';

registerBoth({
  'cfg.title': ['Settings', 'সেটিংস'],
  'cfg.sub': ['How the store looks to customers, how they pay, and what invoices say', 'কাস্টমার স্টোরটি কেমন দেখে, কীভাবে টাকা দেয় এবং ইনভয়েসে কী লেখা থাকে'],
  'cfg.save': ['Save settings', 'সেটিংস সেভ করুন'],
  'cfg.discard': ['Discard changes', 'বদল বাতিল'],
  'cfg.unsaved': ['Unsaved changes', 'সেভ না করা বদল আছে'],
  'cfg.noChange': ['Nothing was changed.', 'কিছুই বদলানো হয়নি।'],
  'cfg.discardTitle': ['Discard your changes?', 'বদলগুলো বাতিল করবেন?'],
  'cfg.discardText': ['The form goes back to what is saved.', 'ফর্ম আগের সেভ করা অবস্থায় ফিরে যাবে।'],
  'cfg.readOnly': ['You can look at the settings but not change them.', 'আপনি সেটিংস দেখতে পারেন, বদলাতে পারবেন না।'],
  'cfg.missing': ['Settings have not been created yet. Saving this page creates them (or run the migration in Setup).', 'সেটিংস এখনো তৈরি হয়নি। এই পেজ সেভ করলেই তৈরি হবে (অথবা সেটআপে মাইগ্রেশন চালান)।'],
  /* store */
  'cfg.s.store': ['Store', 'স্টোর'],
  'cfg.storeName': ['Store name', 'স্টোরের নাম'],
  'cfg.tagline': ['Tagline', 'ট্যাগলাইন'],
  'cfg.logo': ['Logo address', 'লোগোর ঠিকানা'],
  'cfg.logoHint': ['An https:// address, or upload a picture.', 'https:// ঠিকানা, অথবা ছবি আপলোড করুন।'],
  'cfg.logoUpload': ['Upload logo', 'লোগো আপলোড'],
  'cfg.orderPrefix': ['Order number prefix', 'অর্ডার নম্বরের প্রিফিক্স'],
  'cfg.orderPrefixHint': ['Order numbers look like SV-261105-ABC123. Changing it affects new orders only.', 'অর্ডার নম্বর দেখতে SV-261105-ABC123-এর মতো। বদলালে শুধু নতুন অর্ডারে প্রযোজ্য।'],
  /* contact */
  'cfg.s.contact': ['Contact details', 'যোগাযোগের তথ্য'],
  'cfg.contactHelp': ['Shown in the footer and on the contact page.', 'ফুটার ও যোগাযোগ পেজে দেখানো হয়।'],
  'cfg.whatsapp': ['WhatsApp number', 'হোয়াটসঅ্যাপ নম্বর'],
  'cfg.whatsappHint': ['Local format, for example 01712345678. The storefront links to it.', 'স্থানীয় ফরম্যাটে, যেমন 01712345678। স্টোরফ্রন্ট এতে লিংক করে।'],
  'cfg.phone': ['Phone', 'ফোন'],
  'cfg.email': ['E-mail', 'ইমেইল'],
  'cfg.address': ['Address', 'ঠিকানা'],
  /* social */
  'cfg.s.social': ['Social pages', 'সোশ্যাল পেজ'],
  'cfg.socialHelp': ['Full https:// addresses. Leave empty to hide a link.', 'পূর্ণ https:// ঠিকানা। লিংক লুকাতে ফাঁকা রাখুন।'],
  'cfg.facebook': ['Facebook', 'ফেসবুক'],
  'cfg.instagram': ['Instagram', 'ইনস্টাগ্রাম'],
  'cfg.youtube': ['YouTube', 'ইউটিউব'],
  'cfg.tiktok': ['TikTok', 'টিকটক'],
  /* payments */
  'cfg.s.payments': ['Payment methods', 'পেমেন্ট মাধ্যম'],
  'cfg.paymentsHelp': ['Customers send bKash / Nagad money to the number below and enter the TrxID. The website cannot confirm a payment by itself: you verify it in the order.', 'কাস্টমার নিচের নম্বরে bKash / Nagad-এ টাকা পাঠিয়ে TrxID দেয়। ওয়েবসাইট নিজে পেমেন্ট নিশ্চিত করতে পারে না: আপনি অর্ডারে যাচাই করেন।'],
  'cfg.cod': ['Cash on delivery', 'ক্যাশ অন ডেলিভারি'],
  'cfg.codHint': ['The customer pays when the parcel arrives.', 'পার্সেল পৌঁছালে কাস্টমার টাকা দেয়।'],
  'cfg.bkash': ['bKash', 'bKash'],
  'cfg.nagad': ['Nagad', 'Nagad'],
  'cfg.walletOn': ['Accept {name}', '{name} গ্রহণ করুন'],
  'cfg.walletNumber': ['{name} number', '{name} নম্বর'],
  'cfg.walletType': ['Account type', 'অ্যাকাউন্টের ধরন'],
  'cfg.walletNote': ['Note for customers', 'কাস্টমারের জন্য নোট'],
  'cfg.type.Personal': ['Personal', 'পার্সোনাল'],
  'cfg.type.Agent': ['Agent', 'এজেন্ট'],
  'cfg.type.Merchant': ['Merchant', 'মার্চেন্ট'],
  /* orders */
  'cfg.s.orders': ['Returns and stock', 'রিটার্ন ও স্টক'],
  'cfg.returnDays': ['Return window (days after delivery)', 'রিটার্নের সময় (ডেলিভারির পর কত দিন)'],
  'cfg.returnDaysHint': ['0 switches returns off.', '০ দিলে রিটার্ন বন্ধ থাকবে।'],
  'cfg.lowStock': ['Low-stock threshold', 'কম স্টকের সীমা'],
  'cfg.lowStockHint': ['A product with this many left, or fewer, is shown as "low stock" in the panel.', 'এই সংখ্যা বা তার কম বাকি থাকলে প্যানেলে "কম স্টক" দেখাবে।'],
  /* announcement */
  'cfg.s.announce': ['Announcement bar', 'ঘোষণা বার'],
  'cfg.announceHelp': ['A single line above the header — an offer, a holiday notice.', 'হেডারের উপরে একটি লাইন — অফার বা ছুটির বিজ্ঞপ্তি।'],
  'cfg.annOn': ['Show the announcement bar', 'ঘোষণা বার দেখান'],
  'cfg.annText': ['Text', 'লেখা'],
  'cfg.annLink': ['Link (optional)', 'লিংক (ঐচ্ছিক)'],
  'cfg.annLinkHint': ['A page of the store such as /shop, or a full https:// address.', 'স্টোরের পেজ (যেমন /shop) অথবা পূর্ণ https:// ঠিকানা।'],
  /* seo */
  'cfg.s.seo': ['Search engines', 'সার্চ ইঞ্জিন'],
  'cfg.seoHelp': ['Used on pages that have no title or description of their own.', 'যে পেজের নিজস্ব শিরোনাম বা বিবরণ নেই সেখানে ব্যবহৃত হয়।'],
  'cfg.seoTitle': ['Default title', 'ডিফল্ট শিরোনাম'],
  'cfg.seoDesc': ['Default description', 'ডিফল্ট বিবরণ'],
  /* invoice */
  'cfg.s.invoice': ['Invoices', 'ইনভয়েস'],
  'cfg.invoiceHelp': ['Printed on every invoice. Visible to staff only.', 'প্রতিটি ইনভয়েসে ছাপা হয়। শুধু স্টাফ দেখতে পায়।'],
  'cfg.invName': ['Business name', 'ব্যবসার নাম'],
  'cfg.invPhone': ['Phone', 'ফোন'],
  'cfg.invAddress': ['Business address', 'ব্যবসার ঠিকানা'],
  'cfg.invNote': ['Note at the bottom', 'নিচের নোট'],
  /* notifications */
  'cfg.s.notify': ['Notification e-mails', 'নোটিফিকেশন ইমেইল'],
  'cfg.notifyHelp': ['Staff addresses kept for the optional e-mail extension. Nothing is e-mailed until that extension is installed (see the deployment guide).', 'ঐচ্ছিক ইমেইল এক্সটেনশনের জন্য স্টাফের ঠিকানা রাখা হয়। ওই এক্সটেনশন বসানো না হলে কোনো ইমেইল যায় না (ডিপ্লয়মেন্ট গাইড দেখুন)।'],
  'cfg.notifyEmails': ['E-mail addresses', 'ইমেইল ঠিকানা'],
  'cfg.notifyHint': ['One per line, up to 5.', 'প্রতি লাইনে একটি, সর্বোচ্চ ৫টি।'],
  /* chat */
  'cfg.s.chat': ['Live chat (Tawk.to)', 'লাইভ চ্যাট (Tawk.to)'],
  'cfg.chatHelp': ['The two ids are in tawk.to → Administration → Chat Widget → Direct chat link: embed.tawk.to/<property id>/<widget id>.', 'দুটি আইডি tawk.to → Administration → Chat Widget → Direct chat link-এ আছে: embed.tawk.to/<property id>/<widget id>।'],
  'cfg.chatOn': ['Show the chat bubble on the storefront', 'স্টোরফ্রন্টে চ্যাট বাবল দেখান'],
  'cfg.chatProperty': ['Property id', 'প্রপার্টি আইডি'],
  'cfg.chatWidget': ['Widget id', 'উইজেট আইডি'],
  /* display */
  'cfg.s.display': ['Display', 'প্রদর্শন'],
  'cfg.bnDigits': ['Show numbers with Bengali digits on the storefront', 'স্টোরফ্রন্টে সংখ্যা বাংলা অঙ্কে দেখান'],
  'cfg.days': ['days', 'দিন'],
});

const PHONE_ATTRS = { inputmode: 'tel', autocomplete: 'off', maxlength: 20 };

export default {
  async mount(ctx) {
    if (!needs(ctx, 'settings.read')) return;
    await safeMount(ctx, async () => {
      const canWrite = can('settings.write');
      let docs = await loadSettingsDocs();
      if (ctx.signal.aborted) return;
      let dirty = false;

      const panel = (key, title, body, help = '') => html`<section class="panel cfg-panel" aria-labelledby="cfg-${key}-h"><div class="panel-head"><h2 id="cfg-${key}-h">${title}</h2></div><div class="panel-body stack">${help ? html`<p class="muted small">${help}</p>` : ''}${body}</div></section>`;
      const text = (name, label, v, over = {}) => fieldHtml({ name, label, value: v[name], ...over });

      const wallet = (w, v) => html`<div class="cfg-wallet">
        ${fieldHtml({ name: `pay_${w}_enabled`, label: t('cfg.walletOn', { name: t(`cfg.${w}`) }), type: 'switch', value: v[`pay_${w}_enabled`] })}
        <div class="pe-grid">
          ${fieldHtml({ name: `pay_${w}_number`, label: t('cfg.walletNumber', { name: t(`cfg.${w}`) }), value: v[`pay_${w}_number`], attrs: PHONE_ATTRS })}
          ${fieldHtml({ name: `pay_${w}_type`, label: t('cfg.walletType'), type: 'select', value: v[`pay_${w}_type`], options: ACCOUNT_TYPES.map((a) => ({ value: a, label: t(`cfg.type.${a}`) })) })}
        </div>
        ${fieldHtml({ name: `pay_${w}_note`, label: t('cfg.walletNote'), value: v[`pay_${w}_note`], attrs: { maxlength: L.walletNote } })}
      </div>`;

      const formHtml = () => {
        const v = settingsToForm(docs.pub || {}, docs.priv || {});
        const priv = docs.priv !== undefined;
        return html`<form novalidate data-form="settings" id="cfg-form">
          ${!docs.pub ? html`<p class="alert alert-info mb-4">${icon('info', { size: 18 })}<span>${t('cfg.missing')}</span></p>` : ''}
          ${!canWrite ? html`<p class="alert alert-info mb-4">${icon('info', { size: 18 })}<span>${t('cfg.readOnly')}</span></p>` : ''}
          <fieldset class="pe-fields" ${canWrite ? '' : html`disabled`}><div class="stack">
            ${panel('store', t('cfg.s.store'), html`
              <div class="pe-grid">
                ${text('storeName', t('cfg.storeName'), v, { required: true, attrs: { maxlength: L.storeName } })}
                ${text('orderPrefix', t('cfg.orderPrefix'), v, { hint: t('cfg.orderPrefixHint'), attrs: { maxlength: 6, autocapitalize: 'characters', autocomplete: 'off' } })}
              </div>
              ${text('tagline', t('cfg.tagline'), v, { attrs: { maxlength: L.tagline } })}
              <div>${text('logoUrl', t('cfg.logo'), v, { hint: t('cfg.logoHint'), type: 'url', attrs: { maxlength: L.url, autocomplete: 'off' } })}
                <div class="row gap-3 mt-2">${v.logoUrl && safeUrl(v.logoUrl, '') ? html`<img class="cfg-logo" src="${safeUrl(v.logoUrl, '')}" alt="" width="48" height="48">` : ''}
                  ${canWrite ? html`<button type="button" class="btn btn-sm" data-action="logo-upload">${icon('upload', { size: 16 })}<span>${t('cfg.logoUpload')}</span></button>` : ''}</div></div>`)}
            ${panel('contact', t('cfg.s.contact'), html`
              <div class="pe-grid">
                ${text('contact_whatsapp', t('cfg.whatsapp'), v, { hint: t('cfg.whatsappHint'), attrs: PHONE_ATTRS })}
                ${text('contact_phone', t('cfg.phone'), v, { attrs: PHONE_ATTRS })}
              </div>
              ${text('contact_email', t('cfg.email'), v, { type: 'email', attrs: { maxlength: L.email, autocomplete: 'off' } })}
              ${text('contact_address', t('cfg.address'), v, { type: 'textarea', rows: 2, attrs: { maxlength: L.address } })}`, t('cfg.contactHelp'))}
            ${panel('social', t('cfg.s.social'), html`<div class="pe-grid">
                ${['facebook', 'instagram', 'youtube', 'tiktok'].map((k) => text(`social_${k}`, t(`cfg.${k}`), v, { type: 'url', attrs: { maxlength: L.url, autocomplete: 'off', placeholder: 'https://' } }))}
              </div>`, t('cfg.socialHelp'))}
            ${panel('payments', t('cfg.s.payments'), html`
              ${fieldHtml({ name: 'pay_cod_enabled', label: t('cfg.cod'), type: 'switch', value: v.pay_cod_enabled, hint: t('cfg.codHint') })}
              ${WALLETS.map((w) => wallet(w, v))}`, t('cfg.paymentsHelp'))}
            ${panel('orders', t('cfg.s.orders'), html`<div class="pe-grid">
                ${text('returnWindowDays', t('cfg.returnDays'), v, { type: 'number', hint: t('cfg.returnDaysHint'), suffix: t('cfg.days'), attrs: { min: 0, max: L.returnWindowMax, step: 1, inputmode: 'numeric' } })}
                ${priv ? text('lowStockThreshold', t('cfg.lowStock'), v, { type: 'number', hint: t('cfg.lowStockHint'), attrs: { min: 0, max: L.lowStockMax, step: 1, inputmode: 'numeric' } }) : ''}
              </div>`)}
            ${panel('announce', t('cfg.s.announce'), html`
              ${fieldHtml({ name: 'ann_enabled', label: t('cfg.annOn'), type: 'switch', value: v.ann_enabled })}
              <div class="pe-grid">
                ${text('ann_text', t('cfg.annText'), v, { attrs: { maxlength: L.announcement } })}
                ${text('ann_link', t('cfg.annLink'), v, { hint: t('cfg.annLinkHint'), attrs: { maxlength: L.url, autocomplete: 'off' } })}
              </div>`, t('cfg.announceHelp'))}
            ${panel('seo', t('cfg.s.seo'), html`
              ${text('seo_title', t('cfg.seoTitle'), v, { attrs: { maxlength: L.seoTitle } })}
              ${text('seo_description', t('cfg.seoDesc'), v, { type: 'textarea', rows: 2, attrs: { maxlength: L.seoDescription } })}`, t('cfg.seoHelp'))}
            ${priv ? panel('invoice', t('cfg.s.invoice'), html`
              <div class="pe-grid">
                ${text('inv_businessName', t('cfg.invName'), v, { attrs: { maxlength: L.invoiceName } })}
                ${text('inv_phone', t('cfg.invPhone'), v, { attrs: { maxlength: L.invoicePhone } })}
              </div>
              ${text('inv_address', t('cfg.invAddress'), v, { type: 'textarea', rows: 2, attrs: { maxlength: L.invoiceAddress } })}
              ${text('inv_note', t('cfg.invNote'), v, { type: 'textarea', rows: 2, attrs: { maxlength: L.invoiceNote } })}`, t('cfg.invoiceHelp')) : ''}
            ${priv ? panel('notify', t('cfg.s.notify'), html`
              ${text('notifyEmails', t('cfg.notifyEmails'), v, { type: 'textarea', rows: 3, hint: t('cfg.notifyHint'), attrs: { autocomplete: 'off', spellcheck: 'false' } })}`, t('cfg.notifyHelp')) : ''}
            ${panel('chat', t('cfg.s.chat'), html`
              ${fieldHtml({ name: 'tawk_enabled', label: t('cfg.chatOn'), type: 'switch', value: v.tawk_enabled })}
              <div class="pe-grid">
                ${text('tawk_propertyId', t('cfg.chatProperty'), v, { attrs: { maxlength: 40, autocomplete: 'off', spellcheck: 'false' } })}
                ${text('tawk_widgetId', t('cfg.chatWidget'), v, { attrs: { maxlength: 40, autocomplete: 'off', spellcheck: 'false' } })}
              </div>`, t('cfg.chatHelp'))}
            ${panel('display', t('cfg.s.display'), html`${fieldHtml({ name: 'ui_banglaDigits', label: t('cfg.bnDigits'), type: 'switch', value: v.ui_banglaDigits })}`)}
          </div></fieldset>
          ${canWrite ? html`<div class="sticky-bar pe-bar"><span class="muted small" id="cfg-dirty" role="status"></span>
            <button type="button" class="btn" data-action="discard">${t('cfg.discard')}</button>
            <button type="submit" class="btn btn-primary">${t('cfg.save')}</button></div>` : ''}
        </form>`;
      };

      render(ctx.el, html`<div class="cfg" id="cfg-page">${pageHead({ title: t('cfg.title'), sub: t('cfg.sub') })}<div id="cfg-host"></div></div>`);
      const host = () => ctx.el.querySelector('#cfg-host');
      const paint = () => { render(host(), formHtml()); dirty = false; };
      paint();

      const markDirty = () => { if (!dirty) { dirty = true; const el = ctx.el.querySelector('#cfg-dirty'); if (el) el.textContent = t('cfg.unsaved'); } };
      ctx.el.addEventListener('input', markDirty);
      ctx.el.addEventListener('change', markDirty);
      const guard = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
      window.addEventListener('beforeunload', guard);
      ctx.cleanup(() => { ctx.el.removeEventListener('input', markDirty); ctx.el.removeEventListener('change', markDirty); window.removeEventListener('beforeunload', guard); });

      ctx.cleanup(bindActions(ctx.el, {
        discard: async () => {
          if (dirty && !(await confirmDialog({ title: t('cfg.discardTitle'), message: t('cfg.discardText'), confirmText: t('cfg.discard'), danger: true }))) return;
          paint();
        },
        'logo-upload': async (btn) => {
          const [file] = await pickFiles();
          if (!file) return;
          await withBusy(btn, async () => {
            try {
              const r = await uploadSiteImage('logo', file, { maxSide: 512, quality: 0.9 });
              const input = ctx.el.querySelector('#f-logoUrl');
              input.value = r.url; input.removeAttribute('aria-invalid');
              markDirty();
            } catch (e) { if (!isRefusal(e)) reportError(e, 'settings.logo'); toastError(explainError(e)); }
          });
        },
      }, {
        submit: {
          settings: async (form) => {
            if (!canWrite) return;
            const btn = form.querySelector('[type="submit"]');
            await withBusy(btn, async () => {
              showFormErrors(form, {});
              try {
                await saveSettings({ form: readForm(form), current: docs });
              } catch (e) {
                if (e && e.errors) { showFormErrors(form, e.errors); toastError(e.message); return; }
                if (e && e.code === 'no_change') { toast(t('cfg.noChange'), { type: 'info' }); return; }
                if (!isRefusal(e)) reportError(e, 'settings.save');
                toastError(explainError(e));
                return;
              }
              docs = await loadSettingsDocs();
              paint();
              toast(t('common.saved'));
            });
          },
        },
      }));
    });
  },
};
