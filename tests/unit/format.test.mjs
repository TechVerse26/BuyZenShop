/* What customers and staff read: taka with lakh grouping, Bangladesh dates (UTC+6, no daylight saving), relative times, masked contact details. */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setFormatOptions, getFormatOptions, toBnDigits, toLatinDigits, groupLakh, num, money, pct, compact,
  fmtDate, fmtTime, fmtDateTime, fmtShortDate, fmtMonth, dhakaDayKey, startOfDhakaDay, parseDhakaDate, toDhakaInput, fromDhakaInput,
  relTime, plural, initials, truncate, fileSize, fmtPhone, maskPhone, maskEmail,
} from '../../js/core/format.js';

const en = () => setFormatOptions({ language: 'en', banglaDigits: false });
const bn = () => setFormatOptions({ language: 'bn', banglaDigits: true });
afterEach(() => setFormatOptions({ language: 'bn', banglaDigits: false }));          // module state must not leak between tests
const plain = (s) => String(s).replace(/[  ]/g, ' ');                         // ICU versions differ in the kind of space before "am"

test('lakh grouping: 3 digits, then pairs', () => {
  assert.equal(groupLakh(0), '0');
  assert.equal(groupLakh(999), '999');
  assert.equal(groupLakh(1000), '1,000');
  assert.equal(groupLakh(12345), '12,345');
  assert.equal(groupLakh(100000), '1,00,000');
  assert.equal(groupLakh(1250000), '12,50,000');
  assert.equal(groupLakh(12345678), '1,23,45,678');
  assert.equal(groupLakh(-1250000), '-12,50,000');
  assert.equal(groupLakh(1234.99), '1,234', 'whole taka only');
});

test('money: ৳ with grouping, rounded to whole taka, a real minus sign for negatives, optional plus', () => {
  en();
  assert.equal(money(1250), '৳1,250');
  assert.equal(money(0), '৳0');
  assert.equal(money(1250.5), '৳1,251');
  assert.equal(money(99.4), '৳99');
  assert.equal(money(-1250), '−৳1,250', 'U+2212, not a hyphen');
  assert.equal(money(5, { sign: true }), '+৳5');
  assert.equal(money(0, { sign: true }), '৳0');
  assert.equal(money(-5, { sign: true }), '−৳5');
  assert.equal(money('1500'), '৳1,500');
  for (const bad of [null, undefined, NaN, 'abc']) assert.equal(money(bad), '—');
});

test('numbers: grouping, optional decimals, dash for "no value"', () => {
  en();
  assert.equal(num(1234.5), '1,235');
  assert.equal(num(1234.5, { decimals: 2 }), '1,234.50');
  assert.equal(num(-1234.5, { decimals: 1 }), '-1,234.5');
  assert.equal(num(0), '0');
  assert.equal(num(null), '—');
  assert.equal(num(undefined), '—');
  assert.equal(num(NaN), '—');
  assert.equal(pct(12.4), '12%');
  assert.equal(pct(null), '0%');
});

test('Bengali digits switch every number helper without touching call sites', () => {
  bn();
  assert.equal(money(1250), '৳১,২৫০');
  assert.equal(num(1234567), '১২,৩৪,৫৬৭');
  assert.equal(pct(12.4), '১২%');
  assert.equal(num(1234.5, { decimals: 2 }), '১,২৩৪.৫০');
  assert.equal(toBnDigits('2026-01-05'), '২০২৬-০১-০৫');
  assert.equal(toLatinDigits('০১৭১২-৩৪৫৬৭৮'), '01712-345678');
  assert.equal(toLatinDigits(toBnDigits('9876543210')), '9876543210');
  assert.deepEqual(getFormatOptions(), { banglaDigits: true, language: 'bn' });
});

