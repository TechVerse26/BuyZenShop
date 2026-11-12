/*
 * The e-mail outbox. Nothing here sends mail: it only QUEUES a document in `mail/{id}`, which the optional Firebase extension
 * "Trigger Email from Firestore" (installed by the shop owner, see docs/DEPLOYMENT.md) turns into a real message and marks with a `delivery` result.
 * Without that extension the documents simply wait — the admin screens say so.
 *
 *   mailOp({ to, subject, text, kind, refId, actor }) → op | null      (null when `to` is not an e-mail address)
 *
 * firestore.rules: only roles with mail.send may create documents, nobody may change or delete them from a browser.
 */
import { TS } from './ops.js';
import { PATTERNS } from './constants.js';
import { autoId } from './id.js';

export const MAIL_LIMITS = Object.freeze({ SUBJECT_MAX: 200, TEXT_MAX: 5000 });

export function mailOp({ to, subject, text, kind = 'info', refId = '', actor }) {
  const address = String(to || '').trim();
  if (!PATTERNS.email.test(address)) return null;
  return {
    op: 'set', path: `mail/${autoId()}`,
    data: {
      to: [address],
      message: { subject: String(subject || '').slice(0, MAIL_LIMITS.SUBJECT_MAX), text: String(text || '').slice(0, MAIL_LIMITS.TEXT_MAX) },
      kind: String(kind).slice(0, 40), refId: String(refId).slice(0, 80), queuedBy: actor.uid, createdAt: TS,
    },
  };
}
