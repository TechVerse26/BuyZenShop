/*
 * Customers — pure planners (no I/O), so the admin pages and the rules tests run the exact same code.
 *
 *   planRestrict({ customer, reason, actor })               → { ok, id, action, ops } | { ok:false, error, errors? }
 *        error codes: forbidden · not_found · self · no_change · invalid (errors.reason: required · too_short · too_long)
 *   planUnrestrict({ customer, actor })                     → same shape        (forbidden · not_found · no_change)
 *   planNoteAdd({ customer, text, count, actor, noteId })   → { ok, id, noteId, action, ops }     (forbidden · not_found · invalid (errors.text: required · too_long) · too_many)
 *   planNoteDelete({ customer, note, actor })               → { ok, id, noteId, action, ops }     (forbidden · not_found)
 *   planSubscriberRemove({ subscriber, actor })             → { ok, id, action, ops }             (forbidden · not_found)
 *   planExport({ kind, count, actor })                      → { ok, action, ops }   one audit entry for a bulk CSV export   (forbidden · invalid)
 *   summarizeCustomerOrders(orders)  → { orders, completed, cancelled, spent, average, firstMs, lastMs }
 *   filterCustomers(list, { q, status }) · orderCustomers(list) · lookupKind(q) · filterSubscribers(list, q)
 *
 * `customer` is a view from customerModel.normalizeCustomer, `note` from normalizeNote, `subscriber` from normalizeSubscriber.
 *
 * firestore.rules lets everyone with customers.write (Super Admin, Store Admin) change ONLY restricted / restrictedReason / restrictedAt / updatedAt on a
 * customer and refuses a restriction that has no reason of 3–200 characters or a restrictedAt that is not the server time. What the restriction does:
 * the customer's checkout is refused (the rules' order gate). Nothing else about the account changes.
 *   • every change is audited: customer.restrict / customer.unrestrict / customer.note_add / customer.note_delete / newsletter.remove / customer.export / newsletter.export
 *   • the audit entry of a note records that a note was written (and its length), never its words — notes may hold private details
 *   • a bulk export of personal data needs BOTH customers.read and reports.export (Super Admin and Store Admin) and is itself audited
 *   • nobody restricts their own account; internal notes are one document each (userPrivate/{uid}/notes/{id}) so two people never overwrite each other
 */
import { TS, DEL } from './ops.js';
import { roleCan } from './constants.js';
import { auditOp } from './orderFlow.js';
import { autoId, normalizePhone } from './id.js';
import { summarize } from './stats.js';

