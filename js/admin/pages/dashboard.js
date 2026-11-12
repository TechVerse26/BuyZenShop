/*
 * Dashboard — everything on it is computed from live Firestore data (nothing is hard-coded):
 *   • "Needs attention": counters for work that is waiting (new orders, payments to verify, returns, refunds, tickets, reviews, stock)
 *   • sales / orders / average order / payment received for the chosen period, a sales chart and the top products
 *   • the latest orders
 * Each block appears only when the signed-in role may read the data behind it. Definitions of the numbers are in shared/stats.js.
 */
import { html, render, bindActions, aria } from '../../core/dom.js';
import { registerBoth, t, tn, pick } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { statusBadge, paymentBadge, emptyState, toastError } from '../../core/ui.js';
import { explainError } from '../../core/errors.js';
import { money, num, fmtDate, fmtShortDate, relTime } from '../../core/format.js';
import { local } from '../../core/storage.js';
import { can } from '../../data/auth.js';
import { fetchOrdersBetween, fetchRecentOrders } from '../../data/ordersAdmin.js';
import { summarize, buckets, topProducts, dhakaHour, dayStart } from '../../shared/stats.js';
import { barChart, bindChart, rankList } from '../lib/charts.js';
import { safeMount, pageHead, kpiCard } from '../lib/ui.js';
import { loadQueues, QUEUE_CAP } from '../data/queues.js';
import { NAV } from '../nav.js';

registerBoth({
  'dash.title': ['Overview', 'সারসংক্ষেপ'],
  'dash.sub': ['How the store is doing right now', 'স্টোর এখন কেমন চলছে'],
  'dash.range.today': ['Today', 'আজ'],
  'dash.range.week': ['7 days', '৭ দিন'],
  'dash.range.month': ['30 days', '৩০ দিন'],
  'dash.range.label': ['Period', 'সময়কাল'],
  'dash.refresh': ['Refresh', 'রিফ্রেশ'],
  'dash.attn': ['Needs attention', 'এখন দেখা দরকার'],
  'dash.attn.pending': ['New orders', 'নতুন অর্ডার'],
  'dash.attn.verify': ['Payments to verify', 'পেমেন্ট যাচাই বাকি'],
  'dash.attn.returns': ['Return requests', 'রিটার্নের অনুরোধ'],
  'dash.attn.refunds': ['Refunds to pay', 'রিফান্ড বাকি'],
  'dash.attn.tickets': ['Open tickets', 'খোলা টিকিট'],
  'dash.attn.reviews': ['Reviews to check', 'রিভিউ যাচাই বাকি'],
  'dash.attn.low': ['Low stock', 'স্টক কম'],
  'dash.attn.out': ['Out of stock', 'স্টক শেষ'],
  'dash.allClear': ['Nothing is waiting for you right now.', 'এই মুহূর্তে আপনার জন্য কিছু বাকি নেই।'],
  'dash.kpi.sales': ['Sales', 'বিক্রি'],
  'dash.kpi.salesSub_one': ['{n} order, confirmed or later', '{n}টি অর্ডার, নিশ্চিত বা তার পরের ধাপে'],
  'dash.kpi.salesSub_other': ['{n} orders, confirmed or later', '{n}টি অর্ডার, নিশ্চিত বা তার পরের ধাপে'],
  'dash.kpi.orders': ['Orders placed', 'অর্ডার এসেছে'],
  'dash.kpi.ordersSub': ['{n} cancelled', '{n}টি বাতিল'],
  'dash.kpi.aov': ['Average order', 'গড় অর্ডার'],
  'dash.kpi.aovSub': ['{n} units sold', '{n}টি পণ্য বিক্রি'],
  'dash.kpi.received': ['Payment received', 'পেমেন্ট পাওয়া গেছে'],
  'dash.kpi.receivedSub': ['Verified online + cash collected', 'যাচাইকৃত অনলাইন + আদায়কৃত নগদ'],
  'dash.chart.title': ['Sales', 'বিক্রি'],
  'dash.chart.hour': ['per hour', 'ঘণ্টা অনুযায়ী'],
  'dash.chart.day': ['per day', 'দিন অনুযায়ী'],
  'dash.chart.total': ['total {value}', 'মোট {value}'],
  'dash.chart.orders_one': ['{n} order', '{n}টি অর্ডার'],
  'dash.chart.orders_other': ['{n} orders', '{n}টি অর্ডার'],
  'dash.top': ['Top products', 'সেরা পণ্য'],
  'dash.top.sold': ['{n} sold', '{n}টি বিক্রি'],
  'dash.top.none': ['No sales in this period.', 'এই সময়ে কোনো বিক্রি নেই।'],
  'dash.basis': ['Sales count orders from Confirmed to Delivered. Cancelled, returned and refunded orders are left out.', '"নিশ্চিত" থেকে "ডেলিভারি হয়েছে" ধাপের অর্ডার বিক্রি হিসেবে গোনা হয়। বাতিল, ফেরত ও রিফান্ড হওয়া অর্ডার বাদ।'],
  'dash.truncated': ['This period has more orders than can be loaded at once, so the figures cover the latest {n} only. Pick a shorter period.', 'এই সময়ে এত অর্ডার যে একসাথে লোড হয়নি; সংখ্যাগুলো শুধু সর্বশেষ {n}টির। ছোট সময় বেছে নিন।'],
  'dash.recent': ['Latest orders', 'সর্বশেষ অর্ডার'],
  'dash.viewAll': ['View all', 'সব দেখুন'],
  'dash.col.order': ['Order', 'অর্ডার'],
  'dash.col.customer': ['Customer', 'কাস্টমার'],
  'dash.col.total': ['Total', 'মোট'],
  'dash.col.payment': ['Payment', 'পেমেন্ট'],
  'dash.col.status': ['Status', 'অবস্থা'],
  'dash.noOrders': ['No orders yet', 'এখনো কোনো অর্ডার নেই'],
  'dash.noOrdersText': ['New orders will appear here as soon as customers place them.', 'কাস্টমার অর্ডার করলেই এখানে দেখা যাবে।'],
  'dash.welcome': ['Welcome', 'স্বাগতম'],
  'dash.welcomeText': ['Open a section from the list below — it shows what your role can use.', 'নিচের তালিকা থেকে একটি অংশ খুলুন — এতে আপনার রোলে যা আছে তা-ই দেখাচ্ছে।'],
  'dash.loadFailed': ['Could not load this block.', 'এই অংশ লোড করা যায়নি।'],
});

