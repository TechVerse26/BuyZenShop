/*
 * Product page — /product/:slug
 * Gallery (+ zoom), buy box (variants, stock, quantity, cart, wishlist), details, specifications, reviews, related and
 * recently viewed products. The catalog is preloaded (data/catalog.js), so the page paints from memory; stock and price are
 * re-checked by the cart / checkout / security rules. Product + BreadcrumbList JSON-LD are written for search engines.
 */
import { html, render, raw, bindActions, setMeta } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { loadCss, emptyState, errorState, stars } from '../../core/ui.js';
import { truncate } from '../../core/format.js';
import { renderMarkdown } from '../../shared/markdown.js';
import { loadCatalog, productBySlug, productById, categoryPath, relatedProducts, recentlyViewed, pushRecentlyViewed } from '../../data/catalog.js';
import { loadZones } from '../../data/settings.js';
import { productGrid, bindProductCards } from '../components/productCard.js';
import { mountGallery } from '../components/gallery.js';
import { mountBuyBox } from '../components/buybox.js';
import { mountReviews } from '../components/reviews.js';
import { categoryUrl, brandUrl, productUrl, absoluteUrl } from '../lib/links.js';

registerBoth({
  'pdp.crumbs': ['Breadcrumb', 'পেজ পথ'],
  'pdp.home': ['Home', 'হোম'],
  'pdp.notFound': ['Product not found', 'পণ্যটি খুঁজে পাওয়া যায়নি'],
  'pdp.notFoundText': ['It may have been removed, or the link is wrong.', 'পণ্যটি সরানো হয়ে থাকতে পারে, অথবা লিংকটি ভুল।'],
  'pdp.backToShop': ['Browse the shop', 'শপ দেখুন'],
  'pdp.loadError': ['The product could not be loaded.', 'পণ্যটি লোড করা যায়নি।'],
  'pdp.reviews_one': ['{n} review', '{n}টি রিভিউ'],
  'pdp.reviews_other': ['{n} reviews', '{n}টি রিভিউ'],
  'pdp.description': ['Description', 'বিবরণ'],
  'pdp.specs': ['Specifications', 'স্পেসিফিকেশন'],
  'pdp.related': ['You may also like', 'আরও পছন্দ হতে পারে'],
  'pdp.recent': ['Recently viewed', 'সম্প্রতি দেখেছেন'],
  'pdp.sku': ['SKU: {sku}', 'SKU: {sku}'],
});

