/*
 * Home page. The layout is the admin-managed list of sections (content/home → js/shared/contentModel.js):
 * hero · banners · categories · products · brands · trust · richText · newsletter. Sections render only when they have
 * something real to show (no placeholder headings, no invented numbers).
 */
import { html, render, raw, safeUrl, bindActions, readForm, withBusy, setMeta } from '../../core/dom.js';
import { registerBoth, t, getLang } from '../../core/i18n.js';
import { icon, hasIcon } from '../../core/icons.js';
import { loadCss, skeletonCards, emptyState, errorState, toast } from '../../core/ui.js';
import { fmtDateTime } from '../../core/format.js';
import { explainError } from '../../core/errors.js';
import { showFormErrors } from '../../core/validate.js';
import { renderMarkdown } from '../../shared/markdown.js';
import { PRODUCT_SOURCES } from '../../shared/contentModel.js';
import { settings, loadHome } from '../../data/settings.js';
import { loadCatalog, queryProducts, newestProducts, bestSellers, featuredProducts, saleProducts } from '../../data/catalog.js';
import { subscribeNewsletter, validateEmail } from '../../data/newsletter.js';
import { productGrid, bindProductCards } from '../components/productCard.js';
import { categoryUrl, brandUrl, shopUrl, absoluteUrl } from '../lib/links.js';

registerBoth({
  'home.hero': ['Featured', 'বিশেষ আয়োজন'],
  'home.prev': ['Previous slide', 'আগের স্লাইড'],
  'home.next': ['Next slide', 'পরের স্লাইড'],
  'home.slide': ['Slide {n} of {total}', 'স্লাইড {n} / {total}'],
  'home.categories': ['Shop by category', 'ক্যাটাগরি অনুযায়ী কিনুন'],
  'home.brands': ['Our brands', 'আমাদের ব্র্যান্ড'],
  'home.viewAll': ['View all', 'সব দেখুন'],
  'home.offerEnds': ['Offer ends {when}', 'অফার শেষ {when}'],
  'home.newsletter': ['Stay in the loop', 'আপডেট পেতে থাকুন'],
  'home.newsletterText': ['New arrivals and offers, straight to your inbox.', 'নতুন পণ্য ও অফারের খবর সরাসরি আপনার ইনবক্সে।'],
  'home.email': ['Your email', 'আপনার ইমেইল'],
  'home.subscribe': ['Subscribe', 'সাবস্ক্রাইব'],
  'home.subscribed': ['Thank you! You are subscribed.', 'ধন্যবাদ! আপনি সাবস্ক্রাইব করেছেন।'],
  'home.empty': ['The store is being set up', 'স্টোর সাজানো হচ্ছে'],
  'home.emptyText': ['Please check back soon, or browse what is available.', 'একটু পরে আবার দেখুন, অথবা যা আছে তা ঘুরে দেখুন।'],
  'home.browse': ['Browse products', 'পণ্য দেখুন'],
  'home.loadError': ['The home page could not be loaded.', 'হোম পেজ লোড করা যায়নি।'],
  'home.metaDesc': ['Online shopping in Bangladesh with Cash on Delivery, bKash and Nagad.', 'ক্যাশ অন ডেলিভারি, বিকাশ ও নগদে বাংলাদেশে অনলাইন শপিং।'],
});

const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const sectionTitle = (sec, fallback) => sec.title || fallback;

/* ───────────────────────── section renderers (each returns SafeHtml, '' when there is nothing to show) ───────────────────────── */

