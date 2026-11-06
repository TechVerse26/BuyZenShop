/*
 * Store settings — pure planner (no I/O), so the Settings page and the rules tests run the exact same code.
 *
 *   settingsToForm(pub, priv)                 → flat form values (what the page shows)
 *   validateSettingsForm(form)                → { ok, errors: { field: code }, pub, priv }   pub / priv are the nested documents to merge
 *   planSettingsSave({ form, current: { pub, priv }, actor, nowMs })
 *       → { ok, ops, changed: [dotted paths] }  |  { ok:false, error, errors? }
 *
 * settings/public is read by every visitor (storefront name, contact, payment numbers, announcement …), settings/private only by staff
 * (low-stock threshold, notification e-mails, invoice details). Both are written with a deep merge, so a field this page does not
 * know about is never lost. One batch: the documents + one audit entry that names every changed field with its old and new value —
 * a changed payment number is the first thing to look for when money goes missing. (The e-mail list is audited as "changed" only.)
 */
import { TS } from './ops.js';
import { roleCan, PATTERNS } from './constants.js';
import { normalizePhone } from './id.js';
import { auditOp } from './orderFlow.js';

export const SETTINGS_LIMITS = Object.freeze({
  storeName: 60, tagline: 120, address: 200, email: 120, url: 300, walletNote: 120, announcement: 160,
  seoTitle: 70, seoDescription: 200, invoiceName: 80, invoiceAddress: 200, invoicePhone: 40, invoiceNote: 200,
  notifyEmails: 5, returnWindowMax: 60, lowStockMax: 1000,
});
export const ACCOUNT_TYPES = Object.freeze(['Personal', 'Agent', 'Merchant']);
export const WALLETS = Object.freeze(['bkash', 'nagad']);
const ID_RE = /^[A-Za-z0-9]{6,40}$/;
const PREFIX_RE = /^[A-Z0-9]{2,6}$/;
const HTTPS_RE = /^https:\/\/[^\s/$.?#][^\s]*$/i;
const PATH_RE = /^\/(?!\/)[^\s]*$/;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const at = (o, path, d = '') => { let v = o; for (const k of path.split('.')) { if (v === null || v === undefined || typeof v !== 'object') return d; v = v[k]; } return v === undefined || v === null ? d : v; };
const put = (o, path, value) => { const keys = path.split('.'); let v = o; keys.slice(0, -1).forEach((k) => { v = v[k] = v[k] || {}; }); v[keys[keys.length - 1]] = value; };

/** stored WhatsApp number is international (8801…); staff think in local numbers (01…) */
const localPhone = (stored) => normalizePhone(stored) || String(stored || '');

export function settingsToForm(pub = {}, priv = {}) {
  const f = {
    storeName: at(pub, 'storeName'), tagline: at(pub, 'tagline'), logoUrl: at(pub, 'logoUrl'), orderPrefix: at(pub, 'orderPrefix', 'SV'),
    contact_whatsapp: localPhone(at(pub, 'contact.whatsapp')), contact_phone: localPhone(at(pub, 'contact.phone')), contact_email: at(pub, 'contact.email'), contact_address: at(pub, 'contact.address'),
    social_facebook: at(pub, 'social.facebook'), social_instagram: at(pub, 'social.instagram'), social_youtube: at(pub, 'social.youtube'), social_tiktok: at(pub, 'social.tiktok'),
    pay_cod_enabled: at(pub, 'payments.cod.enabled', true) === true,
    returnWindowDays: Number(at(pub, 'checkout.returnWindowDays', 7)),
    ann_enabled: at(pub, 'announcement.enabled', false) === true, ann_text: at(pub, 'announcement.text'), ann_link: at(pub, 'announcement.link'),
    seo_title: at(pub, 'seo.title'), seo_description: at(pub, 'seo.description'),
    ui_banglaDigits: at(pub, 'ui.banglaDigits', false) === true,
    tawk_enabled: at(pub, 'integrations.tawk.enabled', false) === true, tawk_propertyId: at(pub, 'integrations.tawk.propertyId'), tawk_widgetId: at(pub, 'integrations.tawk.widgetId'),
    lowStockThreshold: Number(at(priv, 'lowStockThreshold', 5)),
    notifyEmails: (Array.isArray(priv.notifyEmails) ? priv.notifyEmails : []).join('\n'),
    inv_businessName: at(priv, 'invoice.businessName'), inv_address: at(priv, 'invoice.address'), inv_phone: at(priv, 'invoice.phone'), inv_note: at(priv, 'invoice.note'),
  };
  for (const w of WALLETS) {
    f[`pay_${w}_enabled`] = at(pub, `payments.${w}.enabled`, false) === true;
    f[`pay_${w}_number`] = localPhone(at(pub, `payments.${w}.number`));
    f[`pay_${w}_type`] = ACCOUNT_TYPES.includes(at(pub, `payments.${w}.accountType`)) ? at(pub, `payments.${w}.accountType`) : 'Personal';
    f[`pay_${w}_note`] = at(pub, `payments.${w}.note`);
  }
  return f;
}

export function validateSettingsForm(form = {}) {
  const errors = {};
  const text = (name, max, { required = false } = {}) => {
    const v = String(form[name] ?? '').replace(/\s+/g, ' ').trim();
    if (!v && required) errors[name] = 'required';
    else if (v.length > max) errors[name] = 'too_long';
    return v;
  };
  const link = (name, { path = false } = {}) => {
    const v = text(name, SETTINGS_LIMITS.url);
    if (v && !errors[name] && !HTTPS_RE.test(v) && !(path && PATH_RE.test(v))) errors[name] = 'bad_url';
    return v;
  };
  const bool = (name) => form[name] === true;
  const pub = {}; const priv = {};

  put(pub, 'storeName', text('storeName', SETTINGS_LIMITS.storeName, { required: true }));
  put(pub, 'tagline', text('tagline', SETTINGS_LIMITS.tagline));
  put(pub, 'logoUrl', link('logoUrl', { path: true }));
  const prefix = String(form.orderPrefix ?? '').trim().toUpperCase();
  if (!PREFIX_RE.test(prefix)) errors.orderPrefix = 'bad_prefix';
  put(pub, 'orderPrefix', prefix);

  /* contact */
  const wa = String(form.contact_whatsapp ?? '').trim();
  const waLocal = wa ? normalizePhone(wa) : '';
  if (wa && !waLocal) errors.contact_whatsapp = 'bad_phone';
  put(pub, 'contact.whatsapp', waLocal ? `88${waLocal}` : '');
  const ph = String(form.contact_phone ?? '').trim();
  const phLocal = ph ? normalizePhone(ph) : '';
  if (ph && !phLocal) errors.contact_phone = 'bad_phone';
  put(pub, 'contact.phone', phLocal);
  const email = String(form.contact_email ?? '').trim().toLowerCase();
  if (email && (email.length > SETTINGS_LIMITS.email || !PATTERNS.email.test(email))) errors.contact_email = 'bad_email';
  put(pub, 'contact.email', email);
  put(pub, 'contact.address', text('contact_address', SETTINGS_LIMITS.address));
  for (const k of ['facebook', 'instagram', 'youtube', 'tiktok']) put(pub, `social.${k}`, link(`social_${k}`));

  /* payments */
  put(pub, 'payments.cod.enabled', bool('pay_cod_enabled'));
  for (const w of WALLETS) {
    const enabled = bool(`pay_${w}_enabled`);
    const raw = String(form[`pay_${w}_number`] ?? '').trim();
    const local = raw ? normalizePhone(raw) : '';
    if (enabled && !raw) errors[`pay_${w}_number`] = 'required';
    else if (raw && !local) errors[`pay_${w}_number`] = 'bad_phone';
    put(pub, `payments.${w}.enabled`, enabled);
    put(pub, `payments.${w}.number`, local);
    put(pub, `payments.${w}.accountType`, ACCOUNT_TYPES.includes(form[`pay_${w}_type`]) ? form[`pay_${w}_type`] : 'Personal');
    put(pub, `payments.${w}.note`, text(`pay_${w}_note`, SETTINGS_LIMITS.walletNote));
  }
  if (!bool('pay_cod_enabled') && !bool('pay_bkash_enabled') && !bool('pay_nagad_enabled')) errors.pay_cod_enabled = 'none_enabled';

  /* checkout, announcement, seo, display */
  const days = Number(form.returnWindowDays);
  if (!Number.isInteger(days) || days < 0 || days > SETTINGS_LIMITS.returnWindowMax) errors.returnWindowDays = 'range';
  put(pub, 'checkout.returnWindowDays', Number.isInteger(days) ? days : 7);
  const annOn = bool('ann_enabled');
  put(pub, 'announcement.enabled', annOn);
  put(pub, 'announcement.text', text('ann_text', SETTINGS_LIMITS.announcement, { required: annOn }));
  put(pub, 'announcement.link', link('ann_link', { path: true }));
  put(pub, 'seo.title', text('seo_title', SETTINGS_LIMITS.seoTitle));
  put(pub, 'seo.description', text('seo_description', SETTINGS_LIMITS.seoDescription));
  put(pub, 'ui.banglaDigits', bool('ui_banglaDigits'));

  /* live chat: the ids end up in a script address, so they must be plain letters and digits */
  const tOn = bool('tawk_enabled');
  const pid = String(form.tawk_propertyId ?? '').trim();
  const wid = String(form.tawk_widgetId ?? '').trim();
  if (tOn && !pid) errors.tawk_propertyId = 'required'; else if (pid && !ID_RE.test(pid)) errors.tawk_propertyId = 'bad_id';
  if (tOn && !wid) errors.tawk_widgetId = 'required'; else if (wid && !ID_RE.test(wid)) errors.tawk_widgetId = 'bad_id';
  put(pub, 'integrations.tawk.enabled', tOn);
  put(pub, 'integrations.tawk.propertyId', pid);
  put(pub, 'integrations.tawk.widgetId', wid);

  /* private */
  const low = Number(form.lowStockThreshold);
  if (!Number.isInteger(low) || low < 0 || low > SETTINGS_LIMITS.lowStockMax) errors.lowStockThreshold = 'range';
  priv.lowStockThreshold = Number.isInteger(low) ? low : 5;
  const emails = [...new Set(String(form.notifyEmails ?? '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length > SETTINGS_LIMITS.notifyEmails) errors.notifyEmails = 'too_many';
  else if (emails.some((e) => e.length > SETTINGS_LIMITS.email || !PATTERNS.email.test(e))) errors.notifyEmails = 'bad_email';
  priv.notifyEmails = emails;
  priv.invoice = {
    businessName: text('inv_businessName', SETTINGS_LIMITS.invoiceName), address: text('inv_address', SETTINGS_LIMITS.invoiceAddress),
    phone: text('inv_phone', SETTINGS_LIMITS.invoicePhone), note: text('inv_note', SETTINGS_LIMITS.invoiceNote),
  };

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, errors, pub, priv };
}

/** { 'payments.bkash.number': value, … } — arrays are leaves */
function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.toMillis !== 'function') flatten(v, p, out); else out[p] = v;
  }
  return out;
}
/** "not stored yet" and "stored as empty / off" mean the same thing: saving an untouched form must not look like a change */
const blank = (v) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
const differs = (a, b) => !(blank(a) && blank(b)) && JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

