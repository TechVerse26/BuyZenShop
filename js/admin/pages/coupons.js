/*
 * Coupons — discount codes (permission: coupons.read to look, coupons.write to change).
 *
 *   List     code, offer, conditions, uses, validity and status; search and status filter; details for everyone who may open the page
 *   Dialog   new / edit: kind (percent, fixed, free delivery), minimum order, dates, usage limits, categories or products, customers
 *   Actions  switch off / on, delete a coupon that was never used
 *
 * The rules of the game live in shared/couponFlow.js (validation, status, audit text). The ORDER rule re-checks every coupon when an
 * order is placed — what is shown or saved here never decides a price.
 */
import { html, render, bindActions, readForm, raw, debounce } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, toast, toastError, formDialog, confirmDialog, fieldHtml, openMenu, openModal, paginationHtml, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { money, num, fmtDate, fmtDateTime, toDhakaInput, fromDhakaInput } from '../../core/format.js';
import { can } from '../../data/auth.js';
import { toMillis } from '../../shared/pricing.js';
import { couponStatus } from '../../shared/couponFlow.js';
import { safeMount, pageHead, needs, searchField, kvList } from '../lib/ui.js';
import { loadCoupons, loadScope, customerLabels, saveCoupon, setCouponActive, removeCoupon } from '../data/coupons.js';

