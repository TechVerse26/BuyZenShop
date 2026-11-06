/* URL slugs. Output always satisfies PATTERNS.slug (^[a-z0-9]+(-[a-z0-9]+)*$). */

// Rough phonetic Bengali → Latin transliteration, good enough for readable, editable slugs.
const VOWELS = { 'অ': 'o', 'আ': 'a', 'ই': 'i', 'ঈ': 'i', 'উ': 'u', 'ঊ': 'u', 'ঋ': 'ri', 'এ': 'e', 'ঐ': 'oi', 'ও': 'o', 'ঔ': 'ou' };
const SIGNS = { 'া': 'a', 'ি': 'i', 'ী': 'i', 'ু': 'u', 'ূ': 'u', 'ৃ': 'ri', 'ে': 'e', 'ৈ': 'oi', 'ো': 'o', 'ৌ': 'ou' };
const CONS = {
  'ক': 'k', 'খ': 'kh', 'গ': 'g', 'ঘ': 'gh', 'ঙ': 'ng', 'চ': 'ch', 'ছ': 'chh', 'জ': 'j', 'ঝ': 'jh', 'ঞ': 'n', 'ট': 't', 'ঠ': 'th', 'ড': 'd', 'ঢ': 'dh',
  'ণ': 'n', 'ত': 't', 'থ': 'th', 'দ': 'd', 'ধ': 'dh', 'ন': 'n', 'প': 'p', 'ফ': 'f', 'ব': 'b', 'ভ': 'v', 'ম': 'm', 'য': 'j', 'র': 'r', 'ল': 'l',
  'শ': 'sh', 'ষ': 'sh', 'স': 's', 'হ': 'h', 'ড়': 'r', 'ঢ়': 'rh', 'য়': 'y', 'ৎ': 't',
};
const OTHER = { 'ং': 'ng', 'ঃ': 'h', 'ঁ': 'n', '্': '' };
const DIGITS = '০১২৩৪৫৬৭৮৯';

export function transliterateBengali(input) {
  const s = String(input ?? '').normalize('NFC');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const pair = s.slice(i, i + 2);
    if (CONS[pair]) { out += CONS[pair]; i++; continue; }
    if (CONS[c]) {
      out += CONS[c];
      const next = s[i + 1];
      // inherent vowel: add "o" unless followed by a vowel sign / virama / end of word
      if (!(next && (SIGNS[next] || next === '্' || OTHER[next] !== undefined)) && next && CONS[next]) out += 'o';
      continue;
    }
    if (VOWELS[c]) { out += VOWELS[c]; continue; }
    if (SIGNS[c]) { out += SIGNS[c]; continue; }
    if (OTHER[c] !== undefined) { out += OTHER[c]; continue; }
    const d = DIGITS.indexOf(c);
    if (d >= 0) { out += String(d); continue; }
    out += c;
  }
  return out;
}

export function slugify(input, { max = 80 } = {}) {
  let s = transliterateBengali(input).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/-+[^-]*$/, '') || s.slice(0, max);
  return s.replace(/^-+|-+$/g, '');
}

/** slugify with a fallback (used when a Bengali-only name produces nothing useful). */
export function slugOr(input, fallback) {
  return slugify(input) || fallback;
}

/** Ensure uniqueness against a Set of taken slugs by appending -2, -3 … */
export function uniqueSlug(base, taken) {
  const b = base || 'item';
  if (!taken.has(b)) return b;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${b}-${n}`)) return `${b}-${n}`;
  return `${b}-${Date.now().toString(36)}`;
}
