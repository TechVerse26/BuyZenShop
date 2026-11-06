/*
 * DOM helpers: a safe `html` template tag (everything interpolated is escaped unless it is itself
 * produced by `html`/`raw`), event delegation, form helpers, focus management, <head> meta.
 *
 * Rule for all UI code: never concatenate data into strings that reach innerHTML; use html`...`.
 * URLs coming from data must go through safeUrl().
 */

export class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

/** Mark a string as already-safe HTML (only for trusted, pre-sanitised strings, e.g. renderMarkdown output). */
export const raw = (s) => new SafeHtml(String(s ?? ''));

function toHtml(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** aria-pressed / aria-expanded / aria-checked need the *text* "true" or "false"; html`` renders a bare boolean as nothing, so wrap it: aria-pressed="${aria(on)}". */
export const aria = (v) => (v ? 'true' : 'false');

/** Replace the contents of `target` with safe HTML. The only place that touches innerHTML. */
export function render(target, safe) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return null;
  el.innerHTML = safe instanceof SafeHtml ? safe.s : esc(safe);
  return el;
}

/** http(s), mailto, tel, same-site relative paths and data:image/(png|jpeg|webp|gif) only. */
export function safeUrl(u, fallback = '#') {
  const s = String(u ?? '').trim();
  if (!s) return fallback;
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return fallback;       // any other scheme (javascript:, vbscript: …)
  if (s.startsWith('//')) return fallback;
  return s;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated listener: handler(event, matchedElement). Returns an unsubscribe function. */
export function delegate(root, type, selector, handler, opts) {
  const fn = (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (el && root.contains(el)) handler(ev, el);
  };
  root.addEventListener(type, fn, opts);
  return () => root.removeEventListener(type, fn, opts);
}

/**
 * Wire `data-action="name"` clicks (and `data-change` / `data-input` / `submit` on forms with data-form).
 *   actions: { name: (el, ev) => ... }
 * Returns a disposer. Handlers may be async; rejections go to console.error.
 */
export function bindActions(root, actions = {}, { change = {}, input = {}, submit = {} } = {}) {
  const run = (fn, el, ev) => { try { const r = fn(el, ev); if (r && typeof r.catch === 'function') r.catch((e) => console.error(e)); } catch (e) { console.error(e); } };
  const offs = [
    delegate(root, 'click', '[data-action]', (ev, el) => {
      const fn = actions[el.dataset.action];
      if (!fn) return;
      if (el.tagName === 'A' && !ev.metaKey && !ev.ctrlKey) ev.preventDefault();
      run(fn, el, ev);
    }),
    delegate(root, 'change', '[data-change]', (ev, el) => { const fn = change[el.dataset.change]; if (fn) run(fn, el, ev); }),
    delegate(root, 'input', '[data-input]', (ev, el) => { const fn = input[el.dataset.input]; if (fn) run(fn, el, ev); }),
    delegate(root, 'submit', 'form[data-form]', (ev, el) => { const fn = submit[el.dataset.form]; if (fn) { ev.preventDefault(); run(fn, el, ev); } }),
  ];
  return () => offs.forEach((f) => f());
}

/** Read a form into a plain object. checkbox→bool, [data-type=number]/type=number→number|null, others trimmed strings. */
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; else if (!(el.name in out)) out[el.name] = ''; continue; }
    if (el.type === 'file') continue;
    let v = el.value;
    if (el.type === 'number' || el.dataset.type === 'number') { v = v === '' ? null : Number(v); }
    else if (typeof v === 'string' && el.dataset.trim !== 'false') v = v.trim();
    out[el.name] = v;
  }
  return out;
}

/** Disable a button and show its busy spinner while `fn` runs. */
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.getAttribute('aria-busy') === 'true') return undefined;
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try { return await fn(); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
}

export function debounce(fn, ms = 250) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t); return d;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function focusFirst(container) {
  const el = container.querySelector('[autofocus]') || container.querySelector(FOCUSABLE);
  if (el) el.focus({ preventScroll: true });
}
/** Keep Tab inside `container` and restore focus on release. */
export function trapFocus(container) {
  const prev = document.activeElement;
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => { container.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus({ preventScroll: true }); };
}

/** Update <title>, description, canonical, robots and social tags for the current route. */
export function setMeta({ title, description, canonical, image, noindex = false, siteName = 'Shop Verse', type = 'website', jsonLd } = {}) {
  const full = title ? (siteName && !title.includes(siteName) ? `${title} | ${siteName}` : title) : siteName;
  document.title = full;
  const set = (sel, attrs, content) => {
    let el = document.head.querySelector(sel);
    if (!content) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement(sel.startsWith('link') ? 'link' : 'meta'); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); document.head.appendChild(el); }
    el.setAttribute(sel.startsWith('link') ? 'href' : 'content', content);
  };
  set('meta[name="description"]', { name: 'description' }, description);
  set('meta[name="robots"]', { name: 'robots' }, noindex ? 'noindex,nofollow' : '');
  set('link[rel="canonical"]', { rel: 'canonical' }, canonical);
  set('meta[property="og:title"]', { property: 'og:title' }, full);
  set('meta[property="og:description"]', { property: 'og:description' }, description);
  set('meta[property="og:type"]', { property: 'og:type' }, type);
  set('meta[property="og:image"]', { property: 'og:image' }, image);
  set('meta[property="og:site_name"]', { property: 'og:site_name' }, siteName);
  set('meta[name="twitter:card"]', { name: 'twitter:card' }, image ? 'summary_large_image' : 'summary');
  let ld = document.head.querySelector('script[data-jsonld]');
  if (jsonLd) {
    if (!ld) { ld = document.createElement('script'); ld.type = 'application/ld+json'; ld.dataset.jsonld = '1'; document.head.appendChild(ld); }
    ld.textContent = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
  } else if (ld) ld.remove();
}

/** Copy text to the clipboard with a legacy fallback. Resolves true on success. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

/** Trigger a client-side file download. */
export function downloadFile(name, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
