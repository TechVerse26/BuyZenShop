/*
 * Error handling: turn SDK / rules / network failures into plain, actionable messages.
 * Nothing is ever swallowed silently, and nothing is reported to a remote service (there is none):
 * errors go to the console and, for the admin panel, to an in-memory ring buffer shown in Setup.
 */
import { registerBoth, t, getLang } from './i18n.js';

registerBoth({
  'err.generic': ['Something went wrong. Please try again.', 'কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।'],
  'err.network': ['No connection to the server. Check your internet and try again.', 'সার্ভারের সাথে সংযোগ নেই। ইন্টারনেট দেখে আবার চেষ্টা করুন।'],
  'err.denied': ['You are not allowed to do this, or the data changed while you were working. Refresh and try again.', 'এই কাজের অনুমতি নেই, অথবা আপনার কাজ চলাকালীন তথ্য বদলে গেছে। রিফ্রেশ করে আবার চেষ্টা করুন।'],
  'err.notFound': ['That item no longer exists.', 'এই আইটেমটি আর নেই।'],
  'err.exists': ['That item already exists.', 'এটি আগে থেকেই আছে।'],
  'err.quota': ['The service is busy right now. Wait a moment and try again.', 'সার্ভিস এখন ব্যস্ত। একটু পরে আবার চেষ্টা করুন।'],
  'err.index': ['This list needs a database index that has not been deployed yet (see docs/DEPLOYMENT.md).', 'এই তালিকার জন্য ডাটাবেস ইনডেক্স প্রয়োজন, যা এখনও ডিপ্লয় হয়নি (docs/DEPLOYMENT.md দেখুন)।'],
  'err.conflict': ['Someone else changed this at the same time. Reload and try again.', 'একই সময়ে অন্য কেউ এটি বদলেছেন। রিলোড করে আবার চেষ্টা করুন।'],
  'err.auth.invalid': ['Wrong email or password.', 'ইমেইল বা পাসওয়ার্ড ভুল।'],
  'err.auth.exists': ['An account with this email already exists. Try signing in.', 'এই ইমেইলে আগেই অ্যাকাউন্ট আছে। লগইন করুন।'],
  'err.auth.weak': ['Choose a stronger password (at least 8 characters).', 'আরও শক্তিশালী পাসওয়ার্ড দিন (কমপক্ষে ৮ অক্ষর)।'],
  'err.auth.email': ['That email address does not look right.', 'ইমেইল ঠিকানাটি সঠিক মনে হচ্ছে না।'],
  'err.auth.many': ['Too many attempts. Wait a few minutes and try again.', 'অনেকবার চেষ্টা হয়েছে। কয়েক মিনিট পরে আবার চেষ্টা করুন।'],
  'err.auth.popup': ['The sign-in window was closed before finishing.', 'সাইন-ইন উইন্ডো শেষ হওয়ার আগেই বন্ধ হয়েছে।'],
  'err.auth.disabled': ['This sign-in method is not enabled for the store yet.', 'এই লগইন পদ্ধতি এখনও চালু করা হয়নি।'],
  'err.auth.phone': ['Enter the phone number with country code, e.g. +8801XXXXXXXXX.', 'দেশের কোডসহ নম্বর দিন, যেমন +8801XXXXXXXXX।'],
  'err.auth.code': ['The verification code is wrong or has expired.', 'ভেরিফিকেশন কোডটি ভুল অথবা মেয়াদোত্তীর্ণ।'],
  'err.auth.network': ['Network problem while signing in. Try again.', 'লগইনের সময় নেটওয়ার্ক সমস্যা হয়েছে। আবার চেষ্টা করুন।'],
  'err.auth.domain': ['This website address is not authorised for sign-in. Add it in Firebase → Authentication → Settings → Authorised domains.', 'এই ওয়েবসাইট ঠিকানাটি লগইনের জন্য অনুমোদিত নয়। Firebase → Authentication → Settings → Authorized domains-এ যোগ করুন।'],
  'err.auth.recent': ['For your security, please sign in again and retry.', 'নিরাপত্তার জন্য আবার লগইন করে চেষ্টা করুন।'],
  'err.storage.denied': ['You are not allowed to upload here.', 'এখানে আপলোড করার অনুমতি নেই।'],
  'err.storage.size': ['The file is too large.', 'ফাইলটি অনেক বড়।'],
  'err.storage.type': ['Only JPEG, PNG or WebP images can be uploaded.', 'শুধু JPEG, PNG বা WebP ছবি আপলোড করা যাবে।'],
  'err.storage.canceled': ['Upload cancelled.', 'আপলোড বাতিল হয়েছে।'],
});

