/*
 * Setup & migration — "is the store ready to sell?", moving the old data to the new structure, and the first-time guide.
 *
 *   Your access        who you are signed in as, your role and UID (the UID is what the first Super Admin record needs)
 *   Store readiness    a checklist computed from the real data (shared/readiness.js); what this role cannot read is "not checked"
 *   Migration          preview → confirm → run; non-destructive and safe to repeat (shared/migration.js). Super Admin only
 *   First-time guide   deploy rules → create the first Super Admin → migrate → settings → shipping → test order
 *   Problems seen      errors this browser has logged since the page was opened (helps when reporting a bug)
 *
 * Open to every active staff member: the checklist is read-only for them.
 */
import { html, render, bindActions, copyText, withBusy } from '../../core/dom.js';
import { registerBoth, t, lbl } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, toast, toastError, confirmDialog } from '../../core/ui.js';
import { explainError, isRefusal, reportError, recentErrors } from '../../core/errors.js';
import { fmtTime, num } from '../../core/format.js';
import { getAuthState, can } from '../../data/auth.js';
import { ROLES } from '../../shared/constants.js';
import { evaluateReadiness, summarize } from '../../shared/readiness.js';
import { safeMount, pageHead, kvList } from '../lib/ui.js';
import { gatherSnapshot, previewMigration, runMigration } from '../data/setup.js';

