/*
 * Coupons — pure planners (no I/O), so the Coupons page and the rules tests run the exact same code.
 *
 *   normalizeCode(text)                                                → 'EID-2026'  (trimmed, upper-case)
 *   validateCouponForm(form, { creating, current, catalog, nowMs })    → { ok, code, values, errors }       errors: { field: code }
 *   planCouponSave({ creating, form, current, catalog, actor, nowMs })  → { ok, code, values, action, ops } | { ok:false, error, errors? }
 *   planCouponActive({ code, active, current, actor })                  → { ok, code, action, ops } | { ok:false, error }
 *   planCouponRemove({ code, current, actor })                          → { ok, code, ops } | { ok:false, error }
 *   couponStatus(coupon, nowMs)                                         → 'live' | 'scheduled' | 'expired' | 'exhausted' | 'disabled'
 *   describeOffer(coupon)                                               → '10% off, max 200'  (English, for the audit log)
 *
 * firestore.rules lets `coupons.write` (Super Admin, Store Admin) write coupons/<CODE> without looking at its shape, but the ORDER rule
 * trusts the stored coupon (type, value, maxDiscount, minOrder, dates, customerIds, scope) when it re-derives a discount — so a coupon
 * with a wrong shape is a price list with a bug. This file is the validator:
 *   code ^[A-Z0-9-]{3,24}$ and never changes · type percent | fixed | free_shipping · percent 1–100 (optional cap) · fixed whole taka
 *   minOrder ≥ 0 · endsAt after startsAt (and in the future for a new coupon) · usageLimit ≥ what was used already · scope all |
 *   categories | products (ids must exist) · customerIds = the only accounts that may use it (empty = everyone)
 * Staff never write usedCount / lastOrderId / createdAt (checkout does, through the rules). A coupon that has been used cannot be deleted:
 * switch it off instead, the history stays. Every change is one atomic batch: the coupon + one audit entry.
 */
import { TS } from './ops.js';
import { roleCan } from './constants.js';
import { toMillis } from './pricing.js';
import { auditOp } from './orderFlow.js';

export const COUPON_TYPES = Object.freeze(['percent', 'fixed', 'free_shipping']);
export const COUPON_SCOPES = Object.freeze(['all', 'categories', 'products']);
export const COUPON_LIMITS = Object.freeze({ amountMax: 1000000, minOrderMax: 10000000, usageMax: 1000000, perCustomerMax: 1000, descMax: 200, productsMax: 100, categoriesMax: 50, customersMax: 50 });
export const CODE_PATTERN = /^[A-Z0-9-]{3,24}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const whole = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return s === '' ? null : Number(s);
};
const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))];
const known = (coll, id) => (coll && typeof coll.has === 'function' ? coll.has(id) : (coll || []).includes(id));

export const normalizeCode = (text) => String(text ?? '').trim().toUpperCase();

export function couponStatus(c, nowMs = Date.now()) {
  if (!c || c.active !== true) return 'disabled';
  const start = toMillis(c.startsAt);
  const end = toMillis(c.endsAt);
  if (end !== null && nowMs >= end) return 'expired';
  if (start !== null && nowMs < start) return 'scheduled';
  if (c.usageLimit != null && (Number(c.usedCount) || 0) >= c.usageLimit) return 'exhausted';
  return 'live';
}

export function describeOffer(c) {
  if (c.type === 'free_shipping') return 'free shipping';
  if (c.type === 'fixed') return `${c.value} off`;
  return `${c.value}% off${c.maxDiscount != null ? `, max ${c.maxDiscount}` : ''}`;
}

