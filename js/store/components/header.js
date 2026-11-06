/*
 * Storefront header (sticky, fixed height) and the announcement bar above it.
 *   mountHeader(el, { router }) → disposer
 * ≥ 1100 px: brand · Shop · Categories · Track · Contact · search · language · theme · wishlist · account · cart
 * <  1100 px: menu · brand · search toggle · cart; the menu opens a left drawer (wishlist / account are in the tab bar and the drawer).
 * The bar re-renders on settings / auth / cart / wishlist / route / language changes; the search box keeps focus and value.
 */
import { html, render, raw, safeUrl, bindActions, debounce, $, aria } from '../../core/dom.js';
import { openDrawer } from '../../core/ui.js';
import { registerBoth, t, getLang, setLang, onLangChange } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { effectiveTheme, toggleTheme } from '../../core/theme.js';
import { session } from '../../core/storage.js';
import { num, money } from '../../core/format.js';
import { STORAGE_KEYS } from '../../shared/constants.js';
import { settings, onSettings } from '../../data/settings.js';
import { getCatalog, loadCatalog, suggestProducts } from '../../data/catalog.js';
import { getAuthState, onAuthChange, isStaff, logout } from '../../data/auth.js';
import { cart } from '../../data/cart.js';
import { wishlist } from '../../data/wishlist.js';
import { productUrl, categoryUrl, searchUrl } from '../lib/links.js';

registerBoth({
  'hdr.menu': ['Menu', 'মেনু'],
  'hdr.mainNav': ['Main menu', 'প্রধান মেনু'],
  'hdr.home': ['Home', 'হোম'],
  'hdr.shop': ['Shop', 'শপ'],
  'hdr.categories': ['Categories', 'ক্যাটাগরি'],
  'hdr.allProducts': ['All products', 'সব পণ্য'],
  'hdr.track': ['Track order', 'অর্ডার ট্র্যাক'],
  'hdr.contact': ['Contact', 'যোগাযোগ'],
  'hdr.search': ['Search', 'অনুসন্ধান'],
  'hdr.searchPh': ['Search products', 'পণ্য খুঁজুন'],
  'hdr.searchAll': ['See all results for "{q}"', '"{q}" এর সব ফলাফল দেখুন'],
  'hdr.cart': ['Cart', 'কার্ট'],
  'hdr.cartN': ['Cart, {n} items', 'কার্ট, {n}টি পণ্য'],
  'hdr.wishlist': ['Wishlist', 'পছন্দের তালিকা'],
  'hdr.account': ['My account', 'আমার অ্যাকাউন্ট'],
  'hdr.orders': ['My orders', 'আমার অর্ডার'],
  'hdr.signin': ['Sign in', 'লগইন'],
  'hdr.signout': ['Sign out', 'লগআউট'],
  'hdr.admin': ['Admin panel', 'অ্যাডমিন প্যানেল'],
  'hdr.lang': ['Change language', 'ভাষা পরিবর্তন'],
  'hdr.langSwitch': ['বাংলা', 'English'],
  'hdr.themeToLight': ['Switch to light theme', 'লাইট থিম চালু করুন'],
  'hdr.themeToDark': ['Switch to dark theme', 'ডার্ক থিম চালু করুন'],
  'hdr.light': ['Light', 'লাইট'],
  'hdr.dark': ['Dark', 'ডার্ক'],
  'hdr.prefs': ['Preferences', 'পছন্দসমূহ'],
  'hdr.dismiss': ['Dismiss', 'বন্ধ করুন'],
});

const THEME_KEY = STORAGE_KEYS.theme;
const ANN_KEY = 'sv.ann';

const initialOf = (s) => {
  const n = (s.profile && s.profile.displayName) || (s.user && (s.user.displayName || s.user.email)) || '';
  return String(n).trim().charAt(0).toUpperCase() || '•';
};
const badgeHtml = (n) => (n > 0 ? html`<span class="hdr-badge" aria-hidden="true">${n > 99 ? '99+' : num(n)}</span>` : '');

async function openAuth() {
  const { openAuthModal } = await import('./authModal.js');
  return openAuthModal({ mode: 'signin' });
}

