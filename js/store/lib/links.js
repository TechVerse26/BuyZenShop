/*
 * Storefront URL helpers + a tiny handle on the router so any module can navigate without importing app.js.
 */
import { buildQuery } from '../../core/router.js';

let router = null;
export const setRouter = (r) => { router = r; };
export const getRouter = () => router;
export const go = (path, opts) => { if (router) router.navigate(path, opts); else location.assign(path); };

const enc = encodeURIComponent;
export const productUrl = (p) => `/product/${enc(p.slug || p.id)}`;
export const categoryUrl = (c) => `/category/${enc(c.slug || c.id)}`;
export const brandUrl = (b) => `/brand/${enc(b.slug || b.id)}`;
export const shopUrl = (query = {}) => `/shop${buildQuery(query)}`;
export const searchUrl = (q) => `/search${buildQuery({ q })}`;
export const orderUrl = (id) => `/account/orders/${enc(id)}`;
export const trackUrl = (id) => (id ? `/track/${enc(id)}` : '/track');
export const pageUrl = (slug) => `/page/${enc(slug)}`;
export const loginUrl = (next) => `/login${next ? buildQuery({ next }) : ''}`;
export const absoluteUrl = (path) => new URL(path, location.origin).href;

/** Only same-site relative paths are accepted as post-login destinations (prevents open redirects). */
export function safeNext(next, fallback = '/') {
  const s = String(next || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}
