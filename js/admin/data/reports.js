/*
 * Reports — data layer.
 *
 *   await loadReportData(range)                  → { orders, prevOrders, truncated, prevTruncated, categoryNames }
 *        the orders of the period and of the period of equal length before it (at most LIMITS.REPORT_MAX_ORDERS each; `truncated` says a period had more),
 *        and the category names of the catalog (an order line only stores the category id)
 *   await recordExport({ kind, count, range })   → writes the audit entry of a bulk export; throws an AppError when refused. The caller hands over the file AFTER this resolved.
 *
 * Everything is computed from live orders in the browser (shared/reportFlow.js); nothing is stored. A refusal is thrown as an AppError (forbidden · invalid · empty).
 */
import { fetchOrdersBetween } from '../../data/ordersAdmin.js';
import { loadCatalog } from '../../data/catalog.js';
import { commitAtomic } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t } from '../../core/i18n.js';
import { LIMITS } from '../../shared/constants.js';
import { previousRange, planReportExport } from '../../shared/reportFlow.js';

registerBoth({
  'rpt.err.forbidden': ['You are not allowed to export reports.', 'রিপোর্ট এক্সপোর্ট করার অনুমতি আপনার নেই।'],
  'rpt.err.invalid': ['This export cannot be made.', 'এই এক্সপোর্টটি করা যাচ্ছে না।'],
  'rpt.err.empty': ['There is nothing to export for this period.', 'এই সময়ের জন্য এক্সপোর্ট করার মতো কিছু নেই।'],
});

/** One period: one order more than the cap is asked for, so "more than the cap" is known for sure; then only the newest `cap` orders are kept. */
async function grab(fromMs, toMs) {
  const cap = LIMITS.REPORT_MAX_ORDERS;
  const r = await fetchOrdersBetween(fromMs, toMs, { limit: cap + 1 });
  const over = r.truncated || r.orders.length > cap;
  return { orders: over ? r.orders.slice(0, cap) : r.orders, truncated: over };
}

export async function loadReportData(range) {
  const prev = previousRange(range);
  const [cur, before, catalog] = await Promise.all([
    grab(range.fromMs, range.toMs),
    grab(prev.fromMs, prev.toMs),
    loadCatalog().catch(() => null),
  ]);
  const categoryNames = {};
  for (const c of (catalog && catalog.categories) || []) categoryNames[c.id] = c.name || c.id;
  return { orders: cur.orders, prevOrders: before.orders, truncated: cur.truncated, prevTruncated: before.truncated, categoryNames };
}

export async function recordExport({ kind, count, range }) {
  const plan = planReportExport({ kind, count, range, actor: actor() });
  if (!plan.ok) throw new AppError(plan.error, t(`rpt.err.${plan.error}`));
  await commitAtomic(plan.ops);
}
