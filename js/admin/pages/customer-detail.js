/*
 * Customers → one customer. Permission: customers.read to look; customers.write (Super Admin, Store Admin) to restrict the account and to write or delete notes.
 *
 *   top        who they are, the four numbers that matter (orders · spent · average order · last order — from their real orders)
 *   main       orders (needs orders.read) · support requests (needs support.read) · internal notes (staff only, never shown to the customer)
 *   side       account details · restriction (a restricted account cannot place orders; a reason of 3–200 characters is required and kept in the audit log)
 * Each part loads on its own, so one that fails (or is not allowed) never hides the others.
 * Rules of the game: shared/customerFlow.js (the audit log records that a note was written, never its words).
 */
import { html, render, bindActions } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, errorState, spinnerBlock, fieldHtml, formDialog, confirmDialog, toast, toastError, statusBadge, paymentBadge, ticketBadge, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, money, fmtDate, fmtDateTime, relTime, fmtPhone } from '../../core/format.js';
import { can, currentUid } from '../../data/auth.js';
import { CUSTOMER, summarizeCustomerOrders } from '../../shared/customerFlow.js';
import { itemCount } from '../../shared/orderModel.js';
import { safeMount, pageHead, needs, kvList, kpiCard, runAction, priorityBadge } from '../lib/ui.js';
import { methodLabel } from '../lib/orderUi.js';
import { customerName, customerStatus } from '../lib/customerUi.js';
import { loadCustomer, loadCustomerOrders, loadCustomerTickets, loadNotes, restrictCustomer, liftRestriction, addNote, deleteNote } from '../data/customers.js';

