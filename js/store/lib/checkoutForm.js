/*
 * Checkout form logic — pure (no DOM, no Firebase), unit-tested in tests/unit/checkout-form.test.mjs.
 *
 *   normalizeForm(raw)                       → clean copy of every field (trimmed, phone/TrxID normalised)
 *   validateForm(form, { methods })          → { field: code }   ({} = valid)   codes are mapped to text by the page
 *   toOrderInput(form, { email })            → { customer, address, payment, note } for data/orders.placeOrder
 *   addressFromForm(form) / formFromAddress(address, base)
 *
 * The server side (shared/orderBuilder.js + firestore.rules) re-validates everything; this only gives early, specific feedback.
 */
import { normalizePhone, normalizeTrxId } from '../../shared/id.js';
import { PATTERNS, DISTRICTS } from '../../shared/constants.js';

export const METHODS = Object.freeze(['cod', 'bkash', 'nagad']);
export const isMobileMethod = (m) => m === 'bkash' || m === 'nagad';

const clip = (v, n) => String(v ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, n);

export function emptyForm(over = {}) {
  return {
    name: '', phone: '', email: '', district: '', upazila: '', area: '', postalCode: '', line1: '',
    note: '', method: '', trxId: '', senderNumber: '', saveAddress: true, ...over,
  };
}

export function normalizeForm(raw = {}) {
  const f = { ...emptyForm(), ...raw };
  return {
    name: clip(f.name, 80),
    phone: normalizePhone(f.phone) || clip(f.phone, 20),
    email: clip(f.email, 120).toLowerCase(),
    district: clip(f.district, 40),
    upazila: clip(f.upazila, 60),
    area: clip(f.area, 80),
    postalCode: clip(f.postalCode, 10),
    line1: String(f.line1 ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, 300),
    note: String(f.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    method: METHODS.includes(f.method) ? f.method : '',
    trxId: normalizeTrxId(f.trxId).slice(0, 20),
    senderNumber: normalizePhone(f.senderNumber) || clip(f.senderNumber, 20),
    saveAddress: f.saveAddress !== false,
  };
}

/** @returns {Object<string,string>} field → error code (name | phone | email | district | line1 | method | trx | sender) */
export function validateForm(raw, { methods = METHODS } = {}) {
  const f = normalizeForm(raw);
  const e = {};
  if (f.name.length < 2) e.name = 'name';
  if (!PATTERNS.bdPhone.test(f.phone)) e.phone = 'phone';
  if (f.email && !PATTERNS.email.test(f.email)) e.email = 'email';
  if (!DISTRICTS.includes(f.district)) e.district = 'district';
  if (f.line1.length < 5) e.line1 = 'line1';
  if (!f.method || !methods.includes(f.method)) e.method = 'method';
  else if (isMobileMethod(f.method)) {
    if (!PATTERNS.trxId.test(f.trxId)) e.trxId = 'trx';
    if (!PATTERNS.bdPhone.test(f.senderNumber)) e.senderNumber = 'sender';
  }
  return e;
}

export function addressFromForm(raw) {
  const f = normalizeForm(raw);
  return { name: f.name, phone: f.phone, district: f.district, upazila: f.upazila, area: f.area, postalCode: f.postalCode, line1: f.line1, notes: '' };
}

/** Saved address (data/account.js shape) → form fields. */
export function formFromAddress(a = {}, base = emptyForm()) {
  return { ...base, name: a.name || base.name, phone: a.phone || base.phone, district: a.district || '', upazila: a.upazila || '', area: a.area || '', postalCode: a.postalCode || '', line1: a.line1 || '' };
}

export function toOrderInput(raw, { email = '' } = {}) {
  const f = normalizeForm(raw);
  const payment = isMobileMethod(f.method) ? { method: f.method, trxId: f.trxId, senderNumber: f.senderNumber } : { method: f.method };
  return {
    customer: { name: f.name, phone: f.phone, email: f.email || String(email || '').toLowerCase() },
    address: addressFromForm(f),
    payment,
    note: f.note,
  };
}
