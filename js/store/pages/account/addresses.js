/*
 * Account → address book (users/{uid}/addresses): list, add / edit in a dialog, delete, choose the default one.
 * Checkout reads the same list and pre-fills the default address; orders keep their own copy of the address they shipped to.
 */
import { html, render, raw, bindActions, readForm } from '../../../core/dom.js';
import { registerBoth, t } from '../../../core/i18n.js';
import { icon } from '../../../core/icons.js';
import { skeletonRows, emptyState, errorState, fieldHtml, badge, toast, toastError, confirmDialog, formDialog } from '../../../core/ui.js';
import { showFormErrors } from '../../../core/validate.js';
import { explainError } from '../../../core/errors.js';
import { fmtPhone } from '../../../core/format.js';
import { currentUid } from '../../../data/auth.js';
import { listAddresses, saveAddress, setDefaultAddress, deleteAddress, validateAddress, MAX_ADDRESSES } from '../../../data/account.js';
import { districtOptions } from '../../lib/districts.js';

registerBoth({
  'ad.title': ['Saved addresses', 'সেভ করা ঠিকানা'],
  'ad.intro': ['Checkout fills in your default address for you.', 'চেকআউটে আপনার ডিফল্ট ঠিকানা নিজে থেকেই বসে যায়।'],
  'ad.add': ['Add address', 'নতুন ঠিকানা'],
  'ad.limit': ['You have reached the limit of {n} addresses. Delete one to add another.', 'সর্বোচ্চ {n}টি ঠিকানা রাখা যায়। নতুন যোগ করতে একটি মুছুন।'],
  'ad.empty': ['No saved addresses yet', 'এখনও কোনো ঠিকানা সেভ করা নেই'],
  'ad.emptyText': ['Save one now and checkout will fill it in for you.', 'এখন একটি সেভ করে রাখুন — চেকআউটে নিজে থেকেই বসে যাবে।'],
  'ad.untitled': ['Address', 'ঠিকানা'],
  'ad.default': ['Default', 'ডিফল্ট'],
  'ad.edit': ['Edit', 'সম্পাদনা'],
  'ad.makeDefault': ['Make default', 'ডিফল্ট করুন'],
  'ad.delete': ['Delete', 'মুছুন'],
  'ad.dlgAdd': ['Add address', 'নতুন ঠিকানা'],
  'ad.dlgEdit': ['Edit address', 'ঠিকানা সম্পাদনা'],
  'ad.f.label': ['Label (optional)', 'লেবেল (ঐচ্ছিক)'],
  'ad.f.labelHint': ['For example Home or Office.', 'যেমন: বাসা বা অফিস।'],
  'ad.f.name': ['Recipient name', 'প্রাপকের নাম'],
  'ad.f.phone': ['Mobile number', 'মোবাইল নম্বর'],
  'ad.f.district': ['District', 'জেলা'],
  'ad.f.choose': ['Choose a district', 'জেলা বাছুন'],
  'ad.f.upazila': ['Upazila / Thana (optional)', 'উপজেলা / থানা (ঐচ্ছিক)'],
  'ad.f.area': ['Area (optional)', 'এলাকা (ঐচ্ছিক)'],
  'ad.f.postal': ['Postal code (optional)', 'পোস্টাল কোড (ঐচ্ছিক)'],
  'ad.f.line1': ['Full address', 'পূর্ণ ঠিকানা'],
  'ad.f.line1Hint': ['House, road, village or neighbourhood.', 'বাড়ি, রোড, গ্রাম বা মহল্লা।'],
  'ad.f.default': ['Use as my default address', 'এটিকে ডিফল্ট ঠিকানা করুন'],
  'ad.saved': ['Address saved', 'ঠিকানা সেভ হয়েছে'],
  'ad.deleted': ['Address deleted', 'ঠিকানা মুছে ফেলা হয়েছে'],
  'ad.nowDefault': ['Default address updated', 'ডিফল্ট ঠিকানা বদলানো হয়েছে'],
  'ad.delTitle': ['Delete this address?', 'ঠিকানাটি মুছবেন?'],
  'ad.delText': ['Your past orders keep their own copy of the address, so they are not affected.', 'আগের অর্ডারে ঠিকানার নিজস্ব কপি থাকে, তাই সেগুলো বদলাবে না।'],
  'ad.loadError': ['Your addresses could not be loaded.', 'ঠিকানাগুলো লোড করা যায়নি।'],
});