test('compact amounts: k / L / Cr (or হাজার / লাখ / কোটি)', () => {
  en();
  assert.equal(compact(0), '0');
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1k');
  assert.equal(compact(1500), '1.5k');
  assert.equal(compact(99999), '100k', 'rounds up at the boundary');
  assert.equal(compact(100000), '1 L');
  assert.equal(compact(250000), '2.5 L');
  assert.equal(compact(10000000), '1 Cr');
  assert.equal(compact(null), '0');
  setFormatOptions({ language: 'bn', banglaDigits: true });
  assert.equal(compact(250000), '২.৫ লাখ');
  assert.equal(compact(1500), '১.৫ হাজার');
  assert.equal(compact(25000000), '২.৫ কোটি');
});

test('dates are the Bangladesh calendar day: 18:00 UTC is already tomorrow in Dhaka', () => {
  en();
  assert.equal(fmtDate(Date.UTC(2026, 0, 1, 17, 59)), '1 Jan 2026');
  assert.equal(fmtDate(Date.UTC(2026, 0, 1, 18, 0)), '2 Jan 2026');
  assert.equal(fmtShortDate(Date.UTC(2026, 0, 1, 18, 0)), '2 Jan');
  assert.equal(fmtMonth(Date.UTC(2026, 0, 31, 18, 0)), 'Feb 2026');
  assert.equal(plain(fmtTime(Date.UTC(2026, 0, 1, 18, 30))).toLowerCase(), '12:30 am');
  assert.equal(plain(fmtDateTime(Date.UTC(2026, 5, 1, 6, 5))).toLowerCase(), '1 jun 2026, 12:05 pm');
  assert.equal(fmtDate({ seconds: Date.UTC(2026, 0, 1, 18, 0) / 1000 }), '2 Jan 2026', 'Firestore timestamps work');
  for (const f of [fmtDate, fmtTime, fmtDateTime, fmtShortDate, fmtMonth]) {
    assert.equal(f(null), '—');
    assert.equal(f(undefined), '—');
    assert.equal(f('garbage'), '—');
  }
});

test('dates in Bengali mode keep Latin digits unless the digit switch is on', () => {
  setFormatOptions({ language: 'bn', banglaDigits: false });
  const latin = fmtDate(Date.UTC(2026, 0, 1, 18, 0));
  assert.match(latin, /2/);
  assert.match(latin, /2026/);
  assert.doesNotMatch(latin, /[০-৯]/);
  setFormatOptions({ language: 'bn', banglaDigits: true });
  assert.match(fmtDate(Date.UTC(2026, 0, 1, 18, 0)), /২.*২০২৬/);
});

test('Dhaka day helpers: report grouping, midnight, <input type=date> and datetime-local round trips', () => {
  assert.equal(dhakaDayKey(Date.UTC(2026, 0, 1, 17, 59, 59)), '2026-01-01');
  assert.equal(dhakaDayKey(Date.UTC(2026, 0, 1, 18, 0, 0)), '2026-01-02');
  assert.equal(dhakaDayKey(Date.UTC(2026, 11, 31, 18, 0, 0)), '2027-01-01');
  assert.equal(startOfDhakaDay(Date.UTC(2026, 0, 1, 20, 0)), Date.UTC(2026, 0, 1, 18, 0));
  assert.equal(startOfDhakaDay(Date.UTC(2026, 0, 1, 18, 0)), Date.UTC(2026, 0, 1, 18, 0), 'exactly midnight stays');
  assert.equal(startOfDhakaDay(Date.UTC(2026, 0, 1, 17, 59, 59, 999)), Date.UTC(2025, 11, 31, 18, 0));

  assert.equal(parseDhakaDate('2026-01-02'), Date.UTC(2026, 0, 1, 18, 0));
  assert.equal(parseDhakaDate('2026-01-02', true), Date.UTC(2026, 0, 2, 17, 59, 59, 999));
  for (const bad of ['2026-1-2', '02/01/2026', '', null, undefined, '2026-01-02T00:00']) assert.equal(parseDhakaDate(bad), null, String(bad));
  assert.equal(dhakaDayKey(parseDhakaDate('2026-03-15')), '2026-03-15', 'a picked day groups into the same day');
  assert.equal(dhakaDayKey(parseDhakaDate('2026-03-15', true)), '2026-03-15', 'including its last millisecond');

  assert.equal(toDhakaInput(Date.UTC(2026, 0, 1, 18, 30)), '2026-01-02T00:30');
  assert.equal(toDhakaInput(null), '');
  assert.equal(fromDhakaInput('2026-01-02T00:30'), Date.UTC(2026, 0, 1, 18, 30));
  for (const bad of ['2026-01-02', '2026-01-02 00:30', '', null]) assert.equal(fromDhakaInput(bad), null, String(bad));
  const t = Date.UTC(2026, 7, 9, 3, 45);
  assert.equal(fromDhakaInput(toDhakaInput(t)), t);
});