registerBoth({
  'cus.back': ['All customers', 'সব কাস্টমার'],
  'cus.notFound': ['Customer not found', 'কাস্টমার পাওয়া যায়নি'],
  'cus.notFoundText': ['The account may not exist, or the link is wrong.', 'অ্যাকাউন্টটি নেই, অথবা লিংকটি ভুল।'],
  'cus.joinedOn': ['Joined {when}', 'যোগ দিয়েছেন {when}'],
  'cus.kpi.orders': ['Orders', 'অর্ডার'],
  'cus.kpi.ordersSub': ['{n} cancelled', '{n}টি বাতিল'],
  'cus.kpi.spent': ['Total spent', 'মোট কেনাকাটা'],
  'cus.kpi.spentSub': ['{n} orders counted', '{n}টি অর্ডার ধরা হয়েছে'],
  'cus.kpi.avg': ['Average order', 'গড় অর্ডার'],
  'cus.kpi.last': ['Last order', 'শেষ অর্ডার'],
  'cus.orders': ['Orders', 'অর্ডার'],
  'cus.orders.empty': ['No orders yet', 'এখনও কোনো অর্ডার নেই'],
  'cus.orders.emptyText': ['Orders placed with this account appear here.', 'এই অ্যাকাউন্ট থেকে দেওয়া অর্ডার এখানে দেখা যাবে।'],
  'cus.orders.capped': ['Only the latest {n} orders are shown and counted.', 'সর্বশেষ {n}টি অর্ডার দেখানো ও গোনা হয়েছে।'],
  'cus.col.order': ['Order', 'অর্ডার'],
  'cus.col.date': ['Date', 'তারিখ'],
  'cus.col.items': ['Items', 'পণ্য'],
  'cus.col.total': ['Total', 'মোট'],
  'cus.col.payment': ['Payment', 'পেমেন্ট'],
  'cus.col.orderStatus': ['Status', 'অবস্থা'],
  'cus.tickets': ['Support requests', 'সাপোর্ট অনুরোধ'],
  'cus.tickets.empty': ['No support requests from this account.', 'এই অ্যাকাউন্ট থেকে কোনো সাপোর্ট অনুরোধ নেই।'],
  'cus.tickets.capped': ['Only the latest {n} requests are shown.', 'সর্বশেষ {n}টি অনুরোধ দেখানো হয়েছে।'],
  'cus.account': ['Account', 'অ্যাকাউন্ট'],
  'cus.d.name': ['Name', 'নাম'],
  'cus.d.email': ['E-mail', 'ইমেইল'],
  'cus.d.phone': ['Phone', 'ফোন'],
  'cus.d.joined': ['Joined', 'যোগ দিয়েছেন'],
  'cus.d.lastLogin': ['Last sign-in', 'শেষ সাইন-ইন'],
  'cus.d.lastOrder': ['Last order', 'শেষ অর্ডার'],
  'cus.d.address': ['Latest delivery address', 'সর্বশেষ ডেলিভারি ঠিকানা'],
  'cus.d.id': ['Customer ID', 'কাস্টমার আইডি'],
  'cus.restriction': ['Restriction', 'সীমাবদ্ধতা'],
  'cus.restriction.ok': ['This customer can order normally.', 'এই কাস্টমার স্বাভাবিকভাবে অর্ডার করতে পারেন।'],
  'cus.restriction.explain': ['A restricted account cannot place orders. Signing in, the wishlist and support requests keep working.', 'সীমাবদ্ধ অ্যাকাউন্ট থেকে অর্ডার দেওয়া যায় না। সাইন-ইন, উইশলিস্ট ও সাপোর্ট অনুরোধ আগের মতোই চলে।'],
  'cus.restriction.since': ['Since {when}', '{when} থেকে'],
  'cus.restrict': ['Restrict account…', 'অ্যাকাউন্ট সীমাবদ্ধ করুন…'],
  'cus.restrict.title': ['Restrict this account?', 'এই অ্যাকাউন্ট সীমাবদ্ধ করবেন?'],
  'cus.restrict.text': ['{name} will not be able to place orders until you lift the restriction. Say why — the reason is kept in the audit log.', 'আপনি সীমাবদ্ধতা তোলা পর্যন্ত {name} অর্ডার দিতে পারবেন না। কারণ লিখুন — কারণটি অডিট লগে থাকবে।'],
  'cus.restrict.reason': ['Reason', 'কারণ'],
  'cus.restrict.hint': ['{min}–{max} characters. Only staff see it.', '{min}–{max} অক্ষর। শুধু স্টাফ দেখতে পাবেন।'],
  'cus.restrict.confirm': ['Restrict account', 'অ্যাকাউন্ট সীমাবদ্ধ করুন'],
  'cus.restrict.done': ['Account restricted', 'অ্যাকাউন্ট সীমাবদ্ধ করা হয়েছে'],
  'cus.lift': ['Lift restriction', 'সীমাবদ্ধতা তুলুন'],
  'cus.lift.title': ['Lift the restriction?', 'সীমাবদ্ধতা তুলবেন?'],
  'cus.lift.text': ['{name} will be able to place orders again.', '{name} আবার অর্ডার দিতে পারবেন।'],
  'cus.lift.done': ['Restriction lifted', 'সীমাবদ্ধতা তোলা হয়েছে'],
  'cus.err.reason.required': ['Write a reason.', 'কারণ লিখুন।'],
  'cus.err.reason.too_short': ['The reason is too short (at least {min} characters).', 'কারণটি খুব ছোট (কমপক্ষে {min} অক্ষর)।'],
  'cus.err.reason.too_long': ['The reason is too long ({max} characters at most).', 'কারণটি অনেক লম্বা (সর্বোচ্চ {max} অক্ষর)।'],
  'cus.notes': ['Internal notes', 'অভ্যন্তরীণ নোট'],
  'cus.notes.hint': ['Only staff can see these — never the customer.', 'শুধু স্টাফ এগুলো দেখতে পান — কাস্টমার কখনও নন।'],
  'cus.notes.readOnly': ['You can read the notes but not add any.', 'আপনি নোট পড়তে পারবেন, যোগ করতে পারবেন না।'],
  'cus.notes.empty': ['No notes yet.', 'এখনও কোনো নোট নেই।'],
  'cus.note.label': ['New note', 'নতুন নোট'],
  'cus.note.count': ['{n} of {max} characters', '{max} অক্ষরের মধ্যে {n}টি'],
  'cus.note.add': ['Add note', 'নোট যোগ করুন'],
  'cus.note.added': ['Note added', 'নোট যোগ হয়েছে'],
  'cus.note.delete': ['Delete this note', 'এই নোটটি মুছুন'],
  'cus.note.delete.title': ['Delete this note?', 'এই নোটটি মুছবেন?'],
  'cus.note.delete.text': ['It is removed for everyone.', 'এটি সবার জন্য মুছে যাবে।'],
  'cus.note.delete.confirm': ['Delete note', 'নোট মুছুন'],
  'cus.note.deleted': ['Note deleted', 'নোট মুছে ফেলা হয়েছে'],
  'cus.err.text.required': ['Write the note first.', 'আগে নোট লিখুন।'],
  'cus.err.text.too_long': ['The note is too long ({max} characters at most).', 'নোটটি অনেক লম্বা (সর্বোচ্চ {max} অক্ষর)।'],
});

