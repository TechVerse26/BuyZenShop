/*
 * Inventory — stock of every sellable unit (a simple product or one variant), with the tools to change it safely.
 *
 *   Stock tab     search (name, SKU), filters (state, category), sorting, paging; "Adjust" adds, removes or counts stock — one atomic batch
 *                 that also writes the movement log entry and the audit entry (js/shared/inventoryFlow.js → js/admin/data/inventory.js)
 *   History tab   the immutable movement log, newest first (or the history of one unit: ?tab=history&key=<unit>)
 *   Actions       export the stock sheet (CSV) · import a counted sheet (preview first) · recount reservations against the open orders
 *
 * "Held" is stock reserved by open orders. It changes only when orders change, never from this page.
 * Filters live in the URL: #/inventory?filter=low (the dashboard links here), #/inventory?q=<SKU> (the product editor links here).
 */
import { html, render, bindActions, readForm, withBusy, debounce, raw, safeUrl } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, toast, toastError, paginationHtml, formDialog, fieldHtml, alertDialog, openMenu } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, fmtDateTime, dhakaDayKey } from '../../core/format.js';
import { can } from '../../data/auth.js';
import { STOCK_REASONS } from '../../shared/inventoryFlow.js';
import { safeMount, pageHead, needs, searchField, exportCsv } from '../lib/ui.js';
import { stockBadge } from '../lib/catalogUi.js';
import { loadAdminCatalog, unitRows, invalidateAdminCatalog } from '../data/catalogAdmin.js';
import { adjustStock, previewStockImport, applyStockImport, loadMovements, previewRecount, applyRecount } from '../data/inventory.js';
import { pickFiles } from '../lib/images.js';