export function mountHeader(el, { router }) {
  const annEl = document.getElementById('announcement');
  const ui = { searchOpen: false, catsOpen: false, q: '' };
  let drawer = null;
  let offDrawer = () => {};

  const meta = () => (router.current && router.current.route && router.current.route.meta) || {};
  const roots = () => { const c = getCatalog(); return c && c.categoryTree ? c.categoryTree.slice(0, 12) : []; };

  /* ───────── views ───────── */
  const navLink = (id, href, label, m) => {
    const on = id === 'shop' ? m.nav === 'shop' : m.id === id;
    return html`<a class="hdr-link" href="${href}" ${on ? raw('aria-current="page"') : ''}>${label}</a>`;
  };

  const catsHtml = () => {
    const list = roots();
    if (!list.length) return '';
    return html`<div class="hdr-cats">
      <button type="button" class="hdr-link" data-action="cats" aria-expanded="${aria(ui.catsOpen)}" aria-controls="hdr-cats">${t('hdr.categories')}${icon('chevron-down', { size: 16 })}</button>
      <div class="hdr-cat-panel" id="hdr-cats" ${ui.catsOpen ? '' : raw('hidden')}>
        ${list.map((c) => html`<div class="hdr-cat-col">
          <a class="hdr-cat-link hdr-cat-root" href="${categoryUrl(c)}">${c.name}</a>
          ${(c.children || []).slice(0, 6).map((k) => html`<a class="hdr-cat-link" href="${categoryUrl(k)}">${k.name}</a>`)}
        </div>`)}
        <a class="hdr-cat-link hdr-cat-all" href="/shop">${t('hdr.allProducts')}${icon('arrow-right', { size: 16 })}</a>
      </div>
    </div>`;
  };

  const searchHtml = () => html`<form class="hdr-search ${ui.searchOpen ? 'is-open' : ''}" id="hdr-search" role="search" data-form="search" autocomplete="off">
    <div class="hdr-search-box">
      <span class="hdr-search-ico">${icon('search', { size: 18 })}</span>
      <input id="hdr-q" name="q" type="search" enterkeyhint="search" autocomplete="off" value="${ui.q}" placeholder="${t('hdr.searchPh')}" aria-label="${t('hdr.search')}" data-input="q">
      <div class="hdr-suggest" id="hdr-suggest" hidden></div>
    </div>
  </form>`;

  const accountHtml = (s) => (s.user
    ? html`<a class="hdr-btn hdr-desk" href="/account" aria-label="${t('hdr.account')}"><span class="hdr-avatar" aria-hidden="true">${initialOf(s)}</span></a>`
    : html`<button type="button" class="hdr-signin hdr-desk" data-action="signin">${icon('user', { size: 18 })}<span>${t('hdr.signin')}</span></button>`);

  const view = () => {
    const st = settings();
    const s = getAuthState();
    const m = meta();
    const dark = effectiveTheme() === 'dark';
    const cartN = cart.count();
    const logo = st.logoUrl ? safeUrl(st.logoUrl, '') : '';
    return html`<div class="container hdr">
      <button type="button" class="hdr-btn hdr-menu" data-action="menu" aria-label="${t('hdr.menu')}" aria-haspopup="dialog">${icon('menu')}</button>
      <a class="hdr-brand" href="/">${logo ? html`<img src="${logo}" alt="" width="28" height="28">` : ''}<span>${st.storeName}</span></a>
      <nav class="hdr-nav" aria-label="${t('hdr.mainNav')}">
        ${navLink('shop', '/shop', t('hdr.shop'), m)}${catsHtml()}${navLink('track', '/track', t('hdr.track'), m)}${navLink('contact', '/contact', t('hdr.contact'), m)}
      </nav>
      ${searchHtml()}
      <div class="hdr-actions">
        <button type="button" class="hdr-btn hdr-search-toggle" data-action="searchToggle" aria-expanded="${aria(ui.searchOpen)}" aria-controls="hdr-search" aria-label="${t('hdr.search')}">${icon(ui.searchOpen ? 'x' : 'search')}</button>
        <button type="button" class="hdr-btn hdr-lang hdr-desk" data-action="lang" aria-label="${t('hdr.lang')}" lang="${getLang() === 'bn' ? 'en' : 'bn'}">${t('hdr.langSwitch')}</button>
        <button type="button" class="hdr-btn hdr-desk" data-action="theme" aria-label="${dark ? t('hdr.themeToLight') : t('hdr.themeToDark')}">${icon(dark ? 'sun' : 'moon')}</button>
        <a class="hdr-btn hdr-desk" href="/wishlist" aria-label="${t('hdr.wishlist')}">${icon('heart')}${badgeHtml(wishlist.count())}</a>
        ${accountHtml(s)}
        <a class="hdr-btn" href="/cart" aria-label="${cartN ? t('hdr.cartN', { n: cartN }) : t('hdr.cart')}">${icon('cart')}${badgeHtml(cartN)}</a>
      </div>
    </div>`;
  };

  const paintSuggest = () => {
    const box = $('#hdr-suggest', el);
    if (!box) return;
    const q = ui.q.trim();
    const cat = getCatalog();
    const list = q.length >= 2 && cat ? suggestProducts(cat, q, 6) : [];
    if (!list.length) { box.hidden = true; render(box, html``); return; }
    render(box, html`${list.map((p) => html`<a class="hdr-sug" href="${productUrl(p)}">
        ${p.image ? html`<img src="${safeUrl(p.thumb || p.image)}" alt="" width="40" height="40" loading="lazy">` : html`<span class="hdr-sug-ph">${icon('image', { size: 18 })}</span>`}
        <span class="hdr-sug-name clamp-2">${p.name}</span><span class="hdr-sug-price">${money(p.minPrice)}</span>
      </a>`)}
      <a class="hdr-sug-all" href="${searchUrl(q)}">${t('hdr.searchAll', { q })}</a>`);
    box.hidden = false;
  };
  const suggestSoon = debounce(paintSuggest, 120);

  function redraw() {
    const a = document.activeElement;
    let restore = null;
    if (a && el.contains(a)) {
      if (a.id === 'hdr-q') restore = { sel: '#hdr-q', s: a.selectionStart, e: a.selectionEnd };
      else if (a.dataset && a.dataset.action) restore = { sel: `[data-action="${a.dataset.action}"]` };
    }
    render(el, view());
    if (restore) {
      const n = el.querySelector(restore.sel);
      if (n) {
        n.focus({ preventScroll: true });
        if (restore.s != null) { try { n.setSelectionRange(restore.s, restore.e); } catch { /* not a text input */ } }
        if (restore.sel === '#hdr-q') paintSuggest();
      }
    }
    drawAnn();
  }

  function drawAnn() {
    if (!annEl) return;
    const a = settings().announcement || {};
    const text = String(a.text || '').trim();
    if (a.enabled !== true || !text || session.get(ANN_KEY, '') === text) { render(annEl, html``); return; }
    const link = a.link ? safeUrl(a.link, '') : '';
    const external = /^https?:\/\//i.test(link);
    render(annEl, html`<div class="ann"><div class="container ann-in">
      <p class="ann-text">${link ? html`<a href="${link}" ${external ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${text}</a>` : text}</p>
      <button type="button" class="ann-x" data-action="annClose" aria-label="${t('hdr.dismiss')}">${icon('x', { size: 16 })}</button>
    </div></div>`);
  }

  /* ───────── drawer (compact layouts) ───────── */
  function drawerBody() {
    const s = getAuthState();
    const m = meta();
    const dark = effectiveTheme() === 'dark';
    const list = roots();
    const link = (href, label, ic, on) => html`<a href="${href}" ${on ? raw('aria-current="page"') : ''}>${icon(ic, { size: 20 })}<span>${label}</span></a>`;
    return html`<nav class="dnav" aria-label="${t('hdr.mainNav')}">
      ${link('/', t('hdr.home'), 'home', m.id === 'home')}
      ${link('/shop', t('hdr.shop'), 'grid', m.nav === 'shop')}
      ${link('/wishlist', t('hdr.wishlist'), 'heart', m.nav === 'wishlist')}
      ${link('/track', t('hdr.track'), 'truck', m.id === 'track')}
      ${link('/contact', t('hdr.contact'), 'headset', m.id === 'contact')}
      ${list.length ? html`<div class="dnav-title">${t('hdr.categories')}</div>${list.map((c) => html`<a href="${categoryUrl(c)}"><span>${c.name}</span></a>${(c.children || []).slice(0, 8).map((k) => html`<a class="dnav-sub" href="${categoryUrl(k)}"><span>${k.name}</span></a>`)}`)}` : ''}
      <div class="dnav-title">${t('hdr.account')}</div>
      ${s.user
        ? html`${link('/account', t('hdr.account'), 'user', m.nav === 'account')}
          ${link('/account/orders', t('hdr.orders'), 'package', false)}
          ${isStaff() ? html`<a href="/admin/" data-native>${icon('dashboard', { size: 20 })}<span>${t('hdr.admin')}</span></a>` : ''}
          <button type="button" data-action="signout">${icon('log-out', { size: 20 })}<span>${t('hdr.signout')}</span></button>`
        : html`<button type="button" data-action="signin">${icon('log-in', { size: 20 })}<span>${t('hdr.signin')}</span></button>`}
      <div class="dnav-title">${t('hdr.prefs')}</div>
      <div class="dnav-row">
        <button type="button" class="btn btn-secondary" data-action="lang">${icon('globe', { size: 18 })}<span>${t('hdr.langSwitch')}</span></button>
        <button type="button" class="btn btn-secondary" data-action="theme">${icon(dark ? 'sun' : 'moon', { size: 18 })}<span>${dark ? t('hdr.light') : t('hdr.dark')}</span></button>
      </div>
    </nav>`;
  }

  function openMenu() {
    if (drawer) return;
    drawer = openDrawer({
      title: settings().storeName, side: 'start', body: drawerBody(),
      onClose: () => { drawer = null; offDrawer(); offDrawer = () => {}; },
    });
    offDrawer = bindActions(drawer.bodyEl, {
      lang: () => setLang(getLang() === 'bn' ? 'en' : 'bn'),
      theme: () => { toggleTheme(THEME_KEY); if (drawer) drawer.setBody(drawerBody()); redraw(); },
      signin: async () => { if (drawer) drawer.close(); await openAuth(); },
      signout: async () => { if (drawer) drawer.close(); await logout(); router.navigate('/'); },
    });
  }

  /* ───────── actions ───────── */
  const actions = {
    menu: () => openMenu(),
    searchToggle: () => {
      ui.searchOpen = !ui.searchOpen; redraw();
      if (ui.searchOpen) { const q = $('#hdr-q', el); if (q) q.focus(); }
    },
    cats: () => { ui.catsOpen = !ui.catsOpen; redraw(); },
    lang: () => setLang(getLang() === 'bn' ? 'en' : 'bn'),
    theme: () => { toggleTheme(THEME_KEY); redraw(); },
    signin: () => openAuth(),
    annClose: () => {
      const a = settings().announcement || {};
      session.set(ANN_KEY, String(a.text || '').trim());
      drawAnn();
    },
  };

  const offActions = bindActions(el, actions, {
    input: { q: (inp) => { ui.q = inp.value; suggestSoon(); } },
    submit: {
      search: () => {
        const q = ui.q.trim();
        const box = $('#hdr-suggest', el); if (box) box.hidden = true;
        if (!q) return;
        router.navigate(searchUrl(q));
      },
    },
  });
  const offAnn = annEl ? bindActions(annEl, { annClose: actions.annClose }) : () => {};

  const onFocusIn = (e) => { if (e.target && e.target.id === 'hdr-q') paintSuggest(); };
  const onDocClick = (e) => {
    if (ui.catsOpen && !e.target.closest('.hdr-cats')) { ui.catsOpen = false; redraw(); }
    if (!e.target.closest('.hdr-search')) { const b = $('#hdr-suggest', el); if (b) b.hidden = true; }
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const b = $('#hdr-suggest', el); if (b) b.hidden = true;
    if (ui.catsOpen) { ui.catsOpen = false; redraw(); const c = $('[data-action="cats"]', el); if (c) c.focus(); }
    else if (ui.searchOpen) { ui.searchOpen = false; redraw(); const c = $('[data-action="searchToggle"]', el); if (c) c.focus(); }
  };
  el.addEventListener('focusin', onFocusIn);
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);

  /* ───────── live updates ───────── */
  const offs = [
    onSettings(redraw),
    onAuthChange(() => redraw()),
    cart.subscribe(() => redraw()),
    wishlist.subscribe(() => redraw()),
    router.onChange((cur) => {
      ui.searchOpen = false; ui.catsOpen = false;
      ui.q = cur.path === '/search' ? String(cur.query.q || '') : '';
      if (drawer) drawer.close();
      redraw();
    }),
    onLangChange(() => { if (drawer) drawer.close(); redraw(); }),
  ];
  redraw();
  loadCatalog().then(() => redraw()).catch(() => { /* the header works without categories */ });

  return () => {
    offs.forEach((off) => { if (typeof off === 'function') off(); });
    offActions(); offAnn(); offDrawer();
    el.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
    if (drawer) drawer.close();
  };
}
