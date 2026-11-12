/*
 * Shared UI building blocks: toasts, modal / drawer / confirm / prompt, popover menu, form fields,
 * badges, empty + error states, pagination, stars, price. Everything is built with html`` so data is
 * always escaped; the only innerHTML writer is dom.render().
 */
import { html, render, raw, esc, trapFocus, focusFirst, withBusy, SafeHtml } from './dom.js';
import { icon } from './icons.js';
import { t, lbl } from './i18n.js';
import { money, num } from './format.js';
import { ORDER_STATUS, PAYMENT_STATUS, PRODUCT_STATUS, TICKET_STATUS } from '../shared/constants.js';

/* ───────────────────────── announcer (screen readers) ───────────────────────── */

export function announce(message) {
  const el = document.getElementById('announcer');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = String(message || ''); }, 30);
}

/* ───────────────────────── stylesheet loader ───────────────────────── */

const loadedCss = new Map();
/** Load a page stylesheet once. Resolves when it has applied (or failed, so a missing file never blocks a page). */
export function loadCss(href) {
  if (loadedCss.has(href)) return loadedCss.get(href);
  const p = new Promise((resolve) => {
    if ([...document.styleSheets].some((s) => s.href && s.href.endsWith(href))) return resolve();
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = href;
    link.onload = () => resolve(); link.onerror = () => resolve();
    document.head.appendChild(link);
  });
  loadedCss.set(href, p);
  return p;
}

/* ───────────────────────── toast ───────────────────────── */

function toastRoot() {
  let root = document.getElementById('toasts');
  if (!root) { root = document.createElement('div'); root.id = 'toasts'; root.className = 'toasts'; document.body.appendChild(root); }
  root.setAttribute('role', 'status'); root.setAttribute('aria-live', 'polite');
  return root;
}

/** toast('Saved'), toast('Failed', {type:'bad'}), toast('Removed', {action:{label:'Undo', onClick}}) */
export function toast(message, { type = 'ok', timeout = 3600, action = null } = {}) {
  const root = toastRoot();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const ic = type === 'bad' ? 'alert-circle' : type === 'info' ? 'info' : type === 'warn' ? 'alert-triangle' : 'check-circle';
  render(el, html`${icon(ic)}<span>${message}</span>${action ? html`<button type="button" class="btn btn-link" style="color:inherit;margin-inline-start:8px" data-toast-action>${action.label}</button>` : ''}`);
  root.appendChild(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  const close = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 220); };
  const timer = setTimeout(close, timeout);
  const btn = el.querySelector('[data-toast-action]');
  if (btn) btn.addEventListener('click', () => { clearTimeout(timer); try { action.onClick(); } finally { close(); } });
  return { close: () => { clearTimeout(timer); close(); } };
}
export const toastError = (message) => toast(message, { type: 'bad', timeout: 5500 });

/* ───────────────────────── modal / drawer ───────────────────────── */

let lockCount = 0;
const lockScroll = () => { if (lockCount++ === 0) document.body.classList.add('scroll-lock'); };
const unlockScroll = () => { lockCount = Math.max(0, lockCount - 1); if (lockCount === 0) document.body.classList.remove('scroll-lock'); };
const overlays = [];
let uid = 0;

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !overlays.length) return;
  const top = overlays[overlays.length - 1];
  if (top.dismissible) { e.stopPropagation(); top.close(undefined); }
});

function put(target, content) {
  if (content instanceof Node) { target.replaceChildren(content); return; }
  render(target, content instanceof SafeHtml ? content : html`${content}`);
}

const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * openModal({ title, body, footer, size: 'sm'|'md'|'lg'|'xl', dismissible, onClose })
 * → { el, bodyEl, footEl, close(value), setBody(safe), setFooter(safe), closed: Promise<value> }
 */
