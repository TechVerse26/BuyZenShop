/*
 * Tiny i18n layer (English + Bengali).
 *
 *   registerStrings('bn', { 'cart.title': 'আপনার কার্ট' });     // any module can add strings
 *   t('cart.title')                                              // current language → English → key
 *   t('cart.items', { n: 3 })                                    // "{n}" interpolation
 *   tn('cart.items', 3)                                          // picks cart.items_one / cart.items_other
 *   lbl(ORDER_STATUS.pending)                                    // picks .bn / .label from a constants entry
 *
 * Default language is Bengali (the store's customers); the choice is remembered in localStorage.
 * Pages keep their own strings next to their code (registerStrings at module top level) so
 * parallel work never collides on one big dictionary.
 */
import { local } from './storage.js';
import { setFormatOptions } from './format.js';

const dict = { en: Object.create(null), bn: Object.create(null) };
let lang = 'bn';
let storageKey = 'sv.lang';
const listeners = new Set();

export function registerStrings(language, strings) {
  if (!dict[language]) dict[language] = Object.create(null);
  Object.assign(dict[language], strings);
}

/** Register both languages in one call: registerBoth({ key: ['English', 'বাংলা'] }) */
export function registerBoth(pairs) {
  for (const [k, v] of Object.entries(pairs)) { dict.en[k] = v[0]; dict.bn[k] = v[1]; }
}

export function initI18n({ key = 'sv.lang', fallback = 'bn' } = {}) {
  storageKey = key;
  const saved = local.get(storageKey, null);
  const nav = (navigator.language || '').toLowerCase().startsWith('bn') ? 'bn' : null;
  apply(saved === 'en' || saved === 'bn' ? saved : (nav || fallback), false);
  return lang;
}

function apply(next, persist) {
  lang = next === 'en' ? 'en' : 'bn';
  if (persist) local.set(storageKey, lang);
  if (typeof document !== 'undefined') { document.documentElement.lang = lang === 'bn' ? 'bn' : 'en'; }
  setFormatOptions({ language: lang });
}

export const getLang = () => lang;
export function setLang(next) {
  if (next === lang) return;
  apply(next, true);
  listeners.forEach((fn) => { try { fn(lang); } catch (e) { console.error(e); } });
}
export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function interpolate(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
}

export function t(key, params, fallback) {
  const s = dict[lang][key] ?? dict.en[key] ?? fallback ?? key;
  return interpolate(s, params);
}
export function has(key) { return key in dict[lang] || key in dict.en; }

/** Plural helper: tn('k', 1) → k_one, otherwise k_other (Bengali uses the same split). Params get {n}. */
export function tn(key, n, params = {}) {
  const k = Number(n) === 1 ? `${key}_one` : `${key}_other`;
  return t(has(k) ? k : key, { n, ...params });
}

/** Pick the right text from a constants entry ({label, bn}) or from two strings. */
export function lbl(entry, fallback = '') {
  if (!entry) return fallback;
  if (typeof entry === 'string') return entry;
  return (lang === 'bn' ? entry.bn : entry.label) || entry.label || entry.bn || fallback;
}
export const pick = (en, bn) => (lang === 'bn' ? bn : en);

/* ───────────────────────── strings shared by every page ───────────────────────── */

