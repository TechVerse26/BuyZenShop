/*
 * Staff & roles — pure planners (no I/O), so the Staff page and the rules tests run the exact same code.
 *
 *   validateStaffForm(form, { creating })     → { ok, values, errors }          errors: { field: code }
 *   planStaffSave({ creating, uid, form, current, staff, actor })
 *       → { ok, uid, values, action, ops }  |  { ok:false, error, errors? }
 *   planStaffRemove({ uid, current, staff, actor })   → { ok, ops } | { ok:false, error }
 *   lastActiveSuperAdmin(staff, uid)          → true when `uid` is the only active Super Admin
 *   permissionMatrix()                        → [{ group, perms:[{ id, roles:[roleId…] }] }]  (what each role may do, for the reference table)
 *
 * firestore.rules only requires `staff.manage` (Super Admin) and the shape of staff/<uid>
 * (role, active, email, name, createdAt, updatedAt, createdBy). The safety nets below live here:
 *   - nobody changes their own role or switches themselves off (ask another Super Admin)
 *   - the last active Super Admin can never be demoted, switched off or removed — the panel would lock everybody out
 *   - only a member who is already switched off can be removed; their history stays in the audit log
 * Every change is one atomic batch: the staff document + one audit entry.
 */
import { TS } from './ops.js';
import { ROLES, ROLE_IDS, PERMISSIONS, PERMISSION_IDS, roleCan, PATTERNS } from './constants.js';
import { auditOp } from './orderFlow.js';

/** A Firebase Auth UID is the document id. Typical UIDs are 28 letters/digits; this only guards against typos and path tricks. */
export const STAFF_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/;
export const PERMISSION_GROUPS = Object.freeze(['catalog', 'inventory', 'orders', 'customers', 'marketing', 'content', 'support', 'reports', 'system']);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const spaces = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function validateStaffForm(form = {}, { creating = false } = {}) {
  const errors = {};
  const uid = String(form.uid ?? '').trim();
  const email = String(form.email ?? '').trim().toLowerCase();
  const rawName = String(form.name ?? '').replace(/\s+/g, ' ').trim();
  const role = String(form.role ?? '');
  if (creating) {
    if (!uid) errors.uid = 'required';
    else if (!STAFF_UID_PATTERN.test(uid)) errors.uid = 'bad_uid';
  }
  // an account added by hand in the Firebase console may have no e-mail on its record: only a NEW member needs one
  if (!email) { if (creating) errors.email = 'required'; }
  else if (email.length > 120 || !PATTERNS.email.test(email)) errors.email = 'bad_email';
  if (rawName.length > 80) errors.name = 'too_long';
  if (!ROLE_IDS.includes(role)) errors.role = 'bad_role';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, errors, values: { uid, email, name: spaces(rawName, 80), role, active: typeof form.active === 'boolean' ? form.active : null } };
}

/** true when nobody except `uid` is an active Super Admin */
export const lastActiveSuperAdmin = (staff, uid) => !staff.some((s) => s.id !== uid && s.role === 'super_admin' && s.active === true);

const brief = (s) => ({ role: s.role, active: s.active === true, email: s.email || '' });
const roleName = (id) => (ROLES[id] ? ROLES[id].label : id);

export function planStaffSave({ creating = false, uid, form, current = null, staff = [], actor }) {
  if (!actor || !roleCan(actor.role, 'staff.manage')) return fail('forbidden');
  const v = validateStaffForm({ ...form, uid: creating ? form && form.uid : uid }, { creating });
  if (!v.ok) return fail('invalid', { errors: v.errors });
  const { values } = v;

  if (creating) {
    if (current || staff.some((s) => s.id === values.uid)) return fail('exists', { errors: { uid: 'exists' } });
    const data = { role: values.role, active: true, email: values.email, name: values.name, createdAt: TS, updatedAt: TS, createdBy: actor.uid };
    return {
      ok: true, uid: values.uid, values, action: 'staff.create',
      ops: [
        { op: 'set', path: `staff/${values.uid}`, data },
        auditOp(actor, {
          action: 'staff.create', entity: 'staff', entityId: values.uid,
          summary: `Added ${values.email} as ${roleName(values.role)}`, before: null, after: { role: values.role, active: true, email: values.email },
        }),
      ],
    };
  }

  if (!current) return fail('not_found');
  const active = values.active === null ? current.active === true : values.active;
  if (uid === actor.uid && (values.role !== current.role || active !== (current.active === true))) return fail('self_change');
  const wasSuper = current.role === 'super_admin' && current.active === true;
  const stillSuper = values.role === 'super_admin' && active;
  if (wasSuper && !stillSuper && lastActiveSuperAdmin(staff, uid)) return fail('last_super_admin');
  const roleChanged = values.role !== current.role;
  const activeChanged = active !== (current.active === true);
  if (!roleChanged && !activeChanged && values.email === (current.email || '') && values.name === (current.name || '')) return fail('no_change');

  const action = roleChanged ? 'staff.role' : activeChanged ? (active ? 'staff.activate' : 'staff.deactivate') : 'staff.update';
  const who = values.email || current.email || uid;
  const summary = roleChanged ? `${who}: ${roleName(current.role)} → ${roleName(values.role)}${activeChanged ? (active ? ' (switched on)' : ' (switched off)') : ''}`
    : activeChanged ? `${who} ${active ? 'switched on' : 'switched off'}` : `${who}: details updated`;
  return {
    ok: true, uid, values: { ...values, active }, action,
    ops: [
      { op: 'update', path: `staff/${uid}`, data: { role: values.role, active, email: values.email, name: values.name, updatedAt: TS } },
      auditOp(actor, { action, entity: 'staff', entityId: uid, summary, before: brief(current), after: { role: values.role, active, email: values.email } }),
    ],
  };
}

export function planStaffRemove({ uid, current = null, staff = [], actor }) {
  if (!actor || !roleCan(actor.role, 'staff.manage')) return fail('forbidden');
  if (!current) return fail('not_found');
  if (uid === actor.uid) return fail('self_change');
  if (current.active === true) return fail('not_inactive');
  if (current.role === 'super_admin' && current.active === true && lastActiveSuperAdmin(staff, uid)) return fail('last_super_admin');
  return {
    ok: true, uid,
    ops: [
      { op: 'delete', path: `staff/${uid}` },
      auditOp(actor, {
        action: 'staff.remove', entity: 'staff', entityId: uid,
        summary: `${current.email || uid} removed from staff (was ${roleName(current.role)})`, before: brief(current), after: null,
      }),
    ],
  };
}

/** Which roles hold which permission, grouped for the reference table. Super Admin holds everything. */
export function permissionMatrix() {
  return PERMISSION_GROUPS.map((group) => ({
    group,
    perms: PERMISSION_IDS.filter((id) => PERMISSIONS[id].group === group).map((id) => ({ id, roles: ROLE_IDS.filter((r) => roleCan(r, id)) })),
  })).filter((g) => g.perms.length);
}
