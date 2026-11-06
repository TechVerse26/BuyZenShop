/*
 * Content model shared by the storefront (renders it) and the admin panel (edits it).
 *
 *   content/home  →  { sections: Section[], updatedAt }          (public read, `content.write` to change)
 *   pages/{slug}  →  { title, body (markdown), visible, footer, sort, seoTitle, seoDescription, updatedAt }
 *
 * Both sides MUST go through normalizeHome()/cleanSection()/normalizePage(): they fill defaults, clamp numbers,
 * drop unknown fields and unsafe URLs, so a half-edited or hand-edited document can never break the storefront.
 *
 * Pure module (no DOM, no Firebase) — covered by tests/unit/content.test.mjs.
 */

import { randomCode } from './id.js';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newId = (prefix = 's') => `${prefix}${randomCode(6, ID_ALPHABET)}`;

/* ───────────────────────── tiny sanitisers ───────────────────────── */

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const flag = (v, def = false) => (typeof v === 'boolean' ? v : def);
const idList = (v, max) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, 80)).filter(Boolean))].slice(0, max) : []);

/** Same-site path (/shop?x=1), http(s) URL, mailto: or tel:. Everything else (javascript:, data:, //host …) → ''. */
export function cleanLink(v) {
  const s = str(v, 500);
  if (!s) return '';
  if (/^\/(?![/\\])/.test(s)) return s;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s;
  return '';
}
/** Like cleanLink but only for images (no mailto/tel). Relative legacy paths ("gallery/a.webp") are made root-relative. */
export function cleanImage(v) {
  const s = str(v, 600);
  if (!s) return '';
  if (/^\/(?![/\\])/.test(s) || /^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9][a-z0-9._~\-/]*\.(png|jpe?g|webp|gif|avif)$/i.test(s)) return '/' + s;
  return '';
}

/* ───────────────────────── home sections ───────────────────────── */

export const PRODUCT_SOURCES = Object.freeze({
  newest:      { en: 'New arrivals',  bn: 'নতুন পণ্য' },
  bestsellers: { en: 'Best sellers',  bn: 'সবচেয়ে বেশি বিক্রি' },
  featured:    { en: 'Featured',      bn: 'বাছাই করা' },
  sale:        { en: 'On sale',       bn: 'ছাড়ের পণ্য' },
  category:    { en: 'From a category', bn: 'ক্যাটাগরি থেকে' },
  manual:      { en: 'Hand-picked',   bn: 'নিজে বাছাই করা' },
});

/** type → metadata. `multi:false` means at most one such section on the page. */
export const HOME_SECTION_TYPES = Object.freeze({
  hero:       { en: 'Hero slider',     bn: 'হিরো স্লাইডার',      icon: 'image',    multi: false, about: ['Large banner(s) at the very top.', 'পেজের একদম উপরে বড় ব্যানার।'] },
  banners:    { en: 'Promo banners',   bn: 'প্রোমো ব্যানার',     icon: 'tag',      multi: true,  about: ['A row of 1–3 image tiles linking anywhere.', '১–৩টি ছবির টাইল, যেকোনো লিংকসহ।'] },
  categories: { en: 'Categories',      bn: 'ক্যাটাগরি',          icon: 'grid',     multi: true,  about: ['Category shortcuts (automatic or hand-picked).', 'ক্যাটাগরি শর্টকাট (স্বয়ংক্রিয় বা নিজে বাছাই)।'] },
  products:   { en: 'Product row',     bn: 'প্রোডাক্ট সারি',     icon: 'package',  multi: true,  about: ['A product grid from a source you choose.', 'আপনার বাছাই করা উৎস থেকে প্রোডাক্ট গ্রিড।'] },
  brands:     { en: 'Brands',          bn: 'ব্র্যান্ড',          icon: 'award',    multi: true,  about: ['Brand names / logos.', 'ব্র্যান্ডের নাম বা লোগো।'] },
  trust:      { en: 'Trust badges',    bn: 'বিশ্বাসযোগ্যতার ব্যাজ', icon: 'shield-check', multi: false, about: ['Short reassurance points (delivery, returns, payment).', 'ডেলিভারি, রিটার্ন, পেমেন্ট নিয়ে সংক্ষিপ্ত আশ্বাস।'] },
  richText:   { en: 'Text block',      bn: 'টেক্সট ব্লক',        icon: 'file-text', multi: true, about: ['A heading and a paragraph (Markdown).', 'শিরোনাম ও অনুচ্ছেদ (Markdown)।'] },
  newsletter: { en: 'Newsletter',      bn: 'নিউজলেটার',          icon: 'mail',     multi: false, about: ['E-mail sign-up box.', 'ইমেইল সাইন-আপ বক্স।'] },
});
export const HOME_SECTION_TYPE_IDS = Object.freeze(Object.keys(HOME_SECTION_TYPES));

export const TRUST_ICONS = Object.freeze(['truck', 'shield-check', 'undo', 'wallet', 'headset', 'gift', 'award', 'clock', 'credit-card', 'smartphone']);
export const LIMITS_HOME = Object.freeze({ MAX_SECTIONS: 24, MAX_SLIDES: 6, MAX_BANNERS: 6, MAX_TRUST: 6, MAX_PRODUCTS: 24 });

