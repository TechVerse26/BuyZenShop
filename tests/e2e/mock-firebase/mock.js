/*
 * In-browser stand-in for the Firebase Web SDK (app + auth + firestore + storage). Used ONLY by tests/e2e.
 *
 * Firestore operations are checked against the REAL firestore.rules by the same interpreter the unit tests use
 * (tests/rules/rules-engine.mjs): a read, query or write that production would deny fails here too, and a query that
 * would need a composite index fails with `failed-precondition` (the project ships no composite indexes).
 * Storage uploads are accepted without checking storage.rules (the interpreter only knows Firestore rules).
 *
 * Playwright serves `export * from '<this file>'` for every https://www.gstatic.com/firebasejs/10.8.1/*.js request.
 * Test hooks: window.__MOCK__ = { db, log: { denied[], index[], writes[] }, files, users, signIn(uid), signOutNow(), dump(prefix), patch(key, (doc, Ts) => …), put(key, (Ts) => doc), remove(key) }.
 * Data survives page loads inside one browser context (sessionStorage), so multi-page flows can be tested.
 */
import { RulesEngine, MemDb, Ts, FieldValue, structuredCloneDeep as clone } from '/tests/rules/rules-engine.mjs';

/* ───────── Timestamp ───────── */
Ts.prototype.toDate = Ts.prototype.toDate || function toDate() { return new Date(this.ms); };
Object.defineProperty(Ts.prototype, 'seconds', { get() { return Math.floor(this.ms / 1000); }, configurable: true });
Object.defineProperty(Ts.prototype, 'nanoseconds', { get() { return (this.ms % 1000) * 1e6; }, configurable: true });
Ts.fromMillis = (ms) => new Ts(ms);
Ts.fromDate = (d) => new Ts(d.getTime());
Ts.now = () => new Ts(Date.now());
export const Timestamp = Ts;
export const serverTimestamp = FieldValue.serverTimestamp;
export const increment = FieldValue.increment;
export const deleteField = FieldValue.deleteField;

class FirebaseError extends Error {
  constructor(code, message) { super(message); this.name = 'FirebaseError'; this.code = code; }
}

/* ───────── state ───────── */
const seed = window.__SEED__ || { docs: {}, users: [], signedInAs: null };
const SS = {
  get(k) { try { return window.sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.sessionStorage.setItem(k, v); } catch { /* ignore */ } },
};
const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if (Object.keys(v).length === 1 && typeof v.__ts === 'number') return new Ts(v.__ts);
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = revive(x);
    return o;
  }
  return v;
};
const loadEntries = () => {
  const saved = SS.get('__mock_db');
  if (saved) { try { return JSON.parse(saved).map(([k, v]) => [k, revive(v)]); } catch { /* fall back to the seed */ } }
  return Object.entries(seed.docs || {}).map(([k, v]) => [k, revive(v)]);
};
let db = new MemDb(loadEntries());
const persistDb = () => SS.set('__mock_db', JSON.stringify([...db.m.entries()]));