registerBoth({
  'cpn.title': ['Coupons', 'কুপন'],
  'cpn.sub': ['Discount codes customers type at checkout. Every coupon is checked again by the server when an order is placed.', 'গ্রাহক চেকআউটে যে ডিসকাউন্ট কোড লেখেন। অর্ডার দেওয়ার সময় সার্ভার প্রতিটি কুপন আবার যাচাই করে।'],
  'cpn.add': ['New coupon', 'নতুন কুপন'],
  'cpn.search': ['Search by code or note', 'কোড বা নোট দিয়ে খুঁজুন'],
  'cpn.f.status': ['Status', 'অবস্থা'],
  'cpn.f.allStatus': ['All statuses', 'সব অবস্থা'],
  'cpn.status.live': ['Live', 'চালু'],
  'cpn.status.scheduled': ['Scheduled', 'নির্ধারিত'],
  'cpn.status.expired': ['Expired', 'মেয়াদ শেষ'],
  'cpn.status.exhausted': ['Used up', 'সীমা শেষ'],
  'cpn.status.disabled': ['Switched off', 'বন্ধ'],
  'cpn.col.code': ['Code', 'কোড'],
  'cpn.col.offer': ['Offer', 'অফার'],
  'cpn.col.used': ['Used', 'ব্যবহার'],
  'cpn.col.valid': ['Valid', 'মেয়াদ'],
  'cpn.col.status': ['Status', 'অবস্থা'],
  'cpn.offer.percent': ['{value}% off', '{value}% ছাড়'],
  'cpn.offer.percentCap': ['{value}% off, up to {max}', '{value}% ছাড় (সর্বোচ্চ {max})'],
  'cpn.offer.fixed': ['{amount} off', '{amount} ছাড়'],
  'cpn.offer.free': ['Free delivery', 'ফ্রি ডেলিভারি'],
  'cpn.cond.min': ['Min order {amount}', 'ন্যূনতম অর্ডার {amount}'],
  'cpn.cond.sale': ['Sale items excluded', 'সেল পণ্য বাদ'],
  'cpn.scope.all': ['All products', 'সব পণ্য'],
  'cpn.scope.categories_one': ['{n} category', '{n}টি ক্যাটাগরি'],
  'cpn.scope.categories_other': ['{n} categories', '{n}টি ক্যাটাগরি'],
  'cpn.scope.products_one': ['{n} product', '{n}টি পণ্য'],
  'cpn.scope.products_other': ['{n} products', '{n}টি পণ্য'],
  'cpn.cond.customers_one': ['{n} customer only', 'শুধু {n}জন গ্রাহক'],
  'cpn.cond.customers_other': ['{n} customers only', 'শুধু {n}জন গ্রাহক'],
  'cpn.used.of': ['{used} of {limit}', '{limit}-এর মধ্যে {used}'],
  'cpn.used.per': ['{n} per customer', 'প্রতি গ্রাহকে {n}'],
  'cpn.valid.always': ['No dates', 'তারিখ নেই'],
  'cpn.valid.from': ['From {date}', '{date} থেকে'],
  'cpn.valid.until': ['Until {date}', '{date} পর্যন্ত'],
  'cpn.valid.range': ['{from} – {to}', '{from} – {to}'],
  'cpn.menu.more': ['Actions for {code}', '{code}-এর অ্যাকশন'],
  'cpn.menu.details': ['Details', 'বিস্তারিত'],
  'cpn.menu.edit': ['Edit', 'সম্পাদনা'],
  'cpn.menu.off': ['Switch off', 'বন্ধ করুন'],
  'cpn.menu.on': ['Switch on', 'চালু করুন'],
  'cpn.menu.delete': ['Delete coupon', 'কুপন মুছুন'],
  'cpn.empty': ['No coupons yet', 'এখনও কোনো কুপন নেই'],
  'cpn.emptyText': ['Create a coupon, then share its code with customers.', 'একটি কুপন বানিয়ে তার কোড গ্রাহকদের জানান।'],
  'cpn.noMatch': ['No coupon matches', 'কোনো কুপন মেলেনি'],
  'cpn.noMatchText': ['Change the search or the status filter.', 'সার্চ বা অবস্থার ফিল্টার বদলান।'],
  'cpn.readOnly': ['You can look at coupons. Creating and changing them needs the Store Admin or Super Admin role.', 'আপনি কুপন দেখতে পারবেন। তৈরি বা বদলাতে স্টোর অ্যাডমিন বা সুপার অ্যাডমিন ভূমিকা লাগবে।'],
  'cpn.footer': ['Showing {shown} of {total}', '{total}টির মধ্যে {shown}টি দেখানো হচ্ছে'],
  'cpn.new.title': ['New coupon', 'নতুন কুপন'],
  'cpn.new.confirm': ['Create coupon', 'কুপন তৈরি করুন'],
  'cpn.edit.title': ['Edit {code}', '{code} সম্পাদনা'],
  'cpn.h.basics': ['Basics', 'মূল তথ্য'],
  'cpn.h.offer': ['Offer', 'অফার'],
  'cpn.h.when': ['When', 'কখন'],
  'cpn.h.limits': ['Limits', 'সীমা'],
  'cpn.h.who': ['What and who', 'কীসে ও কার জন্য'],
  'cpn.f.code': ['Coupon code', 'কুপন কোড'],
  'cpn.f.codeHint': ['What customers type, e.g. EID-2026: capital letters, digits and hyphens. It cannot be changed later.', 'গ্রাহক যা লিখবেন, যেমন EID-2026: ইংরেজি বড় হাতের অক্ষর, সংখ্যা ও হাইফেন। পরে বদলানো যাবে না।'],
  'cpn.f.description': ['Note (for your team)', 'নোট (আপনাদের টিমের জন্য)'],
  'cpn.f.active': ['Switched on', 'চালু আছে'],
  'cpn.f.type': ['Kind', 'ধরন'],
  'cpn.type.percent': ['Percentage off', 'শতাংশ ছাড়'],
  'cpn.type.fixed': ['Fixed amount off', 'নির্দিষ্ট টাকা ছাড়'],
  'cpn.type.free_shipping': ['Free delivery', 'ফ্রি ডেলিভারি'],
  'cpn.f.valuePercent': ['Discount (%)', 'ছাড় (%)'],
  'cpn.f.valueFixed': ['Discount amount (৳)', 'ছাড়ের পরিমাণ (৳)'],
  'cpn.f.maxDiscount': ['Highest discount (৳)', 'সর্বোচ্চ ছাড় (৳)'],
  'cpn.f.maxHint': ['Leave empty for no cap.', 'সীমা না চাইলে ফাঁকা রাখুন।'],
  'cpn.f.minOrder': ['Minimum order (৳)', 'ন্যূনতম অর্ডার (৳)'],
  'cpn.f.minHint': ['Total of the products, before delivery. Empty or 0 = none.', 'ডেলিভারি ছাড়া পণ্যের মোট দাম। ফাঁকা বা ০ = নেই।'],
  'cpn.f.startsAt': ['Starts', 'শুরু'],
  'cpn.f.endsAt': ['Ends', 'শেষ'],
  'cpn.f.dhaka': ['Dhaka time. Leave empty for no date.', 'ঢাকার সময়। তারিখ না চাইলে ফাঁকা রাখুন।'],
  'cpn.f.usageLimit': ['Total uses allowed', 'মোট কতবার ব্যবহার করা যাবে'],
  'cpn.f.perCustomer': ['Uses per customer', 'প্রতি গ্রাহক কতবার'],
  'cpn.f.limitHint': ['Leave empty for no limit.', 'সীমা না চাইলে ফাঁকা রাখুন।'],
  'cpn.f.appliesTo': ['Applies to', 'কীসে প্রযোজ্য'],
  'cpn.scopeOpt.all': ['All products', 'সব পণ্য'],
  'cpn.scopeOpt.categories': ['Selected categories', 'নির্বাচিত ক্যাটাগরি'],
  'cpn.scopeOpt.products': ['Selected products', 'নির্বাচিত পণ্য'],
  'cpn.f.categories': ['Categories', 'ক্যাটাগরি'],
  'cpn.f.products': ['Products', 'পণ্য'],
  'cpn.pick.search': ['Search products', 'পণ্য খুঁজুন'],
  'cpn.pick.count': ['{n} selected', '{n}টি বাছাই'],
  'cpn.pick.more': ['{n} more — narrow the search to see them.', 'আরও {n}টি আছে — দেখতে সার্চ ছোট করুন।'],
  'cpn.pick.none': ['Nothing found.', 'কিছু পাওয়া যায়নি।'],
  'cpn.pick.missing': ['no longer available', 'আর নেই'],
  'cpn.f.excludeSale': ['Not for products that are on sale', 'সেল চলছে এমন পণ্যে প্রযোজ্য নয়'],
  'cpn.f.customers': ['Only these customers (optional)', 'শুধু এই গ্রাহকরা (ঐচ্ছিক)'],
  'cpn.f.customersHint': ['One e-mail per line. They must already have an account on the store. Empty = every customer.', 'প্রতি লাইনে একটি ইমেইল। স্টোরে তাদের অ্যাকাউন্ট থাকতে হবে। ফাঁকা = সব গ্রাহক।'],
  'cpn.delete.title': ['Delete {code}?', '{code} মুছবেন?'],
  'cpn.delete.text': ['This coupon was never used. It is deleted for good.', 'এই কুপন কখনো ব্যবহার হয়নি। এটি স্থায়ীভাবে মুছে যাবে।'],
  'cpn.toast.created': ['Coupon created', 'কুপন তৈরি হয়েছে'],
  'cpn.toast.on': ['Coupon switched on', 'কুপন চালু হয়েছে'],
  'cpn.toast.off': ['Coupon switched off', 'কুপন বন্ধ হয়েছে'],
  'cpn.toast.deleted': ['Coupon deleted', 'কুপন মুছে ফেলা হয়েছে'],
  'cpn.d.title': ['Coupon {code}', 'কুপন {code}'],
  'cpn.d.scope': ['Applies to', 'প্রযোজ্য'],
  'cpn.d.min': ['Minimum order', 'ন্যূনতম অর্ডার'],
  'cpn.d.starts': ['Starts', 'শুরু'],
  'cpn.d.ends': ['Ends', 'শেষ'],
  'cpn.d.none': ['—', '—'],
  'cpn.d.used': ['Uses so far', 'এ পর্যন্ত ব্যবহার'],
  'cpn.d.note': ['Note', 'নোট'],
  'cpn.d.created': ['Created', 'তৈরি'],
});

