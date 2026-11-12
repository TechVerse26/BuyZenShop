import { PATTERNS, APP } from './constants.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

/** Random string using the Web Crypto API (falls back to Math.random only where crypto is missing). */
export function randomCode(len = 6, alphabet = ALPHABET, rnd) {
  const out = [];
  const bytes = new Uint8Array(len * 2);
  if (rnd) { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rnd() * 256); }
  else if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  // rejection sampling → uniform characters
  const limit = 256 - (256 % alphabet.length);
  for (let i = 0; i < bytes.length && out.length < len; i++) if (bytes[i] < limit) out.push(alphabet[bytes[i] % alphabet.length]);
  while (out.length < len) out.push(alphabet[Math.floor(Math.random() * alphabet.length)]);
  return out.join('');
}

/** yymmdd in Bangladesh time (UTC+6). */
export function dhakaDateStamp(nowMs = Date.now()) {
  const d = new Date(nowMs + APP.utcOffsetMinutes * 60000);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return yy + mm + dd;
}

/** Order number == Firestore document id: PREFIX-yymmdd-XXXXXX (must satisfy PATTERNS.orderNumber). */
export function makeOrderNumber(prefix = 'SV', nowMs = Date.now(), rnd) {
  const p = String(prefix || 'SV').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SV';
  const id = `${p.length < 2 ? p + 'X' : p}-${dhakaDateStamp(nowMs)}-${randomCode(6, ALPHABET, rnd)}`;
  if (!PATTERNS.orderNumber.test(id)) throw new Error('Generated an invalid order number: ' + id);
  return id;
}

/** Bangladesh mobile → local 11 digit form (01XXXXXXXXX). Returns '' when it cannot be a valid number. */
export function normalizePhone(input) {
  let s = String(input ?? '').trim();
  // Bengali digits → latin
  s = s.replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
  s = s.replace(/[\s\-()]/g, '');
  if (s.startsWith('+880')) s = '0' + s.slice(4);
  else if (s.startsWith('880')) s = '0' + s.slice(3);
  else if (/^1[3-9][0-9]{8}$/.test(s)) s = '0' + s;
  return PATTERNS.bdPhone.test(s) ? s : '';
}

/** TrxID as typed by a customer → canonical upper-case alphanumerics. */
export function normalizeTrxId(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizeCouponCode(input) {
  return String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export function lineKey(productId, variantId) {
  return variantId ? `${productId}__${variantId}` : productId;
}

export function splitLineKey(key) {
  const i = key.indexOf('__');
  return i < 0 ? { productId: key, variantId: null } : { productId: key.slice(0, i), variantId: key.slice(i + 2) };
}

/** Short random id for variants, banners, sections … (lower-case so it is safe inside document ids). */
export function shortId(len = 8) {
  return randomCode(len, 'abcdefghjkmnpqrstuvwxyz23456789');
}

const AUTO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Firestore-style auto id (20 chars) generated without the SDK so planners stay pure. */
export function autoId(len = 20) {
  return randomCode(len, AUTO);
}
