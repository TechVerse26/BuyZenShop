/*
 * A small interpreter for the subset of the Firestore Security Rules language used by
 * firestore.rules. It exists because the real emulator cannot be downloaded in the build
 * sandbox: it executes the ACTUAL rules text against simulated requests so typos, undefined
 * names, logic mistakes and get()/getAfter() call budgets are caught before deployment.
 *
 * It is NOT the Firebase rules engine. Semantics are intentionally strict:
 *  - any evaluation error inside an `allow` condition makes that condition false
 *    (errors propagate through || and && instead of being swallowed);
 *  - get/getAfter/exists/existsAfter calls are counted WITHOUT caching (worst case).
 * Works in Node and in the browser (used by the e2e mock Firestore).
 */

/* ───────────────────────── values ───────────────────────── */

export class Ts {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toJSON() { return { __ts: this.ms }; }
}
export class Dur {
  constructor(ms) { this.ms = ms; }
}
class RPath {
  constructor(segs) { this.segs = segs; } // segments after /databases/x/documents
  get key() { return this.segs.join('/'); }
}
class RSet {
  constructor(items) { this.items = [...new Set(items)]; }
}
class MapDiff {
  constructor(a, b) { this.a = a; this.b = b; }
}

export const FieldValue = {
  serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  increment: (n) => ({ __op: 'increment', n }),
  deleteField: () => ({ __op: 'delete' }),
};

export class RuleError extends Error {}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Ts) && !(v instanceof Dur) && !(v instanceof RPath) && !(v instanceof RSet) && !(v instanceof MapDiff);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Ts && b instanceof Ts) return a.ms === b.ms;
  if (a instanceof Dur && b instanceof Dur) return a.ms === b.ms;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/* ───────────────────────── tokenizer ───────────────────────── */

const PUNCT = ['&&', '||', '==', '!=', '<=', '>=', '{', '}', '(', ')', '[', ']', ',', ';', ':', '.', '?', '!', '<', '>', '+', '-', '*', '/', '%', '=', '$'];

