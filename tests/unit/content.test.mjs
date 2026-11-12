import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanLink, cleanImage, newSection, cleanSection, normalizeHome, defaultHomeSections, validateHome,
  normalizePage, pageToDoc, validatePage, HOME_SECTION_TYPES, LIMITS_HOME,
} from '../../js/shared/contentModel.js';

test('cleanLink accepts site paths, http(s), mailto and tel only', () => {
  assert.equal(cleanLink('/shop?sort=newest'), '/shop?sort=newest');
  assert.equal(cleanLink('https://example.com/a'), 'https://example.com/a');
  assert.equal(cleanLink('mailto:a@b.co'), 'mailto:a@b.co');
  assert.equal(cleanLink('tel:+8801700000000'), 'tel:+8801700000000');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', '//evil.com', '/\\evil.com', 'data:text/html,x', 'shop', 'ftp://x']) assert.equal(cleanLink(bad), '', bad);
});

test('cleanImage accepts https / root paths and repairs legacy relative image paths', () => {
  assert.equal(cleanImage('https://cdn.example.com/a.webp'), 'https://cdn.example.com/a.webp');
  assert.equal(cleanImage('/gallery/a.webp'), '/gallery/a.webp');
  assert.equal(cleanImage('gallery/a.webp'), '/gallery/a.webp');
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'foo/bar', '//x.com/a.png', 'mailto:a@b.co']) assert.equal(cleanImage(bad), '', bad);
});

test('normalizeHome: missing or malformed document falls back to the defaults', () => {
  const d = normalizeHome(null);
  assert.deepEqual(d.sections.map((s) => s.type), ['categories', 'products', 'products', 'trust', 'newsletter']);
  assert.deepEqual(normalizeHome({ sections: 'nope' }).sections.map((s) => s.id), defaultHomeSections().map((s) => s.id));
});

test('normalizeHome: an explicitly empty list stays empty', () => {
  assert.deepEqual(normalizeHome({ sections: [] }).sections, []);
});

test('normalizeHome: drops unknown types, de-duplicates ids and single-instance sections, clamps numbers', () => {
  const doc = {
    sections: [
      { id: 'a', type: 'hero', slides: [{ image: '/x.webp', title: 'T' }, { image: 'javascript:1' }, { title: 'no image' }], interval: 99 },
      { id: 'a', type: 'products', source: 'bogus', limit: 500 },
      { id: 'c', type: 'hero', slides: [{ image: '/y.webp' }] },
      { id: 'd', type: 'script', evil: true },
      { id: 'e', type: 'newsletter', text: 'x'.repeat(500) },
      { id: 'f', type: 'newsletter' },
    ],
  };
  const { sections } = normalizeHome(doc);
  assert.deepEqual(sections.map((s) => s.type), ['hero', 'products', 'newsletter']);
  const ids = sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(sections[0].slides.length, 1);
  assert.equal(sections[0].interval, 15);
  assert.equal(sections[1].source, 'newest');
  assert.equal(sections[1].limit, LIMITS_HOME.MAX_PRODUCTS);
  assert.equal(sections[2].text.length, 200);
});

test('cleanSection keeps only known fields and sanitises links', () => {
  const s = cleanSection({ type: 'banners', items: [{ image: '/b.webp', link: 'javascript:alert(1)', title: 'Sale', extra: 1 }], columns: 9 });
  assert.equal(s.columns, 3);
  assert.equal(s.items[0].link, '');
  assert.equal('extra' in s.items[0], false);
  assert.equal(cleanSection({ type: 'nope' }), null);
});

test('every section type has a factory that survives cleanSection unchanged in shape', () => {
  for (const type of Object.keys(HOME_SECTION_TYPES)) {
    const fresh = newSection(type, 'x1');
    const cleaned = cleanSection(fresh);
    assert.equal(cleaned.type, type);
    assert.deepEqual(Object.keys(cleaned).sort(), Object.keys(fresh).sort(), type);
  }
});

test('validateHome reports incomplete sections', () => {
  const problems = validateHome([
    { ...newSection('hero', 'h'), slides: [] },
    { ...newSection('products', 'p'), source: 'category', categoryId: '' },
    { ...newSection('products', 'm'), source: 'manual', productIds: [] },
    { ...newSection('trust', 't1') }, { ...newSection('trust', 't2') },
  ]);
  assert.equal(problems.length, 4);
  assert.ok(problems.every((p) => Array.isArray(p) && p.length === 2));
  assert.deepEqual(validateHome(defaultHomeSections()), []);
});

test('normalizePage / pageToDoc / validatePage', () => {
  const p = normalizePage('about-us', { title: ' About ', body: 'Hello', visible: true, sort: 5000000 });
  assert.equal(p.title, 'About'); assert.equal(p.visible, true); assert.equal(p.footer, true); assert.equal(p.sort, 9999);
  assert.deepEqual(Object.keys(pageToDoc(p)).sort(), ['body', 'footer', 'seoDescription', 'seoTitle', 'sort', 'title', 'visible']);
  assert.equal(normalizePage('x', null).visible, false);
  assert.deepEqual(validatePage({ slug: 'ok-slug', title: 'T', body: '' }), {});
  assert.ok(validatePage({ slug: 'Bad Slug', title: '', body: '' }).slug);
  assert.ok(validatePage({ slug: 'ok', title: '', body: '' }).title);
});
