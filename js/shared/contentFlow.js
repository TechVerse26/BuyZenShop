/*
 * Content — pure planners (no I/O) for the home page layout and the CMS pages, so the admin pages and the rules tests run the exact same code.
 *
 *   homeProblems(sections)                           → [[en, bn], …]   everything that must stop a save: validateHome() plus pictures and links that the
 *                                                                      storefront would silently drop (an editor must never "save" something that then vanishes)
 *   planHomeSave({ sections, before, actor })        → { ok, action, ops, sections } | { ok:false, error, problems? }        (forbidden · invalid · no_change)
 *   planPageSave({ page, existing, isNew, actor })   → { ok, id, action, ops } | { ok:false, error, errors? }               (forbidden · invalid · exists · not_found · no_change)
 *   planPageFlag({ page, field, value, actor })      → { ok, id, action, ops }     field: 'visible' | 'footer'               (forbidden · not_found · invalid · no_change)
 *   planPageDelete({ page, actor })                  → { ok, id, action, ops }                                                (forbidden · not_found)
 *   homeSummary(sections) · pageSummary(page)
 *
 * firestore.rules lets everyone with content.write (Super Admin, Store Admin, Product Manager) write content/home and pages/{slug}; pages must have a clean slug,
 * only the known fields, sizes within limits and the server time. The storefront sanitises both on every read (contentModel.normalizeHome / normalizePage /
 * markdown), so nothing written here can break a customer's screen.
 *   • the home layout is saved as the SANITISED sections (normalizeHome) — what is stored is exactly what visitors get
 *   • every change is audited: content.home_save · page.create · page.update · page.show · page.hide · page.footer_on · page.footer_off · page.delete
 *     (the audit entry records titles and sizes, never the page text)
 *   • saving what is already stored is refused (no_change), so the audit log holds only real changes; the slug of a page never changes (create a new page instead)
 */
import { TS } from './ops.js';
import { roleCan } from './constants.js';
import { auditOp } from './orderFlow.js';
import {
  HOME_SECTION_TYPES, LIMITS_HOME, cleanImage, cleanLink, normalizeHome, validateHome, normalizePage, pageToDoc, validatePage, PAGE_SLUG_RE, PAGE_LIMITS,
} from './contentModel.js';

export const CONTENT = Object.freeze({ PERM: 'content.write', RESERVED_SLUGS: Object.freeze(['new']) });
export const PAGE_FLAGS = Object.freeze(['visible', 'footer']);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const allowed = (actor) => !!actor && roleCan(actor.role, CONTENT.PERM);
const both = (en, bn) => [en, bn];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function homeSummary(sections = []) {
  return { sections: sections.map((s) => `${s.type}${s.enabled === false ? ' (hidden)' : ''}`) };
}
export function pageSummary(p = {}) {
  return { title: String(p.title || ''), visible: p.visible === true, footer: p.footer !== false, sort: Number(p.sort) || 0, bodyChars: String(p.body || '').length };
}

/** A picture or link the person typed that the storefront would drop. Empty is judged by the caller (a slide needs a picture, a link is optional). */
const badImage = (v) => !!String(v || '').trim() && !cleanImage(v);
const badLink = (v) => !!String(v || '').trim() && !cleanLink(v);

export function homeProblems(sections) {
  const problems = [...validateHome(sections)];
  (Array.isArray(sections) ? sections : []).forEach((s, i) => {
    if (!s || !HOME_SECTION_TYPES[s.type]) return;
    const name = `${HOME_SECTION_TYPES[s.type].en} #${i + 1}`;
    const nameBn = `${HOME_SECTION_TYPES[s.type].bn} #${i + 1}`;
    const each = (list, noun, nounBn) => (Array.isArray(list) ? list : []).forEach((x, j) => {
      const at = `${noun} ${j + 1}`;
      const atBn = `${nounBn} ${j + 1}`;
      if (!String((x && x.image) || '').trim()) problems.push(both(`${name}: ${at} needs a picture.`, `${nameBn}: ${atBn}-এর ছবি দরকার।`));
      else if (badImage(x.image)) problems.push(both(`${name}: ${at} has a picture address that cannot be used (use a https:// address or upload a picture).`, `${nameBn}: ${atBn}-এর ছবির ঠিকানা ব্যবহারযোগ্য নয় (https:// ঠিকানা দিন বা ছবি আপলোড করুন)।`));
      if (badImage(x && x.mobileImage)) problems.push(both(`${name}: ${at} has a phone picture address that cannot be used.`, `${nameBn}: ${atBn}-এর ফোনের ছবির ঠিকানা ব্যবহারযোগ্য নয়।`));
      if (badLink(x && x.link)) problems.push(both(`${name}: ${at} has a link that cannot be used (start it with / or https://).`, `${nameBn}: ${atBn}-এর লিংক ব্যবহারযোগ্য নয় (/ বা https:// দিয়ে শুরু করুন)।`));
    });
    if (s.type === 'hero') each(s.slides, 'slide', 'স্লাইড');
    if (s.type === 'banners') each(s.items, 'banner', 'ব্যানার');
    if (s.type === 'products' && badLink(s.viewAllLink)) problems.push(both(`${name}: the "view all" link cannot be used (start it with / or https://).`, `${nameBn}: "সব দেখুন" লিংকটি ব্যবহারযোগ্য নয় (/ বা https:// দিয়ে শুরু করুন)।`));
    if (s.type === 'trust') (Array.isArray(s.items) ? s.items : []).forEach((x, j) => {
      if (!String((x && x.title) || '').trim()) problems.push(both(`${name}: point ${j + 1} needs a title.`, `${nameBn}: পয়েন্ট ${j + 1}-এর শিরোনাম দরকার।`));
    });
  });
  return problems;
}

