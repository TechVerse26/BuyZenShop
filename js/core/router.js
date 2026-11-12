/*
 * Router (History API for the storefront, hash routes for /admin/).
 *
 * Page module contract (default export of every routed file):
 *
 *   export default {
 *     async mount(ctx) { …render into ctx.el…; return () => { …optional cleanup… }; }
 *   };
 *
 * ctx = { el, params, query, path, route, router, signal, cleanup(fn) }
 *   - el       the outlet element (already emptied)
 *   - params   { slug: 'abc' } from ":slug" segments, `rest` for "*rest"
 *   - query    plain object from the query string
 *   - signal   AbortSignal that aborts when the user navigates away (check before touching the DOM after await)
 *   - cleanup  register teardown callbacks (listeners, onSnapshot unsubscribes …)
 *
 * Route table entries: { path: '/product/:slug', load: () => import('./pages/product.js'), meta?: {…} }
 * `guard({route, params, query, path})` may return a path string to redirect to (auth / permission checks).
 */
import { html, render, bindActions } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export function parseQuery(search) {
  const q = {};
  const s = String(search || '').replace(/^\?/, '');
  if (!s) return q;
  for (const [k, v] of new URLSearchParams(s)) q[k] = v;
  return q;
}
export function buildQuery(obj = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function compile(path) {
  const keys = [];
  const src = path.split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    if (seg.startsWith('*')) { keys.push(seg.slice(1) || 'rest'); return '(.*)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp(`^/${src}/?$`), keys };
}

const NATIVE_PREFIX = /^\/(admin|css|js|assets|gallery|docs|tools|tests|icons)(\/|$)/;
const NATIVE_FILE = /\.[a-z0-9]{2,5}$/i;

export function createRouter({ mode = 'history', base = '', routes, outlet, guard, notFound, onChange, announcer } = {}) {
  const table = routes.map((r) => ({ ...r, ...compile(r.path) }));
  const changeListeners = new Set(onChange ? [onChange] : []);
  let token = 0;
  let teardown = [];
  let aborter = null;
  let current = { path: '/', params: {}, query: {}, route: null };

  const readLocation = () => {
    if (mode === 'hash') {
      const h = location.hash.replace(/^#/, '') || '/';
      const i = h.indexOf('?');
      return { path: normalize(i < 0 ? h : h.slice(0, i)), query: parseQuery(i < 0 ? '' : h.slice(i)) };
    }
    let p = location.pathname;
    if (base && p.startsWith(base)) p = p.slice(base.length) || '/';
    return { path: normalize(p), query: parseQuery(location.search) };
  };
  const normalize = (p) => { let s = decodeURI(p || '/'); if (!s.startsWith('/')) s = '/' + s; if (s.length > 1) s = s.replace(/\/+$/, ''); return s || '/'; };

  function match(path) {
    for (const r of table) {
      const m = r.re.exec(path);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ''); });
        return { route: r, params };
      }
    }
    return null;
  }

  function href(to) {
    const s = String(to || '/');
    return mode === 'hash' ? `${base || ''}#${s.startsWith('/') ? s : '/' + s}` : `${base}${s.startsWith('/') ? s : '/' + s}`;
  }

  async function unmountCurrent() {
    const fns = teardown; teardown = [];
    if (aborter) { aborter.abort(); aborter = null; }
    for (const fn of fns.reverse()) { try { await fn(); } catch (e) { console.error('cleanup failed', e); } }
  }

  function showError(err, retry) {
    console.error(err);
    render(outlet, html`<div class="empty" role="alert">
      ${icon('alert-triangle')}
      <h3>${t('common.error')}</h3>
      <p>${err && err.message ? String(err.message).slice(0, 200) : ''}</p>
      <button class="btn btn-primary" data-action="retry">${t('common.retry')}</button>
    </div>`);
    bindActions(outlet, { retry: () => retry() });
  }

  async function resolve({ scroll = true } = {}) {
    const my = ++token;
    const { path, query } = readLocation();
    let hit = match(path);
    if (!hit) hit = notFound ? { route: { ...notFound, path: '*', meta: { ...(notFound.meta || {}), notFound: true } }, params: { rest: path } } : null;
    if (!hit) return;
    const { route, params } = hit;

    if (guard) {
      let redirect = null;
      try { redirect = await guard({ route, params, query, path }); } catch (e) { console.error('route guard failed', e); }
      if (my !== token) return;
      if (redirect && redirect !== path + buildQuery(query)) { navigate(redirect, { replace: true }); return; }
    }

    await unmountCurrent();
    if (my !== token) return;
    outlet.setAttribute('aria-busy', 'true');
    outlet.replaceChildren();
    current = { path, params, query, route };
    changeListeners.forEach((fn) => { try { fn(current); } catch (e) { console.error(e); } });

    let mod;
    try { mod = await route.load(); } catch (e) {
      if (my !== token) return;
      outlet.removeAttribute('aria-busy');
      showError(e, () => resolve());
      return;
    }
    if (my !== token) return;

    aborter = new AbortController();
    const ctx = {
      el: outlet, params, query, path, route, router: api, signal: aborter.signal,
      cleanup: (fn) => { if (typeof fn === 'function') teardown.push(fn); },
    };
    try {
      const out = await mod.default.mount(ctx);
      if (typeof out === 'function') teardown.push(out);
    } catch (e) {
      if (my === token) showError(e, () => resolve());
    } finally {
      if (my === token) outlet.removeAttribute('aria-busy');
    }
    if (my !== token) return;
    if (scroll) window.scrollTo({ top: 0, left: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    if (outlet.hasAttribute('tabindex')) outlet.focus({ preventScroll: true });
    if (announcer) announcer(document.title);
  }

  function navigate(to, { replace = false } = {}) {
    const target = String(to || '/');
    if (mode === 'hash') {
      const nextHash = '#' + (target.startsWith('/') ? target : '/' + target);
      if (location.hash === nextHash) { resolve(); return; }
      if (replace) location.replace(`${location.pathname}${location.search}${nextHash}`); else location.hash = nextHash;
      return;                                             // hashchange → resolve()
    }
    const url = href(target);
    if (replace) history.replaceState({}, '', url); else history.pushState({}, '', url);
    resolve();
  }

  /** Update the query string without re-mounting the page (filters, sorting, pagination). */
  function setQuery(obj, { replace = true } = {}) {
    const { path } = readLocation();
    const q = buildQuery(obj);
    if (mode === 'hash') {
      const next = `#${path}${q}`;
      if (replace) history.replaceState({}, '', `${location.pathname}${location.search}${next}`); else history.pushState({}, '', `${location.pathname}${location.search}${next}`);
    } else {
      const url = `${base}${path === '/' ? '/' : path}${q}`;
      if (replace) history.replaceState({}, '', url); else history.pushState({}, '', url);
    }
    current = { ...current, query: { ...obj } };
  }

  function onClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.dataset.native !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (mode === 'hash') return;                            // hash links are handled by the browser
    if (NATIVE_PREFIX.test(url.pathname) || NATIVE_FILE.test(url.pathname)) return;
    ev.preventDefault();
    const rel = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;
    navigate(rel + url.search + url.hash);
  }

  const onHash = () => resolve();
  const onPop = () => resolve();
  let running = false;
  function start() {
    if (!running) {
      running = true;
      if (mode === 'hash') window.addEventListener('hashchange', onHash);
      else { window.addEventListener('popstate', onPop); document.addEventListener('click', onClick); }
    }
    return resolve();
  }
  /** Detach listeners and unmount the current page (admin sign-out). */
  async function stop() {
    running = false; token++;
    window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onPop); document.removeEventListener('click', onClick);
    await unmountCurrent();
  }

  const api = {
    start, stop, navigate, setQuery, href, match,
    reload: () => resolve({ scroll: false }),
    back: () => history.back(),
    get current() { return current; },
    onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
  };
  return api;
}
