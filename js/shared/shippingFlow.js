/*
 * Shipping zones — pure planners (no I/O), so the Shipping page and the rules tests run the exact same code.
 *
 *   validateZoneForm(form, { zones, id, fallbackActive })   → { ok, values, errors, overlap }      errors: { field: code }
 *   planZoneSave({ creating, id, form, zones, actor })      → { ok, id, values, action, ops } | { ok:false, error, errors?, overlap? }
 *   planZoneActive({ id, active, zones, actor })            → { ok, id, action, ops, uncovered } | { ok:false, error, overlap? }
 *   planZoneRemove({ id, zones, actor })                    → { ok, id, ops } | { ok:false, error }
 *   coverage(zones)                                         → { total, covered, uncovered[], byDivision[], owner: Map(district → zone) }
 *   exclusiveDistricts(zones, id)                           → districts that ONLY this active zone covers (what a switch-off would uncover)
 *   overlaps(zones, id, districts)                          → [{ district, zoneId, zoneName }] already held by another ACTIVE zone
 *
 * firestore.rules lets anyone holding `shipping.write` write shippingZones/<id> without looking at its shape — this file is the validator:
 *   name 1–60, unique · districts: known districts, at least one · fee: whole taka 0–5000 · freeOver: empty or whole taka 1–1,000,000
 *   etaMin ≤ etaMax: whole days 0–60 · a district belongs to ONE active zone (checkout picks the zone by district; two active zones would
 *   make the price depend on list order). A switched-off zone may keep any districts.
 * The orders rule re-reads the zone (active, districts, name, fee, freeOver) for every order, so a change made here IS the price list.
 * The zone id is the slug of its first name and never changes (past orders keep the name they were placed under).
 * Every change is one atomic batch: the zone + one audit entry. Only a switched-off zone can be deleted.
 */
import { TS } from './ops.js';
import { DIVISIONS, DISTRICTS, roleCan } from './constants.js';
import { slugify, uniqueSlug } from './slug.js';
import { auditOp } from './orderFlow.js';

export const ZONE_LIMITS = Object.freeze({ nameMax: 60, feeMax: 5000, freeOverMax: 1000000, etaMax: 60 });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const isActive = (z) => !!z && z.active === true;
const whole = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
/** '' / null / undefined → null (empty); a number stays; any other text → Number(text) (NaN when it is not a number) */
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return s === '' ? null : Number(s);
};
const canonical = (list) => { const set = new Set(list); return DISTRICTS.filter((d) => set.has(d)); };
const sameName = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** districts of `districts` that another ACTIVE zone (not `id`) already holds */
export function overlaps(zones, id, districts) {
  const out = [];
  for (const d of districts) {
    const z = zones.find((x) => x.id !== id && isActive(x) && Array.isArray(x.districts) && x.districts.includes(d));
    if (z) out.push({ district: d, zoneId: z.id, zoneName: z.name || z.id });
  }
  return out;
}

