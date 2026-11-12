/*
 * Staff & roles — who may open this panel, and what each role is allowed to do (Super Admin only).
 *
 *   Members      add (find the account by e-mail or paste its UID), edit name / e-mail / role, switch off and on, remove a switched-off member
 *   Roles        a fixed list: what every role can do, read from the same table the rules use (shared/constants.js)
 *
 * Safety nets (shared/staffFlow.js): nobody changes their own role or switches themselves off, the last active Super Admin stays,
 * only a member who is switched off can be removed. Every change is one batch with an audit entry.
 * The rules are the real enforcement; this page only decides what to show.
 */
import { html, render, bindActions, readForm, raw } from '../../core/dom.js';
import { registerBoth, t, tn, lbl, pick } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, toast, toastError, formDialog, confirmDialog, fieldHtml, openMenu } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { fmtDate, num } from '../../core/format.js';
import { currentUid } from '../../data/auth.js';
import { ROLES, ROLE_IDS, PERMISSIONS } from '../../shared/constants.js';
import { permissionMatrix } from '../../shared/staffFlow.js';
import { safeMount, pageHead, needs } from '../lib/ui.js';
import { loadStaff, findAccountByEmail, saveStaff, removeStaff } from '../data/staff.js';

registerBoth({
  'stf.title': ['Staff & roles', 'স্টাফ ও রোল'],
  'stf.sub': ['Who can open this panel, and what each role is allowed to do', 'কে এই প্যানেলে ঢুকতে পারবেন এবং কোন রোল কী করতে পারে'],
  'stf.add': ['Add staff member', 'স্টাফ যোগ করুন'],
  'stf.col.member': ['Member', 'সদস্য'],
  'stf.col.role': ['Role', 'রোল'],
  'stf.col.status': ['Status', 'অবস্থা'],
  'stf.col.added': ['Added', 'যোগ হয়েছে'],
  'stf.you': ['You', 'আপনি'],
  'stf.active': ['Active', 'সক্রিয়'],
  'stf.off': ['Switched off', 'বন্ধ'],
  'stf.count_one': ['{n} member', '{n} জন সদস্য'],
  'stf.count_other': ['{n} members', '{n} জন সদস্য'],
  'stf.menu.more': ['Actions for {name}', '{name}-এর অ্যাকশন'],
  'stf.menu.edit': ['Edit', 'সম্পাদনা'],
  'stf.menu.off': ['Switch off', 'বন্ধ করুন'],
  'stf.menu.on': ['Switch on', 'চালু করুন'],
  'stf.menu.remove': ['Remove from staff', 'স্টাফ থেকে সরান'],
  'stf.empty': ['No staff records', 'কোনো স্টাফ রেকর্ড নেই'],
  'stf.emptyText': ['The list could not be read or is empty. Reload the page.', 'তালিকা পড়া যায়নি বা খালি। পেজ রিলোড করুন।'],
  /* add dialog */
  'stf.add.lead': ['The person must first have an account on the store (sign up or sign in once). Find it by e-mail, or paste the UID from Firebase console → Authentication → Users.', 'ব্যক্তির স্টোরে আগে একটি অ্যাকাউন্ট থাকতে হবে (সাইন আপ বা একবার লগইন)। ইমেইল দিয়ে খুঁজুন, অথবা Firebase console → Authentication → Users থেকে UID পেস্ট করুন।'],
  'stf.add.confirm': ['Add member', 'সদস্য যোগ করুন'],
  'stf.lookup': ['Find account by e-mail', 'ইমেইল দিয়ে অ্যাকাউন্ট খুঁজুন'],
  'stf.find': ['Find', 'খুঁজুন'],
  'stf.found': ['Found {name}. The details are filled in below.', '{name}-কে পাওয়া গেছে। নিচের ঘরগুলো ভরে দেওয়া হয়েছে।'],
  'stf.notFound': ['No account with this e-mail has signed up on the store yet. Ask the person to sign up first, or paste the UID below.', 'এই ইমেইলে স্টোরে এখনো কেউ অ্যাকাউন্ট খোলেননি। আগে সাইন আপ করতে বলুন, অথবা নিচে UID পেস্ট করুন।'],
  'stf.uid': ['UID', 'UID'],
  'stf.uidHint': ['The account\'s unique ID (28 letters and digits for most accounts).', 'অ্যাকাউন্টের ইউনিক আইডি (বেশিরভাগ অ্যাকাউন্টে ২৮ অক্ষর/সংখ্যা)।'],
  'stf.email': ['E-mail', 'ইমেইল'],
  'stf.name': ['Name (optional)', 'নাম (ঐচ্ছিক)'],
  'stf.role': ['Role', 'রোল'],
  'stf.pickRole': ['Choose a role…', 'রোল বেছে নিন…'],
  'stf.activeLabel': ['Active (can open the panel)', 'সক্রিয় (প্যানেলে ঢুকতে পারবেন)'],
  'stf.selfHint': ['You cannot change your own role or switch yourself off. Ask another Super Admin.', 'নিজের রোল বদলানো বা নিজেকে বন্ধ করা যাবে না। অন্য সুপার অ্যাডমিনকে বলুন।'],
  'stf.edit.title': ['Edit {name}', '{name} সম্পাদনা'],
  /* confirmations and toasts */
  'stf.off.title': ['Switch off {name}?', '{name}-কে বন্ধ করবেন?'],
  'stf.off.text': ['They will no longer be able to open this panel. Their past actions stay in the audit log. You can switch them on again.', 'তিনি আর এই প্যানেলে ঢুকতে পারবেন না। তাঁর আগের কাজ অডিট লগে থাকবে। পরে আবার চালু করা যাবে।'],
  'stf.remove.title': ['Remove {name} from staff?', '{name}-কে স্টাফ থেকে সরাবেন?'],
  'stf.remove.text': ['The staff record is deleted. Past actions stay in the audit log. To give access again, add the person as new.', 'স্টাফ রেকর্ডটি মুছে যাবে। আগের কাজ অডিট লগে থাকবে। আবার অ্যাক্সেস দিতে নতুন করে যোগ করতে হবে।'],
  'stf.toast.added': ['Added. They can now sign in at /admin/ with that account.', 'যোগ হয়েছে। এখন ওই অ্যাকাউন্ট দিয়ে /admin/-এ লগইন করা যাবে।'],
  'stf.toast.off': ['Switched off', 'বন্ধ করা হয়েছে'],
  'stf.toast.on': ['Switched on', 'চালু করা হয়েছে'],
  'stf.toast.removed': ['Removed from staff', 'স্টাফ থেকে সরানো হয়েছে'],
  /* roles */
  'stf.roles.title': ['What each role can do', 'কোন রোল কী করতে পারে'],
  'stf.roles.lead': ['Roles are fixed. The server enforces them — hiding a menu item is only a convenience for the person.', 'রোলগুলো নির্দিষ্ট। সার্ভার এগুলো কার্যকর করে — মেনু লুকানো শুধু ব্যবহারকারীর সুবিধার জন্য।'],
  'stf.all': ['Everything, including staff management and data migrations.', 'সবকিছু — স্টাফ ম্যানেজমেন্ট ও ডেটা মাইগ্রেশনসহ।'],
  'stf.roleCount_one': ['{n} member', '{n} জন'],
  'stf.roleCount_other': ['{n} members', '{n} জন'],
  'stf.group.catalog': ['Catalog', 'ক্যাটালগ'],
  'stf.group.inventory': ['Inventory', 'ইনভেন্টরি'],
  'stf.group.orders': ['Orders', 'অর্ডার'],
  'stf.group.customers': ['Customers', 'কাস্টমার'],
  'stf.group.marketing': ['Sales tools', 'বিক্রয়ের টুল'],
  'stf.group.content': ['Content', 'কনটেন্ট'],
  'stf.group.support': ['Support', 'সাপোর্ট'],
  'stf.group.reports': ['Reports', 'রিপোর্ট'],
  'stf.group.system': ['System', 'সিস্টেম'],
});

