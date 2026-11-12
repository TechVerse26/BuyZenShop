/*
 * Staff-side inventory reads and writes for the Inventory page. Pure rules live in shared/inventoryFlow.js; this module only does I/O.
 *
 *   await adjustStock({ key, mode, qty, reason, note })     fresh read of the unit → planner → ONE atomic batch
 *   await previewStockImport(text, cat)                       parse the CSV + plan it against the loaded catalog → plan (with per-row verdicts)
 *   await applyStockImport(plan, { onProgress })              commits the plan's chunks one after the other → { done, total }
 *   await loadMovements({ key, after, limit })                newest first; with a key: the history of one unit
 *   await previewRecount(cat)                                 reads every open order, compares with `reserved` → plan | { tooMany }
 *   await applyRecount(plan, { onProgress })
 *
 * Every change is a batch of its own (≤ 18 operations). An import or recount that stops half-way is simply repeated from a fresh preview:
 * the units that were already written show "no change" the second time.
 */
import { getDocDataSafe, listDocs } from '../../data/db.js';
import { commitAtomic } from '../../data/write.js';
import { actor } from '../../data/auth.js';
import { invalidateCatalog } from '../../data/catalog.js';
import { normalizeOrder } from '../../shared/orderModel.js';
import { planStockChange, parseStockCsv, planStockImport, planReservationFix } from '../../shared/inventoryFlow.js';
import { AppError } from '../../core/errors.js';
import { registerBoth, t, has } from '../../core/i18n.js';
import { invalidateAdminCatalog, unitRows } from './catalogAdmin.js';

registerBoth({
  'iv.err.forbidden': ['Your role cannot change stock.', 'আপনার রোল দিয়ে স্টক বদলানো যাবে না।'],
  'iv.err.no_inventory': ['This product has no inventory record yet. Run the migration (Setup page) first.', 'এই প্রোডাক্টের ইনভেন্টরি রেকর্ড এখনো নেই। আগে মাইগ্রেশন চালান (সেটআপ পেজ)।'],
  'iv.err.untracked': ['Stock is not tracked for this product. Switch on "Track stock" in the product first.', 'এই প্রোডাক্টের স্টক ট্র্যাক হয় না। আগে প্রোডাক্টে "স্টক ট্র্যাক করুন" চালু করুন।'],
  'iv.err.bad_qty': ['Enter a whole number (1 or more; 0 or more for a count).', 'একটি পূর্ণসংখ্যা দিন (১ বা বেশি; গণনায় ০ বা বেশি)।'],
  'iv.err.below_zero': ['That is more than what is in stock.', 'এটি স্টকে থাকা সংখ্যার চেয়ে বেশি।'],
  'iv.err.too_big': ['That number is too large.', 'সংখ্যাটি অনেক বড়।'],
  'iv.err.bad_reason': ['Choose a reason.', 'একটি কারণ বেছে নিন।'],
  'iv.err.bad_mode': ['Choose what to do.', 'কী করবেন বেছে নিন।'],
  'iv.err.note_required': ['Please write a short note for this reason.', 'এই কারণের জন্য একটি ছোট নোট লিখুন।'],
  'iv.err.no_change': ['The stock is already that number.', 'স্টক ইতিমধ্যে এই সংখ্যাই আছে।'],
  'iv.err.empty': ['The file has no rows.', 'ফাইলে কোনো সারি নেই।'],
  'iv.err.bad_header': ['The first row must have a "SKU" (or "Key") column and a "Stock" column.', 'প্রথম সারিতে "SKU" (বা "Key") ও "Stock" কলাম থাকতে হবে।'],
  'iv.err.too_many': ['The file has too many rows (the limit is {max}).', 'ফাইলে সারি অনেক বেশি (সীমা {max}টি)।'],
  'iv.err.too_many_orders': ['There are too many open orders to recount safely from this screen.', 'এই স্ক্রিন থেকে নিরাপদে গণনা করার জন্য খোলা অর্ডার অনেক বেশি।'],
});

function explain(res) {
  const key = `iv.err.${res.error}`;
  return new AppError(res.error, has(key) ? t(key, { max: res.max }) : res.error, { max: res.max });
}
const refresh = () => { invalidateAdminCatalog(); invalidateCatalog(); };

export async function adjustStock({ key, mode, qty, reason, note = '' }) {
  const inv = await getDocDataSafe(`inventory/${key}`);
  const plan = planStockChange({ key, inv, mode, qty, reason, note, actor: actor(), nowMs: Date.now() });
  if (!plan.ok) throw explain(plan);
  await commitAtomic(plan.ops);
  refresh();
  return plan;
}

/** `cat` is the freshly loaded admin catalog (the caller forces a reload so the "before" numbers are current). */
export function previewStockImport(text, cat) {
  const parsed = parseStockCsv(text);
  if (!parsed.ok) throw explain(parsed);
  const units = unitRows(cat).map((r) => ({
    key: r.key, sku: r.unit.sku, name: r.unit.label ? `${r.product.name} — ${r.unit.label}` : r.product.name, inv: r.inv && r.inv._legacy ? null : r.inv,
  }));
  const plan = planStockImport({ rows: parsed.rows, units, actor: actor(), nowMs: Date.now() });
  if (!plan.ok) throw explain(plan);
  return plan;
}

async function runChunks(chunks, onProgress) {
  let done = 0;
  try {
    for (const chunk of chunks) { await commitAtomic(chunk); done += 1; if (onProgress) onProgress(done, chunks.length); }
  } catch (e) { e.chunksDone = done; throw e; } finally { if (done) refresh(); }
  return { done, total: chunks.length };
}
export const applyStockImport = (plan, { onProgress } = {}) => runChunks(plan.chunks, onProgress);

export async function loadMovements({ key = '', after = null, limit = 50 } = {}) {
  if (key) {
    const r = await listDocs('inventoryMovements', { where: [['key', '==', key]], limit: 200 });
    const docs = r.docs.slice().sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    return { docs, last: null, more: false };
  }
  const r = await listDocs('inventoryMovements', { orderBy: [['createdAt', 'desc']], limit, after });
  return { docs: r.docs, last: r.last, more: r.size >= limit };
}
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : Number(v) || 0);

const OPEN = ['pending', 'confirmed', 'processing', 'packed'];
const ORDER_CAP = 500;

export async function previewRecount(cat) {
  const lists = await Promise.all(OPEN.map((s) => listDocs('orders', { where: [['status', '==', s]], limit: ORDER_CAP })));
  if (lists.some((l) => l.size >= ORDER_CAP)) throw explain({ error: 'too_many_orders' });
  const orders = lists.flatMap((l) => l.docs).map((d) => { const { id, ...rest } = d; return normalizeOrder(id, rest); });
  const invByKey = Object.fromEntries(Object.entries(cat.inv));
  const plan = planReservationFix({ orders, invByKey, actor: actor(), nowMs: Date.now() });
  if (!plan.ok) throw explain(plan);
  return { ...plan, openOrders: orders.length };
}
export const applyRecount = (plan, { onProgress } = {}) => runChunks(plan.chunks, onProgress);
