/*
 * Product listing — /shop, /search?q=, /category/:slug, /brand/:slug (route.meta.kind picks the flavour).
 * Filters live in the URL (shareable, back button friendly): ?q= &sort= &page= &min= &max= &sale=1 &stock=1 &brand=<slug> &cat=<slug>
 * Everything is computed in the browser from the preloaded catalog; router.setQuery updates the URL without re-mounting.
 */
import { html, render, raw, bindActions, readForm, setMeta, aria } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, openDrawer, emptyState, errorState, skeletonCards, paginationHtml, announce } from '../../core/ui.js';
import { num } from '../../core/format.js';
import { descendantIds } from '../../shared/productModel.js';
import { loadCatalog, queryProducts, priceBounds, categoryBySlug, brandBySlug, categoryPath, SORTS } from '../../data/catalog.js';
import { productGrid, bindProductCards } from '../components/productCard.js';
import { categoryUrl, absoluteUrl } from '../lib/links.js';

registerBoth({
  'shop.title.all': ['All products', 'সব পণ্য'],
  'shop.title.search': ['Search', 'সার্চ'],
  'shop.resultsFor': ['Results for "{q}"', '"{q}" এর ফলাফল'],
  'shop.count': ['{n} products', '{n}টি পণ্য'],
  'shop.sort': ['Sort by', 'সাজান'],
  'shop.sort.relevance': ['Best match', 'সবচেয়ে মিল'],
  'shop.sort.newest': ['Newest', 'নতুন আগে'],
  'shop.sort.popular': ['Most popular', 'জনপ্রিয়'],
  'shop.sort.rating': ['Top rated', 'সেরা রেটিং'],
  'shop.sort.price_asc': ['Price: low to high', 'দাম: কম থেকে বেশি'],
  'shop.sort.price_desc': ['Price: high to low', 'দাম: বেশি থেকে কম'],
  'shop.sort.name': ['Name A–Z', 'নাম (A–Z)'],
  'shop.filters': ['Filters', 'ফিল্টার'],
  'shop.category': ['Category', 'ক্যাটাগরি'],
  'shop.allCategories': ['All categories', 'সব ক্যাটাগরি'],
  'shop.brand': ['Brand', 'ব্র্যান্ড'],
  'shop.price': ['Price', 'দাম'],
  'shop.min': ['Min', 'সর্বনিম্ন'],
  'shop.max': ['Max', 'সর্বোচ্চ'],
  'shop.apply': ['Apply', 'প্রয়োগ'],
  'shop.onSale': ['On sale', 'ছাড়ে পাওয়া যাচ্ছে'],
  'shop.inStock': ['In stock only', 'শুধু স্টকে আছে'],
  'shop.clear': ['Clear all filters', 'সব ফিল্টার মুছুন'],
  'shop.remove': ['Remove filter: {name}', 'ফিল্টার সরান: {name}'],
  'shop.chipPrice': ['Price {range}', 'দাম {range}'],
  'shop.showResults': ['Show {n} products', '{n}টি পণ্য দেখুন'],
  'shop.empty': ['No products found', 'কোনো পণ্য পাওয়া যায়নি'],
  'shop.emptyText': ['Try removing a filter or searching for something else.', 'কোনো ফিল্টার সরিয়ে দেখুন অথবা অন্য কিছু খুঁজুন।'],
  'shop.emptyStore': ['The shop is being stocked. Please check back soon.', 'শপে পণ্য যোগ করা হচ্ছে। একটু পরে আবার দেখুন।'],
  'shop.notFound': ['We could not find that page', 'এই পেজটি পাওয়া যায়নি'],
  'shop.backToShop': ['Browse all products', 'সব পণ্য দেখুন'],
  'shop.crumbHome': ['Home', 'হোম'],
  'shop.crumbs': ['Breadcrumb', 'পেজ পথ'],
  'shop.loadError': ['Products could not be loaded.', 'পণ্যের তালিকা লোড করা যায়নি।'],
  'shop.updated': ['{n} products shown', '{n}টি পণ্য দেখানো হচ্ছে'],
  'shop.metaDesc': ['Shop {name} online. Cash on Delivery, bKash and Nagad accepted.', 'অনলাইনে {name} কিনুন। ক্যাশ অন ডেলিভারি, বিকাশ ও নগদে পেমেন্ট।'],
});