const PAGE = 50;
const STATUSES = ['live', 'scheduled', 'expired', 'exhausted', 'disabled'];
const STATUS_TONE = { live: 'ok', scheduled: 'info', expired: 'neutral', exhausted: 'warn', disabled: 'neutral' };
const count = (v) => (Array.isArray(v) ? v.length : 0);

function offerText(c) {
  if (c.type === 'free_shipping') return t('cpn.offer.free');
  if (c.type === 'fixed') return t('cpn.offer.fixed', { amount: money(c.value) });
  return c.maxDiscount != null ? t('cpn.offer.percentCap', { value: num(c.value), max: money(c.maxDiscount) }) : t('cpn.offer.percent', { value: num(c.value) });
}
function scopeText(c) {
  if (c.appliesTo === 'categories') return tn('cpn.scope.categories', count(c.categoryIds), { n: num(count(c.categoryIds)) });
  if (c.appliesTo === 'products') return tn('cpn.scope.products', count(c.productIds), { n: num(count(c.productIds)) });
  return t('cpn.scope.all');
}
function validText(c) {
  const a = toMillis(c.startsAt);
  const b = toMillis(c.endsAt);
  if (a === null && b === null) return t('cpn.valid.always');
  if (b === null) return t('cpn.valid.from', { date: fmtDate(a) });
  if (a === null) return t('cpn.valid.until', { date: fmtDate(b) });
  return t('cpn.valid.range', { from: fmtDate(a), to: fmtDate(b) });
}
const usedText = (c) => (c.usageLimit != null ? t('cpn.used.of', { used: num(c.usedCount || 0), limit: num(c.usageLimit) }) : num(c.usedCount || 0));

