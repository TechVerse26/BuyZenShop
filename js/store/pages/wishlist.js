/*
 * Wishlist — /wishlist (works for guests too)
 * The saved product ids live in this browser and, once signed in, in users/{uid}/wishlist (data/wishlist.js merges both).
 * Only products that are still in the public catalog are shown; saved ids that no longer exist can be cleared in one click.
 */
import { html, render, bindActions, setMeta } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, emptyState, errorState, skeletonCards, toastError } from '../../core/ui.js';
import { num } from '../../core/format.js';
import { getAuthState } from '../../data/auth.js';
import { loadCatalog, productById } from '../../data/catalog.js';
import { wishlist } from '../../data/wishlist.js';
import { productGrid, bindProductCards } from '../components/productCard.js';
import { loginUrl } from '../lib/links.js';

registerBoth({
  'wl.title': ['Wishlist', 'পছন্দের তালিকা'],
  'wl.count_one': ['{n} saved item', '{n}টি সেভ করা পণ্য'],
  'wl.count_other': ['{n} saved items', '{n}টি সেভ করা পণ্য'],
  'wl.empty': ['Your wishlist is empty', 'আপনার পছন্দের তালিকা খালি'],
  'wl.emptyText': ['Tap the heart on any product to save it here for later.', 'যেকোনো পণ্যের হার্টে চাপ দিলে সেটি পরে দেখার জন্য এখানে জমা থাকবে।'],
  'wl.browse': ['Browse products', 'পণ্য দেখুন'],
  'wl.guest': ['Your wishlist is saved on this device only.', 'আপনার তালিকা শুধু এই ডিভাইসে সেভ আছে।'],
  'wl.signIn': ['Sign in to keep it on all your devices', 'সব ডিভাইসে পেতে সাইন ইন করুন'],
  'wl.gone_one': ['{n} saved item is no longer available.', '{n}টি সেভ করা পণ্য আর পাওয়া যায় না।'],
  'wl.gone_other': ['{n} saved items are no longer available.', '{n}টি সেভ করা পণ্য আর পাওয়া যায় না।'],
  'wl.clear': ['Remove them', 'সরিয়ে দিন'],
  'wl.loadError': ['The wishlist could not be loaded.', 'পছন্দের তালিকা লোড করা যায়নি।'],
});

export default {
  async mount(ctx) {
    loadCss('/css/pages/wishlist.css');
    setMeta({ title: t('wl.title'), noindex: true });
    render(ctx.el, html`<div class="container page"><h1 class="page-title">${t('wl.title')}</h1><div class="product-grid">${skeletonCards(4)}</div></div>`);
    let cat;
    try { cat = await loadCatalog(); } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(ctx.el, html`<div class="container page"><h1 class="page-title">${t('wl.title')}</h1>${errorState({ text: t('wl.loadError') })}</div>`);
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;

    const paint = () => {
      const hadFocus = ctx.el.contains(document.activeElement) && document.activeElement !== document.body;
      const ids = wishlist.ids().reverse();                                  // newest first
      const products = ids.map((id) => productById(cat, id)).filter(Boolean);
      const gone = ids.length - products.length;
      const signedIn = !!getAuthState().user;
      render(ctx.el, html`<div class="container page wl">
        <div class="wl-head">
          <h1 class="page-title" id="wl-title" tabindex="-1">${t('wl.title')}</h1>
          ${products.length ? html`<p class="muted" role="status">${tn('wl.count', products.length, { n: num(products.length) })}</p>` : ''}
        </div>
        ${!signedIn && ids.length ? html`<p class="alert">${icon('info', { size: 18 })}<span>${t('wl.guest')} <a href="${loginUrl('/wishlist')}">${t('wl.signIn')}</a></span></p>` : ''}
        ${gone ? html`<p class="alert alert-warn">${icon('alert-triangle', { size: 18 })}<span>${tn('wl.gone', gone, { n: num(gone) })} <button type="button" class="btn btn-link" data-action="prune">${t('wl.clear')}</button></span></p>` : ''}
        ${products.length ? productGrid(products) : emptyState({ icon: 'heart', title: t('wl.empty'), text: t('wl.emptyText'), action: { href: '/shop', label: t('wl.browse') } })}
      </div>`);
      // A removed card takes the focused heart with it: keep keyboard users on the page instead of dropping them at the top.
      if (hadFocus && !ctx.el.contains(document.activeElement)) ctx.el.querySelector('#wl-title')?.focus({ preventScroll: true });
    };

    paint();
    ctx.cleanup(wishlist.subscribe(() => { if (!ctx.signal.aborted) paint(); }));
    ctx.cleanup(bindProductCards(ctx.el));
    ctx.cleanup(bindActions(ctx.el, {
      prune: async () => {
        const gone = wishlist.ids().filter((id) => !productById(cat, id));
        try { for (const id of gone) await wishlist.toggle(id); } catch (e) { console.error(e); toastError(t('wl.loadError')); }
      },
    }));
  },
};
