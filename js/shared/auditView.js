/*
 * Audit log viewer — the pure part (no DOM, no Firebase), so it can be tested without a browser.
 *
 * The log (`auditLogs`) is written by the planners next to every staff action: who (uid, e-mail, role), what (action code + a one-line summary),
 * on what (entity + id) and the before/after values. It is read with ONE ordering (newest first) and an optional lower time bound — both use the
 * automatic single-field index, so the project needs no composite index. Everything else (search, area, person) filters what is loaded.
 *
 *   sinceFor(period)                 the time bound of a period chip (null = everything)
 *   normalizeEntry(id, doc)          a stored document → the plain entry the page works with
 *   diffEntry(before, after)         what changed, field by field ("status" or "address.district"), as display strings
 *   entityRoute(entity, id, can)     the admin page an entry is about — only when the viewer may open it
 *   matchesFilters(entry, filters)   search text / area / person
 *   tally(entries, key, label)       the values present, most frequent first (for the filter lists)
 *   rawJson(before, after)           pretty JSON of the two snapshots, capped
 */
import { toMillis } from './pricing.js';

export const AUDIT = Object.freeze({ PAGE: 100, MAX_LOADED: 1000, VALUE_MAX: 300, DEPTH: 3, FIELDS_MAX: 60, RAW_MAX: 20000 });
export const PERIODS = Object.freeze(['24h', '7d', '30d', 'all']);

const HOUR = 3600000;
const SPAN = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };

export const isPeriod = (p) => PERIODS.includes(p);
export const sinceFor = (period, nowMs = Date.now()) => (SPAN[period] ? nowMs - SPAN[period] : null);

/** A stored audit document as the plain entry the page works with (every text capped, the time in ms). */
export function normalizeEntry(id, d = {}) {
  const s = (v, max = 200) => String(v ?? '').slice(0, max);
  return {
    id: String(id), actorUid: s(d.actorUid, 128), actorEmail: s(d.actorEmail), actorRole: s(d.actorRole, 40),
    action: s(d.action, 80), entity: s(d.entity, 60), entityId: s(d.entityId), summary: s(d.summary, 600),
    before: d.before ?? null, after: d.after ?? null, createdMs: toMillis(d.createdAt) || 0,
  };
}

/* ───────────────────────── before / after ───────────────────────── */

const isTime = (v) => v instanceof Date || (v !== null && typeof v === 'object' && typeof v.toMillis === 'function');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !isTime(v);
const timeIso = (v) => new Date(v instanceof Date ? v.getTime() : v.toMillis()).toISOString();

/** One value as the text shown in the diff: null → "—", times as ISO, objects and lists as JSON, long text cut. */
export function showValue(v, max = AUDIT.VALUE_MAX) {
  let s;
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') s = v === '' ? '""' : v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else if (isTime(v)) s = timeIso(v);
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A snapshot as [path, value] pairs: nested objects become dotted paths (up to three segments, "a.b.c"), lists and everything deeper stay one value. */
export function flatten(value, depth = AUDIT.DEPTH, prefix = '', out = []) {
  if (isPlain(value) && !Object.keys(value).length && !prefix) return out;
  if (!isPlain(value) || depth <= 0 || !Object.keys(value).length) {
    if (prefix || (value !== null && value !== undefined)) out.push([prefix || '(value)', value]);
    return out;
  }
  for (const k of Object.keys(value).sort()) flatten(value[k], depth - 1, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

const sig = (v) => `${typeof v}:${showValue(v, Infinity)}`;

/**
 * What changed between two snapshots. kind: 'none' (nothing recorded) · 'created' (no "before") · 'deleted' (no "after") · 'changed' · 'same'.
 * rows: [{ path, change: 'added'|'removed'|'changed', before, after }] as display strings, only the fields that differ, at most FIELDS_MAX (`hidden` counts the rest).
 */
export function diffEntry(before, after) {
  const b = before === undefined ? null : before;
  const a = after === undefined ? null : after;
  const was = new Map(flatten(b));
  const now = new Map(flatten(a));
  const rows = [];
  for (const path of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const inWas = was.has(path); const inNow = now.has(path);
    if (inWas && inNow) {
      if (sig(was.get(path)) === sig(now.get(path))) continue;
      rows.push({ path, change: 'changed', before: showValue(was.get(path)), after: showValue(now.get(path)) });
    } else if (inNow) rows.push({ path, change: 'added', before: '—', after: showValue(now.get(path)) });
    else rows.push({ path, change: 'removed', before: showValue(was.get(path)), after: '—' });
  }
  const kind = b === null && a === null ? 'none' : b === null ? 'created' : a === null ? 'deleted' : rows.length ? 'changed' : 'same';
  return { kind, rows: rows.slice(0, AUDIT.FIELDS_MAX), total: rows.length, hidden: Math.max(0, rows.length - AUDIT.FIELDS_MAX) };
}

/** The two snapshots as pretty JSON (times as ISO), cut at RAW_MAX characters. */
export function rawJson(before, after) {
  let s;
  try { s = JSON.stringify({ before: before ?? null, after: after ?? null }, (k, v) => (isTime(v) ? timeIso(v) : v), 2); } catch { s = '{}'; }
  return s.length > AUDIT.RAW_MAX ? `${s.slice(0, AUDIT.RAW_MAX)}\n…` : s;
}

/* ───────────────────────── links, filters ───────────────────────── */

const E = encodeURIComponent;
/** entity → [permission needed to open the page, path]. An entity without an entry (or without an id where one is needed) has no link. */
const ROUTES = {
  order: ['orders.read', (id) => (id ? `/orders/${E(id)}` : null)],
  product: ['products.read', (id) => (id ? `/products/${E(id)}` : null)],
  customer: ['customers.read', (id) => (id ? `/customers/${E(id)}` : null)],
  ticket: ['support.read', (id) => (id ? `/support/${E(id)}` : null)],
  page: ['content.write', (id) => (id ? `/content/pages/${E(id)}` : null)],
  content: ['content.write', () => '/content'],
  category: ['products.read', () => '/categories'],
  brand: ['products.read', () => '/brands'],
  coupon: ['coupons.read', () => '/coupons'],
  shipping_zone: ['shipping.write', () => '/shipping'],
  review: ['reviews.moderate', () => '/reviews'],
  inventory: ['inventory.read', () => '/inventory'],
  newsletter: ['customers.read', () => '/customers'],
  settings: ['settings.read', () => '/settings'],
  staff: ['staff.manage', () => '/staff'],
  report: ['reports.read', () => '/reports'],
};
export function entityRoute(entity, id, can = () => true) {
  const r = ROUTES[entity];
  if (!r || !can(r[0])) return null;
  return r[1](String(id || ''));
}

/** Search text (summary, action, area, id, e-mail), area and person — every filter that is set must match. */
export function matchesFilters(e, { q = '', entity = '', actor = '' } = {}) {
  if (entity && e.entity !== entity) return false;
  if (actor && e.actorUid !== actor) return false;
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  return [e.summary, e.action, e.entity, e.entityId, e.actorEmail].some((x) => String(x || '').toLowerCase().includes(needle));
}

/** The distinct values of `key` among the entries, most frequent first (ties by label): [{ value, label, count }]. */
export function tally(entries, key, labelOf = (e) => e[key]) {
  const m = new Map();
  for (const e of entries) {
    const v = e[key];
    if (!v) continue;
    const cur = m.get(v) || { value: v, label: labelOf(e), count: 0 };
    cur.count += 1;
    m.set(v, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}