export function validateCouponForm(form = {}, { creating = false, current = null, catalog = null, nowMs = Date.now() } = {}) {
  const errors = {};
  const code = creating ? normalizeCode(form.code) : String((current && (current.code || current.id)) || '');
  if (creating) {
    if (!code) errors.code = 'required';
    else if (!CODE_PATTERN.test(code)) errors.code = 'bad_code';
  }

  const type = String(form.type ?? '');
  if (!COUPON_TYPES.includes(type)) errors.type = 'bad_type';
  let value = toNum(form.value);
  if (type === 'free_shipping') value = 0;
  else if (type === 'percent' || type === 'fixed') {
    if (value === null) errors.value = 'required';
    else if (type === 'percent' ? !whole(value, 1, 100) : !whole(value, 1, COUPON_LIMITS.amountMax)) errors.value = type === 'percent' ? 'bad_percent' : 'bad_amount';
  }
  let maxDiscount = null;
  if (type === 'percent') {
    const m = toNum(form.maxDiscount);
    if (m !== null) { if (whole(m, 1, COUPON_LIMITS.amountMax)) maxDiscount = m; else errors.maxDiscount = 'bad_amount'; }
  }
  const mo = toNum(form.minOrder);
  const minOrder = mo === null ? 0 : mo;
  if (!whole(minOrder, 0, COUPON_LIMITS.minOrderMax)) errors.minOrder = 'bad_amount';

  const appliesTo = String(form.appliesTo ?? 'all');
  if (!COUPON_SCOPES.includes(appliesTo)) errors.appliesTo = 'bad_scope';
  let productIds = [];
  let categoryIds = [];
  if (appliesTo === 'products') {
    productIds = ids(form.productIds);
    if (!productIds.length) errors.productIds = 'none';
    else if (productIds.length > COUPON_LIMITS.productsMax) errors.productIds = 'too_many';
    else if (catalog && catalog.productIds && productIds.some((id) => !known(catalog.productIds, id))) errors.productIds = 'unknown';
  } else if (appliesTo === 'categories') {
    categoryIds = ids(form.categoryIds);
    if (!categoryIds.length) errors.categoryIds = 'none';
    else if (categoryIds.length > COUPON_LIMITS.categoriesMax) errors.categoryIds = 'too_many';
    else if (catalog && catalog.categoryIds && categoryIds.some((id) => !known(catalog.categoryIds, id))) errors.categoryIds = 'unknown';
  }

  const startsAt = toNum(form.startsAt);
  const endsAt = toNum(form.endsAt);
  if (startsAt !== null && !Number.isFinite(startsAt)) errors.startsAt = 'bad_date';
  if (endsAt !== null && !Number.isFinite(endsAt)) errors.endsAt = 'bad_date';
  if (!errors.startsAt && !errors.endsAt && startsAt !== null && endsAt !== null && endsAt <= startsAt) errors.endsAt = 'end_before_start';
  if (creating && !errors.endsAt && endsAt !== null && endsAt <= nowMs) errors.endsAt = 'end_past';

  const usageLimit = toNum(form.usageLimit);
  if (usageLimit !== null && !whole(usageLimit, 1, COUPON_LIMITS.usageMax)) errors.usageLimit = 'bad_limit';
  else if (usageLimit !== null && current && usageLimit < (Number(current.usedCount) || 0)) errors.usageLimit = 'limit_below_used';
  const perCustomerLimit = toNum(form.perCustomerLimit);
  if (perCustomerLimit !== null && !whole(perCustomerLimit, 1, COUPON_LIMITS.perCustomerMax)) errors.perCustomerLimit = 'bad_limit';

  const customerIds = ids(form.customerIds);
  if (customerIds.length > COUPON_LIMITS.customersMax) errors.customerIds = 'too_many';
  else if (customerIds.some((id) => !ID_PATTERN.test(id))) errors.customerIds = 'bad_customer';

  const description = String(form.description ?? '').replace(/\s+/g, ' ').trim();
  if (description.length > COUPON_LIMITS.descMax) errors.description = 'too_long';
  const active = typeof form.active === 'boolean' ? form.active : (current ? current.active === true : true);

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true, errors, code,
    values: {
      type, value, maxDiscount, minOrder, appliesTo, productIds, categoryIds, excludeSaleItems: form.excludeSaleItems === true,
      startsAt, endsAt, usageLimit, perCustomerLimit, customerIds, active, description,
    },
  };
}