/* Bengali wording of every permission (the English text lives next to the permission in shared/constants.js) */
const PERM_BN = {
  'products.read': 'প্রোডাক্ট দেখা (ড্রাফটসহ)', 'products.write': 'প্রোডাক্ট তৈরি ও সম্পাদনা', 'products.delete': 'প্রোডাক্ট মুছে ফেলা', 'costs.read': 'ক্রয়মূল্য দেখা',
  'categories.write': 'ক্যাটাগরি ম্যানেজ', 'brands.write': 'ব্র্যান্ড ম্যানেজ', 'inventory.read': 'ইনভেন্টরি ও স্টকের ইতিহাস দেখা', 'inventory.adjust': 'স্টক সমন্বয়',
  'orders.read': 'অর্ডার দেখা', 'orders.update': 'অর্ডারের স্ট্যাটাস বদলানো', 'orders.cancel': 'অর্ডার বাতিল', 'orders.refund': 'অর্ডার রিফান্ড', 'payments.verify': 'পেমেন্ট যাচাই বা প্রত্যাখ্যান',
  'customers.read': 'কাস্টমার দেখা', 'customers.write': 'কাস্টমার সম্পাদনা (নোট, সীমাবদ্ধতা)', 'coupons.read': 'কুপন দেখা', 'coupons.write': 'কুপন ম্যানেজ', 'shipping.write': 'শিপিং জোন ম্যানেজ',
  'content.write': 'হোমপেজ ও পেজ সম্পাদনা', 'reviews.moderate': 'রিভিউ মডারেশন', 'support.read': 'সাপোর্ট টিকিট দেখা', 'support.reply': 'টিকিটে উত্তর দেওয়া',
  'reports.read': 'রিপোর্ট দেখা', 'reports.export': 'CSV এক্সপোর্ট', 'settings.read': 'সেটিংস দেখা', 'settings.write': 'সেটিংস বদলানো', 'audit.read': 'অডিট লগ দেখা',
  'mail.send': 'কাস্টমারকে ইমেইল পাঠানোর অনুরোধ', 'staff.manage': 'স্টাফ ও রোল ম্যানেজ', 'migrate.run': 'ডেটা মাইগ্রেশন চালানো',
};
registerBoth(Object.fromEntries(Object.entries(PERMISSIONS).map(([id, p]) => [`stf.perm.${id}`, [p.label, PERM_BN[id] || p.label]])));

