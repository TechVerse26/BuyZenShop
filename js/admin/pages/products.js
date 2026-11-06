/*
 * Products — the catalog list. Search (name, SKU, tag), filters (status, category, stock), sorting, paging, bulk publish / draft / archive,
 * per-row menu (edit, view in store, duplicate, status, delete) and CSV export. Filters live in the URL (#/products?status=draft).
 *
 * Everything is read from the cached admin catalog (products + inventory + categories + brands), so filtering is instant;
 * every write goes through js/admin/data/products.js (planner → rules). Products created on the old site are listed with an
 * "Old format" badge: they cannot be edited until the migration (Setup page) has upgraded them.
 */
import { html, render, bindActions, withBusy, debounce, raw } from '../../core/dom.js';
import { registerBoth, t, tn, lbl } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { productStatusBadge, badge, emptyState, confirmDialog, openMenu, toast, toastError, paginationHtml, alertDialog } from '../../core/ui.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, fmtDate, dhakaDayKey } from '../../core/format.js';
import { can } from '../../data/auth.js';
import { PRODUCT_STATUS } from '../../shared/constants.js';
import { safeUrl } from '../../core/dom.js';
import { safeMount, pageHead, needs, searchField, exportCsv } from '../lib/ui.js';
import { stockBadge, productStock, productPriceHtml, PRODUCT_CSV_HEADERS, productCsvRow } from '../lib/catalogUi.js';
import { loadAdminCatalog, viewProducts, invalidateAdminCatalog } from '../data/catalogAdmin.js';
import { setProductsStatus, deleteProduct } from '../data/products.js';
import { deleteProductImage } from '../lib/images.js';

