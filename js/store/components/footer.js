/*
 * Storefront footer. Everything shown comes from the public settings, the catalog or the CMS page list —
 * nothing is invented: contact lines, social links and payment methods appear only when they are configured.
 *   mountFooter(el, { router }) → disposer
 */
import { html, render, safeUrl } from '../../core/dom.js';
import { registerBoth, t, lbl, onLangChange } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { PAYMENT_METHODS } from '../../shared/constants.js';
import { settings, onSettings, enabledPayments, loadPageList } from '../../data/settings.js';
import { getCatalog, loadCatalog } from '../../data/catalog.js';
import { categoryUrl, pageUrl } from '../lib/links.js';

registerBoth({
  'ftr.shop': ['Shop', 'কেনাকাটা'],
  'ftr.all': ['All products', 'সব পণ্য'],
  'ftr.help': ['Help', 'সহায়তা'],
  'ftr.track': ['Track your order', 'অর্ডার ট্র্যাক করুন'],
  'ftr.contact': ['Contact us', 'যোগাযোগ করুন'],
  'ftr.follow': ['Follow us', 'আমাদের সাথে থাকুন'],
  'ftr.pay': ['Payment methods', 'পেমেন্ট পদ্ধতি'],
  'ftr.whatsapp': ['WhatsApp', 'হোয়াটসঅ্যাপ'],
  'ftr.facebook': ['Facebook', 'ফেসবুক'],
  'ftr.instagram': ['Instagram', 'ইনস্টাগ্রাম'],
  'ftr.youtube': ['YouTube', 'ইউটিউব'],
  'ftr.tiktok': ['TikTok', 'টিকটক'],
  'ftr.rights': ['All rights reserved.', 'সর্বস্বত্ব সংরক্ষিত।'],
});

const SOCIAL = [['facebook', 'facebook'], ['instagram', 'instagram'], ['youtube', 'youtube'], ['tiktok', 'link']];

export function mountFooter(el) {
  let pages = [];

  const draw = () => {
    const st = settings();
    const c = st.contact || {};
    const so = st.social || {};
    const cat = getCatalog();
    const cats = (cat && cat.categoryTree ? cat.categoryTree : []).slice(0, 6);
    const pay = enabledPayments();
    const wa = String(c.whatsapp || '').replace(/\D/g, '');
    const phone = String(c.phone || '').trim();
    const socials = SOCIAL.filter(([k]) => so[k] && safeUrl(so[k], '') !== '');
    const extra = pages.filter((p) => p.footer !== false);
    const hasContact = !!(phone || wa.length >= 8 || c.email || c.address);

    render(el, html`<div class="container ftr">
      <div class="ftr-grid">
        <section class="ftr-col ftr-about">
          <div class="ftr-brand">${st.storeName}</div>
          ${st.tagline ? html`<p class="ftr-tag">${st.tagline}</p>` : ''}
          ${hasContact ? html`<ul class="ftr-contact">
            ${phone ? html`<li>${icon('phone', { size: 16 })}<a href="tel:${phone.replace(/[^\d+]/g, '')}">${phone}</a></li>` : ''}
            ${wa.length >= 8 ? html`<li>${icon('message-circle', { size: 16 })}<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">${t('ftr.whatsapp')}</a></li>` : ''}
            ${c.email ? html`<li>${icon('mail', { size: 16 })}<a href="mailto:${c.email}">${c.email}</a></li>` : ''}
            ${c.address ? html`<li>${icon('map-pin', { size: 16 })}<span>${c.address}</span></li>` : ''}
          </ul>` : ''}
        </section>

        <nav class="ftr-col" aria-labelledby="ftr-h-shop">
          <h2 id="ftr-h-shop">${t('ftr.shop')}</h2>
          <ul>
            <li><a href="/shop">${t('ftr.all')}</a></li>
            ${cats.map((k) => html`<li><a href="${categoryUrl(k)}">${k.name}</a></li>`)}
          </ul>
        </nav>

        <nav class="ftr-col" aria-labelledby="ftr-h-help">
          <h2 id="ftr-h-help">${t('ftr.help')}</h2>
          <ul>
            <li><a href="/track">${t('ftr.track')}</a></li>
            <li><a href="/contact">${t('ftr.contact')}</a></li>
            ${extra.map((p) => html`<li><a href="${pageUrl(p.slug || p.id)}">${p.title || p.slug || p.id}</a></li>`)}
          </ul>
        </nav>

        ${(socials.length || pay.length) ? html`<section class="ftr-col">
          ${socials.length ? html`<h2>${t('ftr.follow')}</h2>
            <div class="ftr-social">${socials.map(([k, ic]) => html`<a href="${safeUrl(so[k])}" target="_blank" rel="noopener noreferrer" aria-label="${t('ftr.' + k)}">${icon(ic, { size: 18 })}</a>`)}</div>` : ''}
          ${pay.length ? html`<h2 class="${socials.length ? 'ftr-h-gap' : ''}">${t('ftr.pay')}</h2>
            <div class="ftr-pay">${pay.map((m) => html`<span class="badge">${PAYMENT_METHODS[m] ? lbl(PAYMENT_METHODS[m]) : m}</span>`)}</div>` : ''}
        </section>` : ''}
      </div>
      <div class="ftr-bottom"><span>© ${new Date().getFullYear()} ${st.storeName}</span><span>${t('ftr.rights')}</span></div>
    </div>`);
  };

  draw();
  const offs = [onSettings(draw), onLangChange(draw)];
  loadCatalog().then(draw).catch(() => { /* footer works without categories */ });
  loadPageList().then((list) => { pages = Array.isArray(list) ? list : []; draw(); }).catch(() => { /* no CMS pages */ });
  return () => offs.forEach((off) => { if (typeof off === 'function') off(); });
}
