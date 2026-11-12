/*
 * Small helpers shared by the order pages (list, detail, customer profile).
 *
 *   customerLabel(o) / customerPhone(o) / methodLabel(id)
 *   orderMatches(o, 'rahim 0171')           every word must appear somewhere in the order's searchable text
 *   ORDER_CSV_HEADERS + orderCsvRow(o, { mask })    one CSV row per order (formula-injection safe through shared/csv.toCsv)
 *   await loadBusiness()                    seller block for invoices / labels (public settings + settings/private when readable)
 *   piiVisible()                            false for roles that may read orders but not customers (they see masked phone / e-mail)
 */
import { lbl } from '../../core/i18n.js';
import { toDhakaInput, maskPhone, maskEmail } from '../../core/format.js';
import { businessFrom } from '../../core/print.js';
import { getDocDataSafe } from '../../data/db.js';
import { settings } from '../../data/settings.js';
import { can } from '../../data/auth.js';
import { PAYMENT_METHODS, PAYMENT_STATUS, ORDER_STATUS } from '../../shared/constants.js';

export const customerLabel = (o) => (o.customer && o.customer.name) || (o.address && o.address.name) || '—';
export const customerPhone = (o) => (o.customer && o.customer.phone) || (o.address && o.address.phone) || '';
export const methodLabel = (m) => (PAYMENT_METHODS[m] ? lbl(PAYMENT_METHODS[m]) : String(m || ''));

/** Roles without customers.read (Reporting) still see orders, but with masked contact details. This is a UI choice, not a rules boundary. */
export const piiVisible = () => can('customers.read');
export const showPhone = (p) => (piiVisible() ? p : maskPhone(p));
export const showEmail = (e) => (piiVisible() ? e : maskEmail(e));

export function orderMatches(o, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  const a = o.address || {};
  const c = o.customer || {};
  const hay = [o.orderNumber, o.id, c.name, c.phone, c.email, a.name, a.phone, a.district, o.payment && o.payment.trxId, o.payment && o.payment.senderNumber, o.couponCode].join(' ').toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}

export const ORDER_CSV_HEADERS = ['Order', 'Date (Dhaka)', 'Status', 'Customer', 'Phone', 'Email', 'District', 'Address', 'Items', 'Products', 'Subtotal', 'Discount', 'Shipping', 'Total', 'Coupon', 'Payment method', 'Payment status', 'TrxID', 'Courier', 'Tracking no.'];

export function orderCsvRow(o, { mask = false } = {}) {
  const a = o.address || {};
  const p = o.payment || {};
  const t = o.totals || {};
  const phone = customerPhone(o);
  const email = (o.customer && o.customer.email) || '';
  return [
    o.orderNumber,
    o.createdAtMs ? toDhakaInput(o.createdAtMs).replace('T', ' ') : '',
    (ORDER_STATUS[o.status] || {}).label || o.status,
    customerLabel(o),
    mask ? maskPhone(phone) : phone,
    mask ? maskEmail(email) : email,
    a.district || '',
    mask ? '' : [a.line1, a.area, a.upazila].filter(Boolean).join(', '),
    o.items.reduce((s, l) => s + l.qty, 0),
    o.items.map((l) => `${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ''} × ${l.qty}`).join('; '),
    t.subtotal, t.discount, t.shipping, t.total,
    o.couponCode || '',
    (PAYMENT_METHODS[p.method] || {}).label || p.method || '',
    (PAYMENT_STATUS[p.status] || {}).label || p.status || '',
    p.trxId || '',
    (o.shipping && o.shipping.carrier) || '',
    (o.shipping && o.shipping.trackingNo) || '',
  ];
}

let businessCache = null;
/** Seller block for printed documents. settings/private is optional (staff without settings.read still get the public data). */
export async function loadBusiness() {
  if (!businessCache) {
    const priv = can('settings.read') ? await getDocDataSafe('settings/private').catch(() => null) : null;
    businessCache = { priv, at: Date.now() };
  }
  return businessFrom(settings(), businessCache.priv);
}