export class AppError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.name = 'AppError'; this.code = code; Object.assign(this, extra); }
}

const AUTH = {
  'auth/invalid-credential': 'err.auth.invalid', 'auth/wrong-password': 'err.auth.invalid', 'auth/user-not-found': 'err.auth.invalid', 'auth/invalid-login-credentials': 'err.auth.invalid',
  'auth/email-already-in-use': 'err.auth.exists', 'auth/weak-password': 'err.auth.weak', 'auth/invalid-email': 'err.auth.email',
  'auth/too-many-requests': 'err.auth.many', 'auth/popup-closed-by-user': 'err.auth.popup', 'auth/cancelled-popup-request': 'err.auth.popup',
  'auth/operation-not-allowed': 'err.auth.disabled', 'auth/invalid-phone-number': 'err.auth.phone', 'auth/missing-phone-number': 'err.auth.phone',
  'auth/invalid-verification-code': 'err.auth.code', 'auth/code-expired': 'err.auth.code', 'auth/network-request-failed': 'err.auth.network',
  'auth/unauthorized-domain': 'err.auth.domain', 'auth/requires-recent-login': 'err.auth.recent',
};
const FS = {
  'permission-denied': 'err.denied', 'unavailable': 'err.network', 'deadline-exceeded': 'err.network', 'not-found': 'err.notFound',
  'already-exists': 'err.exists', 'resource-exhausted': 'err.quota', 'failed-precondition': 'err.index', 'aborted': 'err.conflict', 'unauthenticated': 'err.denied',
};
const STORAGE = {
  'storage/unauthorized': 'err.storage.denied', 'storage/unauthenticated': 'err.storage.denied', 'storage/canceled': 'err.storage.canceled',
  'storage/retry-limit-exceeded': 'err.network', 'storage/quota-exceeded': 'err.quota',
};

/** Firebase / Firestore / Storage / AppError / anything → a message the person can act on. */
export function explainError(err, fallbackKey = 'err.generic') {
  if (!err) return t(fallbackKey);
  const code = String(err.code || '');
  if (err.name === 'AppError' || err.name === 'OrderBuildError' || err.userMessage) return err.userMessage || err.message || t(fallbackKey);
  const key = AUTH[code] || STORAGE[code] || FS[code.replace(/^firestore\//, '')];
  if (key) return t(key);
  if (!navigator.onLine) return t('err.network');
  if (/Failed to fetch|NetworkError|network/i.test(String(err.message))) return t('err.network');
  return t(fallbackKey);
}

/** An AppError / OrderBuildError is an answer with a message ("address taken", "stock is held by open orders"), not a crash: show it, don't log it. */
export const isRefusal = (e) => !!e && (e.name === 'AppError' || e.name === 'OrderBuildError');
export const isPermissionDenied = (e) => /permission-denied|insufficient permissions/i.test(`${e?.code} ${e?.message}`);
export const isNetworkError = (e) => /unavailable|network|offline|deadline/i.test(`${e?.code} ${e?.message}`);

/* ───────────────────────── in-memory error log (admin → Setup page) ───────────────────────── */

const ring = [];
export function reportError(err, context = '') {
  const entry = { at: Date.now(), context, code: err?.code || '', message: String(err?.message || err).slice(0, 300) };
  ring.push(entry); if (ring.length > 50) ring.shift();
  console.error(context ? `[${context}]` : '', err);
}
export const recentErrors = () => ring.slice().reverse();

/** Catch anything that escapes (rate-limited so a render loop cannot flood the screen). */
export function installGlobalErrorHandlers(show) {
  let last = 0;
  const handle = (err, ctx) => {
    reportError(err, ctx);
    const now = Date.now();
    if (now - last < 4000) return;
    last = now;
    try { show(explainError(err)); } catch { /* ignore */ }
  };
  window.addEventListener('error', (e) => { if (e.error && !/ResizeObserver/.test(String(e.message))) handle(e.error, 'window.error'); });
  window.addEventListener('unhandledrejection', (e) => handle(e.reason, 'unhandledrejection'));
}

export const langIsBn = () => getLang() === 'bn';