export function validateZoneForm(form = {}, { zones = [], id = null, fallbackActive = true } = {}) {
  const errors = {};
  const name = String(form.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) errors.name = 'required';
  else if (name.length > ZONE_LIMITS.nameMax) errors.name = 'too_long';
  else if (zones.some((z) => z.id !== id && sameName(z.name, name))) errors.name = 'name_taken';

  const picked = Array.isArray(form.districts) ? form.districts.map(String) : [];
  if (!picked.length) errors.districts = 'none';
  else if (picked.some((d) => !DISTRICTS.includes(d))) errors.districts = 'bad_district';
  const districts = errors.districts ? [] : canonical(picked);

  const fee = toNum(form.fee);
  if (fee === null) errors.fee = 'required';
  else if (!whole(fee, 0, ZONE_LIMITS.feeMax)) errors.fee = 'bad_fee';
  const freeOver = toNum(form.freeOver);
  if (freeOver !== null && !whole(freeOver, 1, ZONE_LIMITS.freeOverMax)) errors.freeOver = 'bad_free_over';
  const etaMin = toNum(form.etaMin);
  const etaMax = toNum(form.etaMax);
  if (etaMin === null) errors.etaMin = 'required';
  else if (!whole(etaMin, 0, ZONE_LIMITS.etaMax)) errors.etaMin = 'bad_eta';
  if (etaMax === null) errors.etaMax = 'required';
  else if (!whole(etaMax, 0, ZONE_LIMITS.etaMax)) errors.etaMax = 'bad_eta';
  if (!errors.etaMin && !errors.etaMax && etaMin > etaMax) errors.etaMax = 'eta_order';

  const active = typeof form.active === 'boolean' ? form.active : fallbackActive;
  let overlap = [];
  if (active && !errors.districts) {
    overlap = overlaps(zones, id, districts);
    if (overlap.length) errors.districts = 'overlap';
  }
  if (Object.keys(errors).length) return { ok: false, errors, overlap };
  return { ok: true, errors, overlap, values: { name, districts, fee, freeOver, etaMin, etaMax, active } };
}

const brief = (z) => ({
  name: z.name, fee: z.fee, freeOver: z.freeOver ?? null, etaMin: z.etaMin ?? null, etaMax: z.etaMax ?? null,
  active: isActive(z), districts: Array.isArray(z.districts) ? z.districts.length : 0,
});

/** one human sentence for the audit log: what changed between two zones (`after.districts` is an array of names) */
function describeChange(before, after) {
  const bits = [];
  if (before.name !== after.name) bits.push(`renamed from "${before.name}"`);
  if (before.fee !== after.fee) bits.push(`fee ${before.fee} → ${after.fee}`);
  if ((before.freeOver ?? null) !== after.freeOver) bits.push(`free over ${before.freeOver ?? 'none'} → ${after.freeOver ?? 'none'}`);
  if (before.etaMin !== after.etaMin || before.etaMax !== after.etaMax) bits.push(`delivery ${before.etaMin ?? '?'}–${before.etaMax ?? '?'} → ${after.etaMin}–${after.etaMax} days`);
  const was = new Set(before.districts || []);
  const now = new Set(after.districts);
  const added = after.districts.filter((d) => !was.has(d));
  const removed = (before.districts || []).filter((d) => !now.has(d));
  const list = (a) => `${a.slice(0, 4).join(', ')}${a.length > 4 ? ', …' : ''}`;
  if (added.length) bits.push(`+${added.length} district${added.length === 1 ? '' : 's'} (${list(added)})`);
  if (removed.length) bits.push(`−${removed.length} district${removed.length === 1 ? '' : 's'} (${list(removed)})`);
  if (isActive(before) !== after.active) bits.push(after.active ? 'switched on' : 'switched off');
  return bits.join('; ');
}

