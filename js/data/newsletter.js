/*
 * Newsletter sign-ups: one document per address at newsletter/{email} ({email, source, createdAt}); anyone may write their own
 * address (firestore.rules), only staff with customers.read can list them.
 *
 *   validateEmail(v)                     → '' when valid, otherwise a localized message
 *   await subscribeNewsletter(email, source = 'home')
 */
import { commitAtomic } from './write.js';
import { TS } from '../shared/ops.js';
import { PATTERNS } from '../shared/constants.js';
import { AppError } from '../core/errors.js';
import { registerBoth, t } from '../core/i18n.js';

registerBoth({ 'nl.err.email': ['Enter a valid email address.', 'সঠিক ইমেইল ঠিকানা দিন।'] });

export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

export function validateEmail(v) {
  const e = normalizeEmail(v);
  return e.length > 0 && e.length <= 120 && PATTERNS.email.test(e) ? '' : t('nl.err.email');
}

export async function subscribeNewsletter(email, source = 'home') {
  const err = validateEmail(email);
  if (err) throw new AppError('validation', err, { fields: { email: err } });
  const e = normalizeEmail(email);
  await commitAtomic([{ op: 'set', path: `newsletter/${e}`, data: { email: e, source: String(source).slice(0, 40), createdAt: TS } }]);
}
