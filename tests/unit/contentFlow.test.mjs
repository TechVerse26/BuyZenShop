/* Content planners (js/shared/contentFlow.js): what may be saved, what is stored, what is audited. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeProblems, planHomeSave, planPageSave, planPageFlag, planPageDelete, CONTENT } from '../../js/shared/contentFlow.js';
import { newSection, normalizePage, PAGE_LIMITS } from '../../js/shared/contentModel.js';

const SA = { uid: 'sa', email: 'sa@x.test', role: 'super_admin' };
const PM = { uid: 'pm', email: 'pm@x.test', role: 'product_manager' };
const OM = { uid: 'om', email: 'om@x.test', role: 'order_manager' };
const en = (problems) => problems.map((p) => p[0]);
const hero = (slides, over = {}) => ({ ...newSection('hero', 'h1'), slides, ...over });
const slide = (over = {}) => ({ id: 's1', image: 'https://cdn.example.com/a.webp', title: 'Sale', link: '/shop', ...over });
const page = (over = {}) => ({ slug: 'about', title: 'About us', body: 'Hello **world**', visible: true, footer: true, sort: 1, seoTitle: '', seoDescription: '', ...over });

test('homeProblems: a slide needs a usable picture, links must be usable, trust points need a title', () => {
  assert.deepEqual(homeProblems([hero([slide()])]), []);
  assert.match(en(homeProblems([hero([slide({ image: '' })])]))[0], /slide 1 needs a picture/);
  assert.match(en(homeProblems([hero([slide({ image: 'javascript:alert(1)' })])]))[0], /picture address that cannot be used/);
  assert.match(en(homeProblems([hero([slide({ mobileImage: 'data:image/png;base64,AAAA' })])]))[0], /phone picture/);
  assert.match(en(homeProblems([hero([slide({ link: 'javascript:alert(1)' })])]))[0], /link that cannot be used/);
  assert.deepEqual(homeProblems([hero([slide({ link: '' })])]), [], 'a link is optional');
  const banners = { ...newSection('banners', 'b1'), items: [{ id: 'b', image: '', title: 'x' }] };
  assert.match(en(homeProblems([banners]))[0], /banner 1 needs a picture/);
  const trust = { ...newSection('trust', 't1'), items: [{ icon: 'truck', title: '  ', text: 'x' }] };
  assert.match(en(homeProblems([trust]))[0], /point 1 needs a title/);
  const products = { ...newSection('products', 'p1'), viewAllLink: 'ftp://x' };
  assert.match(en(homeProblems([products]))[0], /"view all" link/);
  assert.ok(en(homeProblems([hero([])])).some((m) => /at least one slide/.test(m)), 'the model\'s own rules still apply');
  for (const p of homeProblems([hero([slide({ image: '' })])])) assert.equal(p.length, 2, 'every problem has an English and a Bengali text');
});

test('planHomeSave: stores the SANITISED sections with the server time, audits the change, refuses what is already stored', () => {
  const dirty = hero([slide({ title: '  Big sale  ', evil: '<script>', tone: 'neon' })], { enabled: true, extra: 'x' });
  const r = planHomeSave({ sections: [dirty, { type: 'nope' }], before: null, actor: PM });
  assert.equal(r.ok, true);
  assert.equal(r.sections.length, 1, 'unknown section types are dropped');
  assert.deepEqual(Object.keys(r.sections[0]).sort(), ['autoplay', 'enabled', 'id', 'interval', 'slides', 'title', 'type']);
  assert.equal(r.sections[0].slides[0].title, 'Big sale');
  assert.equal(r.sections[0].slides[0].tone, 'dark', 'a bad tone falls back');
  assert.equal('evil' in r.sections[0].slides[0], false);
  assert.deepEqual(r.ops[0], { op: 'set', path: 'content/home', data: { sections: r.sections, updatedAt: r.ops[0].data.updatedAt } });
  assert.equal(r.ops[1].path.startsWith('auditLogs/'), true);
  assert.equal(r.ops[1].data.action, 'content.home_save');
  assert.deepEqual(r.ops[1].data.after, { sections: ['hero'] });
  assert.equal(r.ops[1].data.before, null);
  assert.equal(planHomeSave({ sections: r.sections, before: r.sections, actor: PM }).error, 'no_change');
  const hidden = planHomeSave({ sections: [{ ...r.sections[0], enabled: false }], before: r.sections, actor: PM });
  assert.deepEqual([hidden.ok, hidden.ops[1].data.after, hidden.ops[1].data.before], [true, { sections: ['hero (hidden)'] }, { sections: ['hero'] }]);
});

test('planHomeSave: only content writers, only valid input', () => {
  assert.equal(planHomeSave({ sections: [], actor: OM }).error, 'forbidden');
  assert.equal(planHomeSave({ sections: [], actor: null }).error, 'forbidden');
  assert.equal(planHomeSave({ sections: 'nope', actor: SA }).error, 'invalid');
  const bad = planHomeSave({ sections: [hero([slide({ image: '' })])], actor: SA });
  assert.deepEqual([bad.error, bad.problems.length], ['invalid', 1]);
  assert.equal(planHomeSave({ sections: [], before: null, actor: SA }).ok, true, 'an empty home page is allowed (the shop shows no sections)');
});

test('planPageSave: create — validated, slug free, reserved words refused, audit without the text', () => {
  const r = planPageSave({ page: page(), existing: null, isNew: true, actor: PM });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'about');
  assert.deepEqual(r.ops[0].path, 'pages/about');
  assert.deepEqual(Object.keys(r.ops[0].data).sort(), ['body', 'footer', 'seoDescription', 'seoTitle', 'sort', 'title', 'updatedAt', 'visible']);
  assert.equal(r.ops[1].data.action, 'page.create');
  assert.equal(r.ops[1].data.before, null);
  assert.deepEqual(r.ops[1].data.after, { title: 'About us', visible: true, footer: true, sort: 1, bodyChars: 15 });
  assert.equal(JSON.stringify(r.ops[1].data).includes('world'), false, 'the audit entry never carries the page text');

  const bad = (over) => planPageSave({ page: page(over), existing: null, isNew: true, actor: SA });
  for (const slug of ['About', 'a b', 'a_b', '-a', 'a-', 'a--b', '', 'x'.repeat(PAGE_LIMITS.SLUG + 1)]) assert.equal(bad({ slug }).error, 'invalid', JSON.stringify(slug));
  assert.equal(bad({ title: '   ' }).errors.title.length, 2);
  assert.equal(bad({ body: 'x'.repeat(PAGE_LIMITS.BODY + 1) }).error, 'invalid');
  assert.equal(bad({ slug: 'new' }).error, 'invalid');
  assert.equal(CONTENT.RESERVED_SLUGS.includes('new'), true);
  assert.equal(planPageSave({ page: page(), existing: { title: 'old' }, isNew: true, actor: SA }).error, 'exists');
  assert.equal(planPageSave({ page: page(), existing: null, isNew: true, actor: OM }).error, 'forbidden');
});

test('planPageSave: update — refuses a page that is gone and a save that changes nothing, audits before and after', () => {
  const stored = { title: 'About us', body: 'Hello **world**', visible: true, footer: true, sort: 1, seoTitle: '', seoDescription: '' };
  assert.equal(planPageSave({ page: page(), existing: stored, actor: SA }).error, 'no_change');
  assert.equal(planPageSave({ page: page(), existing: null, actor: SA }).error, 'not_found');
  const r = planPageSave({ page: page({ title: 'About Shop Verse', visible: false, body: 'x'.repeat(40), sort: -3 }), existing: stored, actor: SA });
  assert.equal(r.ok, true);
  assert.equal(r.ops[1].data.action, 'page.update');
  assert.deepEqual(r.ops[1].data.before, { title: 'About us', visible: true, footer: true, sort: 1, bodyChars: 15 });
  assert.deepEqual(r.ops[1].data.after, { title: 'About Shop Verse', visible: false, footer: true, sort: -3, bodyChars: 40 });
  assert.match(r.ops[1].data.summary, /hidden/);
  assert.equal(normalizePage('about', stored).footer, true);
});

test('planPageFlag and planPageDelete', () => {
  const p = { slug: 'about', title: 'About us', visible: true, footer: true, sort: 1, body: 'abc' };
  const hide = planPageFlag({ page: p, field: 'visible', value: false, actor: PM });
  assert.deepEqual([hide.ok, hide.action, hide.ops[0].path, Object.keys(hide.ops[0].data).sort()], [true, 'page.hide', 'pages/about', ['updatedAt', 'visible']]);
  assert.equal(planPageFlag({ page: p, field: 'footer', value: false, actor: PM }).action, 'page.footer_off');
  assert.equal(planPageFlag({ page: { ...p, visible: false }, field: 'visible', value: true, actor: PM }).action, 'page.show');
  assert.equal(planPageFlag({ page: p, field: 'visible', value: true, actor: PM }).error, 'no_change');
  assert.equal(planPageFlag({ page: p, field: 'sort', value: true, actor: PM }).error, 'invalid');
  assert.equal(planPageFlag({ page: p, field: 'visible', value: 'no', actor: PM }).error, 'invalid');
  assert.equal(planPageFlag({ page: p, field: 'visible', value: false, actor: OM }).error, 'forbidden');
  const del = planPageDelete({ page: p, actor: SA });
  assert.deepEqual([del.ok, del.ops[0], del.ops[1].data.action, del.ops[1].data.before], [true, { op: 'delete', path: 'pages/about' }, 'page.delete', { title: 'About us', visible: true, footer: true, sort: 1, bodyChars: 3 }]);
  assert.equal(planPageDelete({ page: p, actor: OM }).error, 'forbidden');
  assert.equal(planPageDelete({ page: null, actor: SA }).error, 'not_found');
});
