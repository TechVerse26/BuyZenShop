/*
 * Content planners (js/shared/contentFlow.js) against the REAL firestore.rules, strict AND tolerant engine:
 * Super Admin, Store Admin and Product Manager (content.write) save the home layout and create, edit, show / hide and delete pages; everybody else is refused by
 * the RULES. Pages need a clean address, the known fields only, sizes within limits and the server time; the home layout is at most 24 sections.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planHomeSave, planPageSave, planPageFlag, planPageDelete } from '../../js/shared/contentFlow.js';
import { newSection } from '../../js/shared/contentModel.js';
import { TS } from '../../js/shared/ops.js';
import { auditOp } from '../../js/shared/orderFlow.js';
import { baseDb, commitBoth, failedOps, NOW, DAY } from './harness.mjs';
import { Ts } from './rules-engine.mjs';

const ROLE = { sa: 'super_admin', sadm: 'store_admin', pm: 'product_manager', om: 'order_manager', im: 'inventory_manager', cs: 'customer_support', rp: 'reporting' };
const WRITERS = ['sa', 'sadm', 'pm'];
const OTHERS = ['om', 'im', 'cs', 'rp'];
const actor = (uid) => ({ uid, email: `${uid}@x.test`, role: ROLE[uid] });
const audits = (db) => [...db.m.entries()].filter(([k]) => k.startsWith('auditLogs/')).map(([, v]) => v);
const page = (over = {}) => ({ slug: 'about', title: 'About us', body: 'Hello', visible: true, footer: true, sort: 1, seoTitle: '', seoDescription: '', ...over });
const doc = (over = {}) => ({ title: 'About us', body: 'Hello', visible: true, footer: true, sort: 1, seoTitle: '', seoDescription: '', updatedAt: TS, ...over });
const pageDb = () => { const db = baseDb(); db.set('pages/about', { ...doc(), updatedAt: new Ts(NOW - DAY) }); db.set('content/home', { sections: [], updatedAt: new Ts(NOW - DAY) }); return db; };

function commit(db, uid, ops, label) {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, true, `${label} strict: ${failedOps(r.strict).join(' | ')}`);
  assert.equal(r.tolerant.allowed, true, `${label} tolerant: ${failedOps(r.tolerant).join(' | ')}`);
  return r.strict.dbAfter;
}
const refused = (db, uid, ops, label) => {
  const r = commitBoth(db, { uid }, ops);
  assert.equal(r.strict.allowed, false, `${label}: strict engine allowed it`);
  assert.equal(r.tolerant.allowed, false, `${label}: tolerant engine allowed it`);
};
const forge = (plan, who) => plan.ops.map((o) => (o.path.startsWith('auditLogs/') ? auditOp(actor(who), { action: 'content.test', entity: 'content', entityId: 'x', summary: 'forged' }) : o));
const raw = (slug, over) => [{ op: 'set', path: `pages/${slug}`, data: doc(over) }];
const sections = () => [{ ...newSection('trust', 't1'), items: [{ icon: 'truck', title: 'Free delivery', text: '' }] }, newSection('newsletter', 'n1')];

test('home: content writers save the sanitised layout with the server time and leave one audit entry', () => {
  for (const who of WRITERS) {
    const db = pageDb();
    const plan = planHomeSave({ sections: sections(), before: [], actor: actor(who) });
    assert.equal(plan.ok, true);
    const after = commit(db, who, plan.ops, `home by ${who}`);
    assert.deepEqual(after.get('content/home').sections.map((s) => s.type), ['trust', 'newsletter']);
    const [log] = audits(after);
    assert.deepEqual([log.action, log.entity, log.entityId, log.actorUid, log.actorRole], ['content.home_save', 'content', 'home', who, ROLE[who]]);
  }
});

test('home: every other role is refused by the planner AND by the rules; so are bad shapes', () => {
  for (const who of OTHERS) {
    const db = pageDb();
    assert.equal(planHomeSave({ sections: sections(), actor: actor(who) }).error, 'forbidden', who);
    refused(db, who, forge(planHomeSave({ sections: sections(), actor: actor('sa') }), who), `home by ${who}`);
  }
  const db = pageDb();
  const put = (data) => [{ op: 'set', path: 'content/home', data }];
  commit(db, 'sa', put({ sections: [], updatedAt: TS }), 'control');
  refused(db, 'sa', put({ sections: 'nope', updatedAt: TS }), 'sections is not a list');
  refused(db, 'sa', put({ sections: Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, type: 'newsletter' })), updatedAt: TS }), '25 sections');
  refused(db, 'sa', put({ sections: [], updatedAt: TS, extra: 1 }), 'an unknown field');
  commit(db, 'sa', put({ sections: Array.from({ length: 24 }, (_, i) => ({ id: `s${i}`, type: 'newsletter' })), updatedAt: TS }), '24 sections');
});

test('pages: content writers create a page, edit it, hide it and delete it — each audited', () => {
  for (const who of WRITERS) {
    let db = pageDb();
    const create = planPageSave({ page: page({ slug: 'terms', title: 'Terms' }), existing: null, isNew: true, actor: actor(who) });
    db = commit(db, who, create.ops, `create by ${who}`);
    assert.equal(db.get('pages/terms').title, 'Terms');
    const edit = planPageSave({ page: page({ slug: 'terms', title: 'Terms of sale', sort: -4, visible: false }), existing: db.get('pages/terms'), actor: actor(who) });
    db = commit(db, who, edit.ops, `edit by ${who}`);
    assert.deepEqual([db.get('pages/terms').title, db.get('pages/terms').sort, db.get('pages/terms').visible], ['Terms of sale', -4, false]);
    const view = { slug: 'terms', title: 'Terms of sale', visible: false, footer: true, sort: -4, body: 'Hello' };
    db = commit(db, who, planPageFlag({ page: view, field: 'visible', value: true, actor: actor(who) }).ops, `show by ${who}`);
    assert.equal(db.get('pages/terms').visible, true);
    assert.equal(db.get('pages/terms').title, 'Terms of sale', 'a flag change keeps the rest');
    db = commit(db, who, planPageDelete({ page: { ...view, visible: true }, actor: actor(who) }).ops, `delete by ${who}`);
    assert.equal(db.get('pages/terms'), undefined);
    assert.deepEqual(audits(db).map((a) => a.action).sort(), ['page.create', 'page.delete', 'page.show', 'page.update']);
  }
});

test('pages: every other role is refused (create, edit, flag, delete)', () => {
  for (const who of OTHERS) {
    const db = pageDb();
    const create = planPageSave({ page: page({ slug: 'terms' }), existing: null, isNew: true, actor: actor('sa') });
    const edit = planPageSave({ page: page({ title: 'Changed' }), existing: db.get('pages/about'), actor: actor('sa') });
    const flag = planPageFlag({ page: { slug: 'about', title: 'About us', visible: true, footer: true }, field: 'visible', value: false, actor: actor('sa') });
    const del = planPageDelete({ page: { slug: 'about', title: 'About us' }, actor: actor('sa') });
    for (const [name, plan] of [['create', create], ['edit', edit], ['flag', flag], ['delete', del]]) {
      assert.equal(plan.ok, true, `${name} plan for the control`);
      refused(db, who, forge(plan, who), `${name} by ${who}`);
    }
    assert.equal(planPageSave({ page: page(), existing: db.get('pages/about'), actor: actor(who) }).error, 'forbidden');
  }
  const db = pageDb();
  refused(db, 'u1', raw('about', {}), 'a customer');
});

test('pages: the RULES enforce the address, the fields, the sizes and the server time', () => {
  const db = pageDb();
  commit(db, 'sa', raw('terms', {}), 'control');
  commit(db, 'sa', raw('a', { sort: -9999 }), 'sort -9999');
  commit(db, 'sa', raw('b', { sort: 9999, title: 'x'.repeat(120), body: 'y'.repeat(30000), seoTitle: 'z'.repeat(70), seoDescription: 'w'.repeat(200) }), 'every limit exactly');
  commit(db, 'sa', raw('privacy-policy-2', {}), 'hyphens and digits');
  for (const slug of ['About', 'return_policy', '-terms', 'terms-', 'a--b', 'a b', 'x'.repeat(61)]) refused(db, 'sa', raw(slug, {}), `address ${JSON.stringify(slug)}`);
  refused(db, 'sa', raw('t', { author: 'me' }), 'an unknown field');
  refused(db, 'sa', raw('t', { title: '' }), 'no title');
  refused(db, 'sa', raw('t', { title: 'x'.repeat(121) }), 'title 121');
  refused(db, 'sa', raw('t', { body: 'y'.repeat(30001) }), 'body 30001');
  refused(db, 'sa', raw('t', { body: 42 }), 'body not text');
  refused(db, 'sa', raw('t', { visible: 'yes' }), 'visible not a flag');
  refused(db, 'sa', raw('t', { footer: 1 }), 'footer not a flag');
  refused(db, 'sa', raw('t', { sort: 10000 }), 'sort 10000');
  refused(db, 'sa', raw('t', { sort: -10000 }), 'sort -10000');
  refused(db, 'sa', raw('t', { sort: 1.5 }), 'sort not a whole number');
  refused(db, 'sa', raw('t', { seoTitle: 'z'.repeat(71) }), 'seo title 71');
  refused(db, 'sa', raw('t', { seoDescription: 'w'.repeat(201) }), 'seo description 201');
  refused(db, 'sa', raw('t', { updatedAt: new Ts(NOW - 1000) }), 'a client clock');
  refused(db, 'sa', [{ op: 'set', path: 'pages/t', data: { title: 'T', visible: true } }], 'missing fields');
});