const dash = '—';
const mailto = (e) => `mailto:${encodeURIComponent(e)}`;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'customers.read')) return;
    await loadCss('/css/pages/admin-customers.css');
    await safeMount(ctx, async () => {
      const id = ctx.params.id;
      const href = (p) => ctx.router.href(p);
      const back = html`<a class="back-link" href="${href('/customers')}">${icon('arrow-left', { size: 18 })}<span>${t('cus.back')}</span></a>`;
      const customer = await loadCustomer(id);
      if (ctx.signal.aborted) return;
      if (!customer) {
        render(ctx.el, html`<div class="cus">${back}${emptyState({ icon: 'users', title: t('cus.notFound'), text: t('cus.notFoundText') })}</div>`);
        return;
      }
      const canWrite = can('customers.write');
      const canOrders = can('orders.read');
      const canTickets = can('support.read');
      const canRestrict = canWrite && id !== currentUid();
      // null = still loading · { error } = failed · otherwise the loaded data
      const state = { customer, orders: canOrders ? null : undefined, tickets: canTickets ? null : undefined, notes: null };
      const ok = (s) => !!s && !s.error;

      /* ───────── head + numbers ───────── */
      const headHtml = () => {
        const c = state.customer;
        return pageHead({
          title: customerName(c),
          sub: html`${c.email || dash}${c.joinedMs ? html` · ${t('cus.joinedOn', { when: fmtDate(c.joinedMs) })}` : ''}`,
          actions: customerStatus(c),
        });
      };

      const kpisHtml = () => {
        const s = ok(state.orders) ? summarizeCustomerOrders(state.orders.orders) : null;
        return html`<div class="kpi-grid cus-kpis">
          ${kpiCard({ label: t('cus.kpi.orders'), value: s ? num(s.orders) : dash, sub: s ? t('cus.kpi.ordersSub', { n: num(s.cancelled) }) : '' })}
          ${kpiCard({ label: t('cus.kpi.spent'), value: s ? money(s.spent) : dash, sub: s ? t('cus.kpi.spentSub', { n: num(s.completed) }) : '' })}
          ${kpiCard({ label: t('cus.kpi.avg'), value: s ? money(s.average) : dash })}
          ${kpiCard({ label: t('cus.kpi.last'), value: s && s.lastMs ? relTime(s.lastMs) : dash, sub: s && s.lastMs ? fmtDate(s.lastMs) : '' })}
        </div>`;
      };

      /* ───────── orders ───────── */
      const orderRow = (o) => html`<tr>
        <td class="cell-first"><div class="cell-main"><div><a class="t mono" href="${href('/orders/' + encodeURIComponent(o.id))}">${o.orderNumber}</a></div></div></td>
        <td data-label="${t('cus.col.date')}">${o.createdAtMs ? fmtDate(o.createdAtMs) : dash}</td>
        <td data-label="${t('cus.col.items')}">${num(itemCount(o))}</td>
        <td data-label="${t('cus.col.total')}">${money(o.totals.total)}</td>
        <td data-label="${t('cus.col.payment')}"><div class="cus-pay"><span>${methodLabel(o.payment.method)}</span>${paymentBadge(o.payment.status)}</div></td>
        <td data-label="${t('cus.col.orderStatus')}">${statusBadge(o.status)}</td>
      </tr>`;
      const ordersBody = () => {
        const s = state.orders;
        if (!s) return spinnerBlock();
        if (s.error) return errorState({ text: s.error });
        if (!s.orders.length) return emptyState({ icon: 'package', title: t('cus.orders.empty'), text: t('cus.orders.emptyText') });
        return html`${s.capped ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${t('cus.orders.capped', { n: num(s.orders.length) })}</div></div>` : ''}
          <div class="table-wrap"><table class="table table-stack table-cards cus-orders" id="cus-orders-table">
            <thead><tr><th scope="col">${t('cus.col.order')}</th><th scope="col">${t('cus.col.date')}</th><th scope="col">${t('cus.col.items')}</th><th scope="col">${t('cus.col.total')}</th><th scope="col">${t('cus.col.payment')}</th><th scope="col">${t('cus.col.orderStatus')}</th></tr></thead>
            <tbody>${s.orders.map(orderRow)}</tbody></table></div>`;
      };
      const ordersPanel = () => (canOrders ? html`<section class="panel" aria-labelledby="cus-orders-h"><div class="panel-head"><h2 id="cus-orders-h">${t('cus.orders')}</h2></div><div class="panel-body" id="cus-orders-body">${ordersBody()}</div></section>` : '');

      /* ───────── support requests ───────── */
      const ticketRow = (k) => html`<li>
        <div class="cus-ticket"><a href="${href('/support/' + encodeURIComponent(k.id))}">${k.subject}</a>
          <span class="cus-sub"><span class="mono">${k.id}</span> · ${relTime(k.updatedMs)}</span></div>
        <div class="cus-badges">${k.priority !== 'normal' ? priorityBadge(k.priority) : ''}${ticketBadge(k.status)}</div>
      </li>`;
      const ticketsBody = () => {
        const s = state.tickets;
        if (!s) return spinnerBlock();
        if (s.error) return errorState({ text: s.error });
        if (!s.items.length) return html`<p class="muted">${t('cus.tickets.empty')}</p>`;
        return html`<ul class="cus-list" id="cus-tickets-list">${s.items.map(ticketRow)}</ul>${s.capped ? html`<p class="muted small mt-3">${t('cus.tickets.capped', { n: num(s.items.length) })}</p>` : ''}`;
      };
      const ticketsPanel = () => (canTickets ? html`<section class="panel" aria-labelledby="cus-tickets-h"><div class="panel-head"><h2 id="cus-tickets-h">${t('cus.tickets')}</h2></div><div class="panel-body" id="cus-tickets-body">${ticketsBody()}</div></section>` : '');

      /* ───────── notes ───────── */
      const noteItem = (n) => html`<li class="cus-note" data-id="${n.id}">
        <p class="cus-note-text">${n.text}</p>
        <div class="cus-note-meta"><span>${n.authorEmail || dash} · <time>${fmtDateTime(n.createdMs)}</time></span>
          ${canWrite ? html`<button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="note-del" data-id="${n.id}" aria-label="${t('cus.note.delete')}" title="${t('cus.note.delete')}">${icon('trash', { size: 16 })}</button>` : ''}</div>
      </li>`;
      const notesList = () => {
        const s = state.notes;
        if (!s) return spinnerBlock();
        if (s.error) return errorState({ text: s.error });
        if (!s.items.length) return html`<p class="muted" id="cus-notes-empty">${t('cus.notes.empty')}</p>`;
        return html`<ul class="cus-notes" id="cus-notes-list">${s.items.map(noteItem)}</ul>`;
      };
      const noteForm = () => (canWrite ? html`<form novalidate data-form="note" class="stack">
          ${fieldHtml({ name: 'text', label: t('cus.note.label'), type: 'textarea', rows: 3, attrs: { maxlength: CUSTOMER.NOTE_MAX, autocomplete: 'off' } })}
          <p class="muted small" id="cus-count" aria-live="off">${t('cus.note.count', { n: 0, max: num(CUSTOMER.NOTE_MAX) })}</p>
          <div><button type="button" class="btn btn-primary" data-action="note-add">${icon('plus', { size: 18 })}<span>${t('cus.note.add')}</span></button></div>
        </form>` : html`<div class="alert alert-info" role="note">${icon('info', { size: 18 })}<div>${t('cus.notes.readOnly')}</div></div>`);

      /* ───────── side: account + restriction ───────── */
      const latestAddress = () => {
        if (!ok(state.orders)) return '';
        const a = (state.orders.orders.find((o) => o.address && o.address.line1) || {}).address;
        return a ? [a.line1, a.area, a.upazila, a.district].filter(Boolean).join(', ') : '';
      };
      const accountPanel = () => {
        const c = state.customer;
        const address = latestAddress();
        return html`<section class="panel" aria-labelledby="cus-acc-h"><div class="panel-head"><h2 id="cus-acc-h">${t('cus.account')}</h2></div>
          <div class="panel-body">${kvList([
            [t('cus.d.name'), c.name || dash],
            [t('cus.d.email'), c.email ? html`<a href="${mailto(c.email)}">${c.email}</a>` : dash],
            [t('cus.d.phone'), c.phone ? html`<a href="tel:${encodeURIComponent(c.phone)}">${fmtPhone(c.phone)}</a>` : dash],
            [t('cus.d.joined'), c.joinedMs ? fmtDateTime(c.joinedMs) : dash],
            [t('cus.d.lastLogin'), c.lastLoginMs ? fmtDateTime(c.lastLoginMs) : dash],
            [t('cus.d.lastOrder'), c.lastOrderMs ? fmtDateTime(c.lastOrderMs) : dash],
            address ? [t('cus.d.address'), address] : null,
            [t('cus.d.id'), html`<span class="mono cus-id">${c.id}</span>`],
          ])}</div></section>`;
      };
      const restrictionPanel = () => {
        const c = state.customer;
        return html`<section class="panel" aria-labelledby="cus-rs-h"><div class="panel-head"><h2 id="cus-rs-h">${t('cus.restriction')}</h2>${customerStatus(c)}</div>
          <div class="panel-body stack">
            ${c.restricted
              ? html`<div class="alert alert-warn" role="note">${icon('alert-triangle', { size: 18 })}<div><p class="cus-reason">${c.restrictedReason || dash}</p>${c.restrictedMs ? html`<p class="muted small">${t('cus.restriction.since', { when: fmtDateTime(c.restrictedMs) })}</p>` : ''}</div></div>`
              : html`<p class="muted">${t('cus.restriction.ok')}</p>`}
            <p class="muted small">${t('cus.restriction.explain')}</p>
            ${canWrite && c.restricted ? html`<div><button type="button" class="btn" data-action="lift">${icon('undo', { size: 18 })}<span>${t('cus.lift')}</span></button></div>` : ''}
            ${canRestrict && !c.restricted ? html`<div><button type="button" class="btn btn-danger-ghost" data-action="restrict">${icon('ban', { size: 18 })}<span>${t('cus.restrict')}</span></button></div>` : ''}
          </div></section>`;
      };

      render(ctx.el, html`<div class="cus">${back}<div id="cus-head"></div>
        <div class="split">
          <div class="stack">
            ${canOrders ? html`<div id="cus-kpis"></div>` : ''}
            <div id="cus-orders">${ordersPanel()}</div>
            <div id="cus-tickets">${ticketsPanel()}</div>
            <section class="panel" aria-labelledby="cus-notes-h"><div class="panel-head"><h2 id="cus-notes-h">${t('cus.notes')}</h2><span class="muted small">${t('cus.notes.hint')}</span></div>
              <div class="panel-body stack"><div id="cus-note-form">${noteForm()}</div><div id="cus-notes-wrap">${notesList()}</div></div></section>
          </div>
          <aside><div id="cus-side" class="stack"></div></aside>
        </div></div>`);
      const host = (sel) => ctx.el.querySelector(sel);
      const paintHead = () => render(host('#cus-head'), headHtml());
      const paintKpis = () => { const el = host('#cus-kpis'); if (el) render(el, kpisHtml()); };
      const paintOrders = () => { const el = host('#cus-orders-body'); if (el) render(el, ordersBody()); };
      const paintTickets = () => { const el = host('#cus-tickets-body'); if (el) render(el, ticketsBody()); };
      const paintNotes = () => render(host('#cus-notes-wrap'), notesList());
      const paintSide = () => render(host('#cus-side'), html`${accountPanel()}${restrictionPanel()}`);
      paintHead(); paintKpis(); paintSide();

      /* ───────── loading ───────── */
      const safely = async (fn, where) => { try { return await fn(); } catch (e) { reportError(e, where); return { error: explainError(e) }; } };
      const loadAll = () => {
        if (canOrders) safely(() => loadCustomerOrders(id), 'customers.orders').then((r) => { state.orders = r; if (!ctx.signal.aborted) { paintOrders(); paintKpis(); paintSide(); } });
        if (canTickets) safely(() => loadCustomerTickets(id), 'customers.tickets').then((r) => { state.tickets = r; if (!ctx.signal.aborted) paintTickets(); });
        safely(async () => ({ items: await loadNotes(id) }), 'customers.notes').then((r) => { state.notes = r; if (!ctx.signal.aborted) paintNotes(); });
      };
      loadAll();
      const refreshCustomer = async () => {
        const fresh = await loadCustomer(id);
        if (ctx.signal.aborted || !fresh) return;
        state.customer = fresh;
        paintHead(); paintSide();
      };
      const refreshNotes = async () => {
        state.notes = await safely(async () => ({ items: await loadNotes(id) }), 'customers.notes');
        if (!ctx.signal.aborted) paintNotes();
      };

      /* ───────── actions ───────── */
      const fail = (e, where) => { if (!isRefusal(e)) reportError(e, where); toastError(explainError(e)); };
      const reasonMessage = (code) => t(`cus.err.reason.${code}`, { min: num(CUSTOMER.REASON_MIN), max: num(CUSTOMER.REASON_MAX) });

      const restrict = () => formDialog({
        title: t('cus.restrict.title'),
        confirmText: t('cus.restrict.confirm'),
        danger: true,
        body: html`<form novalidate data-form="restrict"><div class="stack"><p>${t('cus.restrict.text', { name: customerName(state.customer) })}</p>
          ${fieldHtml({ name: 'reason', label: t('cus.restrict.reason'), type: 'textarea', rows: 3, required: true, hint: t('cus.restrict.hint', { min: num(CUSTOMER.REASON_MIN), max: num(CUSTOMER.REASON_MAX) }), attrs: { maxlength: CUSTOMER.REASON_MAX, autocomplete: 'off' } })}</div></form>`,
        onSubmit: async (form) => {
          showFormErrors(form, {});
          try { await restrictCustomer({ id, reason: form.elements.reason.value }); } catch (e) {
            if (e && e.errors && e.errors.reason) { showFormErrors(form, { reason: reasonMessage(e.errors.reason) }); return false; }
            fail(e, 'customers.restrict');
            return false;
          }
          toast(t('cus.restrict.done'));
          await refreshCustomer();
          return true;
        },
      });

      const lift = async (btn) => {
        const yes = await confirmDialog({ title: t('cus.lift.title'), message: t('cus.lift.text', { name: customerName(state.customer) }), confirmText: t('cus.lift') });
        if (!yes) return;
        const r = await runAction(btn, () => liftRestriction(id), { ok: t('cus.lift.done') });
        if (r.ok) await refreshCustomer();
      };

      const noteAdd = async (btn) => {
        const form = host('form[data-form="note"]');
        if (!form) return;
        showFormErrors(form, {});
        btn.disabled = true;
        try {
          await addNote({ id, text: form.elements.text.value });
          form.elements.text.value = '';
          host('#cus-count').textContent = t('cus.note.count', { n: 0, max: num(CUSTOMER.NOTE_MAX) });
          toast(t('cus.note.added'));
          await refreshNotes();
          form.elements.text.focus();
        } catch (e) {
          if (e && e.errors && e.errors.text) showFormErrors(form, { text: t(`cus.err.text.${e.errors.text}`, { max: num(CUSTOMER.NOTE_MAX) }) });
          else fail(e, 'customers.note');
        } finally { btn.disabled = false; }
      };

      const noteDel = async (btn) => {
        const yes = await confirmDialog({ title: t('cus.note.delete.title'), message: t('cus.note.delete.text'), confirmText: t('cus.note.delete.confirm'), danger: true });
        if (!yes) return;
        const r = await runAction(btn, () => deleteNote({ id, noteId: btn.dataset.id }), { ok: t('cus.note.deleted') });
        if (r.ok) await refreshNotes();
      };

      ctx.cleanup(bindActions(ctx.el, {
        restrict, lift, 'note-add': noteAdd, 'note-del': noteDel,
        retry: () => { state.orders = canOrders ? null : undefined; state.tickets = canTickets ? null : undefined; state.notes = null; paintOrders(); paintTickets(); paintNotes(); loadAll(); },
      }, {
        input: { text: (el) => { host('#cus-count').textContent = t('cus.note.count', { n: num(el.value.length), max: num(CUSTOMER.NOTE_MAX) }); } },
      }));
    });
  },
};