registerBoth({
  'stp.title': ['Setup & migration', 'সেটআপ ও মাইগ্রেশন'],
  'stp.sub': ['Is the store ready to sell? Move the old data to the new structure and follow the first-time guide.', 'স্টোর কি বিক্রির জন্য প্রস্তুত? পুরনো ডেটা নতুন কাঠামোয় আনুন এবং প্রথমবারের গাইড অনুসরণ করুন।'],
  'stp.recheck': ['Check again', 'আবার যাচাই করুন'],
  /* access */
  'stp.access': ['Your access', 'আপনার অ্যাক্সেস'],
  'stp.signedAs': ['Signed in as', 'লগইন করা অ্যাকাউন্ট'],
  'stp.role': ['Role', 'রোল'],
  'stp.uid': ['Your UID', 'আপনার UID'],
  'stp.copy': ['Copy', 'কপি'],
  'stp.copied': ['Copied', 'কপি হয়েছে'],
  /* readiness */
  'stp.ready': ['Store readiness', 'স্টোর প্রস্তুতি'],
  'stp.summary': ['{ok} of {n} checks passed', '{n}টির মধ্যে {ok}টি যাচাই ঠিক আছে'],
  'stp.problems': ['{n} need attention', '{n}টিতে মনোযোগ দরকার'],
  'stp.truncated': ['The store has more products than this page reads at once, so some checks may be incomplete.', 'স্টোরে এই পেজের একবারে পড়ার চেয়ে বেশি প্রোডাক্ট আছে, তাই কিছু যাচাই অসম্পূর্ণ হতে পারে।'],
  'stp.c.skip': ['Not checked — your role cannot read this.', 'যাচাই করা হয়নি — আপনার রোল এটি পড়তে পারে না।'],
  'stp.c.settings.title': ['Store settings', 'স্টোর সেটিংস'],
  'stp.c.settings.ok': ['The settings document exists.', 'সেটিংস ডকুমেন্ট আছে।'],
  'stp.c.settings.bad': ['Store settings are missing. Run the migration below (or save the Settings page once).', 'স্টোর সেটিংস নেই। নিচের মাইগ্রেশন চালান (অথবা সেটিংস পেজ একবার সেভ করুন)।'],
  'stp.c.contact.title': ['Contact details', 'যোগাযোগের তথ্য'],
  'stp.c.contact.ok': ['{n} contact detail(s) are shown on the storefront.', 'স্টোরফ্রন্টে {n}টি যোগাযোগের তথ্য দেখানো হয়।'],
  'stp.c.contact.warn': ['No WhatsApp number, phone or e-mail is set — customers cannot reach you.', 'হোয়াটসঅ্যাপ, ফোন বা ইমেইল কিছুই নেই — কাস্টমার যোগাযোগ করতে পারবে না।'],
  'stp.c.payments.title': ['Payment methods', 'পেমেন্ট মাধ্যম'],
  'stp.c.payments.ok': ['{n} payment method(s) are switched on.', '{n}টি পেমেন্ট মাধ্যম চালু আছে।'],
  'stp.c.payments.bad.none': ['No payment method is switched on — nobody can check out.', 'কোনো পেমেন্ট মাধ্যম চালু নেই — কেউ অর্ডার করতে পারবে না।'],
  'stp.c.payments.bad.number': ['bKash/Nagad is on without a valid mobile number: {methods}.', 'bKash/Nagad চালু কিন্তু সঠিক মোবাইল নম্বর নেই: {methods}।'],
  'stp.c.shipping.title': ['Shipping zones', 'শিপিং জোন'],
  'stp.c.shipping.ok': ['{zones} active zone(s) cover every district.', '{zones}টি সক্রিয় জোন সব জেলা কভার করে।'],
  'stp.c.shipping.warn': ['{zones} active zone(s), but {uncovered} district(s) are not covered — orders to them cannot be placed.', '{zones}টি সক্রিয় জোন আছে, কিন্তু {uncovered}টি জেলা কভার হয়নি — সেখানকার অর্ডার নেওয়া যাবে না।'],
  'stp.c.shipping.bad': ['No active shipping zone — checkout cannot work out the delivery charge.', 'কোনো সক্রিয় শিপিং জোন নেই — চেকআউট ডেলিভারি চার্জ হিসাব করতে পারবে না।'],
  'stp.c.categories.title': ['Categories', 'ক্যাটাগরি'],
  'stp.c.categories.ok': ['{n} visible categor(ies).', '{n}টি দৃশ্যমান ক্যাটাগরি।'],
  'stp.c.categories.warn': ['No visible category yet.', 'এখনো কোনো দৃশ্যমান ক্যাটাগরি নেই।'],
  'stp.c.products.title': ['Products', 'প্রোডাক্ট'],
  'stp.c.products.ok': ['{published} of {total} products are published.', '{total}টির মধ্যে {published}টি প্রোডাক্ট প্রকাশিত।'],
  'stp.c.products.warn': ['No published product yet.', 'এখনো কোনো প্রকাশিত প্রোডাক্ট নেই।'],
  'stp.c.products.bad': ['{legacy} of {total} products are still in the old format. Run the migration before editing or selling them.', '{total}টির মধ্যে {legacy}টি প্রোডাক্ট এখনো পুরনো ফরম্যাটে। সম্পাদনা বা বিক্রির আগে মাইগ্রেশন চালান।'],
  'stp.c.inventory.title': ['Stock records', 'স্টক রেকর্ড'],
  'stp.c.inventory.ok': ['Every product has its stock record.', 'প্রতিটি প্রোডাক্টের স্টক রেকর্ড আছে।'],
  'stp.c.inventory.bad': ['{missing} sellable item(s) have no stock record, so they cannot be ordered.', '{missing}টি বিক্রয়যোগ্য আইটেমের স্টক রেকর্ড নেই, তাই অর্ডার করা যাবে না।'],
  'stp.c.home.title': ['Homepage layout', 'হোমপেজ লেআউট'],
  'stp.c.home.ok': ['The homepage layout is saved.', 'হোমপেজ লেআউট সেভ করা আছে।'],
  'stp.c.home.warn': ['No homepage layout saved yet. Run the migration or open Homepage and save once.', 'হোমপেজ লেআউট এখনো সেভ করা হয়নি। মাইগ্রেশন চালান অথবা হোমপেজ খুলে একবার সেভ করুন।'],
  'stp.c.invoice.title': ['Invoice details', 'ইনভয়েসের তথ্য'],
  'stp.c.invoice.ok': ['Business name and address are set for invoices.', 'ইনভয়েসের জন্য ব্যবসার নাম ও ঠিকানা দেওয়া আছে।'],
  'stp.c.invoice.warn': ['Invoices have no business name or address yet.', 'ইনভয়েসে এখনো ব্যবসার নাম বা ঠিকানা নেই।'],
  'stp.c.staff.title': ['Super Admins', 'সুপার অ্যাডমিন'],
  'stp.c.staff.ok': ['{supers} active Super Admins — good.', '{supers} জন সক্রিয় সুপার অ্যাডমিন — ভালো।'],
  'stp.c.staff.warn': ['Only one Super Admin. If that account is lost, nobody can manage staff or migrate. Add a second one.', 'মাত্র একজন সুপার অ্যাডমিন। সেই অ্যাকাউন্ট হারালে কেউ স্টাফ ম্যানেজ বা মাইগ্রেশন করতে পারবে না। আরেকজন যোগ করুন।'],
  'stp.c.staff.bad': ['No active Super Admin.', 'কোনো সক্রিয় সুপার অ্যাডমিন নেই।'],
  'stp.fix.migrate': ['Go to migration', 'মাইগ্রেশনে যান'],
  'stp.fix.settings': ['Open Settings', 'সেটিংস খুলুন'],
  'stp.fix.shipping': ['Open Shipping', 'শিপিং খুলুন'],
  'stp.fix.categories': ['Open Categories', 'ক্যাটাগরি খুলুন'],
  'stp.fix.products': ['Open Products', 'প্রোডাক্ট খুলুন'],
  'stp.fix.staff': ['Open Staff', 'স্টাফ খুলুন'],
  /* migration */
  'stp.mig.title': ['Move the old data to the new structure', 'পুরনো ডেটা নতুন কাঠামোয় আনুন'],
  'stp.mig.lead': ['Converts the products of the old site, creates stock records, categories, shipping zones, settings and the homepage layout. Nothing from the old site is deleted, and anything already converted is skipped, so it is safe to run again.', 'পুরনো সাইটের প্রোডাক্ট রূপান্তর করে এবং স্টক রেকর্ড, ক্যাটাগরি, শিপিং জোন, সেটিংস ও হোমপেজ লেআউট তৈরি করে। পুরনো সাইটের কিছুই মুছে যায় না; যা আগেই রূপান্তরিত তা বাদ যায়, তাই আবার চালানো নিরাপদ।'],
  'stp.mig.only': ['Only a Super Admin can run the migration. You can still see the checklist above.', 'শুধু সুপার অ্যাডমিন মাইগ্রেশন চালাতে পারেন। উপরের চেকলিস্ট আপনি দেখতে পারেন।'],
  'stp.mig.preview': ['Check what will change', 'কী বদলাবে দেখুন'],
  'stp.mig.run': ['Run the migration', 'মাইগ্রেশন চালান'],
  'stp.mig.nothing': ['Nothing to migrate', 'মাইগ্রেশনের কিছু নেই'],
  'stp.mig.nothingText': ['Everything is already in the new structure.', 'সবকিছু আগেই নতুন কাঠামোয় আছে।'],
  'stp.mig.toConvert': ['Products to convert', 'রূপান্তর হবে এমন প্রোডাক্ট'],
  'stp.mig.alreadyNew': ['Already in the new structure', 'আগেই নতুন কাঠামোয়'],
  'stp.mig.drafts': ['Imported as drafts (need your attention)', 'ড্রাফট হিসেবে আসবে (আপনার দেখা দরকার)'],
  'stp.mig.stock': ['Stock records to create', 'নতুন স্টক রেকর্ড'],
  'stp.mig.stockDetail': ['{tracked} counted at 0, {untracked} without a limit', '{tracked}টি ০ গণনায়, {untracked}টি সীমাহীন'],
  'stp.mig.cats': ['Categories to create', 'নতুন ক্যাটাগরি'],
  'stp.mig.zones': ['Shipping zones to create', 'নতুন শিপিং জোন'],
  'stp.mig.settings': ['Store settings and homepage layout', 'স্টোর সেটিংস ও হোমপেজ লেআউট'],
  'stp.mig.willCreate': ['will be created', 'তৈরি হবে'],
  'stp.mig.exist': ['already exist', 'আগেই আছে'],
  'stp.mig.coupon': ['Old voucher SHOPVERSE', 'পুরনো ভাউচার SHOPVERSE'],
  'stp.mig.couponDetail': ['becomes a coupon, with {n} usage record(s)', 'কুপন হবে, {n}টি ব্যবহারের রেকর্ডসহ'],
  'stp.mig.writes': ['Writes', 'লেখা হবে'],
  'stp.mig.writesDetail': ['{ops} documents in {steps} steps', '{steps}টি ধাপে {ops}টি ডকুমেন্ট'],
  'stp.mig.notes': ['Notes', 'নোট'],
  'stp.mig.more': ['…and {n} more', '…আরও {n}টি'],
  'stp.mig.confirmTitle': ['Run the migration?', 'মাইগ্রেশন চালাবেন?'],
  'stp.mig.confirmText': ['It will write {ops} documents in {steps} steps. Nothing is deleted. If it stops half-way, check again and run it again — it continues where it stopped.', 'এটি {steps}টি ধাপে {ops}টি ডকুমেন্ট লিখবে। কিছুই মুছবে না। মাঝপথে থামলে আবার "কী বদলাবে দেখুন" চালিয়ে আবার চালান — যেখানে থেমেছিল সেখান থেকে এগোবে।'],
  'stp.mig.progress': ['Step {done} of {total}…', 'ধাপ {done}/{total}…'],
  'stp.mig.done': ['Migration finished ({total} steps). The checklist was updated.', 'মাইগ্রেশন শেষ ({total}টি ধাপ)। চেকলিস্ট হালনাগাদ হয়েছে।'],
  'stp.mig.partial': ['It stopped after {done} of {total} steps. Check again and run it again to continue.', '{total}টির মধ্যে {done}টি ধাপের পর থেমে গেছে। আবার দেখে নিয়ে আবার চালান — বাকিটা চলবে।'],
  'stp.w.settings_created': ['Store settings were created from the old site (WhatsApp, e-mail, Facebook, bKash/Nagad number). The Nagad number was copied from the single number the old checkout showed for both wallets — please check it in Settings.', 'পুরনো সাইট থেকে স্টোর সেটিংস তৈরি হবে (হোয়াটসঅ্যাপ, ইমেইল, ফেসবুক, bKash/Nagad নম্বর)। পুরনো চেকআউটে দুই ওয়ালেটে একই নম্বর দেখানো হত, তাই Nagad নম্বরটি সেটাই কপি হবে — সেটিংসে মিলিয়ে নিন।'],
  'stp.w.zones_created': ['Shipping zones will be created from the old flat charges (Sirajganj and everywhere else). Adjust them in Shipping.', 'পুরনো ফ্ল্যাট চার্জ (সিরাজগঞ্জ ও বাকি সব জায়গা) থেকে শিপিং জোন তৈরি হবে। শিপিং পেজে প্রয়োজনমতো বদলান।'],
  'stp.w.price_rounded': ['Product "{name}": the price {from} will be rounded to {to} (prices are whole taka).', 'প্রোডাক্ট "{name}": দাম {from} বদলে {to} হবে (দাম পূর্ণ টাকায়)।'],
  'stp.w.draft': ['Product "{name}" will be imported as a draft: {reason}. Open it, fix it and publish.', 'প্রোডাক্ট "{name}" ড্রাফট হিসেবে আসবে: {reason}। খুলে ঠিক করে প্রকাশ করুন।'],
  'stp.w.draft.no_name': ['it has no name', 'নাম নেই'],
  'stp.w.draft.no_price': ['the price is missing or zero', 'দাম নেই বা শূন্য'],
  'stp.w.draft.price_too_large': ['the price is too large', 'দাম অনেক বেশি'],
  'stp.w.untracked': ['{n} product(s) were "In Stock" on the old site, which had no quantities. They will be imported without a stock limit. Enter real counts in Inventory to switch stock control on.', 'পুরনো সাইটে {n}টি প্রোডাক্ট "In Stock" ছিল, কিন্তু সংখ্যা ছিল না। সেগুলো সীমাহীন স্টকে আসবে। স্টক নিয়ন্ত্রণ চালু করতে ইনভেন্টরিতে আসল সংখ্যা দিন।'],
  /* guide */
  'stp.guide.title': ['First-time setup guide', 'প্রথমবারের সেটআপ গাইড'],
  'stp.g1.t': ['1 · Publish the security rules', '১ · সিকিউরিটি রুলস পাবলিশ করুন'],
  'stp.g1.p': ['Publish firestore.rules and storage.rules: Firebase console → Firestore → Rules and Storage → Rules (or run firebase deploy --only firestore:rules,storage). Until then the new site cannot read or write anything.', 'firestore.rules ও storage.rules পাবলিশ করুন: Firebase console → Firestore → Rules এবং Storage → Rules (অথবা firebase deploy --only firestore:rules,storage)। তার আগে নতুন সাইট কিছু পড়তে বা লিখতে পারবে না।'],
  'stp.g2.t': ['2 · Create the first Super Admin', '২ · প্রথম সুপার অ্যাডমিন বানান'],
  'stp.g2.p': ['Sign up on the store with the owner\'s e-mail, then open /admin/ — the "not staff" screen shows your UID. In Firebase console → Firestore create the collection staff and add a document whose ID is that UID, with the fields role = super_admin (string), active = true (boolean), email (string), name (string) and createdAt (timestamp). Nothing on the website can do this for you — that is deliberate, so nobody can make themselves an admin.', 'মালিকের ইমেইলে স্টোরে সাইন আপ করুন, তারপর /admin/ খুলুন — "স্টাফ নয়" স্ক্রিনে আপনার UID দেখাবে। Firebase console → Firestore-এ staff কালেকশন বানিয়ে সেই UID-কে ডকুমেন্ট আইডি ধরে ফিল্ডগুলো দিন: role = super_admin (string), active = true (boolean), email (string), name (string), createdAt (timestamp)। ওয়েবসাইট থেকে এটি করা যায় না — ইচ্ছাকৃতভাবেই, যাতে কেউ নিজেকে অ্যাডমিন বানাতে না পারে।'],
  'stp.g3.t': ['3 · Move the old data', '৩ · পুরনো ডেটা আনুন'],
  'stp.g3.p': ['Use "Move the old data to the new structure" above. Then open Inventory and enter real stock counts.', 'উপরের "পুরনো ডেটা নতুন কাঠামোয় আনুন" ব্যবহার করুন। তারপর ইনভেন্টরিতে আসল স্টক সংখ্যা দিন।'],
  'stp.g4.t': ['4 · Fill in the settings', '৪ · সেটিংস ভরুন'],
  'stp.g4.p': ['Settings: store name, contact details, the bKash and Nagad numbers customers pay to, return window and invoice details. Then check Shipping and Categories.', 'সেটিংস: স্টোরের নাম, যোগাযোগ, যে bKash ও Nagad নম্বরে কাস্টমার টাকা পাঠাবে, রিটার্নের সময় ও ইনভয়েসের তথ্য। তারপর শিপিং ও ক্যাটাগরি দেখুন।'],
  'stp.g5.t': ['5 · Add a second Super Admin', '৫ · দ্বিতীয় সুপার অ্যাডমিন যোগ করুন'],
  'stp.g5.p': ['In Staff & roles add a trusted second Super Admin, so the store is never locked if one account is lost.', 'স্টাফ ও রোলে একজন বিশ্বস্ত দ্বিতীয় সুপার অ্যাডমিন যোগ করুন, যাতে একটি অ্যাকাউন্ট হারালেও স্টোর তালাবদ্ধ না হয়।'],
  'stp.g6.t': ['6 · Place a test order', '৬ · একটি টেস্ট অর্ডার দিন'],
  'stp.g6.p': ['Order as a customer (cash on delivery), then confirm it, pack it and mark it delivered here, and check that stock and the invoice look right.', 'কাস্টমার হিসেবে একটি অর্ডার দিন (ক্যাশ অন ডেলিভারি), তারপর এখানে কনফার্ম, প্যাক ও ডেলিভারড করে স্টক ও ইনভয়েস ঠিক আছে কি না দেখুন।'],
  /* problems */
  'stp.err.title': ['Problems seen in this browser', 'এই ব্রাউজারে ধরা সমস্যা'],
  'stp.err.none': ['None since this page was opened.', 'পেজ খোলার পর কিছু ধরা পড়েনি।'],
  'stp.err.copy': ['Copy details', 'বিবরণ কপি'],
  'stp.err.lead': ['Technical details, useful when you report a problem. They are kept only in this tab.', 'প্রযুক্তিগত বিবরণ — সমস্যা জানানোর সময় কাজে লাগে। শুধু এই ট্যাবে থাকে।'],
});

