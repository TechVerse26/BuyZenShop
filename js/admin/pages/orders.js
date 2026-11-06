/*
 * Orders — the working list. Search (order number, name, phone, e-mail, TrxID), filters (status, payment, method, dates),
 * paging, bulk actions (confirm, print invoices / packing slips) and CSV export.
 *
 * A status or payment filter is an equality query, so it finds every such order however old; without a filter the latest
 * 300 orders are loaded and everything else (search, method) is filtered in the browser. Filters live in the URL
 * (#/orders?status=pending), so the dashboard tiles and the browser's back button work.
 */
import { html, render, bindActions, withBusy, debounce, raw, aria } from '../../core/dom.js';
import { registerBoth, t, tn, lbl } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { statusBadge, paymentBadge, badge, emptyState, confirmDialog, toast, toastError, paginationHtml, alertDialog } from '../../core/ui.js';
import { explainError } from '../../core/errors.js';
import { money, num, fmtDateTime, parseDhakaDate, dhakaDayKey } from '../../core/format.js';
import { printDocument, invoiceHtml, packingSlipHtml } from '../../core/print.js';
import { can } from '../../data/auth.js';
import { fetchOrder } from '../../data/ordersAdmin.js';
import { ORDER_STATUS, ORDER_STATUS_IDS, PAYMENT_STATUS, PAYMENT_METHODS, PATTERNS } from '../../shared/constants.js';
import { safeMount, pageHead, needs, searchField, exportCsv } from '../lib/ui.js';
import { customerLabel, customerPhone, methodLabel, orderMatches, showPhone, piiVisible, ORDER_CSV_HEADERS, orderCsvRow, loadBusiness } from '../lib/orderUi.js';
import { fetchOrdersFiltered, changeStatus, RECENT_LIMIT } from '../data/orders.js';

