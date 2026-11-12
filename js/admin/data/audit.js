/*
 * Audit log — reading. One page of `auditLogs`, newest first, optionally from a point in time (the period chips).
 * Both shapes use the automatic single-field index on createdAt (a range and the ordering are on the same field), so no composite index has to be deployed.
 * Reading is for audit.read only (Super Admin, Store Admin) — the rules refuse everybody else. The log is written by the planners next to each staff action and can never be edited.
 */
import { listDocs } from '../../data/db.js';
import { Timestamp } from '../../core/firebase.js';
import { AUDIT, normalizeEntry, sinceFor } from '../../shared/auditView.js';

/** → { entries, cursor, more }. `cursor` is what the previous call returned, to continue with the next older page. */
export async function loadAuditPage({ period = 'all', cursor = null, limit = AUDIT.PAGE } = {}) {
  const since = sinceFor(period);
  const r = await listDocs('auditLogs', {
    where: since === null ? [] : [['createdAt', '>=', Timestamp.fromMillis(since)]],
    orderBy: [['createdAt', 'desc']],
    limit,
    after: cursor,
  });
  return { entries: r.docs.map(({ id, ...d }) => normalizeEntry(id, d)), cursor: r.last, more: r.size >= limit };
}