export function planHomeSave({ sections, before = null, actor }) {
  if (!allowed(actor)) return fail('forbidden');
  if (!Array.isArray(sections)) return fail('invalid', { problems: [both('There is nothing to save.', 'সংরক্ষণ করার কিছু নেই।')] });
  const problems = homeProblems(sections);
  if (problems.length) return fail('invalid', { problems });
  const clean = normalizeHome({ sections }).sections;
  const stored = Array.isArray(before) ? normalizeHome({ sections: before }).sections : null;
  if (stored && same(clean, stored)) return fail('no_change');
  const shown = clean.filter((s) => s.enabled).length;
  return {
    ok: true, action: 'content.home_save', sections: clean,
    ops: [
      { op: 'set', path: 'content/home', data: { sections: clean, updatedAt: TS } },
      auditOp(actor, {
        action: 'content.home_save', entity: 'content', entityId: 'home',
        summary: `Home page saved — ${clean.length} section${clean.length === 1 ? '' : 's'}, ${shown} shown`,
        before: stored ? homeSummary(stored) : null, after: homeSummary(clean),
      }),
    ],
  };
}

export function planPageSave({ page, existing = null, isNew = false, actor }) {
  if (!allowed(actor)) return fail('forbidden');
  if (!page || typeof page !== 'object') return fail('not_found');
  const slug = String(page.slug || '').trim();
  const errors = validatePage({ ...page, slug });
  if (!errors.slug && CONTENT.RESERVED_SLUGS.includes(slug)) errors.slug = both('This address is reserved. Choose another.', 'এই ঠিকানাটি সংরক্ষিত। অন্যটি বেছে নিন।');
  const taken = isNew && !errors.slug && !!existing;
  if (taken) errors.slug = both('A page with this address already exists.', 'এই ঠিকানায় আগে থেকেই একটি পেজ আছে।');
  if (Object.keys(errors).length) return fail(taken ? 'exists' : 'invalid', { errors });
  if (!isNew && !existing) return fail('not_found');
  const doc = pageToDoc({ ...page, slug });
  const old = existing ? pageToDoc(normalizePage(slug, existing)) : null;
  if (!isNew && same(doc, old)) return fail('no_change');
  const action = isNew ? 'page.create' : 'page.update';
  return {
    ok: true, id: slug, action,
    ops: [
      { op: 'set', path: `pages/${slug}`, data: { ...doc, updatedAt: TS } },
      auditOp(actor, {
        action, entity: 'page', entityId: slug,
        summary: `Page "${doc.title}" (/page/${slug}) ${isNew ? 'created' : 'updated'}${doc.visible ? '' : ' — hidden'}`,
        before: old ? pageSummary(old) : null, after: pageSummary(doc),
      }),
    ],
  };
}

export function planPageFlag({ page, field, value, actor }) {
  if (!allowed(actor)) return fail('forbidden');
  if (!page || !page.slug) return fail('not_found');
  if (!PAGE_FLAGS.includes(field) || typeof value !== 'boolean') return fail('invalid');
  const current = field === 'visible' ? page.visible === true : page.footer !== false;
  if (current === value) return fail('no_change');
  const action = field === 'visible' ? (value ? 'page.show' : 'page.hide') : (value ? 'page.footer_on' : 'page.footer_off');
  const what = { 'page.show': 'shown to visitors', 'page.hide': 'hidden from visitors', 'page.footer_on': 'listed in the footer', 'page.footer_off': 'taken out of the footer' }[action];
  return {
    ok: true, id: page.slug, action,
    ops: [
      { op: 'update', path: `pages/${page.slug}`, data: { [field]: value, updatedAt: TS } },
      auditOp(actor, { action, entity: 'page', entityId: page.slug, summary: `Page "${page.title}" ${what}`, before: { [field]: current }, after: { [field]: value } }),
    ],
  };
}

export function planPageDelete({ page, actor }) {
  if (!allowed(actor)) return fail('forbidden');
  if (!page || !page.slug) return fail('not_found');
  return {
    ok: true, id: page.slug, action: 'page.delete',
    ops: [
      { op: 'delete', path: `pages/${page.slug}` },
      auditOp(actor, { action: 'page.delete', entity: 'page', entityId: page.slug, summary: `Page "${page.title}" (/page/${page.slug}) deleted`, before: pageSummary(page), after: null }),
    ],
  };
}

export { LIMITS_HOME, PAGE_LIMITS, PAGE_SLUG_RE };