const rulesText = await (await fetch('/firestore.rules')).text();
const engine = new RulesEngine(rulesText);
const log = { denied: [], index: [], writes: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ───────── auth ───────── */
const users = new Map(((() => { const s = SS.get('__mock_users'); if (s) { try { return JSON.parse(s); } catch { /* seed */ } } return seed.users || []; })()).map((u) => [u.uid, { ...u }]));
const persistUsers = () => SS.set('__mock_users', JSON.stringify([...users.values()]));
const mkUser = (u) => ({
  uid: u.uid, email: u.email || '', displayName: u.displayName || '', photoURL: u.photoURL || '', phoneNumber: u.phoneNumber || '',
  emailVerified: true, isAnonymous: false, providerData: [{ providerId: u.provider || 'password' }],
  getIdToken: async () => `mock-token-${u.uid}`, getIdTokenResult: async () => ({ token: 'mock', claims: {} }), reload: async () => {},
});
let current = null;
const savedUid = SS.get('__mock_uid');
const startUid = savedUid !== null ? savedUid : (seed.signedInAs || '');
if (startUid && users.has(startUid)) current = mkUser(users.get(startUid));
const authListeners = new Set();
const authInfo = () => (current ? { uid: current.uid, token: { email: current.email, email_verified: true } } : null);
const setCurrent = (u) => { current = u ? mkUser(u) : null; SS.set('__mock_uid', current ? current.uid : ''); authListeners.forEach((fn) => { try { fn(current); } catch (e) { console.error(e); } }); };
const authObj = { name: 'mock-auth', get currentUser() { return current; } };

export const initializeApp = (options) => ({ name: '[DEFAULT]', options });
export const getApp = () => ({ name: '[DEFAULT]' });
export const getAuth = () => authObj;
export function onAuthStateChanged(_auth, cb) {
  authListeners.add(cb);
  setTimeout(() => cb(current), 0);
  return () => authListeners.delete(cb);
}
const byEmail = (email) => [...users.values()].find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
export async function signInWithEmailAndPassword(_a, email, password) {
  await tick();
  const u = byEmail(email);
  if (!u || u.password !== password) throw new FirebaseError('auth/invalid-credential', 'Firebase: Error (auth/invalid-credential).');
  setCurrent(u);
  return { user: current };
}
export async function createUserWithEmailAndPassword(_a, email, password) {
  await tick();
  if (byEmail(email)) throw new FirebaseError('auth/email-already-in-use', 'Firebase: Error (auth/email-already-in-use).');
  if (String(password).length < 6) throw new FirebaseError('auth/weak-password', 'Firebase: Error (auth/weak-password).');
  const u = { uid: `u_${Math.random().toString(36).slice(2, 10)}`, email, password, displayName: '' };
  users.set(u.uid, u); persistUsers(); setCurrent(u);
  return { user: current };
}
export async function signOut() { await tick(); setCurrent(null); }
export class GoogleAuthProvider { constructor() { this.providerId = 'google.com'; } }
export async function signInWithPopup() {
  await tick();
  let u = [...users.values()].find((x) => x.provider === 'google.com');
  if (!u) { u = { uid: 'g_google', email: 'google.user@example.com', displayName: 'Google User', provider: 'google.com' }; users.set(u.uid, u); persistUsers(); }
  setCurrent(u);
  return { user: current };
}
export async function signInWithRedirect() { throw new FirebaseError('auth/operation-not-supported-in-this-environment', 'mock: redirect sign-in is not available'); }
export async function getRedirectResult() { return null; }
export async function sendPasswordResetEmail(_a, email) {
  await tick();
  if (!byEmail(email)) throw new FirebaseError('auth/user-not-found', 'Firebase: Error (auth/user-not-found).');
  log.writes.push(`password-reset ${email}`);
}
export async function updateProfile(user, patch) {
  const u = users.get(user.uid);
  if (u) { Object.assign(u, patch); persistUsers(); }
  Object.assign(user, patch);
}
export class RecaptchaVerifier { constructor() { this.type = 'recaptcha'; } render() { return Promise.resolve(0); } clear() {} }
export async function signInWithPhoneNumber(_a, phone) {
  await tick();
  return {
    async confirm(code) {
      if (String(code) !== '123456') throw new FirebaseError('auth/invalid-verification-code', 'Firebase: Error (auth/invalid-verification-code).');
      const uid = `p_${String(phone).replace(/\D/g, '')}`;
      let u = users.get(uid);
      if (!u) { u = { uid, email: '', phoneNumber: String(phone), displayName: '', provider: 'phone' }; users.set(uid, u); persistUsers(); }
      setCurrent(u);
      return { user: current };
    },
  };
}

/* ───────── firestore: refs ───────── */
const segs = (p) => String(p).split('/').filter(Boolean);
const docRefOf = (path) => ({ type: 'document', path, id: segs(path).pop() });
const colRefOf = (path) => ({ type: 'collection', path, id: segs(path).pop() });
export const getFirestore = () => ({ type: 'firestore' });
export const doc = (_db, ...p) => docRefOf(p.join('/'));
export const collection = (_db, ...p) => colRefOf(p.join('/'));
export const where = (f, op, v) => ({ t: 'where', f, op, v });
export const orderBy = (f, dir = 'asc') => ({ t: 'orderBy', f, dir });
export const limit = (n) => ({ t: 'limit', n });
export const startAfter = (v) => ({ t: 'startAfter', v });
export const query = (col, ...constraints) => ({ type: 'query', path: col.path, constraints });

class DocSnap {
  constructor(id, path, data) { this.id = id; this.ref = docRefOf(path); this._d = data; this.metadata = { fromCache: false, hasPendingWrites: false }; }
  exists() { return this._d !== undefined; }
  data() { return this._d === undefined ? undefined : clone(this._d); }
  get(f) { return getField(this._d, f); }
}
class QuerySnap {
  constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; this.metadata = { fromCache: false, hasPendingWrites: false }; }
  forEach(fn) { this.docs.forEach(fn); }
  docChanges() { return []; }
}

