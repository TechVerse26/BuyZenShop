/* URL slugs: whatever the owner types (Bengali, accents, symbols), the result must satisfy the pattern the rules require. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, slugOr, uniqueSlug, transliterateBengali } from '../../js/shared/slug.js';
import { PATTERNS } from '../../js/shared/constants.js';

test('English names become clean slugs', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Cotton   T-Shirt  '), 'cotton-t-shirt');
  assert.equal(slugify('Tom & Jerry'), 'tom-and-jerry');
  assert.equal(slugify("Men's Shirt"), 'mens-shirt', 'apostrophes vanish instead of splitting the word');
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee', 'accents are folded');
  assert.equal(slugify('100% Cotton / XL'), '100-cotton-xl');
});

test('nothing usable gives an empty slug (callers decide the fallback)', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('  --  '), '');
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify(null), '');
  assert.equal(slugOr('!!!', 'fallback'), 'fallback');
  assert.equal(slugOr('Shirt', 'x'), 'shirt');
});

test('Bengali is transliterated so a Bengali-only name still gets a readable address', () => {
  assert.equal(transliterateBengali('বাংলা'), 'bangla');
  assert.equal(transliterateBengali('কলম'), 'kolom');
  assert.equal(transliterateBengali('১২৩'), '123');
  assert.equal(slugify('কলম ১২'), 'kolom-12');
  assert.match(slugify('বাংলাদেশের সেরা শার্ট'), PATTERNS.slug);
  assert.ok(slugify('বাংলাদেশের সেরা শার্ট').length > 5);
});

test('every output satisfies PATTERNS.slug and the length limit, for hostile input too', () => {
  const inputs = ['a'.repeat(300), 'word '.repeat(60), '--a--b--', '\u0000\u0001 x', '😀 smile 😀', '<script>alert(1)</script>', '../../etc/passwd', 'ＦＵＬＬ　ＷＩＤＴＨ', 'শার্ট & জিন্স / ২০২৬'];
  for (const input of inputs) {
    const s = slugify(input);
    if (s) assert.match(s, PATTERNS.slug, JSON.stringify(input));
    assert.ok(s.length <= 80, `${JSON.stringify(input).slice(0, 30)} → ${s.length}`);
  }
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('<script>alert(1)</script>'), 'script-alert-1-script');
  assert.equal(slugify('ＦＵＬＬ　ＷＩＤＴＨ'), 'full-width', 'full-width letters are folded');
});

test('a long name is cut at a word boundary where it can be', () => {
  assert.equal(slugify('word '.repeat(30), { max: 20 }), 'word-word-word-word');
  assert.equal(slugify('abcdefghij klmnopqrst uvwxyz', { max: 12 }), 'abcdefghij');
  assert.equal(slugify('a'.repeat(100)).length, 80, 'one endless word is cut hard');
  assert.equal(slugify('a'.repeat(100), { max: 10 }), 'aaaaaaaaaa');
});

test('unique slugs: the base if free, then -2, -3 …', () => {
  assert.equal(uniqueSlug('shirt', new Set()), 'shirt');
  assert.equal(uniqueSlug('shirt', new Set(['shirt'])), 'shirt-2');
  assert.equal(uniqueSlug('shirt', new Set(['shirt', 'shirt-2', 'shirt-3'])), 'shirt-4');
  assert.equal(uniqueSlug('', new Set()), 'item');
  assert.equal(uniqueSlug('', new Set(['item'])), 'item-2');
  const taken = new Set(['x', ...Array.from({ length: 998 }, (_, i) => `x-${i + 2}`)]);
  const s = uniqueSlug('x', taken);
  assert.ok(!taken.has(s), 'even when all 999 numbered names are taken it finds a free one');
  assert.match(s, PATTERNS.slug);
});