function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment');
      i = end + 2; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { j++; const e = src[j]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; }
        else s += src[j];
        j++;
      }
      if (j >= n) throw new Error('Unterminated string');
      out.push({ k: 'str', v: s }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j]) && !(src[j] === '.' && !/[0-9]/.test(src[j + 1] || ''))) j++;
      out.push({ k: 'num', v: Number(src.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new Error(`Unexpected character '${c}' at ${i}: ${src.slice(Math.max(0, i - 30), i + 30)}`);
    out.push({ k: 'p', v: p }); i += p.length;
  }
  out.push({ k: 'eof' });
  return out;
}

/* ───────────────────────── parser ───────────────────────── */

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek(o = 0) { return this.t[this.i + o]; }
  next() { return this.t[this.i++]; }
  isP(v, o = 0) { const t = this.peek(o); return t.k === 'p' && t.v === v; }
  isId(v, o = 0) { const t = this.peek(o); return t.k === 'id' && t.v === v; }
  eatP(v) { if (this.isP(v)) { this.i++; return true; } return false; }
  expectP(v) { if (!this.eatP(v)) this.fail(`expected '${v}'`); }
  expectId(v) { if (!this.isId(v)) this.fail(`expected '${v}'`); this.i++; }
  ident() { const t = this.next(); if (t.k !== 'id') { this.i--; this.fail('expected identifier'); } return t.v; }
  fail(msg) {
    const t = this.peek();
    const around = this.t.slice(Math.max(0, this.i - 6), this.i + 4).map((x) => x.v ?? x.k).join(' ');
    throw new Error(`Rules parse error: ${msg}, got ${JSON.stringify(t.v ?? t.k)} near: ${around}`);
  }

  parseFile() {
    if (this.isId('rules_version')) { this.next(); this.expectP('='); this.next(); this.expectP(';'); }
    this.expectId('service');
    this.ident(); while (this.eatP('.')) this.ident();
    this.expectP('{');
    const body = this.parseBlockItems();
    this.expectP('}');
    return { t: 'service', items: body };
  }

  parseBlockItems() {
    const items = [];
    while (!this.isP('}')) {
      if (this.isId('match')) items.push(this.parseMatch());
      else if (this.isId('function')) items.push(this.parseFunction());
      else if (this.isId('allow')) items.push(this.parseAllow());
      else this.fail('expected match/function/allow');
    }
    return items;
  }

  parseMatch() {
    this.expectId('match');
    const segs = [];
    while (this.isP('/')) {
      this.next();
      if (this.eatP('{')) {
        const name = this.ident();
        this.expectP('}');
        segs.push({ wild: name });
      } else {
        segs.push({ lit: this.ident() });
      }
    }
    this.expectP('{');
    const items = this.parseBlockItems();
    this.expectP('}');
    return { t: 'match', segs, items };
  }

  parseFunction() {
    this.expectId('function');
    const name = this.ident();
    this.expectP('(');
    const params = [];
    if (!this.isP(')')) { do { params.push(this.ident()); } while (this.eatP(',')); }
    this.expectP(')');
    this.expectP('{');
    const lets = [];
    while (this.isId('let')) {
      this.next();
      const n = this.ident(); this.expectP('=');
      const e = this.parseExpr(); this.expectP(';');
      lets.push({ name: n, expr: e });
    }
    this.expectId('return');
    const ret = this.parseExpr(); this.expectP(';');
    this.expectP('}');
    return { t: 'function', name, params, lets, ret };
  }

  parseAllow() {
    this.expectId('allow');
    const ops = [this.ident()];
    while (this.eatP(',')) ops.push(this.ident());
    let cond = { t: 'bool', v: false };
    if (this.eatP(':')) { this.expectId('if'); cond = this.parseExpr(); }
    this.expectP(';');
    return { t: 'allow', ops, cond };
  }

  parseExpr() { return this.parseTernary(); }
  parseTernary() {
    const c = this.parseOr();
    if (this.eatP('?')) {
      const a = this.parseTernary(); this.expectP(':'); const b = this.parseTernary();
      return { t: 'tern', c, a, b };
    }
    return c;
  }
  parseOr() { let l = this.parseAnd(); while (this.eatP('||')) l = { t: 'bin', op: '||', l, r: this.parseAnd() }; return l; }
  parseAnd() { let l = this.parseEq(); while (this.eatP('&&')) l = { t: 'bin', op: '&&', l, r: this.parseEq() }; return l; }
  parseEq() {
    let l = this.parseRel();
    while (this.isP('==') || this.isP('!=')) { const op = this.next().v; l = { t: 'bin', op, l, r: this.parseRel() }; }
    return l;
  }
  parseRel() {
    let l = this.parseAdd();
    for (;;) {
      if (this.isP('<') || this.isP('<=') || this.isP('>') || this.isP('>=')) { const op = this.next().v; l = { t: 'bin', op, l, r: this.parseAdd() }; }
      else if (this.isId('in')) { this.next(); l = { t: 'bin', op: 'in', l, r: this.parseAdd() }; }
      else if (this.isId('is')) { this.next(); l = { t: 'is', e: l, type: this.ident() }; }
      else return l;
    }
  }
  parseAdd() {
    let l = this.parseMul();
    while (this.isP('+') || this.isP('-')) { const op = this.next().v; l = { t: 'bin', op, l, r: this.parseMul() }; }
    return l;
  }
  parseMul() {
    let l = this.parseUnary();
    while (this.isP('*') || this.isP('/') || this.isP('%')) { const op = this.next().v; l = { t: 'bin', op, l, r: this.parseUnary() }; }
    return l;
  }
  parseUnary() {
    if (this.eatP('!')) return { t: 'unary', op: '!', e: this.parseUnary() };
    if (this.eatP('-')) return { t: 'unary', op: '-', e: this.parseUnary() };
    return this.parsePostfix();
  }
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      if (this.eatP('.')) { e = { t: 'member', obj: e, name: this.ident() }; }
      else if (this.isP('(')) {
        this.next();
        const args = [];
        if (!this.isP(')')) { do { args.push(this.parseExpr()); } while (this.eatP(',')); }
        this.expectP(')');
        e = { t: 'call', callee: e, args };
      } else if (this.eatP('[')) {
        const idx = this.parseExpr(); this.expectP(']');
        e = { t: 'index', obj: e, idx };
      } else return e;
    }
  }
  parsePrimary() {
    const t = this.peek();
    if (t.k === 'num') { this.next(); return { t: 'num', v: t.v }; }
    if (t.k === 'str') { this.next(); return { t: 'str', v: t.v }; }
    if (t.k === 'id') {
      this.next();
      if (t.v === 'true') return { t: 'bool', v: true };
      if (t.v === 'false') return { t: 'bool', v: false };
      if (t.v === 'null') return { t: 'null' };
      return { t: 'id', name: t.v };
    }
    if (this.isP('(')) { this.next(); const e = this.parseExpr(); this.expectP(')'); return e; }
    if (this.isP('[')) {
      this.next();
      const items = [];
      if (!this.isP(']')) { do { if (this.isP(']')) break; items.push(this.parseExpr()); } while (this.eatP(',')); }
      this.expectP(']');
      return { t: 'list', items };
    }
    if (this.isP('/')) {
      const segs = [];
      while (this.isP('/')) {
        this.next();
        if (this.eatP('$')) { this.expectP('('); const e = this.parseExpr(); this.expectP(')'); segs.push({ expr: e }); }
        else if (this.peek().k === 'id' || this.peek().k === 'num') segs.push({ lit: String(this.next().v) });
        else this.fail('bad path segment');
      }
      return { t: 'path', segs };
    }
    this.fail('unexpected token in expression');
  }
}