/* ───────── firestore: reads ───────── */
const getField = (d, p) => String(p).split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), d);
const norm = (v) => (v instanceof Ts ? v.ms : v);
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const cmp = (a, b) => {
  const x = norm(a); const y = norm(b);
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
};
function passes(d, { f, op, v }) {
  const x = getField(d, f);
  if (x === undefined) return false;
  switch (op) {
    case '==': return eq(x, v);
    case '!=': return !eq(x, v);
    case '<': return cmp(x, v) < 0;
    case '<=': return cmp(x, v) <= 0;
    case '>': return cmp(x, v) > 0;
    case '>=': return cmp(x, v) >= 0;
    case 'in': return v.some((y) => eq(x, y));
    case 'not-in': return !v.some((y) => eq(x, y));
    case 'array-contains': return Array.isArray(x) && x.some((y) => eq(y, v));
    case 'array-contains-any': return Array.isArray(x) && x.some((y) => v.some((z) => eq(y, z)));
    default: throw new FirebaseError('invalid-argument', `mock: unsupported operator ${op}`);
  }
}

function authorize(kind, key, constraints) {
  const r = engine.read({ db, auth: authInfo(), now: Date.now(), key, kind, constraints });
  if (!r.allowed) {
    log.denied.push({ kind, key: kind === 'list' ? key.replace(/\/__list__$/, '') : key, constraints: constraints || null, uid: current ? current.uid : null, error: r.error || 'no allow rule matched' });
    throw new FirebaseError('permission-denied', 'Missing or insufficient permissions.');
  }
}

const directChildren = (col) => {
  const out = [];
  const pre = `${col}/`;
  for (const k of db.keys()) {
    if (!k.startsWith(pre)) continue;
    const rest = k.slice(pre.length);
    if (!rest.includes('/')) out.push([rest, db.get(k)]);
  }
  return out;
};

