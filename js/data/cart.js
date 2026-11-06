/*
 * Shopping cart — local-first, synced to users/{uid}/cart/main for signed-in customers.
 *
 * The cart stores only line keys and quantities (+ the unit price seen when the item was added, so
 * the UI can say "price changed"). Names, images and prices always come from the catalog;
 * the authoritative price is re-read from the inventory document at checkout and re-checked by
 * the security rules when the order is written.
 *
 *   cart.add(key, qty)          → throws AppError('too_many_lines') beyond MAX_LINES distinct items
 *   cart.setQty(key, n) / cart.remove(key) / cart.clear()
 *   cart.subscribe(fn)          → fn(lines) on every change; returns unsubscribe
 *   resolveCart(catalog, lines) → display lines with state: ok | out | limited | removed
 */
import { local } from '../core/storage.js';
import { AppError } from '../core/errors.js';
import { t, registerBoth } from '../core/i18n.js';
import { LIMITS, LEGACY, STORAGE_KEYS } from '../shared/constants.js';
import { splitLineKey } from '../shared/id.js';
import { effectivePrice, maxOrderQty, availableQty } from '../shared/pricing.js';
import { findUnit } from '../shared/productModel.js';
import { getDocData } from './db.js';
import { commitAtomic } from './write.js';
import { TS } from '../shared/ops.js';

registerBoth({
  'cart.err.tooMany': ['Your cart can hold up to {n} different items per order. Check out first, or remove an item.', 'একটি অর্ডারে সর্বোচ্চ {n}টি ভিন্ন পণ্য রাখা যায়। আগে অর্ডার সম্পন্ন করুন, অথবা একটি পণ্য সরান।'],
});

let lines = [];                       // [{ key, qty, p }]
const subs = new Set();
let syncUid = null;
let pushTimer = null;

function load() {
  const saved = local.get(STORAGE_KEYS.cart);
  if (saved && Array.isArray(saved.lines)) lines = saved.lines.filter((l) => l && l.key && Number.isInteger(l.qty) && l.qty > 0);
  else {
    // one-time import from the pre-upgrade site: [{ id, name, price, qty }]
    const legacy = local.get(LEGACY.cartStorageKey);
    if (Array.isArray(legacy)) {
      lines = legacy.filter((l) => l && l.id && Number(l.qty) > 0).slice(0, LIMITS.MAX_LINES).map((l) => ({ key: String(l.id), qty: Math.min(LIMITS.MAX_QTY_PER_LINE, Math.floor(Number(l.qty))) }));
      persist();
    }
  }
  local.remove(LEGACY.cartStorageKey);
}
function persist() { local.set(STORAGE_KEYS.cart, { v: 2, lines, updatedAt: Date.now() }); }
function changed() {
  persist();
  subs.forEach((fn) => { try { fn(lines); } catch (e) { console.error(e); } });
  schedulePush();
}

export const cart = {
  lines: () => lines.map((l) => ({ ...l })),
  count: () => lines.reduce((s, l) => s + l.qty, 0),
  distinct: () => lines.length,
  has: (key) => lines.some((l) => l.key === key),
  qtyOf: (key) => lines.find((l) => l.key === key)?.qty || 0,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

  add(key, qty = 1, { price } = {}) {
    const n = Math.max(1, Math.floor(Number(qty) || 1));
    const line = lines.find((l) => l.key === key);
    if (line) { line.qty = Math.min(LIMITS.MAX_QTY_PER_LINE, line.qty + n); if (price !== undefined) line.p = price; }
    else {
      if (lines.length >= LIMITS.MAX_LINES) throw new AppError('too_many_lines', t('cart.err.tooMany', { n: LIMITS.MAX_LINES }));
      lines.push({ key, qty: Math.min(LIMITS.MAX_QTY_PER_LINE, n), ...(price !== undefined ? { p: price } : {}) });
    }
    changed();
  },
  setQty(key, qty) {
    const n = Math.floor(Number(qty) || 0);
    if (n <= 0) return cart.remove(key);
    const line = lines.find((l) => l.key === key);
    if (line) { line.qty = Math.min(LIMITS.MAX_QTY_PER_LINE, n); changed(); }
  },
  acknowledgePrice(key, price) { const l = lines.find((x) => x.key === key); if (l) { l.p = price; changed(); } },
  remove(key) { lines = lines.filter((l) => l.key !== key); changed(); },
  clear() { lines = []; changed(); },
};
load();

