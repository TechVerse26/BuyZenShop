/*
 * 404 page. (A static SPA cannot answer with an HTTP 404 status — this is a "soft 404", so it is marked noindex.)
 */
import { html, render, bindActions, setMeta } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { searchUrl } from '../lib/links.js';

registerBoth({
  'nf.title': ['Page not found', 'পেজটি খুঁজে পাওয়া যায়নি'],
  'nf.text': ['The link may be old or mistyped. Try searching, or head back to the shop.', 'লিংকটি পুরনো বা ভুল হতে পারে। খুঁজে দেখুন, অথবা শপে ফিরে যান।'],
  'nf.searchPh': ['Search products', 'পণ্য খুঁজুন'],
  'nf.search': ['Search', 'খুঁজুন'],
  'nf.home': ['Go to home', 'হোমে যান'],
  'nf.shop': ['Browse the shop', 'শপ দেখুন'],
});

export default {
  mount(ctx) {
    setMeta({ title: t('nf.title'), noindex: true });
    render(ctx.el, html`<div class="container page nf">
      <p class="nf-code" aria-hidden="true">404</p>
      <h1 class="page-title">${t('nf.title')}</h1>
      <p class="muted nf-text">${t('nf.text')}</p>
      <form class="nf-search" role="search" data-form="search">
        <input class="input" type="search" name="q" autocomplete="off" placeholder="${t('nf.searchPh')}" aria-label="${t('nf.searchPh')}">
        <button type="submit" class="btn btn-primary">${t('nf.search')}</button>
      </form>
      <div class="row row-wrap gap-3 nf-actions"><a class="btn btn-secondary" href="/">${t('nf.home')}</a><a class="btn btn-secondary" href="/shop">${t('nf.shop')}</a></div>
    </div>`);
    ctx.cleanup(bindActions(ctx.el, {}, {
      submit: {
        search: (form) => {
          const q = String(new FormData(form).get('q') || '').trim();
          ctx.router.navigate(q ? searchUrl(q) : '/shop');
        },
      },
    }));
  },
};
