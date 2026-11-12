/*
 * Customers — everyone with an account. Permission: customers.read (Super Admin, Store Admin, Order Manager, Customer Support);
 * restricting, notes and removing subscribers (profile page / newsletter tab) need customers.write; exporting needs reports.export as well.
 *
 *   All customers   newest first, loaded 100 at a time ("Load more"); search works on what is loaded — a full e-mail address or phone number
 *                   searches EVERYONE (an exact lookup), so nobody is out of reach
 *   Restricted      the accounts that cannot order
 *   Newsletter      the e-mail addresses that subscribed; staff with customers.write can remove one
 * "Export CSV" saves what the tab lists (after the search). The export is written to the audit log first — no file leaves without a record.
 * Rules of the game: shared/customerFlow.js.
 */
import { html, render, bindActions, debounce } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { emptyState, errorState, spinnerBlock, paginationHtml, confirmDialog, toast, toastError, loadCss } from '../../core/ui.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, fmtDate, relTime, fmtPhone, dhakaDayKey } from '../../core/format.js';
import { can } from '../../data/auth.js';
import { filterCustomers, orderCustomers, lookupKind, filterSubscribers } from '../../shared/customerFlow.js';
import { safeMount, pageHead, needs, searchField, runAction, exportCsv } from '../lib/ui.js';
import { customerName, customerStatus, sourceLabel, customersCsv, subscribersCsv } from '../lib/customerUi.js';
import { loadCustomers, loadRestricted, findCustomers, loadSubscribers, removeSubscriber, auditExport, PAGE_SIZE, LIST_CAP } from '../data/customers.js';

