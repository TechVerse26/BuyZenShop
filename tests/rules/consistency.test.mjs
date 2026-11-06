/*
 * Keeps js/shared/constants.js (used by the UI for role gating) identical to firestore.rules.
 * The rules are the real enforcement; this test only stops the two from drifting apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES_TEXT } from './harness.mjs';
import { ROLE_PERMS, ROLE_IDS, PERMISSION_IDS, ORDER_TRANSITIONS, ORDER_STATUS_IDS, LIMITS, PATTERNS } from '../../js/shared/constants.js';

function rulesRolePerms() {
  const start = RULES_TEXT.indexOf('function rolePerms(r)');
  const end = RULES_TEXT.indexOf('match /staff/{uid}');
  const body = RULES_TEXT.slice(start, end);
  const out = {};
  const re = /r == '([a-z_]+)' \? \[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = [...m[2].matchAll(/'([a-z.]+)'/g)].map((x) => x[1]);
  // the last branch is written as `: r == 'reporting' ? [...]` – picked up by the same regex
  return out;
}

test('role → permission lists are identical in rules and constants', () => {
  const fromRules = rulesRolePerms();
  assert.deepEqual(Object.keys(fromRules).sort(), Object.keys(ROLE_PERMS).sort());
  for (const [role, perms] of Object.entries(ROLE_PERMS)) {
    assert.deepEqual([...perms].sort(), [...fromRules[role]].sort(), `role ${role}`);
  }
});

test('every permission used by a role (or by the rules) is declared', () => {
  const declared = new Set(PERMISSION_IDS);
  for (const perms of Object.values(ROLE_PERMS)) for (const p of perms) assert.ok(declared.has(p), `undeclared permission ${p}`);
  const used = new Set([...RULES_TEXT.matchAll(/perm\('([a-z.]+)'\)/g)].map((m) => m[1]));
  for (const m of RULES_TEXT.matchAll(/permAny\(\[([^\]]*)\]/g)) for (const p of m[1].matchAll(/'([a-z.]+)'/g)) used.add(p[1]);
  for (const m of RULES_TEXT.matchAll(/permFor\(s, '([a-z.]+)'\)/g)) used.add(m[1]);
  for (const p of used) assert.ok(declared.has(p), `rules use undeclared permission ${p}`);
});

test('staff role list in the rules equals ROLE_IDS', () => {
  const m = RULES_TEXT.match(/request\.resource\.data\.role in \[([^\]]*)\]/);
  const rolesInRules = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(rolesInRules, [...ROLE_IDS].sort());
});

test('order status transitions equal validTransition() in the rules', () => {
  const start = RULES_TEXT.indexOf('function validTransition');
  const body = RULES_TEXT.slice(start, RULES_TEXT.indexOf('function staffUpdate'));
  const fromRules = {};
  for (const m of body.matchAll(/f == '([a-z_]+)' && to in \[([^\]]*)\]/g)) fromRules[m[1]] = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  for (const [from, tos] of Object.entries(ORDER_TRANSITIONS)) {
    assert.deepEqual([...(fromRules[from] || [])].sort(), [...tos].sort(), `transitions from ${from}`);
  }
  for (const s of ORDER_STATUS_IDS) assert.ok(s in ORDER_TRANSITIONS, `status ${s} has a transition entry`);
});

test('limits and patterns mirrored from the rules', () => {
  assert.match(RULES_TEXT, new RegExp(`itemOrder.size\\(\\) <= ${LIMITS.MAX_LINES}`));
  assert.match(RULES_TEXT, new RegExp(`duration.value\\(${LIMITS.ORDER_COOLDOWN_SECONDS}, 's'\\)`));
  assert.match(RULES_TEXT, /lineOk\(4\)/);
  assert.ok(!/lineOk\(5\)/.test(RULES_TEXT));
  assert.match(RULES_TEXT, /it\.qty <= 50/);
  assert.equal(LIMITS.MAX_QTY_PER_LINE, 50);
  assert.match(RULES_TEXT, /\^\[A-Z0-9\]\{2,6\}-\[0-9\]\{6\}-\[A-Z0-9\]\{6\}\$/);
  assert.match(RULES_TEXT, /\^01\[3-9\]\[0-9\]\{8\}\$/);
  assert.match(RULES_TEXT, /\^\[A-Z0-9\]\{6,20\}\$/);
  assert.match(RULES_TEXT, /\^\[A-Z0-9-\]\{3,24\}\$/);
  assert.ok(PATTERNS.orderNumber.test('SV-261026-K3F9QZ'));
  assert.ok(!PATTERNS.orderNumber.test('order_1700000000000'));
});
