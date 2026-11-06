import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyForm, normalizeForm, validateForm, toOrderInput, addressFromForm, formFromAddress, METHODS } from '../../js/store/lib/checkoutForm.js';

const good = emptyForm({ name: 'Rahim Uddin', phone: '01712345678', district: 'Sirajganj', line1: 'House 12, Road 3', method: 'cod' });

test('a complete COD form is valid', () => assert.deepEqual(validateForm(good), {}));

test('every required field reports its own code', () => {
  assert.deepEqual(validateForm(emptyForm()), { name: 'name', phone: 'phone', district: 'district', line1: 'line1', method: 'method' });
  assert.equal(validateForm({ ...good, name: 'A' }).name, 'name');
  assert.equal(validateForm({ ...good, district: 'Atlantis' }).district, 'district');
  assert.equal(validateForm({ ...good, line1: 'abc' }).line1, 'line1');
  assert.equal(validateForm({ ...good, email: 'not-an-email' }).email, 'email');
  assert.equal(validateForm({ ...good, email: 'ok@example.com' }).email, undefined);
});

test('phone numbers are normalised: +880, 880, Bengali digits, spaces', () => {
  for (const p of ['01712345678', '+8801712345678', '8801712345678', '1712345678', '017 1234-5678', '০১৭১২৩৪৫৬৭৮']) {
    assert.equal(normalizeForm({ ...good, phone: p }).phone, '01712345678', p);
    assert.deepEqual(validateForm({ ...good, phone: p }), {}, p);
  }
  for (const p of ['0171234567', '01212345678', '12345', 'abc']) assert.equal(validateForm({ ...good, phone: p }).phone, 'phone', p);
});

test('bKash / Nagad need a TrxID (6–20 letters or digits) and the sender number; COD ignores both', () => {
  const b = { ...good, method: 'bkash' };
  assert.deepEqual(validateForm(b), { trxId: 'trx', senderNumber: 'sender' });
  assert.deepEqual(validateForm({ ...b, trxId: '9c4a7b2d10', senderNumber: '01812345678' }), {});
  assert.equal(validateForm({ ...b, trxId: 'ab12', senderNumber: '01812345678' }).trxId, 'trx');
  assert.equal(validateForm({ ...b, trxId: 'X'.repeat(21), senderNumber: '01812345678' }).trxId, undefined, 'overlong input is clipped to 20 before checking');
  assert.equal(validateForm({ ...b, method: 'nagad', trxId: 'ABC123', senderNumber: '123' }).senderNumber, 'sender');
  assert.deepEqual(validateForm({ ...good, trxId: '', senderNumber: '' }), {});
});

test('a payment method that the store disabled is refused', () => {
  assert.equal(validateForm({ ...good, method: 'bkash', trxId: 'ABC123', senderNumber: '01812345678' }, { methods: ['cod'] }).method, 'method');
  assert.equal(validateForm({ ...good, method: 'paypal' }).method, 'method');
  assert.deepEqual([...METHODS], ['cod', 'bkash', 'nagad']);
});

test('TrxIDs are upper-cased and stripped of spaces/punctuation', () => {
  assert.equal(normalizeForm({ trxId: ' 9c4a-7b2d 10 ' }).trxId, '9C4A7B2D10');
});

test('toOrderInput builds the payload for placeOrder (COD has no TrxID, mobile money has)', () => {
  const cod = toOrderInput({ ...good, trxId: 'LEFTOVER', note: '  please   call  ' }, { email: 'Rahim@Example.com' });
  assert.deepEqual(cod.payment, { method: 'cod' });
  assert.equal(cod.customer.email, 'rahim@example.com');
  assert.equal(cod.note, 'please call');
  assert.deepEqual(cod.address, { name: 'Rahim Uddin', phone: '01712345678', district: 'Sirajganj', upazila: '', area: '', postalCode: '', line1: 'House 12, Road 3', notes: '' });
  const mm = toOrderInput({ ...good, method: 'nagad', trxId: 'abc 123', senderNumber: '+8801812345678' });
  assert.deepEqual(mm.payment, { method: 'nagad', trxId: 'ABC123', senderNumber: '01812345678' });
});

test('saved addresses fill the form, and the form gives the address back', () => {
  const saved = { name: 'Karim', phone: '01822222222', district: 'Dhaka', upazila: 'Dhanmondi', area: 'Road 5', postalCode: '1205', line1: 'Flat 4B' };
  const f = formFromAddress(saved, emptyForm({ name: 'Ignored', email: 'k@example.com' }));
  assert.equal(f.name, 'Karim'); assert.equal(f.email, 'k@example.com');
  assert.deepEqual(addressFromForm(f), { ...saved, notes: '' });
});