const ICON = { ok: 'check-circle', warn: 'alert-triangle', bad: 'x-circle', skip: 'info' };
const FIX = {
  migrate: { perm: 'migrate.run', act: 'goto-migrate' },
  settings: { perm: 'settings.read', path: '/settings' },
  shipping: { perm: 'shipping.write', path: '/shipping' },
  categories: { perm: 'products.read', path: '/categories' },
  products: { perm: 'products.read', path: '/products' },
  staff: { perm: 'staff.manage', path: '/staff' },
};

export default {
  async mount(ctx) {
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      const auth = getAuthState();
      let snap = await gatherSnapshot();
      if (ctx.signal.aborted) return;
      let checks = evaluateReadiness(snap);
      let plan = null;
      let progress = '';
      let result = null;

      const checkText = (c) => {
        if (c.status === 'skip') return t('stp.c.skip');
        const key = `stp.c.${c.id}.${c.status}${c.params && c.params.reason ? `.${c.params.reason}` : ''}`;
        return t(key, c.params);
      };
      const checkRow = (c) => {
        const fix = c.fix && FIX[c.fix];
        const link = fix && can(fix.perm)
          ? (fix.act ? html`<button type="button" class="btn btn-sm" data-action="${fix.act}">${t(`stp.fix.${c.fix}`)}</button>` : html`<a class="btn btn-sm" href="${href(fix.path)}">${t(`stp.fix.${c.fix}`)}</a>`)
          : '';
        return html`<li class="stp-${c.status}">${icon(ICON[c.status], { size: 20 })}<div><strong>${t(`stp.c.${c.id}.title`)}</strong><div class="small muted">${checkText(c)}</div></div>${link}</li>`;
      };

      const paintChecks = () => {
        const sum = summarize(checks);
        const bad = sum.bad + sum.warn;
        render(ctx.el.querySelector('#stp-checks'), html`
          <div class="row row-between row-wrap mb-3"><h2 class="section-h">${t('stp.ready')}</h2>
            <span class="row gap-2">${badge(t('stp.summary', { ok: num(sum.ok), n: num(sum.total - sum.skip) }), bad ? 'warn' : 'ok')}${bad ? badge(t('stp.problems', { n: num(bad) }), 'neutral') : ''}</span></div>
          ${snap.truncated ? html`<p class="alert alert-warn mb-3">${icon('alert-triangle', { size: 18 })}<span>${t('stp.truncated')}</span></p>` : ''}
          <ul class="stp-checks">${checks.map(checkRow)}</ul>`);
      };

      const migrateBody = () => {
        if (!can('migrate.run')) return html`<p class="muted">${t('stp.mig.only')}</p>`;
        const lead = html`<p class="muted mb-4">${t('stp.mig.lead')}</p>`;
        if (result) {
          return html`${lead}<p class="alert alert-ok mb-3" role="status">${icon('check-circle', { size: 18 })}<span>${result}</span></p>
            <button type="button" class="btn" data-action="mig-preview">${t('stp.mig.preview')}</button>`;
        }
        if (!plan) return html`${lead}<button type="button" class="btn btn-primary" data-action="mig-preview">${t('stp.mig.preview')}</button>`;
        if (plan.nothingToDo) {
          return html`${lead}<p class="alert alert-ok mb-3" role="status">${icon('check-circle', { size: 18 })}<span><strong>${t('stp.mig.nothing')}.</strong> ${t('stp.mig.nothingText')}</span></p>
            <button type="button" class="btn" data-action="mig-preview">${t('stp.mig.preview')}</button>`;
        }
        const r = plan.report;
        const steps = Math.ceil(plan.ops.length / 18);
        const shown = r.warnings.slice(0, 12);
        const warnText = (w) => {
          if (!w.code) return w.text;
          const p = { ...(w.params || {}) };
          if (w.code === 'draft') p.reason = t(`stp.w.draft.${p.reason}`);
          return t(`stp.w.${w.code}`, p, w.text);
        };
        return html`${lead}
          ${kvList([
    [t('stp.mig.toConvert'), `${num(r.products.migrated)} / ${num(r.products.total)}`],
    [t('stp.mig.alreadyNew'), num(r.products.alreadyNew)],
    r.products.drafted ? [t('stp.mig.drafts'), html`<span class="text-warn strong">${num(r.products.drafted)}</span>`] : null,
    [t('stp.mig.stock'), html`${num(r.products.inventoryCreated)}${r.products.inventoryCreated ? html` <span class="muted small">(${t('stp.mig.stockDetail', { tracked: num(r.products.tracked), untracked: num(r.products.untracked) })})</span>` : ''}`],
    [t('stp.mig.cats'), num(r.categoriesCreated)],
    [t('stp.mig.zones'), num(r.zonesCreated)],
    [t('stp.mig.settings'), r.settingsCreated || r.homeCreated ? t('stp.mig.willCreate') : t('stp.mig.exist')],
    r.coupon.created ? [t('stp.mig.coupon'), t('stp.mig.couponDetail', { n: num(r.coupon.usageRecords) })] : null,
    [t('stp.mig.writes'), t('stp.mig.writesDetail', { ops: num(plan.ops.length), steps: num(steps) })],
  ])}
          ${shown.length ? html`<h3 class="mt-4 mb-2" style="font-size:var(--fs-md)">${t('stp.mig.notes')}</h3>
            <ul class="stp-notes">${shown.map((w) => html`<li class="stp-${w.level === 'warn' ? 'warn' : 'info'}">${icon(w.level === 'warn' ? 'alert-triangle' : 'info', { size: 18 })}<span>${warnText(w)}</span></li>`)}
              ${r.warnings.length > shown.length ? html`<li class="muted small">${t('stp.mig.more', { n: num(r.warnings.length - shown.length) })}</li>` : ''}</ul>` : ''}
          <div class="row row-wrap mt-4"><button type="button" class="btn btn-primary" data-action="mig-run">${t('stp.mig.run')}</button>
            <button type="button" class="btn" data-action="mig-preview">${t('stp.mig.preview')}</button>
            <span class="small muted" id="stp-progress" role="status" aria-live="polite">${progress}</span></div>`;
      };
      const paintMigrate = () => render(ctx.el.querySelector('#stp-migrate'), html`<h2 class="section-h mb-3">${t('stp.mig.title')}</h2>${migrateBody()}`);

      const paintErrors = () => {
        const list = recentErrors();
        render(ctx.el.querySelector('#stp-errors'), html`
          <div class="row row-between row-wrap mb-2"><h2 class="section-h">${t('stp.err.title')}</h2>${list.length ? html`<button type="button" class="btn btn-sm" data-action="copy-errors">${t('stp.err.copy')}</button>` : ''}</div>
          <p class="small muted mb-3">${t('stp.err.lead')}</p>
          ${list.length ? html`<ul class="stp-errors">${list.map((e) => html`<li><span class="mono">${fmtTime(e.at)}</span> <span class="mono muted">${e.context || '—'}${e.code ? ` · ${e.code}` : ''}</span><div class="small">${e.message}</div></li>`)}</ul>` : html`<p class="muted">${t('stp.err.none')}</p>`}`);
      };

      const guideSteps = [1, 2, 3, 4, 5, 6];
      render(ctx.el, html`
        ${pageHead({ title: t('stp.title'), sub: t('stp.sub'), actions: html`<button type="button" class="btn" data-action="recheck">${icon('history', { size: 18 })}<span>${t('stp.recheck')}</span></button>` })}
        <div class="stp-cards">
          <section class="card card-pad" aria-labelledby="stp-access-h"><h2 class="section-h mb-3" id="stp-access-h">${t('stp.access')}</h2>
            ${kvList([
    [t('stp.signedAs'), (auth.user && auth.user.email) || '—'],
    [t('stp.role'), auth.staff ? badge(lbl(ROLES[auth.staff.role]) || auth.staff.role, auth.staff.role === 'super_admin' ? 'brand' : 'neutral') : '—'],
    [t('stp.uid'), html`<span class="row gap-2"><span class="mono" id="stp-uid">${(auth.user && auth.user.uid) || '—'}</span><button type="button" class="btn btn-sm" data-action="copy-uid">${t('stp.copy')}</button></span>`],
  ])}</section>
          <section class="card card-pad" id="stp-checks" aria-live="polite"></section>
          <section class="card card-pad" id="stp-migrate"></section>
          <section class="card card-pad" aria-labelledby="stp-guide-h"><h2 class="section-h mb-2" id="stp-guide-h">${t('stp.guide.title')}</h2>
            <div class="accordion">${guideSteps.map((n) => html`<details><summary>${t(`stp.g${n}.t`)}</summary><div class="acc-body"><p>${t(`stp.g${n}.p`)}</p></div></details>`)}</div></section>
          <section class="card card-pad" id="stp-errors"></section>
        </div>`);
      paintChecks(); paintMigrate(); paintErrors();

      const recheck = async (btn) => {
        await withBusy(btn, async () => {
          try { snap = await gatherSnapshot(); checks = evaluateReadiness(snap); paintChecks(); paintErrors(); } catch (e) { if (!isRefusal(e)) reportError(e, 'setup.check'); toastError(explainError(e)); }
        });
      };

      const preview = async (btn) => {
        await withBusy(btn, async () => {
          try { result = null; progress = ''; plan = await previewMigration(); paintMigrate(); } catch (e) { if (!isRefusal(e)) reportError(e, 'setup.preview'); toastError(explainError(e)); paintErrors(); }
        });
      };

      const run = async (btn) => {
        if (!plan || plan.nothingToDo) return;
        const nSteps = Math.ceil(plan.ops.length / 18);
        if (!(await confirmDialog({ title: t('stp.mig.confirmTitle'), message: t('stp.mig.confirmText', { ops: num(plan.ops.length), steps: num(nSteps) }), confirmText: t('stp.mig.run') }))) return;
        await withBusy(btn, async () => {
          try {
            const r = await runMigration(plan, { onProgress: (done, total) => { progress = t('stp.mig.progress', { done: num(done), total: num(total) }); const el = ctx.el.querySelector('#stp-progress'); if (el) el.textContent = progress; } });
            result = t('stp.mig.done', { total: num(r.total) });
            plan = null; progress = '';
            toast(result);
            snap = await gatherSnapshot(); checks = evaluateReadiness(snap);
            paintChecks();
          } catch (e) {
            if (!isRefusal(e)) reportError(e, 'setup.run');
            const done = Number.isFinite(e && e.chunksDone) ? e.chunksDone : 0;
            toastError(done ? `${explainError(e)} ${t('stp.mig.partial', { done: num(done), total: num(nSteps) })}` : explainError(e));
            plan = null; progress = '';
          }
          paintMigrate(); paintErrors();
        });
      };

      ctx.cleanup(bindActions(ctx.el, {
        recheck, 'mig-preview': preview, 'mig-run': run,
        'goto-migrate': () => { const el = ctx.el.querySelector('#stp-migrate'); if (el) { el.scrollIntoView({ block: 'start' }); const b = el.querySelector('[data-action="mig-preview"]'); if (b) b.focus({ preventScroll: true }); } },
        'copy-uid': async () => { const ok = await copyText((auth.user && auth.user.uid) || ''); if (ok !== false) toast(t('stp.copied')); },
        'copy-errors': async () => {
          const text = recentErrors().map((e) => `${new Date(e.at).toISOString()}  ${e.context}  ${e.code}  ${e.message}`).join('\n');
          const ok = await copyText(text); if (ok !== false) toast(t('stp.copied'));
        },
      }));
    });
  },
};