/* ───────────────────────── cross-device sync (signed-in customers) ───────────────────────── */

function schedulePush() {
  if (!syncUid) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 900);
}
async function pushNow() {
  if (!syncUid) return;
  const items = Object.fromEntries(lines.map((l) => [l.key, l.qty]));
  try { await commitAtomic([{ op: 'set', path: `users/${syncUid}/cart/main`, data: { items, updatedAt: TS } }]); } catch (e) { console.warn('cart sync failed', e); }
}

/** Call from the app shell: merges the saved cart on sign-in, clears local data on sign-out. */
export function bindCartToAuth(onAuthChange) {
  let prev = null;
  return onAuthChange(async (s) => {
    const uid = s.user ? s.user.uid : null;
    if (uid === prev) return;
    if (!uid && prev) { syncUid = null; lines = []; persist(); subs.forEach((fn) => fn(lines)); prev = null; return; }
    prev = uid; syncUid = uid;
    if (!uid) return;
    try {
      const remote = await getDocData(`users/${uid}/cart/main`);
      const items = remote && remote.items ? remote.items : {};
      const byKey = new Map(lines.map((l) => [l.key, { ...l }]));
      for (const [key, qty] of Object.entries(items)) {
        if (!Number.isInteger(qty) || qty < 1) continue;
        if (byKey.has(key)) byKey.get(key).qty = Math.max(byKey.get(key).qty, qty);
        else if (byKey.size < LIMITS.MAX_LINES) byKey.set(key, { key, qty: Math.min(qty, LIMITS.MAX_QTY_PER_LINE) });
      }
      lines = [...byKey.values()];
      changed();
    } catch (e) { console.warn('cart merge failed', e); schedulePush(); }
  });
}

/* ───────────────────────── display model ───────────────────────── */

/**
 * @returns {{lines: Array, subtotal: number, count: number, issues: number}}
 * line: { key, qty, product, unit, inv, name, variantLabel, image, sku, unitPrice, regularPrice, lineTotal,
 *         state: 'ok'|'out'|'limited'|'removed', maxQty, priceChanged: {from,to}|null }
 */
export function resolveCart(catalog, cartLines = lines, nowMs = Date.now()) {
  const out = [];
  let subtotal = 0; let issues = 0; let count = 0;
  for (const l of cartLines) {
    const { productId } = splitLineKey(l.key);
    const product = catalog?.byId.get(productId) || null;
    const unit = product ? product.units.find((u) => u.key === l.key) || (product.type !== 'variable' ? product.units[0] : null) : null;
    const inv = unit?.inv || null;
    const base = {
      key: l.key, qty: l.qty, product, unit, inv,
      name: product?.name || l.key, variantLabel: unit?.label || '', image: unit?.image || product?.image || '', sku: unit?.sku || '',
      unitPrice: 0, regularPrice: 0, lineTotal: 0, state: 'removed', maxQty: 0, priceChanged: null,
    };
    if (!product || !unit || !inv || inv.active === false) { out.push(base); issues++; continue; }
    const unitPrice = effectivePrice(inv, nowMs);
    const maxQty = maxOrderQty(inv);
    let state = 'ok';
    if (availableQty(inv) <= 0) state = 'out';
    else if (l.qty > maxQty) state = 'limited';
    const priceChanged = l.p !== undefined && l.p !== unitPrice ? { from: l.p, to: unitPrice } : null;
    const row = { ...base, unitPrice, regularPrice: inv.price, maxQty, state, priceChanged, lineTotal: unitPrice * l.qty };
    out.push(row);
    if (state === 'ok') { subtotal += row.lineTotal; count += l.qty; } else issues++;
  }
  return { lines: out, subtotal, count, issues };
}

/** The unit (variant) key to add for a product + chosen options, or null when the combination does not exist. */
export function unitKeyFor(product, chosen) { return findUnit(product, chosen)?.key || null; }
