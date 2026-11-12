/*
 * Public store configuration: settings/public (name, contact, payment numbers, announcement …),
 * shipping zones, homepage layout and CMS pages. Cached briefly so repeat visits paint instantly.
 *
 *   settings()                 → merged settings (defaults until the first load completes)
 *   await loadSettings()       → fetch + cache, applies number-format options, notifies onSettings listeners
 *   await loadZones()          → active shipping zones [{id, name, districts, fee, freeOver, etaMin, etaMax}]
 *   await loadHome()           → { sections: [...] }
 *   await loadPage(slug)       → CMS page | null
 */
import { getDocData, getDocDataSafe, listDocs, serializeDoc } from './db.js';
import { defaultSettingsPublic } from '../shared/migration.js';
import { normalizeHome } from '../shared/contentModel.js';
import { setFormatOptions } from '../core/format.js';
import { local } from '../core/storage.js';
import { reportError } from '../core/errors.js';

const KEY_SETTINGS = 'sv.settings.v2';
const KEY_ZONES = 'sv.zones.v2';
const TTL = 5 * 60 * 1000;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.toMillis !== 'function';
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function defaults() {
  const d = defaultSettingsPublic();
  delete d.createdAt; delete d.updatedAt;
  return d;
}

let current = (() => {
  const cached = local.get(KEY_SETTINGS);
  return deepMerge(defaults(), cached && cached.data ? cached.data : {});
})();
const listeners = new Set();
let inflight = null;
let loadedAt = 0;

export const settings = () => current;
export function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function applySettings(data) {
  current = deepMerge(defaults(), data || {});
  setFormatOptions({ banglaDigits: current.ui?.banglaDigits === true });
  listeners.forEach((fn) => { try { fn(current); } catch (e) { console.error(e); } });
  return current;
}
setFormatOptions({ banglaDigits: current.ui?.banglaDigits === true });

export async function loadSettings({ force = false } = {}) {
  if (!force && Date.now() - loadedAt < TTL && loadedAt) return current;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const doc = await getDocData('settings/public');
      const { id, ...data } = doc || {};
      local.set(KEY_SETTINGS, { savedAt: Date.now(), data: serializeDoc(data) });
      loadedAt = Date.now();
      return applySettings(data);
    } catch (e) { reportError(e, 'settings.load'); return current; } finally { inflight = null; }
  })();
  return inflight;
}

/** Payment methods the customer can currently choose (cod/bkash/nagad), per settings. */
export function enabledPayments() {
  const p = current.payments || {};
  return ['cod', 'bkash', 'nagad'].filter((m) => p[m] && p[m].enabled !== false);
}

/* ───────────────────────── shipping zones ───────────────────────── */

let zonesMem = null;
export async function loadZones({ force = false } = {}) {
  if (!force && zonesMem && Date.now() - zonesMem.at < TTL) return zonesMem.list;
  const cached = !force ? local.get(KEY_ZONES) : null;
  if (cached && Date.now() - cached.savedAt < TTL) { zonesMem = { at: cached.savedAt, list: cached.list }; return cached.list; }
  try {
    const { docs } = await listDocs('shippingZones');
    const list = docs.map((z) => ({ ...serializeDoc(z) })).filter((z) => z.active !== false)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    zonesMem = { at: Date.now(), list };
    local.set(KEY_ZONES, { savedAt: Date.now(), list });
    return list;
  } catch (e) { reportError(e, 'zones.load'); return zonesMem ? zonesMem.list : (cached ? cached.list : []); }
}
export const clearZonesCache = () => { zonesMem = null; local.remove(KEY_ZONES); };

/* ───────────────────────── homepage layout & pages ───────────────────────── */

/** Homepage layout, always sanitised (see shared/contentModel.js). Missing / broken document → defaults. */
export async function loadHome() {
  try {
    const d = await getDocDataSafe('content/home');
    return normalizeHome(d ? serializeDoc(d) : null);
  } catch (e) { reportError(e, 'home.load'); }
  return normalizeHome(null);
}

export async function loadPage(slug) {
  try { const d = await getDocDataSafe(`pages/${slug}`); return d ? serializeDoc(d) : null; } catch (e) { reportError(e, 'page.load'); return null; }
}
export async function loadPageList() {
  try {
    const { docs } = await listDocs('pages', { where: [['visible', '==', true]] });
    return docs.map(serializeDoc).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  } catch (e) { reportError(e, 'pages.list'); return []; }
}