const MATRIX = permissionMatrix();
const who = (m) => m.name || m.email || m.id;
const roleOptions = (withBlank = false) => [
  ...(withBlank ? [{ value: '', label: t('stf.pickRole') }] : []),
  ...ROLE_IDS.map((id) => ({ value: id, label: lbl(ROLES[id]) })),
];
const aboutRole = (id) => (ROLES[id] ? pick(ROLES[id].about, ROLES[id].aboutBn) : '');
const roleTone = (id) => (id === 'super_admin' ? 'brand' : id === 'store_admin' ? 'info' : 'neutral');

export default {
  async mount(ctx) {
    if (!needs(ctx, 'staff.manage')) return;
    await safeMount(ctx, async () => {
      const me = currentUid();
      let staff = await loadStaff();
      if (ctx.signal.aborted) return;

      const refresh = async () => { staff = await loadStaff(); paint(); };

      const memberRow = (m) => html`<tr>
        <td class="cell-first"><div class="cell-main"><div>
          <span class="t">${who(m)}</span>${m.id === me ? html` ${badge(t('stf.you'), 'brand')}` : ''}
          ${m.name && m.email ? html`<div class="s mono">${m.email}</div>` : ''}
        </div></div></td>
        <td data-label="${t('stf.col.role')}">${badge(lbl(ROLES[m.role]) || m.role, roleTone(m.role))}</td>
        <td data-label="${t('stf.col.status')}">${m.active === true ? badge(t('stf.active'), 'ok') : badge(t('stf.off'), 'neutral')}</td>
        <td data-label="${t('stf.col.added')}">${m.createdAt ? fmtDate(m.createdAt) : '—'}</td>
        <td class="col-actions"><button type="button" class="btn btn-ghost btn-icon" data-action="row-menu" data-uid="${m.id}" aria-haspopup="menu" aria-label="${t('stf.menu.more', { name: who(m) })}">${icon('more-horizontal', { size: 18 })}</button></td>
      </tr>`;

      const roleBlock = (role) => {
        const n = staff.filter((m) => m.role === role).length;
        const body = role === 'super_admin'
          ? html`<p>${t('stf.all')}</p>`
          : html`<div class="stf-perms">${MATRIX.map((g) => {
            const own = g.perms.filter((p) => p.roles.includes(role));
            return own.length ? html`<div><h4>${t(`stf.group.${g.group}`)}</h4><ul>${own.map((p) => html`<li>${t(`stf.perm.${p.id}`)}</li>`)}</ul></div>` : '';
          })}</div>`;
        return html`<details><summary><span class="stf-role-head"><strong>${lbl(ROLES[role])}</strong><span class="stf-about">${aboutRole(role)}</span></span>${badge(tn('stf.roleCount', n, { n: num(n) }), 'neutral')}</summary><div class="acc-body">${body}</div></details>`;
      };

      const paint = () => render(ctx.el, html`
        ${pageHead({ title: t('stf.title'), sub: t('stf.sub'), actions: html`<button type="button" class="btn btn-primary" data-action="add">${icon('plus', { size: 18 })}<span>${t('stf.add')}</span></button>` })}
        ${staff.length
    ? html`<div class="table-wrap"><table class="table table-stack table-cards stf-table" id="stf-table">
            <thead><tr><th scope="col">${t('stf.col.member')}</th><th scope="col">${t('stf.col.role')}</th><th scope="col">${t('stf.col.status')}</th><th scope="col">${t('stf.col.added')}</th><th scope="col" class="col-actions"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
            <tbody>${staff.map(memberRow)}</tbody></table>
            <div class="table-footer"><span>${tn('stf.count', staff.length, { n: num(staff.length) })}</span></div></div>`
    : emptyState({ icon: 'users', title: t('stf.empty'), text: t('stf.emptyText') })}
        <section class="mt-section" aria-labelledby="stf-roles-h">
          <h2 id="stf-roles-h" class="section-h">${t('stf.roles.title')}</h2>
          <p class="muted mb-4">${t('stf.roles.lead')}</p>
          <div class="accordion">${ROLE_IDS.map(roleBlock)}</div>
        </section>`);
      paint();

      /* ── dialogs ── */
      const aboutLine = (form) => { const el = form.querySelector('#stf-role-about'); const sel = form.querySelector('#f-role'); if (el && sel) el.textContent = aboutRole(sel.value); };

      const addMember = () => {
        const closed = formDialog({
          title: t('stf.add'), confirmText: t('stf.add.confirm'), size: 'md',
          body: html`<form novalidate data-form="staff-add"><p class="muted mb-4">${t('stf.add.lead')}</p><div class="stack">
            <div class="field"><label for="f-lookup">${t('stf.lookup')}</label>
              <div class="stf-lookup"><input class="input" type="email" id="f-lookup" name="lookup" autocomplete="off" inputmode="email" aria-describedby="stf-found"><button type="button" class="btn" data-find>${t('stf.find')}</button></div>
              <div class="field-hint" id="stf-found" role="status" aria-live="polite"></div></div>
            ${fieldHtml({ name: 'uid', label: t('stf.uid'), required: true, hint: t('stf.uidHint'), attrs: { autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 128 } })}
            ${fieldHtml({ name: 'email', label: t('stf.email'), type: 'email', required: true, attrs: { autocomplete: 'off', maxlength: 120 } })}
            ${fieldHtml({ name: 'name', label: t('stf.name'), attrs: { autocomplete: 'off', maxlength: 80 } })}
            ${fieldHtml({ name: 'role', label: t('stf.role'), type: 'select', required: true, options: roleOptions(true) })}
            <p class="small muted" id="stf-role-about" aria-live="polite"></p></div></form>`,
          onSubmit: async (form) => {
            showFormErrors(form, {});
            const v = readForm(form);
            try {
              await saveStaff({ creating: true, form: { uid: v.uid, email: v.email, name: v.name, role: v.role }, staff });
            } catch (e) {
              if (e && e.errors) { showFormErrors(form, e.errors); return false; }
              if (!isRefusal(e)) reportError(e, 'staff.add');
              toastError(explainError(e));
              return false;
            }
            toast(t('stf.toast.added'));
            await refresh();
            return true;
          },
        });
        const form = document.querySelector('[role="dialog"] form[data-form="staff-add"]');
        if (form) {
          const found = form.querySelector('#stf-found');
          form.querySelector('#f-role').addEventListener('change', () => aboutLine(form));
          const find = async (btn) => {
            const q = form.querySelector('#f-lookup').value.trim();
            if (!q) { found.textContent = ''; return; }
            btn.disabled = true; found.textContent = '';
            try {
              const hit = await findAccountByEmail(q);
              if (hit) {
                form.querySelector('#f-uid').value = hit.uid;
                form.querySelector('#f-email').value = (hit.email || q).toLowerCase();
                if (!form.querySelector('#f-name').value) form.querySelector('#f-name').value = hit.name || '';
                found.textContent = t('stf.found', { name: hit.name || hit.email || q });
              } else found.textContent = t('stf.notFound');
            } catch (e) { if (!isRefusal(e)) reportError(e, 'staff.lookup'); found.textContent = explainError(e); } finally { btn.disabled = false; }
          };
          form.querySelector('[data-find]').addEventListener('click', (e) => find(e.currentTarget));
          form.querySelector('#f-lookup').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); find(form.querySelector('[data-find]')); } });
        }
        return closed;
      };

      const edit = (m) => {
        const self = m.id === me;
        formDialog({
          title: t('stf.edit.title', { name: who(m) }), confirmText: t('common.save'), size: 'md',
          body: html`<form novalidate data-form="staff-edit"><div class="stack">
            ${fieldHtml({ name: 'email', label: t('stf.email'), type: 'email', value: m.email || '', attrs: { autocomplete: 'off', maxlength: 120 } })}
            ${fieldHtml({ name: 'name', label: t('stf.name'), value: m.name || '', attrs: { autocomplete: 'off', maxlength: 80 } })}
            ${fieldHtml({ name: 'role', label: t('stf.role'), type: 'select', value: m.role, options: roleOptions(), hint: self ? t('stf.selfHint') : '', attrs: self ? { disabled: true } : {} })}
            <p class="small muted" id="stf-role-about" aria-live="polite">${aboutRole(m.role)}</p>
            ${fieldHtml({ name: 'active', label: t('stf.activeLabel'), type: 'switch', value: m.active === true, attrs: self ? { disabled: true } : {} })}
          </div></form>`,
          onSubmit: async (form) => {
            showFormErrors(form, {});
            const v = readForm(form);
            try {
              const plan = await saveStaff({ uid: m.id, form: { email: v.email, name: v.name, role: self ? m.role : v.role, active: self ? m.active === true : v.active === true }, staff });
              toast(plan.action === 'staff.deactivate' ? t('stf.toast.off') : plan.action === 'staff.activate' ? t('stf.toast.on') : t('common.saved'));
            } catch (e) {
              if (e && e.code === 'no_change') return true;
              if (e && e.errors) { showFormErrors(form, e.errors); return false; }
              if (!isRefusal(e)) reportError(e, 'staff.edit');
              toastError(explainError(e));
              return false;
            }
            await refresh();
            return true;
          },
        });
        const form = document.querySelector('[role="dialog"] form[data-form="staff-edit"]');
        if (form) form.querySelector('#f-role').addEventListener('change', () => aboutLine(form));
      };

      const setActive = async (m, active) => {
        if (!active && !(await confirmDialog({ title: t('stf.off.title', { name: who(m) }), message: t('stf.off.text'), confirmText: t('stf.menu.off'), danger: true }))) return;
        try {
          await saveStaff({ uid: m.id, form: { email: m.email || '', name: m.name || '', role: m.role, active }, staff });
          toast(active ? t('stf.toast.on') : t('stf.toast.off'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'staff.active'); toastError(explainError(e)); }
      };

      const remove = async (m) => {
        if (!(await confirmDialog({ title: t('stf.remove.title', { name: who(m) }), message: t('stf.remove.text'), confirmText: t('stf.menu.remove'), danger: true }))) return;
        try {
          await removeStaff({ uid: m.id, staff });
          toast(t('stf.toast.removed'));
          await refresh();
        } catch (e) { if (!isRefusal(e)) reportError(e, 'staff.remove'); toastError(explainError(e)); }
      };

      ctx.cleanup(bindActions(ctx.el, {
        add: addMember,
        'row-menu': (btn) => {
          const m = staff.find((s) => s.id === btn.dataset.uid);
          if (!m) return;
          const items = [{ label: t('stf.menu.edit'), icon: 'edit', onClick: () => edit(m) }];
          if (m.id !== me) {
            items.push(m.active === true
              ? { label: t('stf.menu.off'), icon: 'eye-off', onClick: () => setActive(m, false) }
              : { label: t('stf.menu.on'), icon: 'check-circle', onClick: () => setActive(m, true) });
            if (m.active !== true) items.push({ label: t('stf.menu.remove'), icon: 'trash', danger: true, onClick: () => remove(m) });
          }
          openMenu({ anchor: btn, items });
        },
      }));
    });
  },
};
