/*
 * Shipping zones — what delivery costs and how long it takes, by district (permission: shipping.write).
 *
 *   Coverage   the districts that have no active zone (customers there cannot check out)
 *   Zones      add, edit (fee, free-delivery amount, delivery time, districts), switch off / on, delete a switched-off zone
 *
 * The rules of the game live in shared/shippingFlow.js: a district belongs to ONE active zone, only a switched-off zone can be deleted,
 * every change is one batch with an audit entry. The orders rule re-reads the zone for every order, so nothing shown here sets a price.
 */
import { html, render, bindActions, readForm, raw } from '../../core/dom.js';
import { registerBoth, t, tn, getLang } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, toast, toastError, formDialog, confirmDialog, fieldHtml, openMenu, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { money, num } from '../../core/format.js';
import { DIVISIONS, DISTRICT_BN } from '../../shared/constants.js';
import { coverage, exclusiveDistricts } from '../../shared/shippingFlow.js';
import { safeMount, pageHead, needs } from '../lib/ui.js';
import { loadShippingZones, saveZone, setZoneActive, removeZone } from '../data/shipping.js';

registerBoth({
  'shz.title': ['Shipping zones', 'শিপিং জোন'],
  'shz.sub': ['What delivery costs and how long it takes, by district. Checkout picks the zone from the customer\'s district.', 'জেলা অনুযায়ী ডেলিভারি চার্জ ও সময়। চেকআউটে গ্রাহকের জেলা দেখে জোন ঠিক হয়।'],
  'shz.add': ['Add zone', 'জোন যোগ করুন'],
  'shz.col.zone': ['Zone', 'জোন'],
  'shz.col.fee': ['Delivery fee', 'ডেলিভারি চার্জ'],
  'shz.col.free': ['Free delivery', 'ফ্রি ডেলিভারি'],
  'shz.col.eta': ['Delivery time', 'সময়'],
  'shz.col.status': ['Status', 'অবস্থা'],
  'shz.freeOver': ['Over {amount}', '{amount}-এর বেশি হলে'],
  'shz.noFree': ['Not offered', 'নেই'],
  'shz.dayRange': ['{min}–{max} days', '{min}–{max} দিন'],
  'shz.dayCount_one': ['{n} day', '{n} দিন'],
  'shz.dayCount_other': ['{n} days', '{n} দিন'],
  'shz.districts_one': ['{n} district', '{n}টি জেলা'],
  'shz.districts_other': ['{n} districts', '{n}টি জেলা'],
  'shz.zoneCount_one': ['{n} zone', '{n}টি জোন'],
  'shz.zoneCount_other': ['{n} zones', '{n}টি জোন'],
  'shz.footer': ['Devices refresh zones every 5 minutes. Every order is priced from the saved zone.', 'ডিভাইস প্রতি ৫ মিনিটে জোন রিফ্রেশ করে। প্রতিটি অর্ডারের দাম সংরক্ষিত জোন থেকেই ঠিক হয়।'],
  'shz.active': ['Active', 'সক্রিয়'],
  'shz.off': ['Switched off', 'বন্ধ'],
  'shz.menu.more': ['Actions for {name}', '{name}-এর অ্যাকশন'],
  'shz.menu.edit': ['Edit', 'সম্পাদনা'],
  'shz.menu.off': ['Switch off', 'বন্ধ করুন'],
  'shz.menu.on': ['Switch on', 'চালু করুন'],
  'shz.menu.delete': ['Delete zone', 'জোন মুছুন'],
  'shz.empty': ['No shipping zones', 'কোনো শিপিং জোন নেই'],
  'shz.emptyText': ['Without an active zone nobody can check out. Add a zone to start delivering.', 'সক্রিয় জোন না থাকলে কেউ অর্ডার করতে পারবেন না। ডেলিভারি শুরু করতে একটি জোন যোগ করুন।'],
  /* coverage */
  'shz.cover.ok': ['All {total} districts are covered by an active zone.', 'সব {total}টি জেলা একটি সক্রিয় জোনের আওতায় আছে।'],
  'shz.cover.gap': ['{n} of {total} districts have no active zone', '{total}টির মধ্যে {n}টি জেলার কোনো সক্রিয় জোন নেই'],
  'shz.cover.gapText': ['Customers in these districts cannot place an order. Add a district to a zone if you deliver there.', 'এই জেলাগুলোর গ্রাহক অর্ডার করতে পারবেন না। যেখানে ডেলিভারি দেন, সেই জেলা কোনো জোনে যোগ করুন।'],
  'shz.cover.show': ['Show the districts', 'জেলাগুলো দেখুন'],
  /* dialog */
  'shz.add.title': ['Add shipping zone', 'নতুন শিপিং জোন'],
  'shz.add.confirm': ['Add zone', 'জোন যোগ করুন'],
  'shz.edit.title': ['Edit {name}', '{name} সম্পাদনা'],
  'shz.f.name': ['Zone name', 'জোনের নাম'],
  'shz.f.fee': ['Delivery fee (৳)', 'ডেলিভারি চার্জ (৳)'],
  'shz.f.freeOver': ['Free delivery over (৳)', 'কত টাকার বেশি হলে ফ্রি (৳)'],
  'shz.f.freeOverHint': ['Leave empty for no free delivery.', 'ফ্রি ডেলিভারি না দিলে ফাঁকা রাখুন।'],
  'shz.f.etaMin': ['Fastest (days)', 'দ্রুততম (দিন)'],
  'shz.f.etaMax': ['Slowest (days)', 'সর্বোচ্চ (দিন)'],
  'shz.f.active': ['Active (offered at checkout)', 'সক্রিয় (চেকআউটে দেখাবে)'],
  'shz.f.districts': ['Districts', 'জেলা'],
  'shz.f.districtsHint': ['A district can belong to one active zone only. Greyed-out districts are already in the zone named under them.', 'একটি জেলা একটি সক্রিয় জোনেই থাকতে পারে। ধূসর জেলাগুলো নিচে লেখা জোনে আছে।'],
  'shz.sel.count': ['{n} selected', '{n}টি বাছাই'],
  'shz.sel.all': ['Select all', 'সব বাছুন'],
  'shz.sel.none': ['Clear', 'মুছুন'],
  'shz.taken': ['In {zone}', '{zone}-এ আছে'],
  /* confirmations and toasts */
  'shz.off.title': ['Switch off {name}?', '{name} বন্ধ করবেন?'],
  'shz.off.text': ['Customers in its districts cannot check out until another active zone covers them.', 'অন্য কোনো সক্রিয় জোন না থাকলে এই জোনের জেলার গ্রাহকেরা অর্ডার করতে পারবেন না।'],
  'shz.off.gap': ['These districts would have no active zone: {list}.', 'এই জেলাগুলোর কোনো সক্রিয় জোন থাকবে না: {list}।'],
  'shz.delete.title': ['Delete {name}?', '{name} মুছবেন?'],
  'shz.delete.text': ['The zone is deleted for good. Past orders keep the zone name they were placed with.', 'জোনটি স্থায়ীভাবে মুছে যাবে। আগের অর্ডারে জোনের নাম যেমন ছিল তেমনই থাকবে।'],
  'shz.toast.created': ['Zone added', 'জোন যোগ হয়েছে'],
  'shz.toast.on': ['Zone switched on', 'জোন চালু হয়েছে'],
  'shz.toast.off': ['Zone switched off', 'জোন বন্ধ হয়েছে'],
  'shz.toast.deleted': ['Zone deleted', 'জোন মুছে ফেলা হয়েছে'],
});

