/*
 * Mobile tab bar (< 768 px; CSS hides it above). Hidden on the checkout page so nothing competes with the pay button.
 *   mountTabbar(el, { router }) → disposer
 */
import { html, render, raw } from '../../core/dom.js';
import { registerBoth, t, onLangChange } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { num } from '../../core/format.js';
import { cart } from '../../data/cart.js';
import { wishlist } from '../../data/wishlist.js';

registerBoth({
  'tab.nav': ['Quick navigation', 'দ্রুত নেভিগেশন'],
  'tab.home': ['Home', 'হোম'],
  'tab.shop': ['Shop', 'শপ'],
  'tab.wishlist': ['Wishlist', 'পছন্দ'],
  'tab.cart': ['Cart', 'কার্ট'],
  'tab.account': ['Account', 'অ্যাকাউন্ট'],
});

const ITEMS = [
  { nav: 'home', href: '/', ic: 'home', key: 'tab.home' },
  { nav: 'shop', href: '/shop', ic: 'grid', key: 'tab.shop' },
  { nav: 'wishlist', href: '/wishlist', ic: 'heart', key: 'tab.wishlist' },
  { nav: 'cart', href: '/cart', ic: 'cart', key: 'tab.cart' },
  { nav: 'account', href: '/account', ic: 'user', key: 'tab.account' },
];

export function mountTabbar(el, { router }) {
  const draw = () => {
    const m = (router.current && router.current.route && router.current.route.meta) || {};
    const hide = m.id === 'checkout';
    el.hidden = hide;
    document.body.classList.toggle('has-tabbar', !hide);
    el.setAttribute('aria-label', t('tab.nav'));
    const counts = { cart: cart.count(), wishlist: wishlist.count() };
    render(el, html`${ITEMS.map((it) => {
      const n = counts[it.nav] || 0;
      return html`<a class="tab-item" href="${it.href}" ${m.nav === it.nav ? raw('aria-current="page"') : ''}>
        <span class="tab-ico">${icon(it.ic, { size: 22 })}${n > 0 ? html`<span class="tab-badge" aria-hidden="true">${n > 99 ? '99+' : num(n)}</span>` : ''}</span>
        <span class="tab-label">${t(it.key)}</span>
      </a>`;
    })}`);
  };
  draw();
  const offs = [router.onChange(draw), cart.subscribe(draw), wishlist.subscribe(draw), onLangChange(draw)];
  return () => offs.forEach((off) => { if (typeof off === 'function') off(); });
}