export function parseRules(text) {
  return new Parser(tokenize(text)).parseFile();
}

/* ───────────────────────── evaluator ───────────────────────── */

class Scope {
  constructor(parent = null) { this.vars = new Map(); this.funcs = new Map(); this.parent = parent; }
  getVar(n) { for (let s = this; s; s = s.parent) if (s.vars.has(n)) return { v: s.vars.get(n) }; return null; }
  getFunc(n) { for (let s = this; s; s = s.parent) if (s.funcs.has(n)) return s.funcs.get(n); return null; }
}

const MAX_DEPTH = 20;

function typeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Ts) return 'timestamp';
  if (v instanceof Dur) return 'duration';
  if (v instanceof RPath) return 'path';
  if (v instanceof RSet) return 'set';
  return 'map';
}

function num(v, what = 'number') {
  if (typeof v !== 'number') throw new RuleError(`${what} expected, got ${typeOf(v)}`);
  return v;
}

function compare(a, b, op) {
  let x = a, y = b;
  if (a instanceof Ts && b instanceof Ts) { x = a.ms; y = b.ms; }
  else if (a instanceof Dur && b instanceof Dur) { x = a.ms; y = b.ms; }
  else if (typeof a === 'number' && typeof b === 'number') { /* ok */ }
  else if (typeof a === 'string' && typeof b === 'string') { /* ok */ }
  else throw new RuleError(`cannot compare ${typeOf(a)} ${op} ${typeOf(b)}`);
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
}

class EvalCtx {
  constructor(opts) {
    Object.assign(this, opts); // db, dbAfter, request, resource, counters
    this.depth = 0;
    this.nodes = 0;
  }
}

function listOf(v) {
  if (Array.isArray(v)) return v;
  if (v instanceof RSet) return v.items;
  throw new RuleError(`list expected, got ${typeOf(v)}`);
}