registerBoth({
  'inv.title': ['Inventory', 'ইনভেন্টরি'],
  'inv.sub': ['Stock of everything you sell, and a log of every change', 'আপনি যা বিক্রি করেন তার স্টক এবং প্রতিটি পরিবর্তনের লগ'],
  'inv.tab.stock': ['Stock', 'স্টক'],
  'inv.tab.history': ['History', 'ইতিহাস'],
  'inv.export': ['Export sheet', 'শিট এক্সপোর্ট'],
  'inv.import': ['Import count', 'গণনা ইমপোর্ট'],
  'inv.recount': ['Check holds', 'হোল্ড মিলিয়ে দেখুন'],
  'inv.search': ['Product name or SKU…', 'প্রোডাক্টের নাম বা SKU…'],
  'inv.f.state': ['Stock state', 'স্টকের অবস্থা'],
  'inv.f.all': ['All units', 'সব ইউনিট'],
  'inv.f.cat': ['Category', 'ক্যাটাগরি'],
  'inv.f.allCat': ['All categories', 'সব ক্যাটাগরি'],
  'inv.f.sort': ['Sort by', 'সাজান'],
  'inv.f.clear': ['Clear filters', 'ফিল্টার মুছুন'],
  'inv.sort.stock': ['Lowest stock first', 'কম স্টক আগে'],
  'inv.sort.name': ['Name A–Z', 'নাম A–Z'],
  'inv.sort.sku': ['SKU', 'SKU'],
  'inv.sort.updated': ['Recently changed', 'সম্প্রতি বদলানো'],
  'inv.col.product': ['Product', 'প্রোডাক্ট'],
  'inv.col.onhand': ['On hand', 'হাতে আছে'],
  'inv.col.held': ['Held', 'আটকে আছে'],
  'inv.col.available': ['Available', 'পাওয়া যাবে'],
  'inv.col.state': ['State', 'অবস্থা'],
  'inv.count_one': ['{n} unit', '{n}টি ইউনিট'],
  'inv.count_other': ['{n} units', '{n}টি ইউনিট'],
  'inv.draft': ['Draft', 'ড্রাফট'],
  'inv.archived': ['Archived', 'আর্কাইভ'],
  'inv.legacy': ['Old format', 'পুরনো ফরম্যাট'],
  'inv.noData': ['No stock records yet', 'এখনো কোনো স্টক রেকর্ড নেই'],
  'inv.noDataText': ['Add a product and its stock appears here.', 'প্রোডাক্ট যোগ করলে তার স্টক এখানে দেখা যাবে।'],
  'inv.noMatch': ['Nothing matches', 'কিছু মেলেনি'],
  'inv.noMatchText': ['Try a different word or clear the filters.', 'অন্য শব্দ দিয়ে খুঁজুন অথবা ফিল্টার মুছুন।'],
  'inv.truncated': ['The catalog is larger than what this page loads. Use the search to find a specific unit.', 'ক্যাটালগ এই পাতার লোড-সীমার চেয়ে বড়। নির্দিষ্ট ইউনিট খুঁজতে সার্চ ব্যবহার করুন।'],
  'inv.menu.more': ['Actions for {name}', '{name}-এর অ্যাকশন'],
  'inv.menu.adjust': ['Adjust stock', 'স্টক সমন্বয়'],
  'inv.menu.history': ['Stock history', 'স্টকের ইতিহাস'],
  'inv.menu.edit': ['Edit product', 'প্রোডাক্ট সম্পাদনা'],
  /* adjust dialog */
  'inv.adj.title': ['Adjust stock', 'স্টক সমন্বয়'],
  'inv.adj.mode': ['What happened?', 'কী হয়েছে?'],
  'inv.adj.mode.add': ['Stock came in (add)', 'নতুন স্টক এসেছে (যোগ)'],
  'inv.adj.mode.remove': ['Stock left or was lost (remove)', 'স্টক বেরিয়েছে বা নষ্ট হয়েছে (বাদ)'],
  'inv.adj.mode.set': ['I counted the shelf (set exact number)', 'শেলফ গুনেছি (সঠিক সংখ্যা বসান)'],
  'inv.adj.qty.add': ['Quantity to add', 'যোগ করার সংখ্যা'],
  'inv.adj.qty.remove': ['Quantity to remove', 'বাদ দেওয়ার সংখ্যা'],
  'inv.adj.qty.set': ['Counted stock', 'গুনে পাওয়া স্টক'],
  'inv.adj.reason': ['Reason', 'কারণ'],
  'inv.adj.note': ['Note', 'নোট'],
  'inv.adj.noteHint': ['Shown in the history. Required when the reason is "Other".', 'ইতিহাসে দেখাবে। কারণ "অন্য" হলে আবশ্যক।'],
  'inv.adj.now': ['On hand now', 'এখন হাতে আছে'],
  'inv.adj.held': ['Held by open orders', 'খোলা অর্ডারে আটকে আছে'],
  'inv.adj.after': ['Stock after this change', 'এই পরিবর্তনের পরে স্টক'],
  'inv.adj.afterBelowHeld': ['That is fewer than the {n} held by open orders — some of those orders may not be fulfilled in full.', 'এটি খোলা অর্ডারে আটকে থাকা {n}টির চেয়ে কম — কিছু অর্ডার পুরো পাঠানো নাও যেতে পারে।'],
  'inv.adj.save': ['Save change', 'পরিবর্তন সংরক্ষণ'],
  'inv.adj.done': ['Stock updated: {before} → {after}.', 'স্টক বদলেছে: {before} → {after}।'],
  'inv.reason.restock': ['Restock / purchase', 'নতুন মাল / কেনা'],
  'inv.reason.correction': ['Correction', 'সংশোধন'],
  'inv.reason.other': ['Other', 'অন্য'],
  'inv.reason.damage': ['Damaged', 'নষ্ট'],
  'inv.reason.loss': ['Lost or stolen', 'হারিয়েছে বা চুরি'],
  'inv.reason.count': ['Stock count', 'স্টক গণনা'],
  /* history */
  'inv.h.time': ['Time', 'সময়'],
  'inv.h.unit': ['Product', 'প্রোডাক্ট'],
  'inv.h.type': ['Type', 'ধরন'],
  'inv.h.change': ['Change', 'পরিবর্তন'],
  'inv.h.after': ['Stock after', 'পরে স্টক'],
  'inv.h.ref': ['Reference', 'সূত্র'],
  'inv.h.by': ['By', 'কে করেছেন'],
  'inv.h.heldChange': ['held {n}', 'আটকে {n}'],
  'inv.h.empty': ['No stock movements yet', 'এখনো কোনো স্টক মুভমেন্ট নেই'],
  'inv.h.emptyText': ['Every change of stock is written here and can never be edited.', 'স্টকের প্রতিটি পরিবর্তন এখানে লেখা হয় এবং কখনো বদলানো যায় না।'],
  'inv.h.more': ['Show older entries', 'পুরনো এন্ট্রি দেখুন'],
  'inv.h.unitTitle': ['History of {name}', '{name}-এর ইতিহাস'],
  'inv.h.allUnits': ['All units', 'সব ইউনিট'],
  'inv.h.manual': ['manual', 'হাতে করা'],
  'inv.type.initial': ['Starting stock', 'শুরুর স্টক'],
  'inv.type.restock': ['Restock', 'নতুন মাল'],
  'inv.type.damage': ['Damaged', 'নষ্ট'],
  'inv.type.loss': ['Lost', 'হারানো'],
  'inv.type.count': ['Stock count', 'স্টক গণনা'],
  'inv.type.correction': ['Correction', 'সংশোধন'],
  'inv.type.adjust': ['Adjustment', 'সমন্বয়'],
  'inv.type.ship': ['Shipped', 'পাঠানো হয়েছে'],
  'inv.type.return': ['Returned', 'ফেরত'],
  'inv.type.reserve_fix': ['Hold fixed', 'হোল্ড ঠিক করা'],
  /* import */
  'inv.imp.title': ['Import stock count', 'স্টক গণনা ইমপোর্ট'],
  'inv.imp.help': ['Choose a CSV file with a "SKU" (or "Key") column and a "Stock" column — for example the sheet you exported, with the Stock column corrected after counting. You see everything that would change before anything is saved.', '"SKU" (বা "Key") ও "Stock" কলামসহ একটি CSV ফাইল বাছুন — যেমন এক্সপোর্ট করা শিট, গণনার পর Stock কলাম ঠিক করে। কিছু সংরক্ষণের আগে কী কী বদলাবে সব দেখতে পাবেন।'],
  'inv.imp.pick': ['Choose CSV file', 'CSV ফাইল বাছুন'],
  'inv.imp.tooBig': ['The file is larger than 1 MB.', 'ফাইলটি ১ MB-এর চেয়ে বড়।'],
  'inv.imp.summary': ['{changes} to change · {same} already correct · {errors} with a problem', '{changes}টি বদলাবে · {same}টি ঠিক আছে · {errors}টিতে সমস্যা'],
  'inv.imp.apply': ['Apply {n} changes', '{n}টি পরিবর্তন প্রয়োগ করুন'],
  'inv.imp.nothing': ['Nothing to change', 'বদলানোর কিছু নেই'],
  'inv.imp.nothingText': ['Every row already matches the stock in the shop, or has a problem (see below).', 'প্রতিটি সারি দোকানের স্টকের সঙ্গে মিলে গেছে, অথবা সমস্যা আছে (নিচে দেখুন)।'],
  'inv.imp.col.line': ['Line', 'লাইন'],
  'inv.imp.col.unit': ['Product', 'প্রোডাক্ট'],
  'inv.imp.col.change': ['Stock', 'স্টক'],
  'inv.imp.col.result': ['Result', 'ফলাফল'],
  'inv.imp.ok': ['Will change', 'বদলাবে'],
  'inv.imp.same': ['No change', 'বদল নেই'],
  'inv.imp.progress': ['Saving… {done} of {total}', 'সংরক্ষণ হচ্ছে… {total}-এর মধ্যে {done}'],
  'inv.imp.done': ['Stock count imported: {n} units updated.', 'স্টক গণনা ইমপোর্ট হয়েছে: {n}টি ইউনিট হালনাগাদ।'],
  'inv.imp.partial': ['Only {done} of {total} batches were saved. Import the file again to finish — units that were already updated will show "no change".', '{total}টির মধ্যে মাত্র {done}টি ব্যাচ সংরক্ষিত হয়েছে। শেষ করতে ফাইলটি আবার ইমপোর্ট করুন — যেগুলো হালনাগাদ হয়ে গেছে সেগুলোতে "বদল নেই" দেখাবে।'],
  'inv.imp.err.no_ref': ['No SKU or key', 'SKU বা কী নেই'],
  'inv.imp.err.unknown': ['Unknown SKU', 'অচেনা SKU'],
  'inv.imp.err.duplicate': ['Listed twice', 'দুইবার আছে'],
  'inv.imp.err.no_inventory': ['Old-format product', 'পুরনো ফরম্যাটের প্রোডাক্ট'],
  'inv.imp.err.untracked': ['Stock not tracked', 'স্টক ট্র্যাক হয় না'],
  'inv.imp.err.bad_qty': ['Not a whole number', 'পূর্ণসংখ্যা নয়'],
  /* recount */
  'inv.rc.title': ['Check holds against open orders', 'খোলা অর্ডারের সঙ্গে হোল্ড মিলিয়ে দেখুন'],
  'inv.rc.ok': ['Everything matches', 'সব মিলে গেছে'],
  'inv.rc.okText': ['The stock held for customers matches the {n} open orders.', 'কাস্টমারের জন্য আটকে রাখা স্টক {n}টি খোলা অর্ডারের সঙ্গে মিলেছে।'],
  'inv.rc.help': ['The {n} open orders hold a different amount of stock than recorded for these units. Fixing sets "held" to what the open orders need. Physical stock is not changed.', '{n}টি খোলা অর্ডার যে পরিমাণ স্টক আটকে রাখে তা এই ইউনিটগুলোতে লেখা সংখ্যার সঙ্গে মেলে না। ঠিক করলে "আটকে আছে" খোলা অর্ডারের দরকার অনুযায়ী হবে। হাতে থাকা স্টক বদলাবে না।'],
  'inv.rc.col.have': ['Recorded', 'লেখা আছে'],
  'inv.rc.col.want': ['Should be', 'হওয়া উচিত'],
  'inv.rc.fix': ['Fix {n} units', '{n}টি ইউনিট ঠিক করুন'],
  'inv.rc.done': ['Holds corrected for {n} units.', '{n}টি ইউনিটের হোল্ড ঠিক হয়েছে।'],
  'inv.rc.partial': ['Only {done} of {total} batches were saved. Check again to finish.', '{total}টির মধ্যে মাত্র {done}টি ব্যাচ সংরক্ষিত হয়েছে। শেষ করতে আবার মিলিয়ে দেখুন।'],
});