registerBoth({
  'cus.title': ['Customers', 'কাস্টমার'],
  'cus.sub': ['Everyone who has an account. Open a customer to see their orders and requests, leave a private note or restrict the account.', 'যাদের অ্যাকাউন্ট আছে তারা সবাই। অর্ডার ও অনুরোধ দেখতে, ব্যক্তিগত নোট রাখতে বা অ্যাকাউন্ট সীমাবদ্ধ করতে কাস্টমার খুলুন।'],
  'cus.tabs': ['Customer lists', 'কাস্টমারের তালিকা'],
  'cus.tab.all': ['All customers', 'সব কাস্টমার'],
  'cus.tab.restricted': ['Restricted', 'সীমাবদ্ধ'],
  'cus.tab.newsletter': ['Newsletter', 'নিউজলেটার'],
  'cus.search': ['Search name, e-mail or phone', 'নাম, ইমেইল বা ফোন খুঁজুন'],
  'cus.searchNews': ['Search e-mail address', 'ইমেইল ঠিকানা খুঁজুন'],
  'cus.col.customer': ['Customer', 'কাস্টমার'],
  'cus.col.phone': ['Phone', 'ফোন'],
  'cus.col.joined': ['Joined', 'যোগ দিয়েছেন'],
  'cus.col.lastOrder': ['Last order', 'শেষ অর্ডার'],
  'cus.col.status': ['Status', 'অবস্থা'],
  'cus.col.email': ['E-mail', 'ইমেইল'],
  'cus.col.source': ['Signed up on', 'যেখানে সাইন-আপ'],
  'cus.col.subscribed': ['Subscribed', 'সাবস্ক্রাইব'],
  'cus.empty.all': ['No customers yet', 'এখনও কোনো কাস্টমার নেই'],
  'cus.emptyText.all': ['Customers appear here when they create an account.', 'কেউ অ্যাকাউন্ট খুললে এখানে দেখা যাবে।'],
  'cus.empty.restricted': ['No restricted accounts', 'কোনো সীমাবদ্ধ অ্যাকাউন্ট নেই'],
  'cus.emptyText.restricted': ['Accounts you restrict are listed here.', 'আপনি যেগুলো সীমাবদ্ধ করবেন সেগুলো এখানে থাকবে।'],
  'cus.empty.newsletter': ['No subscribers yet', 'এখনও কোনো সাবস্ক্রাইবার নেই'],
  'cus.emptyText.newsletter': ['Addresses appear here when someone subscribes on your website.', 'কেউ ওয়েবসাইটে সাবস্ক্রাইব করলে ঠিকানা এখানে দেখা যাবে।'],
  'cus.noMatch': ['Nothing matches', 'কিছুই মেলেনি'],
  'cus.noMatchText': ['Change the search. A full e-mail address or phone number looks through every customer.', 'সার্চ বদলান। পূর্ণ ইমেইল ঠিকানা বা ফোন নম্বর দিলে সব কাস্টমারের মধ্যে খোঁজা হয়।'],
  'cus.more': ['Customers load {n} at a time, newest first. Search by a full e-mail address or phone number to find anyone, even if they are not loaded yet.', 'কাস্টমার একবারে {n}জন করে লোড হয়, নতুনরা আগে। এখনও লোড না হওয়া কাউকে পেতে পূর্ণ ইমেইল ঠিকানা বা ফোন নম্বর দিয়ে খুঁজুন।'],
  'cus.capped': ['Only the first {n} are loaded.', 'প্রথম {n}টি লোড হয়েছে।'],
  'cus.loadMore': ['Load {n} more', 'আরও {n}জন লোড করুন'],
  'cus.searching': ['Searching all customers…', 'সব কাস্টমারের মধ্যে খোঁজা হচ্ছে…'],
  'cus.footer': ['Showing {shown} of {total} loaded', 'লোড হওয়া {total}-এর মধ্যে {shown}টি দেখানো হচ্ছে'],
  'cus.export': ['Export CSV', 'CSV এক্সপোর্ট'],
  'cus.export.none': ['There is nothing to export.', 'এক্সপোর্ট করার কিছু নেই।'],
  'cus.export.done': ['{n} rows exported', '{n}টি সারি এক্সপোর্ট হয়েছে'],
  'cus.unsub': ['Remove', 'সরান'],
  'cus.unsub.label': ['Remove {email} from the newsletter', '{email}-কে নিউজলেটার থেকে সরান'],
  'cus.unsub.title': ['Remove this subscriber?', 'এই সাবস্ক্রাইবারকে সরাবেন?'],
  'cus.unsub.text': ['{email} will no longer be on the newsletter list. They can subscribe again at any time.', '{email} আর নিউজলেটার তালিকায় থাকবে না। চাইলে যেকোনো সময় আবার সাবস্ক্রাইব করতে পারবে।'],
  'cus.unsub.confirm': ['Remove subscriber', 'সাবস্ক্রাইবার সরান'],
  'cus.unsub.done': ['Subscriber removed', 'সাবস্ক্রাইবার সরানো হয়েছে'],
});

const TABS = ['all', 'restricted', 'newsletter'];
const TAB_ICON = { all: 'users', restricted: 'ban', newsletter: 'mail' };
const PAGE = 25;
const dash = '—';

