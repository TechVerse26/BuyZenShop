/*
 * Shipping zones data for the Shipping page. The rules of the game live in shared/shippingFlow.js; this module only does I/O.
 *
 *   await loadShippingZones()                          → [{ id, name, districts, fee, freeOver, etaMin, etaMax, active, sort }] by sort, then name
 *   await saveZone({ creating, id, form, zones })      one atomic batch: the zone + an audit entry
 *   await setZoneActive({ id, active, zones })
 *   await removeZone({ id, zones })
 *   overlapText(overlap)                               "Dhaka (Outside Sirajganj), …" in the language of the page
 *
 * A refusal is thrown as an AppError carrying `.errors` ({ field: message }) when a form field is at fault.
 * Every write clears the storefront's 5-minute zone cache on this device; other devices pick the change up within 5 minutes.
 */
import { listDocs } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { clearZonesCache } from '../../data/settings.js';
import { actor } from '../../data/auth.js';
import { planZoneSave, planZoneActive, planZoneRemove } from '../../shared/shippingFlow.js';
import { DISTRICT_BN } from '../../shared/constants.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t, has, getLang } from '../../core/i18n.js';

registerBoth({
  'shz.err.forbidden': ['You are not allowed to change shipping zones.', 'শিপিং জোন বদলানোর অনুমতি আপনার নেই।'],
  'shz.err.not_found': ['This zone no longer exists. Reload the page.', 'এই জোনটি আর নেই। পেজ রিলোড করুন।'],
  'shz.err.not_inactive': ['Switch the zone off first, then delete it.', 'আগে জোনটি বন্ধ করুন, তারপর মুছুন।'],
  'shz.err.no_change': ['Nothing was changed.', 'কিছুই বদলানো হয়নি।'],
  'shz.err.invalid': ['Please fix the highlighted fields.', 'চিহ্নিত ঘরগুলো ঠিক করুন।'],
  'shz.err.overlap': ['{list} already belong to another active zone. Remove them from that zone first.', '{list} ইতিমধ্যে অন্য একটি সক্রিয় জোনে আছে। আগে ওই জোন থেকে সরান।'],
  'shz.fe.required': ['This field is required.', 'এই ঘরটি পূরণ করতে হবে।'],
  'shz.fe.too_long': ['That is too long (60 characters at most).', 'অনেক লম্বা (সর্বোচ্চ ৬০ অক্ষর)।'],
  'shz.fe.name_taken': ['Another zone already has this name.', 'এই নামে আরেকটি জোন আছে।'],
  'shz.fe.none': ['Choose at least one district.', 'কমপক্ষে একটি জেলা বেছে নিন।'],
  'shz.fe.bad_district': ['Unknown district. Reload the page and choose again.', 'অচেনা জেলা। পেজ রিলোড করে আবার বাছুন।'],
  'shz.fe.overlap': ['{list} already belong to another active zone. Untick them, or switch this zone off.', '{list} ইতিমধ্যে অন্য সক্রিয় জোনে আছে। টিক তুলে দিন, অথবা এই জোন বন্ধ রাখুন।'],
  'shz.fe.bad_fee': ['Enter a whole amount from 0 to 5,000.', '০ থেকে ৫,০০০-এর মধ্যে পূর্ণ সংখ্যা দিন।'],
  'shz.fe.bad_free_over': ['Leave empty, or enter a whole amount from 1 to 1,000,000.', 'ফাঁকা রাখুন, অথবা ১ থেকে ১০,০০,০০০-এর মধ্যে পূর্ণ সংখ্যা দিন।'],
  'shz.fe.bad_eta': ['Enter whole days from 0 to 60.', '০ থেকে ৬০-এর মধ্যে পূর্ণ দিন দিন।'],
  'shz.fe.eta_order': ['The slowest time cannot be shorter than the fastest.', 'সর্বোচ্চ সময় সর্বনিম্ন সময়ের কম হতে পারে না।'],
});

const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : Number(v) || 0);
const districtName = (d) => (getLang() === 'bn' ? (DISTRICT_BN[d] || d) : d);

export async function loadShippingZones() {
  const { docs } = await listDocs('shippingZones', { limit: 200 });
  return docs.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name || a.id).localeCompare(String(b.name || b.id)) || ms(a.updatedAt) - ms(b.updatedAt));
}

export function overlapText(overlap = []) {
  const shown = overlap.slice(0, 4).map((o) => `${districtName(o.district)} (${o.zoneName})`).join(', ');
  return overlap.length > 4 ? `${shown} +${overlap.length - 4}` : shown;
}

function refusal(res) {
  const list = overlapText(res.overlap);
  const key = `shz.err.${res.error}`;
  const errors = res.errors
    ? Object.fromEntries(Object.entries(res.errors).map(([f, code]) => [f, t(has(`shz.fe.${code}`) ? `shz.fe.${code}` : 'shz.fe.required', { list })]))
    : null;
  return new AppError(res.error, has(key) ? t(key, { list }) : res.error, errors ? { errors } : {});
}

async function commit(plan) {
  if (!plan.ok) throw refusal(plan);
  await commitAtomic(plan.ops);
  clearZonesCache();
  return plan;
}

export const saveZone = ({ creating = false, id, form, zones }) => commit(planZoneSave({ creating, id, form, zones, actor: actor() }));
export const setZoneActive = ({ id, active, zones }) => commit(planZoneActive({ id, active, zones, actor: actor() }));
export const removeZone = ({ id, zones }) => commit(planZoneRemove({ id, zones, actor: actor() }));