test('relative time: just now under 45 seconds, then minutes, hours, days (past and future)', () => {
  en();
  const now = Date.UTC(2026, 5, 1, 6, 0, 0);
  assert.equal(relTime(now - 10000, now), 'just now');
  assert.equal(relTime(now + 30000, now), 'just now');
  assert.equal(relTime(now - 5 * 60000, now), '5 minutes ago');
  assert.equal(relTime(now + 3 * 3600000, now), 'in 3 hours');
  assert.equal(relTime(now - 86400000, now), 'yesterday');
  assert.equal(relTime(now - 2 * 86400000, now), '2 days ago');
  assert.equal(relTime(null, now), '—');
  setFormatOptions({ language: 'bn', banglaDigits: false });
  assert.equal(relTime(now - 10000, now), 'এইমাত্র');
  assert.match(relTime(now - 5 * 60000, now), /5/);
});

test('small text helpers: plural, initials, truncate, file size', () => {
  assert.equal(plural(1, 'item', 'items'), 'item');
  assert.equal(plural(0, 'item', 'items'), 'items');
  assert.equal(plural('1', 'item', 'items'), 'item');
  assert.equal(initials('imran ahmed'), 'IA');
  assert.equal(initials('  Rupsha   Jonokollan  Foundation '), 'RJ');
  assert.equal(initials('বাংলা নাম'), 'বন');
  assert.equal(initials(''), '?');
  assert.equal(initials(null), '?');
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('x'.repeat(20), 10), 'xxxxxxxxx…');
  assert.equal(truncate(null), '');
  assert.equal(fileSize(0), '0 B');
  assert.equal(fileSize(1023), '1023 B');
  assert.equal(fileSize(1024), '1 KB');
  assert.equal(fileSize(1536), '2 KB');
  assert.equal(fileSize(1048576), '1.0 MB');
  assert.equal(fileSize(5.5 * 1048576), '5.5 MB');
  assert.equal(fileSize('abc'), '0 B');
});

test('phone numbers and e-mails are shown whole to the owner and masked for people who only need to recognise them', () => {
  assert.equal(fmtPhone('01712345678'), '01712-345678');
  assert.equal(fmtPhone('+8801712345678'), '+8801712345678', 'only the local form is re-spaced');
  assert.equal(fmtPhone(''), '');
  assert.equal(maskPhone('01712345678'), '017••••••78');
  assert.equal(maskPhone('01712345678').length, 11);
  assert.equal(maskPhone('12345'), '12345', 'too short to mask');
  assert.equal(maskPhone(null), '');
  assert.equal(maskEmail('imran@example.com'), 'im•••@example.com');
  assert.equal(maskEmail('ab@x.co'), 'ab•@x.co');
  assert.equal(maskEmail('no-at-sign'), 'no-at-sign');
  assert.equal(maskEmail(null), '');
  assert.ok(!maskEmail('imran@example.com').includes('mran'), 'the hidden part is really gone');
});