function callMethod(recv, name, args, ctx) {
  const t = typeOf(recv);
  switch (t) {
    case 'string':
      switch (name) {
        case 'size': return recv.length;
        case 'matches': { if (typeof args[0] !== 'string') throw new RuleError('matches needs a string'); return new RegExp(`^(?:${args[0]})$`).test(recv); }
        case 'lower': return recv.toLowerCase();
        case 'upper': return recv.toUpperCase();
        case 'trim': return recv.trim();
        case 'split': return recv.split(args[0]);
        case 'replace': return recv.split(args[0]).join(args[1]);
        default: break;
      }
      break;
    case 'list': case 'set': {
      const items = listOf(recv);
      switch (name) {
        case 'size': return items.length;
        case 'hasAny': return listOf(args[0]).some((x) => items.some((y) => deepEqual(x, y)));
        case 'hasAll': return listOf(args[0]).every((x) => items.some((y) => deepEqual(x, y)));
        case 'hasOnly': return items.every((x) => listOf(args[0]).some((y) => deepEqual(x, y)));
        case 'join': return items.join(args[0]);
        case 'toSet': return new RSet(items);
        case 'concat': return [...items, ...listOf(args[0])];
        default: break;
      }
      break;
    }
    case 'map':
      switch (name) {
        case 'keys': return Object.keys(recv);
        case 'values': return Object.values(recv);
        case 'size': return Object.keys(recv).length;
        case 'get': return Object.prototype.hasOwnProperty.call(recv, args[0]) ? recv[args[0]] : args[1];
        case 'diff': return new MapDiff(recv, args[0]);
        default: break;
      }
      break;
    case 'int': case 'float':
      break;
    default: break;
  }
  if (recv instanceof MapDiff && name === 'affectedKeys') {
    const keys = new Set([...Object.keys(recv.a), ...Object.keys(recv.b)]);
    return new RSet([...keys].filter((k) => !(k in recv.a) || !(k in recv.b) || !deepEqual(recv.a[k], recv.b[k])));
  }
  throw new RuleError(`unknown method ${name}() on ${t}`);
}

// Access calls are de-duplicated per document (pre-state and post-state separately), which is how
// Firestore bills/limits them (repeated access to the same document is served from a cache).
// `raw` is the uncached count, reported for transparency.
function docAt(ctx, path, after) {
  if (!(path instanceof RPath)) throw new RuleError('path expected');
  ctx.counters.raw++;
  ctx.counters.seen.add((after ? 'A:' : 'B:') + path.key);
  const db = after ? ctx.dbAfter : ctx.db;
  return db.has(path.key) ? db.get(path.key) : undefined;
}

function evalNode(n, scope, ctx) {
  ctx.nodes++;
  switch (n.t) {
    case 'num': case 'str': case 'bool': return n.v;
    case 'null': return null;
    case 'list': return n.items.map((e) => evalNode(e, scope, ctx));
    case 'id': {
      const f = scope.getVar(n.name);
      if (f) return f.v;
      if (n.name === 'math') return { __ns: 'math' };
      if (n.name === 'duration') return { __ns: 'duration' };
      throw new RuleError(`undefined variable '${n.name}'`);
    }
    case 'path': {
      const segs = n.segs.map((s) => {
        if (s.lit !== undefined) return s.lit;
        const v = evalNode(s.expr, scope, ctx);
        if (typeof v !== 'string' || v === '' || v.includes('/')) throw new RuleError(`invalid path segment ${JSON.stringify(v)}`);
        return v;
      });
      // /databases/{db}/documents/<rest>
      if (segs[0] === 'databases' && segs[2] === 'documents') return new RPath(segs.slice(3));
      return new RPath(segs);
    }
    case 'member': {
      const obj = evalNode(n.obj, scope, ctx);
      if (obj && obj.__ns) { return { __fn: `${obj.__ns}.${n.name}` }; }
      if (obj === null || obj === undefined) throw new RuleError(`cannot read '${n.name}' of null`);
      if (isMap(obj)) {
        if (!Object.prototype.hasOwnProperty.call(obj, n.name)) throw new RuleError(`field '${n.name}' does not exist`);
        return obj[n.name];
      }
      throw new RuleError(`cannot read '${n.name}' of ${typeOf(obj)}`);
    }
    case 'index': {
      const obj = evalNode(n.obj, scope, ctx);
      const idx = evalNode(n.idx, scope, ctx);
      if (Array.isArray(obj)) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) throw new RuleError(`list index ${idx} out of range`);
        return obj[idx];
      }
      if (isMap(obj)) {
        if (typeof idx !== 'string' || !Object.prototype.hasOwnProperty.call(obj, idx)) throw new RuleError(`map key ${JSON.stringify(idx)} missing`);
        return obj[idx];
      }
      throw new RuleError(`cannot index ${typeOf(obj)}`);
    }
    case 'call': return evalCall(n, scope, ctx);
    case 'unary': {
      const v = evalNode(n.e, scope, ctx);
      if (n.op === '!') { if (typeof v !== 'boolean') throw new RuleError('! needs bool'); return !v; }
      return -num(v);
    }
    case 'is': {
      const v = evalNode(n.e, scope, ctx);
      const t = typeOf(v);
      switch (n.type) {
        case 'string': return t === 'string';
        case 'int': return t === 'int';
        case 'float': return t === 'float';
        case 'number': return t === 'int' || t === 'float';
        case 'bool': return t === 'bool';
        case 'list': return t === 'list';
        case 'map': return t === 'map';
        case 'timestamp': return t === 'timestamp';
        case 'duration': return t === 'duration';
        case 'path': return t === 'path';
        default: throw new RuleError(`unknown type ${n.type}`);
      }
    }
    case 'tern': {
      const c = evalNode(n.c, scope, ctx);
      if (typeof c !== 'boolean') throw new RuleError('ternary condition must be bool');
      return c ? evalNode(n.a, scope, ctx) : evalNode(n.b, scope, ctx);
    }
    case 'bin': return evalBin(n, scope, ctx);
    default: throw new RuleError(`bad node ${n.t}`);
  }
}

