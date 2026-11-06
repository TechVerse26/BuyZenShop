/*
 * Form validation. Validators return an error *message* (already translated) or '' when valid.
 *
 *   const { ok, errors, values } = validateForm(readForm(form), {
 *     name:  [required, minLen(2)],
 *     phone: [required, phone],
 *   });
 *   showFormErrors(form, errors);            // sets aria-invalid + fills #err-<name>
 *
 * Mirrors the constraints in firestore.rules so people see the problem before the server rejects the write.
 */
import { t } from './i18n.js';
import { PATTERNS } from '../shared/constants.js';
import { normalizePhone } from '../shared/id.js';
import { focusFirst } from './dom.js';

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export const required = (v) => (blank(v) ? t('v.required') : '');
export const minLen = (n) => (v) => (blank(v) || String(v).trim().length >= n ? '' : t('v.min', { n }));
export const maxLen = (n) => (v) => (blank(v) || String(v).length <= n ? '' : t('v.max', { n }));
export const phone = (v) => (blank(v) || normalizePhone(v) ? '' : t('v.phone'));
export const email = (v) => (blank(v) || PATTERNS.email.test(String(v).trim()) ? '' : t('v.email'));
export const slug = (v) => (blank(v) || PATTERNS.slug.test(String(v)) ? '' : t('v.slug'));
export const integer = (v) => (blank(v) || Number.isInteger(Number(v)) ? '' : t('v.int'));
export const minValue = (n) => (v) => (blank(v) || Number(v) >= n ? '' : t('v.minValue', { n }));
export const maxValue = (n) => (v) => (blank(v) || Number(v) <= n ? '' : t('v.maxValue', { n }));
export const url = (v) => {
  if (blank(v)) return '';
  try { const u = new URL(String(v).trim()); return /^https?:$/.test(u.protocol) ? '' : t('v.url'); } catch { return t('v.url'); }
};
export const trxId = (v) => (blank(v) || PATTERNS.trxId.test(String(v).toUpperCase().replace(/[^A-Z0-9]/g, '')) ? '' : t('v.trx'));
export const password = (v) => (blank(v) || String(v).length >= 8 ? '' : t('v.password'));
export const matches = (other) => (v, all) => (v === all[other] ? '' : t('v.match'));
/** Custom rule: validator(v, allValues) → message | '' */
export const custom = (fn) => fn;

export function validateForm(values, schema) {
  const errors = {};
  for (const [name, rules] of Object.entries(schema)) {
    for (const rule of rules) {
      const msg = rule(values[name], values);
      if (msg) { errors[name] = msg; break; }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** Marks invalid inputs and writes messages into `#err-<name>` (created by fieldHtml()). Focuses the first invalid input. */
export function showFormErrors(form, errors = {}) {
  let first = null;
  for (const el of form.elements) {
    if (!el.name) continue;
    const msg = errors[el.name];
    const slot = form.querySelector(`#err-${CSS.escape(el.name)}`);
    if (msg) {
      el.setAttribute('aria-invalid', 'true');
      const id = slot ? slot.id : '';
      if (id) el.setAttribute('aria-describedby', id);
      if (slot) slot.textContent = msg;
      if (!first) first = el;
    } else {
      el.removeAttribute('aria-invalid');
      if (slot) slot.textContent = '';
    }
  }
  if (first) first.focus({ preventScroll: false });
  return !first;
}

export function clearFormErrors(form) { showFormErrors(form, {}); }

export { focusFirst };