function heroHtml(sec) {
  const slides = sec.slides || [];
  if (!slides.length) return '';
  return html`<section class="hero" id="hero-${sec.id}" aria-roledescription="carousel" aria-label="${sectionTitle(sec, t('home.hero'))}">
    <div class="hero-track" data-hero tabindex="0">
      ${slides.map((s, i) => html`<article class="hero-slide tone-${s.tone}" role="group" aria-roledescription="slide" aria-label="${t('home.slide', { n: i + 1, total: slides.length })}">
        <picture>
          ${s.mobileImage ? html`<source media="(max-width: 640px)" srcset="${safeUrl(s.mobileImage)}">` : ''}
          <img src="${safeUrl(s.image)}" alt="${s.alt || s.title || ''}" width="1600" height="640" ${i === 0 ? raw('fetchpriority="high"') : raw('loading="lazy"')} decoding="async">
        </picture>
        ${s.link && !s.cta ? html`<a class="hero-link" href="${safeUrl(s.link)}" aria-label="${s.title || s.alt || t('home.hero')}"></a>` : ''}
        ${(s.title || s.text || (s.cta && s.link)) ? html`<div class="hero-copy"><div class="container">
          ${s.title ? html`<h2>${s.title}</h2>` : ''}${s.text ? html`<p>${s.text}</p>` : ''}
          ${s.cta && s.link ? html`<a class="btn btn-primary btn-lg" href="${safeUrl(s.link)}">${s.cta}</a>` : ''}
        </div></div>` : ''}
      </article>`)}
    </div>
    ${slides.length > 1 ? html`<div class="hero-ctl">
      <button type="button" class="hero-btn" data-action="heroPrev" aria-label="${t('home.prev')}">${icon('chevron-left')}</button>
      <div class="hero-dots">${slides.map((_, i) => html`<button type="button" class="hero-dot" data-action="heroGo" data-i="${i}" aria-label="${t('home.slide', { n: i + 1, total: slides.length })}" ${i === 0 ? raw('aria-current="true"') : ''}></button>`)}</div>
      <button type="button" class="hero-btn" data-action="heroNext" aria-label="${t('home.next')}">${icon('chevron-right')}</button>
    </div>` : ''}
  </section>`;
}

function bannersHtml(sec) {
  const items = sec.items || [];
  if (!items.length) return '';
  return html`<section class="section"><div class="container">
    ${sec.title ? html`<div class="section-head"><h2>${sec.title}</h2></div>` : ''}
    <div class="banner-grid cols-${sec.columns}">${items.map((b) => html`<a class="banner" href="${b.link ? safeUrl(b.link) : '/shop'}">
      <img src="${safeUrl(b.image)}" alt="${b.alt || b.title || ''}" width="800" height="450" loading="lazy" decoding="async">
      ${(b.title || b.text || b.cta) ? html`<span class="banner-copy">${b.title ? html`<strong>${b.title}</strong>` : ''}${b.text ? html`<span>${b.text}</span>` : ''}${b.cta ? html`<em>${b.cta}</em>` : ''}</span>` : ''}
    </a>`)}</div>
  </div></section>`;
}

function categoriesHtml(cat, sec) {
  const list = (sec.categoryIds.length ? sec.categoryIds.map((id) => cat.catById[id]).filter(Boolean) : cat.categoryTree).slice(0, sec.limit);
  if (!list.length) return '';
  return html`<section class="section"><div class="container">
    <div class="section-head"><h2>${sectionTitle(sec, t('home.categories'))}</h2></div>
    <div class="cat-grid ${sec.style === 'scroll' ? 'is-scroll' : ''}">${list.map((c) => html`<a class="cat-tile" href="${categoryUrl(c)}">
      ${c.image ? html`<img src="${safeUrl(c.image)}" alt="" width="160" height="160" loading="lazy" decoding="async">` : html`<span class="cat-ico">${icon(c.icon && hasIcon(c.icon) ? c.icon : 'grid', { size: 28 })}</span>`}
      <span class="cat-name">${c.name}</span>
    </a>`)}</div>
  </div></section>`;
}