const lineOf = (a) => [a.line1, a.area, a.upazila, [a.district, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');

function cardHtml(a) {
  return html`<li class="adr-card ${a.isDefault ? 'is-default' : ''}">
    <div class="adr-top"><strong class="adr-label">${a.label || t('ad.untitled')}</strong>${a.isDefault ? badge(t('ad.default'), 'brand') : ''}</div>
    <p class="adr-name">${a.name} <span class="muted">· ${fmtPhone(a.phone)}</span></p>
    <p class="adr-line">${lineOf(a)}</p>
    <div class="adr-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${a.id}">${icon('edit', { size: 16 })}<span>${t('ad.edit')}</span></button>
      ${a.isDefault ? '' : html`<button type="button" class="btn btn-secondary btn-sm" data-action="default" data-id="${a.id}">${icon('check', { size: 16 })}<span>${t('ad.makeDefault')}</span></button>`}
      <button type="button" class="btn btn-danger-ghost btn-sm" data-action="del" data-id="${a.id}">${icon('trash', { size: 16 })}<span>${t('ad.delete')}</span></button>
    </div>
  </li>`;
}

/** The dialog form. `existing` is the address being edited (or null); `canDefault` shows the "make default" box. */
function formBody(existing, canDefault) {
  const a = existing || {};
  return html`<form class="adr-form" data-form="address" novalidate>
    <div class="form-grid">
      ${fieldHtml({ name: 'label', label: t('ad.f.label'), value: a.label || '', hint: t('ad.f.labelHint'), span2: true, attrs: { maxlength: 30 } })}
      ${fieldHtml({ name: 'name', label: t('ad.f.name'), value: a.name || '', required: true, autocomplete: 'name', attrs: { maxlength: 80 } })}
      ${fieldHtml({ name: 'phone', label: t('ad.f.phone'), type: 'tel', value: a.phone || '', required: true, autocomplete: 'tel', inputmode: 'tel' })}
      <div class="field span-2">
        <label for="f-district" class="req">${t('ad.f.district')}</label>
        <select class="select" id="f-district" name="district" required aria-describedby="err-district">
          <option value="">${t('ad.f.choose')}</option>
          ${districtOptions(a.district || '')}
        </select>
        <div class="field-error" id="err-district" aria-live="polite"></div>
      </div>
      ${fieldHtml({ name: 'upazila', label: t('ad.f.upazila'), value: a.upazila || '', attrs: { maxlength: 60 } })}
      ${fieldHtml({ name: 'area', label: t('ad.f.area'), value: a.area || '', attrs: { maxlength: 80 } })}
      ${fieldHtml({ name: 'postalCode', label: t('ad.f.postal'), value: a.postalCode || '', inputmode: 'numeric', autocomplete: 'postal-code', attrs: { maxlength: 10 } })}
      ${fieldHtml({ name: 'line1', label: t('ad.f.line1'), type: 'textarea', rows: 3, value: a.line1 || '', required: true, hint: t('ad.f.line1Hint'), span2: true, autocomplete: 'street-address', attrs: { maxlength: 300 } })}
      ${canDefault ? fieldHtml({ name: 'isDefault', type: 'checkbox', label: t('ad.f.default'), value: false, span2: true }) : ''}
    </div>
    <button type="submit" hidden></button>
  </form>`;
}

export default {
  async mount(ctx) {
    const uid = currentUid();
    const host = ctx.el;
    let list = [];

    const view = () => html`
      <section class="acc-card" aria-labelledby="ad-title">
        <div class="acc-card-head">
          <h2 id="ad-title" tabindex="-1">${t('ad.title')}</h2>
          <button type="button" class="btn btn-primary btn-sm" data-action="add" ${list.length >= MAX_ADDRESSES ? raw('disabled') : ''}>${icon('plus', { size: 16 })}<span>${t('ad.add')}</span></button>
        </div>
        <p class="muted">${list.length >= MAX_ADDRESSES ? t('ad.limit', { n: MAX_ADDRESSES }) : t('ad.intro')}</p>
        ${list.length
    ? html`<ul class="adr-list">${list.map(cardHtml)}</ul>`
    : emptyState({ icon: 'map-pin', title: t('ad.empty'), text: t('ad.emptyText') })}
      </section>`;

    const paint = ({ focusTitle = false } = {}) => {
      render(host, view());
      if (focusTitle) host.querySelector('#ad-title')?.focus({ preventScroll: true });
    };
    const reload = async (opts) => { list = await listAddresses(uid); if (!ctx.signal.aborted) paint(opts); };

    render(host, skeletonRows(3));
    try { await reload(); } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(host, errorState({ text: t('ad.loadError') }));
      ctx.cleanup(bindActions(host, { retry: () => ctx.router.reload() }));
      return;
    }

    /** Open the add / edit dialog; resolves once it closes. */
    const openForm = (existing) => {
      const others = list.filter((x) => !existing || x.id !== existing.id).length;
      const canDefault = others > 0 && !(existing && existing.isDefault);
      return formDialog({
        title: existing ? t('ad.dlgEdit') : t('ad.dlgAdd'),
        body: formBody(existing, canDefault),
        confirmText: t('common.save'),
        onSubmit: async (form) => {
          const v = readForm(form);
          if (existing && existing.isDefault) v.isDefault = true; // the default address stays the default until another one is chosen
          const errors = validateAddress(v);
          showFormErrors(form, errors);
          if (Object.keys(errors).length) return false;
          try { await saveAddress(uid, v, existing ? existing.id : null); } catch (e) { toastError(explainError(e)); return false; }
          toast(t('ad.saved'));
          try { await reload({ focusTitle: true }); } catch (e) { console.error(e); }
          return true;
        },
      });
    };

    const byId = (el) => list.find((x) => x.id === el.dataset.id);
    ctx.cleanup(bindActions(host, {
      add: () => openForm(null),
      edit: (el) => { const a = byId(el); if (a) return openForm(a); return undefined; },
      default: async (el) => {
        const a = byId(el); if (!a) return;
        try { await setDefaultAddress(uid, a.id); toast(t('ad.nowDefault')); await reload({ focusTitle: true }); } catch (e) { toastError(explainError(e)); }
      },
      del: async (el) => {
        const a = byId(el); if (!a) return;
        const ok = await confirmDialog({ title: t('ad.delTitle'), message: t('ad.delText'), confirmText: t('ad.delete'), danger: true });
        if (!ok) return;
        try { await deleteAddress(uid, a.id); toast(t('ad.deleted')); await reload({ focusTitle: true }); } catch (e) { toastError(explainError(e)); }
      },
    }));
  },
};