function cleanSlide(s) {
  if (!s || typeof s !== 'object') return null;
  const image = cleanImage(s.image);
  if (!image) return null;                                          // a slide without a picture is meaningless
  return {
    id: str(s.id, 24) || newId('h'), image, mobileImage: cleanImage(s.mobileImage),
    title: str(s.title, 90), text: str(s.text, 200), cta: str(s.cta, 30), link: cleanLink(s.link),
    tone: oneOf(s.tone, ['light', 'dark'], 'dark'), alt: str(s.alt, 140),
  };
}
function cleanBanner(b) {
  if (!b || typeof b !== 'object') return null;
  const image = cleanImage(b.image);
  if (!image) return null;
  return { id: str(b.id, 24) || newId('b'), image, title: str(b.title, 70), text: str(b.text, 140), cta: str(b.cta, 30), link: cleanLink(b.link), alt: str(b.alt, 140) };
}
function cleanTrustItem(i) {
  if (!i || typeof i !== 'object') return null;
  const title = str(i.title, 60);
  if (!title) return null;
  return { icon: oneOf(i.icon, TRUST_ICONS, 'shield-check'), title, text: str(i.text, 140) };
}

/** Default (new) section of a type. Pass `id` for deterministic tests. */
export function newSection(type, id) {
  const base = { id: id || newId(), type, enabled: true, title: '' };
  switch (type) {
    case 'hero': return { ...base, slides: [], autoplay: false, interval: 6 };
    case 'banners': return { ...base, items: [], columns: 2 };
    case 'categories': return { ...base, categoryIds: [], limit: 12, style: 'grid' };
    case 'products': return { ...base, source: 'newest', categoryId: '', productIds: [], limit: 8, viewAllLink: '', endsAt: null };
    case 'brands': return { ...base, limit: 12 };
    case 'trust': return { ...base, items: [] };
    case 'richText': return { ...base, body: '', align: 'start' };
    case 'newsletter': return { ...base, text: '' };
    default: return null;
  }
}

/** Sanitise one section; returns null for unknown types. */
export function cleanSection(raw) {
  if (!raw || typeof raw !== 'object' || !HOME_SECTION_TYPES[raw.type]) return null;
  const base = newSection(raw.type, str(raw.id, 24).replace(/[^A-Za-z0-9_-]/g, '') || undefined);
  const out = { ...base, enabled: flag(raw.enabled, true), title: str(raw.title, 80) };
  switch (raw.type) {
    case 'hero':
      out.slides = (Array.isArray(raw.slides) ? raw.slides : []).map(cleanSlide).filter(Boolean).slice(0, LIMITS_HOME.MAX_SLIDES);
      out.autoplay = flag(raw.autoplay, false); out.interval = int(raw.interval, 3, 15, 6);
      break;
    case 'banners':
      out.items = (Array.isArray(raw.items) ? raw.items : []).map(cleanBanner).filter(Boolean).slice(0, LIMITS_HOME.MAX_BANNERS);
      out.columns = int(raw.columns, 1, 3, 2);
      break;
    case 'categories':
      out.categoryIds = idList(raw.categoryIds, 24); out.limit = int(raw.limit, 1, 24, 12); out.style = oneOf(raw.style, ['grid', 'scroll'], 'grid');
      break;
    case 'products': {
      out.source = oneOf(raw.source, Object.keys(PRODUCT_SOURCES), 'newest');
      out.categoryId = str(raw.categoryId, 80); out.productIds = idList(raw.productIds, LIMITS_HOME.MAX_PRODUCTS);
      out.limit = int(raw.limit, 1, LIMITS_HOME.MAX_PRODUCTS, 8); out.viewAllLink = cleanLink(raw.viewAllLink);
      const e = Number(raw.endsAt); out.endsAt = Number.isFinite(e) && e > 0 ? Math.round(e) : null;
      break;
    }
    case 'brands': out.limit = int(raw.limit, 1, 24, 12); break;
    case 'trust': out.items = (Array.isArray(raw.items) ? raw.items : []).map(cleanTrustItem).filter(Boolean).slice(0, LIMITS_HOME.MAX_TRUST); break;
    case 'richText': out.body = str(raw.body, 4000); out.align = oneOf(raw.align, ['start', 'center'], 'start'); break;
    case 'newsletter': out.text = str(raw.text, 200); break;
    default: break;
  }
  return out;
}

export function defaultHomeSections() {
  return [
    { ...newSection('categories', 'cats'), limit: 12 },
    { ...newSection('products', 'new'), source: 'newest', limit: 8 },
    { ...newSection('products', 'best'), source: 'bestsellers', limit: 8 },
    newSection('trust', 'trust'),
    newSection('newsletter', 'news'),
  ];
}

/**
 * Whatever is stored (or nothing) → a safe `{ sections }`.
 * A missing / malformed document yields the defaults; a document with an explicitly empty list stays empty.
 */