registerBoth({
  'prd.title': ['Products', 'প্রোডাক্ট'],
  'prd.sub': ['Everything you sell: prices, stock and visibility', 'আপনি যা বিক্রি করেন: দাম, স্টক ও দৃশ্যমানতা'],
  'prd.add': ['Add product', 'নতুন প্রোডাক্ট'],
  'prd.export': ['Export CSV', 'CSV এক্সপোর্ট'],
  'prd.search': ['Name, SKU or tag…', 'নাম, SKU বা ট্যাগ…'],
  'prd.f.status': ['Status', 'অবস্থা'],
  'prd.f.allStatus': ['All statuses', 'সব অবস্থা'],
  'prd.f.cat': ['Category', 'ক্যাটাগরি'],
  'prd.f.allCat': ['All categories', 'সব ক্যাটাগরি'],
  'prd.f.noCat': ['No category', 'ক্যাটাগরি নেই'],
  'prd.f.stock': ['Stock', 'স্টক'],
  'prd.f.allStock': ['Any stock', 'যেকোনো স্টক'],
  'prd.f.sort': ['Sort by', 'সাজান'],
  'prd.f.clear': ['Clear filters', 'ফিল্টার মুছুন'],
  'prd.sort.new': ['Newest first', 'নতুন আগে'],
  'prd.sort.name': ['Name A–Z', 'নাম A–Z'],
  'prd.sort.priceUp': ['Price: low to high', 'দাম: কম থেকে বেশি'],
  'prd.sort.priceDown': ['Price: high to low', 'দাম: বেশি থেকে কম'],
  'prd.sort.stock': ['Stock: lowest first', 'স্টক: কম আগে'],
  'prd.col.product': ['Product', 'প্রোডাক্ট'],
  'prd.col.category': ['Category', 'ক্যাটাগরি'],
  'prd.col.price': ['Price', 'দাম'],
  'prd.col.stock': ['Stock', 'স্টক'],
  'prd.col.status': ['Status', 'অবস্থা'],
  'prd.col.updated': ['Added', 'যোগ হয়েছে'],
  'prd.select': ['Select {name}', '{name} বাছাই করুন'],
  'prd.selectAll': ['Select all on this page', 'এই পাতার সবগুলো বাছাই করুন'],
  'prd.count_one': ['{n} product', '{n}টি প্রোডাক্ট'],
  'prd.count_other': ['{n} products', '{n}টি প্রোডাক্ট'],
  'prd.selected_one': ['{n} selected', '{n}টি বাছাই করা'],
  'prd.selected_other': ['{n} selected', '{n}টি বাছাই করা'],
  'prd.variants_one': ['{n} variant', '{n}টি ভ্যারিয়েন্ট'],
  'prd.variants_other': ['{n} variants', '{n}টি ভ্যারিয়েন্ট'],
  'prd.avail': ['{n} available', '{n}টি আছে'],
  'prd.legacy': ['Old format', 'পুরনো ফরম্যাট'],
  'prd.legacyNote_one': ['{n} product from the old site is not migrated yet. It is shown in the store, but it cannot be edited here until the migration has run.', 'পুরনো সাইটের {n}টি প্রোডাক্ট এখনো মাইগ্রেট হয়নি। স্টোরে দেখা যাচ্ছে, কিন্তু মাইগ্রেশন চালানোর আগে এখানে এডিট করা যাবে না।'],
  'prd.legacyNote_other': ['{n} products from the old site are not migrated yet. They are shown in the store, but they cannot be edited here until the migration has run.', 'পুরনো সাইটের {n}টি প্রোডাক্ট এখনো মাইগ্রেট হয়নি। স্টোরে দেখা যাচ্ছে, কিন্তু মাইগ্রেশন চালানোর আগে এখানে এডিট করা যাবে না।'],
  'prd.legacyGo': ['Open the Setup page', 'সেটআপ পেজ খুলুন'],
  'prd.truncated': ['The catalog is larger than what this page loads. Use the search to find a specific product.', 'ক্যাটালগ এই পাতার লোড-সীমার চেয়ে বড়। নির্দিষ্ট প্রোডাক্ট খুঁজতে সার্চ ব্যবহার করুন।'],
  'prd.bulk.publish': ['Publish', 'প্রকাশ করুন'],
  'prd.bulk.draft': ['Move to draft', 'ড্রাফটে নিন'],
  'prd.bulk.archive': ['Archive', 'আর্কাইভ করুন'],
  'prd.bulk.clear': ['Clear selection', 'বাছাই মুছুন'],
  'prd.bulk.title': ['{label} {n} products?', '{n}টি প্রোডাক্ট: {label}?'],
  'prd.bulk.msgPublish': ['Published products appear in the store straight away.', 'প্রকাশিত প্রোডাক্ট সঙ্গে সঙ্গে স্টোরে দেখা যাবে।'],
  'prd.bulk.msgHide': ['Draft and archived products disappear from the store; open orders are not affected.', 'ড্রাফট ও আর্কাইভ করা প্রোডাক্ট স্টোর থেকে সরে যাবে; খোলা অর্ডারে কোনো প্রভাব পড়বে না।'],
  'prd.bulk.done': ['{n} products updated.', '{n}টি প্রোডাক্ট হালনাগাদ হয়েছে।'],
  'prd.bulk.skipped': ['Skipped {n}: old-format or already in that status.', '{n}টি বাদ গেছে: পুরনো ফরম্যাট অথবা আগে থেকেই ওই অবস্থায় আছে।'],
  'prd.bulk.nothing': ['Nothing to change for the selected products.', 'বাছাই করা প্রোডাক্টে বদলানোর কিছু নেই।'],
  'prd.menu.edit': ['Edit', 'সম্পাদনা'],
  'prd.menu.view': ['View in store', 'স্টোরে দেখুন'],
  'prd.menu.dup': ['Duplicate', 'ডুপ্লিকেট'],
  'prd.menu.publish': ['Publish', 'প্রকাশ করুন'],
  'prd.menu.draft': ['Move to draft', 'ড্রাফটে নিন'],
  'prd.menu.archive': ['Archive', 'আর্কাইভ করুন'],
  'prd.menu.delete': ['Delete', 'মুছুন'],
  'prd.menu.more': ['Actions for {name}', '{name}-এর অ্যাকশন'],
  'prd.status.done': ['Status updated.', 'অবস্থা বদলেছে।'],
  'prd.del.title': ['Delete "{name}"?', '"{name}" মুছবেন?'],
  'prd.del.msg': ['The product, its stock records and its search entries are removed. Old orders keep their own copy of what was bought. This cannot be undone — to just hide it, archive it instead.', 'প্রোডাক্ট, তার স্টক রেকর্ড ও সার্চ এন্ট্রি মুছে যাবে। পুরনো অর্ডারে কেনা জিনিসের নিজস্ব কপি থাকবে। এটি ফেরানো যায় না — শুধু লুকাতে চাইলে বরং আর্কাইভ করুন।'],
  'prd.del.done': ['Product deleted.', 'প্রোডাক্ট মুছে গেছে।'],
  'prd.empty': ['No products yet', 'এখনো কোনো প্রোডাক্ট নেই'],
  'prd.emptyText': ['Add your first product to start selling.', 'বিক্রি শুরু করতে প্রথম প্রোডাক্টটি যোগ করুন।'],
  'prd.noMatch': ['No product matches', 'কোনো প্রোডাক্ট মেলেনি'],
  'prd.noMatchText': ['Try a different word or clear the filters.', 'অন্য শব্দ দিয়ে খুঁজুন অথবা ফিল্টার মুছুন।'],
  'prd.noImage': ['No image', 'ছবি নেই'],
  'prd.failed': ['The change failed.', 'পরিবর্তন করা যায়নি।'],
});

