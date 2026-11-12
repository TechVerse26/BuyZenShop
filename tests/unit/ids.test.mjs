/* Identifiers and the little normalisers that decide what the rules see: order numbers, phone numbers, TrxIDs, coupon codes, line keys. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  randomCode, dhakaDateStamp, makeOrderNumber, normalizePhone, normalizeTrxId, normalizeCouponCode, lineKey, splitLineKey, shortId, autoId,
} from '../../js/shared/id.js';
import { PATTERNS } from '../../js/shared/constants.js';

test('random codes have the requested length and only unambiguous characters (no 0 O 1 I L)', () => {
  for (let i = 0; i < 200; i++) {
    const c = randomCode(10);
    assert.equal(c.length, 10);
    assert.match(c, /^[A-HJKMNP-Z2-9]{10}$/);
  }
  assert.equal(randomCode(0), '');
});

test('random codes are reproducible with an injected source and spread over the whole alphabet', () => {
  let n = 0;
  const rnd = () => ((n++ * 37) % 256) / 256;
  n = 0; const a = randomCode(8, undefined, rnd);
  n = 0; const b = randomCode(8, undefined, rnd);
  assert.equal(a, b);
  const seen = new Set();
  for (let i = 0; i < 400; i++) for (const ch of randomCode(8)) seen.add(ch);
  assert.ok(seen.size >= 28, `only ${seen.size} different characters seen`);
});

test('short ids are lower-case (safe inside document ids) and auto ids are 20 alphanumerics', () => {
  assert.match(shortId(), /^[a-z2-9]{8}$/);
  assert.match(shortId(12), /^[a-z2-9]{12}$/);
  assert.match(autoId(), /^[A-Za-z0-9]{20}$/);
  assert.notEqual(autoId(), autoId());
});

test('the order-number date is the Bangladesh calendar day (UTC+6), including across midnight and new year', () => {
  assert.equal(dhakaDateStamp(Date.UTC(2026, 0, 1, 17, 59, 59)), '260101');
  assert.equal(dhakaDateStamp(Date.UTC(2026, 0, 1, 18, 0, 0)), '260102', '18:00 UTC is already midnight in Dhaka');
  assert.equal(dhakaDateStamp(Date.UTC(2026, 11, 31, 18, 0, 0)), '270101');
  assert.equal(dhakaDateStamp(Date.UTC(2026, 1, 28, 18, 0, 0)), '260301');
});

test('order numbers always satisfy the pattern the rules demand, whatever prefix the settings hold', () => {
  const now = Date.UTC(2026, 5, 1, 6, 0, 0);
  for (const prefix of ['SV', 'sv', 's', '', null, undefined, 'toolongprefix', 'a-b c', '!!!', 'শপ']) {
    const id = makeOrderNumber(prefix, now);
    assert.match(id, PATTERNS.orderNumber, `prefix ${JSON.stringify(prefix)} → ${id}`);
    assert.ok(id.includes('-260601-'), id);
  }
  assert.ok(makeOrderNumber('s', now).startsWith('SX-'), 'a one-letter prefix is padded');
  assert.ok(makeOrderNumber('toolongprefix', now).startsWith('TOOLON-'), 'a long prefix is cut to six');
  assert.ok(makeOrderNumber('', now).startsWith('SV-'), 'an empty prefix falls back to SV');
  const ids = new Set(Array.from({ length: 300 }, () => makeOrderNumber('SV', now)));
  assert.equal(ids.size, 300, 'no collisions in 300 draws');
});

test('phone numbers: every way people write a Bangladeshi mobile becomes the 11-digit local form, anything else becomes empty', () => {
  for (const ok of ['01712345678', '+8801712345678', '8801712345678', '1712345678', '০১৭১২৩৪৫৬৭৮', '0171-234 5678', ' (0171) 234-5678 ', '+880 1712-345678']) {
    assert.equal(normalizePhone(ok), '01712345678', ok);
  }
  for (const bad of ['01212345678', '0171234567', '017123456789', '+8801212345678', 'abc', '', '   ', null, undefined, '02-9876543']) {
    assert.equal(normalizePhone(bad), '', String(bad));
  }
  assert.match(normalizePhone('01312345678'), PATTERNS.bdPhone);
  assert.match(normalizePhone('01912345678'), PATTERNS.bdPhone);
});

test('TrxIDs and coupon codes are canonicalised the same way the rules compare them', () => {
  assert.equal(normalizeTrxId('9a b-c1d2e3 f'), '9ABC1D2E3F');
  assert.equal(normalizeTrxId(null), '');
  assert.equal(normalizeTrxId('ab!'), 'AB');
  assert.match(normalizeTrxId('8n5 f2k 9q1'), PATTERNS.trxId);
  assert.equal(normalizeCouponCode(' save 10 '), 'SAVE10');
  assert.equal(normalizeCouponCode('Eid\t2026'), 'EID2026');
  assert.equal(normalizeCouponCode(undefined), '');
});

test('line keys: productId, or productId__variantId; and back again', () => {
  assert.equal(lineKey('p1', null), 'p1');
  assert.equal(lineKey('p1', undefined), 'p1');
  assert.equal(lineKey('p1', 'v1'), 'p1__v1');
  assert.deepEqual(splitLineKey('p1'), { productId: 'p1', variantId: null });
  assert.deepEqual(splitLineKey('p1__v1'), { productId: 'p1', variantId: 'v1' });
  assert.deepEqual(splitLineKey('p1__v1__x'), { productId: 'p1', variantId: 'v1__x' }, 'only the first separator splits');
  const k = lineKey('abc', 'red-xl');
  assert.deepEqual(splitLineKey(k), { productId: 'abc', variantId: 'red-xl' });
});
