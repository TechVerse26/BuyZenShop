/*
 * Customer side of support tickets (staff side lives in the admin panel).
 *
 *   await createTicket({ uid|null, name, email, phone, subject, message, orderNumber? }) → ticketId   (guests allowed: uid = null)
 *   await listMyTickets(uid)                 → [{ id, subject, status, orderNumber, lastAuthor, createdMs, updatedMs }]  newest activity first
 *   await getTicket(id)                      → ticket | null     (own tickets only, otherwise the rules deny → null)
 *   await listMessages(ticketId)             → [{ id, authorType: 'customer'|'staff', text, createdMs }]   oldest first
 *   await replyToTicket(ticket, uid, text)   (adds the message and re-opens the ticket in ONE batch)
 *   validateTicket(input)                    → { field: message } ({} = valid)
 *
 * Document shapes are fixed by firestore.rules → supportTickets/{id}(+/messages/{id}). Tickets are numbered like
 * TK-261029-AB12CD (same generator as order numbers). A guest ticket cannot be read back by the guest.
 */
import { listDocs, getDocDataSafe } from './db.js';
import { commitAtomic } from './write.js';
import { TS } from '../shared/ops.js';
import { autoId, makeOrderNumber, normalizePhone } from '../shared/id.js';
import { PATTERNS } from '../shared/constants.js';
import { normalizeTicket, normalizeMessage } from '../shared/ticketModel.js';
import { AppError } from '../core/errors.js';
import { registerBoth, t } from '../core/i18n.js';

registerBoth({
  'tk.err.name': ['Enter your name.', 'আপনার নাম লিখুন।'],
  'tk.err.email': ['Enter a valid email address (or leave it empty).', 'সঠিক ইমেইল দিন (অথবা ফাঁকা রাখুন)।'],
  'tk.err.phone': ['Enter a valid mobile number (01XXXXXXXXX) or leave it empty.', 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX) অথবা ফাঁকা রাখুন।'],
  'tk.err.contact': ['Give an email or a phone number so we can reply.', 'উত্তর দিতে একটি ইমেইল বা ফোন নম্বর দিন।'],
  'tk.err.subject': ['Write a subject (at least 3 characters).', 'বিষয় লিখুন (কমপক্ষে ৩ অক্ষর)।'],
  'tk.err.message': ['Write your message (at least 5 characters).', 'আপনার বার্তা লিখুন (কমপক্ষে ৫ অক্ষর)।'],
  'tk.err.reply': ['Write a reply first.', 'আগে উত্তর লিখুন।'],
});

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

export function validateTicket(i = {}) {
  const e = {};
  const email = clip(i.email, 120);
  const phone = clip(i.phone, 20);
  if (clip(i.name, 80).length < 2) e.name = t('tk.err.name');
  if (email && !PATTERNS.email.test(email)) e.email = t('tk.err.email');
  if (phone && !normalizePhone(phone)) e.phone = t('tk.err.phone');
  if (!email && !phone) e.contact = t('tk.err.contact');
  if (clip(i.subject, 120).length < 3) e.subject = t('tk.err.subject');
  if (clip(i.message, 2000).length < 5) e.message = t('tk.err.message');
  return e;
}

export async function createTicket(i) {
  const fields = validateTicket(i);
  if (Object.keys(fields).length) throw new AppError('validation', Object.values(fields)[0], { fields });
  const id = makeOrderNumber('TK');
  await commitAtomic([{
    op: 'set', path: `supportTickets/${id}`,
    data: {
      userId: i.uid || null, name: clip(i.name, 80), email: clip(i.email, 120), phone: normalizePhone(i.phone) || '',
      subject: clip(i.subject, 120), message: clip(i.message, 2000), orderNumber: clip(i.orderNumber, 40),
      status: 'open', priority: 'normal', lastAuthor: 'customer', createdAt: TS, updatedAt: TS,
    },
  }]);
  return id;
}

const view = (d) => normalizeTicket(d.id, d);

export async function listMyTickets(uid) {
  const { docs } = await listDocs('supportTickets', { where: [['userId', '==', uid]] });
  return docs.map(view).sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
}

export async function getTicket(id) {
  const d = await getDocDataSafe(`supportTickets/${id}`);
  return d ? view(d) : null;
}

export async function listMessages(ticketId) {
  const { docs } = await listDocs(`supportTickets/${ticketId}/messages`, { orderBy: [['createdAt', 'asc']] });
  return docs.map((m) => normalizeMessage(m.id, m));
}

export async function replyToTicket(ticket, uid, text) {
  const body = clip(text, 2000);
  if (!body) throw new AppError('validation', t('tk.err.reply'));
  await commitAtomic([
    { op: 'set', path: `supportTickets/${ticket.id}/messages/${autoId()}`, data: { authorType: 'customer', authorUid: uid, text: body, createdAt: TS } },
    { op: 'update', path: `supportTickets/${ticket.id}`, data: { status: 'open', lastAuthor: 'customer', updatedAt: TS } },
  ]);
}
