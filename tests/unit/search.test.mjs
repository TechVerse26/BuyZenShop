/* Storefront search: Bengali + English, digits, accents, prefixes, one typo; weights; AND first, then "any word" as a fallback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, tokenize, buildIndex, search, suggest } from '../../js/shared/search.js';

const P = (id, name, x = {}) => ({
  id, name, sku: x.sku || '', units: x.units || [], brandName: x.brand || '', categoryName: x.category || '',
  tags: x.tags || [], shortDescription: x.short || '', description: x.description || '',
});

const CATALOG = [
  P('p1', 'Blue Cotton Shirt', { sku: 'SV-1001', brand: 'Aarong', category: 'Men', tags: ['summer', 'casual'], units: [{ sku: 'SV-1001-RED' }, { sku: 'SV-1001-BLU' }] }),
  P('p2', 'Black Jacket', { sku: 'SV-2002', category: 'Outerwear', description: 'A warm jacket. Pairs well with a blue shirt.' }),
  P('p3', 'কটন শার্ট', { sku: 'SV-3003', category: 'পুরুষ' }),
  P('p4', 'Phone Model ৫', { sku: 'SV-4004' }),
  P('p5', 'Crème Brûlée Candle', { category: 'Home' }),
  P('p6', 'Red T-Shirt', { short: 'Soft and light' }),
];
const INDEX = buildIndex(CATALOG);
const ids = (q, opts) => search(INDEX, q, opts).map((h) => h.id);

test('text is folded: case, accents, Bengali digits, zero-width joiners', () => {
  assert.equal(normalizeText('Crème BRÛLÉE'), 'creme brulee');
  assert.equal(normalizeText('মডেল ১২৩'), normalizeText('মডেল 123'));
  assert.equal(normalizeText('a‌b‍c'), 'abc');
  assert.equal(normalizeText(null), '');
});

test('tokens: letters, numbers and Bengali marks stay together; punctuation separates', () => {
  assert.deepEqual(tokenize('Blue, Cotton-Shirt (XL)!'), ['blue', 'cotton', 'shirt', 'xl']);
  assert.deepEqual(tokenize('কটন শার্ট'), ['কটন', 'শার্ট'], 'vowel signs and conjuncts are not split off');
  assert.deepEqual(tokenize('   '), []);
});

test('an empty or punctuation-only query finds nothing', () => {
  assert.deepEqual(search(INDEX, ''), []);
  assert.deepEqual(search(INDEX, '  ,, '), []);
});

test('a name match beats a description match', () => {
  // two products with "shirt" in the name (tie → catalogue order), then the jacket that only mentions a shirt in its description
  assert.deepEqual(ids('shirt'), ['p1', 'p6', 'p2']);
  const scores = search(INDEX, 'shirt').map((h) => h.score);
  assert.ok(scores[1] > scores[2], 'a name hit scores clearly higher than a description hit');
});

test('every word must match (AND), and the phrase in the name earns a bonus', () => {
  assert.deepEqual(ids('blue shirt'), ['p1', 'p2'], '"Red T-Shirt" has a shirt but no blue, so it is left out');
  const [first, second] = search(INDEX, 'blue shirt');
  assert.ok(first.score > second.score);
  assert.deepEqual(ids('shirt blue'), ['p1', 'p2'], 'word order does not matter for matching');
});

test('when no product has all the words, the closest "any word" results are still shown, at half weight', () => {
  assert.deepEqual(ids('red jacket'), ['p2', 'p6', 'p1']);
  assert.deepEqual(search(INDEX, 'red jacket').map((h) => h.score), [3, 3, 2.5]);
  assert.deepEqual(ids('zzzz qqqq'), []);
});

test('SKUs and variant SKUs are searchable', () => {
  assert.deepEqual(ids('1001'), ['p1']);
  assert.deepEqual(ids('sv-2002'), ['p2']);
  assert.deepEqual(ids('red'), ['p6', 'p1'], 'the name "Red T-Shirt" outranks a variant SKU ending in RED');
});

test('brand, category and tags are searchable too', () => {
  assert.deepEqual(ids('aarong'), ['p1']);
  assert.deepEqual(ids('outerwear'), ['p2']);
  assert.deepEqual(ids('casual'), ['p1']);
  assert.deepEqual(ids('home'), ['p5']);
});

test('prefixes, substrings (3+ letters) and one typo (5+ letters) still match, but score lower than the exact word', () => {
  assert.deepEqual(ids('jack'), ['p2'], 'prefix of "jacket"');
  assert.deepEqual(ids('shi'), ['p1', 'p6', 'p2'], 'prefix of "shirt"');
  assert.deepEqual(ids('ack'), ['p2'], 'a 3-letter piece from the middle of "black" / "jacket"');
  assert.deepEqual(ids('ac'), [], 'two letters must match the start of a word, not the middle');
  assert.deepEqual(ids('jackat'), ['p2'], 'one wrong letter in a long word');
  const exact = search(INDEX, 'jacket')[0];
  const typo = search(INDEX, 'jackat')[0];
  assert.equal(exact.id, 'p2');
  assert.ok(exact.score > typo.score, 'an exact word scores higher than a typo');
});

test('Bengali words and Bengali digits', () => {
  assert.deepEqual(ids('শার্ট'), ['p3']);
  assert.deepEqual(ids('শা'), ['p3'], 'a Bengali prefix');
  assert.deepEqual(ids('পুরুষ'), ['p3'], 'Bengali category');
  assert.deepEqual(ids('5'), ['p4'], 'a Latin digit finds the Bengali digit in the name');
  assert.deepEqual(ids('৫'), ['p4'], 'and the other way round');
});

test('accents and case do not matter', () => {
  assert.deepEqual(ids('CREME brulee'), ['p5']);
  assert.deepEqual(ids('Crème'), ['p5']);
});

test('the result list is best-first, deterministic and cut at the limit', () => {
  const a = search(INDEX, 'shirt');
  assert.deepEqual(a, search(INDEX, 'shirt'));
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].score >= a[i].score);
  assert.equal(search(INDEX, 'shirt', { limit: 1 }).length, 1);
  assert.deepEqual(ids('shirt', { limit: 2 }), ['p1', 'p6']);
});

test('only the first 600 characters of a description are indexed', () => {
  const long = P('p9', 'Plain', { description: `${'word '.repeat(200)} hiddenword` });
  assert.deepEqual(search(buildIndex([long]), 'hiddenword'), []);
  const short = P('p8', 'Plain', { description: 'findable early' });
  assert.deepEqual(search(buildIndex([short]), 'findable').map((h) => h.id), ['p8']);
});

test('suggestions: at least two characters; names that start with the text come before names that merely contain it', () => {
  const names = (q, n) => suggest(CATALOG, q, n).map((p) => p.id);
  assert.deepEqual(names('b'), []);
  assert.deepEqual(names('  '), []);
  assert.deepEqual(names('bl'), ['p1', 'p2'], 'both names start with "bl": catalogue order');
  assert.deepEqual(names('shirt'), ['p1', 'p6'], 'nothing starts with it; two names contain it');
  assert.deepEqual(names('ja'), ['p2']);
  assert.deepEqual(names('red', 1), ['p6'], 'the limit applies');
  const ordered = suggest([P('a', 'Red Shirt'), P('b', 'Shirt Red'), P('c', 'Shirts')], 'shirt').map((p) => p.id);
  assert.deepEqual(ordered, ['b', 'c', 'a'], 'starts-with first (in catalogue order), then contains');
});