function evalBool(node, op, scope, ctx) {
  // Returns {v} or {err}. In strict mode errors propagate immediately.
  try {
    const v = evalNode(node, scope, ctx);
    if (typeof v !== 'boolean') throw new RuleError(`${op} needs bool, got ${typeOf(v)}`);
    return { v };
  } catch (e) {
    if (!ctx.tolerant || !(e instanceof RuleError)) throw e;
    return { err: e };
  }
}

function evalBin(n, scope, ctx) {
  if (n.op === '&&' || n.op === '||') {
    // strict (default): errors propagate. tolerant: an erroring operand is ignored when the other
    // operand alone decides the result (true || error == true, false && error == false), which is
    // how the production engine is documented to behave. Tests run both modes: legitimate requests
    // must pass in STRICT mode, forged ones must fail in TOLERANT mode.
    const isOr = n.op === '||';
    const decisive = isOr ? true : false;
    const L = evalBool(n.l, n.op, scope, ctx);
    if (!L.err && L.v === decisive) return decisive;
    const R = evalBool(n.r, n.op, scope, ctx);
    if (!R.err && R.v === decisive) return decisive;
    if (L.err) throw L.err;
    if (R.err) throw R.err;
    return !decisive;
  }
  const l = evalNode(n.l, scope, ctx);
  const r = evalNode(n.r, scope, ctx);
  switch (n.op) {
    case '==': return deepEqual(l, r);
    case '!=': return !deepEqual(l, r);
    case '<': case '<=': case '>': case '>=': return compare(l, r, n.op);
    case 'in':
      if (Array.isArray(r)) return r.some((x) => deepEqual(x, l));
      if (r instanceof RSet) return r.items.some((x) => deepEqual(x, l));
      if (isMap(r)) return typeof l === 'string' && Object.prototype.hasOwnProperty.call(r, l);
      throw new RuleError(`'in' needs list/map, got ${typeOf(r)}`);
    case '+':
      if (typeof l === 'number' && typeof r === 'number') return l + r;
      if (typeof l === 'string' && typeof r === 'string') return l + r;
      if (l instanceof Ts && r instanceof Dur) return new Ts(l.ms + r.ms);
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      throw new RuleError(`cannot add ${typeOf(l)} + ${typeOf(r)}`);
    case '-':
      if (l instanceof Ts && r instanceof Dur) return new Ts(l.ms - r.ms);
      if (l instanceof Ts && r instanceof Ts) return new Dur(l.ms - r.ms);
      return num(l) - num(r);
    case '*': return num(l) * num(r);
    case '/': { const d = num(r); if (d === 0) throw new RuleError('division by zero'); return num(l) / d; }
    case '%': return num(l) % num(r);
    default: throw new RuleError(`bad operator ${n.op}`);
  }
}