function runQuery(q) {
  const filters = q.constraints.filter((c) => c.t === 'where');
  const orders = q.constraints.filter((c) => c.t === 'orderBy');
  const lim = q.constraints.find((c) => c.t === 'limit');
  const after = q.constraints.find((c) => c.t === 'startAfter');
  const cons = {};
  for (const c of filters) if (c.op === '==') cons[c.f] = c.v;
  authorize('list', `${q.path}/__list__`, cons);
  if (orders.length > 1 || (orders.length === 1 && filters.some((c) => c.f !== orders[0].f))) {
    log.index.push({ path: q.path, filters: filters.map((c) => `${c.f} ${c.op}`), orders: orders.map((o) => o.f) });
    throw new FirebaseError('failed-precondition', 'The query requires an index. (mock: a composite index would be needed)');
  }
  let rows = directChildren(q.path).filter(([, d]) => filters.every((c) => passes(d, c)));
  for (const o of orders) rows = rows.filter(([, d]) => getField(d, o.f) !== undefined);
  rows.sort((a, b) => {
    for (const o of orders) { const r = cmp(getField(a[1], o.f), getField(b[1], o.f)); if (r) return o.dir === 'desc' ? -r : r; }
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  if (after && after.v && after.v.id) { const i = rows.findIndex(([id]) => id === after.v.id); if (i >= 0) rows = rows.slice(i + 1); }
  if (lim) rows = rows.slice(0, lim.n);
  return rows.map(([id, d]) => new DocSnap(id, `${q.path}/${id}`, d));
}

const docSnapOf = (ref) => new DocSnap(ref.id, ref.path, db.has(ref.path) ? db.get(ref.path) : undefined);

export async function getDoc(ref) { await tick(); authorize('get', ref.path); return docSnapOf(ref); }
export async function getDocs(target) {
  await tick();
  return new QuerySnap(runQuery(target.type === 'collection' ? { path: target.path, constraints: [] } : target));
}

const listeners = new Set();
export function onSnapshot(target, next, error) {
  const entry = { alive: true };
  entry.fire = () => {
    if (!entry.alive) return;
    try {
      if (target.type === 'document') { authorize('get', target.path); next(docSnapOf(target)); }
      else next(new QuerySnap(runQuery(target.type === 'collection' ? { path: target.path, constraints: [] } : target)));
    } catch (e) { entry.alive = false; listeners.delete(entry); if (error) error(e); else console.error(e); }
  };
  listeners.add(entry);
  setTimeout(entry.fire, 0);
  return () => { entry.alive = false; listeners.delete(entry); };
}
const notify = () => listeners.forEach((l) => setTimeout(l.fire, 0));

/* ───────── firestore: writes (rules evaluated per atomic batch) ───────── */
function commit(writes) {
  if (!writes.length) return;
  const res = engine.evaluateBatch({ db, auth: authInfo(), now: Date.now(), writes });
  if (!res.allowed) {
    const bad = res.results.filter((r) => !r.allowed);
    if (bad.some((r) => r.error === 'NOT_FOUND')) throw new FirebaseError('not-found', 'No document to update.');
    log.denied.push({ kind: 'write', uid: current ? current.uid : null, ops: bad.map((r) => `${r.op} ${r.key}: ${r.error || 'denied'}`) });
    throw new FirebaseError('permission-denied', 'Missing or insufficient permissions.');
  }
  db = res.dbAfter;
  persistDb();
  for (const w of writes) log.writes.push(`${w.op} ${w.key}`);
  notify();
}
export function writeBatch() {
  const writes = [];
  const b = {
    set(ref, data, opts) { writes.push({ op: 'set', key: ref.path, data, merge: !!(opts && opts.merge) }); return b; },
    update(ref, data) { writes.push({ op: 'update', key: ref.path, data }); return b; },
    delete(ref) { writes.push({ op: 'delete', key: ref.path }); return b; },
    async commit() { await tick(); commit(writes); },
  };
  return b;
}
export async function setDoc(ref, data, opts) { await tick(); commit([{ op: 'set', key: ref.path, data, merge: !!(opts && opts.merge) }]); }
export async function updateDoc(ref, data) { await tick(); commit([{ op: 'update', key: ref.path, data }]); }
export async function deleteDoc(ref) { await tick(); commit([{ op: 'delete', key: ref.path }]); }

/* ───────── storage ───────── */
const files = new Map();
export const getStorage = () => ({ type: 'storage' });
export const ref = (_s, path) => ({ fullPath: path, name: String(path).split('/').pop() });
export function uploadBytesResumable(r, blob) {
  const h = {};
  const task = {
    snapshot: { ref: r, bytesTransferred: 0, totalBytes: blob.size, state: 'running' },
    on(_ev, next, err, done) { h.next = next; h.err = err; h.done = done; return () => {}; },
    cancel() {},
  };
  const finished = new Promise((resolve) => {
    setTimeout(() => {
      files.set(r.fullPath, { url: `https://mock-storage.test/o/${encodeURIComponent(r.fullPath)}?alt=media`, size: blob.size, type: blob.type });   // like the real thing: an https link (tests/e2e/lib.mjs answers it with a 1×1 PNG)
      task.snapshot = { ref: r, bytesTransferred: blob.size, totalBytes: blob.size, state: 'success' };
      if (h.next) h.next(task.snapshot);
      if (h.done) h.done();
      resolve(task.snapshot);
    }, 10);
  });
  task.then = (a, b) => finished.then(a, b);
  task.catch = (b) => finished.catch(b);
  return task;
}
export async function getDownloadURL(r) {
  const f = files.get(r.fullPath);
  if (!f) throw new FirebaseError('storage/object-not-found', 'mock: no such object');
  return f.url;
}
export async function deleteObject(r) { files.delete(r.fullPath); }

/* ───────── test hooks ───────── */
window.__MOCK__ = {
  engine,
  get db() { return db; },
  log, files, users,
  signIn(uid) { const u = users.get(uid); if (!u) throw new Error(`no mock user ${uid}`); setCurrent(u); },
  signOutNow() { setCurrent(null); },
  dump(prefix) { return [...db.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]); },
  /** Change a document behind the app's back (another customer bought the last item, staff changed a price, time passed …). */
  patch(key, fn) { const d = clone(db.get(key)); fn(d, Ts); db.set(key, d); persistDb(); notify(); }, // notify(): open realtime listeners see the change
  /** Create (or replace) a document behind the app's back — e.g. a product of the old site. `fn(Ts)` returns the document. */
  put(key, fn) { db.set(key, fn(Ts)); persistDb(); notify(); },
  /** Remove a document behind the app's back. */
  remove(key) { db.m.delete(key); persistDb(); notify(); },
};
