/*
 * I/O for the Settings page. The rules of the game (validation, what counts as a change, the audit entry) are in shared/settingsFlow.js.
 *
 *   await loadSettingsDocs()            → { pub, priv }   pub: settings/public | null (missing);  priv: settings/private | null | undefined (this role may not read it)
 *   await saveSettings({ form, current }) → plan          one atomic batch: the documents that changed + one audit entry
 *
 * A refusal is thrown as an AppError; when form fields are at fault it carries `.errors` ({ field: message }).
 */
import { getDocData } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor, can } from '../../data/auth.js';
import { loadSettings } from '../../data/settings.js';
import { planSettingsSave } from '../../shared/settingsFlow.js';
import { AppError, isPermissionDenied } from '../../core/errors.js';
import { registerBoth, t, has } from '../../core/i18n.js';

registerBoth({
  'cfg.err.forbidden': ['Your role cannot change the settings.', 'আপনার রোল দিয়ে সেটিংস বদলানো যাবে না।'],
  'cfg.err.no_change': ['Nothing was changed.', 'কিছুই বদলানো হয়নি।'],
  'cfg.err.invalid': ['Please fix the highlighted fields.', 'চিহ্নিত ঘরগুলো ঠিক করুন।'],
  'cfg.fe.required': ['This field is required.', 'এই ঘরটি পূরণ করতে হবে।'],
  'cfg.fe.too_long': ['This is too long.', 'এটি অনেক লম্বা।'],
  'cfg.fe.bad_phone': ['Enter a valid Bangladeshi mobile number (01XXXXXXXXX).', 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন (01XXXXXXXXX)।'],
  'cfg.fe.bad_email': ['Enter a valid e-mail address.', 'সঠিক ইমেইল দিন।'],
  'cfg.fe.bad_url': ['Enter a full https:// address (a site path like /shop also works for links).', 'পূর্ণ https:// ঠিকানা দিন (লিংকের জন্য /shop-এর মতো সাইট-পাথও চলবে)।'],
  'cfg.fe.bad_prefix': ['Use 2–6 capital letters or digits, for example SV.', '২–৬টি বড় হাতের অক্ষর বা সংখ্যা দিন, যেমন SV।'],
  'cfg.fe.bad_id': ['Use letters and digits only (6–40 characters).', 'শুধু অক্ষর ও সংখ্যা (৬–৪০টি)।'],
  'cfg.fe.range': ['This number is out of range.', 'সংখ্যাটি সীমার বাইরে।'],
  'cfg.fe.too_many': ['Too many addresses (5 at most).', 'অনেক বেশি ঠিকানা (সর্বোচ্চ ৫টি)।'],
  'cfg.fe.none_enabled': ['Switch on at least one payment method, or nobody can check out.', 'অন্তত একটি পেমেন্ট মাধ্যম চালু রাখুন, নইলে কেউ অর্ডার করতে পারবে না।'],
});

const docOrNull = async (path) => { const d = await getDocData(path); if (!d) return null; const { id, ...rest } = d; return rest; };

export async function loadSettingsDocs() {
  const pub = await docOrNull('settings/public');
  let priv;
  if (can('settings.read')) {
    try { priv = await docOrNull('settings/private'); } catch (e) { if (!isPermissionDenied(e)) throw e; priv = undefined; }
  }
  return { pub, priv };
}

export async function saveSettings({ form, current }) {
  const plan = planSettingsSave({ form, current: { pub: current.pub, priv: current.priv === undefined ? null : current.priv }, actor: actor(), nowMs: Date.now() });
  if (!plan.ok) {
    const errors = plan.errors ? Object.fromEntries(Object.entries(plan.errors).map(([f, code]) => [f, t(has(`cfg.fe.${code}`) ? `cfg.fe.${code}` : 'cfg.fe.required')])) : null;
    const key = `cfg.err.${plan.error}`;
    throw new AppError(plan.error, has(key) ? t(key) : plan.error, errors ? { errors } : {});
  }
  await commitAtomic(plan.ops);
  await loadSettings({ force: true });   // the admin shell and the storefront cache pick the new values up at once
  return plan;
}