export function planZoneSave({ creating = false, id = null, form, zones = [], actor }) {
  if (!actor || !roleCan(actor.role, 'shipping.write')) return fail('forbidden');
  const current = creating ? null : zones.find((z) => z.id === id) || null;
  if (!creating && !current) return fail('not_found');
  const v = validateZoneForm(form, { zones, id: creating ? null : id, fallbackActive: creating ? true : isActive(current) });
  if (!v.ok) return fail('invalid', { errors: v.errors, overlap: v.overlap });
  const { values } = v;

  if (creating) {
    const zid = uniqueSlug(slugify(values.name, { max: 40 }) || 'zone', new Set(zones.map((z) => z.id)));
    const sort = zones.reduce((m, z) => Math.max(m, Number(z.sort) || 0), 0) + 1;
    return {
      ok: true, id: zid, values, action: 'shipping.create',
      ops: [
        { op: 'set', path: `shippingZones/${zid}`, data: { ...values, sort, updatedAt: TS } },
        auditOp(actor, {
          action: 'shipping.create', entity: 'shipping_zone', entityId: zid,
          summary: `Zone "${values.name}" created: ${values.districts.length} district${values.districts.length === 1 ? '' : 's'}, fee ${values.fee}`,
          before: null, after: brief(values),
        }),
      ],
    };
  }

  const same = current.name === values.name
    && JSON.stringify(canonical(current.districts || [])) === JSON.stringify(values.districts)
    && current.fee === values.fee && (current.freeOver ?? null) === values.freeOver
    && current.etaMin === values.etaMin && current.etaMax === values.etaMax && isActive(current) === values.active;
  if (same) return fail('no_change');
  const onlyActive = current.name === values.name && current.fee === values.fee && (current.freeOver ?? null) === values.freeOver
    && current.etaMin === values.etaMin && current.etaMax === values.etaMax
    && JSON.stringify(canonical(current.districts || [])) === JSON.stringify(values.districts);
  const action = onlyActive ? (values.active ? 'shipping.activate' : 'shipping.deactivate') : 'shipping.update';
  return {
    ok: true, id, values, action,
    ops: [
      { op: 'update', path: `shippingZones/${id}`, data: { ...values, updatedAt: TS } },
      auditOp(actor, {
        action, entity: 'shipping_zone', entityId: id,
        summary: `Zone "${values.name}": ${describeChange(current, values)}`, before: brief(current), after: brief(values),
      }),
    ],
  };
}

export function planZoneActive({ id, active, zones = [], actor }) {
  if (!actor || !roleCan(actor.role, 'shipping.write')) return fail('forbidden');
  const current = zones.find((z) => z.id === id) || null;
  if (!current) return fail('not_found');
  const want = active === true;
  if (isActive(current) === want) return fail('no_change');
  if (want) {
    const overlap = overlaps(zones, id, current.districts || []);
    if (overlap.length) return fail('overlap', { overlap });
  }
  const action = want ? 'shipping.activate' : 'shipping.deactivate';
  return {
    ok: true, id, action, uncovered: want ? [] : exclusiveDistricts(zones, id),
    ops: [
      { op: 'update', path: `shippingZones/${id}`, data: { active: want, updatedAt: TS } },
      auditOp(actor, {
        action, entity: 'shipping_zone', entityId: id,
        summary: `Zone "${current.name}" ${want ? 'switched on' : 'switched off'}`, before: brief(current), after: { ...brief(current), active: want },
      }),
    ],
  };
}

export function planZoneRemove({ id, zones = [], actor }) {
  if (!actor || !roleCan(actor.role, 'shipping.write')) return fail('forbidden');
  const current = zones.find((z) => z.id === id) || null;
  if (!current) return fail('not_found');
  if (isActive(current)) return fail('not_inactive');
  return {
    ok: true, id,
    ops: [
      { op: 'delete', path: `shippingZones/${id}` },
      auditOp(actor, { action: 'shipping.delete', entity: 'shipping_zone', entityId: id, summary: `Zone "${current.name}" deleted`, before: brief(current), after: null }),
    ],
  };
}

/** Which districts have an active zone. Only `active === true` counts — that is what the orders rule demands. */
export function coverage(zones = []) {
  const owner = new Map();
  for (const z of zones) if (isActive(z)) for (const d of z.districts || []) if (!owner.has(d)) owner.set(d, z);
  const uncovered = DISTRICTS.filter((d) => !owner.has(d));
  return {
    owner, total: DISTRICTS.length, covered: DISTRICTS.length - uncovered.length, uncovered,
    byDivision: Object.entries(DIVISIONS).map(([division, list]) => ({ division, uncovered: list.filter((d) => !owner.has(d)) })).filter((g) => g.uncovered.length),
  };
}

/** districts that only zone `id` covers — switching it off (or deleting it) would leave them without delivery */
export function exclusiveDistricts(zones = [], id) {
  const z = zones.find((x) => x.id === id);
  if (!isActive(z)) return [];
  const rest = coverage(zones.filter((x) => x.id !== id)).owner;
  return canonical((z.districts || []).filter((d) => !rest.has(d)));
}