/** items: [{ id, label, sub }] · chosen: Set of ids (kept while the list is filtered) */
function wirePicker(root, items, chosen) {
  const list = root.querySelector('[data-list]');
  const q = root.querySelector('input[type="search"]');
  const counter = root.querySelector('[data-count]');
  const paintCount = () => { counter.textContent = t('cpn.pick.count', { n: num(chosen.size) }); };
  const paint = () => {
    const needle = (q ? q.value : '').trim().toLowerCase();
    const rows = items.filter((i) => !needle || i.label.toLowerCase().includes(needle) || i.sub.toLowerCase().includes(needle));
    const shown = [...rows.filter((i) => chosen.has(i.id)), ...rows.filter((i) => !chosen.has(i.id))].slice(0, 60);
    render(list, shown.length
      ? html`${shown.map((i) => html`<label class="cpn-opt"><input type="checkbox" data-pick-id="${i.id}" ${chosen.has(i.id) ? raw('checked') : ''}><span class="cpn-opt-t">${i.label}</span>${i.sub ? html`<span class="cpn-opt-s">${i.sub}</span>` : ''}</label>`)}${rows.length > shown.length ? html`<p class="field-hint">${t('cpn.pick.more', { n: num(rows.length - shown.length) })}</p>` : ''}`
      : html`<p class="field-hint">${t('cpn.pick.none')}</p>`);
  };
  list.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-pick-id]');
    if (!box) return;
    if (box.checked) chosen.add(box.dataset.pickId); else chosen.delete(box.dataset.pickId);
    paintCount();
  });
  if (q) q.addEventListener('input', debounce(paint, 150));
  paint();
  paintCount();
}

/** categories as a tree (children under their parent, indented with a dash) */
function categoryItems(cats) {
  const byParent = new Map();
  for (const c of cats) { const k = c.parentId || ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(c); }
  const out = [];
  const walk = (pid, depth) => {
    for (const c of (byParent.get(pid) || []).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      out.push({ id: c.id, label: `${depth ? '— ' : ''}${c.name}`, sub: '' });
      if (depth < 4) walk(c.id, depth + 1);
    }
  };
  walk('', 0);
  for (const c of cats) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, label: c.name, sub: '' });
  return out;
}

