/*
 * Account → order history. One query (orders where userId == me); filtering and paging happen in the browser.
 */
import { html, render, bindActions } from '../../../core/dom.js';
import { registerBoth, t } from '../../../core/i18n.js';
import { skeletonRows, emptyState, errorState } from '../../../core/ui.js';
import { listMyOrders } from '../../../data/orders.js';
import { currentUid } from '../../../data/auth.js';
import { OPEN_STATUSES } from '../../../shared/constants.js';
import { orderRowHtml } from '../../components/orderParts.js';
import { num } from '../../../core/format.js';

registerBoth({
  'aor.title': ['My orders', 'আমার অর্ডার'],
  'aor.f.all': ['All', 'সব'],
  'aor.f.open': ['In progress', 'চলমান'],
  'aor.f.done': ['Delivered', 'ডেলিভারি হয়েছে'],
  'aor.f.closed': ['Cancelled / returned', 'বাতিল / ফেরত'],
  'aor.filters': ['Filter orders', 'অর্ডার ফিল্টার'],
  'aor.empty': ['No orders yet', 'এখনও কোনো অর্ডার নেই'],
  'aor.emptyText': ['When you place an order it will show up here.', 'অর্ডার করলে এখানে দেখা যাবে।'],
  'aor.emptyFilter': ['No orders in this view', 'এই তালিকায় কোনো অর্ডার নেই'],
  'aor.shop': ['Browse the shop', 'শপ দেখুন'],
  'aor.more': ['Show more', 'আরও দেখুন'],
  'aor.loadError': ['Your orders could not be loaded.', 'আপনার অর্ডার লোড করা যায়নি।'],
});

const PAGE = 10;
const FILTERS = {
  all: () => true,
  open: (o) => OPEN_STATUSES.includes(o.status),
  done: (o) => o.status === 'delivered',
  closed: (o) => ['cancelled', 'returned', 'refunded'].includes(o.status),
};

export default {
  async mount(ctx) {
    render(ctx.el, skeletonRows(4));
    let orders;
    try { orders = await listMyOrders(currentUid(), { limit: 100 }); } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(ctx.el, errorState({ text: t('aor.loadError') }));
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;

    const st = { filter: FILTERS[ctx.query.filter] ? ctx.query.filter : 'all', shown: PAGE };
    const paint = () => {
      const list = orders.filter(FILTERS[st.filter]);
      render(ctx.el, html`
        <h2 class="acc-h2">${t('aor.title')}</h2>
        ${orders.length ? html`<div class="chips" role="group" aria-label="${t('aor.filters')}">
          ${Object.keys(FILTERS).map((k) => html`<button type="button" class="chip" data-action="filter" data-f="${k}" aria-pressed="${st.filter === k ? 'true' : 'false'}">${t(`aor.f.${k}`)} <span class="muted">${num(orders.filter(FILTERS[k]).length)}</span></button>`)}
        </div>` : ''}
        ${!orders.length
    ? emptyState({ icon: 'package', title: t('aor.empty'), text: t('aor.emptyText'), action: { href: '/shop', label: t('aor.shop') } })
    : !list.length ? emptyState({ icon: 'package', title: t('aor.emptyFilter') })
      : html`<ul class="ord-list">${list.slice(0, st.shown).map(orderRowHtml)}</ul>
        ${list.length > st.shown ? html`<div class="acc-more"><button type="button" class="btn btn-secondary" data-action="more">${t('aor.more')}</button></div>` : ''}`}`);
    };
    paint();
    ctx.cleanup(bindActions(ctx.el, {
      filter: (b) => { st.filter = b.dataset.f; st.shown = PAGE; paint(); const a = ctx.el.querySelector(`[data-f="${st.filter}"]`); if (a) a.focus(); },
      more: () => { st.shown += PAGE; paint(); },
    }));
  },
};
