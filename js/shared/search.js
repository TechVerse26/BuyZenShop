/*
 * Client-side product search (the catalog is small enough to index in the browser).
 *  - Bengali + Latin tokenisation, Bengali digits, diacritics folded, case-insensitive
 *  - weighted fields (name > sku > brand/category/tags > description)
 *  - exact / prefix / substring / one-typo matching
 * Pure and deterministic: tests/unit/search.test.mjs.
 */

const FIELD_WEIGHT = { name: 6, sku: 5, brand: 3, category: 3, tags: 3, short: 1.5, description: 1 };

export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)))
    .replace(/[‌‍]/g, '')
    .toLowerCase();
}

export function tokenize(s) {
  return normalizeText(s).split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
}

function editDistanceLe1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

export function buildIndex(products) {
  return products.map((p) => ({
    id: p.id,
    fields: {
      name: tokenize(p.name),
      sku: [...new Set([p.sku, ...p.units.map((u) => u.sku)].filter(Boolean).flatMap(tokenize))],
      brand: tokenize(p.brandName),
      category: tokenize(p.categoryName),
      tags: (p.tags || []).flatMap(tokenize),
      short: tokenize(p.shortDescription),
      description: tokenize(String(p.description || '').slice(0, 600)),
    },
    nameNorm: normalizeText(p.name),
  }));
}

function tokenScore(q, tokens, weight) {
  let best = 0;
  for (const t of tokens) {
    if (t === q) return weight;
    if (t.startsWith(q)) best = Math.max(best, weight * 0.75);
    else if (q.length >= 3 && t.includes(q)) best = Math.max(best, weight * 0.4);
    else if (q.length >= 5 && editDistanceLe1(q, t)) best = Math.max(best, weight * 0.3);
  }
  return best;
}

/**
 * @returns {Array<{id:string, score:number}>} best first. All query tokens must match something
 * (AND); if nothing matches, falls back to "any token" so the customer still sees close results.
 */
export function search(index, query, { limit = 60 } = {}) {
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const score = (entry, requireAll) => {
    let total = 0, matched = 0;
    for (const q of qTokens) {
      let s = 0;
      for (const [f, w] of Object.entries(FIELD_WEIGHT)) s = Math.max(s, tokenScore(q, entry.fields[f], w));
      if (s > 0) { matched++; total += s; }
    }
    if (requireAll ? matched < qTokens.length : matched === 0) return 0;
    if (entry.nameNorm.includes(normalizeText(query).trim())) total += 4; // phrase bonus
    return total;
  };
  let hits = index.map((e) => ({ id: e.id, score: score(e, true) })).filter((h) => h.score > 0);
  if (!hits.length && qTokens.length > 1) hits = index.map((e) => ({ id: e.id, score: score(e, false) * 0.5 })).filter((h) => h.score > 0);
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Autocomplete: product names starting with / containing the query. */
export function suggest(products, query, limit = 6) {
  const q = normalizeText(query).trim();
  if (q.length < 2) return [];
  const starts = [], contains = [];
  for (const p of products) {
    const n = normalizeText(p.name);
    if (n.startsWith(q)) starts.push(p); else if (n.includes(q)) contains.push(p);
  }
  return [...starts, ...contains].slice(0, limit);
}
