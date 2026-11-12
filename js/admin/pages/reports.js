/*
 * Reports. Permission: reports.read (Super Admin, Store Admin, Reporting). Exporting a sheet needs reports.export as well.
 *
 * Everything is computed in the browser from the live orders of the chosen period and of the period of equal length before it (shared/reportFlow.js): nothing is stored,
 * nothing is invented. The page says what a number means (the "How the numbers are counted" note), says when a period had more orders than can be loaded, and never
 * hands over a CSV of an incomplete period. A sheet carries customer names and phones only for roles that may read customers; every export is written to the audit log first.
 */
import { html, render, bindActions, aria } from '../../core/dom.js';
import { registerBoth, t, tn, pick } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { emptyState, errorState, spinnerBlock, fieldHtml, toast, toastError, openMenu, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { money, num, fmtDate, fmtShortDate, fmtMonth } from '../../core/format.js';
import { local } from '../../core/storage.js';
import { can } from '../../data/auth.js';
import { LIMITS, ORDER_STATUS, PAYMENT_METHODS, PAYMENT_STATUS } from '../../shared/constants.js';
import { dhakaHour } from '../../shared/stats.js';
import { PRESETS, resolveRange, buildReport, exportSheet } from '../../shared/reportFlow.js';
import { barChart, bindChart, rankList } from '../lib/charts.js';
import { safeMount, pageHead, needs, kpiCard, exportCsv } from '../lib/ui.js';
import { loadReportData, recordExport } from '../data/reports.js';

registerBoth({
  'rpt.title': ['Reports', 'রিপোর্ট'],
  'rpt.sub': ['Sales, orders and products for the period you choose, compared with the period right before it.', 'আপনার বেছে নেওয়া সময়ের বিক্রয়, অর্ডার ও প্রোডাক্ট — ঠিক আগের সময়ের সাথে তুলনাসহ।'],
  'rpt.range.label': ['Period', 'সময়কাল'],
  'rpt.range.today': ['Today', 'আজ'], 'rpt.range.7d': ['7 days', '৭ দিন'], 'rpt.range.30d': ['30 days', '৩০ দিন'],
  'rpt.range.month': ['This month', 'এই মাস'], 'rpt.range.lastMonth': ['Last month', 'গত মাস'], 'rpt.range.custom': ['Custom', 'নিজের মতো'],
  'rpt.refresh': ['Refresh', 'রিফ্রেশ'],
  'rpt.custom.from': ['From', 'শুরু'], 'rpt.custom.to': ['To', 'শেষ'], 'rpt.custom.apply': ['Show report', 'রিপোর্ট দেখান'],
  'rpt.err.from': ['Enter a valid start date.', 'শুরুর তারিখ সঠিকভাবে দিন।'],
  'rpt.err.to': ['Enter a valid end date.', 'শেষের তারিখ সঠিকভাবে দিন।'],
  'rpt.err.order': ['The end date is before the start date.', 'শেষের তারিখ শুরুর তারিখের আগে।'],
  'rpt.err.too_long': ['The period can be at most one year (366 days).', 'সময়কাল সর্বোচ্চ এক বছর (৩৬৬ দিন) হতে পারে।'],
  'rpt.period': ['{from} – {to}', '{from} – {to}'],
  'rpt.compared': ['Compared with {from} – {to}', 'তুলনা: {from} – {to}'],
  'rpt.kpi.sales': ['Sales', 'বিক্রয়'], 'rpt.kpi.orders': ['Orders', 'অর্ডার'], 'rpt.kpi.aov': ['Average order', 'গড় অর্ডার'], 'rpt.kpi.units': ['Units sold', 'বিক্রীত পণ্য'],
  'rpt.kpi.received': ['Payment received', 'প্রাপ্ত পেমেন্ট'], 'rpt.kpi.customers': ['Customers', 'ক্রেতা'], 'rpt.kpi.cancel': ['Cancel rate', 'বাতিলের হার'], 'rpt.kpi.discount': ['Discounts given', 'দেওয়া ছাড়'],
  'rpt.kpi.sales_one': ['from {n} order', '{n}টি অর্ডার থেকে'], 'rpt.kpi.sales_other': ['from {n} orders', '{n}টি অর্ডার থেকে'],
  'rpt.kpi.ordersSub': ['all statuses', 'সব স্ট্যাটাস'], 'rpt.kpi.aovSub': ['per counted order', 'প্রতি গণনাযোগ্য অর্ডারে'], 'rpt.kpi.unitsSub': ['in counted orders', 'গণনাযোগ্য অর্ডারে'],
  'rpt.kpi.receivedSub': ['verified or collected', 'যাচাই বা সংগ্রহ হয়েছে'], 'rpt.kpi.customersSub': ['placed an order', 'অর্ডার করেছেন'],
  'rpt.kpi.cancelSub_one': ['{n} cancelled order', '{n}টি বাতিল অর্ডার'], 'rpt.kpi.cancelSub_other': ['{n} cancelled orders', '{n}টি বাতিল অর্ডার'],
  'rpt.kpi.discountSub': ['on counted orders', 'গণনাযোগ্য অর্ডারে'],
  'rpt.delta.up': ['Up {v} compared with the previous period', 'আগের সময়ের চেয়ে {v} বেশি'],
  'rpt.delta.down': ['Down {v} compared with the previous period', 'আগের সময়ের চেয়ে {v} কম'],
  'rpt.delta.flat': ['No change compared with the previous period', 'আগের সময়ের মতোই'],
  'rpt.delta.new': ['Nothing to compare with in the previous period', 'আগের সময়ে তুলনার মতো কিছু নেই'],
  'rpt.noPrev': ['The period before had no orders, so there is nothing to compare with.', 'আগের সময়ে কোনো অর্ডার ছিল না, তাই তুলনা করা যাচ্ছে না।'],
  'rpt.delta.points': ['{v} points', '{v} পয়েন্ট'],
  'rpt.sales.title': ['Sales over time', 'সময় অনুযায়ী বিক্রয়'],
  'rpt.unit.hour': ['per hour', 'ঘণ্টা অনুযায়ী'], 'rpt.unit.day': ['per day', 'দিন অনুযায়ী'], 'rpt.unit.week': ['per week (7 days)', 'সপ্তাহ অনুযায়ী (৭ দিন)'], 'rpt.unit.month': ['per month', 'মাস অনুযায়ী'],
  'rpt.chart.total': ['{value} in total', 'মোট {value}'],
  'rpt.chart.orders_one': ['{n} order', '{n}টি অর্ডার'], 'rpt.chart.orders_other': ['{n} orders', '{n}টি অর্ডার'],
  'rpt.status.title': ['Orders by status', 'স্ট্যাটাস অনুযায়ী অর্ডার'],
  'rpt.status.sales': ['{value} in sales', 'বিক্রয় {value}'],
  'rpt.pay.title': ['Payments', 'পেমেন্ট'], 'rpt.pay.method': ['Method', 'মাধ্যম'], 'rpt.pay.orders': ['Orders', 'অর্ডার'], 'rpt.pay.sales': ['Sales', 'বিক্রয়'], 'rpt.pay.received': ['Received', 'প্রাপ্ত'],
  'rpt.pay.states': ['Payment states (cancelled orders left out)', 'পেমেন্টের অবস্থা (বাতিল অর্ডার বাদে)'],
  'rpt.prod.title': ['Top products', 'সেরা প্রোডাক্ট'], 'rpt.prod.bySales': ['By sales', 'বিক্রয় অনুযায়ী'], 'rpt.prod.byUnits': ['By units', 'সংখ্যা অনুযায়ী'],
  'rpt.prod.units': ['{n} sold', '{n}টি বিক্রি'], 'rpt.prod.sales': ['{value} in sales', 'বিক্রয় {value}'], 'rpt.prod.none': ['No product was sold in this period.', 'এই সময়ে কোনো প্রোডাক্ট বিক্রি হয়নি।'],
  'rpt.cat.title': ['Top categories', 'সেরা ক্যাটাগরি'], 'rpt.cat.none': ['Uncategorised', 'ক্যাটাগরিহীন'],
  'rpt.geo.title': ['Where orders go', 'অর্ডার কোথায় যায়'],
  'rpt.geo.orders_one': ['{n} order', '{n}টি অর্ডার'], 'rpt.geo.orders_other': ['{n} orders', '{n}টি অর্ডার'],
  'rpt.hours.title': ['Orders by hour of day (Bangladesh time)', 'দিনের ঘণ্টা অনুযায়ী অর্ডার (বাংলাদেশ সময়)'],
  'rpt.coupon.title': ['Coupons used', 'ব্যবহৃত কুপন'], 'rpt.coupon.code': ['Code', 'কোড'], 'rpt.coupon.orders': ['Orders', 'অর্ডার'], 'rpt.coupon.discount': ['Discount given', 'দেওয়া ছাড়'],
  'rpt.cust.title': ['Top customers', 'সেরা ক্রেতা'], 'rpt.cust.name': ['Customer', 'ক্রেতা'], 'rpt.cust.orders': ['Orders', 'অর্ডার'], 'rpt.cust.sales': ['Sales', 'বিক্রয়'], 'rpt.cust.anon': ['Customer', 'ক্রেতা'],
  'rpt.empty': ['No orders in this period', 'এই সময়ে কোনো অর্ডার নেই'],
  'rpt.emptyText': ['Choose a longer period, or come back after the first orders arrive.', 'দীর্ঘ সময় বেছে নিন, অথবা প্রথম অর্ডার আসার পর আবার দেখুন।'],
  'rpt.truncated': ['This period has more than {n} orders, so the report only covers the newest {n}. Choose a shorter period for exact numbers.', 'এই সময়ে {n}টির বেশি অর্ডার, তাই রিপোর্টে শুধু নতুন {n}টি আছে। সঠিক সংখ্যার জন্য ছোট সময় বেছে নিন।'],
  'rpt.truncatedPrev': ['The period before it has more than {n} orders, so the comparison is approximate.', 'তার আগের সময়ে {n}টির বেশি অর্ডার, তাই তুলনা আনুমানিক।'],
  'rpt.export': ['Export', 'এক্সপোর্ট'],
  'rpt.export.orders': ['Orders (CSV)', 'অর্ডার (CSV)'], 'rpt.export.daily': ['Sales by day (CSV)', 'দিন অনুযায়ী বিক্রয় (CSV)'], 'rpt.export.products': ['Products sold (CSV)', 'বিক্রীত প্রোডাক্ট (CSV)'],
  'rpt.export.done': ['{n} rows exported', '{n}টি সারি এক্সপোর্ট হয়েছে'],
  'rpt.export.empty': ['There is nothing to export for this period.', 'এই সময়ের জন্য এক্সপোর্ট করার মতো কিছু নেই।'],
  'rpt.export.truncated': ['This period has too many orders for a complete file. Choose a shorter period.', 'এই সময়ে সম্পূর্ণ ফাইলের জন্য অর্ডার অনেক বেশি। ছোট সময় বেছে নিন।'],
  'rpt.defs.title': ['How the numbers are counted', 'সংখ্যাগুলো কীভাবে গণনা হয়'],
  'rpt.defs.sales': ['Sales = the totals of orders that are confirmed, being prepared, packed, shipped or delivered. Pending, cancelled, returned and refunded orders are not sales.', 'বিক্রয় = নিশ্চিত, প্রস্তুত হচ্ছে, প্যাক, পাঠানো বা ডেলিভারি হওয়া অর্ডারের মোট। অপেক্ষমাণ, বাতিল, ফেরত ও রিফান্ড হওয়া অর্ডার বিক্রয় নয়।'],
  'rpt.defs.orders': ['Orders = every order placed in the period, whatever its status.', 'অর্ডার = এই সময়ে দেওয়া সব অর্ডার, যে স্ট্যাটাসেই থাকুক।'],
  'rpt.defs.received': ['Payment received = the part of sales whose payment is verified or collected.', 'প্রাপ্ত পেমেন্ট = বিক্রয়ের যে অংশের পেমেন্ট যাচাই বা সংগ্রহ হয়েছে।'],
  'rpt.defs.customers': ['Customers = different signed-in customers who placed an order.', 'ক্রেতা = যেসব আলাদা সাইন-ইন করা ক্রেতা অর্ডার করেছেন।'],
  'rpt.defs.days': ['Days are Bangladesh days. The comparison uses the period of the same length that ends the moment this one starts.', 'দিন মানে বাংলাদেশের দিন। তুলনায় ঠিক আগের সমান দৈর্ঘ্যের সময় ধরা হয়।'],
  'rpt.defs.cost': ['Product costs and profit are not part of these reports.', 'প্রোডাক্টের খরচ ও লাভ এই রিপোর্টে নেই।'],
  'rpt.defs.audit': ['Every export is recorded in the audit log.', 'প্রতিটি এক্সপোর্ট অডিট-লগে লেখা থাকে।'],
});

const KEY = 'sv.admin.reportRange';
const MAX = LIMITS.REPORT_MAX_ORDERS;
const statusName = (id) => (ORDER_STATUS[id] ? pick(ORDER_STATUS[id].label, ORDER_STATUS[id].bn) : id);
const methodName = (id) => (PAYMENT_METHODS[id] ? pick(PAYMENT_METHODS[id].label, PAYMENT_METHODS[id].bn) : id);
const payName = (id) => (PAYMENT_STATUS[id] ? pick(PAYMENT_STATUS[id].label, PAYMENT_STATUS[id].bn) : id);
const rate = (v) => `${Number.isInteger(v) ? num(v) : num(v, { decimals: 1 })}%`;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'reports.read')) return;
    await loadCss('/css/pages/admin-reports.css');
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      const canExport = can('reports.export');
      const canCustomers = can('customers.read');
      let preset = local.get(KEY, '30d');
      if (!PRESETS.includes(preset) || preset === 'custom') preset = '30d';
      let custom = { from: '', to: '' };
      let range = null;
      let st = { loading: true, error: '', data: null, report: null };
      let prodBy = 'revenue';
      let seq = 0;                                                   // an answer for an older choice is ignored
      let disposeChart = () => {};

      /* ───────── blocks ───────── */
      const delta = (k, { points = false, lowerIsBetter = false } = {}) => {
        if (!st.data) return '';
        const none = k.pct === null && !points;
        const flat = points ? k.delta === 0 : (k.pct === 0 || k.delta === 0);
        if (none) return html`<span class="rpt-delta is-none" data-dir="none"><span class="sr-only">${t('rpt.delta.new')}</span></span>`;
        if (flat) return html`<span class="rpt-delta is-flat" data-dir="flat">${icon('minus', { size: 14 })}<span class="sr-only">${t('rpt.delta.flat')}</span></span>`;
        const up = k.delta > 0;
        const good = lowerIsBetter ? !up : up;
        const v = points ? t('rpt.delta.points', { v: num(Math.abs(k.delta), { decimals: 1 }) }) : `${num(Math.abs(k.pct), { decimals: Number.isInteger(Math.abs(k.pct)) ? 0 : 1 })}%`;
        return html`<span class="rpt-delta ${good ? 'is-good' : 'is-bad'}" data-dir="${up ? 'up' : 'down'}">${icon(up ? 'arrow-up' : 'arrow-down', { size: 14 })}<span aria-hidden="true">${v}</span><span class="sr-only">${t(up ? 'rpt.delta.up' : 'rpt.delta.down', { v })}</span></span>`;
      };
      const kpi = (label, value, sub, k, o) => kpiCard({ label, value, sub: html`<span class="rpt-sub">${sub}</span> ${k ? delta(k, o) : ''}` });

      const bucketLabel = (unit, b) => (unit === 'hour' ? num(dhakaHour(b.start)) : unit === 'month' ? fmtMonth(b.start) : fmtShortDate(b.start));
      const salesChart = (r) => {
        const unit = r.series.unit;
        const data = r.series.rows.map((b) => ({
          label: bucketLabel(unit, b),
          value: b.sales,
          note: `${unit === 'week' ? `${fmtShortDate(b.start)} – ${fmtShortDate(b.end)} · ` : unit === 'hour' ? `${num(dhakaHour(b.start))}:00 · ` : ''}${tn('rpt.chart.orders', b.orders, { n: num(b.orders) })}`,
        }));
        return barChart({ title: t('rpt.sales.title'), data, format: money, summary: t('rpt.chart.total', { value: money(r.kpis.sales.value) }) });
      };

      const productsPanel = (r) => {
        const rows = prodBy === 'revenue' ? r.products.byRevenue : r.products.byQty;
        const items = rows.map((p) => (prodBy === 'revenue'
          ? { label: p.name, value: p.revenue, sub: t('rpt.prod.units', { n: num(p.qty) }) }
          : { label: p.name, value: p.qty, sub: t('rpt.prod.sales', { value: money(p.revenue) }) }));
        return html`<section class="panel" id="rpt-products" aria-labelledby="rpt-products-h">
          <div class="panel-head"><h2 id="rpt-products-h">${t('rpt.prod.title')}</h2>
            <div class="tabs rpt-tabs" role="group" aria-label="${t('rpt.prod.title')}">
              <button type="button" class="tab" data-action="prodBy" data-by="revenue" aria-pressed="${aria(prodBy === 'revenue')}">${t('rpt.prod.bySales')}</button>
              <button type="button" class="tab" data-action="prodBy" data-by="qty" aria-pressed="${aria(prodBy === 'qty')}">${t('rpt.prod.byUnits')}</button>
            </div></div>
          <div class="panel-body">${items.length ? rankList({ items, format: prodBy === 'revenue' ? money : num }) : html`<p class="muted">${t('rpt.prod.none')}</p>`}</div></section>`;
      };

      const reportHtml = (r) => {
        const k = r.kpis;
        const d = st.data;
        const alerts = html`${d.truncated ? html`<div class="alert alert-warn" role="alert">${icon('alert-triangle', { size: 18 })}<div>${t('rpt.truncated', { n: num(MAX) })}</div></div>` : ''}
          ${d.prevTruncated && !d.truncated ? html`<div class="alert alert-info" role="note">${icon('info', { size: 18 })}<div>${t('rpt.truncatedPrev', { n: num(MAX) })}</div></div>` : ''}`;
        if (r.empty) return html`${alerts}${emptyState({ icon: 'bar-chart', title: t('rpt.empty'), text: t('rpt.emptyText') })}`;
        return html`${alerts}
          <div class="kpi-grid rpt-kpis" id="rpt-kpis">
            ${kpi(t('rpt.kpi.sales'), money(k.sales.value), tn('rpt.kpi.sales', k.sales.count, { n: num(k.sales.count) }), k.sales)}
            ${kpi(t('rpt.kpi.orders'), num(k.orders.value), t('rpt.kpi.ordersSub'), k.orders)}
            ${kpi(t('rpt.kpi.aov'), money(k.aov.value), t('rpt.kpi.aovSub'), k.aov)}
            ${kpi(t('rpt.kpi.units'), num(k.units.value), t('rpt.kpi.unitsSub'), k.units)}
            ${kpi(t('rpt.kpi.received'), money(k.received.value), t('rpt.kpi.receivedSub'), k.received)}
            ${kpi(t('rpt.kpi.customers'), num(k.customers.value), t('rpt.kpi.customersSub'), k.customers)}
            ${kpi(t('rpt.kpi.cancel'), rate(k.cancelRate.value), tn('rpt.kpi.cancelSub', r.byStatus.find((s) => s.status === 'cancelled')?.count || 0, { n: num(r.byStatus.find((s) => s.status === 'cancelled')?.count || 0) }), k.cancelRate, { points: true, lowerIsBetter: true })}
            ${kpi(t('rpt.kpi.discount'), money(k.discount.value), t('rpt.kpi.discountSub'), null)}
          </div>
          <div class="rpt-grid">
            <section class="panel rpt-wide" aria-labelledby="rpt-sales-h"><div class="panel-head"><h2 id="rpt-sales-h">${t('rpt.sales.title')} <span class="muted small">· ${t(`rpt.unit.${r.series.unit}`)}</span></h2></div>
              <div class="panel-body" id="rpt-sales">${salesChart(r)}</div></section>

            <section class="panel" id="rpt-status" aria-labelledby="rpt-status-h"><div class="panel-head"><h2 id="rpt-status-h">${t('rpt.status.title')}</h2></div>
              <div class="panel-body">${rankList({ items: r.byStatus.map((s) => ({ label: statusName(s.status), value: s.count, sub: s.sales > 0 ? t('rpt.status.sales', { value: money(s.sales) }) : '' })), format: num })}</div></section>

            <section class="panel" id="rpt-pay" aria-labelledby="rpt-pay-h"><div class="panel-head"><h2 id="rpt-pay-h">${t('rpt.pay.title')}</h2></div>
              <div class="panel-body stack">
                <div class="table-wrap"><table class="table table-compact rpt-table">
                  <thead><tr><th scope="col">${t('rpt.pay.method')}</th><th scope="col" class="num">${t('rpt.pay.orders')}</th><th scope="col" class="num">${t('rpt.pay.sales')}</th><th scope="col" class="num">${t('rpt.pay.received')}</th></tr></thead>
                  <tbody>${r.methods.map((m) => html`<tr><th scope="row">${methodName(m.method)}</th><td class="num">${num(m.count)}</td><td class="num">${money(m.sales)}</td><td class="num">${money(m.received)}</td></tr>`)}</tbody></table></div>
                <div><div class="rpt-subhead">${t('rpt.pay.states')}</div>
                  <ul class="rpt-states">${r.payStatus.map((p) => html`<li><span>${payName(p.status)}</span><strong>${num(p.count)}</strong></li>`)}</ul></div>
              </div></section>

            ${productsPanel(r)}

            <section class="panel" id="rpt-categories" aria-labelledby="rpt-cat-h"><div class="panel-head"><h2 id="rpt-cat-h">${t('rpt.cat.title')}</h2></div>
              <div class="panel-body">${r.categories.length ? rankList({ items: r.categories.map((c) => ({ label: c.name || t('rpt.cat.none'), value: c.revenue, sub: t('rpt.prod.units', { n: num(c.qty) }) })), format: money }) : html`<p class="muted">${t('rpt.prod.none')}</p>`}</div></section>

            ${r.districts.length ? html`<section class="panel" id="rpt-geo" aria-labelledby="rpt-geo-h"><div class="panel-head"><h2 id="rpt-geo-h">${t('rpt.geo.title')}</h2></div>
              <div class="panel-body">${rankList({ items: r.districts.map((x) => ({ label: x.name, value: x.sales, sub: tn('rpt.geo.orders', x.count, { n: num(x.count) }) })), format: money })}</div></section>` : ''}

            ${r.coupons.length ? html`<section class="panel" id="rpt-coupons" aria-labelledby="rpt-coupon-h"><div class="panel-head"><h2 id="rpt-coupon-h">${t('rpt.coupon.title')}</h2></div>
              <div class="panel-body"><div class="table-wrap"><table class="table table-compact rpt-table">
                <thead><tr><th scope="col">${t('rpt.coupon.code')}</th><th scope="col" class="num">${t('rpt.coupon.orders')}</th><th scope="col" class="num">${t('rpt.coupon.discount')}</th></tr></thead>
                <tbody>${r.coupons.map((c) => html`<tr><th scope="row"><code>${c.code}</code></th><td class="num">${num(c.orders)}</td><td class="num">${money(c.discount)}</td></tr>`)}</tbody></table></div></div></section>` : ''}

            ${canCustomers && r.topCustomers.length ? html`<section class="panel" id="rpt-customers" aria-labelledby="rpt-cust-h"><div class="panel-head"><h2 id="rpt-cust-h">${t('rpt.cust.title')}</h2></div>
              <div class="panel-body"><div class="table-wrap"><table class="table table-compact rpt-table">
                <thead><tr><th scope="col">${t('rpt.cust.name')}</th><th scope="col" class="num">${t('rpt.cust.orders')}</th><th scope="col" class="num">${t('rpt.cust.sales')}</th></tr></thead>
                <tbody>${r.topCustomers.map((c) => html`<tr><th scope="row"><a href="${href('/customers/' + encodeURIComponent(c.userId))}">${c.name || t('rpt.cust.anon')}</a></th><td class="num">${num(c.orders)}</td><td class="num">${money(c.sales)}</td></tr>`)}</tbody></table></div></div></section>` : ''}

            <section class="panel rpt-wide" id="rpt-hours" aria-labelledby="rpt-hours-h"><div class="panel-head"><h2 id="rpt-hours-h">${t('rpt.hours.title')}</h2></div>
              <div class="panel-body">${barChart({ title: t('rpt.hours.title'), data: r.hours.map((h) => ({ label: num(h.hour), value: h.orders, note: `${num(h.hour)}:00` })), format: num, tickFormat: (v) => (Number.isInteger(v) ? num(v) : ''), summary: tn('rpt.chart.orders', k.orders.value, { n: num(k.orders.value) }) })}</div></section>
          </div>
          <details class="rpt-defs" id="rpt-defs"><summary>${t('rpt.defs.title')}</summary>
            <ul>${['sales', 'orders', 'received', 'customers', 'days', 'cost'].concat(canExport ? ['audit'] : []).map((x) => html`<li>${t(`rpt.defs.${x}`)}</li>`)}</ul></details>`;
      };

      const paintBody = () => {
        disposeChart();
        const body = ctx.el.querySelector('#rpt-body');
        if (!body) return;
        if (st.loading) render(body, spinnerBlock());
        else if (st.error) render(body, errorState({ text: st.error }));
        else render(body, reportHtml(st.report));
        disposeChart = bindChart(body);
      };
      const paintPeriod = () => {
        const el = ctx.el.querySelector('#rpt-period');
        if (!el) return;
        if (!range) { el.textContent = ''; return; }
        const prev = st.data ? { from: fmtDate(st.data.prevFrom), to: fmtDate(st.data.prevTo) } : null;
        const noPrev = st.data && !st.data.prevOrders.length && !st.data.prevTruncated;
        el.textContent = `${t('rpt.period', { from: fmtDate(range.fromMs), to: fmtDate(range.toMs) })}${prev ? ` · ${t('rpt.compared', prev)}` : ''}${noPrev ? ` — ${t('rpt.noPrev')}` : ''}`;
      };
      const paintChips = () => {
        for (const b of ctx.el.querySelectorAll('[data-action="range"]')) b.setAttribute('aria-pressed', b.dataset.range === preset ? 'true' : 'false');
        const f = ctx.el.querySelector('#rpt-custom'); if (f) f.hidden = preset !== 'custom';
      };

      /* ───────── loading ───────── */
      const load = async () => {
        const r = resolveRange({ preset, from: custom.from, to: custom.to });
        if (!r.ok) {
          const f = ctx.el.querySelector('form[data-form="custom"]');
          if (f) showFormErrors(f, { [r.field === 'from' ? 'from' : 'to']: t(`rpt.err.${r.error === 'invalid' ? r.field : r.error}`) });
          return;
        }
        const f = ctx.el.querySelector('form[data-form="custom"]'); if (f) showFormErrors(f, {});
        range = r;
        const mine = ++seq;
        st = { loading: true, error: '', data: null, report: null };
        paintPeriod(); paintBody();
        try {
          const data = await loadReportData(range);
          if (mine !== seq || ctx.signal.aborted) return;
          const prevSpan = range.toMs + 1 - range.fromMs;
          data.prevFrom = range.fromMs - prevSpan; data.prevTo = range.fromMs - 1;
          st = { loading: false, error: '', data, report: buildReport({ orders: data.orders, prevOrders: data.prevOrders, range, categoryNames: data.categoryNames }) };
        } catch (e) {
          if (mine !== seq || ctx.signal.aborted) return;
          if (!isRefusal(e)) reportError(e, 'reports.load');
          st = { loading: false, error: explainError(e), data: null, report: null };
        }
        paintPeriod(); paintBody();
      };

      /* ───────── page ───────── */
      const exportButton = canExport ? html`<button type="button" class="btn" data-action="export" id="rpt-export" aria-haspopup="menu">${icon('download', { size: 18 })}<span>${t('rpt.export')}</span></button>` : '';
      render(ctx.el, html`<div class="rpt">
        ${pageHead({ title: t('rpt.title'), sub: t('rpt.sub'), actions: exportButton })}
        <div class="rpt-bar">
          <div class="range-chips" role="group" aria-label="${t('rpt.range.label')}">${PRESETS.map((p) => html`<button type="button" class="chip" data-action="range" data-range="${p}" aria-pressed="${aria(p === preset)}">${t(`rpt.range.${p}`)}</button>`)}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="refresh">${icon('refresh', { size: 16 })}<span>${t('rpt.refresh')}</span></button>
        </div>
        <form class="rpt-custom" id="rpt-custom" data-form="custom" novalidate hidden>
          ${fieldHtml({ name: 'from', type: 'date', label: t('rpt.custom.from'), value: custom.from })}
          ${fieldHtml({ name: 'to', type: 'date', label: t('rpt.custom.to'), value: custom.to })}
          <button type="submit" class="btn btn-primary" data-action="apply">${t('rpt.custom.apply')}</button>
        </form>
        <p class="muted small rpt-period" id="rpt-period" role="status"></p>
        <div id="rpt-body" class="stack" aria-live="polite"></div></div>`);
      ctx.cleanup(() => disposeChart());

      const exportKind = async (kind) => {
        const d = st.data;
        if (!d || !range) return;
        if (d.truncated) { toastError(t('rpt.export.truncated')); return; }
        const sheet = exportSheet(kind, { orders: d.orders, range, withCustomer: canCustomers });
        if (!sheet || !sheet.rows.length) { toast(t('rpt.export.empty'), { type: 'info' }); return; }
        try {
          await recordExport({ kind, count: sheet.rows.length, range });          // the audit entry first: no entry, no file
        } catch (e) {
          if (!isRefusal(e)) reportError(e, 'reports.export');
          toastError(explainError(e));
          return;
        }
        exportCsv(sheet.filename, sheet.headers, sheet.rows);
        toast(t('rpt.export.done', { n: num(sheet.rows.length) }));
      };

      ctx.cleanup(bindActions(ctx.el, {
        range: (el) => {
          const next = el.dataset.range;
          if (next === preset) return;
          preset = next;
          if (preset === 'custom') {
            if (range) { custom = { from: range.fromKey, to: range.toKey }; const f = ctx.el.querySelector('form[data-form="custom"]'); if (f) { f.elements.from.value = custom.from; f.elements.to.value = custom.to; } }
            paintChips();
            const first = ctx.el.querySelector('#f-from'); if (first) first.focus();
            return;
          }
          local.set(KEY, preset);
          paintChips();
          return load();
        },
        refresh: () => load(),
        apply: (el, ev) => {
          ev.preventDefault();
          const f = ctx.el.querySelector('form[data-form="custom"]');
          custom = { from: f.elements.from.value, to: f.elements.to.value };
          return load();
        },
        prodBy: (el) => {
          prodBy = el.dataset.by;
          const old = ctx.el.querySelector('#rpt-products');
          if (!old || !st.report) return;
          const tmp = document.createElement('div');
          render(tmp, productsPanel(st.report));
          old.replaceWith(tmp.firstElementChild);
          const again = ctx.el.querySelector(`#rpt-products [data-by="${prodBy}"]`); if (again) again.focus();
        },
        export: (el) => openMenu({
          anchor: el, align: 'end',
          items: ['orders', 'daily', 'products'].map((kind) => ({ label: t(`rpt.export.${kind}`), icon: 'file-text', onClick: () => exportKind(kind) })),
        }),
        retry: () => load(),
      }, { submit: { custom: (form) => { custom = { from: form.elements.from.value, to: form.elements.to.value }; return load(); } } }));

      paintChips();
      await load();
    });
  },
};