/** a stored coupon in the same shape as `values` (dates in ms) so the two can be compared */
const norm = (c) => ({
  type: c.type, value: Number(c.value) || 0, maxDiscount: c.maxDiscount ?? null, minOrder: Number(c.minOrder) || 0, appliesTo: c.appliesTo || 'all',
  productIds: ids(c.productIds), categoryIds: ids(c.categoryIds), excludeSaleItems: c.excludeSaleItems === true,
  startsAt: toMillis(c.startsAt), endsAt: toMillis(c.endsAt), usageLimit: c.usageLimit ?? null, perCustomerLimit: c.perCustomerLimit ?? null,
  customerIds: ids(c.customerIds), active: c.active === true, description: String(c.description || ''),
});
const sig = (x) => JSON.stringify({ ...x, productIds: [...x.productIds].sort(), categoryIds: [...x.categoryIds].sort(), customerIds: [...x.customerIds].sort() });
const sameIds = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());
const when = (ms) => (ms === null ? 'none' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
const brief = (x) => ({
  offer: describeOffer(x), minOrder: x.minOrder, appliesTo: x.appliesTo, products: x.productIds.length, categories: x.categoryIds.length, customers: x.customerIds.length,
  startsAt: x.startsAt, endsAt: x.endsAt, usageLimit: x.usageLimit, perCustomerLimit: x.perCustomerLimit, active: x.active,
});

function describeChange(b, a) {
  const bits = [];
  if (b.type !== a.type || b.value !== a.value || b.maxDiscount !== a.maxDiscount) bits.push(`offer ${describeOffer(b)} → ${describeOffer(a)}`);
  if (b.minOrder !== a.minOrder) bits.push(`min order ${b.minOrder} → ${a.minOrder}`);
  if (b.appliesTo !== a.appliesTo) bits.push(`applies to ${b.appliesTo} → ${a.appliesTo}`);
  else if (a.appliesTo === 'products' && !sameIds(b.productIds, a.productIds)) bits.push(`products ${b.productIds.length} → ${a.productIds.length}`);
  else if (a.appliesTo === 'categories' && !sameIds(b.categoryIds, a.categoryIds)) bits.push(`categories ${b.categoryIds.length} → ${a.categoryIds.length}`);
  if (b.excludeSaleItems !== a.excludeSaleItems) bits.push(a.excludeSaleItems ? 'sale items excluded' : 'sale items included');
  if (b.startsAt !== a.startsAt) bits.push(`starts ${when(b.startsAt)} → ${when(a.startsAt)}`);
  if (b.endsAt !== a.endsAt) bits.push(`ends ${when(b.endsAt)} → ${when(a.endsAt)}`);
  if (b.usageLimit !== a.usageLimit) bits.push(`usage limit ${b.usageLimit ?? 'none'} → ${a.usageLimit ?? 'none'}`);
  if (b.perCustomerLimit !== a.perCustomerLimit) bits.push(`per customer ${b.perCustomerLimit ?? 'none'} → ${a.perCustomerLimit ?? 'none'}`);
  if (!sameIds(b.customerIds, a.customerIds)) bits.push(`customers ${b.customerIds.length} → ${a.customerIds.length}`);
  if (b.description !== a.description) bits.push('description changed');
  if (b.active !== a.active) bits.push(a.active ? 'switched on' : 'switched off');
  return bits.join('; ');
}

export function planCouponSave({ creating = false, form, current = null, catalog = null, actor, nowMs = Date.now() }) {
  if (!actor || !roleCan(actor.role, 'coupons.write')) return fail('forbidden');
  if (!creating && !current) return fail('not_found');
  const v = validateCouponForm(form, { creating, current: creating ? null : current, catalog, nowMs });
  if (!v.ok) return fail('invalid', { errors: v.errors });
  if (creating && current) return fail('exists', { errors: { code: 'exists' } });
  const { code, values } = v;
  const date = (ms) => (ms === null ? null : new Date(ms));

  if (creating) {
    return {
      ok: true, code, values, action: 'coupon.create',
      ops: [
        { op: 'set', path: `coupons/${code}`, data: { code, ...values, startsAt: date(values.startsAt), endsAt: date(values.endsAt), usedCount: 0, createdAt: TS, updatedAt: TS } },
        auditOp(actor, { action: 'coupon.create', entity: 'coupon', entityId: code, summary: `Coupon ${code} created: ${describeOffer(values)}, min order ${values.minOrder}`, before: null, after: brief(values) }),
      ],
    };
  }

  const before = norm(current);
  if (sig(before) === sig(values)) return fail('no_change');
  const onlyActive = sig({ ...before, active: values.active }) === sig(values);
  const action = onlyActive ? (values.active ? 'coupon.activate' : 'coupon.deactivate') : 'coupon.update';
  return {
    ok: true, code, values, action,
    ops: [
      { op: 'update', path: `coupons/${code}`, data: { ...values, startsAt: date(values.startsAt), endsAt: date(values.endsAt), updatedAt: TS } },
      auditOp(actor, { action, entity: 'coupon', entityId: code, summary: `Coupon ${code}: ${describeChange(before, values)}`, before: brief(before), after: brief(values) }),
    ],
  };
}

export function planCouponActive({ code, active, current, actor }) {
  if (!actor || !roleCan(actor.role, 'coupons.write')) return fail('forbidden');
  if (!current) return fail('not_found');
  const want = active === true;
  if ((current.active === true) === want) return fail('no_change');
  const action = want ? 'coupon.activate' : 'coupon.deactivate';
  return {
    ok: true, code, action,
    ops: [
      { op: 'update', path: `coupons/${code}`, data: { active: want, updatedAt: TS } },
      auditOp(actor, { action, entity: 'coupon', entityId: code, summary: `Coupon ${code} ${want ? 'switched on' : 'switched off'}`, before: { active: !want }, after: { active: want } }),
    ],
  };
}

export function planCouponRemove({ code, current, actor }) {
  if (!actor || !roleCan(actor.role, 'coupons.write')) return fail('forbidden');
  if (!current) return fail('not_found');
  if ((Number(current.usedCount) || 0) > 0) return fail('used');
  return {
    ok: true, code,
    ops: [
      { op: 'delete', path: `coupons/${code}` },
      auditOp(actor, { action: 'coupon.delete', entity: 'coupon', entityId: code, summary: `Coupon ${code} deleted (${describeOffer(norm(current))}, never used)`, before: brief(norm(current)), after: null }),
    ],
  };
}