export default {
  async mount(ctx) {
    if (!needs(ctx, 'customers.read')) return;
    await loadCss('/css/pages/admin-customers.css');
    await safeMount(ctx, async () => {
      const first = await loadCustomers();
      if (ctx.signal.aborted) return;
      const href = (p) => ctx.router.href(p);
      const canWrite = can('customers.write');
      const canExport = can('reports.export');
      const data = { all: first, restricted: null, newsletter: null, found: {} };
      const state = { tab: 'all', q: '', page: 1, error: null };

      const searchKey = () => { const k = lookupKind(state.q); return k ? `${k.field}:${k.value}` : ''; };
      const shownCustomers = () => {
        const base = state.tab === 'restricted' ? data.restricted.items : data.all.items;
        const hit = state.tab === 'all' ? data.found[searchKey()] : null;
        const have = new Set(base.map((c) => c.id));
        const merged = Array.isArray(hit) ? [...base, ...hit.filter((c) => !have.has(c.id))] : base;
        return orderCustomers(filterCustomers(merged, { q: state.q }));
      };
      const shownSubscribers = () => filterSubscribers(data.newsletter.items, state.q);
      const loaded = (tab) => (tab === 'all' ? data.all.items.length : data[tab] ? data[tab].items.length : null);

      const customerRow = (c) => html`<tr>
        <td class="cell-first"><div class="cell-main"><div>
          <a class="t cus-name" href="${href('/customers/' + encodeURIComponent(c.id))}">${customerName(c)}</a>
          <div class="s">${c.email || dash}</div>
        </div></div></td>
        <td data-label="${t('cus.col.phone')}">${c.phone ? fmtPhone(c.phone) : dash}</td>
        <td data-label="${t('cus.col.joined')}">${c.joinedMs ? fmtDate(c.joinedMs) : dash}</td>
        <td data-label="${t('cus.col.lastOrder')}">${c.lastOrderMs ? html`<span title="${fmtDate(c.lastOrderMs)}">${relTime(c.lastOrderMs)}</span>` : dash}</td>
        <td data-label="${t('cus.col.status')}">${customerStatus(c, { quiet: true })}</td>
      </tr>`;

      const subscriberRow = (s) => html`<tr>
        <td class="cell-first"><div class="cell-main"><div><span class="t cus-name">${s.email}</span></div></div></td>
        <td data-label="${t('cus.col.source')}">${sourceLabel(s.source)}</td>
        <td data-label="${t('cus.col.subscribed')}">${s.createdMs ? fmtDate(s.createdMs) : dash}</td>
        ${canWrite ? html`<td class="cell-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="unsub" data-id="${s.id}" aria-label="${t('cus.unsub.label', { email: s.email })}">${icon('trash', { size: 16 })}<span>${t('cus.unsub')}</span></button></td>` : ''}
      </tr>`;

      const customersResults = () => {
        const l = state.tab === 'all' ? data.all : data.restricted;
        if (!l) return spinnerBlock();
        if (!l.items.length && !state.q) return emptyState({ icon: TAB_ICON[state.tab], title: t(`cus.empty.${state.tab}`), text: t(`cus.emptyText.${state.tab}`) });
        const list = shownCustomers();
        if (!list.length && state.tab === 'all' && data.found[searchKey()] === 'loading') return html`<p class="muted" role="status">${t('cus.searching')}</p>${spinnerBlock()}`;
        if (!list.length) return emptyState({ icon: 'search', title: t('cus.noMatch'), text: t('cus.noMatchText') });
        const pages = Math.max(1, Math.ceil(list.length / PAGE));
        state.page = Math.min(state.page, pages);
        const slice = list.slice((state.page - 1) * PAGE, state.page * PAGE);
        const more = state.tab === 'all' && data.all.more;
        return html`${more ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${t('cus.more', { n: num(PAGE_SIZE) })}</div></div>` : ''}
          ${state.tab === 'restricted' && data.restricted.capped ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${t('cus.capped', { n: num(LIST_CAP) })}</div></div>` : ''}
          <div class="table-wrap"><table class="table table-stack table-cards cus-table" id="cus-table">
            <thead><tr><th scope="col">${t('cus.col.customer')}</th><th scope="col">${t('cus.col.phone')}</th><th scope="col">${t('cus.col.joined')}</th><th scope="col">${t('cus.col.lastOrder')}</th><th scope="col">${t('cus.col.status')}</th></tr></thead>
            <tbody>${slice.map(customerRow)}</tbody></table>
            <div class="table-footer"><span>${t('cus.footer', { shown: num(slice.length), total: `${num(list.length)}${more ? '+' : ''}` })}</span></div></div>${paginationHtml({ page: state.page, pages })}
          ${more ? html`<div class="cus-more"><button type="button" class="btn" data-action="more">${icon('plus', { size: 18 })}<span>${t('cus.loadMore', { n: num(PAGE_SIZE) })}</span></button></div>` : ''}`;
      };

      const newsletterResults = () => {
        const l = data.newsletter;
        if (!l) return spinnerBlock();
        if (!l.items.length) return emptyState({ icon: 'mail', title: t('cus.empty.newsletter'), text: t('cus.emptyText.newsletter') });
        const list = shownSubscribers();
        if (!list.length) return emptyState({ icon: 'search', title: t('cus.noMatch'), text: t('cus.noMatchText') });
        const pages = Math.max(1, Math.ceil(list.length / PAGE));
        state.page = Math.min(state.page, pages);
        const slice = list.slice((state.page - 1) * PAGE, state.page * PAGE);
        return html`${l.capped ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${t('cus.capped', { n: num(LIST_CAP) })}</div></div>` : ''}
          <div class="table-wrap"><table class="table table-stack table-cards cus-table" id="cus-table">
            <thead><tr><th scope="col">${t('cus.col.email')}</th><th scope="col">${t('cus.col.source')}</th><th scope="col">${t('cus.col.subscribed')}</th>${canWrite ? html`<th scope="col"><span class="sr-only">${t('common.actions')}</span></th>` : ''}</tr></thead>
            <tbody>${slice.map(subscriberRow)}</tbody></table>
            <div class="table-footer"><span>${t('cus.footer', { shown: num(slice.length), total: num(list.length) })}</span></div></div>${paginationHtml({ page: state.page, pages })}`;
      };

      const results = () => {
        if (state.error) return errorState({ text: state.error });
        return state.tab === 'newsletter' ? newsletterResults() : customersResults();
      };

      const tabsHtml = () => html`<div class="tabs cus-tabs" role="tablist" aria-label="${t('cus.tabs')}">${TABS.map((tab) => {
        const n = loaded(tab);
        const plus = tab === 'all' && data.all.more ? '+' : '';
        return html`<button type="button" class="tab" role="tab" id="cus-tab-${tab}" aria-selected="${state.tab === tab ? 'true' : 'false'}" tabindex="${state.tab === tab ? '0' : '-1'}" aria-controls="cus-results" data-action="tab" data-tab="${tab}">${t(`cus.tab.${tab}`)}${n === null ? '' : html`<span class="cus-n">${num(n)}${plus}</span>`}</button>`;
      })}</div>`;

      const paintResults = () => { render(ctx.el.querySelector('#cus-results'), results()); };
      const paintTabs = () => { render(ctx.el.querySelector('#cus-tabs-wrap'), tabsHtml()); };
      const actionsHtml = () => html`${canExport ? html`<button type="button" class="btn" data-action="export">${icon('download', { size: 18 })}<span>${t('cus.export')}</span></button>` : ''}
        <button type="button" class="btn" data-action="reload">${icon('refresh', { size: 18 })}<span>${t('common.refresh')}</span></button>`;
      const paint = () => render(ctx.el, html`<div class="cus">
        ${pageHead({ title: t('cus.title'), sub: t('cus.sub'), actions: actionsHtml() })}
        <div id="cus-tabs-wrap">${tabsHtml()}</div>
        <div class="toolbar" role="search">
          ${searchField({ id: 'q', value: state.q, placeholder: state.tab === 'newsletter' ? t('cus.searchNews') : t('cus.search'), label: state.tab === 'newsletter' ? t('cus.searchNews') : t('cus.search'), bind: 'q' })}
        </div>
        <div id="cus-results" role="tabpanel" aria-labelledby="cus-tab-${state.tab}">${results()}</div></div>`);
      paint();

      const open = async (tab, { focus = false } = {}) => {
        state.tab = tab; state.page = 1; state.error = null;
        paint();
        if (focus) ctx.el.querySelector(`#cus-tab-${tab}`)?.focus();
        if (tab !== 'all' && !data[tab]) {
          try { data[tab] = await (tab === 'restricted' ? loadRestricted() : loadSubscribers()); } catch (e) { reportError(e, 'customers.load'); if (state.tab === tab) state.error = explainError(e); }
        }
        if (ctx.signal.aborted || state.tab !== tab) return;
        paintTabs(); paintResults();
      };
      const reload = async () => {
        try {
          const [all, restricted, newsletter] = await Promise.all([loadCustomers(), data.restricted ? loadRestricted() : null, data.newsletter ? loadSubscribers() : null]);
          data.all = all; data.restricted = restricted; data.newsletter = newsletter; data.found = {};
          state.error = null;
        } catch (e) { reportError(e, 'customers.reload'); state.error = explainError(e); }
        if (!ctx.signal.aborted) paint();
      };

      // an exact e-mail / phone that is not among the loaded customers: ask the database for exactly that one
      const lookup = async () => {
        const kind = lookupKind(state.q);
        const key = searchKey();
        if (state.tab !== 'all' || !kind || !data.all.more || data.found[key] || shownCustomers().length) return;
        data.found[key] = 'loading';
        paintResults();
        try { data.found[key] = await findCustomers(kind); } catch (e) { delete data.found[key]; reportError(e, 'customers.find'); toastError(explainError(e)); }
        if (!ctx.signal.aborted) paintResults();
      };

      const more = async (btn) => {
        const r = await runAction(btn, () => loadCustomers({ after: data.all.last }), { quiet: true });
        if (!r.ok || ctx.signal.aborted) return;
        data.all = { items: [...data.all.items, ...r.value.items], last: r.value.last, more: r.value.more };
        paintTabs(); paintResults();
      };

      const unsub = async (el) => {
        const s = data.newsletter && data.newsletter.items.find((x) => x.id === el.dataset.id);
        if (!s) return;
        const yes = await confirmDialog({ title: t('cus.unsub.title'), message: t('cus.unsub.text', { email: s.email }), confirmText: t('cus.unsub.confirm'), danger: true });
        if (!yes) return;
        const r = await runAction(el, () => removeSubscriber(s.id), { ok: t('cus.unsub.done') });
        if (!r.ok || ctx.signal.aborted) return;
        data.newsletter = { ...data.newsletter, items: data.newsletter.items.filter((x) => x.id !== s.id) };
        paintTabs(); paintResults();
      };

      const doExport = async (btn) => {
        const newsletter = state.tab === 'newsletter';
        const list = newsletter ? (data.newsletter ? shownSubscribers() : []) : (data[state.tab === 'all' ? 'all' : 'restricted'] ? shownCustomers() : []);
        if (!list.length) { toast(t('cus.export.none')); return; }
        const kind = newsletter ? 'subscribers' : 'customers';
        const r = await runAction(btn, async () => {
          await auditExport(kind, list.length);                       // the record first, the file second
          const csv = newsletter ? subscribersCsv(list) : customersCsv(list);
          exportCsv(`${kind}-${state.tab}-${dhakaDayKey(Date.now())}.csv`, csv.headers, csv.rows);
        }, { ok: t('cus.export.done', { n: num(list.length) }) });
        if (!r.ok && !isRefusal(r.error)) reportError(r.error, 'customers.export');
      };

      const onKey = (e) => {
        const tab = e.target.closest && e.target.closest('[role="tab"]');
        if (!tab) return;
        const i = TABS.indexOf(tab.dataset.tab);
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        open(TABS[(to + TABS.length) % TABS.length], { focus: true });
      };
      ctx.el.addEventListener('keydown', onKey);
      ctx.cleanup(() => ctx.el.removeEventListener('keydown', onKey));

      ctx.cleanup(bindActions(ctx.el, {
        tab: (el) => { if (el.dataset.tab !== state.tab) open(el.dataset.tab, { focus: true }); },
        page: (el) => { state.page = Number(el.dataset.page) || 1; paintResults(); },
        more, unsub, reload,
        export: doExport,
        retry: () => open(state.tab),
      }, {
        input: { q: debounce((el) => { state.q = el.value; state.page = 1; paintResults(); lookup(); }, 200) },
      }));
    });
  },
};
