/*
 * Manual stock changes — pure planners (no I/O), so the browser and the rules tests run the exact same code.
 *
 *   planStockChange({ key, inv, mode: 'add'|'remove'|'set', qty, reason, note, actor, nowMs })
 *       → { ok, key, before, after, delta, ops }  |  { ok:false, error }
 *       one atomic batch: the inventory document, one immutable stock movement, the catalog stamp and an audit entry
 *   parseStockCsv(text)                    → { ok, rows:[{line, ref, count}] } | { ok:false, error }
 *   planStockImport({ rows, units, actor, nowMs })
 *       → { ok, items:[{line, ref, key, sku, name, before, after, delta, status: change|same|error, error}], chunks:[ops[]], changes, same, errors }
 *   planReservationFix({ orders, invByKey, actor, nowMs })   → { ok, diffs, chunks }
 *
 * "add" and "remove" use an increment (a concurrent change by someone else is kept); "set" (a stock count) writes the counted number itself.
 * A CSV import is a stock count, so every changed unit is written as an absolute number: running a chunk twice gives the same stock.
 * Each chunk of an import or recount is its own atomic batch (≤ 18 operations); a failed run is repeated from a fresh preview.
 */
import { TS, inc } from './ops.js';
import { roleCan } from './constants.js';
import { movementOp, auditOp, catalogStampOp, planReservationRecount } from './orderFlow.js';
import { skuKey } from './productFlow.js';
import { parseCsvObjects } from './csv.js';

export const STOCK_MAX = 1000000;
export const IMPORT_MAX_ROWS = 500;
/** 8 units × (inventory update + movement) + catalog stamp + audit entry = 18 operations, the staff batch limit */
export const UNITS_PER_CHUNK = 8;
export const STOCK_MODES = Object.freeze(['add', 'remove', 'set']);
export const STOCK_REASONS = Object.freeze({
  add: ['restock', 'correction', 'other'],
  remove: ['damage', 'loss', 'correction', 'other'],
  set: ['count', 'correction'],
});
/** reason → type written on the movement */
const MOVE_TYPE = Object.freeze({ restock: 'restock', damage: 'damage', loss: 'loss', count: 'count', correction: 'correction', other: 'adjust' });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const cleanNote = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

export function planStockChange({ key, inv, mode, qty, reason, note = '', actor, nowMs }) {
  if (!roleCan(actor.role, 'inventory.adjust')) return fail('forbidden');
  if (!key || !inv || inv._legacy) return fail('no_inventory');
  if (inv.track !== true) return fail('untracked');
  if (!STOCK_MODES.includes(mode)) return fail('bad_mode');
  if (!STOCK_REASONS[mode].includes(reason)) return fail('bad_reason');
  const n = typeof qty === 'number' ? qty : (String(qty ?? '').trim() === '' ? NaN : Number(qty));
  if (!Number.isInteger(n) || n < (mode === 'set' ? 0 : 1)) return fail('bad_qty');
  const before = Number(inv.stock) || 0;
  const after = mode === 'add' ? before + n : mode === 'remove' ? before - n : n;
  if (after < 0) return fail('below_zero', { before });
  if (after > STOCK_MAX) return fail('too_big');
  const text = cleanNote(note);
  if (reason === 'other' && !text) return fail('note_required');
  const delta = after - before;
  if (delta === 0) return fail('no_change', { before });
  const ops = [
    { op: 'update', path: `inventory/${key}`, data: { stock: mode === 'set' ? after : inc(delta), updatedAt: TS } },
    movementOp(actor, { key, inv: { ...inv, stock: before }, type: MOVE_TYPE[reason], delta, note: text }),
    catalogStampOp(nowMs),
    auditOp(actor, { action: 'inventory.adjust', entity: 'inventory', entityId: key, summary: `Stock of ${inv.sku || key}: ${before} → ${after} (${reason})`, before: { stock: before }, after: { stock: after } }),
  ];
  return { ok: true, key, before, after, delta, ops };
}

/* ───────────────────────── CSV stock count ───────────────────────── */

const REF_COLS = ['sku'];
const KEY_COLS = ['key', 'id', 'inventory key'];
const COUNT_COLS = ['stock', 'count', 'new stock', 'new_stock', 'quantity', 'qty'];

