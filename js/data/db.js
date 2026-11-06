/*
 * Thin Firestore helpers. Paths are plain strings ('orders/SV-261026-ABC123', 'orders/X/events').
 *
 *   await getDocData('products/abc')                       → { id, ...data } | null
 *   await listDocs('orders', { where: [['status','==','pending']], orderBy: [['createdAt','desc']], limit: 25, after: lastSnap })
 *        → { docs: [{id,...}], last: snapshot|null, size }
 *   const off = watchDoc('orders/X', (doc|null) => …, onError)
 *   const off = watchList('orders', opts, (docs) => …, onError)
 *
 * Timestamps stay Firestore Timestamp objects in memory (shared/pricing.toMillis understands them).
 */
import {
  db, doc, collection, getDoc, getDocs, query, where, orderBy, limit as qLimit, startAfter, onSnapshot,
} from '../core/firebase.js';

const segs = (path) => String(path).split('/').filter(Boolean);
export const docRef = (path) => doc(db, ...segs(path));
export const colRef = (path) => collection(db, ...segs(path));
export const snapData = (s) => (s && s.exists() ? { id: s.id, ...s.data() } : null);

export async function getDocData(path) { return snapData(await getDoc(docRef(path))); }

/** Like getDocData but resolves null instead of throwing on permission-denied (hidden / missing docs). */
export async function getDocDataSafe(path) {
  try { return await getDocData(path); } catch (e) {
    if (/permission-denied|insufficient permissions/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

function build(colPath, { where: w = [], orderBy: o = [], limit: l, after } = {}) {
  const c = [];
  for (const [f, op, v] of w) c.push(where(f, op, v));
  for (const [f, dir] of o) c.push(orderBy(f, dir || 'asc'));
  if (after) c.push(startAfter(after));
  if (l) c.push(qLimit(l));
  return query(colRef(colPath), ...c);
}

export async function listDocs(colPath, opts = {}) {
  const snap = await getDocs(build(colPath, opts));
  return { docs: snap.docs.map(snapData), last: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, size: snap.size };
}

export function watchDoc(path, cb, onError) {
  return onSnapshot(docRef(path), (s) => cb(snapData(s)), (e) => { if (onError) onError(e); else console.error(e); });
}
export function watchList(colPath, opts, cb, onError) {
  return onSnapshot(build(colPath, opts), (s) => cb(s.docs.map(snapData)), (e) => { if (onError) onError(e); else console.error(e); });
}

/** Firestore Timestamp / Date → {ms} so documents survive JSON (localStorage caches). */
export function serializeDoc(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return { ms: v.toMillis() };
  if (v instanceof Date) return { ms: v.getTime() };
  if (Array.isArray(v)) return v.map(serializeDoc);
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = serializeDoc(x);
  return o;
}