registerBoth({
  'ord.title': ['Orders', 'অর্ডার'],
  'ord.sub': ['Find, check and move orders along', 'অর্ডার খুঁজুন, যাচাই করুন, পরের ধাপে এগিয়ে দিন'],
  'ord.export': ['Export CSV', 'CSV এক্সপোর্ট'],
  'ord.search': ['Order no., name, phone, TrxID…', 'অর্ডার নং, নাম, ফোন, TrxID…'],
  'ord.f.status': ['Status', 'অবস্থা'],
  'ord.f.payment': ['Payment', 'পেমেন্ট'],
  'ord.f.method': ['Method', 'মাধ্যম'],
  'ord.f.from': ['From date', 'শুরুর তারিখ'],
  'ord.f.to': ['To date', 'শেষ তারিখ'],
  'ord.f.fromShort': ['From', 'থেকে'],
  'ord.f.toShort': ['To', 'পর্যন্ত'],
  'ord.f.allStatus': ['All statuses', 'সব অবস্থা'],
  'ord.f.allPayment': ['All payments', 'সব পেমেন্ট'],
  'ord.f.allMethod': ['All methods', 'সব মাধ্যম'],
  'ord.f.clear': ['Clear filters', 'ফিল্টার মুছুন'],
  'ord.col.order': ['Order', 'অর্ডার'],
  'ord.col.customer': ['Customer', 'কাস্টমার'],
  'ord.col.items': ['Items', 'পণ্য'],
  'ord.col.total': ['Total', 'মোট'],
  'ord.col.payment': ['Payment', 'পেমেন্ট'],
  'ord.col.status': ['Status', 'অবস্থা'],
  'ord.select': ['Select order {n}', '{n} অর্ডারটি বাছুন'],
  'ord.selectAll': ['Select all on this page', 'এই পেজের সব বাছুন'],
  'ord.legacy': ['Old site', 'পুরনো সাইট'],
  'ord.count_one': ['{n} order', '{n}টি অর্ডার'],
  'ord.count_other': ['{n} orders', '{n}টি অর্ডার'],
  'ord.recentNote': ['Showing the latest {n} orders. Pick a status, payment filter or date range to look further back.', 'সর্বশেষ {n}টি অর্ডার দেখাচ্ছে। আরও পেছনে দেখতে অবস্থা, পেমেন্ট বা তারিখ বেছে নিন।'],
  'ord.truncated': ['There are more matching orders than can be loaded. Narrow the filter.', 'মিলে যাওয়া অর্ডার আরও আছে যা লোড করা যায়নি। ফিল্টার ছোট করুন।'],
  'ord.empty': ['No orders yet', 'এখনো কোনো অর্ডার নেই'],
  'ord.emptyText': ['Orders will show up here as soon as customers check out.', 'কাস্টমার অর্ডার করলেই এখানে দেখা যাবে।'],
  'ord.noMatch': ['No order matches these filters', 'এই ফিল্টারে কোনো অর্ডার মেলেনি'],
  'ord.noMatchText': ['Change or clear the filters to see more.', 'ফিল্টার বদলান বা মুছে দিন।'],
  'ord.selected_one': ['{n} selected', '{n}টি বাছাই করা'],
  'ord.selected_other': ['{n} selected', '{n}টি বাছাই করা'],
  'ord.bulk.confirm': ['Confirm pending', 'অপেক্ষমাণ নিশ্চিত করুন'],
  'ord.bulk.invoices': ['Print invoices', 'ইনভয়েস প্রিন্ট'],
  'ord.bulk.slips': ['Print packing slips', 'প্যাকিং স্লিপ প্রিন্ট'],
  'ord.bulk.clear': ['Clear selection', 'বাছাই মুছুন'],
  'ord.bulk.none': ['None of the selected orders is pending.', 'বাছাই করা কোনো অর্ডারই অপেক্ষমাণ নয়।'],
  'ord.bulk.title': ['Confirm {n} orders?', '{n}টি অর্ডার নিশ্চিত করবেন?'],
  'ord.bulk.msg': ['Each order moves from Pending to Confirmed and its customer is notified. Orders that fail are listed afterwards.', 'প্রতিটি অর্ডার "অপেক্ষমাণ" থেকে "নিশ্চিত" হবে এবং কাস্টমার জানতে পারবেন। যেগুলো ব্যর্থ হবে সেগুলোর তালিকা পরে দেখানো হবে।'],
  'ord.bulk.done': ['{n} orders confirmed.', '{n}টি অর্ডার নিশ্চিত হয়েছে।'],
  'ord.bulk.partial': ['Done, but some orders failed', 'কাজ শেষ, তবে কিছু অর্ডার ব্যর্থ হয়েছে'],
  'ord.bulk.partialText': ['{ok} confirmed, {bad} failed:', '{ok}টি নিশ্চিত, {bad}টি ব্যর্থ:'],
  'ord.loadFailed': ['Orders could not be loaded.', 'অর্ডার লোড করা যায়নি।'],
  'ord.printing': ['Preparing the print view…', 'প্রিন্টের জন্য প্রস্তুত হচ্ছে…'],
  'ord.mask': ['Phone numbers and e-mail addresses are hidden for your role.', 'আপনার রোলের জন্য ফোন নম্বর ও ইমেইল লুকানো আছে।'],
});