export function normalizeHome(doc) {
  if (!doc || !Array.isArray(doc.sections)) return { sections: defaultHomeSections() };
  const seen = new Set();
  const singles = new Set();
  const sections = [];
  for (const raw of doc.sections.slice(0, LIMITS_HOME.MAX_SECTIONS)) {
    const s = cleanSection(raw);
    if (!s) continue;
    if (!HOME_SECTION_TYPES[s.type].multi) { if (singles.has(s.type)) continue; singles.add(s.type); }   // hero / trust / newsletter: once
    while (seen.has(s.id)) s.id = newId();
    seen.add(s.id);
    sections.push(s);
  }
  return { sections };
}

/** Validation for the admin editor: returns a list of human problems (empty = OK). Bilingual strings are [en, bn]. */
export function validateHome(sections) {
  const problems = [];
  const list = Array.isArray(sections) ? sections : [];
  list.forEach((s, i) => {
    const name = `${HOME_SECTION_TYPES[s.type]?.en || s.type} #${i + 1}`;
    if (s.type === 'hero' && s.enabled && !(s.slides || []).length) problems.push([`${name}: add at least one slide with an image.`, `${name}: অন্তত একটি ছবিসহ স্লাইড যোগ করুন।`]);
    if (s.type === 'banners' && s.enabled && !(s.items || []).length) problems.push([`${name}: add at least one banner image.`, `${name}: অন্তত একটি ব্যানার ছবি যোগ করুন।`]);
    if (s.type === 'products' && s.source === 'category' && !s.categoryId) problems.push([`${name}: pick a category.`, `${name}: একটি ক্যাটাগরি বাছুন।`]);
    if (s.type === 'products' && s.source === 'manual' && !(s.productIds || []).length) problems.push([`${name}: pick at least one product.`, `${name}: অন্তত একটি প্রোডাক্ট বাছুন।`]);
    if (s.type === 'richText' && s.enabled && !s.body && !s.title) problems.push([`${name}: write some text.`, `${name}: কিছু লিখুন।`]);
  });
  for (const [type, meta] of Object.entries(HOME_SECTION_TYPES)) {
    if (!meta.multi && list.filter((s) => s.type === type).length > 1) problems.push([`Only one "${meta.en}" section is allowed.`, `"${meta.bn}" সেকশন শুধু একটি থাকতে পারে।`]);
  }
  if (list.length > LIMITS_HOME.MAX_SECTIONS) problems.push([`At most ${LIMITS_HOME.MAX_SECTIONS} sections.`, `সর্বোচ্চ ${LIMITS_HOME.MAX_SECTIONS}টি সেকশন।`]);
  return problems;
}

/* ───────────────────────── CMS pages ───────────────────────── */

export const PAGE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PAGE_LIMITS = Object.freeze({ TITLE: 120, BODY: 30000, SEO_TITLE: 70, SEO_DESC: 200, SLUG: 60 });

export function normalizePage(slug, d) {
  const x = d && typeof d === 'object' ? d : {};
  return {
    slug: str(slug, PAGE_LIMITS.SLUG),
    title: str(x.title, PAGE_LIMITS.TITLE) || str(slug, PAGE_LIMITS.SLUG),
    body: String(x.body ?? '').slice(0, PAGE_LIMITS.BODY),
    visible: x.visible === true,
    footer: x.footer !== false,                        // listed in the footer unless switched off
    sort: int(x.sort, -9999, 9999, 0),
    seoTitle: str(x.seoTitle, PAGE_LIMITS.SEO_TITLE),
    seoDescription: str(x.seoDescription, PAGE_LIMITS.SEO_DESC),
    updatedAtMs: typeof x.updatedAt?.toMillis === 'function' ? x.updatedAt.toMillis() : (Number(x.updatedAt?.ms) || Number(x.updatedAtMs) || null),
  };
}

/** The fields that are written to Firestore (admin editor). `updatedAt` is added by the caller (TS sentinel). */
export function pageToDoc(p) {
  const n = normalizePage(p.slug, p);
  return { title: n.title, body: n.body, visible: n.visible, footer: n.footer, sort: n.sort, seoTitle: n.seoTitle, seoDescription: n.seoDescription };
}

export function validatePage(p) {
  const errors = {};
  if (!PAGE_SLUG_RE.test(String(p.slug || '')) || String(p.slug).length > PAGE_LIMITS.SLUG) errors.slug = ['Use lower-case letters, digits and hyphens only.', 'শুধু ছোট হাতের ইংরেজি অক্ষর, সংখ্যা ও হাইফেন ব্যবহার করুন।'];
  if (!str(p.title, PAGE_LIMITS.TITLE)) errors.title = ['Enter a title.', 'শিরোনাম লিখুন।'];
  if (String(p.body || '').length > PAGE_LIMITS.BODY) errors.body = [`Too long (max ${PAGE_LIMITS.BODY} characters).`, `অনেক বড় (সর্বোচ্চ ${PAGE_LIMITS.BODY} অক্ষর)।`];
  return errors;
}