const PAGE_SIZE = 24;
const numOrEmpty = (v) => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : '';
};

function readState(q, kind) {
  return {
    q: kind === 'search' ? String(q.q || '').slice(0, 80) : '',
    sort: SORTS.includes(q.sort) ? q.sort : '',
    page: Math.max(1, parseInt(q.page, 10) || 1),
    min: numOrEmpty(q.min), max: numOrEmpty(q.max),
    sale: q.sale === '1', stock: q.stock === '1',
    brand: String(q.brand || ''), cat: String(q.cat || ''),
  };
}
const queryOf = (s) => ({
  q: s.q || undefined, sort: s.sort || undefined, page: s.page > 1 ? s.page : undefined,
  min: s.min || undefined, max: s.max || undefined, sale: s.sale || undefined, stock: s.stock || undefined,
  brand: s.brand || undefined, cat: s.cat || undefined,
});

function resolveBase(cat, kind, params) {
  if (kind === 'category') { const c = categoryBySlug(cat, params.slug); return c ? { kind, category: c } : { missing: true }; }
  if (kind === 'brand') { const b = brandBySlug(cat, params.slug); return b ? { kind, brand: b } : { missing: true }; }
  return { kind };
}

/** Run `fn`, then put keyboard focus back on the control (data-fkey) that had it — the facets re-render under the user's fingers. */
function keepFocus(root, fn) {
  const a = document.activeElement;
  const key = a && root.contains(a) && a.dataset ? a.dataset.fkey : '';
  fn();
  if (key) { const n = root.querySelector(`[data-fkey="${CSS.escape(key)}"]`); if (n) n.focus({ preventScroll: true }); }
}

