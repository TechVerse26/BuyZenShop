/*
 * Customers for the admin pages. The rules of the game live in shared/customerFlow.js; this module only does I/O.
 *
 *   await loadCustomers({ after })           → { items, last, more }    newest first, PAGE_SIZE at a time; pass the previous `last` to get the next page
 *   await loadRestricted()                   → { items, capped }        every account with restricted == true (first LIST_CAP)
 *   await findCustomers({ field, value })    → Customer[]               exact e-mail / phone lookup over ALL customers (an equality query, no index needed)
 *   await loadCustomer(id)                   → Customer | null
 *   await loadCustomerOrders(uid)            → { orders, capped }       normalized, newest first (equality query on userId, first ORDERS_CAP)
 *   await loadCustomerTickets(uid)           → { items, capped }        support requests written while signed in (first TICKETS_CAP)
 *   await loadNotes(uid)                     → Note[]                   newest first
 *   await loadSubscribers()                  → { items, capped }        newsletter, newest first (first LIST_CAP)
 *   await restrictCustomer({ id, reason }) · liftRestriction(id) · addNote({ id, text }) · deleteNote({ id, noteId }) · removeSubscriber(id) · auditExport(kind, count)
 *
 * Every write re-reads what it changes first, so what is planned is what is stored right now. A refusal is thrown as an AppError with a message for the screen
 * (and `errors` for a field). Customers who have no createdAt field (very old accounts) are missing from the newest-first list: find them by e-mail or phone.
 */
import { listDocs, getDocDataSafe } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { normalizeCustomer, normalizeNote, normalizeSubscriber } from '../../shared/customerModel.js';
import { normalizeOrder } from '../../shared/orderModel.js';
import { normalizeTicket } from '../../shared/ticketModel.js';
import { CUSTOMER, planRestrict, planUnrestrict, planNoteAdd, planNoteDelete, planSubscriberRemove, planExport } from '../../shared/customerFlow.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t } from '../../core/i18n.js';

registerBoth({
  'cus.err.forbidden': ['You are not allowed to change customers.', 'কাস্টমারের তথ্য বদলানোর অনুমতি আপনার নেই।'],
  'cus.err.not_found': ['This customer no longer exists. Reload the page.', 'এই কাস্টমার আর নেই। পেজ রিলোড করুন।'],
  'cus.err.self': ['You cannot restrict your own account.', 'নিজের অ্যাকাউন্ট নিজে সীমাবদ্ধ করা যায় না।'],
  'cus.err.no_change': ['Nothing to change — it is already set.', 'বদলানোর কিছু নেই — এটি আগে থেকেই এভাবে আছে।'],
  'cus.err.invalid': ['Check the form and try again.', 'ফর্মটি দেখে আবার চেষ্টা করুন।'],
  'cus.err.too_many': ['This customer already has the most notes allowed. Delete an old one first.', 'এই কাস্টমারের নোটের সর্বোচ্চ সংখ্যা হয়ে গেছে। আগে পুরোনো একটি মুছুন।'],
});

export const PAGE_SIZE = 100;
export const LIST_CAP = 200;
export const ORDERS_CAP = 100;
export const TICKETS_CAP = 50;

const refusal = (plan) => new AppError(plan.error, t(`cus.err.${plan.error}`) || plan.error, plan.errors ? { errors: plan.errors } : {});
const cust = (d) => normalizeCustomer(d.id, d);

export async function loadCustomers({ after = null } = {}) {
  const r = await listDocs('users', { orderBy: [['createdAt', 'desc']], limit: PAGE_SIZE, after });
  return { items: r.docs.map(cust), last: r.last, more: r.size >= PAGE_SIZE };
}

export async function loadRestricted() {
  const r = await listDocs('users', { where: [['restricted', '==', true]], limit: LIST_CAP });
  return { items: r.docs.map(cust), capped: r.size >= LIST_CAP };
}

export async function findCustomers({ field, value }) {
  if (field !== 'email' && field !== 'phone') return [];
  const r = await listDocs('users', { where: [[field, '==', value]], limit: 5 });
  return r.docs.map(cust);
}

export async function loadCustomer(id) {
  const raw = await getDocDataSafe(`users/${id}`);
  return raw ? normalizeCustomer(id, raw) : null;
}

export async function loadCustomerOrders(uid) {
  const r = await listDocs('orders', { where: [['userId', '==', uid]], limit: ORDERS_CAP });
  const orders = r.docs.map((d) => normalizeOrder(d.id, d)).sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return { orders, capped: r.size >= ORDERS_CAP };
}

export async function loadCustomerTickets(uid) {
  const r = await listDocs('supportTickets', { where: [['userId', '==', uid]], limit: TICKETS_CAP });
  const items = r.docs.map((d) => normalizeTicket(d.id, d)).sort((a, b) => (b.updatedMs || 0) - (a.updatedMs || 0));
  return { items, capped: r.size >= TICKETS_CAP };
}

export async function loadNotes(uid) {
  const r = await listDocs(`userPrivate/${uid}/notes`, { orderBy: [['createdAt', 'desc']], limit: CUSTOMER.NOTES_MAX });
  return r.docs.map((d) => normalizeNote(d.id, d));
}

export async function loadSubscribers() {
  const r = await listDocs('newsletter', { orderBy: [['createdAt', 'desc']], limit: LIST_CAP });
  return { items: r.docs.map((d) => normalizeSubscriber(d.id, d)), capped: r.size >= LIST_CAP };
}

async function fresh(id) {
  const c = await loadCustomer(id);
  if (!c) throw new AppError('not_found', t('cus.err.not_found'));
  return c;
}

async function run(plan) {
  if (!plan.ok) throw refusal(plan);
  await commitAtomic(plan.ops);
  return plan;
}

export async function restrictCustomer({ id, reason }) {
  return run(planRestrict({ customer: await fresh(id), reason, actor: actor() }));
}

export async function liftRestriction(id) {
  return run(planUnrestrict({ customer: await fresh(id), actor: actor() }));
}

export async function addNote({ id, text }) {
  const customer = await fresh(id);
  const count = (await listDocs(`userPrivate/${id}/notes`, { limit: CUSTOMER.NOTES_MAX })).size;
  return run(planNoteAdd({ customer, text, count, actor: actor() }));
}

export async function deleteNote({ id, noteId }) {
  const customer = await fresh(id);
  const raw = await getDocDataSafe(`userPrivate/${id}/notes/${noteId}`);
  if (!raw) throw new AppError('not_found', t('cus.err.not_found'));
  return run(planNoteDelete({ customer, note: normalizeNote(noteId, raw), actor: actor() }));
}

export async function removeSubscriber(id) {
  const raw = await getDocDataSafe(`newsletter/${id}`);
  if (!raw) throw new AppError('not_found', t('cus.err.not_found'));
  return run(planSubscriberRemove({ subscriber: normalizeSubscriber(id, raw), actor: actor() }));
}

/** Writes the audit entry of a bulk export. Called BEFORE the file is handed over, so no export ever happens without a record. */
export async function auditExport(kind, count) {
  return run(planExport({ kind, count, actor: actor() }));
}
