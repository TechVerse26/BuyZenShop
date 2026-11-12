/*
 * Support — the queue of customer requests. Permission: support.read (Super Admin, Store Admin, Order Manager, Customer Support);
 * answering (on the request page) needs support.reply.
 *
 *   Open      waiting for the team — urgent first, then whoever has waited longest      Answered   the team replied
 *   Closed    done                                                                       Search: subject, first message, name, e-mail, phone, ticket or order number
 * One equality query per status (first 200), loaded when the tab is opened; search and the priority filter work on what is loaded.
 * Rules of the game: shared/supportFlow.js.
 */
import { html, render, bindActions, raw, debounce } from '../../core/dom.js';
import { registerBoth, t, lbl } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, errorState, spinnerBlock, paginationHtml, loadCss } from '../../core/ui.js';
import { explainError, reportError } from '../../core/errors.js';
import { num, fmtDateTime, relTime } from '../../core/format.js';
import { TICKET_PRIORITY, TICKET_PRIORITY_IDS } from '../../shared/constants.js';
import { filterTickets, orderTickets } from '../../shared/supportFlow.js';
import { safeMount, pageHead, needs, searchField, priorityBadge } from '../lib/ui.js';
import { loadTicketList, LIST_CAP } from '../data/tickets.js';

registerBoth({
  'tkm.title': ['Support', 'সাপোর্ট'],
  'tkm.sub': ['Questions from customers. Answer the open ones first — the urgent ones and the ones that have waited longest are at the top.', 'ক্রেতাদের প্রশ্ন। খোলা অনুরোধগুলো আগে সামলান — জরুরি আর সবচেয়ে বেশি সময় অপেক্ষায় থাকা অনুরোধ উপরে।'],
  'tkm.tabs': ['Request lists', 'অনুরোধের তালিকা'],
  'tkm.tab.open': ['Open', 'খোলা'],
  'tkm.tab.answered': ['Answered', 'উত্তর দেওয়া'],
  'tkm.tab.closed': ['Closed', 'বন্ধ'],
  'tkm.search': ['Search subject, customer, e-mail, phone or order', 'বিষয়, ক্রেতা, ইমেইল, ফোন বা অর্ডার খুঁজুন'],
  'tkm.f.priority': ['Priority', 'প্রায়োরিটি'],
  'tkm.f.allPriorities': ['All priorities', 'সব প্রায়োরিটি'],
  'tkm.col.request': ['Request', 'অনুরোধ'],
  'tkm.col.customer': ['Customer', 'ক্রেতা'],
  'tkm.col.priority': ['Priority', 'প্রায়োরিটি'],
  'tkm.col.activity': ['Last activity', 'শেষ কার্যকলাপ'],
  'tkm.order': ['Order', 'অর্ডার'],
  'tkm.empty.open': ['No open requests', 'কোনো খোলা অনুরোধ নেই'],
  'tkm.emptyText.open': ['Every request has been answered.', 'সব অনুরোধের উত্তর দেওয়া হয়েছে।'],
  'tkm.empty.answered': ['Nothing answered yet', 'এখনও কোনো উত্তর দেওয়া অনুরোধ নেই'],
  'tkm.emptyText.answered': ['Requests you have replied to wait here for the customer.', 'আপনি যেগুলোর উত্তর দিয়েছেন সেগুলো ক্রেতার জবাবের অপেক্ষায় এখানে থাকে।'],
  'tkm.empty.closed': ['No closed requests', 'কোনো বন্ধ অনুরোধ নেই'],
  'tkm.emptyText.closed': ['Closed requests are kept here.', 'বন্ধ করা অনুরোধ এখানে থাকে।'],
  'tkm.noMatch': ['Nothing matches', 'কিছুই মেলেনি'],
  'tkm.noMatchText': ['Change the search or the filter.', 'সার্চ বা ফিল্টার বদলান।'],
  'tkm.capped': ['Only the first {n} requests of this list are loaded. Work through them, then reload for the rest.', 'এই তালিকার প্রথম {n}টি অনুরোধ লোড হয়েছে। এগুলো শেষ করে বাকিগুলোর জন্য রিলোড করুন।'],
  'tkm.footer': ['Showing {shown} of {total}', '{total}টির মধ্যে {shown}টি দেখানো হচ্ছে'],
});

