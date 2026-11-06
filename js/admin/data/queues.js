/*
 * "Needs attention" counters for the dashboard. Every counter is one equality query (no composite index needed) capped
 * at CAP documents, so the number shows as "100+" instead of reading an unbounded list. A counter whose permission the
 * signed-in role lacks is simply absent (null) — nothing is requested that the rules would refuse.
 */
import { listDocs } from '../../data/db.js';
import { can } from '../../data/auth.js';
import { loadAdminCatalog, stockCounts } from './catalogAdmin.js';

export const QUEUE_CAP = 100;

const count = async (path, where) => {
  const r = await listDocs(path, { where, limit: QUEUE_CAP });
  return r.size;
};
const sum = async (jobs) => {
  const parts = await Promise.all(jobs);
  const n = parts.reduce((s, v) => s + v, 0);
  return { n, capped: n >= QUEUE_CAP };
};
/** A failed counter must not blank the whole dashboard: log it and show nothing for that tile. */
const safe = async (fn) => { try { return await fn(); } catch (e) { console.warn('queue counter failed', e && e.code); return null; } };

export async function loadQueues() {
  const q = { pending: null, verify: null, returns: null, refunds: null, tickets: null, reviews: null, low: null, out: null };
  const jobs = [];
  if (can('orders.read')) {
    // "Pending" (capital P) is how the pre-upgrade site stored the status.
    jobs.push(safe(() => sum([count('orders', [['status', '==', 'pending']]), count('orders', [['status', '==', 'Pending']])])).then((v) => { q.pending = v; }));
    jobs.push(safe(() => sum([count('orders', [['payment.status', '==', 'awaiting_verification']])])).then((v) => { q.verify = v; }));
    jobs.push(safe(() => sum([count('orders', [['status', '==', 'return_requested']])])).then((v) => { q.returns = v; }));
    jobs.push(safe(() => sum([count('orders', [['status', '==', 'refund_pending']])])).then((v) => { q.refunds = v; }));
  }
  if (can('support.read')) jobs.push(safe(() => sum([count('supportTickets', [['status', '==', 'open']])])).then((v) => { q.tickets = v; }));
  if (can('reviews.moderate')) jobs.push(safe(() => sum([count('reviews', [['status', '==', 'pending']])])).then((v) => { q.reviews = v; }));
  if (can('inventory.read')) {
    jobs.push(safe(async () => stockCounts(await loadAdminCatalog())).then((v) => { if (v) { q.low = { n: v.low, capped: false }; q.out = { n: v.out, capped: false }; } }));
  }
  await Promise.all(jobs);
  return q;
}
