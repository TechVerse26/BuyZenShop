/*
 * Checkout — /checkout   (sign-in required: see routes.js)
 *
 *   address (saved or new) → delivery zone from the district → payment (COD / bKash / Nagad) → note → place order
 *
 * The page never decides money: quoteOrder() re-reads inventory + coupon from Firestore and shows the totals; placeOrder()
 * re-reads them again, builds one atomic batch and firestore.rules re-derive price, stock, discount and delivery charge.
 * bKash / Nagad orders are stored as "awaiting verification": a customer-typed TrxID is a claim, not proof.
 * A retry re-uses the same order number, so a lost response can never create a second order.
 *
 * The form is uncontrolled (inputs are mirrored into `st.form` on every keystroke) and painted in independent regions, so a
 * browser auto-fill or a late price quote never wipes what the person is typing.
 */
import { html, render, raw, bindActions, setMeta, safeUrl, copyText } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, emptyState, errorState, toast, toastError, announce, fieldHtml, badge } from '../../core/ui.js';
import { explainError, AppError } from '../../core/errors.js';
import { money, num, fmtPhone } from '../../core/format.js';
import { local } from '../../core/storage.js';
import { cart, resolveCart } from '../../data/cart.js';
import { loadCatalog, refreshInventory } from '../../data/catalog.js';
import { loadZones, settings, enabledPayments } from '../../data/settings.js';
import { getAuthState, currentUid } from '../../data/auth.js';
import { listAddresses, saveAddress } from '../../data/account.js';
import { quoteOrder, placeOrder, getMyOrder, couponMessage } from '../../data/orders.js';
import { zoneForDistrict, freeShippingGap } from '../../shared/pricing.js';
import { assetUrl } from '../../shared/productModel.js';
import { STORAGE_KEYS } from '../../shared/constants.js';
import { normalizeCouponCode, makeOrderNumber } from '../../shared/id.js';
import { emptyForm, validateForm, toOrderInput, formFromAddress, isMobileMethod } from '../lib/checkoutForm.js';
import { districtOptions } from '../lib/districts.js';

