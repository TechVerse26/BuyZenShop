/*
 * Formatting: money (৳ with lakh grouping), numbers, dates in Bangladesh time, relative time.
 * Digits can be switched to Bengali numerals (settings.ui.banglaDigits / user toggle) without
 * touching any call site: everything goes through these helpers.
 */
import { APP } from '../shared/constants.js';
import { toMillis } from '../shared/pricing.js';

let bnDigits = false;
let lang = 'bn';

export function setFormatOptions({ banglaDigits, language } = {}) {
  if (typeof banglaDigits === 'boolean') bnDigits = banglaDigits;
  if (language) lang = language;
}
export const getFormatOptions = () => ({ banglaDigits: bnDigits, language: lang });

const BN = '০১২৩৪৫৬৭৮৯';
export const toBnDigits = (s) => String(s).replace(/[0-9]/g, (d) => BN[d]);
export const toLatinDigits = (s) => String(s).replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));
const digits = (s) => (bnDigits ? toBnDigits(s) : String(s));

/** 1250000 → "12,50,000" (South-Asian grouping). */
export function groupLakh(n) {
  const neg = n < 0; const s = String(Math.abs(Math.trunc(n)));
  if (s.length <= 3) return (neg ? '-' : '') + s;
  const last3 = s.slice(-3); let rest = s.slice(0, -3);
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (neg ? '-' : '') + rest + ',' + last3;
}

export function num(n, { decimals = 0 } = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (!decimals) return digits(groupLakh(Math.round(v)));
  const [i, f] = Math.abs(v).toFixed(decimals).split('.');
  return digits((v < 0 ? '-' : '') + groupLakh(Number(i)) + '.' + f);
}

/** 1250 → "৳1,250"; negative → "−৳1,250". Amounts are whole taka. */
export function money(n, { sign = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Math.round(Number(n));
  const body = APP.currencySymbol + digits(groupLakh(Math.abs(v)));
  if (v < 0) return '−' + body;
  return sign && v > 0 ? '+' + body : body;
}

export const pct = (n) => digits(`${Math.round(Number(n) || 0)}%`);

export function compact(n) {
  const v = Number(n) || 0;
  if (v >= 10000000) return digits((v / 10000000).toFixed(1).replace(/\.0$/, '')) + (lang === 'bn' ? ' কোটি' : ' Cr');
  if (v >= 100000) return digits((v / 100000).toFixed(1).replace(/\.0$/, '')) + (lang === 'bn' ? ' লাখ' : ' L');
  if (v >= 1000) return digits((v / 1000).toFixed(1).replace(/\.0$/, '')) + (lang === 'bn' ? ' হাজার' : 'k');
  return digits(String(Math.round(v)));
}

/* ───────────────────────── dates (Asia/Dhaka) ───────────────────────── */

const dfCache = new Map();
function df(locale, opts) {
  const k = locale + JSON.stringify(opts);
  let f = dfCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat(locale, { timeZone: APP.timezone, ...opts }); dfCache.set(k, f); }
  return f;
}
const loc = () => (lang === 'bn' ? 'bn-BD-u-nu-latn' : 'en-GB');
const out = (s) => (bnDigits ? toBnDigits(s) : s);

export function fmtDate(v, { month = 'short' } = {}) {
  const ms = toMillis(v); if (ms === null) return '—';
  return out(df(loc(), { day: 'numeric', month, year: 'numeric' }).format(ms));
}
export function fmtTime(v) {
  const ms = toMillis(v); if (ms === null) return '—';
  return out(df(loc(), { hour: 'numeric', minute: '2-digit', hour12: true }).format(ms));
}
export function fmtDateTime(v) {
  const ms = toMillis(v); if (ms === null) return '—';
  return out(df(loc(), { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(ms));
}
export function fmtShortDate(v) {
  const ms = toMillis(v); if (ms === null) return '—';
  return out(df(loc(), { day: 'numeric', month: 'short' }).format(ms));
}

/** "Oct 2026" — month and year of a moment, in Bangladesh time (the sales chart of a long period shows one bar per month). */
export function fmtMonth(v) {
  const ms = toMillis(v); if (ms === null) return '—';
  return out(df(loc(), { month: 'short', year: 'numeric' }).format(ms));
}

/** 'YYYY-MM-DD' of the Dhaka calendar day containing `ms`. Used to group reports. */
export function dhakaDayKey(ms) {
  const d = new Date(ms + APP.utcOffsetMinutes * 60000);
  return d.toISOString().slice(0, 10);
}
/** Epoch ms of 00:00 Dhaka time for the day containing `ms`. */
export function startOfDhakaDay(ms) {
  const d = new Date(ms + APP.utcOffsetMinutes * 60000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - APP.utcOffsetMinutes * 60000;
}
/** Parse an <input type=date> value (YYYY-MM-DD) as Dhaka midnight → epoch ms. */
export function parseDhakaDate(str, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return null;
  const [y, m, d] = str.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) - APP.utcOffsetMinutes * 60000;
  return endOfDay ? ms + 86400000 - 1 : ms;
}
/** Epoch ms → value for <input type=datetime-local> in Dhaka time. */
export function toDhakaInput(ms) {
  if (ms === null || ms === undefined) return '';
  return new Date(ms + APP.utcOffsetMinutes * 60000).toISOString().slice(0, 16);
}
export function fromDhakaInput(str) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str || '')) return null;
  const [d, t] = str.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, dd, hh, mm) - APP.utcOffsetMinutes * 60000;
}

const UNITS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
export function relTime(v, nowMs = Date.now()) {
  const ms = toMillis(v); if (ms === null) return '—';
  const diff = Math.round((ms - nowMs) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return lang === 'bn' ? 'এইমাত্র' : 'just now';
  const rtf = new Intl.RelativeTimeFormat(lang === 'bn' ? 'bn-BD-u-nu-latn' : 'en', { numeric: 'auto' });
  for (const [unit, secs] of UNITS) if (abs >= secs) return out(rtf.format(Math.round(diff / secs), unit));
  return out(rtf.format(Math.round(diff / 60), 'minute'));
}

/* ───────────────────────── misc ───────────────────────── */

export const plural = (n, one, other) => (Number(n) === 1 ? one : other);
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase() || '?';
export const truncate = (s, n = 80) => { const str = String(s ?? ''); return str.length > n ? str.slice(0, n - 1).trimEnd() + '…' : str; };
export function fileSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
/** 01712345678 → "01712-345678" for display. */
export function fmtPhone(p) { const s = String(p || ''); return /^01\d{9}$/.test(s) ? `${s.slice(0, 5)}-${s.slice(5)}` : s; }
export const maskPhone = (p) => { const s = String(p || ''); return s.length >= 6 ? `${s.slice(0, 3)}${'•'.repeat(s.length - 5)}${s.slice(-2)}` : s; };
export const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}` : String(e || ''); };
