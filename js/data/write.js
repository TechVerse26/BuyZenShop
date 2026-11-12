/*
 * Commits abstract write operations (js/shared/ops.js) through the Firestore SDK.
 *
 * Atomicity matters: a status change and its stock effect, or an order and its inventory
 * reservation, MUST land in one batch (the security rules bind them together with getAfter()).
 *   commitAtomic(ops)            – exactly one batch; throws if it cannot be atomic
 *   commitChunked(ops, {size})   – bulk jobs (imports, migrations); each chunk atomic, the job idempotent
 */
import { db, doc, writeBatch, serverTimestamp, increment, deleteField, Timestamp } from '../core/firebase.js';
import { isSentinel, clean, chunkOps } from '../shared/ops.js';
import { LIMITS } from '../shared/constants.js';

const ref = (path) => doc(db, ...String(path).split('/').filter(Boolean));

export function toSdk(value) {
  if (isSentinel(value)) {
    if (value.$op === 'ts') return serverTimestamp();
    if (value.$op === 'inc') return increment(value.n);
    if (value.$op === 'del') return deleteField();
  }
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (Array.isArray(value)) return value.map(toSdk);
  if (value && typeof value === 'object' && typeof value.toMillis !== 'function') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = toSdk(v);
    return o;
  }
  return value;
}

function addToBatch(batch, o) {
  const r = ref(o.path);
  if (o.op === 'set') { if (o.merge) batch.set(r, toSdk(clean(o.data)), { merge: true }); else batch.set(r, toSdk(clean(o.data))); }
  else if (o.op === 'update') batch.update(r, toSdk(clean(o.data)));
  else if (o.op === 'delete') batch.delete(r);
  else throw new Error(`Unknown write op: ${o.op}`);
}

/** One batch, all-or-nothing. */
export async function commitAtomic(ops) {
  const list = (ops || []).filter(Boolean);
  if (!list.length) return 0;
  if (list.length > 20) throw new Error(`This change touches ${list.length} documents; an atomic batch is limited to 20 (firestore.rules access-call budget).`);
  const batch = writeBatch(db);
  for (const o of list) addToBatch(batch, o);
  await batch.commit();
  return list.length;
}

/** Many writes, committed in sequential atomic chunks. Returns the number of ops written. */
export async function commitChunked(ops, { size = LIMITS.ADMIN_BATCH_OPS, onProgress } = {}) {
  const list = (ops || []).filter(Boolean);
  let done = 0;
  for (const chunk of chunkOps(list, size)) {
    const batch = writeBatch(db);
    for (const o of chunk) addToBatch(batch, o);
    await batch.commit();
    done += chunk.length;
    if (onProgress) onProgress(done, list.length);
  }
  return done;
}

/** Convenience single-document writers (each is one atomic commit). */
export const setDocData = (path, data, merge = false) => commitAtomic([{ op: 'set', path, data, merge }]);
export const updateDocData = (path, data) => commitAtomic([{ op: 'update', path, data }]);
export const deleteDocData = (path) => commitAtomic([{ op: 'delete', path }]);