registerBoth({
  'co.title': ['Checkout', 'চেকআউট'],
  'co.empty': ['Your cart is empty', 'আপনার কার্ট খালি'],
  'co.shop': ['Browse the shop', 'শপ দেখুন'],
  'co.loadError': ['Checkout could not be loaded.', 'চেকআউট লোড করা যায়নি।'],
  'co.h.address': ['Delivery address', 'ডেলিভারির ঠিকানা'],
  'co.h.payment': ['Payment', 'পেমেন্ট'],
  'co.h.note': ['Order note', 'অর্ডার নোট'],
  'co.saved': ['Saved addresses', 'সেভ করা ঠিকানা'],
  'co.useNew': ['Use a different address', 'অন্য ঠিকানা ব্যবহার করুন'],
  'co.default': ['Default', 'ডিফল্ট'],
  'co.f.name': ['Full name', 'পূর্ণ নাম'],
  'co.f.phone': ['Mobile number', 'মোবাইল নম্বর'],
  'co.f.phoneHint': ['We call this number to confirm delivery.', 'ডেলিভারি নিশ্চিত করতে এই নম্বরে ফোন করা হবে।'],
  'co.f.email': ['Email (optional)', 'ইমেইল (ঐচ্ছিক)'],
  'co.f.district': ['District', 'জেলা'],
  'co.f.districtPick': ['Choose a district', 'জেলা বেছে নিন'],
  'co.f.upazila': ['Upazila / thana (optional)', 'উপজেলা / থানা (ঐচ্ছিক)'],
  'co.f.area': ['Area / village (optional)', 'এলাকা / গ্রাম (ঐচ্ছিক)'],
  'co.f.postal': ['Postal code (optional)', 'পোস্টাল কোড (ঐচ্ছিক)'],
  'co.f.line1': ['Full address', 'পূর্ণ ঠিকানা'],
  'co.f.line1Ph': ['House, road, landmark', 'বাড়ি, রাস্তা, পরিচিত স্থান'],
  'co.f.save': ['Save this address for next time', 'পরেরবারের জন্য ঠিকানাটি সেভ করুন'],
  'co.f.note': ['Note for us (optional)', 'আমাদের জন্য নোট (ঐচ্ছিক)'],
  'co.f.notePh': ['Delivery instructions, preferred time …', 'ডেলিভারি নির্দেশনা, পছন্দের সময় …'],
  'co.f.sender': ['Number you paid from', 'যে নম্বর থেকে টাকা পাঠিয়েছেন'],
  'co.f.trx': ['Transaction ID (TrxID)', 'ট্রানজেকশন আইডি (TrxID)'],
  'co.e.name': ['Enter your full name.', 'আপনার পূর্ণ নাম লিখুন।'],
  'co.e.phone': ['Enter a valid mobile number (01XXXXXXXXX).', 'সঠিক মোবাইল নম্বর দিন (০১XXXXXXXXX)।'],
  'co.e.email': ['Enter a valid email address, or leave it empty.', 'সঠিক ইমেইল দিন, অথবা ফাঁকা রাখুন।'],
  'co.e.district': ['Choose your district.', 'আপনার জেলা বেছে নিন।'],
  'co.e.zone': ['We do not deliver to this district yet.', 'এই জেলায় এখনও ডেলিভারি দেওয়া হচ্ছে না।'],
  'co.e.line1': ['Enter your full address (house, road, area).', 'পূর্ণ ঠিকানা লিখুন (বাড়ি, রাস্তা, এলাকা)।'],
  'co.e.method': ['Choose a payment method.', 'পেমেন্ট পদ্ধতি বেছে নিন।'],
  'co.e.trx': ['Enter the transaction ID from your payment message (6–20 letters or digits).', 'পেমেন্ট মেসেজের ট্রানজেকশন আইডি দিন (৬–২০টি অক্ষর/সংখ্যা)।'],
  'co.e.sender': ['Enter the mobile number you paid from.', 'যে নম্বর থেকে টাকা পাঠিয়েছেন সেটি দিন।'],
  'co.e.trxUsed': ['This transaction ID was not accepted — it is probably already attached to another order. Check it in your payment message.', 'এই ট্রানজেকশন আইডি গ্রহণ করা যায়নি — সম্ভবত এটি আগেই অন্য অর্ডারে ব্যবহার হয়েছে। পেমেন্ট মেসেজে আবার দেখুন।'],
  'co.fixErrors': ['Please fix the highlighted fields.', 'চিহ্নিত ঘরগুলো ঠিক করুন।'],
  'co.noMethods': ['No payment method is available right now. Please contact us to place an order.', 'এখন কোনো পেমেন্ট পদ্ধতি চালু নেই। অর্ডার করতে আমাদের সাথে যোগাযোগ করুন।'],
  'co.delivery': ['Delivery', 'ডেলিভারি'],
  'co.eta': ['{min}–{max} days', '{min}–{max} দিন'],
  'co.eta1': ['{n} days', '{n} দিন'],
  'co.freeOver': ['free over {amount}', '{amount}-এর বেশি কিনলে ফ্রি'],
  'co.noZone': ['We do not deliver to this district yet. Please contact us for options.', 'এই জেলায় এখনও ডেলিভারি দেওয়া হচ্ছে না। বিকল্পের জন্য যোগাযোগ করুন।'],
  'co.m.cod': ['Cash on Delivery', 'ক্যাশ অন ডেলিভারি'],
  'co.m.codText': ['Pay in cash when your order arrives.', 'পণ্য হাতে পেয়ে নগদে পরিশোধ করুন।'],
  'co.m.bkash': ['bKash', 'বিকাশ'],
  'co.m.nagad': ['Nagad', 'নগদ'],
  'co.m.mobileText': ['Send Money, then enter the TrxID.', 'সেন্ড মানি করে TrxID লিখুন।'],
  'co.pay.s1': ['Open the {app} app and choose Send Money.', '{app} অ্যাপ খুলে Send Money বেছে নিন।'],
  'co.pay.s2': ['Send {amount} to {number} ({type}).', '{number} ({type}) নম্বরে {amount} পাঠান।'],
  'co.pay.s2n': ['Send the order total shown in the summary to {number} ({type}).', 'সারাংশে দেখানো মোট টাকা {number} ({type}) নম্বরে পাঠান।'],
  'co.pay.s3': ['Enter the TrxID from the confirmation message and the number you paid from.', 'কনফার্মেশন মেসেজের TrxID এবং যে নম্বর থেকে পাঠিয়েছেন সেটি লিখুন।'],
  'co.pay.copy': ['Copy number', 'নম্বর কপি করুন'],
  'co.pay.copied': ['Number copied', 'নম্বর কপি হয়েছে'],
  'co.pay.note': ['Your order is placed as "awaiting payment verification" and confirmed only after our team checks the payment. Typing a TrxID does not confirm it by itself.', 'অর্ডারটি "পেমেন্ট যাচাইয়ের অপেক্ষায়" অবস্থায় জমা হবে; আমাদের টিম পেমেন্ট মিলিয়ে দেখার পরই নিশ্চিত হবে। শুধু TrxID লিখলেই পেমেন্ট নিশ্চিত হয় না।'],
  'co.sum': ['Order summary', 'অর্ডারের সারাংশ'],
  'co.qty': ['Qty {n}', 'পরিমাণ {n}'],
  'co.unavailable': ['Unavailable item', 'অনুপলব্ধ পণ্য'],
  'co.subtotal': ['Subtotal', 'সাবটোটাল'],
  'co.discount': ['Discount ({code})', 'ছাড় ({code})'],
  'co.free': ['Free', 'ফ্রি'],
  'co.chooseDistrict': ['Choose a district', 'জেলা বেছে নিন'],
  'co.total': ['Total', 'মোট'],
  'co.freeGap': ['Add {amount} more for free delivery.', 'ফ্রি ডেলিভারির জন্য আরও {amount} কিনুন।'],
  'co.coupon': ['Coupon code', 'কুপন কোড'],
  'co.apply': ['Apply', 'প্রয়োগ'],
  'co.remove': ['Remove', 'সরান'],
  'co.couponEmpty': ['Enter a coupon code.', 'কুপন কোড লিখুন।'],
  'co.couponZone': ['Choose your delivery district first, then apply the coupon.', 'আগে ডেলিভারির জেলা বেছে নিন, তারপর কুপন দিন।'],
  'co.couponOn': ['Coupon {code} applied', 'কুপন {code} প্রয়োগ হয়েছে'],
  'co.place': ['Place order', 'অর্ডার করুন'],
  'co.placeTotal': ['Place order · {total}', 'অর্ডার করুন · {total}'],
  'co.placing': ['Placing your order…', 'অর্ডার জমা হচ্ছে…'],
  'co.checking': ['Checking prices…', 'দাম যাচাই হচ্ছে…'],
  'co.editCart': ['Edit cart', 'কার্ট সম্পাদনা'],
  'co.issues': ['Some items need your attention:', 'কিছু পণ্য দেখা দরকার:'],
  'co.reviewCart': ['Review your cart', 'কার্ট দেখুন'],
  'co.cartIssue': ['This item is not available right now.', 'এই পণ্যটি এখন পাওয়া যাচ্ছে না।'],
  'co.codNote': ['You pay the courier when the order arrives.', 'অর্ডার পৌঁছালে কুরিয়ারকে টাকা দেবেন।'],
  'co.secure': ['Prices and stock are checked again when you place the order.', 'অর্ডার দেওয়ার সময় দাম ও স্টক আবার যাচাই হয়।'],
});