export function planSettingsSave({ form, current = {}, actor, nowMs }) {
  if (!actor || !roleCan(actor.role, 'settings.write')) return fail('forbidden');
  const v = validateSettingsForm(form);
  if (!v.ok) return fail('invalid', { errors: v.errors });

  const was = { pub: flatten(current.pub), priv: flatten(current.priv) };
  const changes = [];
  for (const [kind, doc] of [['pub', v.pub], ['priv', v.priv]]) {
    for (const [path, value] of Object.entries(flatten(doc))) {
      const old = was[kind][path];
      if (differs(old, value)) changes.push({ kind, path, old, value });
    }
  }
  if (!changes.length) return fail('no_change');

  const ops = [];
  const pubChanged = changes.some((c) => c.kind === 'pub');
  const privChanged = changes.some((c) => c.kind === 'priv');
  if (pubChanged) ops.push({ op: 'set', path: 'settings/public', merge: true, data: { ...v.pub, ...(current.pub ? {} : { createdAt: TS }), updatedAt: TS } });
  if (privChanged) ops.push({ op: 'set', path: 'settings/private', merge: true, data: { ...v.priv, ...(current.priv ? {} : { createdAt: TS }), updatedAt: TS } });

  const named = changes.filter((c) => c.path !== 'notifyEmails');
  const before = {}; const after = {};
  for (const c of named.slice(0, 40)) { before[c.path.replace(/\./g, '/')] = c.old ?? null; after[c.path.replace(/\./g, '/')] = c.value; }
  if (changes.some((c) => c.path === 'notifyEmails')) { before['notifyEmails'] = 'changed'; after['notifyEmails'] = 'changed'; }
  const paths = changes.map((c) => c.path);
  ops.push(auditOp(actor, {
    action: 'settings.update', entity: 'settings', entityId: pubChanged ? 'public' : 'private',
    summary: `Settings changed: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ` (+${paths.length - 12} more)` : ''}`.slice(0, 590),
    before, after,
  }));
  return { ok: true, ops, changed: paths };
}