const PAGE_SIZE = 30;
const FILTERS = ['low', 'out', 'in_stock', 'backorder', 'untracked'];
const SORTS = ['stock', 'name', 'sku', 'updated'];
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : Number(v) || 0);

function readQuery(q = {}) {
  return {
    tab: q.tab === 'history' ? 'history' : 'stock',
    q: String(q.q || '').slice(0, 80),
    filter: FILTERS.includes(q.filter) ? q.filter : '',
    cat: String(q.cat || '').slice(0, 80),
    sort: SORTS.includes(q.sort) ? q.sort : 'stock',
    page: Math.max(1, parseInt(q.page, 10) || 1),
    key: String(q.key || '').slice(0, 120),
  };
}
const toQuery = (f) => Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== '' && !(k === 'page' && v === 1) && !(k === 'sort' && v === 'stock') && !(k === 'tab' && v === 'stock')));
const option = (value, label, cur) => html`<option value="${value}" ${value === cur ? raw('selected') : ''}>${label}</option>`;
const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : num(0));

export default {
  async mount(ctx) {
    if (!needs(ctx, 'inventory.read')) return;
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      const canAdjust = can('inventory.adjust');
      const canRecount = canAdjust && can('orders.read');
      const canOrders = can('orders.read');
      let cat = await loadAdminCatalog();
      if (ctx.signal.aborted) return;
      let f = readQuery(ctx.query);
      let rows = [];
      let mv = { key: null, docs: [], last: null, more: false, loading: false, failed: false };
      const haystack = new Map();

      const buildRows = () => {
        haystack.clear();
        rows = unitRows(cat).map((r) => {
          const legacy = !!(r.inv && r.inv._legacy);
          const stock = r.inv ? Number(r.inv.stock) || 0 : 0;
          const held = r.inv ? Number(r.inv.reserved) || 0 : 0;
          const tracked = !legacy && r.tracked;
          const state = tracked ? r.state : (r.state === 'unavailable' ? 'unavailable' : 'untracked');
          return { ...r, legacy, tracked, stock, held, avail: Math.max(0, stock - held), name: r.product.name, variant: r.unit.label, sku: r.unit.sku || '', state, updated: r.inv ? ms(r.inv.updatedAt) : 0 };
        });
      };
      buildRows();
      const reload = async () => { invalidateAdminCatalog(); cat = await loadAdminCatalog({ force: true }); buildRows(); };
      const byKey = (key) => rows.find((r) => r.key === key);
      const unitName = (r) => (r.variant ? `${r.name} — ${r.variant}` : r.name);
      const hay = (r) => { if (!haystack.has(r.key)) haystack.set(r.key, [r.name, r.variant, r.sku, r.key, r.product.categoryName].join(' ').toLowerCase()); return haystack.get(r.key); };

      /* ── filtering, sorting, paging ── */
      const matches = (r) => {
        if (f.filter === 'untracked' ? r.tracked : (f.filter && (!r.tracked || r.state !== f.filter))) return false;
        if (f.cat === '_none' ? !!r.product.categoryId : (f.cat && r.product.categoryId !== f.cat)) return false;
        return f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay(r).includes(w));
      };
      const sorters = {
        stock: (a, b) => (a.tracked === b.tracked ? 0 : a.tracked ? -1 : 1) || a.avail - b.avail || unitName(a).localeCompare(unitName(b)),
        name: (a, b) => unitName(a).localeCompare(unitName(b)),
        sku: (a, b) => (a.sku || '￿').localeCompare(b.sku || '￿') || unitName(a).localeCompare(unitName(b)),
        updated: (a, b) => b.updated - a.updated || unitName(a).localeCompare(unitName(b)),
      };
      const filtered = () => rows.filter(matches).sort(sorters[f.sort]);
      const hasFilter = () => !!(f.q || f.filter || f.cat);

      /* ── stock tab ── */
      const rowHtml = (r) => {
        const stateBadge = r.legacy ? badge(t('inv.legacy'), 'warn') : stockBadge(r.state);
        return html`<tr>
          <td class="cell-first"><div class="cell-main">
            ${r.product.thumb ? html`<img class="thumb" src="${safeUrl(r.product.thumb)}" alt="" width="44" height="44" loading="lazy">` : html`<span class="thumb" aria-hidden="true"></span>`}
            <div><a class="t" href="${href('/products/' + encodeURIComponent(r.product.id))}">${r.name}</a>
              <div class="s">${r.variant ? html`${r.variant} · ` : ''}<span class="mono">${r.sku || r.key}</span>${r.product.status !== 'published' ? html` · ${r.product.status === 'draft' ? t('inv.draft') : t('inv.archived')}` : ''}</div></div></div></td>
          <td data-label="${t('inv.col.onhand')}" class="num">${r.tracked ? html`<span class="strong">${num(r.stock)}</span>` : html`<span class="muted">—</span>`}</td>
          <td data-label="${t('inv.col.held')}" class="num">${r.tracked ? num(r.held) : html`<span class="muted">—</span>`}</td>
          <td data-label="${t('inv.col.available')}" class="num">${r.tracked ? html`<span class="strong">${num(r.avail)}</span>` : html`<span class="muted">—</span>`}</td>
          <td data-label="${t('inv.col.state')}">${stateBadge}</td>
          <td class="col-actions"><button type="button" class="btn btn-ghost btn-icon" data-action="row-menu" data-key="${r.key}" aria-haspopup="menu" aria-label="${t('inv.menu.more', { name: unitName(r) })}">${icon('more-horizontal', { size: 18 })}</button></td>
        </tr>`;
      };
      const stockHtml = () => {
        if (!rows.length) return emptyState({ icon: 'archive', title: t('inv.noData'), text: t('inv.noDataText') });
        const list = filtered();
        const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
        f.page = Math.min(f.page, pages);
        const part = list.slice((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE);
        return html`${cat.truncated ? html`<p class="alert alert-warn mb-4">${icon('alert-triangle', { size: 18 })}<span>${t('inv.truncated')}</span></p>` : ''}
          ${part.length ? html`<div class="table-wrap"><table class="table table-stack table-cards inv-table">
            <thead><tr><th scope="col">${t('inv.col.product')}</th><th scope="col" class="num">${t('inv.col.onhand')}</th><th scope="col" class="num">${t('inv.col.held')}</th><th scope="col" class="num">${t('inv.col.available')}</th><th scope="col">${t('inv.col.state')}</th><th scope="col" class="col-actions"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
            <tbody>${part.map(rowHtml)}</tbody></table>
            <div class="table-footer"><span>${tn('inv.count', list.length, { n: num(list.length) })}</span>${paginationHtml({ page: f.page, pages, action: 'page' })}</div></div>`
            : emptyState({ icon: 'search', title: t('inv.noMatch'), text: t('inv.noMatchText') })}`;
      };

      /* ── history tab ── */
      const labelOfKey = (m) => { const r = byKey(m.key); return r ? { name: unitName(r), pid: r.product.id } : { name: (cat.productById[m.productId] || {}).name || m.key, pid: m.productId }; };
      const historyHtml = () => {
        const unit = f.key ? byKey(f.key) : null;
        const head = f.key ? html`<div class="row row-between mb-3"><strong>${t('inv.h.unitTitle', { name: unit ? unitName(unit) : f.key })}</strong><a href="${href('/inventory?tab=history')}">${t('inv.h.allUnits')}</a></div>` : '';
        if (mv.loading && !mv.docs.length) return html`${head}<div class="empty" role="status"><span class="spinner" aria-hidden="true"></span></div>`;
        if (mv.failed) return html`${head}<p class="alert alert-bad">${icon('alert-triangle', { size: 18 })}<span>${t('common.error')}</span> <button type="button" class="btn btn-sm" data-action="mv-retry">${t('common.retry')}</button></p>`;
        if (!mv.docs.length) return html`${head}${emptyState({ icon: 'history', title: t('inv.h.empty'), text: t('inv.h.emptyText') })}`;
        return html`${head}<div class="table-wrap"><table class="table table-stack inv-log">
          <thead><tr><th scope="col">${t('inv.h.time')}</th><th scope="col">${t('inv.h.unit')}</th><th scope="col">${t('inv.h.type')}</th><th scope="col" class="num">${t('inv.h.change')}</th><th scope="col" class="num">${t('inv.h.after')}</th><th scope="col">${t('inv.h.ref')}</th><th scope="col">${t('inv.h.by')}</th></tr></thead>
          <tbody>${mv.docs.map((m) => {
    const u = labelOfKey(m);
    const delta = Number(m.delta) || 0;
    const rd = Number(m.reservedDelta) || 0;
    return html`<tr>
              <td class="nowrap" data-label="${t('inv.h.time')}">${fmtDateTime(m.createdAt)}</td>
              <td class="cell-first"><a class="t" href="${href('/inventory?tab=history&key=' + encodeURIComponent(m.key))}">${u.name}</a>${m.sku ? html`<span class="cell-sub mono">${m.sku}</span>` : ''}</td>
              <td data-label="${t('inv.h.type')}">${badge(t(`inv.type.${m.type}`, null, m.type), m.type === 'ship' || m.type === 'damage' || m.type === 'loss' ? 'warn' : 'neutral')}${m.note ? html`<span class="cell-sub">${m.note}</span>` : ''}</td>
              <td data-label="${t('inv.h.change')}" class="num"><span class="strong ${delta > 0 ? 'text-ok' : delta < 0 ? 'text-bad' : ''}">${signed(delta)}</span>${rd ? html`<span class="cell-sub">${t('inv.h.heldChange', { n: signed(rd) })}</span>` : ''}</td>
              <td data-label="${t('inv.h.after')}" class="num">${num(Number(m.stockAfter) || 0)}</td>
              <td data-label="${t('inv.h.ref')}">${m.refType === 'order' && m.refId ? (canOrders ? html`<a class="mono" href="${href('/orders/' + encodeURIComponent(m.refId))}">${m.refId}</a>` : html`<span class="mono">${m.refId}</span>`) : html`<span class="muted">${t('inv.h.manual')}</span>`}</td>
              <td data-label="${t('inv.h.by')}" class="small">${m.actorEmail || '—'}</td>
            </tr>`;
  })}</tbody></table>
          ${mv.more ? html`<div class="table-footer"><button type="button" class="btn btn-sm" data-action="mv-more" ${mv.loading ? raw('disabled') : ''}>${t('inv.h.more')}</button></div>` : ''}</div>`;
      };
      const loadHistory = async ({ more = false } = {}) => {
        if (!can('inventory.read')) return;
        const key = f.key || '';
        if (!more) mv = { key, docs: [], last: null, more: false, loading: true, failed: false };
        else mv.loading = true;
        paintBody();
        try {
          const r = await loadMovements({ key, after: more ? mv.last : null });
          if (ctx.signal.aborted || mv.key !== key) return;
          mv = { key, docs: more ? [...mv.docs, ...r.docs] : r.docs, last: r.last, more: r.more, loading: false, failed: false };
        } catch (e) {
          if (ctx.signal.aborted) return;
          reportError(e, 'inventory.history');
          mv = { ...mv, loading: false, failed: true };
        }
        paintBody();
      };

      /* ── shell ── */
      const bodyHtml = () => (f.tab === 'history' ? historyHtml() : stockHtml());
      const paintBody = () => { const h = ctx.el.querySelector('#inv-body'); if (h) render(h, bodyHtml()); };
      const actions = () => html`
        <button type="button" class="btn" data-action="export">${icon('download', { size: 16 })}<span>${t('inv.export')}</span></button>
        ${canAdjust ? html`<button type="button" class="btn" data-action="import">${icon('upload', { size: 16 })}<span>${t('inv.import')}</span></button>` : ''}
        ${canRecount ? html`<button type="button" class="btn" data-action="recount">${icon('check-circle', { size: 16 })}<span>${t('inv.recount')}</span></button>` : ''}`;
      const toolbar = () => (f.tab === 'history' ? '' : html`<div class="toolbar" role="search">
          ${searchField({ id: 'q', value: f.q, placeholder: t('inv.search'), label: t('inv.search'), bind: 'q' })}
          <select class="select" data-change="filter" aria-label="${t('inv.f.state')}">${option('', t('inv.f.all'), f.filter)}${FILTERS.map((s) => option(s, t(`stk.${s}`), f.filter))}</select>
          <select class="select" data-change="cat" aria-label="${t('inv.f.cat')}">${option('', t('inv.f.allCat'), f.cat)}${cat.categories.map((c) => option(c.id, c.name, f.cat))}</select>
          <select class="select" data-change="sort" aria-label="${t('inv.f.sort')}">${SORTS.map((s) => option(s, t(`inv.sort.${s}`), f.sort))}</select>
          <button type="button" class="btn btn-ghost" data-action="clear" ${hasFilter() ? '' : raw('hidden')}>${icon('x', { size: 16 })}<span>${t('inv.f.clear')}</span></button>
        </div>`);
      const shell = () => html`<div class="inv-page">
        ${pageHead({ title: t('inv.title'), sub: t('inv.sub'), actions: actions() })}
        <div class="seg inv-tabs" role="group" aria-label="${t('inv.title')}">
          <button type="button" class="seg-btn" data-action="tab" data-tab="stock" aria-pressed="${f.tab === 'stock' ? 'true' : 'false'}">${t('inv.tab.stock')}</button>
          <button type="button" class="seg-btn" data-action="tab" data-tab="history" aria-pressed="${f.tab === 'history' ? 'true' : 'false'}">${t('inv.tab.history')}</button>
        </div>
        <div id="inv-toolbar">${toolbar()}</div>
        <div id="inv-body" aria-live="polite"></div>
      </div>`;
      const paintAll = () => { render(ctx.el, shell()); paintBody(); };
      paintAll();
      if (f.tab === 'history') loadHistory();

      const syncUrl = () => ctx.router.setQuery(toQuery(f));
      const setFilters = (patch) => {
        f = { ...f, ...patch, page: patch.page || 1 };
        syncUrl();
        const clear = ctx.el.querySelector('[data-action="clear"]');
        if (clear) clear.hidden = !hasFilter();
        paintBody();
      };

      /* ── adjust stock ── */
      const adjust = async (r) => {
        if (!r || !canAdjust) return;
        if (r.legacy) { toastError(t('iv.err.no_inventory')); return; }
        if (!r.tracked) { toastError(t('iv.err.untracked')); return; }
        const reasonOptions = (mode) => STOCK_REASONS[mode].map((x) => ({ value: x, label: t(`inv.reason.${x}`) }));
        const done = formDialog({
          title: t('inv.adj.title'), confirmText: t('inv.adj.save'), size: 'sm',
          body: html`<form novalidate data-adjust>
            <p class="strong">${unitName(r)}</p>
            <dl class="kv mb-4"><dt>${t('inv.adj.now')}</dt><dd class="strong">${num(r.stock)}</dd><dt>${t('inv.adj.held')}</dt><dd>${num(r.held)}</dd></dl>
            <div class="stack">
              ${fieldHtml({ name: 'mode', label: t('inv.adj.mode'), type: 'select', value: 'add', options: ['add', 'remove', 'set'].map((m) => ({ value: m, label: t(`inv.adj.mode.${m}`) })) })}
              ${fieldHtml({ name: 'qty', label: t('inv.adj.qty.add'), type: 'number', value: '', required: true, attrs: { min: 0, step: 1, inputmode: 'numeric', autocomplete: 'off' } })}
              ${fieldHtml({ name: 'reason', label: t('inv.adj.reason'), type: 'select', value: 'restock', options: reasonOptions('add') })}
              ${fieldHtml({ name: 'note', label: t('inv.adj.note'), value: '', hint: t('inv.adj.noteHint'), attrs: { maxlength: 300 } })}
              <p class="small" id="inv-after" aria-live="polite"></p>
            </div>
          </form>`,
          onSubmit: async (form) => {
            showFormErrors(form, {});
            const v = readForm(form);
            try {
              const res = await adjustStock({ key: r.key, mode: v.mode, qty: v.qty, reason: v.reason, note: v.note });
              await reload();
              paintBody();
              toast(t('inv.adj.done', { before: num(res.before), after: num(res.after) }));
              return true;
            } catch (e) {
              const code = e && e.code;
              if (['bad_qty', 'below_zero', 'too_big', 'no_change'].includes(code)) showFormErrors(form, { qty: e.message });
              else if (code === 'note_required') showFormErrors(form, { note: e.message });
              else if (code === 'bad_reason') showFormErrors(form, { reason: e.message });
              else { if (!isRefusal(e)) reportError(e, 'inventory.adjust'); toastError(explainError(e)); }
              return false;
            }
          },
        });
        const form = document.querySelector('[role="dialog"] form[data-adjust]');
        if (form) {
          const preview = () => {
            const v = readForm(form);
            const q = typeof v.qty === 'number' ? v.qty : NaN;
            const after = v.mode === 'add' ? r.stock + q : v.mode === 'remove' ? r.stock - q : q;
            const out = form.querySelector('#inv-after');
            if (!Number.isFinite(after) || after < 0) { out.textContent = ''; return; }
            out.textContent = `${t('inv.adj.after')}: ${num(after)}${after < r.held ? ` — ${t('inv.adj.afterBelowHeld', { n: num(r.held) })}` : ''}`;
            out.className = after < r.held ? 'small text-warn' : 'small muted';
          };
          form.addEventListener('input', preview);
          form.addEventListener('change', (e) => {
            if (e.target.name === 'mode') {
              const mode = e.target.value;
              const label = form.querySelector('label[for="f-qty"]');
              if (label) label.textContent = t(`inv.adj.qty.${mode}`);
              const sel = form.querySelector('#f-reason');
              sel.replaceChildren(...STOCK_REASONS[mode].map((x) => { const o = document.createElement('option'); o.value = x; o.textContent = t(`inv.reason.${x}`); return o; }));
            }
            preview();
          });
          form.querySelector('#f-qty').focus();
        }
        await done;
      };

      /* ── export / import / recount ── */
      const exportSheet = () => {
        const headers = ['Key', 'SKU', 'Product', 'Variant', 'Category', 'Stock', 'Reserved', 'Available', 'State'];
        const data = filtered().map((r) => [r.key, r.sku, r.name, r.variant, r.product.categoryName, r.tracked ? r.stock : '', r.tracked ? r.held : '', r.tracked ? r.avail : '', r.state]);
        exportCsv(`stock-${dhakaDayKey(Date.now())}.csv`, headers, data);
      };

      const importCount = async () => {
        const files = await pickFiles({ accept: '.csv,text/csv,text/plain', multiple: false });
        if (!files.length) return;
        const file = files[0];
        if (file.size > 1024 * 1024) { toastError(t('inv.imp.tooBig')); return; }
        let plan;
        try {
          const text = await file.text();
          await reload();
          plan = previewStockImport(text, cat);
        } catch (e) { if (!isRefusal(e)) reportError(e, 'inventory.import'); toastError(explainError(e)); return; }
        const verdict = (it) => (it.status === 'error' ? html`<span class="text-bad">${t(`inv.imp.err.${it.error}`)}</span>` : it.status === 'same' ? html`<span class="muted">${t('inv.imp.same')}</span>` : html`<span class="text-ok">${t('inv.imp.ok')}</span>`);
        const table = html`<div class="table-wrap inv-preview"><table class="table"><thead><tr><th scope="col">${t('inv.imp.col.line')}</th><th scope="col">${t('inv.imp.col.unit')}</th><th scope="col" class="num">${t('inv.imp.col.change')}</th><th scope="col">${t('inv.imp.col.result')}</th></tr></thead>
          <tbody>${plan.items.map((it) => html`<tr><td>${num(it.line)}</td><td>${it.name ? html`${it.name}<span class="cell-sub mono">${it.sku || it.key}</span>` : html`<span class="mono">${it.ref || '—'}</span>`}</td>
            <td class="num">${it.status === 'error' ? '—' : html`${num(it.before)} → <span class="strong">${num(it.after)}</span>`}</td><td>${verdict(it)}</td></tr>`)}</tbody></table></div>`;
        await showPlan(plan, table, plan.changes > 0);
      };
      const showPlan = (plan, table, canApply) => formDialog({
        title: t('inv.imp.title'), size: 'lg', confirmText: canApply ? t('inv.imp.apply', { n: num(plan.changes) }) : t('common.ok'),
        body: html`<form novalidate><p class="muted mb-3">${t('inv.imp.summary', { changes: num(plan.changes), same: num(plan.same), errors: num(plan.errors) })}</p>
          ${canApply ? '' : html`<p class="alert alert-info mb-3">${icon('info', { size: 18 })}<span><strong>${t('inv.imp.nothing')}.</strong> ${t('inv.imp.nothingText')}</span></p>`}${table}<p class="small muted mt-3" id="inv-progress" role="status"></p></form>`,
        onSubmit: async (form) => {
          if (!canApply) return true;
          const prog = form.querySelector('#inv-progress');
          try {
            await applyStockImport(plan, { onProgress: (done, total) => { prog.textContent = t('inv.imp.progress', { done: num(done), total: num(total) }); } });
            toast(t('inv.imp.done', { n: num(plan.changes) }));
          } catch (e) {
            if (!isRefusal(e)) reportError(e, 'inventory.import');
            const done = Number.isFinite(e && e.chunksDone) ? e.chunksDone : 0;
            toastError(done ? `${explainError(e)} ${t('inv.imp.partial', { done: num(done), total: num(plan.chunks.length) })}` : explainError(e));
          }
          await reload(); paintBody();
          return true;
        },
      });

      const recount = async () => {
        let plan;
        try { await reload(); plan = await previewRecount(cat); } catch (e) { if (!isRefusal(e)) reportError(e, 'inventory.recount'); toastError(explainError(e)); return; }
        if (!plan.diffs.length) { await alertDialog({ title: t('inv.rc.ok'), message: t('inv.rc.okText', { n: num(plan.openOrders) }) }); return; }
        const nameOf = (k) => { const r = byKey(k); return r ? unitName(r) : k; };
        await formDialog({
          title: t('inv.rc.title'), size: 'md', confirmText: t('inv.rc.fix', { n: num(plan.diffs.length) }),
          body: html`<form novalidate><p class="muted mb-3">${t('inv.rc.help', { n: num(plan.openOrders) })}</p>
            <div class="table-wrap"><table class="table"><thead><tr><th scope="col">${t('inv.col.product')}</th><th scope="col" class="num">${t('inv.rc.col.have')}</th><th scope="col" class="num">${t('inv.rc.col.want')}</th></tr></thead>
            <tbody>${plan.diffs.map((d) => html`<tr><td>${nameOf(d.key)}</td><td class="num">${num(d.have)}</td><td class="num strong">${num(d.want)}</td></tr>`)}</tbody></table></div></form>`,
          onSubmit: async () => {
            try {
              await applyRecount(plan);
              toast(t('inv.rc.done', { n: num(plan.diffs.length) }));
            } catch (e) {
              if (!isRefusal(e)) reportError(e, 'inventory.recount');
              const done = Number.isFinite(e && e.chunksDone) ? e.chunksDone : 0;
              toastError(done ? `${explainError(e)} ${t('inv.rc.partial', { done: num(done), total: num(plan.chunks.length) })}` : explainError(e));
            }
            await reload(); paintBody();
            return true;
          },
        });
      };

      ctx.cleanup(bindActions(ctx.el, {
        tab: (el) => {
          f = { ...f, tab: el.dataset.tab, page: 1, key: el.dataset.tab === 'history' ? f.key : '' };
          syncUrl();
          paintAll();
          if (f.tab === 'history') loadHistory();
        },
        page: (el) => { f.page = Number(el.dataset.page) || 1; syncUrl(); paintBody(); ctx.el.querySelector('.inv-page')?.scrollIntoView({ block: 'start' }); },
        clear: () => { f = { ...readQuery({}), tab: f.tab }; render(ctx.el.querySelector('#inv-toolbar'), toolbar()); paintBody(); syncUrl(); },
        export: exportSheet,
        import: (btn) => withBusy(btn, importCount),
        recount: (btn) => withBusy(btn, recount),
        'mv-more': () => loadHistory({ more: true }),
        'mv-retry': () => loadHistory(),
        'row-menu': (btn) => {
          const r = byKey(btn.dataset.key);
          if (!r) return;
          const items = [];
          if (canAdjust && r.tracked && !r.legacy) items.push({ label: t('inv.menu.adjust'), icon: 'sliders', onClick: () => adjust(r) });
          items.push({ label: t('inv.menu.history'), icon: 'history', href: href(`/inventory?tab=history&key=${encodeURIComponent(r.key)}`) });
          if (can('products.read')) items.push({ label: t('inv.menu.edit'), icon: 'edit', href: href('/products/' + encodeURIComponent(r.product.id)) });
          openMenu({ anchor: btn, items });
        },
      }, {
        change: {
          filter: (el) => setFilters({ filter: el.value }),
          cat: (el) => setFilters({ cat: el.value }),
          sort: (el) => setFilters({ sort: el.value }),
        },
        input: { q: debounce((el) => setFilters({ q: el.value.trim() }), 250) },
      }));
    });
  },
};
