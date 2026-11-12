/*
 * Light / dark / system theme. The choice is stored per app (storefront and admin keep separate keys)
 * and applied as <html data-theme="light|dark">; "system" removes the attribute so the
 * prefers-color-scheme media query in tokens.css decides. js/theme-init.js applies the stored
 * value before first paint to avoid a flash.
 */
import { local } from './storage.js';

const MODES = ['system', 'light', 'dark'];
const COLORS = { light: '#F7F5F0', dark: '#0F1513' };

function apply(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', COLORS[effectiveTheme()]);
}

export function effectiveTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const getTheme = (key) => { const v = local.get(key, 'system'); return MODES.includes(v) ? v : 'system'; };
export function initTheme(key) {
  apply(getTheme(key));
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply(getTheme(key)));
}
export function setTheme(key, mode) { const m = MODES.includes(mode) ? mode : 'system'; local.set(key, m); apply(m); return m; }
/** system → light → dark → system … returns the new mode. */
export function cycleTheme(key) { const cur = getTheme(key); return setTheme(key, MODES[(MODES.indexOf(cur) + 1) % MODES.length]); }
/** Toggle between the two visible themes (what a simple sun/moon button needs). */
export function toggleTheme(key) { return setTheme(key, effectiveTheme() === 'dark' ? 'light' : 'dark'); }
