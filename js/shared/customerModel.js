/*
 * Customers — the one place that turns stored documents into the views the admin pages draw.
 *
 *   normalizeCustomer(id, doc)    → { id, name, email, phone, photoURL, joinedMs, lastLoginMs, lastOrderMs, restricted, restrictedReason, restrictedMs }
 *   normalizeNote(id, doc)        → { id, text, authorUid, authorEmail, createdMs }
 *   normalizeSubscriber(id, doc)  → { id, email, source, createdMs }          (the document id is the lower-cased e-mail)
 *
 * Stored shapes (fixed by firestore.rules → users/{uid}, userPrivate/{uid}/notes/{id}, newsletter/{email}): see docs/DATA_MODEL.md.
 * A missing time is 0, so sorting and "never" checks need no null handling. `restricted` is true only for the boolean true.
 */
import { toMillis } from './pricing.js';

export function normalizeCustomer(id, d = {}) {
  return {
    id,
    name: String(d.displayName || ''),
    email: String(d.email || ''),
    phone: String(d.phone || ''),
    photoURL: String(d.photoURL || ''),
    joinedMs: toMillis(d.createdAt) || 0,
    lastLoginMs: toMillis(d.lastLoginAt) || 0,
    lastOrderMs: toMillis(d.lastOrderAt) || 0,
    restricted: d.restricted === true,
    restrictedReason: String(d.restrictedReason || ''),
    restrictedMs: toMillis(d.restrictedAt) || 0,
  };
}

export function normalizeNote(id, d = {}) {
  return { id, text: String(d.text || ''), authorUid: String(d.authorUid || ''), authorEmail: String(d.authorEmail || ''), createdMs: toMillis(d.createdAt) || 0 };
}

export function normalizeSubscriber(id, d = {}) {
  return { id, email: String(d.email || id), source: String(d.source || ''), createdMs: toMillis(d.createdAt) || 0 };
}