/** Reads a spreadsheet export: a "SKU" (or "Key") column and a "Stock" column. Other columns are ignored. */
export function parseStockCsv(text) {
  const { headers, rows } = parseCsvObjects(text);
  if (!headers.length) return fail('empty');
  const skuCol = REF_COLS.find((h) => headers.includes(h)) || null;
  const keyCol = KEY_COLS.find((h) => headers.includes(h)) || null;
  const countCol = COUNT_COLS.find((h) => headers.includes(h)) || null;
  if ((!skuCol && !keyCol) || !countCol) return fail('bad_header');
  if (!rows.length) return fail('empty');
  if (rows.length > IMPORT_MAX_ROWS) return fail('too_many', { max: IMPORT_MAX_ROWS });
  return { ok: true, rows: rows.map((r, i) => ({ line: i + 2, ref: (skuCol && r[skuCol]) || (keyCol && r[keyCol]) || '', count: r[countCol] ?? '' })) };
}

/**
 * @param {{line:number, ref:string, count:string}[]} p.rows
 * @param {{key:string, sku:string, name:string, inv:object|null}[]} p.units   every sellable unit the page knows
 */
export function planStockImport({ rows, units, actor, nowMs }) {
  if (!roleCan(actor.role, 'inventory.adjust')) return fail('forbidden');
  const byKey = new Map(units.map((u) => [u.key, u]));
  const bySku = new Map(units.filter((u) => u.sku).map((u) => [skuKey(u.sku), u]));
  const seen = new Set();
  const items = rows.map((r) => {
    const ref = String(r.ref || '').trim();
    const item = { line: r.line, ref, key: '', sku: '', name: '', before: null, after: null, delta: 0, status: 'error', error: '' };
    if (!ref) { item.error = 'no_ref'; return item; }
    const u = bySku.get(skuKey(ref)) || byKey.get(ref);
    if (!u) { item.error = 'unknown'; return item; }
    Object.assign(item, { key: u.key, sku: u.sku || '', name: u.name || '' });
    if (seen.has(u.key)) { item.error = 'duplicate'; return item; }
    seen.add(u.key);
    if (!u.inv || u.inv._legacy) { item.error = 'no_inventory'; return item; }
    if (u.inv.track !== true) { item.error = 'untracked'; return item; }
    const s = String(r.count ?? '').trim();
    if (!/^\d{1,7}$/.test(s) || Number(s) > STOCK_MAX) { item.error = 'bad_qty'; return item; }
    item.before = Number(u.inv.stock) || 0;
    item.after = Number(s);
    item.delta = item.after - item.before;
    item.status = item.delta === 0 ? 'same' : 'change';
    return item;
  });
  const changes = items.filter((i) => i.status === 'change');
  const chunks = [];
  for (let i = 0; i < changes.length; i += UNITS_PER_CHUNK) {
    const part = changes.slice(i, i + UNITS_PER_CHUNK);
    const ops = [];
    for (const it of part) {
      const u = byKey.get(it.key);
      ops.push({ op: 'update', path: `inventory/${it.key}`, data: { stock: it.after, updatedAt: TS } });
      ops.push(movementOp(actor, { key: it.key, inv: { ...u.inv, stock: it.before }, type: 'count', delta: it.delta, note: 'Stock count (CSV import)' }));
    }
    ops.push(catalogStampOp(nowMs));
    ops.push(auditOp(actor, {
      action: 'inventory.import', entity: 'inventory', entityId: part.slice(0, 3).map((x) => x.key).join(','),
      summary: `Stock count by CSV import: ${part.length} unit(s)`, before: null, after: { units: part.length },
    }));
    chunks.push(ops);
  }
  return { ok: true, items, changes: changes.length, same: items.filter((i) => i.status === 'same').length, errors: items.filter((i) => i.status === 'error').length, chunks };
}

/* ───────────────────────── reservation recount ───────────────────────── */

/** Pairs each correction with its movement and spreads them over atomic chunks (UNITS_PER_CHUNK units each). */
export function planReservationFix({ orders, invByKey, actor, nowMs }) {
  if (!roleCan(actor.role, 'inventory.adjust')) return fail('forbidden');
  const r = planReservationRecount({ orders, invByKey, actor });
  const body = r.ops.filter((o) => o.path !== 'meta/catalog');
  const pairs = [];
  for (let i = 0; i < body.length; i += 2) pairs.push(body.slice(i, i + 2));
  const chunks = [];
  for (let i = 0; i < pairs.length; i += UNITS_PER_CHUNK) {
    const part = pairs.slice(i, i + UNITS_PER_CHUNK);
    chunks.push([
      ...part.flat(),
      catalogStampOp(nowMs),
      auditOp(actor, {
        action: 'inventory.recount', entity: 'inventory', entityId: part.slice(0, 3).map((p) => p[0].path.split('/')[1]).join(','),
        summary: `Reservation recount: ${part.length} unit(s) corrected`, before: null, after: { units: part.length },
      }),
    ]);
  }
  return { ok: true, diffs: r.diffs, chunks };
}
