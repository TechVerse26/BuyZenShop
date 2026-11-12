/*
 * Support desk — pure planners (no I/O), so the admin pages and the rules tests run the exact same code.
 *
 *   planTicketReply({ ticket, text, close, alsoEmail, storeName, actor, nowMs })
 *        → { ok, id, status, ops, notified, emailed } | { ok:false, error, errors? }
 *        error codes: forbidden · not_found · invalid (errors.text: required | too_long) · no_mail_permission · no_email
 *   planTicketStatus({ ticket, to, actor })      → { ok, id, ops }          (bad_status · no_change)
 *   planTicketPriority({ ticket, to, actor })    → { ok, id, ops }          (bad_priority · no_change)
 *   filterTickets(list, { q, priority })         orderTickets(list, status) → sorted copy
 *
 * `ticket` is a view from ticketModel.normalizeTicket. firestore.rules lets everyone with support.reply (Super Admin, Store Admin, Customer Support)
 * change a ticket in any way and add messages as "staff" — so what is allowed is decided here:
 *   • a reply is 1–2000 characters (the rules check the same), written under the staff member's own uid, and moves the ticket to "answered"
 *     (or "closed" when the staff member chose to close it); lastAuthor becomes "staff"
 *   • a customer with an account is told in-app (users/{uid}/notifications, kind "support", ticketId) — a guest cannot read the ticket back at all,
 *     which is why a reply can also be queued as an e-mail (mail/{id}, needs mail.send and an address on the ticket)
 *   • status and priority are changed one at a time; priority never touches updatedAt (it is not customer-visible activity)
 *   • every action is audited: ticket.reply · ticket.status · ticket.priority (the audit entry never carries the message text)
 * The ticket document is readable by its customer, so nothing internal is ever written to it.
 */
import { TS } from './ops.js';
import { roleCan, PATTERNS, TICKET_STATUS, TICKET_PRIORITY } from './constants.js';
import { auditOp } from './orderFlow.js';
import { autoId } from './id.js';
import { mailOp } from './mailFlow.js';

export const SUPPORT = Object.freeze({ PERM: 'support.reply', REPLY_MAX: 2000, PREVIEW_MAX: 140 });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const allowed = (actor) => !!actor && roleCan(actor.role, SUPPORT.PERM);
const tidy = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
const preview = (s) => { const one = String(s).replace(/\s+/g, ' ').trim(); return one.length > SUPPORT.PREVIEW_MAX ? `${one.slice(0, SUPPORT.PREVIEW_MAX - 1)}…` : one; };
const short = (s, n = 60) => String(s || '').slice(0, n);

export function planTicketReply({ ticket, text, close = false, alsoEmail = false, storeName = '', actor, nowMs = Date.now() }) {
  void nowMs;
  if (!allowed(actor)) return fail('forbidden');
  if (!ticket || !ticket.id) return fail('not_found');
  const body = tidy(text);
  if (!body) return fail('invalid', { errors: { text: 'required' } });
  if (body.length > SUPPORT.REPLY_MAX) return fail('invalid', { errors: { text: 'too_long' } });
  let mail = null;
  if (alsoEmail) {
    if (!roleCan(actor.role, 'mail.send')) return fail('no_mail_permission');
    if (!PATTERNS.email.test(ticket.email || '')) return fail('no_email');
    mail = mailOp({
      to: ticket.email, kind: 'ticket_reply', refId: ticket.id, actor,
      subject: `Re: ${ticket.subject} [${ticket.id}]`,
      text: `${body}\n\n—\n${storeName || 'Customer support'}\nReference: ${ticket.id}`,
    });
  }
  const status = close ? 'closed' : 'answered';
  const ops = [
    { op: 'set', path: `supportTickets/${ticket.id}/messages/${autoId()}`, data: { authorType: 'staff', authorUid: actor.uid, text: body, createdAt: TS } },
    { op: 'update', path: `supportTickets/${ticket.id}`, data: { status, lastAuthor: 'staff', updatedAt: TS } },
  ];
  const notified = !!ticket.userId;
  if (notified) {
    ops.push({
      op: 'set', path: `users/${ticket.userId}/notifications/${autoId()}`,
      data: { title: 'Reply to your support request', body: `${ticket.id}: ${preview(body)}`, kind: 'support', ticketId: ticket.id, read: false, createdAt: TS },
    });
  }
  if (mail) ops.push(mail);
  ops.push(auditOp(actor, {
    action: 'ticket.reply', entity: 'ticket', entityId: ticket.id,
    summary: `Replied to ticket ${ticket.id} ("${short(ticket.subject)}")${close ? ' and closed it' : ''}${mail ? ' · e-mail queued' : ''}${notified ? '' : ' · customer has no account'}`,
    before: { status: ticket.status }, after: { status, emailed: !!mail },
  }));
  return { ok: true, id: ticket.id, status, ops, notified, emailed: !!mail };
}

export function planTicketStatus({ ticket, to, actor }) {
  if (!allowed(actor)) return fail('forbidden');
  if (!ticket || !ticket.id) return fail('not_found');
  if (!TICKET_STATUS[to]) return fail('bad_status');
  if (ticket.status === to) return fail('no_change');
  return {
    ok: true, id: ticket.id,
    ops: [
      { op: 'update', path: `supportTickets/${ticket.id}`, data: { status: to, updatedAt: TS } },
      auditOp(actor, {
        action: 'ticket.status', entity: 'ticket', entityId: ticket.id,
        summary: `Ticket ${ticket.id} ("${short(ticket.subject)}"): ${ticket.status} → ${to}`, before: { status: ticket.status }, after: { status: to },
      }),
    ],
  };
}

export function planTicketPriority({ ticket, to, actor }) {
  if (!allowed(actor)) return fail('forbidden');
  if (!ticket || !ticket.id) return fail('not_found');
  if (!TICKET_PRIORITY[to]) return fail('bad_priority');
  if (ticket.priority === to) return fail('no_change');
  return {
    ok: true, id: ticket.id,
    ops: [
      { op: 'update', path: `supportTickets/${ticket.id}`, data: { priority: to } },
      auditOp(actor, {
        action: 'ticket.priority', entity: 'ticket', entityId: ticket.id,
        summary: `Ticket ${ticket.id} ("${short(ticket.subject)}"): priority ${ticket.priority} → ${to}`, before: { priority: ticket.priority }, after: { priority: to },
      }),
    ],
  };
}

/** Search (subject, first message, name, e-mail, phone, ticket number, order number) and an exact priority filter. */
export function filterTickets(list, { q = '', priority = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (list || []).filter((k) => {
    if (priority && k.priority !== priority) return false;
    if (!needle) return true;
    return [k.subject, k.message, k.name, k.email, k.phone, k.id, k.orderNumber].some((v) => String(v || '').toLowerCase().includes(needle));
  });
}

/** The open queue: urgent first, then whoever has waited longest. Answered and closed: latest activity first. */
export function orderTickets(list, status) {
  const rank = (k) => (TICKET_PRIORITY[k.priority] || TICKET_PRIORITY.normal).rank;
  return (list || []).slice().sort((a, b) => {
    if (status === 'open') return (rank(b) - rank(a)) || ((a.updatedMs || 0) - (b.updatedMs || 0)) || String(a.id).localeCompare(String(b.id));
    return ((b.updatedMs || 0) - (a.updatedMs || 0)) || String(a.id).localeCompare(String(b.id));
  });
}