registerBoth({
  'common.loading': ['Loading…', 'লোড হচ্ছে…'],
  'common.save': ['Save', 'সংরক্ষণ করুন'],
  'common.saved': ['Saved', 'সংরক্ষিত হয়েছে'],
  'common.cancel': ['Cancel', 'বাতিল'],
  'common.close': ['Close', 'বন্ধ করুন'],
  'common.delete': ['Delete', 'মুছে ফেলুন'],
  'common.edit': ['Edit', 'সম্পাদনা'],
  'common.add': ['Add', 'যোগ করুন'],
  'common.remove': ['Remove', 'সরান'],
  'common.back': ['Back', 'পেছনে'],
  'common.next': ['Next', 'পরবর্তী'],
  'common.prev': ['Previous', 'আগের'],
  'common.continue': ['Continue', 'এগিয়ে যান'],
  'common.confirm': ['Confirm', 'নিশ্চিত করুন'],
  'common.search': ['Search', 'খুঁজুন'],
  'common.filter': ['Filter', 'ফিল্টার'],
  'common.clear': ['Clear', 'মুছুন'],
  'common.reset': ['Reset', 'রিসেট'],
  'common.apply': ['Apply', 'প্রয়োগ করুন'],
  'common.all': ['All', 'সব'],
  'common.none': ['None', 'নেই'],
  'common.yes': ['Yes', 'হ্যাঁ'],
  'common.no': ['No', 'না'],
  'common.ok': ['OK', 'ঠিক আছে'],
  'common.retry': ['Try again', 'আবার চেষ্টা করুন'],
  'common.refresh': ['Refresh', 'রিফ্রেশ'],
  'common.view': ['View', 'দেখুন'],
  'common.details': ['Details', 'বিস্তারিত'],
  'common.actions': ['Actions', 'অ্যাকশন'],
  'common.status': ['Status', 'স্ট্যাটাস'],
  'common.date': ['Date', 'তারিখ'],
  'common.name': ['Name', 'নাম'],
  'common.email': ['Email', 'ইমেইল'],
  'common.phone': ['Phone', 'ফোন'],
  'common.total': ['Total', 'মোট'],
  'common.subtotal': ['Subtotal', 'সাবটোটাল'],
  'common.price': ['Price', 'মূল্য'],
  'common.qty': ['Qty', 'পরিমাণ'],
  'common.optional': ['optional', 'ঐচ্ছিক'],
  'common.required': ['required', 'আবশ্যক'],
  'common.more': ['More', 'আরও'],
  'common.less': ['Less', 'কম'],
  'common.showMore': ['Show more', 'আরও দেখুন'],
  'common.download': ['Download', 'ডাউনলোড'],
  'common.print': ['Print', 'প্রিন্ট'],
  'common.copy': ['Copy', 'কপি'],
  'common.copied': ['Copied', 'কপি হয়েছে'],
  'common.noResults': ['Nothing found', 'কিছু পাওয়া যায়নি'],
  'common.page': ['Page {n}', 'পৃষ্ঠা {n}'],
  'common.of': ['of', 'এর'],
  'common.results_one': ['{n} result', '{n}টি ফলাফল'],
  'common.results_other': ['{n} results', '{n}টি ফলাফল'],
  'common.items_one': ['{n} item', '{n}টি আইটেম'],
  'common.items_other': ['{n} items', '{n}টি আইটেম'],
  'common.error': ['Something went wrong', 'কিছু একটা সমস্যা হয়েছে'],
  'common.offline': ['You are offline', 'আপনি অফলাইনে আছেন'],
  'common.language': ['Language', 'ভাষা'],
  'common.theme': ['Theme', 'থিম'],
  'common.darkMode': ['Dark mode', 'ডার্ক মোড'],
  'common.lightMode': ['Light mode', 'লাইট মোড'],
  'common.skip': ['Skip to content', 'মূল কনটেন্টে যান'],
  'common.signIn': ['Sign in', 'লগইন'],
  'common.signOut': ['Sign out', 'লগআউট'],
  'common.free': ['Free', 'ফ্রি'],
  'common.inStock': ['In stock', 'স্টকে আছে'],
  'common.outOfStock': ['Out of stock', 'স্টকে নেই'],
  'common.lowStock': ['Only a few left', 'অল্প কিছু বাকি'],
  'common.backorder': ['Available on backorder', 'ব্যাকঅর্ডারে পাওয়া যাবে'],
  'common.unavailable': ['Unavailable', 'পাওয়া যাচ্ছে না'],
  'common.sale': ['Sale', 'অফার'],
  'common.new': ['New', 'নতুন'],
  'v.required': ['This field is required', 'এই ঘরটি পূরণ করা আবশ্যক'],
  'v.phone': ['Enter a valid mobile number (01XXXXXXXXX)', 'সঠিক মোবাইল নম্বর দিন (০১XXXXXXXXX)'],
  'v.email': ['Enter a valid email address', 'সঠিক ইমেইল ঠিকানা দিন'],
  'v.min': ['At least {n} characters', 'কমপক্ষে {n}টি অক্ষর'],
  'v.max': ['At most {n} characters', 'সর্বোচ্চ {n}টি অক্ষর'],
  'v.int': ['Enter a whole number', 'পূর্ণ সংখ্যা দিন'],
  'v.minValue': ['Must be at least {n}', 'কমপক্ষে {n} হতে হবে'],
  'v.maxValue': ['Must be at most {n}', 'সর্বোচ্চ {n} হতে পারে'],
  'v.slug': ['Use lowercase letters, numbers and hyphens', 'ছোট হাতের অক্ষর, সংখ্যা ও হাইফেন ব্যবহার করুন'],
  'v.url': ['Enter a valid link (https://…)', 'সঠিক লিংক দিন (https://…)'],
  'v.trx': ['6–20 letters or digits from your payment message', 'পেমেন্ট মেসেজ থেকে ৬–২০টি অক্ষর/সংখ্যা'],
  'v.password': ['At least 8 characters', 'কমপক্ষে ৮টি অক্ষর'],
  'v.match': ['Values do not match', 'মান মিলছে না'],
});
