/*
 * Pricing, coupon and shipping maths.
 *
 * These functions mirror the formulas that firestore.rules re-derives at write time
 * (effPrice / lineEligible / couponDiscount / baseShip / validTotals). The client uses them to
 * show the customer exactly what the rules will accept; the rules remain the authority.
 * All amounts are integer BDT. There is no tax line (prices are VAT-inclusive; `tax` is always 0).
 */

import { LIMITS } from './constants.js';

/** Timestamp-ish → epoch ms (Date | number | ISO string | Firestore Timestamp | {seconds}). */
export function toMillis(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  if (typeof v.ms === 'number') return v.ms;
  return null;
}

/* ───────────────────────── unit price ───────────────────────── */

export function isOnSale(inv, nowMs = Date.now()) {
  if (!inv) return false;
  const sale = inv.salePrice;
  if (sale === null || sale === undefined || !(sale < inv.price)) return false;
  const start = toMillis(inv.saleStart);
  const end = toMillis(inv.saleEnd);
  return (start === null || nowMs >= start) && (end === null || nowMs < end);
}

/** The price a customer pays right now for one unit of this inventory record. */
export function effectivePrice(inv, nowMs = Date.now()) {
  return isOnSale(inv, nowMs) ? inv.salePrice : inv.price;
}

export function discountPercent(inv, nowMs = Date.now()) {
  if (!isOnSale(inv, nowMs) || !inv.price) return 0;
  return Math.round(((inv.price - inv.salePrice) / inv.price) * 100);
}

/* ───────────────────────── stock ───────────────────────── */

/** Units a customer can still buy of this inventory record (Infinity when untracked / backorder). */
export function availableQty(inv) {
  if (!inv || inv.active === false) return 0;
  if (inv.track !== true) return Infinity;
  if (inv.allowBackorder === true) return Infinity;
  return Math.max(0, (inv.stock || 0) - (inv.reserved || 0));
}

export function maxOrderQty(inv) {
  const per = Number.isFinite(inv?.maxPerOrder) ? inv.maxPerOrder : LIMITS.MAX_QTY_PER_LINE;
  return Math.max(0, Math.min(per, LIMITS.MAX_QTY_PER_LINE, availableQty(inv)));
}

/** 'in_stock' | 'low' | 'out' | 'backorder' | 'unavailable' */
export function stockState(inv, lowDefault = 5) {
  if (!inv || inv.active === false) return 'unavailable';
  if (inv.track !== true) return 'in_stock';
  const avail = (inv.stock || 0) - (inv.reserved || 0);
  if (avail <= 0) return inv.allowBackorder === true ? 'backorder' : 'out';
  const low = Number.isFinite(inv.lowStockThreshold) ? inv.lowStockThreshold : lowDefault;
  return avail <= low ? 'low' : 'in_stock';
}

/* ───────────────────────── coupons ───────────────────────── */

export function lineEligible(line, coupon) {
  if (!coupon) return false;
  const applies =
    coupon.appliesTo === 'all'
    || (coupon.appliesTo === 'products' && (coupon.productIds || []).includes(line.productId))
    || (coupon.appliesTo === 'categories' && (coupon.categoryIds || []).includes(line.categoryId));
  return applies && (coupon.excludeSaleItems !== true || line.unitPrice === line.regularPrice);
}

export function couponDiscount(coupon, eligibleSubtotal) {
  if (!coupon) return 0;
  if (coupon.type === 'percent') {
    const raw = Math.floor((eligibleSubtotal * coupon.value) / 100);
    return coupon.maxDiscount != null && raw > coupon.maxDiscount ? coupon.maxDiscount : raw;
  }
  if (coupon.type === 'fixed') return coupon.value < eligibleSubtotal ? coupon.value : eligibleSubtotal;
  return 0;
}

/**
 * Eligibility checks that do not need the cart's lines. Returns {ok:true} or {ok:false, reason}.
 * Reasons: not_found | inactive | not_started | expired | min_order | customer_only | usage_limit | per_customer_limit
 * `usedByUser` = number of times this customer already used the coupon (couponUsage.count or 0).
 */
export function checkCoupon(coupon, { subtotal, uid, nowMs = Date.now(), usedByUser = 0 }) {
  if (!coupon) return { ok: false, reason: 'not_found' };
  if (coupon.active !== true) return { ok: false, reason: 'inactive' };
  const start = toMillis(coupon.startsAt);
  const end = toMillis(coupon.endsAt);
  if (start !== null && nowMs < start) return { ok: false, reason: 'not_started' };
  if (end !== null && nowMs >= end) return { ok: false, reason: 'expired' };
  if (subtotal < (coupon.minOrder || 0)) return { ok: false, reason: 'min_order', min: coupon.minOrder || 0 };
  if (Array.isArray(coupon.customerIds) && coupon.customerIds.length > 0 && !coupon.customerIds.includes(uid)) {
    return { ok: false, reason: 'customer_only' };
  }
  if (coupon.usageLimit != null && (coupon.usedCount || 0) >= coupon.usageLimit) return { ok: false, reason: 'usage_limit' };
  if (coupon.perCustomerLimit != null && usedByUser >= coupon.perCustomerLimit) return { ok: false, reason: 'per_customer_limit' };
  return { ok: true };
}

/* ───────────────────────── shipping ───────────────────────── */

export function baseShipping(zone, amount) {
  if (!zone) return 0;
  return zone.freeOver != null && amount >= zone.freeOver ? 0 : zone.fee;
}

export function zoneForDistrict(zones, district) {
  return (zones || []).find((z) => z.active !== false && (z.districts || []).includes(district)) || null;
}

/* ───────────────────────── totals ───────────────────────── */

/**
 * lines: [{ productId, categoryId, unitPrice, regularPrice, qty }]
 * Returns the `totals` object that is stored on the order (and validated by the rules) plus
 * `coupon: {ok, reason?}` describing whether the coupon could be applied.
 */
export function computeTotals({ lines, coupon = null, zone, nowMs = Date.now(), uid = null, usedByUser = 0 }) {
  const withTotals = lines.map((l) => ({ ...l, lineTotal: l.unitPrice * l.qty }));
  const subtotal = withTotals.reduce((s, l) => s + l.lineTotal, 0);

  let couponResult = { ok: false, reason: 'none' };
  let applied = null;
  if (coupon) {
    couponResult = checkCoupon(coupon, { subtotal, uid, nowMs, usedByUser });
    if (couponResult.ok) {
      const eligible = withTotals.reduce((s, l) => s + (lineEligible(l, coupon) ? l.lineTotal : 0), 0);
      if (eligible === 0 && coupon.type !== 'free_shipping') couponResult = { ok: false, reason: 'no_eligible_items' };
      else applied = { eligible };
    }
  }

  let eligibleSubtotal = 0, discount = 0, shipping;
  if (applied) {
    eligibleSubtotal = applied.eligible;
    discount = couponDiscount(coupon, eligibleSubtotal);
    shipping = coupon.type === 'free_shipping' ? 0 : baseShipping(zone, subtotal - discount);
  } else {
    shipping = baseShipping(zone, subtotal);
  }

  return {
    lines: withTotals,
    totals: { subtotal, eligibleSubtotal, discount, shipping, tax: 0, total: subtotal - discount + shipping },
    coupon: couponResult,
    appliedCoupon: applied ? coupon : null,
  };
}

/** "Add ৳X more for free shipping" helper. Returns null when not applicable. */
export function freeShippingGap(zone, subtotal) {
  if (!zone || zone.freeOver == null) return null;
  return subtotal >= zone.freeOver ? 0 : zone.freeOver - subtotal;
}