const PAGE_SIZE = 25;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readQuery(q = {}) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  return {
    status: ORDER_STATUS[q.status] ? q.status : '',
    payment: PAYMENT_STATUS[q.payment] ? q.payment : '',
    method: PAYMENT_METHODS[q.method] ? q.method : '',
    q: String(q.q || '').slice(0, 80),
    from: DATE_RE.test(q.from || '') ? q.from : '',
    to: DATE_RE.test(q.to || '') ? q.to : '',
    page,
  };
}
const toQuery = (f) => Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== '' && !(k === 'page' && v === 1)));
const serverKey = (f) => [f.status, f.payment, f.from, f.to].join('|');
const option = (value, label, cur) => html`<option value="${value}" ${value === cur ? raw('selected') : ''}>${label}</option>`;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'orders.read')) return;
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      let f = readQuery(ctx.query);
      let data = await fetchOrdersFiltered({ status: f.status, payment: f.payment, from: f.from ? parseDhakaDate(f.from, false) : null, to: f.to ? parseDhakaDate(f.to, true) : null });
      if (ctx.signal.aborted) return;
      let loadedKey = serverKey(f);
      const selected = new Set();
      const canUpdate = can('orders.update');
      const canExport = can('reports.export');
      const mask = !piiVisible();

      const filtered = () => data.orders.filter((o) => (!f.method || o.payment.method === f.method) && orderMatches(o, f.q));
      const pageOf = (list) => { const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE)); const page = Math.min(f.page, pages); return { pages, page, rows: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) }; };
      const byId = (id) => data.orders.find((o) => o.id === id);
      const hasFilter = () => !!(f.status || f.payment || f.method || f.q || f.from || f.to);

      const rowHtml = (o) => html`<tr>
        <td class="col-check"><input type="checkbox" data-change="toggle" data-id="${o.id}" ${selected.has(o.id) ? raw('checked') : ''} aria-label="${t('ord.select', { n: o.orderNumber })}"></td>
        <td data-label="${t('ord.col.order')}"><a class="mono strong" href="${href('/orders/' + encodeURIComponent(o.id))}">${o.orderNumber}</a><span class="cell-sub">${fmtDateTime(o.createdAtMs)}</span></td>
        <td data-label="${t('ord.col.customer')}">${customerLabel(o)}<span class="cell-sub">${[showPhone(customerPhone(o)), o.address && o.address.district].filter(Boolean).join(' · ')}</span></td>
        <td data-label="${t('ord.col.items')}" class="num">${num(o.items.reduce((s, l) => s + l.qty, 0))}</td>
        <td data-label="${t('ord.col.total')}" class="num nowrap">${money(o.totals.total)}</td>
        <td data-label="${t('ord.col.payment')}">${methodLabel(o.payment.method)} ${paymentBadge(o.payment.status)}</td>
        <td data-label="${t('ord.col.status')}">${statusBadge(o.status)}${o.isLegacy ? html` ${badge(t('ord.legacy'))}` : ''}</td>
      </tr>`;

      const bulkHtml = () => {
        const n = [...selected].filter((id) => byId(id)).length;
        if (!n) return '';
        return html`<div class="bulk-bar" role="region" aria-label="${tn('ord.selected', n, { n: num(n) })}">
          <span>${tn('ord.selected', n, { n: num(n) })}</span>
          ${canUpdate ? html`<button type="button" class="btn btn-sm btn-primary" data-action="bulk-confirm">${icon('check', { size: 16 })}<span>${t('ord.bulk.confirm')}</span></button>` : ''}
          <button type="button" class="btn btn-sm" data-action="bulk-invoices">${icon('printer', { size: 16 })}<span>${t('ord.bulk.invoices')}</span></button>
          <button type="button" class="btn btn-sm" data-action="bulk-slips">${icon('package', { size: 16 })}<span>${t('ord.bulk.slips')}</span></button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="bulk-clear">${t('ord.bulk.clear')}</button>
        </div>`;
      };

      const resultsHtml = () => {
        const list = filtered();
        const { pages, page, rows } = pageOf(list);
        f.page = page;
        const recentMode = !f.status && !f.payment && !f.from && !f.to;
        return html`
          ${recentMode && data.orders.length >= RECENT_LIMIT ? html`<p class="alert mb-4">${icon('info', { size: 18 })}<span>${t('ord.recentNote', { n: num(RECENT_LIMIT) })}</span></p>` : ''}
          ${!recentMode && data.truncated ? html`<p class="alert alert-warn mb-4">${icon('alert-triangle', { size: 18 })}<span>${t('ord.truncated')}</span></p>` : ''}
          ${mask ? html`<p class="muted small mb-3">${t('ord.mask')}</p>` : ''}
          ${bulkHtml()}
          ${rows.length ? html`<div class="table-wrap"><table class="table table-stack">
            <thead><tr>
              <th class="col-check"><input type="checkbox" data-change="toggleAll" aria-label="${t('ord.selectAll')}" ${rows.every((o) => selected.has(o.id)) ? raw('checked') : ''}></th>
              <th scope="col">${t('ord.col.order')}</th><th scope="col">${t('ord.col.customer')}</th><th scope="col" class="num">${t('ord.col.items')}</th>
              <th scope="col" class="num">${t('ord.col.total')}</th><th scope="col">${t('ord.col.payment')}</th><th scope="col">${t('ord.col.status')}</th>
            </tr></thead>
            <tbody>${rows.map(rowHtml)}</tbody></table>
            <div class="table-footer"><span>${tn('ord.count', list.length, { n: num(list.length) })}</span>${paginationHtml({ page, pages, action: 'page' })}</div>
          </div>`
          : (data.orders.length ? emptyState({ icon: 'search', title: t('ord.noMatch'), text: t('ord.noMatchText') }) : emptyState({ icon: 'package', title: t('ord.empty'), text: t('ord.emptyText') }))}`;
      };

      const paintResults = () => { const host = ctx.el.querySelector('#ord-results'); if (host) { render(host, resultsHtml()); host.removeAttribute('aria-busy'); } };

      const shell = () => html`<div class="orders-page">
        ${pageHead({ title: t('ord.title'), sub: t('ord.sub'), actions: canExport ? html`<button type="button" class="btn" data-action="export">${icon('download', { size: 16 })}<span>${t('ord.export')}</span></button>` : null })}
        <div class="toolbar" role="search">
          ${searchField({ id: 'q', value: f.q, placeholder: t('ord.search'), label: t('ord.search'), bind: 'q' })}
          <select class="select" data-change="status" aria-label="${t('ord.f.status')}">${option('', t('ord.f.allStatus'), f.status)}${ORDER_STATUS_IDS.map((id) => option(id, lbl(ORDER_STATUS[id]), f.status))}</select>
          <select class="select" data-change="payment" aria-label="${t('ord.f.payment')}">${option('', t('ord.f.allPayment'), f.payment)}${Object.keys(PAYMENT_STATUS).map((id) => option(id, lbl(PAYMENT_STATUS[id]), f.payment))}</select>
          <select class="select" data-change="method" aria-label="${t('ord.f.method')}">${option('', t('ord.f.allMethod'), f.method)}${Object.keys(PAYMENT_METHODS).map((id) => option(id, lbl(PAYMENT_METHODS[id]), f.method))}</select>
          <label class="date-field"><span>${t('ord.f.fromShort')}</span><input class="input" type="date" data-change="from" value="${f.from}" aria-label="${t('ord.f.from')}" max="${dhakaDayKey(Date.now())}"></label>
          <label class="date-field"><span>${t('ord.f.toShort')}</span><input class="input" type="date" data-change="to" value="${f.to}" aria-label="${t('ord.f.to')}" max="${dhakaDayKey(Date.now())}"></label>
          <button type="button" class="btn btn-ghost" data-action="clear" ${hasFilter() ? '' : raw('hidden')}>${icon('x', { size: 16 })}<span>${t('ord.f.clear')}</span></button>
        </div>
        <div id="ord-results" aria-live="polite"></div>
      </div>`;

      render(ctx.el, shell());
      paintResults();

      /* ── filters ── */
      const syncUrl = () => ctx.router.setQuery(toQuery(f));
      const reload = async () => {
        const host = ctx.el.querySelector('#ord-results');
        if (host) host.setAttribute('aria-busy', 'true');
        try {
          const next = await fetchOrdersFiltered({ status: f.status, payment: f.payment, from: f.from ? parseDhakaDate(f.from, false) : null, to: f.to ? parseDhakaDate(f.to, true) : null });
          if (ctx.signal.aborted) return;
          data = next; loadedKey = serverKey(f);
        } catch (e) { console.error(e); toastError(`${t('ord.loadFailed')} ${explainError(e)}`); }
        paintResults();
      };
      const setFilters = async (patch) => {
        f = { ...f, ...patch, page: patch.page || 1 };
        syncUrl();
        const clearBtn = ctx.el.querySelector('[data-action="clear"]');
        if (clearBtn) clearBtn.hidden = !hasFilter();
        if (serverKey(f) !== loadedKey) await reload(); else paintResults();
        if (!filtered().length && PATTERNS.orderNumber.test(f.q.trim().toUpperCase())) {          // an exact order number older than the loaded list
          const found = await fetchOrder(f.q.trim().toUpperCase()).catch(() => null);
          if (found && !ctx.signal.aborted && !byId(found.id)) { data = { ...data, orders: [found, ...data.orders] }; paintResults(); }
        }
      };

      /* ── selection and bulk actions ── */
      const chosen = () => [...selected].map(byId).filter(Boolean);
      const printMany = async (kind) => {
        const list = chosen();
        const business = await loadBusiness();
        const body = html`${list.map((o) => (kind === 'invoice' ? invoiceHtml(o, { business }) : packingSlipHtml(o, { business })))}`;
        await printDocument(body, { title: kind === 'invoice' ? 'Invoices' : 'Packing slips' });
      };

      ctx.cleanup(bindActions(ctx.el, {
        page: (el) => { f.page = Number(el.dataset.page) || 1; syncUrl(); paintResults(); ctx.el.querySelector('.orders-page')?.scrollIntoView({ block: 'start' }); },
        clear: () => { f = readQuery({}); selected.clear(); render(ctx.el, shell()); syncUrl(); (serverKey(f) !== loadedKey ? reload() : Promise.resolve()).then(paintResults); },
        export: () => {
          const rows = filtered().map((o) => orderCsvRow(o, { mask }));
          exportCsv(`orders-${dhakaDayKey(Date.now())}.csv`, ORDER_CSV_HEADERS, rows);
        },
        'bulk-clear': () => { selected.clear(); paintResults(); },
        'bulk-invoices': (btn) => withBusy(btn, () => printMany('invoice')),
        'bulk-slips': (btn) => withBusy(btn, () => printMany('slip')),
        'bulk-confirm': async (btn) => {
          const targets = chosen().filter((o) => o.status === 'pending');
          if (!targets.length) { toastError(t('ord.bulk.none')); return; }
          if (!(await confirmDialog({ title: t('ord.bulk.title', { n: num(targets.length) }), message: t('ord.bulk.msg'), confirmText: t('ord.bulk.confirm') }))) return;
          const failed = [];
          let ok = 0;
          await withBusy(btn, async () => {
            for (const o of targets) {
              try { await changeStatus(o, 'confirmed'); ok += 1; } catch (e) { console.error(e); failed.push(`${o.orderNumber}: ${explainError(e)}`); }
            }
          });
          selected.clear();
          await reload();
          if (failed.length) await alertDialog({ title: t('ord.bulk.partial'), message: `${t('ord.bulk.partialText', { ok: num(ok), bad: num(failed.length) })} ${failed.join(' · ')}` });
          else toast(t('ord.bulk.done', { n: num(ok) }));
        },
      }, {
        change: {
          status: (el) => setFilters({ status: el.value }),
          payment: (el) => setFilters({ payment: el.value }),
          method: (el) => setFilters({ method: el.value }),
          from: (el) => setFilters({ from: el.value }),
          to: (el) => setFilters({ to: el.value }),
          toggle: (el) => { if (el.checked) selected.add(el.dataset.id); else selected.delete(el.dataset.id); paintResults(); },
          toggleAll: (el) => { const { rows } = pageOf(filtered()); for (const o of rows) { if (el.checked) selected.add(o.id); else selected.delete(o.id); } paintResults(); },
        },
        input: { q: debounce((el) => setFilters({ q: el.value.trim() }), 250) },
      }));
    });
  },
};