const PAGE_SIZE = 25;
const STATUS_IDS = Object.keys(PRODUCT_STATUS);
const STOCK_FILTERS = ['in_stock', 'low', 'out', 'backorder', 'untracked'];
const SORTS = ['new', 'name', 'priceUp', 'priceDown', 'stock'];

function readQuery(q = {}) {
  return {
    q: String(q.q || '').slice(0, 80),
    status: STATUS_IDS.includes(q.status) ? q.status : '',
    cat: String(q.cat || '').slice(0, 80),
    stock: STOCK_FILTERS.includes(q.stock) ? q.stock : '',
    sort: SORTS.includes(q.sort) ? q.sort : 'new',
    page: Math.max(1, parseInt(q.page, 10) || 1),
  };
}
const toQuery = (f) => Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== '' && !(k === 'page' && v === 1) && !(k === 'sort' && v === 'new')));
const option = (value, label, cur) => html`<option value="${value}" ${value === cur ? raw('selected') : ''}>${label}</option>`;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'products.read')) return;
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      let cat = await loadAdminCatalog();
      if (ctx.signal.aborted) return;
      let views = viewProducts(cat);
      let f = readQuery(ctx.query);
      const selected = new Set();
      const canWrite = can('products.write');
      const canDelete = can('products.delete');

      const reloadCatalog = async () => { invalidateAdminCatalog(); cat = await loadAdminCatalog({ force: true }); views = viewProducts(cat); };
      const byId = (id) => views.find((v) => v.id === id);
      const haystack = new Map();
      const hay = (v) => { if (!haystack.has(v.id)) haystack.set(v.id, [v.name, v.slug, v.categoryName, v.brandName, ...v.tags, ...v.units.map((u) => u.sku)].join(' ').toLowerCase()); return haystack.get(v.id); };

      const matches = (v) => {
        if (f.status && v.status !== f.status) return false;
        if (f.cat === '_none' ? !!v.categoryId : (f.cat && v.categoryId !== f.cat)) return false;
        if (f.stock) {
          const s = productStock(v);
          if (f.stock === 'untracked' ? s.tracked : (!s.tracked || v.stockState !== f.stock)) return false;
        }
        const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
        return words.every((w) => hay(v).includes(w));
      };
      const sorters = {
        new: (a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0) || a.name.localeCompare(b.name),
        name: (a, b) => a.name.localeCompare(b.name),
        priceUp: (a, b) => a.minPrice - b.minPrice,
        priceDown: (a, b) => b.minPrice - a.minPrice,
        stock: (a, b) => { const x = productStock(a); const y = productStock(b); return (x.tracked ? x.available : Infinity) - (y.tracked ? y.available : Infinity) || a.name.localeCompare(b.name); },
      };
      const filtered = () => views.filter(matches).sort(sorters[f.sort]);
      const pageOf = (list) => { const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE)); const page = Math.min(f.page, pages); return { pages, page, rows: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) }; };
      const hasFilter = () => !!(f.q || f.status || f.cat || f.stock);
      const legacyCount = () => views.filter((v) => v.isLegacy).length;

      const rowHtml = (v) => {
        const s = productStock(v);
        return html`<tr>
          <td class="col-check"><input type="checkbox" data-change="toggle" data-id="${v.id}" ${selected.has(v.id) ? raw('checked') : ''} aria-label="${t('prd.select', { name: v.name })}"></td>
          <td class="cell-first"><div class="cell-main">
            ${v.thumb ? html`<img class="thumb" src="${safeUrl(v.thumb)}" alt="" width="44" height="44" loading="lazy">` : html`<span class="thumb" role="img" aria-label="${t('prd.noImage')}"></span>`}
            <div><a class="t" href="${href('/products/' + encodeURIComponent(v.id))}">${v.name}</a>
              <div class="s">${v.type === 'variable' ? tn('prd.variants', v.units.length, { n: num(v.units.length) }) : (v.sku || '—')}</div></div></div></td>
          <td data-label="${t('prd.col.category')}">${v.categoryName || '—'}</td>
          <td data-label="${t('prd.col.price')}" class="num">${productPriceHtml(v)}</td>
          <td data-label="${t('prd.col.stock')}">${stockBadge(s.tracked ? v.stockState : (v.stockState === 'unavailable' ? 'unavailable' : 'untracked'))}${s.tracked ? html`<span class="cell-sub">${t('prd.avail', { n: num(s.available) })}</span>` : ''}</td>
          <td data-label="${t('prd.col.status')}">${productStatusBadge(v.status)}${v.isLegacy ? html` ${badge(t('prd.legacy'), 'warn')}` : ''}</td>
          <td class="col-actions"><button type="button" class="btn btn-ghost btn-icon" data-action="row-menu" data-id="${v.id}" aria-haspopup="menu" aria-label="${t('prd.menu.more', { name: v.name })}">${icon('more-horizontal', { size: 18 })}</button></td>
        </tr>`;
      };

      const bulkHtml = () => {
        const n = [...selected].filter(byId).length;
        if (!n || !canWrite) return '';
        return html`<div class="bulk-bar" role="region" aria-label="${tn('prd.selected', n, { n: num(n) })}">
          <span>${tn('prd.selected', n, { n: num(n) })}</span>
          <button type="button" class="btn btn-sm btn-primary" data-action="bulk" data-to="published">${t('prd.bulk.publish')}</button>
          <button type="button" class="btn btn-sm" data-action="bulk" data-to="draft">${t('prd.bulk.draft')}</button>
          <button type="button" class="btn btn-sm" data-action="bulk" data-to="archived">${t('prd.bulk.archive')}</button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="bulk-clear">${t('prd.bulk.clear')}</button>
        </div>`;
      };

      const resultsHtml = () => {
        const list = filtered();
        const { pages, page, rows } = pageOf(list);
        f.page = page;
        const legacy = legacyCount();
        return html`
          ${legacy ? html`<p class="alert alert-warn mb-4">${icon('alert-triangle', { size: 18 })}<span>${tn('prd.legacyNote', legacy, { n: num(legacy) })} ${can('migrate.run') ? html`<a href="${href('/setup')}">${t('prd.legacyGo')}</a>` : ''}</span></p>` : ''}
          ${cat.truncated ? html`<p class="alert alert-warn mb-4">${icon('alert-triangle', { size: 18 })}<span>${t('prd.truncated')}</span></p>` : ''}
          ${bulkHtml()}
          ${rows.length ? html`<div class="table-wrap"><table class="table table-stack table-cards">
            <thead><tr>
              <th class="col-check"><input type="checkbox" data-change="toggleAll" aria-label="${t('prd.selectAll')}" ${rows.every((v) => selected.has(v.id)) ? raw('checked') : ''}></th>
              <th scope="col">${t('prd.col.product')}</th><th scope="col">${t('prd.col.category')}</th><th scope="col" class="num">${t('prd.col.price')}</th>
              <th scope="col">${t('prd.col.stock')}</th><th scope="col">${t('prd.col.status')}</th><th scope="col" class="col-actions"><span class="sr-only">${t('common.actions')}</span></th>
            </tr></thead>
            <tbody>${rows.map(rowHtml)}</tbody></table>
            <div class="table-footer"><span>${tn('prd.count', list.length, { n: num(list.length) })}</span>${paginationHtml({ page, pages, action: 'page' })}</div>
          </div>`
          : (views.length ? emptyState({ icon: 'search', title: t('prd.noMatch'), text: t('prd.noMatchText') })
            : emptyState({ icon: 'package', title: t('prd.empty'), text: t('prd.emptyText'), action: canWrite ? { label: t('prd.add'), href: href('/products/new') } : null }))}`;
      };
      const paint = () => { const host = ctx.el.querySelector('#prd-results'); if (host) render(host, resultsHtml()); };

      const addBtn = canWrite ? html`<a class="btn btn-primary" href="${href('/products/new')}">${icon('plus', { size: 16 })}<span>${t('prd.add')}</span></a>` : null;
      const shell = () => html`<div class="products-page">
        ${pageHead({ title: t('prd.title'), sub: t('prd.sub'), actions: html`<button type="button" class="btn" data-action="export">${icon('download', { size: 16 })}<span>${t('prd.export')}</span></button>${addBtn || ''}` })}
        <div class="toolbar" role="search">
          ${searchField({ id: 'q', value: f.q, placeholder: t('prd.search'), label: t('prd.search'), bind: 'q' })}
          <select class="select" data-change="status" aria-label="${t('prd.f.status')}">${option('', t('prd.f.allStatus'), f.status)}${STATUS_IDS.map((id) => option(id, lbl(PRODUCT_STATUS[id]), f.status))}</select>
          <select class="select" data-change="cat" aria-label="${t('prd.f.cat')}">${option('', t('prd.f.allCat'), f.cat)}${option('_none', t('prd.f.noCat'), f.cat)}${cat.categories.map((c) => option(c.id, c.name, f.cat))}</select>
          <select class="select" data-change="stock" aria-label="${t('prd.f.stock')}">${option('', t('prd.f.allStock'), f.stock)}${STOCK_FILTERS.map((s) => option(s, t(`stk.${s}`), f.stock))}</select>
          <select class="select" data-change="sort" aria-label="${t('prd.f.sort')}">${SORTS.map((s) => option(s, t(`prd.sort.${s}`), f.sort))}</select>
          <button type="button" class="btn btn-ghost" data-action="clear" ${hasFilter() ? '' : raw('hidden')}>${icon('x', { size: 16 })}<span>${t('prd.f.clear')}</span></button>
        </div>
        <div id="prd-results" aria-live="polite"></div>
      </div>`;
      render(ctx.el, shell());
      paint();

      const syncUrl = () => ctx.router.setQuery(toQuery(f));
      const setFilters = (patch) => {
        f = { ...f, ...patch, page: patch.page || 1 };
        syncUrl();
        const clear = ctx.el.querySelector('[data-action="clear"]');
        if (clear) clear.hidden = !hasFilter();
        paint();
      };

      /* ── status changes and delete ── */
      const changeStatus = async (list, to, { confirm = true } = {}) => {
        const targets = list.filter((v) => !v.isLegacy && v.status !== to);
        if (!targets.length) { toastError(t('prd.bulk.nothing')); return; }
        const label = t(`prd.bulk.${to === 'published' ? 'publish' : to === 'draft' ? 'draft' : 'archive'}`);
        if (confirm && !(await confirmDialog({ title: t('prd.bulk.title', { label, n: num(targets.length) }), message: to === 'published' ? t('prd.bulk.msgPublish') : t('prd.bulk.msgHide'), confirmText: label }))) return;
        try {
          const res = await setProductsStatus(targets.map((v) => ({ id: v.id, data: v.raw })), to);
          await reloadCatalog();
          selected.clear();
          paint();
          toast(t('prd.bulk.done', { n: num(res.changed) }));
          if (list.length > res.changed) toast(t('prd.bulk.skipped', { n: num(list.length - res.changed) }), { timeout: 5000 });
        } catch (e) { if (!isRefusal(e)) reportError(e, 'products.status'); toastError(`${t('prd.failed')} ${explainError(e)}`); }
      };
      const remove = async (v) => {
        if (!(await confirmDialog({ title: t('prd.del.title', { name: v.name }), message: t('prd.del.msg'), confirmText: t('prd.menu.delete'), danger: true }))) return;
        try {
          const { images } = await deleteProduct(v.id);
          for (const img of images) deleteProductImage(img).catch(() => {});          // best effort; the product is already gone
          await reloadCatalog();
          selected.delete(v.id);
          paint();
          toast(t('prd.del.done'));
        } catch (e) { if (!isRefusal(e)) reportError(e, 'products.delete'); toastError(explainError(e)); }
      };

      ctx.cleanup(bindActions(ctx.el, {
        page: (el) => { f.page = Number(el.dataset.page) || 1; syncUrl(); paint(); ctx.el.querySelector('.products-page')?.scrollIntoView({ block: 'start' }); },
        clear: () => { f = readQuery({}); selected.clear(); render(ctx.el, shell()); paint(); syncUrl(); },
        export: () => exportCsv(`products-${dhakaDayKey(Date.now())}.csv`, PRODUCT_CSV_HEADERS, filtered().map(productCsvRow)),
        'bulk-clear': () => { selected.clear(); paint(); },
        bulk: (btn) => withBusy(btn, () => changeStatus([...selected].map(byId).filter(Boolean), btn.dataset.to)),
        'row-menu': (btn) => {
          const v = byId(btn.dataset.id);
          if (!v) return;
          const items = [{ label: t('prd.menu.edit'), icon: 'edit', href: href('/products/' + encodeURIComponent(v.id)) }];
          if (v.status === 'published') items.push({ label: t('prd.menu.view'), icon: 'external-link', href: `/product/${encodeURIComponent(v.slug)}`, native: true });
          if (canWrite) {
            items.push({ label: t('prd.menu.dup'), icon: 'copy', href: href(`/products/new?from=${encodeURIComponent(v.id)}`) });
            if (!v.isLegacy) {
              items.push({ divider: true });
              if (v.status !== 'published') items.push({ label: t('prd.menu.publish'), icon: 'check', onClick: () => changeStatus([v], 'published', { confirm: false }) });
              if (v.status !== 'draft') items.push({ label: t('prd.menu.draft'), icon: 'edit', onClick: () => changeStatus([v], 'draft', { confirm: false }) });
              if (v.status !== 'archived') items.push({ label: t('prd.menu.archive'), icon: 'archive', onClick: () => changeStatus([v], 'archived', { confirm: false }) });
            }
          }
          if (canDelete) items.push({ divider: true }, { label: t('prd.menu.delete'), icon: 'trash', danger: true, onClick: () => remove(v) });
          openMenu({ anchor: btn, items });
        },
      }, {
        change: {
          status: (el) => setFilters({ status: el.value }),
          cat: (el) => setFilters({ cat: el.value }),
          stock: (el) => setFilters({ stock: el.value }),
          sort: (el) => setFilters({ sort: el.value }),
          toggle: (el) => { if (el.checked) selected.add(el.dataset.id); else selected.delete(el.dataset.id); paint(); },
          toggleAll: (el) => { const { rows } = pageOf(filtered()); for (const v of rows) { if (el.checked) selected.add(v.id); else selected.delete(v.id); } paint(); },
        },
        input: { q: debounce((el) => setFilters({ q: el.value.trim() }), 250) },
      }));
    });
  },
};