export default {
  async mount(ctx) {
    if (!needs(ctx, 'coupons.read')) return;
    await loadCss('/css/pages/admin-coupons.css');
    await safeMount(ctx, async () => {
      const canWrite = can('coupons.write');
      let coupons = await loadCoupons();
      if (ctx.signal.aborted) return;
      let scope = null;
      const state = { q: '', status: '', page: 1 };
      const now = () => Date.now();

      const filtered = () => {
        const needle = state.q.trim().toLowerCase();
        return coupons.filter((c) => (!state.status || couponStatus(c, now()) === state.status)
          && (!needle || String(c.id).toLowerCase().includes(needle) || String(c.description || '').toLowerCase().includes(needle)));
      };

      const row = (c) => {
        const st = couponStatus(c, now());
        const conds = [c.minOrder > 0 ? t('cpn.cond.min', { amount: money(c.minOrder) }) : '', scopeText(c), c.excludeSaleItems ? t('cpn.cond.sale') : '',
          count(c.customerIds) ? tn('cpn.cond.customers', count(c.customerIds), { n: num(count(c.customerIds)) }) : ''].filter(Boolean).join(' · ');
        return html`<tr>
          <td class="cell-first"><div class="cell-main"><div><span class="t cpn-code">${c.id}</span>${c.description ? html`<div class="s">${c.description}</div>` : ''}</div></div></td>
          <td data-label="${t('cpn.col.offer')}"><div class="cpn-cell"><div>${offerText(c)}</div><div class="cpn-sub">${conds}</div></div></td>
          <td data-label="${t('cpn.col.used')}"><div class="cpn-cell"><div>${usedText(c)}</div>${c.perCustomerLimit != null ? html`<div class="cpn-sub">${t('cpn.used.per', { n: num(c.perCustomerLimit) })}</div>` : ''}</div></td>
          <td data-label="${t('cpn.col.valid')}">${validText(c)}</td>
          <td data-label="${t('cpn.col.status')}">${badge(t(`cpn.status.${st}`), STATUS_TONE[st])}</td>
          <td class="col-actions"><button type="button" class="btn btn-ghost btn-icon" data-action="row-menu" data-id="${c.id}" aria-haspopup="menu" aria-label="${t('cpn.menu.more', { code: c.id })}">${icon('more-horizontal', { size: 18 })}</button></td>
        </tr>`;
      };

      const results = () => {
        if (!coupons.length) return emptyState({ icon: 'percent', title: t('cpn.empty'), text: canWrite ? t('cpn.emptyText') : '' });
        const list = filtered();
        if (!list.length) return emptyState({ icon: 'search', title: t('cpn.noMatch'), text: t('cpn.noMatchText') });
        const pages = Math.max(1, Math.ceil(list.length / PAGE));
        state.page = Math.min(state.page, pages);
        const slice = list.slice((state.page - 1) * PAGE, state.page * PAGE);
        return html`<div class="table-wrap"><table class="table table-stack table-cards cpn-table" id="cpn-table">
          <thead><tr><th scope="col">${t('cpn.col.code')}</th><th scope="col">${t('cpn.col.offer')}</th><th scope="col">${t('cpn.col.used')}</th><th scope="col">${t('cpn.col.valid')}</th><th scope="col">${t('cpn.col.status')}</th><th scope="col" class="col-actions"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
          <tbody>${slice.map(row)}</tbody></table>
          <div class="table-footer"><span>${t('cpn.footer', { shown: num(slice.length), total: num(list.length) })}</span></div></div>${paginationHtml({ page: state.page, pages })}`;
      };
      const paintResults = () => render(ctx.el.querySelector('#cpn-results'), results());

      const paint = () => render(ctx.el, html`
        ${pageHead({ title: t('cpn.title'), sub: t('cpn.sub'), actions: canWrite ? html`<button type="button" class="btn btn-primary" data-action="add">${icon('plus', { size: 18 })}<span>${t('cpn.add')}</span></button>` : '' })}
        ${canWrite ? '' : html`<div class="alert alert-info" role="note">${icon('info', { size: 18 })}<div>${t('cpn.readOnly')}</div></div>`}
        ${coupons.length ? html`<div class="toolbar" role="search">
          ${searchField({ id: 'q', value: state.q, placeholder: t('cpn.search'), label: t('cpn.search'), bind: 'q' })}
          <select class="select" id="cpn-status" data-change="status" aria-label="${t('cpn.f.status')}"><option value="">${t('cpn.f.allStatus')}</option>${STATUSES.map((s) => html`<option value="${s}" ${state.status === s ? raw('selected') : ''}>${t(`cpn.status.${s}`)}</option>`)}</select>
        </div>` : ''}
        <div id="cpn-results">${results()}</div>`);
      const refresh = async () => { coupons = await loadCoupons(); paint(); };
      paint();

      /* ── details (read-only) ── */
      const showDetails = async (c) => {
        const labels = count(c.customerIds) && can('customers.read') ? await customerLabels(c.customerIds) : new Map();
        const dash = t('cpn.d.none');
        const when = (v) => (toMillis(v) === null ? dash : fmtDateTime(toMillis(v)));
        openModal({
          title: t('cpn.d.title', { code: c.id }),
          body: html`${kvList([
            [t('cpn.col.status'), badge(t(`cpn.status.${couponStatus(c, now())}`), STATUS_TONE[couponStatus(c, now())])],
            [t('cpn.col.offer'), offerText(c)],
            [t('cpn.d.min'), c.minOrder > 0 ? money(c.minOrder) : dash],
            [t('cpn.d.scope'), scopeText(c) + (c.excludeSaleItems ? ` · ${t('cpn.cond.sale')}` : '')],
            [t('cpn.d.starts'), when(c.startsAt)],
            [t('cpn.d.ends'), when(c.endsAt)],
            [t('cpn.d.used'), usedText(c) + (c.perCustomerLimit != null ? ` · ${t('cpn.used.per', { n: num(c.perCustomerLimit) })}` : '')],
            [t('cpn.f.customers'), count(c.customerIds) ? c.customerIds.map((u) => labels.get(u) || u).join(', ') : dash],
            [t('cpn.d.note'), c.description || dash],
            [t('cpn.d.created'), when(c.createdAt)],
          ])}`,
        });
      };

      /* ── new / edit ── */
      const openCoupon = async (coupon) => {
        const creating = !coupon;
        if (!scope) {
          try { scope = await loadScope(); } catch (e) { reportError(e, 'coupons.scope'); toastError(explainError(e)); return; }
        }
        const labels = !creating && count(coupon.customerIds) && can('customers.read') ? await customerLabels(coupon.customerIds) : new Map();
        const chosenProducts = new Set(creating ? [] : coupon.productIds || []);
        const chosenCats = new Set(creating ? [] : coupon.categoryIds || []);
        const withMissing = (items, chosen) => [...items, ...[...chosen].filter((id) => !items.some((i) => i.id === id)).map((id) => ({ id, label: id, sub: t('cpn.pick.missing') }))];
        const productItems = withMissing(scope.products.map((p) => ({ id: p.id, label: p.name, sub: p.sku })), chosenProducts);
        const catItems = withMissing(categoryItems(scope.categories), chosenCats);
        const c = coupon || {};
        const opt = (value, label) => ({ value, label });
        const dateVal = (v) => (toMillis(v) === null ? '' : toDhakaInput(toMillis(v)));
        const numVal = (v) => (v === undefined || v === null ? '' : v);

        formDialog({
          title: creating ? t('cpn.new.title') : t('cpn.edit.title', { code: coupon.id }), confirmText: creating ? t('cpn.new.confirm') : t('common.save'), size: 'lg',
          body: html`<form novalidate data-form="coupon"><div class="stack">
            <h4 class="cpn-h">${t('cpn.h.basics')}</h4>
            ${fieldHtml({ name: 'code', label: t('cpn.f.code'), required: true, value: creating ? '' : coupon.id, hint: creating ? t('cpn.f.codeHint') : '', attrs: { maxlength: 24, autocomplete: 'off', autocapitalize: 'characters', ...(creating ? {} : { readonly: true }) } })}
            ${fieldHtml({ name: 'description', label: t('cpn.f.description'), value: c.description || '', attrs: { maxlength: 200, autocomplete: 'off' } })}
            ${fieldHtml({ name: 'active', label: t('cpn.f.active'), type: 'switch', value: creating ? true : c.active === true })}

            <h4 class="cpn-h">${t('cpn.h.offer')}</h4>
            ${fieldHtml({ name: 'type', label: t('cpn.f.type'), type: 'select', required: true, value: c.type || 'percent', options: ['percent', 'fixed', 'free_shipping'].map((k) => opt(k, t(`cpn.type.${k}`))) })}
            <div class="cpn-two">
              <div data-show-value>${fieldHtml({ name: 'value', label: t('cpn.f.valuePercent'), type: 'number', required: true, value: numVal(c.value), attrs: { min: 1, step: 1, inputmode: 'numeric' } })}</div>
              <div data-show-cap>${fieldHtml({ name: 'maxDiscount', label: t('cpn.f.maxDiscount'), type: 'number', value: numVal(c.maxDiscount), hint: t('cpn.f.maxHint'), attrs: { min: 1, step: 1, inputmode: 'numeric' } })}</div>
            </div>
            ${fieldHtml({ name: 'minOrder', label: t('cpn.f.minOrder'), type: 'number', value: numVal(c.minOrder), hint: t('cpn.f.minHint'), attrs: { min: 0, step: 1, inputmode: 'numeric' } })}

            <h4 class="cpn-h">${t('cpn.h.when')}</h4>
            <div class="cpn-two">
              ${fieldHtml({ name: 'startsAt', label: t('cpn.f.startsAt'), type: 'datetime-local', value: dateVal(c.startsAt) })}
              ${fieldHtml({ name: 'endsAt', label: t('cpn.f.endsAt'), type: 'datetime-local', value: dateVal(c.endsAt), hint: t('cpn.f.dhaka') })}
            </div>

            <h4 class="cpn-h">${t('cpn.h.limits')}</h4>
            <div class="cpn-two">
              ${fieldHtml({ name: 'usageLimit', label: t('cpn.f.usageLimit'), type: 'number', value: numVal(c.usageLimit), hint: t('cpn.f.limitHint'), attrs: { min: 1, step: 1, inputmode: 'numeric' } })}
              ${fieldHtml({ name: 'perCustomerLimit', label: t('cpn.f.perCustomer'), type: 'number', value: numVal(c.perCustomerLimit), hint: t('cpn.f.limitHint'), attrs: { min: 1, step: 1, inputmode: 'numeric' } })}
            </div>

            <h4 class="cpn-h">${t('cpn.h.who')}</h4>
            ${fieldHtml({ name: 'appliesTo', label: t('cpn.f.appliesTo'), type: 'select', value: c.appliesTo || 'all', options: ['all', 'categories', 'products'].map((k) => opt(k, t(`cpn.scopeOpt.${k}`))) })}
            <div class="cpn-pick" id="cpn-cats" hidden>
              <div class="cpn-pick-head"><span class="cpn-pick-t">${t('cpn.f.categories')}</span><span class="cpn-count" data-count></span></div>
              <div class="cpn-list" data-list role="group" aria-label="${t('cpn.f.categories')}"></div>
              <div class="field-error" id="err-categories" aria-live="polite"></div>
            </div>
            <div class="cpn-pick" id="cpn-prods" hidden>
              <div class="cpn-pick-head"><label class="cpn-pick-t" for="cpn-pq">${t('cpn.f.products')}</label><span class="cpn-count" data-count></span></div>
              <div class="search-field">${icon('search')}<input class="input" type="search" id="cpn-pq" placeholder="${t('cpn.pick.search')}" autocomplete="off"></div>
              <div class="cpn-list" data-list role="group" aria-label="${t('cpn.f.products')}"></div>
              <div class="field-error" id="err-products" aria-live="polite"></div>
            </div>
            ${fieldHtml({ name: 'excludeSaleItems', label: t('cpn.f.excludeSale'), type: 'switch', value: c.excludeSaleItems === true })}
            ${fieldHtml({ name: 'customers', label: t('cpn.f.customers'), type: 'textarea', rows: 3, value: (c.customerIds || []).map((u) => labels.get(u) || u).join('\n'), hint: t('cpn.f.customersHint'), attrs: { autocomplete: 'off', spellcheck: 'false' } })}
          </div></form>`,
          onSubmit: async (form) => {
            const clearAll = () => { showFormErrors(form, {}); for (const id of ['err-products', 'err-categories']) { const s = form.querySelector(`#${id}`); if (s) s.textContent = ''; } };
            clearAll();
            const v = readForm(form);
            const at = (s) => (s ? (fromDhakaInput(s) ?? NaN) : null);
            try {
              await saveCoupon({
                creating, code: creating ? null : coupon.id, scope,
                form: {
                  code: v.code, description: v.description, type: v.type, value: v.value, maxDiscount: v.maxDiscount, minOrder: v.minOrder,
                  startsAt: at(v.startsAt), endsAt: at(v.endsAt), usageLimit: v.usageLimit, perCustomerLimit: v.perCustomerLimit,
                  appliesTo: v.appliesTo, productIds: [...chosenProducts], categoryIds: [...chosenCats], excludeSaleItems: v.excludeSaleItems === true,
                  customers: String(v.customers || '').split(/[\s,;]+/).filter(Boolean), active: v.active === true,
                },
              });
            } catch (e) {
              if (e && e.code === 'no_change') { toast(t('cpn.err.no_change')); return true; }
              if (e && e.errors) {
                showFormErrors(form, e.errors);
                for (const k of ['products', 'categories']) { const s = form.querySelector(`#err-${k}`); if (s) s.textContent = e.errors[k] || ''; }
                return false;
              }
              if (!isRefusal(e)) reportError(e, 'coupons.save');
              toastError(explainError(e));
              return false;
            }
            toast(creating ? t('cpn.toast.created') : t('common.saved'));
            await refresh();
            return true;
          },
        });

        const form = document.querySelector('[role="dialog"] form[data-form="coupon"]');
        if (!form) return;
        wirePicker(form.querySelector('#cpn-cats'), catItems, chosenCats);
        wirePicker(form.querySelector('#cpn-prods'), productItems, chosenProducts);
        const syncType = () => {
          const type = form.querySelector('#f-type').value;
          form.querySelector('[data-show-value]').hidden = type === 'free_shipping';
          form.querySelector('[data-show-cap]').hidden = type !== 'percent';
          form.querySelector('label[for="f-value"]').textContent = t(type === 'fixed' ? 'cpn.f.valueFixed' : 'cpn.f.valuePercent');
        };
        const syncScope = () => {
          const kind = form.querySelector('#f-appliesTo').value;
          form.querySelector('#cpn-cats').hidden = kind !== 'categories';
          form.querySelector('#cpn-prods').hidden = kind !== 'products';
        };
        form.addEventListener('change', (e) => { if (e.target.matches('#f-type')) syncType(); if (e.target.matches('#f-appliesTo')) syncScope(); });
        syncType();
        syncScope();
      };

      /* ── switch / delete ── */
      const setActive = async (c, active) => {
        try {
          await setCouponActive({ code: c.id, active });
          toast(active ? t('cpn.toast.on') : t('cpn.toast.off'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'coupons.active'); toastError(explainError(e)); }
      };
      const remove = async (c) => {
        if (!(await confirmDialog({ title: t('cpn.delete.title', { code: c.id }), message: t('cpn.delete.text'), confirmText: t('cpn.menu.delete'), danger: true }))) return;
        try {
          await removeCoupon({ code: c.id });
          toast(t('cpn.toast.deleted'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'coupons.remove'); toastError(explainError(e)); }
      };

      ctx.cleanup(bindActions(ctx.el, {
        add: () => openCoupon(null),
        page: (el) => { state.page = Number(el.dataset.page) || 1; paintResults(); },
        'row-menu': (btn) => {
          const c = coupons.find((x) => x.id === btn.dataset.id);
          if (!c) return;
          const items = [{ label: t('cpn.menu.details'), icon: 'eye', onClick: () => showDetails(c) }];
          if (canWrite) {
            items.push({ label: t('cpn.menu.edit'), icon: 'edit', onClick: () => openCoupon(c) });
            items.push(c.active === true
              ? { label: t('cpn.menu.off'), icon: 'eye-off', onClick: () => setActive(c, false) }
              : { label: t('cpn.menu.on'), icon: 'check-circle', onClick: () => setActive(c, true) });
            if (!(Number(c.usedCount) > 0)) items.push({ label: t('cpn.menu.delete'), icon: 'trash', danger: true, onClick: () => remove(c) });
          }
          openMenu({ anchor: btn, items });
        },
      }, {
        input: { q: debounce((el) => { state.q = el.value; state.page = 1; paintResults(); }, 200) },
        change: { status: (el) => { state.status = el.value; state.page = 1; paintResults(); } },
      }));
    });
  },
};