const dn = (d) => (getLang() === 'bn' ? (DISTRICT_BN[d] || d) : d);
const listText = (districts, max = 8) => (districts.length > max ? `${districts.slice(0, max).map(dn).join(', ')} +${num(districts.length - max)}` : districts.map(dn).join(', '));
const days = (z) => {
  const a = Number(z.etaMin);
  const b = Number(z.etaMax);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  return a === b ? tn('shz.dayCount', b, { n: num(b) }) : t('shz.dayRange', { min: num(a), max: num(b) });
};
const selected = (form) => [...form.querySelectorAll('input[data-district]:checked')].map((b) => b.dataset.district);

/** the standard field errors plus the one slot that has no input of its own (#err-districts) */
function showErrors(form, errors = {}) {
  showFormErrors(form, errors);
  const slot = form.querySelector('#err-districts');
  if (slot) slot.textContent = errors.districts || '';
  if (errors.districts && Object.keys(errors).every((k) => k === 'districts')) { const first = form.querySelector('input[data-district]:not(:disabled)'); if (first) first.focus(); }
}

export default {
  async mount(ctx) {
    if (!needs(ctx, 'shipping.write')) return;
    await loadCss('/css/pages/admin-shipping.css');
    await safeMount(ctx, async () => {
      let zones = await loadShippingZones();
      if (ctx.signal.aborted) return;

      const refresh = async () => { zones = await loadShippingZones(); paint(); };

      const coverBlock = (cov) => (cov.uncovered.length
        ? html`<div class="alert alert-warn shz-cover" id="shz-cover" role="status">${icon('alert-triangle', { size: 18 })}<div>
            <div class="alert-title">${t('shz.cover.gap', { n: num(cov.uncovered.length), total: num(cov.total) })}</div>
            <p class="shz-cover-text">${t('shz.cover.gapText')}</p>
            <details class="shz-gap"><summary>${t('shz.cover.show')}</summary>${cov.byDivision.map((g) => html`<p><strong>${dn(g.division)}</strong> — ${g.uncovered.map(dn).join(', ')}</p>`)}</details>
          </div></div>`
        : html`<div class="alert alert-ok shz-cover" id="shz-cover" role="status">${icon('check-circle', { size: 18 })}<div>${t('shz.cover.ok', { total: num(cov.total) })}</div></div>`);

      const zoneRow = (z) => {
        const n = (z.districts || []).length;
        return html`<tr>
          <td class="cell-first"><div class="cell-main"><div>
            <span class="t">${z.name}</span>
            <div class="s">${tn('shz.districts', n, { n: num(n) })} · ${listText(z.districts || [], 3)}</div>
          </div></div></td>
          <td data-label="${t('shz.col.fee')}">${money(z.fee)}</td>
          <td data-label="${t('shz.col.free')}">${z.freeOver ? t('shz.freeOver', { amount: money(z.freeOver) }) : t('shz.noFree')}</td>
          <td data-label="${t('shz.col.eta')}">${days(z)}</td>
          <td data-label="${t('shz.col.status')}">${z.active === true ? badge(t('shz.active'), 'ok') : badge(t('shz.off'), 'neutral')}</td>
          <td class="col-actions"><button type="button" class="btn btn-ghost btn-icon" data-action="row-menu" data-id="${z.id}" aria-haspopup="menu" aria-label="${t('shz.menu.more', { name: z.name })}">${icon('more-horizontal', { size: 18 })}</button></td>
        </tr>`;
      };

      const paint = () => render(ctx.el, html`
        ${pageHead({ title: t('shz.title'), sub: t('shz.sub'), actions: html`<button type="button" class="btn btn-primary" data-action="add">${icon('plus', { size: 18 })}<span>${t('shz.add')}</span></button>` })}
        ${coverBlock(coverage(zones))}
        ${zones.length
    ? html`<div class="table-wrap"><table class="table table-stack table-cards shz-table" id="shz-table">
            <thead><tr><th scope="col">${t('shz.col.zone')}</th><th scope="col">${t('shz.col.fee')}</th><th scope="col">${t('shz.col.free')}</th><th scope="col">${t('shz.col.eta')}</th><th scope="col">${t('shz.col.status')}</th><th scope="col" class="col-actions"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
            <tbody>${zones.map(zoneRow)}</tbody></table>
            <div class="table-footer"><span>${tn('shz.zoneCount', zones.length, { n: num(zones.length) })}</span><span class="shz-note">${t('shz.footer')}</span></div></div>`
    : emptyState({ icon: 'truck', title: t('shz.empty'), text: t('shz.emptyText') })}`);
      paint();

      /* ── add / edit ── */
      const pickerHtml = (picked) => html`<fieldset class="shz-pick" id="shz-pick">
        <legend>${t('shz.f.districts')}</legend>
        <p class="field-hint" id="hint-districts">${t('shz.f.districtsHint')}<span class="shz-count" id="shz-count" aria-live="polite"></span></p>
        ${Object.entries(DIVISIONS).map(([division, list]) => html`<div class="shz-div">
          <div class="shz-div-head"><h4>${dn(division)}</h4><span class="shz-div-tools">
            <button type="button" class="btn btn-ghost btn-sm" data-pick="all">${t('shz.sel.all')}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-pick="none">${t('shz.sel.none')}</button></span></div>
          <div class="shz-grid">${list.map((d) => html`<label class="shz-opt"><input type="checkbox" data-district="${d}" ${picked.has(d) ? raw('checked') : ''}><span class="shz-opt-name">${dn(d)}</span><span class="shz-opt-note" data-note></span></label>`)}</div>
        </div>`)}
        <div class="field-error" id="err-districts" aria-live="polite"></div>
      </fieldset>`;

      const openZone = (zone) => {
        const creating = !zone;
        const held = coverage(zones.filter((x) => !zone || x.id !== zone.id)).owner;   // district → the other ACTIVE zone that already has it
        const num0 = (v) => (v === undefined || v === null ? '' : v);
        formDialog({
          title: creating ? t('shz.add.title') : t('shz.edit.title', { name: zone.name }), confirmText: creating ? t('shz.add.confirm') : t('common.save'), size: 'lg',
          body: html`<form novalidate data-form="zone"><div class="stack">
            ${fieldHtml({ name: 'name', label: t('shz.f.name'), required: true, value: creating ? '' : zone.name, attrs: { maxlength: 60, autocomplete: 'off' } })}
            <div class="shz-two">
              ${fieldHtml({ name: 'fee', label: t('shz.f.fee'), type: 'number', required: true, value: creating ? '' : num0(zone.fee), attrs: { min: 0, max: 5000, step: 1, inputmode: 'numeric' } })}
              ${fieldHtml({ name: 'freeOver', label: t('shz.f.freeOver'), type: 'number', value: creating ? '' : num0(zone.freeOver), hint: t('shz.f.freeOverHint'), attrs: { min: 1, max: 1000000, step: 1, inputmode: 'numeric' } })}
            </div>
            <div class="shz-eta">
              ${fieldHtml({ name: 'etaMin', label: t('shz.f.etaMin'), type: 'number', required: true, value: creating ? '' : num0(zone.etaMin), attrs: { min: 0, max: 60, step: 1, inputmode: 'numeric' } })}
              ${fieldHtml({ name: 'etaMax', label: t('shz.f.etaMax'), type: 'number', required: true, value: creating ? '' : num0(zone.etaMax), attrs: { min: 0, max: 60, step: 1, inputmode: 'numeric' } })}
            </div>
            ${fieldHtml({ name: 'active', label: t('shz.f.active'), type: 'switch', value: creating ? true : zone.active === true })}
            ${pickerHtml(new Set(creating ? [] : zone.districts || []))}
          </div></form>`,
          onSubmit: async (form) => {
            showErrors(form, {});
            const v = readForm(form);
            try {
              await saveZone({
                creating, id: creating ? null : zone.id, zones,
                form: { name: v.name, fee: v.fee, freeOver: v.freeOver, etaMin: v.etaMin, etaMax: v.etaMax, active: v.active === true, districts: selected(form) },
              });
            } catch (e) {
              if (e && e.code === 'no_change') return true;
              if (e && e.errors) { showErrors(form, e.errors); return false; }
              if (!isRefusal(e)) reportError(e, 'shipping.save');
              toastError(explainError(e));
              return false;
            }
            toast(creating ? t('shz.toast.created') : t('common.saved'));
            await refresh();
            return true;
          },
        });

        /* the district list: districts another ACTIVE zone already has are greyed out (unless this zone is switched off, or they are already ticked) */
        const form = document.querySelector('[role="dialog"] form[data-form="zone"]');
        if (!form) return;
        const boxes = [...form.querySelectorAll('input[data-district]')];
        const sw = form.querySelector('#f-active');
        const count = form.querySelector('#shz-count');
        const sync = () => {
          let n = 0;
          for (const b of boxes) {
            const owner = held.get(b.dataset.district);
            const label = b.closest('.shz-opt');
            b.disabled = !!owner && sw.checked && !b.checked;
            label.querySelector('[data-note]').textContent = owner ? owner.name : '';
            label.title = owner ? t('shz.taken', { zone: owner.name }) : '';
            label.classList.toggle('is-held', !!owner);
            if (b.checked) n += 1;
          }
          count.textContent = ` · ${t('shz.sel.count', { n: num(n) })}`;
        };
        form.addEventListener('change', (e) => { if (e.target.matches('input[data-district], #f-active')) sync(); });
        form.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-pick]');
          if (!btn) return;
          for (const b of btn.closest('.shz-div').querySelectorAll('input[data-district]')) {
            if (btn.dataset.pick === 'all') { if (!b.disabled) b.checked = true; } else b.checked = false;
          }
          sync();
        });
        sync();
      };

      /* ── switch / delete ── */
      const setActive = async (z, active) => {
        if (!active) {
          const gap = exclusiveDistricts(zones, z.id);
          const message = gap.length ? `${t('shz.off.text')} ${t('shz.off.gap', { list: listText(gap) })}` : t('shz.off.text');
          if (!(await confirmDialog({ title: t('shz.off.title', { name: z.name }), message, confirmText: t('shz.menu.off'), danger: true }))) return;
        }
        try {
          await setZoneActive({ id: z.id, active, zones });
          toast(active ? t('shz.toast.on') : t('shz.toast.off'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'shipping.active'); toastError(explainError(e)); }
      };

      const remove = async (z) => {
        if (!(await confirmDialog({ title: t('shz.delete.title', { name: z.name }), message: t('shz.delete.text'), confirmText: t('shz.menu.delete'), danger: true }))) return;
        try {
          await removeZone({ id: z.id, zones });
          toast(t('shz.toast.deleted'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'shipping.remove'); toastError(explainError(e)); }
      };

      ctx.cleanup(bindActions(ctx.el, {
        add: () => openZone(null),
        'row-menu': (btn) => {
          const z = zones.find((x) => x.id === btn.dataset.id);
          if (!z) return;
          const items = [
            { label: t('shz.menu.edit'), icon: 'edit', onClick: () => openZone(z) },
            z.active === true
              ? { label: t('shz.menu.off'), icon: 'eye-off', onClick: () => setActive(z, false) }
              : { label: t('shz.menu.on'), icon: 'check-circle', onClick: () => setActive(z, true) },
          ];
          if (z.active !== true) items.push({ label: t('shz.menu.delete'), icon: 'trash', danger: true, onClick: () => remove(z) });
          openMenu({ anchor: btn, items });
        },
      }));
    });
  },
};
