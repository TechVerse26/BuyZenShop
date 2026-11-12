/*
 * Small pieces shared by the customer pages (list, profile).
 *
 *   customerName(c)                    the name, else the e-mail, else "No name"
 *   customerStatus(c, {quiet})         a red "Restricted" badge, or a green "Active" one (quiet: plain muted text, for table rows)
 *   sourceLabel(source)                where a newsletter subscriber signed up ("home", "footer", anything else as written)
 *   customersCsv(list) / subscribersCsv(list)    → { headers, rows } for exportCsv — times in Bangladesh time, formula-injection safe through shared/csv.toCsv
 *
 * Strings that BOTH pages use are registered here (a key registered only by one page shows as a raw key on the other).
 */
import { html } from '../../core/dom.js';
import { registerBoth, t, has } from '../../core/i18n.js';
import { badge } from '../../core/ui.js';
import { toDhakaInput } from '../../core/format.js';

registerBoth({
  'cus.restricted': ['Restricted', 'সীমাবদ্ধ'],
  'cus.active': ['Active', 'সক্রিয়'],
  'cus.noName': ['No name', 'নাম নেই'],
  'cus.src.home': ['Home page', 'হোম পেজ'],
  'cus.src.footer': ['Website footer', 'ওয়েবসাইটের ফুটার'],
});

export const customerName = (c) => c.name || c.email || t('cus.noName');
export const customerStatus = (c, { quiet = false } = {}) => (c.restricted ? badge(t('cus.restricted'), 'bad') : quiet ? html`<span class="muted">${t('cus.active')}</span>` : badge(t('cus.active'), 'ok'));
export const sourceLabel = (s) => (s && has(`cus.src.${s}`) ? t(`cus.src.${s}`) : (s || '—'));

const when = (ms) => (ms ? toDhakaInput(ms).replace('T', ' ') : '');

export const customersCsv = (list) => ({
  headers: ['Name', 'E-mail', 'Phone', 'Joined (Dhaka)', 'Last order (Dhaka)', 'Status', 'Restriction reason', 'Customer ID'],
  rows: list.map((c) => [c.name, c.email, c.phone, when(c.joinedMs), when(c.lastOrderMs), c.restricted ? 'Restricted' : 'Active', c.restrictedReason, c.id]),
});

export const subscribersCsv = (list) => ({
  headers: ['E-mail', 'Source', 'Subscribed (Dhaka)'],
  rows: list.map((s) => [s.email, s.source, when(s.createdMs)]),
});