function evalCall(n, scope, ctx) {
  const c = n.callee;
  // method call: obj.name(args)
  if (c.t === 'member') {
    const recv = evalNode(c.obj, scope, ctx);
    if (recv && recv.__ns) return callNamespaceFn(`${recv.__ns}.${c.name}`, n.args.map((a) => evalNode(a, scope, ctx)));
    if (recv === null || recv === undefined) throw new RuleError(`cannot call ${c.name}() on null`);
    return callMethod(recv, c.name, n.args.map((a) => evalNode(a, scope, ctx)), ctx);
  }
  if (c.t !== 'id') throw new RuleError('bad call target');
  const args = n.args.map((a) => evalNode(a, scope, ctx));
  switch (c.name) {
    case 'get': { const d = docAt(ctx, args[0], false); if (d === undefined) throw new RuleError(`get(): document ${args[0].key} not found`); return { data: d }; }
    case 'getAfter': { const d = docAt(ctx, args[0], true); if (d === undefined) throw new RuleError(`getAfter(): document ${args[0].key} not found`); return { data: d }; }
    case 'exists': return docAt(ctx, args[0], false) !== undefined;
    case 'existsAfter': return docAt(ctx, args[0], true) !== undefined;
    default: break;
  }
  const fn = scope.getFunc(c.name);
  if (!fn) throw new RuleError(`undefined function '${c.name}'`);
  if (fn.params.length !== args.length) throw new RuleError(`${c.name}() expects ${fn.params.length} args, got ${args.length}`);
  if (++ctx.depth > MAX_DEPTH) throw new RuleError(`function call depth exceeded (${MAX_DEPTH})`);
  try {
    const fscope = new Scope(fn.scope);
    fn.params.forEach((p, i) => fscope.vars.set(p, args[i]));
    for (const l of fn.lets) fscope.vars.set(l.name, evalNode(l.expr, fscope, ctx));
    return evalNode(fn.ret, fscope, ctx);
  } finally { ctx.depth--; }
}

function callNamespaceFn(name, args) {
  switch (name) {
    case 'math.floor': return Math.floor(num(args[0]));
    case 'math.ceil': return Math.ceil(num(args[0]));
    case 'math.round': return Math.round(num(args[0]));
    case 'math.abs': return Math.abs(num(args[0]));
    case 'duration.value': {
      const unit = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[args[1]];
      if (!unit) throw new RuleError(`bad duration unit ${args[1]}`);
      return new Dur(num(args[0]) * unit);
    }
    default: throw new RuleError(`unknown function ${name}`);
  }
}

/* ───────────────────────── in-memory database ───────────────────────── */

export class MemDb {
  constructor(entries) { this.m = new Map(entries || []); }
  has(k) { return this.m.has(k); }
  get(k) { return this.m.get(k); }
  set(k, v) { this.m.set(k, v); }
  delete(k) { this.m.delete(k); }
  clone() { return new MemDb([...this.m.entries()].map(([k, v]) => [k, structuredCloneDeep(v)])); }
  keys() { return [...this.m.keys()]; }
}