const METHOD_KEY = { cod: 'co.m.cod', bkash: 'co.m.bkash', nagad: 'co.m.nagad' };
const FIELD_NAMES = ['name', 'phone', 'email', 'district', 'line1', 'method', 'trxId', 'senderNumber'];
const RELOAD_CODES = ['stock', 'unavailable', 'max_per_order', 'changed', 'coupon', 'key', 'qty'];

export default {
  async mount(ctx) {
    loadCss('/css/pages/checkout.css');
    setMeta({ title: t('co.title'), noindex: true });
    const uid = currentUid();
    const keys = cart.lines().map((l) => l.key);
    if (!keys.length) {
      render(ctx.el, html`<div class="container page"><h1 class="page-title">${t('co.title')}</h1>${emptyState({ icon: 'cart', title: t('co.empty'), action: { href: '/shop', label: t('co.shop') } })}</div>`);
      return;
    }
    render(ctx.el, html`<div class="container page" aria-busy="true"><h1 class="page-title">${t('co.title')}</h1><div class="skeleton" style="height:240px;border-radius:var(--r-lg)"></div></div>`);

    let cat; let zones; let addresses;
    try {
      [cat, zones, addresses] = await Promise.all([
        loadCatalog().then((c) => refreshInventory(keys).catch(() => c)),
        loadZones(),
        listAddresses(uid).catch(() => []),
      ]);
    } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(ctx.el, html`<div class="container page">${errorState({ text: t('co.loadError') })}</div>`);
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;

    /* ───────── state ───────── */
    const auth = getAuthState();
    const email = (auth.profile && auth.profile.email) || (auth.user && auth.user.email) || '';
    const methods = enabledPayments();
    const st = {
      addresses,
      addrId: addresses.length ? addresses[0].id : 'new',
      form: emptyForm({
        name: (auth.profile && auth.profile.displayName) || '', phone: (auth.profile && auth.profile.phone) || '',
        email, saveAddress: addresses.length === 0, method: methods[0] || '',
      }),
      errors: {},
      coupon: { input: normalizeCouponCode(ctx.query.coupon || local.get(STORAGE_KEYS.pendingCoupon) || ''), applied: '', msg: '', busy: false },
      quote: null, quoting: false, placing: false, alert: '', orderNumber: '',
    };
    if (addresses.length) st.form = formFromAddress(addresses[0], st.form);

    const resolved = () => resolveCart(cat);
    const zone = () => zoneForDistrict(zones, st.form.district);
    const methodLabel = (m) => t(METHOD_KEY[m]);
    const mobileCfg = (m) => (settings().payments || {})[m] || {};
    const quoteTotal = () => (st.quote && st.quote.totals ? st.quote.totals.total : null);
    const lineName = (l) => (l.state === 'removed' ? t('co.unavailable') : l.name);

    /* ───────── quote (live totals) ───────── */
    let seq = 0;
    const payableLines = () => resolved().lines.filter((l) => l.state === 'ok').map((l) => ({ key: l.key, qty: l.qty, name: l.name }));
    const requote = async () => {
      const mine = ++seq;
      st.quoting = true; paintTotals();
      let q;
      try {
        q = await quoteOrder({ uid, lines: payableLines(), zone: zone(), couponCode: st.coupon.applied });
        if (st.coupon.applied && q.coupon && !q.coupon.ok && q.coupon.reason !== 'none') {     // an applied coupon stopped qualifying
          st.coupon.msg = couponMessage(q.coupon.reason, { min: q.coupon.min }); st.coupon.applied = '';
          q = await quoteOrder({ uid, lines: payableLines(), zone: zone(), couponCode: '' });
          paintCoupon();
        }
      } catch (e) { console.error(e); q = { ok: false, issues: [], totals: null, error: explainError(e) }; }
      if (mine !== seq || ctx.signal.aborted) return;
      st.quote = q; st.quoting = false;
      paintTotals(); paintSteps();
    };
    ctx.cleanup(() => { seq += 1; });

    /* ───────── markup: address ───────── */
    const addrCard = (a) => html`<label class="co-card ${st.addrId === a.id ? 'is-on' : ''}">
      <input type="radio" name="addr" value="${a.id}" data-change="addr" ${st.addrId === a.id ? 'checked' : ''}>
      <span class="co-card-body">
        <strong>${a.name} ${a.label ? html`<span class="muted">· ${a.label}</span>` : ''} ${a.isDefault ? badge(t('co.default'), 'brand') : ''}</strong>
        <span>${fmtPhone(a.phone)}</span>
        <span class="muted">${[a.line1, a.area, a.upazila, a.district].filter(Boolean).join(', ')}</span>
      </span></label>`;

    const addressFields = () => html`<div class="form-grid co-fields">
      ${fieldHtml({ name: 'name', label: t('co.f.name'), value: st.form.name, required: true, autocomplete: 'name', attrs: { 'data-input': 'field' } })}
      ${fieldHtml({ name: 'phone', label: t('co.f.phone'), type: 'tel', value: st.form.phone, required: true, autocomplete: 'tel', inputmode: 'tel', hint: t('co.f.phoneHint'), attrs: { 'data-input': 'field' } })}
      ${fieldHtml({ name: 'email', label: t('co.f.email'), type: 'email', value: st.form.email, autocomplete: 'email', inputmode: 'email', span2: true, attrs: { 'data-input': 'field' } })}
      <div class="field"><label for="f-district" class="req">${t('co.f.district')}</label>
        <select class="select" id="f-district" name="district" data-change="district" aria-describedby="err-district" autocomplete="address-level1">
          <option value="">${t('co.f.districtPick')}</option>
          ${districtOptions(st.form.district)}
        </select><div class="field-error" id="err-district" aria-live="polite"></div></div>
      ${fieldHtml({ name: 'upazila', label: t('co.f.upazila'), value: st.form.upazila, attrs: { 'data-input': 'field' } })}
      ${fieldHtml({ name: 'area', label: t('co.f.area'), value: st.form.area, attrs: { 'data-input': 'field' } })}
      ${fieldHtml({ name: 'postalCode', label: t('co.f.postal'), value: st.form.postalCode, inputmode: 'numeric', autocomplete: 'postal-code', attrs: { 'data-input': 'field' } })}
      ${fieldHtml({ name: 'line1', label: t('co.f.line1'), type: 'textarea', rows: 2, value: st.form.line1, required: true, placeholder: t('co.f.line1Ph'), autocomplete: 'street-address', span2: true, attrs: { 'data-input': 'field' } })}
      ${fieldHtml({ name: 'saveAddress', label: t('co.f.save'), type: 'checkbox', value: st.form.saveAddress, span2: true, attrs: { 'data-change': 'save' } })}
    </div>`;

    const deliveryBlock = () => {
      if (!st.form.district) return html``;
      const z = zone();
      if (!z) return html`<p class="co-zone is-bad" role="alert">${icon('alert-circle', { size: 18 })}<span>${t('co.noZone')}</span></p>`;
      const eta = z.etaMin && z.etaMax ? (z.etaMin === z.etaMax ? t('co.eta1', { n: num(z.etaMax) }) : t('co.eta', { min: num(z.etaMin), max: num(z.etaMax) })) : '';
      const parts = [z.fee ? money(z.fee) : t('co.free'), eta, z.freeOver != null ? t('co.freeOver', { amount: money(z.freeOver) }) : ''].filter(Boolean);
      return html`<p class="co-zone">${icon('truck', { size: 18 })}<span><strong>${z.name}</strong> — ${parts.join(' · ')}</span></p>`;
    };

    const addrSection = () => html`
      <h2 id="co-h-addr"><span class="co-n" aria-hidden="true">1</span>${t('co.h.address')}</h2>
      ${st.addresses.length ? html`<div class="co-cards" role="radiogroup" aria-label="${t('co.saved')}">
        ${st.addresses.map(addrCard)}
        <label class="co-card ${st.addrId === 'new' ? 'is-on' : ''}"><input type="radio" name="addr" value="new" data-change="addr" ${st.addrId === 'new' ? 'checked' : ''}><span class="co-card-body"><strong>${t('co.useNew')}</strong></span></label>
      </div>` : ''}
      ${st.addrId === 'new' ? addressFields() : ''}
      <div id="co-delivery" aria-live="polite">${deliveryBlock()}</div>`;

    /* ───────── markup: payment ───────── */
    const stepsHtml = () => {
      const m = st.form.method;
      const cfg = mobileCfg(m);
      const amt = quoteTotal();
      const vars = { number: cfg.number || '—', type: cfg.accountType || '' };
      return html`<ol class="co-steps">
          <li>${t('co.pay.s1', { app: methodLabel(m) })}</li>
          <li>${amt != null ? t('co.pay.s2', { ...vars, amount: money(amt) }) : t('co.pay.s2n', vars)}
            ${cfg.number ? html` <button type="button" class="btn btn-secondary btn-sm" data-action="copy" data-number="${cfg.number}">${icon('copy', { size: 14 })}<span>${t('co.pay.copy')}</span></button>` : ''}</li>
          <li>${t('co.pay.s3')}</li>
        </ol>
        ${cfg.note ? html`<p class="muted small">${cfg.note}</p>` : ''}`;
    };

    const paySection = () => html`
      <h2 id="co-h-pay"><span class="co-n" aria-hidden="true">2</span>${t('co.h.payment')}</h2>
      ${methods.length ? html`<div class="co-cards" role="radiogroup" aria-labelledby="co-h-pay">
        ${methods.map((m) => html`<label class="co-card ${st.form.method === m ? 'is-on' : ''}">
          <input type="radio" name="method" value="${m}" data-change="method" ${st.form.method === m ? 'checked' : ''}>
          <span class="co-card-body"><strong>${methodLabel(m)}</strong><span class="muted">${m === 'cod' ? t('co.m.codText') : t('co.m.mobileText')}</span></span></label>`)}
      </div>` : html`<p class="alert alert-warn" role="alert">${icon('alert-triangle', { size: 18 })}<span>${t('co.noMethods')}</span></p>`}
      <div class="field-error" id="err-method" aria-live="polite"></div>
      ${isMobileMethod(st.form.method) ? html`<div class="co-pay">
        <div id="co-steps">${stepsHtml()}</div>
        <div class="form-grid co-fields">
          ${fieldHtml({ name: 'senderNumber', label: t('co.f.sender'), type: 'tel', value: st.form.senderNumber, required: true, inputmode: 'tel', autocomplete: 'off', attrs: { 'data-input': 'field' } })}
          ${fieldHtml({ name: 'trxId', label: t('co.f.trx'), value: st.form.trxId, required: true, autocomplete: 'off', attrs: { 'data-input': 'field', autocapitalize: 'characters', spellcheck: 'false', maxlength: 24 } })}
        </div>
        <div class="alert co-verify">${icon('info', { size: 18 })}<span>${t('co.pay.note')}</span></div>
      </div>` : ''}`;

    /* ───────── markup: summary ───────── */
    const linesHtml = () => html`<ul class="co-lines">${resolved().lines.map((l) => {
      const img = l.image || (l.product && l.product.image) || '';
      return html`<li>
        <span class="co-thumb">${img ? html`<img src="${safeUrl(assetUrl(img))}" alt="" width="48" height="48" loading="lazy" decoding="async">` : icon('image', { size: 20 })}</span>
        <span class="co-line-body"><span class="co-line-name">${lineName(l)}</span>${l.variantLabel ? html`<span class="muted small">${l.variantLabel}</span>` : ''}<span class="muted small">${t('co.qty', { n: num(l.qty) })}</span></span>
        <span class="co-line-total">${l.state === 'ok' ? money(l.lineTotal) : '—'}</span></li>`;
    })}</ul>`;

    const couponHtml = () => (st.coupon.applied
      ? html`<p class="co-coupon-on">${icon('check-circle', { size: 18 })}<span>${t('co.couponOn', { code: st.coupon.applied })}</span><button type="button" class="btn btn-link btn-sm" data-action="coupon-remove">${t('co.remove')}</button></p>`
      : html`<form class="co-coupon-row" data-form="coupon" novalidate>
          <div class="field"><label class="sr-only" for="co-coupon">${t('co.coupon')}</label>
            <input class="input" id="co-coupon" name="coupon" value="${st.coupon.input}" placeholder="${t('co.coupon')}" autocomplete="off" autocapitalize="characters" spellcheck="false" data-input="coupon" aria-describedby="co-coupon-err" ${st.coupon.msg ? raw('aria-invalid="true"') : ''}></div>
          <button type="submit" class="btn btn-secondary" ${st.coupon.busy ? 'disabled' : ''}>${t('co.apply')}</button>
        </form>
        <p class="field-error" id="co-coupon-err" role="alert">${st.coupon.msg}</p>`);

    const issueText = (i) => (i.code === 'stock' ? t('order.err.stock') : i.code === 'max_per_order' ? t('order.err.max_per_order') : t('co.cartIssue'));
    const totalsHtml = () => {
      const r = resolved();
      const q = st.quote;
      const totals = q && q.totals;
      const z = zone();
      const subtotal = totals ? totals.subtotal : r.subtotal;
      const quoteIssues = (q && q.issues) || [];
      const cartIssues = r.issues > 0;
      const blocked = cartIssues || quoteIssues.length > 0 || st.placing || st.quoting || !!(q && q.error);
      const gap = z && totals ? freeShippingGap(z, totals.subtotal - (totals.discount || 0)) : null;
      return html`
        <dl class="co-totals">
          <div><dt>${t('co.subtotal')}</dt><dd>${money(subtotal)}</dd></div>
          ${totals && totals.discount ? html`<div class="is-discount"><dt>${t('co.discount', { code: st.coupon.applied })}</dt><dd>−${money(totals.discount)}</dd></div>` : ''}
          <div><dt>${t('co.delivery')}</dt><dd>${totals ? (totals.shipping ? money(totals.shipping) : t('co.free')) : t('co.chooseDistrict')}</dd></div>
          <div class="is-total"><dt>${t('co.total')}</dt><dd>${totals ? money(totals.total) : money(subtotal)}</dd></div>
        </dl>
        ${gap ? html`<p class="co-gap muted small">${icon('truck', { size: 14 })}<span>${t('co.freeGap', { amount: money(gap) })}</span></p>` : ''}
        ${quoteIssues.length || cartIssues ? html`<div class="alert alert-warn" role="alert">${icon('alert-triangle', { size: 18 })}<div><p>${t('co.issues')}</p>
          <ul>${quoteIssues.map((i) => { const l = r.lines.find((x) => x.key === i.key); return html`<li><strong>${l ? lineName(l) : t('co.unavailable')}</strong> — ${issueText(i)}</li>`; })}${cartIssues && !quoteIssues.length ? html`<li>${t('co.cartIssue')}</li>` : ''}</ul>
          <a href="/cart">${t('co.reviewCart')}</a></div></div>` : ''}
        ${q && q.error ? html`<div class="alert alert-bad" role="alert">${icon('alert-circle', { size: 18 })}<div><p>${q.error}</p><button type="button" class="btn btn-link btn-sm" data-action="requote">${t('common.retry')}</button></div></div>` : ''}
        ${st.alert ? html`<div class="alert alert-bad" role="alert">${icon('alert-circle', { size: 18 })}<div><p>${st.alert}</p></div></div>` : ''}
        <button type="submit" form="co-form" class="btn btn-primary btn-lg btn-block" ${blocked ? 'disabled' : ''} ${st.placing ? raw('aria-busy="true"') : ''}>
          ${st.placing ? html`<span class="spinner" aria-hidden="true"></span><span>${t('co.placing')}</span>` : (totals ? t('co.placeTotal', { total: money(totals.total) }) : (st.quoting ? t('co.checking') : t('co.place')))}
        </button>
        ${st.form.method === 'cod' ? html`<p class="muted small co-note">${t('co.codNote')}</p>` : ''}
        <p class="muted small co-note">${icon('lock', { size: 14 })}<span>${t('co.secure')}</span></p>
        <a class="co-edit" href="/cart">${t('co.editCart')}</a>`;
    };

    /* ───────── shell + painters ───────── */
    render(ctx.el, html`<div class="container page co">
      <h1 class="page-title">${t('co.title')}</h1>
      <div class="co-grid">
        <form class="co-main" id="co-form" data-form="place" novalidate>
          <section class="co-sec" id="co-s-addr" aria-labelledby="co-h-addr"></section>
          <section class="co-sec" id="co-s-pay" aria-labelledby="co-h-pay"></section>
          <section class="co-sec" aria-labelledby="co-h-note">
            <h2 id="co-h-note"><span class="co-n" aria-hidden="true">3</span>${t('co.h.note')}</h2>
            ${fieldHtml({ name: 'note', label: t('co.f.note'), type: 'textarea', rows: 2, value: st.form.note, placeholder: t('co.f.notePh'), attrs: { 'data-input': 'field', maxlength: 300 } })}
          </section>
        </form>
        <aside class="co-side" aria-labelledby="cos-h">
          <h2 id="cos-h">${t('co.sum')}</h2>
          <div id="co-lines"></div>
          <div class="co-coupon" id="co-coupon-box"></div>
          <div id="co-totals"></div>
        </aside>
      </div></div>`);
    const $id = (id) => ctx.el.querySelector(`#${id}`);
    const formEl = $id('co-form');

    const showErrors = (errors, { focus = false } = {}) => {
      const controls = [...formEl.elements];
      let first = null;
      for (const name of FIELD_NAMES) {
        const code = errors[name];
        const slot = formEl.querySelector(`#err-${name}`);
        const ctl = controls.find((c) => c.name === name);
        if (slot) slot.textContent = code ? t(`co.e.${code}`) : '';
        if (ctl && ctl.type !== 'radio') { if (code) ctl.setAttribute('aria-invalid', 'true'); else ctl.removeAttribute('aria-invalid'); }
        if (code && ctl && !first) first = ctl;
      }
      if (focus && first) first.focus({ preventScroll: false });
      return first;
    };
    const paintAddr = () => { render($id('co-s-addr'), addrSection()); showErrors(st.errors); };
    const paintDelivery = () => { render($id('co-delivery'), deliveryBlock()); };
    const paintPay = () => { render($id('co-s-pay'), paySection()); showErrors(st.errors); };
    const paintSteps = () => { const el = $id('co-steps'); if (el) render(el, stepsHtml()); };
    const paintLines = () => { render($id('co-lines'), linesHtml()); };
    const paintCoupon = () => { render($id('co-coupon-box'), couponHtml()); };
    const paintTotals = () => { render($id('co-totals'), totalsHtml()); };

    /* ───────── actions ───────── */
    const clearError = (name) => { if (st.errors[name]) { delete st.errors[name]; showErrors(st.errors); } };

    const applyCoupon = async () => {
      const code = normalizeCouponCode(st.coupon.input);
      const fail = (msg) => { st.coupon.msg = msg; st.coupon.busy = false; paintCoupon(); const i = $id('co-coupon'); if (i) i.focus(); };
      if (!code) { fail(t('co.couponEmpty')); return; }
      if (!zone()) { fail(t('co.couponZone')); return; }
      st.coupon.busy = true; st.coupon.msg = ''; paintCoupon();
      try {
        const q = await quoteOrder({ uid, lines: payableLines(), zone: zone(), couponCode: code });
        if (ctx.signal.aborted) return;
        if (q.coupon && q.coupon.ok) {
          seq += 1;                                                    // this answer is newer than any quote still in flight
          Object.assign(st.coupon, { applied: code, input: '', msg: '', busy: false });
          st.quote = q; local.remove(STORAGE_KEYS.pendingCoupon);
          paintCoupon(); paintTotals(); paintSteps();
          toast(t('co.couponOn', { code })); announce(t('co.couponOn', { code }));
        } else fail(couponMessage((q.coupon && q.coupon.reason) || 'not_found', { min: q.coupon && q.coupon.min }));
      } catch (e) { if (!ctx.signal.aborted) fail(explainError(e)); }
    };

    const alreadyPlaced = async () => {                              // a "failed" attempt may really have been written (lost response)
      if (!st.orderNumber) return false;
      try { return !!(await getMyOrder(st.orderNumber)); } catch { return false; }
    };
    const finish = (orderNumber) => {
      cart.clear();
      local.remove(STORAGE_KEYS.pendingCoupon);
      ctx.router.navigate(`/order-success/${orderNumber}`, { replace: true });
    };

    const place = async () => {
      if (st.placing) return;
      const errors = validateForm(st.form, { methods });
      if (!errors.district && !zone()) errors.district = 'zone';
      st.errors = errors; st.alert = '';
      if (Object.keys(errors).length) {
        if (st.addrId !== 'new' && (errors.name || errors.phone || errors.district || errors.line1)) { st.addrId = 'new'; paintAddr(); }   // an incomplete saved address: let the person fix it
        if (!showErrors(errors, { focus: true })) { st.alert = t('co.fixErrors'); }
        announce(t('co.fixErrors'));
        paintTotals();
        return;
      }
      const r = resolved();
      if (r.issues > 0) { paintTotals(); return; }
      if (st.quoting || quoteTotal() == null) { await requote(); return; }        // the person must see a final total before it is charged
      const shown = quoteTotal();
      st.placing = true; paintTotals();
      st.orderNumber ||= makeOrderNumber(settings().orderPrefix || 'SV');
      try {
        const input = toOrderInput(st.form, { email });
        const res = await placeOrder({
          uid, orderNumber: st.orderNumber, ...input, zone: zone(), couponCode: st.coupon.applied, expectTotal: shown,
          lines: r.lines.map((l) => ({ key: l.key, qty: l.qty, name: l.name, variantLabel: l.variantLabel, image: assetUrl(l.image || (l.product && l.product.image) || ''), sku: l.sku })),
        });
        if (st.addrId === 'new' && st.form.saveAddress) {
          saveAddress(uid, { ...input.address, label: '', isDefault: st.addresses.length === 0 }).catch((e) => console.warn('address not saved', e));
        }
        finish(res.orderNumber);
      } catch (e) {
        if ((!(e instanceof AppError) || e.attempted) && await alreadyPlaced()) { finish(st.orderNumber); return; }
        if (ctx.signal.aborted) return;
        st.placing = false;
        const code = e instanceof AppError ? e.code : '';
        const msg = e instanceof AppError ? e.message : explainError(e);
        const fieldFor = { trx_used: ['trxId', 'trxUsed'], trx: ['trxId', 'trx'], sender: ['senderNumber', 'sender'], phone: ['phone', 'phone'], zone: ['district', 'zone'], method: ['method', 'method'] }[code];
        st.errors = fieldFor ? { [fieldFor[0]]: fieldFor[1] } : {};
        if (fieldFor) {
          if (fieldFor[0] === 'trxId' || fieldFor[0] === 'senderNumber' || fieldFor[0] === 'method') paintPay(); else paintAddr();
          if (!showErrors(st.errors, { focus: true })) st.alert = msg;
        } else st.alert = msg;
        if (st.alert) toastError(msg);
        if (RELOAD_CODES.includes(code) || e.refresh) {
          try { cat = await refreshInventory(keys); } catch { /* keep the old view */ }
          if (code === 'coupon') { st.coupon.applied = ''; st.coupon.msg = msg; paintCoupon(); }
          paintLines();
          await requote();
        } else paintTotals();
      }
    };

    ctx.cleanup(bindActions(ctx.el, {
      'coupon-remove': () => { st.coupon.applied = ''; st.coupon.msg = ''; paintCoupon(); requote(); },
      requote: () => requote(),
      copy: async (b) => { if (await copyText(b.dataset.number)) toast(t('co.pay.copied')); },
    }, {
      change: {
        addr: (el) => {
          st.addrId = el.value; st.errors = {};
          st.form = el.value === 'new'
            ? { ...st.form, district: '', upazila: '', area: '', postalCode: '', line1: '' }
            : formFromAddress(st.addresses.find((a) => a.id === el.value) || {}, st.form);
          paintAddr(); requote();
        },
        district: (el) => { st.form.district = el.value; clearError('district'); paintDelivery(); requote(); },
        method: (el) => {
          st.form.method = el.value;
          delete st.errors.method; delete st.errors.trxId; delete st.errors.senderNumber;
          paintPay(); paintTotals();
        },
        save: (el) => { st.form.saveAddress = el.checked; },
      },
      input: {
        field: (el) => { st.form[el.name] = el.value; clearError(el.name); },
        coupon: (el) => {
          st.coupon.input = el.value;
          if (st.coupon.msg) { st.coupon.msg = ''; const m = $id('co-coupon-err'); if (m) m.textContent = ''; el.removeAttribute('aria-invalid'); }
        },
      },
      submit: { place: () => place(), coupon: () => applyCoupon() },
    }));

    paintAddr();
    paintPay();
    paintLines();
    paintCoupon();
    paintTotals();
    requote();
  },
};