export function openModal({ title = '', body = '', footer = null, size = 'md', dismissible = true, onClose, initialFocus, className = '' } = {}) {
  const id = `m${++uid}`;
  const backdrop = document.createElement('div'); backdrop.className = 'backdrop';
  const wrap = document.createElement('div'); wrap.className = 'modal-wrap';
  const dlg = document.createElement('div');
  dlg.className = `modal ${size === 'sm' ? 'modal-sm' : size === 'lg' ? 'modal-lg' : size === 'xl' ? 'modal-xl' : ''} ${className}`.trim();
  dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', `${id}-t`);
  render(dlg, html`
    <div class="modal-head">
      <h2 class="modal-title" id="${id}-t">${title}</h2>
      ${dismissible ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close aria-label="${t('common.close')}">${icon('x')}</button>` : ''}
    </div>
    <div class="modal-body" data-modal-body></div>
    <div class="modal-foot" data-modal-foot ${footer ? '' : 'hidden'}></div>`);
  const bodyEl = dlg.querySelector('[data-modal-body]');
  const footEl = dlg.querySelector('[data-modal-foot]');
  put(bodyEl, body);
  if (footer) put(footEl, footer);
  wrap.appendChild(dlg);
  document.body.append(backdrop, wrap);
  lockScroll();

  let release = null; let done = false; let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const entry = {
    dismissible,
    close(value) {
      if (done) return; done = true;
      const idx = overlays.indexOf(entry); if (idx >= 0) overlays.splice(idx, 1);
      dlg.classList.remove('is-open'); backdrop.classList.remove('is-open');
      const finish = () => { backdrop.remove(); wrap.remove(); unlockScroll(); if (release) release(); if (onClose) onClose(value); resolveClosed(value); };
      if (reduced()) finish(); else setTimeout(finish, 200);
    },
  };
  overlays.push(entry);
  backdrop.addEventListener('click', () => { if (dismissible) entry.close(undefined); });
  wrap.addEventListener('click', (e) => { if (e.target === wrap && dismissible) entry.close(undefined); });
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) entry.close(undefined); });
  release = trapFocus(dlg);
  requestAnimationFrame(() => {
    backdrop.classList.add('is-open'); dlg.classList.add('is-open');
    const target = initialFocus ? dlg.querySelector(initialFocus) : null;
    if (target) target.focus({ preventScroll: true }); else focusFirst(bodyEl.children.length ? bodyEl : dlg);
  });

  return {
    el: dlg, bodyEl, footEl, closed,
    close: (v) => entry.close(v),
    setBody: (c) => put(bodyEl, c),
    setFooter: (c) => { footEl.hidden = !c; if (c) put(footEl, c); },
    setTitle: (s) => { dlg.querySelector('.modal-title').textContent = s; },
  };
}

/** openDrawer({ title, body, footer, side: 'end'|'start' }) – same return shape as openModal. */
export function openDrawer({ title = '', body = '', footer = null, side = 'end', onClose, dismissible = true, width } = {}) {
  const id = `d${++uid}`;
  const backdrop = document.createElement('div'); backdrop.className = 'backdrop drawer-backdrop';
  const dr = document.createElement('aside');
  dr.className = `drawer ${side === 'start' ? 'drawer-left' : ''}`;
  if (width) dr.style.width = width;
  dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-modal', 'true'); dr.setAttribute('aria-labelledby', `${id}-t`);
  render(dr, html`
    <div class="drawer-head"><h2 class="modal-title" id="${id}-t">${title}</h2>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close aria-label="${t('common.close')}">${icon('x')}</button></div>
    <div class="drawer-body" data-modal-body></div>
    <div class="drawer-foot" data-modal-foot ${footer ? '' : 'hidden'}></div>`);
  const bodyEl = dr.querySelector('[data-modal-body]'); const footEl = dr.querySelector('[data-modal-foot]');
  put(bodyEl, body); if (footer) put(footEl, footer);
  document.body.append(backdrop, dr);
  lockScroll();
  let release = null; let done = false; let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const entry = {
    dismissible,
    close(value) {
      if (done) return; done = true;
      const idx = overlays.indexOf(entry); if (idx >= 0) overlays.splice(idx, 1);
      dr.classList.remove('is-open'); backdrop.classList.remove('is-open');
      const finish = () => { backdrop.remove(); dr.remove(); unlockScroll(); if (release) release(); if (onClose) onClose(value); resolveClosed(value); };
      if (reduced()) finish(); else setTimeout(finish, 220);
    },
  };
  overlays.push(entry);
  backdrop.addEventListener('click', () => { if (dismissible) entry.close(undefined); });
  dr.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) entry.close(undefined); });
  release = trapFocus(dr);
  requestAnimationFrame(() => { backdrop.classList.add('is-open'); dr.classList.add('is-open'); focusFirst(dr); });
  return { el: dr, bodyEl, footEl, closed, close: (v) => entry.close(v), setBody: (c) => put(bodyEl, c), setFooter: (c) => { footEl.hidden = !c; if (c) put(footEl, c); } };
}

/** Promise<boolean>. */
export function confirmDialog({ title, message = '', confirmText, cancelText, danger = false, details = null } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title: title || t('common.confirm'), size: 'sm',
      body: html`<p>${message}</p>${details ? html`<div class="mt-4 small muted">${details}</div>` : ''}`,
      footer: html`<button type="button" class="btn" data-no>${cancelText || t('common.cancel')}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${confirmText || t('common.confirm')}</button>`,
      onClose: (v) => resolve(v === true),
    });
    m.footEl.querySelector('[data-yes]').addEventListener('click', () => m.close(true));
    m.footEl.querySelector('[data-no]').addEventListener('click', () => m.close(false));
    m.footEl.querySelector(danger ? '[data-no]' : '[data-yes]').focus();
  });
}

/**
 * A dialog that holds one <form> and two buttons. `onSubmit(form, dialog)` runs on confirm / Enter and returns true when it
 * finished (the dialog closes) or false to stay open (validation errors, a failed save). Resolves with true | false | undefined.
 */
export function formDialog({ title, body, confirmText, cancelText, danger = false, size = 'md', onSubmit } = {}) {
  const m = openModal({
    title, size, body,
    footer: html`<button type="button" class="btn" data-no>${cancelText || t('common.cancel')}</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${confirmText || t('common.save')}</button>`,
  });
  const form = m.bodyEl.querySelector('form');
  const yes = m.footEl.querySelector('[data-yes]');
  const submit = () => withBusy(yes, async () => { if (await onSubmit(form, m)) m.close(true); });
  yes.addEventListener('click', submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  m.footEl.querySelector('[data-no]').addEventListener('click', () => m.close(false));
  return m.closed;
}

export function alertDialog({ title, message, okText } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title: title || '', size: 'sm', body: html`<p>${message}</p>`,
      footer: html`<button type="button" class="btn btn-primary" data-ok>${okText || t('common.ok')}</button>`, onClose: () => resolve(),
    });
    m.footEl.querySelector('[data-ok]').addEventListener('click', () => m.close());
  });
}

/** Promise<string|null>. validate(value) → error message | ''. */
export function promptDialog({ title, label = '', value = '', placeholder = '', multiline = false, required = false, confirmText, type = 'text', hint = '', validate, maxLength = 300 } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title: title || label, size: 'sm',
      body: html`<form data-prompt novalidate>${fieldHtml({ name: 'value', label, type: multiline ? 'textarea' : type, value, placeholder, required, hint, attrs: { maxlength: maxLength }, rows: 4 })}</form>`,
      footer: html`<button type="button" class="btn" data-no>${t('common.cancel')}</button><button type="button" class="btn btn-primary" data-yes>${confirmText || t('common.ok')}</button>`,
      onClose: (v) => resolve(typeof v === 'string' ? v : null),
    });
    const input = m.bodyEl.querySelector('[name=value]');
    const err = m.bodyEl.querySelector('#err-value');
    const submit = () => {
      const v = input.value.trim();
      const msg = (required && !v) ? t('v.required') : (validate ? validate(v) : '');
      if (msg) { input.setAttribute('aria-invalid', 'true'); err.textContent = msg; input.focus(); return; }
      m.close(v);
    };
    m.footEl.querySelector('[data-yes]').addEventListener('click', submit);
    m.footEl.querySelector('[data-no]').addEventListener('click', () => m.close(null));
    m.bodyEl.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    input.focus(); input.select?.();
  });
}

/* ───────────────────────── popover menu ───────────────────────── */

let openMenuEl = null;
/** openMenu({ anchor, items:[{label, icon?, href?, onClick?, danger?, divider?}], align:'end'|'start' }) */
export function openMenu({ anchor, items, align = 'end' }) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu'; el.setAttribute('role', 'menu'); el.style.position = 'fixed';
  render(el, html`${items.map((it, i) => it.divider ? html`<hr>` : (it.href
    ? html`<a role="menuitem" href="${it.href}" data-i="${i}" ${it.native ? raw('data-native') : ''}>${it.icon ? icon(it.icon) : ''}<span>${it.label}</span></a>`
    : html`<button type="button" role="menuitem" data-i="${i}" ${it.danger ? raw('style="color:var(--danger)"') : ''}>${it.icon ? icon(it.icon) : ''}<span>${it.label}</span></button>`))}`);
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth; const h = el.offsetHeight;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = `${left}px`; el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const focusables = () => [...el.querySelectorAll('[role=menuitem]')];
  focusables()[0]?.focus();
  const onKey = (e) => {
    const list = focusables(); const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Tab') closeMenu();
  };
  const onDown = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
  const onClick = (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    const it = items[Number(b.dataset.i)]; closeMenu();
    if (it && it.onClick) it.onClick();
  };
  /* The menu is position:fixed next to its button, so a real scroll or a change of width (rotation) closes it. Two things must not:
     the scroll that brought the button into view a moment ago, and a height-only resize (the phone's address bar sliding away). */
  const openedAt = performance.now(); const width0 = window.innerWidth;
  const onScroll = () => { if (performance.now() - openedAt > 150) closeMenu(); };
  const onResize = () => { if (window.innerWidth !== width0) closeMenu(); };
  el.addEventListener('keydown', onKey); el.addEventListener('click', onClick);
  setTimeout(() => { if (openMenuEl && openMenuEl.el === el) document.addEventListener('pointerdown', onDown, true); }, 0);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  openMenuEl = { el, anchor, onDown, onScroll, onResize };
  return el;
}
export function closeMenu(restoreFocus = false) {
  if (!openMenuEl) return;
  const { el, anchor, onDown, onScroll, onResize } = openMenuEl; openMenuEl = null;
  document.removeEventListener('pointerdown', onDown, true);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('scroll', onScroll, { capture: true });
  el.remove(); anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus) anchor.focus({ preventScroll: true });
}

/* ───────────────────────── form fields ───────────────────────── */

export function attrsHtml(attrs = {}) {
  return raw(Object.entries(attrs).filter(([, v]) => v !== false && v !== undefined && v !== null)
    .map(([k, v]) => (v === true ? ` ${esc(k)}` : ` ${esc(k)}="${esc(v)}"`)).join(''));
}

/**
 * Accessible form field with label, hint and an error slot (#err-<name>, filled by showFormErrors()).
 * type: text|email|tel|number|password|date|datetime-local|url|search|textarea|select|checkbox|switch
 */
export function fieldHtml({ name, label = '', type = 'text', value = '', id, required = false, hint = '', placeholder = '', options = null, rows = 3, attrs = {}, autocomplete, inputmode, cls = '', span2 = false, prefix = '', suffix = '' } = {}) {
  const fid = id || `f-${name}`;
  const describedBy = `${hint ? `hint-${name} ` : ''}err-${name}`;
  const common = { id: fid, name, required: required || undefined, autocomplete, inputmode, placeholder: placeholder || undefined, 'aria-describedby': describedBy, ...attrs };
  const wrapCls = `field ${span2 ? 'span-2' : ''} ${cls}`.trim();
  const hintEl = hint ? html`<div class="field-hint" id="hint-${name}">${hint}</div>` : '';
  const errEl = html`<div class="field-error" id="err-${name}" aria-live="polite"></div>`;

  if (type === 'checkbox') {
    return html`<div class="${wrapCls}"><label class="check"><input type="checkbox" ${attrsHtml({ ...common, 'aria-describedby': undefined, checked: value === true || value === 'true' || undefined })}><span>${label}</span></label>${hintEl}${errEl}</div>`;
  }
  if (type === 'switch') {
    return html`<div class="${wrapCls}"><label class="switch"><input type="checkbox" role="switch" ${attrsHtml({ ...common, 'aria-describedby': undefined, checked: value === true || value === 'true' || undefined })}><span class="track"></span><span>${label}</span></label>${hintEl}${errEl}</div>`;
  }
  const labelEl = label ? html`<label for="${fid}" class="${required ? 'req' : ''}">${label}</label>` : '';
  let control;
  if (type === 'textarea') control = html`<textarea class="textarea" rows="${rows}" ${attrsHtml(common)}>${value ?? ''}</textarea>`;
  else if (type === 'select') {
    control = html`<select class="select" ${attrsHtml(common)}>${(options || []).map((o) => html`<option value="${o.value}" ${String(o.value) === String(value) ? raw('selected') : ''} ${o.disabled ? raw('disabled') : ''}>${o.label}</option>`)}</select>`;
  } else {
    const input = html`<input class="input" type="${type}" value="${value ?? ''}" ${attrsHtml(common)}>`;
    control = (prefix || suffix)
      ? html`<div class="input-group">${prefix ? html`<span class="input-prefix">${prefix}</span>` : ''}${input}${suffix ? html`<span class="input-prefix" style="border-inline-start:0;border-inline-end:1px solid var(--border-strong);border-radius:0 var(--r-md) var(--r-md) 0">${suffix}</span>` : ''}</div>`
      : input;
  }
  return html`<div class="${wrapCls}">${labelEl}${control}${hintEl}${errEl}</div>`;
}

/* ───────────────────────── badges & states ───────────────────────── */

const TONES = { ok: 'badge-ok', warn: 'badge-warn', bad: 'badge-bad', info: 'badge-info', brand: 'badge-brand', sale: 'badge-sale', neutral: '' };
export const badge = (text, tone = 'neutral') => html`<span class="badge ${TONES[tone] ?? ''}">${text}</span>`;
export const statusBadge = (status) => { const s = ORDER_STATUS[status] || ORDER_STATUS.pending; return badge(lbl(s), s.tone); };
export const paymentBadge = (status) => { const s = PAYMENT_STATUS[status] || PAYMENT_STATUS.unpaid; return badge(lbl(s), s.tone); };
export const productStatusBadge = (status) => { const s = PRODUCT_STATUS[status] || PRODUCT_STATUS.draft; return badge(lbl(s), s.tone); };
export const ticketBadge = (status) => { const s = TICKET_STATUS[status] || TICKET_STATUS.open; return badge(lbl(s), s.tone); };

export function emptyState({ icon: ic = 'inbox', title = '', text = '', action = null } = {}) {
  return html`<div class="empty">${icon(ic)}<h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}${action ? html`<a class="btn btn-primary" href="${action.href || '#'}" ${action.act ? raw(`data-action="${esc(action.act)}"`) : ''}>${action.label}</a>` : ''}</div>`;
}
export function errorState({ title, text = '', retry = true } = {}) {
  return html`<div class="empty" role="alert">${icon('alert-triangle')}<h3>${title || t('common.error')}</h3>${text ? html`<p>${text}</p>` : ''}${retry ? html`<button class="btn btn-primary" data-action="retry">${t('common.retry')}</button>` : ''}</div>`;
}
export const spinnerBlock = (label = t('common.loading')) => html`<div class="empty" role="status"><span class="spinner" aria-hidden="true"></span><span class="muted">${label}</span></div>`;
export function skeletonCards(n = 8) {
  return html`${Array.from({ length: n }, () => html`<div class="skeleton-card" aria-hidden="true"><div class="skeleton sk-img"></div><div class="skeleton sk-line" style="width:80%"></div><div class="skeleton sk-line" style="width:45%"></div></div>`)}`;
}
export function skeletonRows(n = 6) {
  return html`${Array.from({ length: n }, () => html`<div class="skeleton sk-line" style="height:44px;margin-block:8px" aria-hidden="true"></div>`)}`;
}

/** Pagination buttons: `data-action="page" data-page="N"`. */
export function paginationHtml({ page, pages, action = 'page' }) {
  if (pages <= 1) return html``;
  const nums = new Set([1, pages, page - 1, page, page + 1]);
  const list = [...nums].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items = [];
  list.forEach((n, i) => { if (i && n - list[i - 1] > 1) items.push('…'); items.push(n); });
  return html`<nav class="pagination" aria-label="${t('common.page', { n: page })}">
    <button type="button" class="page-btn" data-action="${action}" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''} aria-label="${t('common.prev')}">${icon('chevron-left')}</button>
    ${items.map((n) => n === '…' ? html`<span class="muted" aria-hidden="true">…</span>` : html`<button type="button" class="page-btn" data-action="${action}" data-page="${n}" ${n === page ? raw('aria-current="page"') : ''}>${num(n)}</button>`)}
    <button type="button" class="page-btn" data-action="${action}" data-page="${page + 1}" ${page >= pages ? raw('disabled') : ''} aria-label="${t('common.next')}">${icon('chevron-right')}</button>
  </nav>`;
}

/** ★★★★☆ with an accessible text value. */
export function stars(rating = 0, { count = null, size = 16 } = {}) {
  const r = Math.max(0, Math.min(5, Number(rating) || 0));
  const full = Math.round(r);
  return html`<span class="rating" role="img" aria-label="${r.toFixed(1)} / 5">${[0, 1, 2, 3, 4].map((i) => icon('star', { fill: i < full, size }))}${count !== null ? html`<span class="rating-text">${num(count)}</span>` : ''}</span>`;
}

/** Price block: sale price + struck-through regular price, or "from" for ranges. */
export function priceHtml({ now, old = null, from = false, size = '' } = {}) {
  const sale = old !== null && old > now;
  return html`<span class="price ${size}">${from ? html`<span class="price-from">${t('common.from', null, 'From')}</span>` : ''}<span class="price-now ${sale ? 'is-sale' : ''}">${money(now)}</span>${sale ? html`<s class="price-old"><span class="sr-only">${t('common.was', null, 'Was')} </span>${money(old)}</s>` : ''}</span>`;
}