export default {
  async mount(ctx) {
    loadCss('/css/pages/shop.css');
    const kind = (ctx.route.meta && ctx.route.meta.kind) || 'all';
    render(ctx.el, html`<div class="container page"><div class="product-grid">${skeletonCards(8)}</div></div>`);

    let cat;
    try { cat = await loadCatalog(); } catch (e) {
      if (ctx.signal.aborted) return;
      render(ctx.el, html`<div class="container page">${errorState({ text: t('shop.loadError') })}</div>`);
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;

    const base = resolveBase(cat, kind, ctx.params);
    if (base.missing) {
      setMeta({ title: t('shop.notFound'), noindex: true });
      render(ctx.el, html`<div class="container page">${emptyState({ icon: 'search', title: t('shop.notFound'), action: { href: '/shop', label: t('shop.backToShop') } })}</div>`);
      return;
    }

    const st = readState(ctx.query, kind);
    const defaultSort = kind === 'search' && st.q ? 'relevance' : 'newest';
    const sortOptions = SORTS.filter((s) => s !== 'relevance' || (kind === 'search' && st.q));
    let drawer = null;
    let offDrawer = () => {};
    let first = true;

    const heading = () => (base.category ? base.category.name : base.brand ? base.brand.name
      : kind === 'search' ? (st.q ? t('shop.resultsFor', { q: st.q }) : t('shop.title.search')) : t('shop.title.all'));

    render(ctx.el, html`<div class="container page shop">
      <nav class="crumbs" id="shop-crumbs" aria-label="${t('shop.crumbs')}"></nav>
      <header class="shop-head"><h1 class="page-title" id="shop-title"></h1><p class="muted" id="shop-count" aria-live="polite"></p></header>
      <div class="shop-bar">
        <button type="button" class="btn btn-secondary shop-filter-btn" data-action="openFilters">${icon('sliders', { size: 18 })}<span>${t('shop.filters')}</span><span class="shop-badge" id="shop-fcount" hidden></span></button>
        <label class="shop-sort"><span class="muted small">${t('shop.sort')}</span>
          <select class="select input-sm" id="shop-sort" data-change="sort">${sortOptions.map((s) => html`<option value="${s}">${t(`shop.sort.${s}`)}</option>`)}</select>
        </label>
      </div>
      <div class="shop-layout">
        <aside class="shop-side" id="shop-side" aria-label="${t('shop.filters')}"></aside>
        <section class="shop-main"><div class="shop-chips" id="shop-chips"></div><div id="shop-grid"></div><div id="shop-pager"></div></section>
      </div>
    </div>`);
    const $ = (id) => ctx.el.querySelector(`#${id}`);

    /* ───────── derived data ───────── */
    const effective = () => {
      const category = base.category || (st.cat ? categoryBySlug(cat, st.cat) : null);
      const brand = base.brand || (st.brand ? brandBySlug(cat, st.brand) : null);
      return { q: st.q, categoryId: category ? category.id : '', brandId: brand ? brand.id : '', min: st.min, max: st.max, onSale: st.sale, inStock: st.stock, sort: st.sort || undefined, category, brand };
    };
    const view = () => {
      const f = effective();
      const all = queryProducts(cat, f);
      const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      if (st.page > pages) st.page = pages;
      const slice = all.slice((st.page - 1) * PAGE_SIZE, st.page * PAGE_SIZE);
      // facets are computed from the products matching the search text (so counts stay meaningful)
      const pool = st.q ? queryProducts(cat, { q: st.q }) : cat.products;
      const parentId = base.category ? base.category.id : null;
      const catItems = cat.categories.filter((c) => (parentId ? c.parentId === parentId : !c.parentId))
        .map((c) => { const ids = new Set(descendantIds(cat.categories, c.id)); return { c, n: pool.filter((p) => ids.has(p.categoryId)).length }; })
        .filter((x) => x.n > 0);
      const inCat = f.category ? new Set(descendantIds(cat.categories, f.category.id)) : null;
      const brandPool = inCat ? pool.filter((p) => inCat.has(p.categoryId)) : pool;
      const brandItems = base.brand ? [] : cat.brands.map((b) => ({ b, n: brandPool.filter((p) => p.brandId === b.id).length })).filter((x) => x.n > 0);
      return { f, all, pages, slice, catItems, brandItems, bounds: priceBounds(pool) };
    };
    const activeFilters = () => {
      const f = effective();
      const out = [];
      if (!base.category && f.category) out.push({ key: 'cat', label: f.category.name });
      if (!base.brand && f.brand) out.push({ key: 'brand', label: f.brand.name });
      if (st.min !== '' || st.max !== '') out.push({ key: 'price', label: t('shop.chipPrice', { range: `${st.min !== '' ? num(st.min) : '0'} – ${st.max !== '' ? num(st.max) : '∞'}` }) });
      if (st.sale) out.push({ key: 'sale', label: t('shop.onSale') });
      if (st.stock) out.push({ key: 'stock', label: t('shop.inStock') });
      return out;
    };

    /* ───────── views ───────── */
    const facetsHtml = (v) => html`
      <section class="facet"><h2 class="facet-title">${t('shop.category')}</h2>${base.category ? html`<ul class="facet-list">
          <li><a href="${base.category.parentId && cat.catById[base.category.parentId] ? categoryUrl(cat.catById[base.category.parentId]) : '/shop'}">${icon('chevron-left', { size: 14 })}<span>${base.category.parentId && cat.catById[base.category.parentId] ? cat.catById[base.category.parentId].name : t('shop.allCategories')}</span></a></li>
          <li class="facet-current"><strong>${base.category.name}</strong></li>
          ${v.catItems.map(({ c, n }) => html`<li class="facet-sub"><a href="${categoryUrl(c)}"><span>${c.name}</span><span class="muted">${num(n)}</span></a></li>`)}
        </ul>` : html`<ul class="facet-list">
          <li><button type="button" class="facet-btn ${st.cat ? '' : 'is-active'}" data-action="setCat" data-slug="" data-fkey="cat-all" aria-pressed="${aria(!st.cat)}"><span>${t('shop.allCategories')}</span></button></li>
          ${v.catItems.map(({ c, n }) => html`<li><button type="button" class="facet-btn ${st.cat === c.slug ? 'is-active' : ''}" data-action="setCat" data-slug="${c.slug}" data-fkey="cat-${c.slug}" aria-pressed="${aria(st.cat === c.slug)}"><span>${c.name}</span><span class="muted">${num(n)}</span></button></li>`)}
        </ul>`}</section>
      ${v.brandItems.length ? html`<section class="facet"><h2 class="facet-title">${t('shop.brand')}</h2><ul class="facet-list">
        ${v.brandItems.map(({ b, n }) => html`<li><button type="button" class="facet-btn ${st.brand === b.slug ? 'is-active' : ''}" data-action="setBrand" data-slug="${b.slug}" data-fkey="brand-${b.slug}" aria-pressed="${aria(st.brand === b.slug)}"><span>${b.name}</span><span class="muted">${num(n)}</span></button></li>`)}
      </ul></section>` : ''}
      <section class="facet"><h2 class="facet-title">${t('shop.price')}</h2>
        <form class="facet-price" data-form="price" novalidate>
          <input class="input input-sm" type="number" inputmode="numeric" min="0" name="min" value="${st.min}" placeholder="${v.bounds.max ? num(v.bounds.min) : t('shop.min')}" aria-label="${t('shop.min')}" data-fkey="min">
          <span aria-hidden="true">–</span>
          <input class="input input-sm" type="number" inputmode="numeric" min="0" name="max" value="${st.max}" placeholder="${v.bounds.max ? num(v.bounds.max) : t('shop.max')}" aria-label="${t('shop.max')}" data-fkey="max">
          <button type="submit" class="btn btn-secondary btn-sm">${t('shop.apply')}</button>
        </form></section>
      <section class="facet facet-checks">
        <label class="check"><input type="checkbox" data-change="sale" data-fkey="sale" ${st.sale ? raw('checked') : ''}><span>${t('shop.onSale')}</span></label>
        <label class="check"><input type="checkbox" data-change="stock" data-fkey="stock" ${st.stock ? raw('checked') : ''}><span>${t('shop.inStock')}</span></label>
      </section>`;

    const crumbsHtml = () => {
      const items = [{ href: '/', label: t('shop.crumbHome') }];
      if (base.category) categoryPath(cat, base.category.id).forEach((c, i, a) => items.push({ href: i < a.length - 1 ? categoryUrl(c) : '', label: c.name }));
      else items.push({ href: '', label: heading() });
      return html`<ol>${items.map((it) => (it.href ? html`<li><a href="${it.href}">${it.label}</a></li>` : html`<li aria-current="page">${it.label}</li>`))}</ol>`;
    };

    const chipsHtml = () => {
      const list = activeFilters();
      if (!list.length) return html``;
      return html`${list.map((c) => html`<button type="button" class="chip" data-action="clearOne" data-key="${c.key}" aria-label="${t('shop.remove', { name: c.label })}"><span>${c.label}</span>${icon('x', { size: 14 })}</button>`)}
        <button type="button" class="btn-link shop-clear" data-action="clearAll">${t('shop.clear')}</button>`;
    };

    const emptyView = () => (cat.products.length === 0
      ? emptyState({ icon: 'package', title: t('shop.empty'), text: t('shop.emptyStore') })
      : emptyState({
        icon: 'search', title: t('shop.empty'), text: t('shop.emptyText'),
        action: activeFilters().length ? { href: '#', act: 'clearAll', label: t('shop.clear') } : { href: '/shop', label: t('shop.backToShop') },
      }));

    /* ───────── paint ───────── */
    const paint = () => {
      const v = view();
      const filters = activeFilters();
      keepFocus(ctx.el, () => {
        render($('shop-crumbs'), crumbsHtml());
        $('shop-title').textContent = heading();
        $('shop-count').textContent = t('shop.count', { n: num(v.all.length) });
        render($('shop-side'), facetsHtml(v));
        render($('shop-chips'), chipsHtml());
        render($('shop-grid'), v.slice.length ? productGrid(v.slice) : emptyView());
        render($('shop-pager'), paginationHtml({ page: st.page, pages: v.pages }));
      });
      $('shop-sort').value = st.sort && sortOptions.includes(st.sort) ? st.sort : defaultSort;
      const badge = $('shop-fcount');
      badge.hidden = filters.length === 0;
      badge.textContent = filters.length ? num(filters.length) : '';
      if (drawer) {
        keepFocus(drawer.el, () => drawer.setBody(facetsHtml(v)));
        drawer.setFooter(html`<button type="button" class="btn btn-primary btn-block" data-action="closeFilters">${t('shop.showResults', { n: num(v.all.length) })}</button>`);
      }
      const title = heading();
      setMeta({
        title: kind === 'search' && !st.q ? t('shop.title.search') : title,
        description: base.category && base.category.description ? String(base.category.description).slice(0, 160) : t('shop.metaDesc', { name: title }),
        canonical: absoluteUrl(ctx.path),
        noindex: kind === 'search',
        jsonLd: base.category ? {
          '@context': 'https://schema.org', '@type': 'BreadcrumbList',
          itemListElement: categoryPath(cat, base.category.id).map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: absoluteUrl(categoryUrl(c)) })),
        } : undefined,
      });
      if (!first) announce(t('shop.updated', { n: num(v.all.length) }));
      first = false;
    };

    /* ───────── behaviour ───────── */
    const sync = ({ resetPage = true } = {}) => {
      if (resetPage) st.page = 1;
      ctx.router.setQuery(queryOf(st));
      paint();
    };
    const actions = {
      setCat: (el) => { st.cat = el.dataset.slug || ''; sync(); },
      setBrand: (el) => { st.brand = st.brand === el.dataset.slug ? '' : el.dataset.slug; sync(); },
      clearOne: (el) => {
        const k = el.dataset.key;
        if (k === 'price') { st.min = ''; st.max = ''; } else if (k === 'sale') st.sale = false; else if (k === 'stock') st.stock = false; else st[k] = '';
        sync();
      },
      clearAll: () => { Object.assign(st, { min: '', max: '', sale: false, stock: false, brand: '', cat: '' }); sync(); },
      page: (el) => {
        st.page = Math.max(1, Number(el.dataset.page) || 1);
        sync({ resetPage: false });
        const top = $('shop-title');
        if (top) top.scrollIntoView({ block: 'start' });
      },
      openFilters: () => {
        if (drawer) return;
        const v = view();
        drawer = openDrawer({
          title: t('shop.filters'), side: 'end', body: facetsHtml(v),
          footer: html`<button type="button" class="btn btn-primary btn-block" data-action="closeFilters">${t('shop.showResults', { n: num(v.all.length) })}</button>`,
          onClose: () => { drawer = null; offDrawer(); offDrawer = () => {}; },
        });
        offDrawer = bindActions(drawer.el, { ...actions, closeFilters: () => drawer && drawer.close() }, handlers);
      },
    };
    const handlers = {
      change: {
        sort: (el) => { st.sort = el.value === defaultSort ? '' : el.value; sync(); },
        sale: (el) => { st.sale = el.checked; sync(); },
        stock: (el) => { st.stock = el.checked; sync(); },
      },
      submit: {
        price: (form) => {
          const v = readForm(form);
          st.min = numOrEmpty(v.min); st.max = numOrEmpty(v.max);
          if (st.min !== '' && st.max !== '' && st.min > st.max) [st.min, st.max] = [st.max, st.min];
          sync();
        },
      },
    };

    ctx.cleanup(bindActions(ctx.el, { ...actions, retry: () => ctx.router.reload() }, handlers));
    ctx.cleanup(bindProductCards(ctx.el));
    ctx.cleanup(() => { if (drawer) drawer.close(); });
    paint();
  },
};
