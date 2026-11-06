/*
 * Staff data for the "Staff & roles" page. The rules of the game live in shared/staffFlow.js; this module only does I/O.
 *
 *   await loadStaff()                      → [{ id, role, active, email, name, createdAt }] (active first, then by role, then by name)
 *   await findAccountByEmail(email)        → { uid, name, email } | null    (looks in users/, i.e. people who signed up on the store)
 *   await saveStaff({ creating, uid, form, staff })     one atomic batch: staff document + audit entry
 *   await removeStaff({ uid, staff })
 *
 * A refusal is thrown as an AppError carrying `.errors` ({ field: message }) when a form field is at fault.
 */
import { listDocs } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { planStaffSave, planStaffRemove } from '../../shared/staffFlow.js';
import { ROLE_IDS } from '../../shared/constants.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t, has } from '../../core/i18n.js';

registerBoth({
  'stf.err.forbidden': ['Only a Super Admin can manage staff.', 'শুধু সুপার অ্যাডমিন স্টাফ ম্যানেজ করতে পারেন।'],
  'stf.err.exists': ['This account is already on the staff list.', 'এই অ্যাকাউন্ট ইতিমধ্যে স্টাফ তালিকায় আছে।'],
  'stf.err.not_found': ['This staff record no longer exists. Reload the page.', 'এই স্টাফ রেকর্ড আর নেই। পেজ রিলোড করুন।'],
  'stf.err.self_change': ['You cannot change your own role or switch yourself off. Ask another Super Admin.', 'নিজের রোল বদলানো বা নিজেকে বন্ধ করা যাবে না। অন্য সুপার অ্যাডমিনকে বলুন।'],
  'stf.err.last_super_admin': ['This is the last active Super Admin. Make someone else a Super Admin first, otherwise nobody could manage staff.', 'ইনিই শেষ সক্রিয় সুপার অ্যাডমিন। আগে অন্য কাউকে সুপার অ্যাডমিন করুন, নইলে কেউ স্টাফ ম্যানেজ করতে পারবে না।'],
  'stf.err.not_inactive': ['Switch this member off first, then remove them.', 'আগে এই সদস্যকে বন্ধ করুন, তারপর সরান।'],
  'stf.err.no_change': ['Nothing was changed.', 'কিছুই বদলানো হয়নি।'],
  'stf.err.invalid': ['Please fix the highlighted fields.', 'চিহ্নিত ঘরগুলো ঠিক করুন।'],
  'stf.fe.required': ['This field is required.', 'এই ঘরটি পূরণ করতে হবে।'],
  'stf.fe.bad_uid': ['A UID is letters and digits (and _ . : -), 2–128 characters, without spaces or "/".', 'UID-তে শুধু অক্ষর, সংখ্যা (এবং _ . : -) থাকবে, ২–১২৮ অক্ষর; স্পেস বা "/" চলবে না।'],
  'stf.fe.bad_email': ['Enter a valid e-mail address.', 'সঠিক ইমেইল দিন।'],
  'stf.fe.too_long': ['That is too long (80 characters at most).', 'অনেক লম্বা (সর্বোচ্চ ৮০ অক্ষর)।'],
  'stf.fe.bad_role': ['Choose a role.', 'একটি রোল বেছে নিন।'],
  'stf.fe.exists': ['This account is already on the staff list.', 'এই অ্যাকাউন্ট ইতিমধ্যে স্টাফ তালিকায় আছে।'],
});

const ROLE_RANK = Object.fromEntries(ROLE_IDS.map((r, i) => [r, i]));
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : Number(v) || 0);

export async function loadStaff() {
  const { docs } = await listDocs('staff', { limit: 200 });
  return docs.slice().sort((a, b) =>
    (b.active === true) - (a.active === true)
    || (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99)
    || String(a.name || a.email || a.id).localeCompare(String(b.name || b.email || b.id))
    || ms(a.createdAt) - ms(b.createdAt));
}

/** People who have signed up on the store have a users/<uid> document with their e-mail. Staff must sign up first. */
export async function findAccountByEmail(email) {
  const typed = String(email || '').trim();
  if (!typed) return null;
  const tries = [...new Set([typed, typed.toLowerCase()])];
  for (const value of tries) {
    const { docs } = await listDocs('users', { where: [['email', '==', value]], limit: 2 });
    if (docs.length) { const u = docs[0]; return { uid: u.id, name: u.displayName || '', email: u.email || value }; }
  }
  return null;
}

function refusal(res) {
  const key = `stf.err.${res.error}`;
  const errors = res.errors ? Object.fromEntries(Object.entries(res.errors).map(([f, code]) => [f, t(has(`stf.fe.${code}`) ? `stf.fe.${code}` : 'stf.fe.required')])) : null;
  return new AppError(res.error, has(key) ? t(key) : res.error, errors ? { errors } : {});
}

export async function saveStaff({ creating = false, uid, form, staff }) {
  const plan = planStaffSave({ creating, uid, form, current: staff.find((s) => s.id === (creating ? (form && form.uid && String(form.uid).trim()) : uid)) || null, staff, actor: actor() });
  if (!plan.ok) throw refusal(plan);
  await commitAtomic(plan.ops);
  return plan;
}

export async function removeStaff({ uid, staff }) {
  const plan = planStaffRemove({ uid, current: staff.find((s) => s.id === uid) || null, staff, actor: actor() });
  if (!plan.ok) throw refusal(plan);
  await commitAtomic(plan.ops);
  return plan;
}
