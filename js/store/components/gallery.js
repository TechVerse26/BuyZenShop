/*
 * Product gallery — swipeable main image (CSS scroll-snap), thumbnail strip and a zoomable lightbox.
 *
 *   const gal = mountGallery(el, { images, name })      images: [{ url, thumb, alt, w, h }]
 *   gal.show(url)      jump to the picture with that URL (a variant can have its own picture)
 *   gal.dispose()
 */
import { html, render, safeUrl, bindActions } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { openModal } from '../../core/ui.js';
import { num } from '../../core/format.js';

registerBoth({
  'gal.zoom': ['Zoom image', 'ছবি বড় করুন'],
  'gal.image': ['Image {n} of {total}', 'ছবি {n} / {total}'],
  'gal.prev': ['Previous image', 'আগের ছবি'],
  'gal.next': ['Next image', 'পরের ছবি'],
  'gal.none': ['No image available', 'ছবি নেই'],
  'gal.zoomIn': ['Zoom in', 'বড় করুন'],
  'gal.zoomOut': ['Zoom out', 'ছোট করুন'],
});

const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const label = (i, total) => t('gal.image', { n: num(i + 1), total: num(total) });

function openLightbox(list, start, name) {
  let i = start;
  let zoomed = false;
  let drag = null;
  const many = list.length > 1;
  const modal = openModal({
    title: name, size: 'xl', className: 'lightbox',
    body: html`<div class="lb">
      <div class="lb-stage" data-stage><img class="lb-img" alt="" decoding="async"></div>
      <div class="lb-bar">
        <button type="button" class="btn btn-secondary btn-icon" data-lb="prev" aria-label="${t('gal.prev')}" ${many ? '' : 'hidden'}>${icon('chevron-left')}</button>
        <span class="lb-count" data-count aria-live="polite"></span>
        <button type="button" class="btn btn-secondary btn-icon" data-lb="next" aria-label="${t('gal.next')}" ${many ? '' : 'hidden'}>${icon('chevron-right')}</button>
        <button type="button" class="btn btn-secondary btn-icon" data-lb="zoom" aria-pressed="false" aria-label="${t('gal.zoomIn')}">${icon('zoom-in')}</button>
      </div>
    </div>`,
  });
  const root = modal.el;
  const stage = root.querySelector('[data-stage]');
  const img = root.querySelector('.lb-img');
  const count = root.querySelector('[data-count]');
  const zoomBtn = root.querySelector('[data-lb="zoom"]');

  const setZoom = (z) => {
    zoomed = z;
    stage.classList.toggle('is-zoomed', z);
    zoomBtn.setAttribute('aria-pressed', String(z));
    zoomBtn.setAttribute('aria-label', t(z ? 'gal.zoomOut' : 'gal.zoomIn'));
    if (z) { stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2; stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2; }
    else { stage.scrollLeft = 0; stage.scrollTop = 0; }
  };
  const paint = () => {
    const im = list[i];
    img.src = safeUrl(im.url);
    img.alt = im.alt || name;
    count.textContent = label(i, list.length);
    setZoom(false);
  };
  const step = (d) => { i = (i + d + list.length) % list.length; paint(); };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb]');
    if (!b) return;
    if (b.dataset.lb === 'prev') step(-1);
    else if (b.dataset.lb === 'next') step(1);
    else setZoom(!zoomed);
  });
  img.addEventListener('click', () => { if (!(drag && drag.moved)) setZoom(!zoomed); });
  root.addEventListener('keydown', (e) => {
    if (!many) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  // mouse drag pans a zoomed picture (touch uses the browser's native scrolling)
  stage.addEventListener('pointerdown', (e) => {
    if (!zoomed || e.pointerType === 'touch') return;
    drag = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    stage.scrollLeft = drag.sl - dx; stage.scrollTop = drag.st - dy;
  });
  const endDrag = () => { setTimeout(() => { drag = null; }, 0); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  paint();
  return modal;
}

export function mountGallery(el, { images = [], name = '' } = {}) {
  const list = images.filter((im) => im && im.url);
  if (!list.length) {
    render(el, html`<div class="gal"><div class="gal-empty" role="img" aria-label="${t('gal.none')}">${icon('image', { size: 48 })}</div></div>`);
    return { show() {}, dispose() {} };
  }
  const many = list.length > 1;
  render(el, html`<div class="gal">
    <div class="gal-main">
      <div class="gal-track" data-track tabindex="0" role="group" aria-roledescription="carousel" aria-label="${name}">
        ${list.map((im, i) => html`<div class="gal-slide" role="group" aria-roledescription="slide" aria-label="${label(i, list.length)}">
          <button type="button" class="gal-open" data-action="zoom" data-i="${i}" aria-label="${t('gal.zoom')}">
            <img src="${safeUrl(im.url)}" alt="${im.alt || name}" width="${im.w || 800}" height="${im.h || 800}" loading="${i === 0 ? 'eager' : 'lazy'}" fetchpriority="${i === 0 ? 'high' : 'auto'}" decoding="async">
          </button>
        </div>`)}
      </div>
      ${many ? html`<button type="button" class="gal-nav gal-prev" data-action="prev" aria-label="${t('gal.prev')}">${icon('chevron-left')}</button>
        <button type="button" class="gal-nav gal-next" data-action="next" aria-label="${t('gal.next')}">${icon('chevron-right')}</button>
        <span class="gal-count" data-count aria-hidden="true"></span>` : ''}
    </div>
    ${many ? html`<ul class="gal-thumbs">${list.map((im, i) => html`<li><button type="button" class="gal-thumb" data-action="go" data-i="${i}" aria-label="${label(i, list.length)}" aria-current="${i === 0 ? 'true' : 'false'}"><img src="${safeUrl(im.thumb || im.url)}" alt="" width="64" height="64" loading="lazy" decoding="async"></button></li>`)}</ul>` : ''}
  </div>`);

  const track = el.querySelector('[data-track]');
  const strip = el.querySelector('.gal-thumbs');
  const thumbs = [...el.querySelectorAll('.gal-thumb')];
  const count = el.querySelector('[data-count]');
  let cur = 0;
  let lightbox = null;

  const paint = (centerThumb) => {
    thumbs.forEach((b, k) => b.setAttribute('aria-current', String(k === cur)));
    if (count) count.textContent = `${num(cur + 1)} / ${num(list.length)}`;
    if (centerThumb && strip && thumbs[cur]) strip.scrollTo({ left: thumbs[cur].offsetLeft - (strip.clientWidth - thumbs[cur].offsetWidth) / 2, behavior: reduced() ? 'auto' : 'smooth' });
  };
  const goTo = (n, smooth = true) => {
    const k = Math.max(0, Math.min(list.length - 1, n));
    track.scrollTo({ left: k * track.clientWidth, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  };
  const step = (d) => goTo((cur + d + list.length) % list.length);
  const onScroll = () => {
    const k = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    if (k !== cur && k >= 0 && k < list.length) { cur = k; paint(true); }
  };
  const onKey = (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  };
  track.addEventListener('scroll', onScroll, { passive: true });
  track.addEventListener('keydown', onKey);
  const off = bindActions(el, {
    zoom: (b) => { lightbox = openLightbox(list, Number(b.dataset.i) || 0, name); },
    go: (b) => goTo(Number(b.dataset.i)),
    prev: () => step(-1),
    next: () => step(1),
  });
  paint(false);

  return {
    show(url) { const k = list.findIndex((im) => im.url === url); if (k >= 0 && k !== cur) goTo(k, false); },
    dispose() { off(); track.removeEventListener('scroll', onScroll); track.removeEventListener('keydown', onKey); if (lightbox) lightbox.close(); },
  };
}