export function structuredCloneDeep(v) {
  if (v instanceof Ts) return new Ts(v.ms);
  if (v instanceof Dur) return new Dur(v.ms);
  if (Array.isArray(v)) return v.map(structuredCloneDeep);
  if (isMap(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = structuredCloneDeep(v[k]); return o; }
  return v;
}

const DELETE_MARK = Symbol('delete');

function resolveValue(v, prev, now) {
  if (v && typeof v === 'object' && v.__op) {
    if (v.__op === 'serverTimestamp') return new Ts(now);
    if (v.__op === 'increment') return (typeof prev === 'number' ? prev : 0) + v.n;
    if (v.__op === 'delete') return DELETE_MARK;
    throw new Error('unknown field op ' + v.__op);
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, undefined, now));
  if (isMap(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const r = resolveValue(x, isMap(prev) ? prev[k] : undefined, now);
      if (r !== DELETE_MARK) o[k] = r;
    }
    return o;
  }
  return structuredCloneDeep(v);
}

function mergeDeep(base, add) {
  for (const [k, v] of Object.entries(add)) base[k] = isMap(v) && isMap(base[k]) ? mergeDeep(base[k], v) : v;
  return base;
}

/**
 * Resolve FieldValue sentinels (also inside nested maps) against the existing document.
 * merge  keep the fields that are not mentioned (set(…, {merge:true}) and update())
 * deep   merge nested maps key by key, like set(…, {merge:true}) does in Firestore; update() replaces a whole top-level field
 */
export function resolveFields(existing, fields, now, merge, deep = false) {
  const base = merge && existing ? structuredCloneDeep(existing) : {};
  for (const [k, v] of Object.entries(fields)) {
    const r = resolveValue(v, existing ? existing[k] : undefined, now);
    if (r === DELETE_MARK) delete base[k];
    else base[k] = deep && isMap(r) && isMap(base[k]) ? mergeDeep(base[k], r) : r;
  }
  return base;
}

/* ───────────────────────── engine ───────────────────────── */

export class RulesEngine {
  constructor(text, opts = {}) {
    this.ast = parseRules(text);
    this.tolerant = !!opts.tolerant;
    this.matches = [];
    const top = { wilds: [], funcs: this.ast.items.filter((x) => x.t === 'function') };
    this.collectMatches(this.ast.items, [], [top], this.matches);
  }

  /** Flatten nested match blocks into {segs, chain, allows}; chain keeps per-block wildcards + functions. */
  collectMatches(items, prefix, chain, out) {
    for (const it of items) {
      if (it.t !== 'match') continue;
      const segs = [...prefix, ...it.segs];
      const blk = { wilds: it.segs.filter((s) => s.wild).map((s) => s.wild), funcs: it.items.filter((x) => x.t === 'function') };
      const newChain = [...chain, blk];
      out.push({ segs, chain: newChain, allows: it.items.filter((x) => x.t === 'allow') });
      this.collectMatches(it.items.filter((x) => x.t === 'match'), segs, newChain, out);
    }
  }

  /** Does `docSegs` match the pattern? returns wildcard bindings or null. */
  static bind(patternSegs, docSegs) {
    if (patternSegs.length !== docSegs.length) return null;
    const vars = {};
    for (let i = 0; i < patternSegs.length; i++) {
      const p = patternSegs[i];
      if (p.lit !== undefined) { if (p.lit !== docSegs[i]) return null; }
      else vars[p.wild] = docSegs[i];
    }
    return vars;
  }

