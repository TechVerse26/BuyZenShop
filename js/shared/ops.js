/*
 * Abstract write operations.
 *
 * Business logic (orderBuilder, orderFlow, inventory planners …) never talks to Firestore directly.
 * It returns a list of plain operations:
 *
 *   { op: 'set' | 'update' | 'delete', path: 'orders/SV-261026-ABC123', data: {...}, merge?: true }
 *
 * `data` may contain three sentinels (plain objects, so they survive JSON and tests):
 *   TS        → server timestamp          (Firestore serverTimestamp())
 *   inc(n)    → numeric increment         (Firestore increment(n))
 *   DEL       → delete this field         (Firestore deleteField())
 *
 * js/data/write.js turns these into SDK calls; tests/rules/harness.mjs turns them into the rules
 * engine's own representation. Keeping this layer pure lets the exact same code run in the browser
 * and in the rules tests.
 */

export const TS = Object.freeze({ $op: 'ts' });
export const DEL = Object.freeze({ $op: 'del' });
export const inc = (n) => ({ $op: 'inc', n });

export const isSentinel = (v) => v !== null && typeof v === 'object' && typeof v.$op === 'string';

/** Group operations into batches of at most `size` (the rules engine allows 20 access calls per batch). */
export function chunkOps(ops, size = 18) {
  const out = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}

/** Drop undefined values (Firestore rejects them) – deep, but leaves sentinels and arrays' items intact. */
export function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object' && !isSentinel(value) && !(value instanceof Date)) {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      o[k] = clean(v);
    }
    return o;
  }
  return value;
}
