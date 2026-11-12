/*
 * The signed-in customer's own data: address book and notifications.
 * (Profile fields are handled by data/auth.js → saveProfile; wishlist / cart by their own modules.)
 *
 *   await listAddresses(uid)                      → [{ id, label, name, phone, district, upazila, area, postalCode, line1, isDefault }]   default first
 *   await saveAddress(uid, input, id?)            → id            (creates or replaces; first address becomes the default)
 *   await deleteAddress(uid, id)                  (promotes another address to default when the default was deleted)
 *   await setDefaultAddress(uid, id)
 *   validateAddress(input)                        → { name?: msg, phone?: msg, district?: msg, line1?: msg }   ({} = valid)
 *   normalizeAddressInput(input)                  → clean object (phone normalised to 01XXXXXXXXX)
 *
 *   const off = watchNotifications(uid, (list) => …, onError)    newest first, max 50 → [{ id, title, body, kind, orderNumber, ticketId, read, createdMs }]
 *   await markNotificationRead(uid, id) / markAllNotificationsRead(uid, ids) / deleteNotification(uid, id)
 *
 * Every write follows firestore.rules (users/{uid}/addresses, users/{uid}.defaultAddressId, notifications.read).
 */
import { listDocs, watchList } from './db.js';
import { commitAtomic } from './write.js';
import { TS, DEL } from '../shared/ops.js';
import { autoId, normalizePhone } from '../shared/id.js';
import { DISTRICTS } from '../shared/constants.js';
import { toMillis } from '../shared/pricing.js';
import { AppError } from '../core/errors.js';
import { registerBoth, t } from '../core/i18n.js';

registerBoth({
  'addr.err.name': ['Enter the recipient\'s name (at least 2 letters).', 'প্রাপকের নাম লিখুন (কমপক্ষে ২ অক্ষর)।'],
  'addr.err.phone': ['Enter a valid Bangladeshi mobile number (01XXXXXXXXX).', 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)।'],
  'addr.err.district': ['Choose a district.', 'জেলা বাছুন।'],
  'addr.err.line1': ['Enter the full address (house, road, area — at least 5 characters).', 'পূর্ণ ঠিকানা লিখুন (বাড়ি, রোড, এলাকা — কমপক্ষে ৫ অক্ষর)।'],
  'addr.err.limit': ['You can save up to 10 addresses. Delete one to add another.', 'সর্বোচ্চ ১০টি ঠিকানা সংরক্ষণ করা যায়। নতুন যোগ করতে একটি মুছুন।'],
});

export const MAX_ADDRESSES = 10;

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function normalizeAddressInput(a = {}) {
  return {
    label: clip(a.label, 30),
    name: clip(a.name, 80),
    phone: normalizePhone(a.phone) || '',
    district: clip(a.district, 40),
    upazila: clip(a.upazila, 60),
    area: clip(a.area, 80),
    postalCode: clip(a.postalCode, 10),
    line1: String(a.line1 ?? '').trim().replace(/[ \t]+/g, ' ').slice(0, 300),
    isDefault: a.isDefault === true,
  };
}

export function validateAddress(input = {}) {
  const a = normalizeAddressInput(input);
  const e = {};
  if (a.name.length < 2) e.name = t('addr.err.name');
  if (!a.phone) e.phone = t('addr.err.phone');
  if (!DISTRICTS.includes(a.district)) e.district = t('addr.err.district');
  if (a.line1.length < 5) e.line1 = t('addr.err.line1');
  return e;
}

const col = (uid) => `users/${uid}/addresses`;

export async function listAddresses(uid) {
  const { docs } = await listDocs(col(uid));
  return docs.map((d) => ({ ...d, isDefault: d.isDefault === true }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (toMillis(b.updatedAt) ?? 0) - (toMillis(a.updatedAt) ?? 0));
}

export async function saveAddress(uid, input, id = null) {
  const data = normalizeAddressInput(input);
  const fields = validateAddress(input);
  if (Object.keys(fields).length) throw new AppError('validation', Object.values(fields)[0], { fields });

  const existing = await listAddresses(uid);
  if (!id && existing.length >= MAX_ADDRESSES) throw new AppError('limit', t('addr.err.limit'));
  const aid = id || autoId();
  const others = existing.filter((x) => x.id !== aid);
  const makeDefault = data.isDefault || others.length === 0;

  const ops = [{ op: 'set', path: `${col(uid)}/${aid}`, data: { ...data, isDefault: makeDefault, updatedAt: TS } }];
  if (makeDefault) {
    for (const o of others) if (o.isDefault) ops.push({ op: 'update', path: `${col(uid)}/${o.id}`, data: { isDefault: false, updatedAt: TS } });
    ops.push({ op: 'update', path: `users/${uid}`, data: { defaultAddressId: aid, updatedAt: TS } });
  }
  await commitAtomic(ops);
  return aid;
}

export async function setDefaultAddress(uid, id) {
  const existing = await listAddresses(uid);
  if (!existing.some((x) => x.id === id)) throw new AppError('notFound', t('err.notFound'));
  const ops = existing.filter((x) => x.id !== id && x.isDefault).map((x) => ({ op: 'update', path: `${col(uid)}/${x.id}`, data: { isDefault: false, updatedAt: TS } }));
  ops.push({ op: 'update', path: `${col(uid)}/${id}`, data: { isDefault: true, updatedAt: TS } });
  ops.push({ op: 'update', path: `users/${uid}`, data: { defaultAddressId: id, updatedAt: TS } });
  await commitAtomic(ops);
}

export async function deleteAddress(uid, id) {
  const existing = await listAddresses(uid);
  const target = existing.find((x) => x.id === id);
  if (!target) return;
  const ops = [{ op: 'delete', path: `${col(uid)}/${id}` }];
  if (target.isDefault) {
    const next = existing.find((x) => x.id !== id);
    if (next) {
      ops.push({ op: 'update', path: `${col(uid)}/${next.id}`, data: { isDefault: true, updatedAt: TS } });
      ops.push({ op: 'update', path: `users/${uid}`, data: { defaultAddressId: next.id, updatedAt: TS } });
    } else {
      ops.push({ op: 'update', path: `users/${uid}`, data: { defaultAddressId: DEL, updatedAt: TS } });
    }
  }
  await commitAtomic(ops);
}

/* ───────────────────────── notifications ───────────────────────── */

const view = (d) => ({
  id: d.id, title: d.title || '', body: d.body || '', kind: d.kind || 'order', orderNumber: d.orderNumber || '', ticketId: d.ticketId || '',
  read: d.read === true, createdMs: toMillis(d.createdAt),
});

export function watchNotifications(uid, cb, onError) {
  return watchList(`users/${uid}/notifications`, { orderBy: [['createdAt', 'desc']], limit: 50 }, (docs) => cb(docs.map(view)), onError);
}

export const markNotificationRead = (uid, id) => commitAtomic([{ op: 'update', path: `users/${uid}/notifications/${id}`, data: { read: true } }]);

export async function markAllNotificationsRead(uid, ids) {
  const list = [...new Set(ids || [])];
  for (let i = 0; i < list.length; i += 18) {
    await commitAtomic(list.slice(i, i + 18).map((id) => ({ op: 'update', path: `users/${uid}/notifications/${id}`, data: { read: true } })));
  }
}

export const deleteNotification = (uid, id) => commitAtomic([{ op: 'delete', path: `users/${uid}/notifications/${id}` }]);
