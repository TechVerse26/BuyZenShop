/*
 * Wishlist — local-first set of product ids, synced to users/{uid}/wishlist/{productId} when signed in.
 *
 *   wishlist.has(id) · wishlist.toggle(id) → boolean (now saved?) · wishlist.ids() · wishlist.count()
 *   wishlist.subscribe(fn) · bindWishlistToAuth(onAuthChange)
 */
import { local } from '../core/storage.js';
import { listDocs } from './db.js';
import { commitAtomic, commitChunked } from './write.js';
import { TS } from '../shared/ops.js';

const KEY = 'sv.wish.v2';
let ids = new Set(local.get(KEY, []));
let syncUid = null;
const subs = new Set();

function changed() {
  local.set(KEY, [...ids]);
  subs.forEach((fn) => { try { fn([...ids]); } catch (e) { console.error(e); } });
}

export const wishlist = {
  has: (id) => ids.has(id),
  ids: () => [...ids],
  count: () => ids.size,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  async toggle(id) {
    const now = !ids.has(id);
    if (now) ids.add(id); else ids.delete(id);
    changed();
    if (syncUid) {
      const op = now ? { op: 'set', path: `users/${syncUid}/wishlist/${id}`, data: { productId: id, addedAt: TS } } : { op: 'delete', path: `users/${syncUid}/wishlist/${id}` };
      try { await commitAtomic([op]); } catch (e) { console.warn('wishlist sync failed', e); }
    }
    return now;
  },
};

export function bindWishlistToAuth(onAuthChange) {
  let prev = null;
  return onAuthChange(async (s) => {
    const uid = s.user ? s.user.uid : null;
    if (uid === prev) return;
    if (!uid && prev) { syncUid = null; ids = new Set(); changed(); prev = null; return; }
    prev = uid; syncUid = uid;
    if (!uid) return;
    try {
      const { docs } = await listDocs(`users/${uid}/wishlist`);
      const remote = new Set(docs.map((d) => d.id));
      const missing = [...ids].filter((id) => !remote.has(id));
      if (missing.length) await commitChunked(missing.map((id) => ({ op: 'set', path: `users/${uid}/wishlist/${id}`, data: { productId: id, addedAt: TS } })));
      remote.forEach((id) => ids.add(id));
      changed();
    } catch (e) { console.warn('wishlist merge failed', e); }
  });
}
