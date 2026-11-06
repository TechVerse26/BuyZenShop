/*
 * My account — /account and /account/*rest   (sign-in required: see routes.js)
 *
 *   /account                  overview + profile           ./account/overview.js
 *   /account/orders           order history                ./account/orders.js
 *   /account/orders/:id       one order (cancel, return, invoice, pay again)   ./account/order.js
 *   /account/addresses        address book                 ./account/addresses.js
 *   /account/notifications    order messages               ./account/notifications.js
 *   /account/support[/:id]    tickets                      ./account/support.js
 *
 * This file is only the frame (title + navigation); each section is a module with the usual `mount(ctx)` contract that
 * receives the content element as `ctx.el` and the id (if any) as `ctx.params.id`.
 */
import { html, render, setMeta } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, errorState } from '../../core/ui.js';

registerBoth({
  'acc.title': ['My account', 'আমার অ্যাকাউন্ট'],
  'acc.nav': ['Account sections', 'অ্যাকাউন্টের বিভাগ'],
  'acc.n.overview': ['Overview', 'ওভারভিউ'],
  'acc.n.orders': ['Orders', 'অর্ডার'],
  'acc.n.addresses': ['Addresses', 'ঠিকানা'],
  'acc.n.notifications': ['Notifications', 'নোটিফিকেশন'],
  'acc.n.support': ['Support', 'সাপোর্ট'],
  'acc.n.wishlist': ['Wishlist', 'পছন্দের তালিকা'],
  'acc.loadError': ['This page could not be loaded.', 'পেজটি লোড করা যায়নি।'],
});

const SECTIONS = {
  '': { icon: 'user', key: 'acc.n.overview', load: () => import('./account/overview.js') },
  orders: { icon: 'package', key: 'acc.n.orders', load: () => import('./account/orders.js') },
  addresses: { icon: 'map-pin', key: 'acc.n.addresses', load: () => import('./account/addresses.js') },
  notifications: { icon: 'bell', key: 'acc.n.notifications', load: () => import('./account/notifications.js') },
  support: { icon: 'headset', key: 'acc.n.support', load: () => import('./account/support.js') },
};

export default {
  async mount(ctx) {
    loadCss('/css/pages/account.css');
    const parts = String(ctx.params.rest || '').split('/').filter(Boolean);
    const section = parts[0] || '';
    const id = parts[1] ? decodeURIComponent(parts[1]) : '';
    if (!SECTIONS[section] || parts.length > 2 || (id && !['orders', 'support'].includes(section))) {
      const nf = await import('./not-found.js');
      return nf.default.mount(ctx);
    }
    setMeta({ title: t('acc.title'), noindex: true });

    render(ctx.el, html`<div class="container page acc">
      <h1 class="page-title">${t('acc.title')}</h1>
      <div class="acc-grid">
        <nav class="acc-nav" aria-label="${t('acc.nav')}">
          ${Object.entries(SECTIONS).map(([key, s]) => html`<a class="acc-link ${key === section ? 'is-active' : ''}" href="/account${key ? `/${key}` : ''}" ${key === section ? html`aria-current="page"` : ''}>${icon(s.icon, { size: 18 })}<span>${t(s.key)}</span></a>`)}
          <a class="acc-link" href="/wishlist">${icon('heart', { size: 18 })}<span>${t('acc.n.wishlist')}</span></a>
        </nav>
        <div class="acc-main" id="acc-main"></div>
      </div></div>`);
    const host = ctx.el.querySelector('#acc-main');
    ctx.el.querySelector('.acc-link.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center' }); // the tab strip scrolls sideways on phones
    try {
      const load = section === 'orders' && id ? () => import('./account/order.js') : SECTIONS[section].load;
      const mod = await load();
      if (ctx.signal.aborted) return;
      await mod.default.mount({ ...ctx, el: host, params: { id } });
    } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(host, errorState({ text: t('acc.loadError') }));
      host.addEventListener('click', (ev) => { if (ev.target.closest('[data-action="retry"]')) ctx.router.reload(); });
    }
  },
};