function productsFor(cat, sec) {
  const n = sec.limit;
  switch (sec.source) {
    case 'bestsellers': return bestSellers(cat, n);
    case 'featured': return featuredProducts(cat, n);
    case 'sale': return saleProducts(cat, n);
    case 'category': return cat.catById[sec.categoryId] ? queryProducts(cat, { categoryId: sec.categoryId, sort: 'newest' }).slice(0, n) : [];
    case 'manual': return sec.productIds.map((id) => cat.byId.get(id)).filter(Boolean).slice(0, n);
    default: return newestProducts(cat, n);
  }
}
function viewAllFor(cat, sec) {
  if (sec.viewAllLink) return sec.viewAllLink;
  switch (sec.source) {
    case 'bestsellers': return shopUrl({ sort: 'popular' });
    case 'sale': return shopUrl({ sale: 1 });
    case 'category': { const c = cat.catById[sec.categoryId]; return c ? categoryUrl(c) : '/shop'; }
    case 'manual': case 'featured': return '/shop';
    default: return shopUrl({ sort: 'newest' });
  }
}
function productsHtml(cat, sec) {
  if (sec.endsAt && sec.endsAt < Date.now()) return '';                 // the offer window is over
  const list = productsFor(cat, sec);
  if (!list.length) return '';
  const src = PRODUCT_SOURCES[sec.source] || PRODUCT_SOURCES.newest;
  const title = sectionTitle(sec, getLang() === 'bn' ? src.bn : src.en);
  return html`<section class="section"><div class="container">
    <div class="section-head"><div><h2>${title}</h2>${sec.endsAt ? html`<p class="muted small">${t('home.offerEnds', { when: fmtDateTime(sec.endsAt) })}</p>` : ''}</div>
      <a href="${safeUrl(viewAllFor(cat, sec))}">${t('home.viewAll')}</a></div>
    ${productGrid(list, { priority: 0 })}
  </div></section>`;
}

function brandsHtml(cat, sec) {
  const list = cat.brands.slice(0, sec.limit);
  if (!list.length) return '';
  return html`<section class="section"><div class="container">
    <div class="section-head"><h2>${sectionTitle(sec, t('home.brands'))}</h2></div>
    <div class="brand-row">${list.map((b) => html`<a class="brand-tile" href="${brandUrl(b)}">${b.logo ? html`<img src="${safeUrl(b.logo)}" alt="${b.name}" width="120" height="48" loading="lazy" decoding="async">` : html`<span>${b.name}</span>`}</a>`)}</div>
  </div></section>`;
}

function trustHtml(sec) {
  const items = sec.items || [];
  if (!items.length) return '';
  return html`<section class="section"><div class="container"><ul class="trust">${items.map((i) => html`<li>${icon(hasIcon(i.icon) ? i.icon : 'shield-check', { size: 26 })}<div><strong>${i.title}</strong>${i.text ? html`<span>${i.text}</span>` : ''}</div></li>`)}</ul></div></section>`;
}

function richTextHtml(sec) {
  if (!sec.body && !sec.title) return '';
  return html`<section class="section"><div class="container"><div class="rich ${sec.align === 'center' ? 'is-center' : ''}">
    ${sec.title ? html`<h2>${sec.title}</h2>` : ''}${sec.body ? html`<div class="prose">${raw(renderMarkdown(sec.body))}</div>` : ''}
  </div></div></section>`;
}

function newsletterHtml(sec) {
  return html`<section class="section"><div class="container"><div class="newsletter">
    <div><h2>${sectionTitle(sec, t('home.newsletter'))}</h2><p>${sec.text || t('home.newsletterText')}</p></div>
    <form class="newsletter-form" data-form="newsletter" novalidate>
      <div class="field"><label class="sr-only" for="nl-email">${t('home.email')}</label>
        <input class="input" id="nl-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="${t('home.email')}" aria-describedby="err-email" required>
        <div class="field-error" id="err-email" aria-live="polite"></div></div>
      <button type="submit" class="btn btn-primary">${t('home.subscribe')}</button>
    </form>
    <p class="newsletter-done" id="nl-done" role="status" hidden>${t('home.subscribed')}</p>
  </div></div></section>`;
}

/* ───────────────────────── hero behaviour (scroll-snap carousel, optional autoplay) ───────────────────────── */