  /**
   * Evaluate one operation. op: get | list | create | update | delete.
   * `existing` = pre-state data (undefined if missing); `incoming` = request.resource.data.
   */
  authorize({ op, key, auth, now, db, dbAfter, existing, incoming }) {
    const docSegs = ['databases', '(default)', 'documents', ...key.split('/')];
    const wanted = op === 'get' || op === 'list' ? ['read', op] : ['write', op];
    const request = {
      auth: auth ? { uid: auth.uid, token: auth.token || {} } : null,
      time: new Ts(now),
      resource: incoming === undefined ? null : { data: incoming },
      path: new RPath(docSegs.slice(3)),
      method: op,
    };
    const resource = existing === undefined ? null : { data: existing };
    const counters = { raw: 0, seen: new Set() };
    let allowed = false;
    let lastError = null;
    let matchedAny = false;
    let nodes = 0;
    for (const m of this.matches) {
      const vars = RulesEngine.bind(m.segs, docSegs);
      if (!vars) continue;
      matchedAny = true;
      // Runtime scope chain: globals → one scope per enclosing match block (wildcards + functions).
      let scope = new Scope(null);
      scope.vars.set('request', request);
      scope.vars.set('resource', resource);
      for (const blk of m.chain) {
        scope = new Scope(scope);
        for (const w of blk.wilds) scope.vars.set(w, vars[w]);
        for (const f of blk.funcs) scope.funcs.set(f.name, { ...f, scope });
      }
      for (const a of m.allows) {
        if (!a.ops.some((o) => wanted.includes(o))) continue;
        const ctx = new EvalCtx({ db, dbAfter, counters, tolerant: this.tolerant });
        try {
          const r = evalNode(a.cond, scope, ctx);
          nodes += ctx.nodes;
          if (r === true) allowed = true;
        } catch (e) {
          nodes += ctx.nodes;
          if (e instanceof RuleError) lastError = e.message; else throw e;
        }
        if (allowed) break;
      }
      if (allowed) break;
    }
    return { allowed, calls: counters.seen.size, rawCalls: counters.raw, error: allowed ? null : lastError, matched: matchedAny, nodes };
  }

  /**
   * Evaluate a batch / transaction commit atomically.
   * writes: [{op:'set'|'update'|'delete', key, data, merge?}]
   * Limits modelled: 10 distinct get/exists calls per write, 20 per batch (sum of per-write counts).
   */
  evaluateBatch({ db, auth, now, writes, perOpLimit = 10, batchLimit = 20 }) {
    const dbAfter = db.clone();
    const prepared = writes.map((w) => {
      const existing = db.has(w.key) ? db.get(w.key) : undefined;
      const cur = dbAfter.has(w.key) ? dbAfter.get(w.key) : undefined;
      if (w.op === 'delete') { dbAfter.delete(w.key); return { w, existing, kind: 'delete', incoming: undefined }; }
      let incoming;
      if (w.op === 'update') {
        if (cur === undefined) return { w, existing, kind: 'update', incoming: undefined, missing: true };
        incoming = resolveFields(cur, w.data, now, true);
      } else incoming = resolveFields(cur, w.data, now, !!w.merge, !!w.merge);
      dbAfter.set(w.key, incoming);
      return { w, existing, kind: existing === undefined ? 'create' : 'update', incoming };
    });
    const results = [];
    let total = 0;
    let allowed = true;
    for (const p of prepared) {
      if (p.missing) { results.push({ key: p.w.key, op: 'update', allowed: false, calls: 0, error: 'NOT_FOUND' }); allowed = false; continue; }
      const r = this.authorize({ op: p.kind, key: p.w.key, auth, now, db, dbAfter, existing: p.existing, incoming: p.incoming });
      total += r.calls;
      let ok = r.allowed;
      let error = r.error;
      if (r.calls > perOpLimit) { ok = false; error = `op exceeded ${perOpLimit} get/exists calls (${r.calls})`; }
      results.push({ key: p.w.key, op: p.kind, allowed: ok, calls: r.calls, rawCalls: r.rawCalls, error, nodes: r.nodes });
      if (!ok) allowed = false;
    }
    if (total > batchLimit) {
      allowed = false;
      results.push({ key: '*batch*', op: 'batch', allowed: false, calls: total, error: `batch exceeded ${batchLimit} get/exists calls (${total})` });
    }
    return { allowed, results, totalCalls: total, dbAfter: allowed ? dbAfter : null };
  }

  /**
   * Evaluate a read. For kind 'list', pass `constraints` = the equality filters of the query
   * (as {field: value}); Firestore evaluates list rules against the query constraints, not documents,
   * so `resource.data.<field>` is only defined for constrained fields.
   */
  read({ db, auth, now, key, kind = 'get', constraints }) {
    const existing = kind === 'list' ? (constraints || {}) : (db.has(key) ? db.get(key) : undefined);
    return this.authorize({ op: kind, key, auth, now, db, dbAfter: db, existing, incoming: undefined });
  }
}
