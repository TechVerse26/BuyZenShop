/*
 * Support tickets — the one place that turns stored documents into the views the storefront and the admin panel draw.
 *
 *   normalizeTicket(id, doc)   → { id, subject, message, status, priority, orderNumber, lastAuthor, name, email, phone, userId, createdMs, updatedMs }
 *   normalizeMessage(id, doc)  → { id, authorType: 'customer'|'staff', authorUid, text, createdMs }
 *
 * Stored shape (fixed by firestore.rules → supportTickets/{id} and supportTickets/{id}/messages/{id}): see docs/DATA_MODEL.md.
 * `status` is open (waiting for the team) · answered (the team replied) · closed; `lastAuthor` is who wrote last. The customer can read their own
 * ticket document, so nothing internal may ever be stored on it.
 */
import { TICKET_STATUS, TICKET_PRIORITY } from './constants.js';
import { toMillis } from './pricing.js';

export function normalizeTicket(id, d = {}) {
  return {
    id,
    subject: String(d.subject || ''),
    message: String(d.message || ''),
    status: TICKET_STATUS[d.status] ? d.status : 'open',
    priority: TICKET_PRIORITY[d.priority] ? d.priority : 'normal',
    orderNumber: String(d.orderNumber || ''),
    lastAuthor: d.lastAuthor === 'staff' ? 'staff' : 'customer',
    name: String(d.name || ''),
    email: String(d.email || ''),
    phone: String(d.phone || ''),
    userId: d.userId ?? null,
    createdMs: toMillis(d.createdAt),
    updatedMs: toMillis(d.updatedAt),
  };
}

export function normalizeMessage(id, d = {}) {
  return {
    id,
    authorType: d.authorType === 'staff' ? 'staff' : 'customer',
    authorUid: String(d.authorUid || ''),
    text: String(d.text || ''),
    createdMs: toMillis(d.createdAt),
  };
}
