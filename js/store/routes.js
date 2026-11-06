/*
 * Storefront route table. Every page is a module whose default export is { mount(ctx) } (see core/router.js).
 * meta.auth → requires sign-in (the guard in app.js redirects to /login?next=…).
 * meta.nav  → which header / tab-bar item is highlighted.
 * meta.kind → lets one page file serve several URL shapes (shop.js handles all / search / category / brand).
 */
export const routes = [
  { path: '/', load: () => import('./pages/home.js'), meta: { id: 'home', nav: 'home' } },
  { path: '/shop', load: () => import('./pages/shop.js'), meta: { id: 'shop', nav: 'shop', kind: 'all' } },
  { path: '/search', load: () => import('./pages/shop.js'), meta: { id: 'search', nav: 'shop', kind: 'search' } },
  { path: '/category/:slug', load: () => import('./pages/shop.js'), meta: { id: 'category', nav: 'shop', kind: 'category' } },
  { path: '/brand/:slug', load: () => import('./pages/shop.js'), meta: { id: 'brand', nav: 'shop', kind: 'brand' } },
  { path: '/product/:slug', load: () => import('./pages/product.js'), meta: { id: 'product', nav: 'shop' } },
  { path: '/cart', load: () => import('./pages/cart.js'), meta: { id: 'cart', nav: 'cart' } },
  { path: '/checkout', load: () => import('./pages/checkout.js'), meta: { id: 'checkout', nav: 'cart', auth: true } },
  { path: '/order-success/:id', load: () => import('./pages/order-success.js'), meta: { id: 'order-success', auth: true } },
  { path: '/account', load: () => import('./pages/account.js'), meta: { id: 'account', nav: 'account', auth: true } },
  { path: '/account/*rest', load: () => import('./pages/account.js'), meta: { id: 'account', nav: 'account', auth: true } },
  { path: '/wishlist', load: () => import('./pages/wishlist.js'), meta: { id: 'wishlist', nav: 'wishlist' } },
  { path: '/track', load: () => import('./pages/track.js'), meta: { id: 'track', auth: true } },
  { path: '/track/:id', load: () => import('./pages/track.js'), meta: { id: 'track', auth: true } },
  { path: '/login', load: () => import('./pages/login.js'), meta: { id: 'login' } },
  { path: '/contact', load: () => import('./pages/contact.js'), meta: { id: 'contact' } },
  { path: '/page/:slug', load: () => import('./pages/content.js'), meta: { id: 'content' } },
];

export const notFound = { load: () => import('./pages/not-found.js'), meta: { id: 'not-found' } };