export const CUSTOMER = Object.freeze({
  READ: 'customers.read', WRITE: 'customers.write', EXPORT: 'reports.export',
  REASON_MIN: 3, REASON_MAX: 200, NOTE_MAX: 1000, NOTES_MAX: 100,
});
export const EXPORT_KINDS = Object.freeze(['customers', 'subscribers']);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const canWrite = (actor) => !!actor && roleCan(actor.role, CUSTOMER.WRITE);
const label = (c) => c.name || c.email || c.id;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const tidyNote = (s) => String(s ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const latin = (s) => String(s ?? '').replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
/** "rahim@example.com" → "ra••••@example.com" (the audit log is read by more people than the customer list) */
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}` : String(e || ''); };

export function planRestrict({ customer, reason = '', actor }) {
  if (!canWrite(actor)) return fail('forbidden');
  if (!customer || !customer.id) return fail('not_found');
  if (customer.id === actor.uid) return fail('self');
  if (customer.restricted) return fail('no_change');
  const text = oneLine(reason);
  if (!text) return fail('invalid', { errors: { reason: 'required' } });
  if (text.length < CUSTOMER.REASON_MIN) return fail('invalid', { errors: { reason: 'too_short' } });
  if (text.length > CUSTOMER.REASON_MAX) return fail('invalid', { errors: { reason: 'too_long' } });
  return {
    ok: true, id: customer.id, action: 'customer.restrict',
    ops: [
      { op: 'update', path: `users/${customer.id}`, data: { restricted: true, restrictedReason: text, restrictedAt: TS, updatedAt: TS } },
      auditOp(actor, {
        action: 'customer.restrict', entity: 'customer', entityId: customer.id,
        summary: `${label(customer)} restricted — ${text}`, before: { restricted: false }, after: { restricted: true, reason: text },
      }),
    ],
  };
}

export function planUnrestrict({ customer, actor }) {
  if (!canWrite(actor)) return fail('forbidden');
  if (!customer || !customer.id) return fail('not_found');
  if (!customer.restricted) return fail('no_change');
  return {
    ok: true, id: customer.id, action: 'customer.unrestrict',
    ops: [
      { op: 'update', path: `users/${customer.id}`, data: { restricted: false, restrictedReason: DEL, restrictedAt: DEL, updatedAt: TS } },
      auditOp(actor, {
        action: 'customer.unrestrict', entity: 'customer', entityId: customer.id,
        summary: `${label(customer)} — restriction lifted`, before: { restricted: true, reason: customer.restrictedReason }, after: { restricted: false },
      }),
    ],
  };
}

export function planNoteAdd({ customer, text = '', count = 0, actor, noteId }) {
  if (!canWrite(actor)) return fail('forbidden');
  if (!customer || !customer.id) return fail('not_found');
  const body = tidyNote(text);
  if (!body) return fail('invalid', { errors: { text: 'required' } });
  if (body.length > CUSTOMER.NOTE_MAX) return fail('invalid', { errors: { text: 'too_long' } });
  if (count >= CUSTOMER.NOTES_MAX) return fail('too_many');
  const id = noteId || autoId();
  return {
    ok: true, id: customer.id, noteId: id, action: 'customer.note_add',
    ops: [
      { op: 'set', path: `userPrivate/${customer.id}/notes/${id}`, data: { text: body, authorUid: actor.uid, authorEmail: actor.email || '', createdAt: TS } },
      auditOp(actor, { action: 'customer.note_add', entity: 'customer', entityId: customer.id, summary: `Internal note added to ${label(customer)}`, before: null, after: { length: body.length } }),
    ],
  };
}

export function planNoteDelete({ customer, note, actor }) {
  if (!canWrite(actor)) return fail('forbidden');
  if (!customer || !customer.id || !note || !note.id) return fail('not_found');
  return {
    ok: true, id: customer.id, noteId: note.id, action: 'customer.note_delete',
    ops: [
      { op: 'delete', path: `userPrivate/${customer.id}/notes/${note.id}` },
      auditOp(actor, {
        action: 'customer.note_delete', entity: 'customer', entityId: customer.id,
        summary: `Internal note on ${label(customer)} deleted`, before: { authorUid: note.authorUid, length: String(note.text || '').length }, after: null,
      }),
    ],
  };
}

export function planSubscriberRemove({ subscriber, actor }) {
  if (!canWrite(actor)) return fail('forbidden');
  if (!subscriber || !subscriber.id) return fail('not_found');
  const who = maskEmail(subscriber.email || subscriber.id);
  return {
    ok: true, id: subscriber.id, action: 'newsletter.remove',
    ops: [
      { op: 'delete', path: `newsletter/${subscriber.id}` },
      auditOp(actor, { action: 'newsletter.remove', entity: 'newsletter', entityId: who, summary: `Newsletter subscriber ${who} removed`, before: { source: subscriber.source || '' }, after: null }),
    ],
  };
}

export function planExport({ kind, count = 0, actor }) {
  if (!actor || !roleCan(actor.role, CUSTOMER.READ) || !roleCan(actor.role, CUSTOMER.EXPORT)) return fail('forbidden');
  if (!EXPORT_KINDS.includes(kind) || !Number.isInteger(count) || count < 0) return fail('invalid');
  const action = kind === 'customers' ? 'customer.export' : 'newsletter.export';
  return {
    ok: true, action,
    ops: [auditOp(actor, { action, entity: kind === 'customers' ? 'customer' : 'newsletter', entityId: 'csv', summary: `Exported ${count} ${kind} to CSV`, before: null, after: { count } })],
  };
}

/** What a customer's orders add up to. Sales count only the statuses that are revenue (shared/stats.js), cancelled orders are counted apart. */
export function summarizeCustomerOrders(orders = []) {
  const s = summarize(orders);
  const times = orders.map((o) => o.createdAtMs).filter((ms) => Number.isFinite(ms) && ms > 0);
  return { orders: s.count, completed: s.salesCount, cancelled: s.cancelled, spent: s.sales, average: s.aov, firstMs: times.length ? Math.min(...times) : 0, lastMs: times.length ? Math.max(...times) : 0 };
}

/** Search the loaded customers: name, e-mail, id, or any part (3+ digits) of the phone number — also typed with Bengali digits or +880. */
export function filterCustomers(list, { q = '', status = '' } = {}) {
  const needle = latin(q).trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const national = digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
  return (list || []).filter((c) => {
    if (status === 'restricted' && !c.restricted) return false;
    if (!needle) return true;
    if ([c.name, c.email, c.id].some((v) => String(v || '').toLowerCase().includes(needle))) return true;
    if (digits.length < 3) return false;
    const phone = String(c.phone || '').replace(/\D/g, '');
    return phone.includes(digits) || phone.includes(national);
  });
}

/** Newest customers first. */
export const orderCustomers = (list) => (list || []).slice().sort((a, b) => (b.joinedMs || 0) - (a.joinedMs || 0) || String(a.id).localeCompare(String(b.id)));

/** A search that names exactly one customer: an e-mail or a Bangladesh mobile number → { field, value } for an equality query, otherwise null. */
export function lookupKind(q) {
  const s = latin(q).trim();
  if (!s) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { field: 'email', value: s.toLowerCase() };
  const phone = normalizePhone(s);
  return phone ? { field: 'phone', value: phone } : null;
}

export function filterSubscribers(list, q = '') {
  const needle = String(q || '').trim().toLowerCase();
  return (list || []).filter((s) => !needle || [s.email, s.source].some((v) => String(v || '').toLowerCase().includes(needle)));
}