const RANGES = { today: 1, week: 7, month: 30 };
const RANGE_KEY = 'sv.admin.dashRange';
const DAY = 86400000;

export default {
  async mount(ctx) {
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      const showOrders = can('orders.read');
      let range = local.get(RANGE_KEY, 'week');
      if (!RANGES[range]) range = 'week';
      let dispose = () => {};

      const windowFor = (r) => { const now = Date.now(); return { from: dayStart(now - (RANGES[r] - 1) * DAY), to: now }; };
      const loadRange = async (r) => { const w = windowFor(r); const res = await fetchOrdersBetween(w.from, w.to); return { ...res, ...w }; };

      let rangeData;
      const [queues, firstRange, recent] = await Promise.all([
        loadQueues(),
        showOrders ? loadRange(range) : Promise.resolve(null),
        showOrders ? fetchRecentOrders({ limit: 8 }).catch((e) => { console.warn('recent orders failed', e); return null; }) : Promise.resolve(null),
      ]);
      if (ctx.signal.aborted) return;
      rangeData = firstRange;

      /* ── needs attention ── */
      const tiles = [
        ['pending', 'dash.attn.pending', '/orders?status=pending', 'package'],
        ['verify', 'dash.attn.verify', '/orders?payment=awaiting_verification', 'wallet'],
        ['returns', 'dash.attn.returns', '/orders?status=return_requested', 'undo'],
        ['refunds', 'dash.attn.refunds', '/orders?status=refund_pending', 'credit-card'],
        ['tickets', 'dash.attn.tickets', '/support?status=open', 'message-circle'],
        ['reviews', 'dash.attn.reviews', '/reviews', 'star'],
        ['low', 'dash.attn.low', '/inventory?filter=low', 'alert-triangle'],
        ['out', 'dash.attn.out', '/inventory?filter=out', 'x-circle'],
      ].filter(([k]) => queues[k]);
      const waiting = tiles.some(([k]) => queues[k].n > 0);
      const attnHtml = () => tiles.length ? html`<section class="mt-section" aria-labelledby="dash-attn-h">
        <h2 class="mb-3" id="dash-attn-h" style="font-size:var(--fs-md)">${t('dash.attn')}</h2>
        <div class="attn-grid">${tiles.map(([k, label, to, ic]) => {
          const q = queues[k];
          return html`<a class="attn ${q.n > 0 ? 'is-hot' : 'is-zero'}" href="${href(to)}"><span class="attn-n">${num(q.n)}${q.capped ? '+' : ''}</span><span class="attn-l">${t(label)}</span></a>`;
        })}</div>
        ${waiting ? '' : html`<p class="muted small mt-3">${t('dash.allClear')}</p>`}
      </section>` : '';

      /* ── period block (kpis, chart, top products) ── */
      const periodHtml = (d) => {
        const s = summarize(d.orders);
        const hourly = range === 'today';
        const rows = buckets(d.orders, d.from, d.to, hourly ? 'hour' : 'day');
        const data = rows.map((b) => ({
          label: hourly ? `${num(dhakaHour(b.start))}` : fmtShortDate(b.start),
          value: b.sales,
          note: tn('dash.chart.orders', b.orders, { n: num(b.orders) }),
        }));
        const top = topProducts(d.orders, { limit: 5 });
        return html`
          ${d.truncated ? html`<p class="alert alert-warn mt-4">${icon('alert-triangle', { size: 18 })}<span>${t('dash.truncated', { n: num(d.orders.length) })}</span></p>` : ''}
          <div class="kpi-grid mt-4">
            ${kpiCard({ label: t('dash.kpi.sales'), value: money(s.sales), sub: tn('dash.kpi.salesSub', s.salesCount, { n: num(s.salesCount) }) })}
            ${kpiCard({ label: t('dash.kpi.orders'), value: num(s.count), sub: t('dash.kpi.ordersSub', { n: num(s.cancelled) }) })}
            ${kpiCard({ label: t('dash.kpi.aov'), value: money(s.aov), sub: t('dash.kpi.aovSub', { n: num(s.units) }) })}
            ${kpiCard({ label: t('dash.kpi.received'), value: money(s.received), sub: t('dash.kpi.receivedSub') })}
          </div>
          <div class="panel-grid mt-5">
            <section class="panel" aria-labelledby="dash-chart-h">
              <div class="panel-head"><h2 id="dash-chart-h">${t('dash.chart.title')} <span class="muted small">· ${hourly ? t('dash.chart.hour') : t('dash.chart.day')}</span></h2></div>
              <div class="panel-body">${barChart({ title: t('dash.chart.title'), data, format: money, summary: t('dash.chart.total', { value: money(s.sales) }) })}</div>
              <p class="panel-note">${t('dash.basis')}</p>
            </section>
            <section class="panel" aria-labelledby="dash-top-h">
              <div class="panel-head"><h2 id="dash-top-h">${t('dash.top')}</h2></div>
              <div class="panel-body">${top.length
                ? rankList({ items: top.map((p) => ({ label: p.name, value: p.revenue, sub: t('dash.top.sold', { n: num(p.qty) }) })), format: money })
                : html`<p class="muted">${t('dash.top.none')}</p>`}</div>
            </section>
          </div>`;
      };

      /* ── latest orders ── */
      const recentHtml = () => {
        if (!showOrders) return '';
        if (recent === null) return html`<section class="panel mt-section"><div class="panel-body"><p class="muted">${t('dash.loadFailed')}</p></div></section>`;
        return html`<section class="panel mt-section" aria-labelledby="dash-recent-h">
          <div class="panel-head"><h2 id="dash-recent-h">${t('dash.recent')}</h2><a class="btn btn-sm" href="${href('/orders')}">${t('dash.viewAll')}</a></div>
          ${recent.length ? html`<div class="table-wrap" style="border:0;border-radius:0"><table class="table">
            <thead><tr><th scope="col">${t('dash.col.order')}</th><th scope="col">${t('dash.col.customer')}</th><th scope="col" class="num">${t('dash.col.total')}</th><th scope="col">${t('dash.col.payment')}</th><th scope="col">${t('dash.col.status')}</th></tr></thead>
            <tbody>${recent.map((o) => html`<tr>
              <td><a class="mono strong" href="${href('/orders/' + encodeURIComponent(o.id))}">${o.orderNumber}</a><span class="cell-sub">${relTime(o.createdAtMs)}</span></td>
              <td>${o.customer.name || (o.address && o.address.name) || '—'}</td>
              <td class="num nowrap">${money(o.totals.total)}</td>
              <td>${paymentBadge(o.payment.status)}</td>
              <td>${statusBadge(o.status)}</td>
            </tr>`)}</tbody></table></div>`
            : html`<div class="panel-body">${emptyState({ icon: 'package', title: t('dash.noOrders'), text: t('dash.noOrdersText') })}</div>`}
        </section>`;
      };

      /* ── roles without order access get their own shortcuts ── */
      const quickHtml = () => {
        if (showOrders) return '';
        const groups = NAV.map((g) => ({ g, items: g.items.filter((i) => i.id !== 'dashboard' && (i.perm === null || i.perm === undefined || (Array.isArray(i.perm) ? i.perm.some(can) : can(i.perm)))) })).filter((x) => x.items.length);
        return html`<section class="panel mt-section"><div class="panel-head"><h2>${t('dash.welcome')}</h2></div><div class="panel-body">
          <p class="muted mb-4">${t('dash.welcomeText')}</p>
          <div class="attn-grid">${groups.flatMap((x) => x.items).map((i) => html`<a class="attn" href="${href(i.path)}"><span class="attn-n">${icon(i.icon)}</span><span class="attn-l">${pick(...i.label)}</span></a>`)}</div>
        </div></section>`;
      };

      const rangeChips = () => html`<div class="range-chips" role="group" aria-label="${t('dash.range.label')}">${Object.keys(RANGES).map((r) => html`<button type="button" class="chip" data-action="range" data-range="${r}" aria-pressed="${aria(r === range)}">${t('dash.range.' + r)}</button>`)}</div>`;

      const paint = () => {
        render(ctx.el, html`<div class="dash">
          ${pageHead({ title: t('dash.title'), sub: `${fmtDate(Date.now())} · ${t('dash.sub')}`, actions: html`${showOrders ? rangeChips() : ''}<button type="button" class="btn btn-sm" data-action="refresh">${icon('refresh', { size: 16 })}<span>${t('dash.refresh')}</span></button>` })}
          ${attnHtml()}
          ${showOrders && rangeData ? html`<div id="dash-period">${periodHtml(rangeData)}</div>` : ''}
          ${recentHtml()}
          ${quickHtml()}
        </div>`);
        dispose();
        dispose = bindChart(ctx.el);
      };
      ctx.cleanup(() => dispose());
      paint();

      ctx.cleanup(bindActions(ctx.el, {
        range: async (el) => {
          const next = el.dataset.range;
          if (!RANGES[next] || next === range) return;
          range = next; local.set(RANGE_KEY, range);
          ctx.el.querySelectorAll('[data-action="range"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.range === range ? 'true' : 'false'));
          const host = ctx.el.querySelector('#dash-period');
          if (host) host.setAttribute('aria-busy', 'true');
          try { rangeData = await loadRange(range); } catch (e) { console.error(e); toastError(explainError(e)); if (host) host.removeAttribute('aria-busy'); return; }
          if (ctx.signal.aborted) return;
          paint();
        },
        refresh: () => ctx.router.reload(),
      }));
    });
  },
};