const TABS = ['open', 'answered', 'closed'];
const TAB_ICON = { open: 'inbox', answered: 'message-circle', closed: 'check-circle' };
const PAGE = 25;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'support.read')) return;
    await loadCss('/css/pages/admin-support.css');
    await safeMount(ctx, async () => {
      const first = await loadTicketList('open');
      if (ctx.signal.aborted) return;
      const href = (p) => ctx.router.href(p);
      const lists = { open: first, answered: null, closed: null };
      const state = { tab: 'open', q: '', priority: '', page: 1, error: null };

      const visible = () => orderTickets(filterTickets(lists[state.tab].items, { q: state.q, priority: state.priority }), state.tab);

      const row = (k) => html`<tr>
        <td class="cell-first"><div class="cell-main"><div>
          <a class="t tkm-subject" href="${href('/support/' + encodeURIComponent(k.id))}">${k.subject}</a>
          <div class="s"><span class="mono">${k.id}</span>${k.orderNumber ? html` · ${t('tkm.order')} <span class="mono">${k.orderNumber}</span>` : ''}</div>
        </div></div></td>
        <td data-label="${t('tkm.col.customer')}"><div class="tkm-cell"><span>${k.name}</span><span class="tkm-sub">${k.email || k.phone}</span>${k.userId ? '' : badge(t('tkm.guest'), 'neutral')}</div></td>
        <td data-label="${t('tkm.col.priority')}">${priorityBadge(k.priority)}</td>
        <td data-label="${t('tkm.col.activity')}"><span title="${fmtDateTime(k.updatedMs)}">${relTime(k.updatedMs)}</span></td>
      </tr>`;

      const results = () => {
        if (state.error) return errorState({ text: state.error });
        const l = lists[state.tab];
        if (!l) return spinnerBlock();
        if (!l.items.length) return emptyState({ icon: TAB_ICON[state.tab], title: t(`tkm.empty.${state.tab}`), text: t(`tkm.emptyText.${state.tab}`) });
        const list = visible();
        if (!list.length) return emptyState({ icon: 'search', title: t('tkm.noMatch'), text: t('tkm.noMatchText') });
        const pages = Math.max(1, Math.ceil(list.length / PAGE));
        state.page = Math.min(state.page, pages);
        const slice = list.slice((state.page - 1) * PAGE, state.page * PAGE);
        return html`${l.capped ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${t('tkm.capped', { n: num(LIST_CAP) })}</div></div>` : ''}
          <div class="table-wrap"><table class="table table-stack table-cards tkm-table" id="tkm-table">
            <thead><tr><th scope="col">${t('tkm.col.request')}</th><th scope="col">${t('tkm.col.customer')}</th><th scope="col">${t('tkm.col.priority')}</th><th scope="col">${t('tkm.col.activity')}</th></tr></thead>
            <tbody>${slice.map(row)}</tbody></table>
            <div class="table-footer"><span>${t('tkm.footer', { shown: num(slice.length), total: num(list.length) })}</span></div></div>${paginationHtml({ page: state.page, pages })}`;
      };

      const tabsHtml = () => html`<div class="tabs tkm-tabs" role="tablist" aria-label="${t('tkm.tabs')}">${TABS.map((tab) => {
        const l = lists[tab];
        const more = l && l.capped ? '+' : '';
        return html`<button type="button" class="tab" role="tab" id="tkm-tab-${tab}" aria-selected="${state.tab === tab ? 'true' : 'false'}" tabindex="${state.tab === tab ? '0' : '-1'}" aria-controls="tkm-results" data-action="tab" data-tab="${tab}">${t(`tkm.tab.${tab}`)}${l ? html`<span class="tkm-n">${num(l.items.length)}${more}</span>` : ''}</button>`;
      })}</div>`;

      const paintResults = () => { render(ctx.el.querySelector('#tkm-results'), results()); };
      const paintTabs = () => { render(ctx.el.querySelector('#tkm-tabs-wrap'), tabsHtml()); };
      const paint = () => render(ctx.el, html`
        ${pageHead({ title: t('tkm.title'), sub: t('tkm.sub'), actions: html`<button type="button" class="btn" data-action="reload">${icon('refresh', { size: 18 })}<span>${t('common.refresh')}</span></button>` })}
        <div id="tkm-tabs-wrap">${tabsHtml()}</div>
        <div class="toolbar" role="search">
          ${searchField({ id: 'q', value: state.q, placeholder: t('tkm.search'), label: t('tkm.search'), bind: 'q' })}
          <select class="select" id="tkm-priority" data-change="priority" aria-label="${t('tkm.f.priority')}"><option value="">${t('tkm.f.allPriorities')}</option>${TICKET_PRIORITY_IDS.map((p) => html`<option value="${p}" ${state.priority === p ? raw('selected') : ''}>${lbl(TICKET_PRIORITY[p])}</option>`)}</select>
        </div>
        <div id="tkm-results" role="tabpanel" aria-labelledby="tkm-tab-${state.tab}">${results()}</div>`);
      paint();

      const open = async (tab, { focus = false } = {}) => {
        state.tab = tab; state.page = 1; state.error = null;
        paint();
        if (focus) ctx.el.querySelector(`#tkm-tab-${tab}`)?.focus();
        if (!lists[tab]) {
          try { lists[tab] = await loadTicketList(tab); } catch (e) { reportError(e, 'support.load'); if (state.tab === tab) state.error = explainError(e); }
        }
        if (ctx.signal.aborted || state.tab !== tab) return;
        paintTabs(); paintResults();
      };
      const reload = async () => {
        const loaded = TABS.filter((k) => lists[k]);
        try {
          const fresh = await Promise.all(loaded.map((k) => loadTicketList(k)));
          loaded.forEach((k, i) => { lists[k] = fresh[i]; });
          state.error = null;
        } catch (e) { reportError(e, 'support.reload'); state.error = explainError(e); }
        paint();
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
        reload,
        retry: () => open(state.tab),
      }, {
        input: { q: debounce((el) => { state.q = el.value; state.page = 1; paintResults(); }, 200) },
        change: { priority: (el) => { state.priority = el.value; state.page = 1; paintResults(); } },
      }));
    });
  },
};