const plain = (md) => String(md || '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s*[-*]\s+/gm, '').replace(/[#>*_`~|]/g, ' ').replace(/\s+/g, ' ').trim();

function availabilityUrl(state) {
  if (state === 'out' || state === 'unavailable') return 'https://schema.org/OutOfStock';
  return state === 'backorder' ? 'https://schema.org/BackOrder' : 'https://schema.org/InStock';
}

function jsonLd(cat, p, description) {
  const url = absoluteUrl(productUrl(p));
  const offers = p.minPrice === p.maxPrice
    ? { '@type': 'Offer', price: String(p.minPrice), priceCurrency: 'BDT', availability: availabilityUrl(p.stockState), url }
    : { '@type': 'AggregateOffer', lowPrice: String(p.minPrice), highPrice: String(p.maxPrice), priceCurrency: 'BDT', offerCount: p.units.length, availability: availabilityUrl(p.stockState), url };
  const crumbs = [{ name: t('pdp.home'), url: absoluteUrl('/') }, ...categoryPath(cat, p.categoryId).map((c) => ({ name: c.name, url: absoluteUrl(categoryUrl(c)) })), { name: p.name, url }];
  return [{
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, url,
    image: p.images.map((i) => absoluteUrl(i.url)), description, sku: p.sku || undefined,
    brand: p.brandName ? { '@type': 'Brand', name: p.brandName } : undefined, offers,
    aggregateRating: p.ratingCount > 0 ? { '@type': 'AggregateRating', ratingValue: Number(p.ratingAvg.toFixed(2)), reviewCount: p.ratingCount } : undefined,
  }, {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
  }];
}

export default {
  async mount(ctx) {
    loadCss('/css/pages/product.css');
    render(ctx.el, html`<div class="container page pdp" aria-busy="true"><div class="pdp-grid">
      <div class="skeleton sk-img"></div>
      <div><div class="skeleton sk-title"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line" style="width:60%"></div></div>
    </div></div>`);

    let cat; let zones;
    try { [cat, zones] = await Promise.all([loadCatalog(), loadZones().catch(() => [])]); } catch (e) {
      if (ctx.signal.aborted) return;
      console.error(e);
      render(ctx.el, html`<div class="container page">${errorState({ text: t('pdp.loadError') })}</div>`);
      ctx.cleanup(bindActions(ctx.el, { retry: () => ctx.router.reload() }));
      return;
    }
    if (ctx.signal.aborted) return;

    const p = productBySlug(cat, ctx.params.slug) || productById(cat, ctx.params.slug);
    if (!p) {
      setMeta({ title: t('pdp.notFound'), noindex: true });
      render(ctx.el, html`<div class="container page">${emptyState({ icon: 'search', title: t('pdp.notFound'), text: t('pdp.notFoundText'), action: { href: '/shop', label: t('pdp.backToShop') } })}</div>`);
      return;
    }
    pushRecentlyViewed(p.id);

    const description = p.seoDescription || p.shortDescription || truncate(plain(p.description), 155);
    setMeta({
      title: p.seoTitle || p.name, description, canonical: absoluteUrl(productUrl(p)), image: p.image ? absoluteUrl(p.image) : undefined,
      type: 'product', jsonLd: jsonLd(cat, p, truncate(plain(p.shortDescription || p.description) || p.name, 300)),
    });

    const path = categoryPath(cat, p.categoryId);
    const crumbs = [{ href: '/', label: t('pdp.home') }, ...path.map((c) => ({ href: categoryUrl(c), label: c.name })), { href: '', label: p.name }];
    const brand = p.brandId ? cat.brands.find((b) => b.id === p.brandId) : null;
    const etaMin = zones.length ? Math.min(...zones.map((z) => Number(z.etaMin) || 0)) : 0;
    const etaMax = zones.length ? Math.max(...zones.map((z) => Number(z.etaMax) || 0)) : 0;
    const eta = zones.length && etaMax > 0 ? { min: etaMin || etaMax, max: etaMax } : null;

    const related = relatedProducts(cat, p, 8);
    const recent = recentlyViewed().filter((id) => id !== p.id).map((id) => productById(cat, id)).filter(Boolean).slice(0, 6);
    const hasDetails = !!(p.description || p.specs.length);

    render(ctx.el, html`<div class="container page pdp">
      <nav class="crumbs" aria-label="${t('pdp.crumbs')}"><ol>${crumbs.map((c) => (c.href ? html`<li><a href="${c.href}">${c.label}</a></li>` : html`<li aria-current="page">${c.label}</li>`))}</ol></nav>
      <div class="pdp-grid">
        <div class="pdp-media" id="pdp-gallery"></div>
        <div class="pdp-info">
          ${p.categoryName || brand ? html`<p class="pdp-eyebrow">${path.length ? html`<a href="${categoryUrl(path[path.length - 1])}">${p.categoryName}</a>` : p.categoryName}${brand ? html` · <a href="${brandUrl(brand)}">${brand.name}</a>` : (p.brandName ? ` · ${p.brandName}` : '')}</p>` : ''}
          <h1 class="pdp-title">${p.name}</h1>
          ${p.ratingCount > 0 ? html`<a class="pdp-rating" href="#reviews">${stars(p.ratingAvg, { size: 16 })}<span>${tn('pdp.reviews', p.ratingCount)}</span></a>` : ''}
          ${p.shortDescription ? html`<p class="pdp-short">${p.shortDescription}</p>` : ''}
          ${p.highlights.length ? html`<ul class="pdp-hl">${p.highlights.slice(0, 6).map((h) => html`<li>${h}</li>`)}</ul>` : ''}
          <div id="pdp-box"></div>
          ${p.type !== 'variable' && p.sku ? html`<p class="pdp-sku muted small">${t('pdp.sku', { sku: p.sku })}</p>` : ''}
        </div>
      </div>
      ${hasDetails ? html`<div class="pdp-details accordion">
        ${p.description ? html`<details open><summary>${t('pdp.description')}</summary><div class="acc-body prose">${raw(renderMarkdown(p.description))}</div></details>` : ''}
        ${p.specs.length ? html`<details ${p.description ? '' : 'open'}><summary>${t('pdp.specs')}</summary><div class="acc-body"><table class="table table-compact pdp-specs"><tbody>${p.specs.map((s) => html`<tr><th scope="row">${s.label}</th><td>${s.value}</td></tr>`)}</tbody></table></div></details>` : ''}
      </div>` : ''}
      <section class="pdp-section" id="reviews" aria-labelledby="rev-h"></section>
      ${related.length ? html`<section class="pdp-section"><h2>${t('pdp.related')}</h2>${productGrid(related, { priority: 0 })}</section>` : ''}
      ${recent.length ? html`<section class="pdp-section"><h2>${t('pdp.recent')}</h2>${productGrid(recent, { priority: 0 })}</section>` : ''}
    </div>`);

    const gallery = mountGallery(ctx.el.querySelector('#pdp-gallery'), { images: p.images, name: p.name });
    const box = mountBuyBox(ctx.el.querySelector('#pdp-box'), p, {
      initialVariant: ctx.query.v || '', eta,
      onImage: (url) => gallery.show(url),
      onVariant: (vid) => ctx.router.setQuery({ ...ctx.query, v: vid || '' }),
      navigate: (to) => ctx.router.navigate(to),
    });
    const reviews = mountReviews(ctx.el.querySelector('#reviews'), p);
    ctx.cleanup(bindProductCards(ctx.el));
    ctx.cleanup(() => { gallery.dispose(); box.dispose(); reviews.dispose(); });
    // a variant picked through ?v= may have its own picture
    const v0 = box.selectedVariant();
    if (v0) { const u = p.units.find((x) => x.variantId === v0); if (u && u.image) gallery.show(u.image); }
  },
};
