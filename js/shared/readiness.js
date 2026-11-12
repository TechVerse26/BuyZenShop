/*
 * Store readiness — a checklist computed from a plain snapshot of the database (pure; the Setup page gathers the snapshot).
 *
 *   evaluateReadiness(snapshot) → [{ id, status: 'ok' | 'warn' | 'bad' | 'skip', params, fix }]
 *
 *   snapshot = {
 *     settings:    settings/public document | null (missing)
 *     private:     settings/private document | null (missing) | undefined (this role may not read it)
 *     home:        content/home document | null
 *     zones:       shippingZones documents                       | undefined
 *     categories:  categories documents                          | undefined
 *     products:    products documents (raw)                      | undefined
 *     inventoryIds: ids of the inventory documents               | undefined
 *     staff:       staff documents                               | undefined
 *   }
 *
 * `undefined` means "this role cannot read it": the check is 'skip', never a false 'ok'. `fix` names the page that repairs a problem
 * ('migrate' | 'settings' | 'shipping' | 'categories' | 'products' | 'staff' | null) so the screen can link to it.
 */
import { DISTRICTS, PATTERNS } from './constants.js';
import { isLegacyProduct } from './productModel.js';
import { lineKey } from './id.js';

const make = (id, status, params = {}, fix = null) => ({ id, status, params, fix });
const skip = (id) => make(id, 'skip');
const arr = (v) => (Array.isArray(v) ? v : []);

export function evaluateReadiness(s = {}) {
  const checks = [];
  const pub = s.settings || null;

  /* settings */
  checks.push(pub ? make('settings', 'ok') : make('settings', 'bad', {}, 'migrate'));

  /* contact details the storefront shows */
  if (pub) {
    const c = pub.contact || {};
    const has = [c.whatsapp, c.phone, c.email].filter((v) => String(v || '').trim()).length;
    checks.push(has ? make('contact', 'ok', { n: has }) : make('contact', 'warn', {}, 'settings'));
  }

  /* payments */
  if (pub) {
    const p = pub.payments || {};
    const enabled = ['cod', 'bkash', 'nagad'].filter((m) => p[m] && p[m].enabled === true);
    const noNumber = ['bkash', 'nagad'].filter((m) => p[m] && p[m].enabled === true && !PATTERNS.bdPhone.test(String(p[m].number || '').replace(/[^0-9]/g, '')));
    if (!enabled.length) checks.push(make('payments', 'bad', { reason: 'none' }, 'settings'));
    else if (noNumber.length) checks.push(make('payments', 'bad', { reason: 'number', methods: noNumber.join(', ') }, 'settings'));
    else checks.push(make('payments', 'ok', { n: enabled.length }));
  }

  /* shipping */
  if (s.zones === undefined) checks.push(skip('shipping'));
  else {
    const active = s.zones.filter((z) => z.active !== false);
    if (!active.length) checks.push(make('shipping', 'bad', {}, 'shipping'));
    else {
      const covered = new Set(active.flatMap((z) => arr(z.districts)));
      const uncovered = DISTRICTS.filter((d) => !covered.has(d)).length;
      checks.push(uncovered ? make('shipping', 'warn', { zones: active.length, uncovered }, 'shipping') : make('shipping', 'ok', { zones: active.length }));
    }
  }

  /* categories */
  if (s.categories === undefined) checks.push(skip('categories'));
  else {
    const visible = s.categories.filter((c) => c.visible !== false).length;
    checks.push(visible ? make('categories', 'ok', { n: visible }) : make('categories', 'warn', {}, 'categories'));
  }

  /* products and their inventory records */
  if (s.products === undefined) {
    checks.push(skip('products'));
    checks.push(skip('inventory'));
  } else {
    const legacy = s.products.filter(isLegacyProduct);
    const current = s.products.filter((p) => !isLegacyProduct(p));
    const published = current.filter((p) => p.status === 'published').length;
    if (legacy.length) checks.push(make('products', 'bad', { legacy: legacy.length, total: s.products.length }, 'migrate'));
    else if (!published) checks.push(make('products', 'warn', {}, 'products'));
    else checks.push(make('products', 'ok', { published, total: s.products.length }));

    if (s.inventoryIds === undefined) checks.push(skip('inventory'));
    else {
      const have = new Set(s.inventoryIds);
      let missingSimple = 0; let missingVariants = 0;
      for (const p of current) {
        if (p.type === 'variable' && arr(p.variants).length) {
          for (const v of arr(p.variants)) if (v.active !== false && !have.has(lineKey(p.id, v.id))) missingVariants += 1;
        } else if (!have.has(p.id)) missingSimple += 1;
      }
      const missing = missingSimple + missingVariants;
      checks.push(missing ? make('inventory', 'bad', { missing }, missingSimple ? 'migrate' : 'products') : make('inventory', 'ok'));
    }
  }

  /* homepage layout */
  checks.push(s.home && arr(s.home.sections).length ? make('home', 'ok') : make('home', 'warn', {}, 'migrate'));

  /* invoices (private settings) */
  if (s.private === undefined) checks.push(skip('invoice'));
  else {
    const inv = (s.private && s.private.invoice) || {};
    checks.push(String(inv.address || '').trim() && String(inv.businessName || '').trim() ? make('invoice', 'ok') : make('invoice', 'warn', {}, 'settings'));
  }

  /* staff */
  if (s.staff === undefined) checks.push(skip('staff'));
  else {
    const supers = s.staff.filter((m) => m.role === 'super_admin' && m.active === true).length;
    if (!supers) checks.push(make('staff', 'bad', {}, 'staff'));
    else if (supers === 1) checks.push(make('staff', 'warn', { n: s.staff.filter((m) => m.active === true).length }, 'staff'));
    else checks.push(make('staff', 'ok', { supers }));
  }
  return checks;
}

/** { ok, warn, bad, skip, total } — "3 of 8 checks passed" */
export function summarize(checks) {
  const out = { ok: 0, warn: 0, bad: 0, skip: 0, total: checks.length };
  for (const c of checks) out[c.status] += 1;
  return out;
}
