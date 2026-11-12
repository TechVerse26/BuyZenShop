/*
 * Support tickets for the admin pages. The rules of the game live in shared/supportFlow.js; this module only does I/O.
 *
 *   await loadTicketList(status)           → { items: Ticket[], capped }     'open' | 'answered' | 'closed' — one equality query, at most LIST_CAP
 *   await loadTicket(id)                   → { ticket, messages } | null     the ticket and its conversation, oldest message first
 *   await sendReply({ id, text, close, alsoEmail })   the message, the status, the in-app notice, the optional queued e-mail, the audit entry
 *   await setStatus({ id, to })            await setPriority({ id, to })
 *
 * Every write re-reads the ticket first, so what is planned is what is stored right now. A refusal is thrown as an AppError with a message for the screen.
 */
import { listDocs, getDocDataSafe } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { settings } from '../../data/settings.js';
import { normalizeTicket, normalizeMessage } from '../../shared/ticketModel.js';
import { planTicketReply, planTicketStatus, planTicketPriority } from '../../shared/supportFlow.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t } from '../../core/i18n.js';

registerBoth({
  'tkm.guest': ['No account', 'অ্যাকাউন্ট নেই'],                                  // used by the queue and by the request page, so it lives here
  'tkm.err.forbidden': ['You are not allowed to answer requests.', 'অনুরোধের উত্তর দেওয়ার অনুমতি আপনার নেই।'],
  'tkm.err.not_found': ['This request no longer exists. Reload the list.', 'এই অনুরোধটি আর নেই। তালিকা রিলোড করুন।'],
  'tkm.err.invalid': ['Check the reply and try again.', 'উত্তরটি দেখে আবার চেষ্টা করুন।'],
  'tkm.err.no_mail_permission': ['Your role may not queue e-mails.', 'আপনার রোল ইমেইল কিউ করতে পারে না।'],
  'tkm.err.no_email': ['This request has no e-mail address.', 'এই অনুরোধে কোনো ইমেইল ঠিকানা নেই।'],
  'tkm.err.no_change': ['Nothing to change — it is already set.', 'বদলানোর কিছু নেই — এটি আগে থেকেই এভাবে আছে।'],
  'tkm.err.bad_status': ['That is not a valid status.', 'এটি সঠিক স্ট্যাটাস নয়।'],
  'tkm.err.bad_priority': ['That is not a valid priority.', 'এটি সঠিক প্রায়োরিটি নয়।'],
});

export const LIST_CAP = 200;
const MESSAGE_CAP = 300;

const refusal = (plan) => new AppError(plan.error, t(`tkm.err.${plan.error}`) || plan.error, plan.errors ? { errors: plan.errors } : {});

export async function loadTicketList(status) {
  const r = await listDocs('supportTickets', { where: [['status', '==', status]], limit: LIST_CAP });
  return { items: r.docs.map((d) => normalizeTicket(d.id, d)), capped: r.size >= LIST_CAP };
}

export async function loadTicket(id) {
  const raw = await getDocDataSafe(`supportTickets/${id}`);
  if (!raw) return null;
  const { docs } = await listDocs(`supportTickets/${id}/messages`, { orderBy: [['createdAt', 'asc']], limit: MESSAGE_CAP });
  return { ticket: normalizeTicket(id, raw), messages: docs.map((m) => normalizeMessage(m.id, m)) };
}

async function fresh(id) {
  const raw = await getDocDataSafe(`supportTickets/${id}`);
  if (!raw) throw new AppError('not_found', t('tkm.err.not_found'));
  return normalizeTicket(id, raw);
}

async function run(plan) {
  if (!plan.ok) throw refusal(plan);
  await commitAtomic(plan.ops);
  return plan;
}

export async function sendReply({ id, text, close = false, alsoEmail = false }) {
  const ticket = await fresh(id);
  return run(planTicketReply({ ticket, text, close, alsoEmail, storeName: settings().storeName || '', actor: actor(), nowMs: Date.now() }));
}

export async function setStatus({ id, to }) {
  return run(planTicketStatus({ ticket: await fresh(id), to, actor: actor() }));
}

export async function setPriority({ id, to }) {
  return run(planTicketPriority({ ticket: await fresh(id), to, actor: actor() }));
}