function initHero(root, sec) {
  const track = root.querySelector('[data-hero]');
  if (!track) return () => {};
  const slides = [...track.children];
  const dots = [...root.querySelectorAll('.hero-dot')];
  let timer = null;
  const index = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const go = (i) => {
    const n = (i + slides.length) % slides.length;
    track.scrollTo({ left: n * track.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  const mark = () => dots.forEach((d, i) => { if (i === index()) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current'); });
  track.addEventListener('scroll', mark, { passive: true });
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const offActions = bindActions(root, {
    heroPrev: () => { stop(); go(index() - 1); },
    heroNext: () => { stop(); go(index() + 1); },
    heroGo: (el) => { stop(); go(Number(el.dataset.i) || 0); },
  });
  if (sec.autoplay && slides.length > 1 && !reducedMotion()) {
    timer = setInterval(() => go(index() + 1), (sec.interval || 6) * 1000);
    ['pointerdown', 'focusin', 'mouseenter', 'touchstart'].forEach((ev) => root.addEventListener(ev, stop, { once: true, passive: true }));
  }
  return () => { stop(); track.removeEventListener('scroll', mark); offActions(); };
}

/* ───────────────────────── page ───────────────────────── */

export default {
  async mount(ctx) {
    loadCss('/css/pages/home.css');
    render(ctx.el, html`<div class="container page"><div class="hero-skeleton skeleton" aria-hidden="true"></div><div class="product-grid mt-8">${skeletonCards(4)}</div></div>`);

    let home; let cat = null;
    try {
      [home, cat] = await Promise.all([loadHome(), loadCatalog().catch(() => null)]);
    } catch (e) {
      if (ctx.signal.aborted) return;
      render(ctx.el, html`<div class="container page">${errorState({ text: t('home.loadError') })}</div>`);
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;

    const st = settings();
    const parts = [];
    for (const sec of home.sections) {
      if (!sec.enabled) continue;
      let out = '';
      switch (sec.type) {
        case 'hero': out = heroHtml(sec); break;
        case 'banners': out = bannersHtml(sec); break;
        case 'categories': out = cat ? categoriesHtml(cat, sec) : ''; break;
        case 'products': out = cat ? productsHtml(cat, sec) : ''; break;
        case 'brands': out = cat ? brandsHtml(cat, sec) : ''; break;
        case 'trust': out = trustHtml(sec); break;
        case 'richText': out = richTextHtml(sec); break;
        case 'newsletter': out = newsletterHtml(sec); break;
        default: break;
      }
      if (out) parts.push({ sec, out });
    }

    render(ctx.el, html`<h1 class="sr-only">${st.storeName}</h1>${parts.length ? parts.map((p) => p.out) : html`<div class="container page">${emptyState({ icon: 'store', title: t('home.empty'), text: t('home.emptyText'), action: { href: '/shop', label: t('home.browse') } })}</div>`}`);

    for (const { sec } of parts) {
      if (sec.type === 'hero') { const root = ctx.el.querySelector(`#hero-${sec.id}`); if (root) ctx.cleanup(initHero(root, sec)); }
    }
    ctx.cleanup(bindProductCards(ctx.el));
    ctx.cleanup(bindActions(ctx.el, {}, {
      submit: {
        newsletter: async (form) => {
          const email = String(readForm(form).email || '');
          const msg = validateEmail(email);
          showFormErrors(form, msg ? { email: msg } : {});
          if (msg) { form.querySelector('input').focus(); return; }
          try {
            await withBusy(form.querySelector('[type="submit"]'), () => subscribeNewsletter(email, 'home'));
            form.hidden = true;
            const done = ctx.el.querySelector('#nl-done');
            if (done) done.hidden = false;
          } catch (e) { toast(explainError(e), { type: 'bad' }); }
        },
      },
    }));

    const firstHero = home.sections.find((s) => s.type === 'hero' && s.enabled && s.slides.length);
    setMeta({
      title: (st.seo && st.seo.title) || st.storeName,
      description: (st.seo && st.seo.description) || st.tagline || t('home.metaDesc'),
      canonical: absoluteUrl('/'),
      image: firstHero ? absoluteUrl(firstHero.slides[0].image) : undefined,
      jsonLd: [
        { '@context': 'https://schema.org', '@type': 'Organization', name: st.storeName, url: absoluteUrl('/'), logo: st.logoUrl ? absoluteUrl(st.logoUrl) : undefined },
        { '@context': 'https://schema.org', '@type': 'WebSite', name: st.storeName, url: absoluteUrl('/'), potentialAction: { '@type': 'SearchAction', target: `${absoluteUrl('/search')}?q={search_term_string}`, 'query-input': 'required name=search_term_string' } },
      ],
    });
  },
};
