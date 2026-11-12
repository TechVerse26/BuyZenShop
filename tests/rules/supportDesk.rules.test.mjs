/*
 * Support desk (js/shared/supportFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * Super Admin, Store Admin and Customer Support reply to tickets, change their status and priority; the Order Manager may read tickets but not answer them;
 * everyone else and every customer is refused by the RULES. A reply is a message written as "staff" under the staff member's own uid, a status change,
 * an in-app notification for a customer with an account, an optional queued e-mail and one audit entry (that never carries the message).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTicketReply, planTicketStatus, planTicketPriority, filterTickets, orderTickets, SUPPORT } from '../../js/shared/supportFlow.js';
import { normalizeTicket } from '../../js/shared/ticketModel.js';
import { mailOp } from '../../js/shared/mailFlow.js';
import { TS } from '../../js/shared/ops.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { baseDb, commitBoth, failedOps, NOW, DAY } from './harness.mjs';
import { Ts } from './rules-engine.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const REPLIERS = ['sa', 'sadm', 'cs'];
const OTHERS = ['om', 'pm', 'im', 'rp'];
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const under = (db, prefix) => [...db.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ id: k.split('/').pop(), ...v }));

const base = (over) => ({ userId: 'u1', name: 'Rahim', email: 'rahim@example.com', phone: '01711111111', subject: 'Where is my order', message: 'It is late.', orderNumber: '',
  status: 'open', priority: 'normal', lastAuthor: 'customer', createdAt: new Ts(NOW - DAY), updatedAt: new Ts(NOW - DAY), ...over });
function deskDb() {
  const db = baseDb();
  db.set('supportTickets/T1', base());
  db.set('supportTickets/TG', base({ userId: null, name: 'Guest', email: 'guest@example.com', phone: '', subject: 'Before I buy' }));
  db.set('supportTickets/TP', base({ userId: null, name: 'Phone only', email: '', phone: '01811111111', subject: 'Call me' }));
  return db;
}
const ticket = (db, id) => normalizeTicket(id, db.get(`supportTickets/${id}`));

function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}
const refused = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine allowed it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine allowed it`);
};
const reply = (db, id, who, over = {}) => planTicketReply({ ticket: ticket(db, id), text: 'Your parcel ships tomorrow.', actor: actor(who), storeName: 'Shop Verse', ...over });
const forge = (plan, who) => plan.ops.map((o) => (o.path.startsWith('auditLogs/') ? auditOp(actor(who), { action: 'ticket.reply', entity: 'ticket', entityId: 'T1', summary: 'forged' }) : o));

test('a reply: the message is written as staff under the staff uid, the ticket becomes "answered", the customer gets an in-app notice, the e-mail is queued, one audit entry', () => {
  const db = deskDb();
  const plan = reply(db, 'T1', 'cs', { alsoEmail: true, text: '  Your parcel ships tomorrow.\r\nThank you for waiting.  ' });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, 'answered');
  assert.equal(plan.notified, true);
  assert.equal(plan.emailed, true);
  const after = commit(db, 'cs', plan.ops, 'reply');

  const [msg] = under(after, 'supportTickets/T1/messages/');
  assert.deepEqual([msg.authorType, msg.authorUid], ['staff', 'cs']);
  assert.equal(msg.text, 'Your parcel ships tomorrow.\nThank you for waiting.', 'tidied: trimmed, line breaks normalised');
  assert.ok(msg.createdAt, 'server time');

  const t = after.get('supportTickets/T1');
  assert.deepEqual([t.status, t.lastAuthor], ['answered', 'staff']);
  assert.equal(t.subject, 'Where is my order', 'nothing else on the ticket changed');
  assert.equal(t.message, 'It is late.');

  const [note] = under(after, 'users/u1/notifications/');
  assert.deepEqual([note.kind, note.ticketId, note.read], ['support', 'T1', false]);
  assert.match(note.body, /^T1: Your parcel ships tomorrow/);

  const [mail] = under(after, 'mail/');
  assert.deepEqual(mail.to, ['rahim@example.com']);
  assert.equal(mail.message.subject, 'Re: Where is my order [T1]');
  assert.match(mail.message.text, /Thank you for waiting\.\n\n—\nShop Verse\nReference: T1$/);
  assert.deepEqual([mail.kind, mail.refId, mail.queuedBy], ['ticket_reply', 'T1', 'cs']);

  const log = audits(after);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'ticket.reply');
  assert.equal(log[0].actorRole, 'customer_support');
  assert.equal(log[0].entityId, 'T1');
  assert.equal(JSON.stringify(log[0]).includes('parcel ships'), false, 'the audit entry never carries the message');
});

test('"reply and close" closes the ticket; a reply without the e-mail box queues no mail', () => {
  const db = deskDb();
  const plan = reply(db, 'T1', 'sadm', { close: true });
  assert.equal(plan.status, 'closed');
  assert.equal(plan.emailed, false);
  const after = commit(db, 'sadm', plan.ops, 'reply+close');
  assert.equal(after.get('supportTickets/T1').status, 'closed');
  assert.equal(under(after, 'mail/').length, 0);
  assert.match(audits(after)[0].summary, /and closed it/);
});

test('a guest (no account): no in-app notice, the e-mail is the way; a ticket with only a phone number can be answered but not e-mailed', () => {
  const db = deskDb();
  const guest = reply(db, 'TG', 'cs', { alsoEmail: true });
  assert.equal(guest.notified, false);
  assert.equal(guest.ops.some((o) => o.path.startsWith('users/')), false);
  const after = commit(db, 'cs', guest.ops, 'guest reply');
  assert.deepEqual(under(after, 'mail/')[0].to, ['guest@example.com']);
  assert.match(audits(after)[0].summary, /customer has no account/);

  assert.equal(reply(db, 'TP', 'cs', { alsoEmail: true }).error, 'no_email');
  const phone = reply(db, 'TP', 'cs');
  assert.equal(phone.ok, true);
  commit(db, 'cs', phone.ops, 'phone-only reply');
});

test('who may reply: Super Admin, Store Admin and Customer Support; everyone else is refused by the planner and by the rules', () => {
  const db = deskDb();
  for (const who of REPLIERS) {
    const plan = reply(db, 'T1', who, { alsoEmail: true });
    assert.equal(plan.ok, true, who);
    commit(db, who, plan.ops, `reply as ${who}`);
  }
  const good = reply(db, 'T1', 'cs', { alsoEmail: true });
  for (const who of OTHERS) {
    assert.equal(reply(db, 'T1', who).error, 'forbidden', who);
    assert.equal(planTicketStatus({ ticket: ticket(db, 'T1'), to: 'closed', actor: actor(who) }).error, 'forbidden', who);
    assert.equal(planTicketPriority({ ticket: ticket(db, 'T1'), to: 'high', actor: actor(who) }).error, 'forbidden', who);
    refused(db, who, forge(good, who), `forged reply as ${who}`);
    refused(db, who, [{ op: 'update', path: 'supportTickets/T1', data: { status: 'closed', updatedAt: TS } }], `close as ${who}`);
    refused(db, who, [{ op: 'update', path: 'supportTickets/T1', data: { priority: 'urgent' } }], `priority as ${who}`);
  }
  assert.equal(planTicketReply({ ticket: ticket(db, 'T1'), text: 'x', actor: null }).error, 'forbidden');
});

test('a staff member cannot write under someone else\'s uid or as a customer, and the message length is limited by the rules too', () => {
  const db = deskDb();
  const msg = (data, id = 'm1') => [{ op: 'set', path: `supportTickets/T1/messages/${id}`, data: { authorType: 'staff', authorUid: 'cs', text: 'Hello', createdAt: TS, ...data } }];
  commit(db, 'cs', msg({}), 'plain staff message');
  refused(db, 'cs', msg({ authorUid: 'sa' }), 'impersonate another staff member');
  refused(db, 'cs', msg({ authorType: 'customer' }), 'pose as the customer');
  refused(db, 'cs', msg({ text: '' }), 'empty message');
  refused(db, 'cs', msg({ text: 'x'.repeat(SUPPORT.REPLY_MAX + 1) }), 'message over 2000 characters');
  commit(db, 'cs', msg({ text: 'x'.repeat(SUPPORT.REPLY_MAX) }), 'exactly 2000 characters');
  refused(db, 'cs', msg({ extra: 1 }), 'unknown field');
  refused(db, 'cs', [{ op: 'update', path: 'supportTickets/T1/messages/m1', data: { text: 'edited' } }], 'edit a sent message');
  refused(db, 'sa', [{ op: 'delete', path: 'supportTickets/T1/messages/m1' }], 'delete a message');
});

test('the planner checks the text: required and at most 2000 characters', () => {
  const db = deskDb();
  for (const bad of ['', '   \n  ', null, undefined]) {
    const r = reply(db, 'T1', 'cs', { text: bad });
    assert.equal(r.error, 'invalid');
    assert.deepEqual(r.errors, { text: 'required' });
  }
  const long = reply(db, 'T1', 'cs', { text: 'y'.repeat(SUPPORT.REPLY_MAX + 1) });
  assert.deepEqual(long.errors, { text: 'too_long' });
  assert.equal(reply(db, 'T1', 'cs', { text: 'y'.repeat(SUPPORT.REPLY_MAX) }).ok, true);
  assert.equal(planTicketReply({ ticket: null, text: 'x', actor: actor('cs') }).error, 'not_found');
});

test('a long reply is cut in the notification preview but kept whole in the message', () => {
  const db = deskDb();
  const long = `${'word '.repeat(100)}end`;
  const plan = reply(db, 'T1', 'cs', { text: long });
  const note = plan.ops.find((o) => o.path.startsWith('users/u1/notifications/')).data;
  assert.ok(note.body.length <= 'T1: '.length + SUPPORT.PREVIEW_MAX);
  assert.match(note.body, /…$/);
  assert.equal(plan.ops[0].data.text, long.trim());
});

test('status: changed one step at a time, audited, updatedAt moves; unknown status and "nothing to change" are refused', () => {
  const db = deskDb();
  for (const who of REPLIERS) {
    const plan = planTicketStatus({ ticket: ticket(db, 'T1'), to: 'closed', actor: actor(who) });
    assert.equal(plan.ok, true, who);
    const after = commit(db, who, plan.ops, `close as ${who}`);
    assert.equal(after.get('supportTickets/T1').status, 'closed');
    assert.equal(audits(after)[0].action, 'ticket.status');
    assert.deepEqual(audits(after)[0].after, { status: 'closed' });
  }
  const closed = commit(db, 'sa', planTicketStatus({ ticket: ticket(db, 'T1'), to: 'closed', actor: actor('sa') }).ops, 'close');
  const reopen = planTicketStatus({ ticket: ticket(closed, 'T1'), to: 'open', actor: actor('cs') });
  assert.equal(commit(closed, 'cs', reopen.ops, 'reopen').get('supportTickets/T1').status, 'open');
  assert.equal(planTicketStatus({ ticket: ticket(db, 'T1'), to: 'open', actor: actor('cs') }).error, 'no_change');
  assert.equal(planTicketStatus({ ticket: ticket(db, 'T1'), to: 'banana', actor: actor('cs') }).error, 'bad_status');
  assert.equal(planTicketStatus({ ticket: null, to: 'closed', actor: actor('cs') }).error, 'not_found');
});

test('priority: staff set normal / high / urgent without touching updatedAt; a customer cannot', () => {
  const db = deskDb();
  const plan = planTicketPriority({ ticket: ticket(db, 'T1'), to: 'urgent', actor: actor('cs') });
  const after = commit(db, 'cs', plan.ops, 'urgent');
  assert.equal(after.get('supportTickets/T1').priority, 'urgent');
  assert.deepEqual(after.get('supportTickets/T1').updatedAt, db.get('supportTickets/T1').updatedAt, 'not customer-visible activity');
  assert.equal(audits(after)[0].action, 'ticket.priority');
  assert.equal(planTicketPriority({ ticket: ticket(db, 'T1'), to: 'normal', actor: actor('cs') }).error, 'no_change');
  assert.equal(planTicketPriority({ ticket: ticket(db, 'T1'), to: 'low', actor: actor('cs') }).error, 'bad_priority');
  refused(db, 'u1', [{ op: 'update', path: 'supportTickets/T1', data: { priority: 'urgent', updatedAt: TS } }], 'customer sets priority');
  refused(db, 'u1', [{ op: 'update', path: 'supportTickets/T1', data: { status: 'closed', updatedAt: TS } }], 'customer closes (only re-opening is allowed)');
  refused(db, 'u2', [{ op: 'update', path: 'supportTickets/T1', data: { status: 'open', lastAuthor: 'customer', updatedAt: TS } }], 'someone else re-opens it');
});

test('the e-mail outbox: roles with mail.send may queue, the rest may not, and nobody can change or delete a queued mail from a browser', () => {
  const db = deskDb();
  const queue = (who) => [mailOp({ to: 'a@b.co', subject: 'Hi', text: 'Hello', kind: 'test', actor: actor(who) })];
  for (const who of ['sa', 'sadm', 'om', 'cs']) commit(db, who, queue(who), `queue as ${who}`);
  for (const who of ['pm', 'im', 'rp']) refused(db, who, queue(who), `queue as ${who}`);
  refused(db, 'u1', queue('sa'), 'customer queues mail');
  const withMail = commit(db, 'sa', [{ ...queue('sa')[0], path: 'mail/m1' }], 'fixed id');
  refused(withMail, 'sa', [{ op: 'update', path: 'mail/m1', data: { kind: 'other' } }], 'edit queued mail');
  refused(withMail, 'sa', [{ op: 'delete', path: 'mail/m1' }], 'delete queued mail');
  assert.equal(mailOp({ to: 'not-an-address', subject: 's', text: 't', actor: actor('sa') }), null);
  assert.equal(mailOp({ to: '', subject: 's', text: 't', actor: actor('sa') }), null);
  const long = mailOp({ to: 'a@b.co', subject: 's'.repeat(500), text: 't'.repeat(9000), actor: actor('sa') });
  assert.equal(long.data.message.subject.length, 200);
  assert.equal(long.data.message.text.length, 5000);
});

test('filterTickets / orderTickets: search, priority filter, urgent-then-longest-waiting queue, latest activity first elsewhere', () => {
  const k = (id, over) => ({ id, subject: `Subject ${id}`, message: 'body', name: 'N', email: '', phone: '', orderNumber: '', priority: 'normal', updatedMs: 0, ...over });
  const list = [
    k('A', { updatedMs: 300, name: 'Rahim', email: 'rahim@x.co', orderNumber: 'SV-1' }),
    k('B', { updatedMs: 100, priority: 'high' }),
    k('C', { updatedMs: 200, priority: 'urgent', message: 'Refund please' }),
    k('D', { updatedMs: 50 }),
  ];
  assert.deepEqual(orderTickets(list, 'open').map((x) => x.id), ['C', 'B', 'D', 'A'], 'urgent, high, then the longest waiting');
  assert.deepEqual(orderTickets(list, 'answered').map((x) => x.id), ['A', 'C', 'B', 'D'], 'latest activity first');
  assert.deepEqual(filterTickets(list, { q: 'RAHIM' }).map((x) => x.id), ['A']);
  assert.deepEqual(filterTickets(list, { q: 'refund' }).map((x) => x.id), ['C'], 'finds the first message');
  assert.deepEqual(filterTickets(list, { q: 'sv-1' }).map((x) => x.id), ['A'], 'finds the order number');
  assert.deepEqual(filterTickets(list, { priority: 'high' }).map((x) => x.id), ['B']);
  assert.deepEqual(filterTickets(list, { q: 'zzz' }), []);
  assert.equal(filterTickets(list, {}).length, 4);
});

test('normalizeTicket: unknown values fall back safely and the stored guest marker survives', () => {
  const t = normalizeTicket('X', { subject: 'S', status: 'weird', priority: 'weird', lastAuthor: 'weird', userId: null });
  assert.deepEqual([t.status, t.priority, t.lastAuthor, t.userId, t.email], ['open', 'normal', 'customer', null, '']);
  assert.equal(normalizeTicket('Y', { userId: 'u9', status: 'closed', priority: 'urgent', lastAuthor: 'staff' }).userId, 'u9');
});
