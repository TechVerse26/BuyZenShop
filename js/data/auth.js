/*
 * Authentication + the signed-in person's profile and staff role.
 *
 *   await initAuth();                       // once, at start-up
 *   const s = getAuthState();               // { ready, user, profile, staff }
 *   onAuthChange((s) => …)                  // fires immediately when ready, then on every change
 *   can('orders.update')                    // UI gating only — firestore.rules are the real enforcement
 *   actor()                                 // { uid, email, role } for the order/inventory planners
 *
 * Staff roles live in staff/{uid} (writable only by Super Admin through the rules). A person with no
 * staff document is a customer. The profile document users/{uid} is created on first sign-in.
 */
import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, sendPasswordResetEmail,
  updateProfile, RecaptchaVerifier, signInWithPhoneNumber, doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from '../core/firebase.js';
import { roleCan } from '../shared/constants.js';
import { normalizePhone } from '../shared/id.js';
import { toMillis } from '../shared/pricing.js';
import { reportError } from '../core/errors.js';

const state = { ready: false, user: null, profile: null, staff: null };
const subs = new Set();
let seq = 0;
let started = false;
let signupName = '';
let resolveReady;
const readyPromise = new Promise((r) => { resolveReady = r; });

export const getAuthState = () => state;
export const whenAuthReady = () => readyPromise;
export function onAuthChange(fn, { immediate = true } = {}) {
  subs.add(fn);
  if (immediate && state.ready) { try { fn(state); } catch (e) { console.error(e); } }
  return () => subs.delete(fn);
}
const emit = () => subs.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });

export const isSignedIn = () => !!state.user;
export const currentUid = () => (state.user ? state.user.uid : null);
export const isStaff = () => !!(state.staff && state.staff.active === true);
export const staffRole = () => (isStaff() ? state.staff.role : null);
/** UI gating only. */
export const can = (perm) => isStaff() && roleCan(state.staff.role, perm);
export const canAny = (perms) => perms.some(can);
/** The identity block the pure planners (orderFlow, inventory …) expect. */
export function actor() {
  if (!state.user || !isStaff()) throw new Error('Not signed in as staff.');
  return { uid: state.user.uid, email: state.user.email || '', role: state.staff.role };
}

const clip = (v, n) => String(v ?? '').slice(0, n);
const basic = (u) => ({ uid: u.uid, email: u.email || '', displayName: u.displayName || '', photoURL: u.photoURL || '', phoneNumber: u.phoneNumber || '', emailVerified: !!u.emailVerified, providerIds: (u.providerData || []).map((p) => p.providerId) });

export function initAuth() {
  if (started) return readyPromise;
  started = true;
  onAuthStateChanged(auth, async (u) => {
    const my = ++seq;
    try {
      if (!u) { state.user = null; state.profile = null; state.staff = null; }
      else {
        state.user = basic(u);
        const [profile, staff] = await Promise.all([
          ensureProfile(u).catch((e) => { reportError(e, 'auth.profile'); return null; }),
          loadStaff(u.uid),
        ]);
        if (my !== seq) return;
        state.profile = profile; state.staff = staff;
      }
    } catch (e) { reportError(e, 'auth.apply'); }
    if (my !== seq) return;
    state.ready = true; resolveReady(); emit();
  });
  getRedirectResult(auth).catch((e) => reportError(e, 'auth.redirect'));
  return readyPromise;
}

/* ───────────────────────── profile & staff documents ───────────────────────── */

const inflight = new Map();
export function ensureProfile(u, hints = {}) {
  if (inflight.has(u.uid)) return inflight.get(u.uid);
  const p = (async () => {
    const ref = doc(db, 'users', u.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const data = {
        displayName: clip(hints.displayName || u.displayName || signupName, 80),
        email: clip(u.email, 120), phone: clip(u.phoneNumber, 20), photoURL: clip(u.photoURL, 600),
        notifyPrefs: { email: true }, createdAt: serverTimestamp(), lastLoginAt: serverTimestamp(),
      };
      await setDoc(ref, data);
      const now = new Date();
      return { id: u.uid, ...data, createdAt: now, lastLoginAt: now };
    }
    const d = { id: snap.id, ...snap.data() };
    if (Date.now() - (toMillis(d.lastLoginAt) || 0) > 6 * 3600 * 1000) updateDoc(ref, { lastLoginAt: serverTimestamp() }).catch(() => {});
    return d;
  })().finally(() => inflight.delete(u.uid));
  inflight.set(u.uid, p);
  return p;
}

async function loadStaff(uid) {
  try {
    const s = await getDoc(doc(db, 'staff', uid));
    if (!s.exists()) return null;
    const d = s.data();
    return { id: uid, role: d.role, active: d.active === true, name: d.name || '', email: d.email || '' };
  } catch (e) { return null; }
}

export async function refreshAuthState() {
  const u = auth.currentUser;
  if (!u) return state;
  const [profile, staff] = await Promise.all([ensureProfile(u).catch(() => state.profile), loadStaff(u.uid)]);
  state.profile = profile; state.staff = staff; emit();
  return state;
}

/** Save the customer's own profile (fields allowed by the rules: displayName, phone, notifyPrefs, defaultAddressId). */
export async function saveProfile(patch) {
  const u = auth.currentUser;
  if (!u) throw new Error('Not signed in');
  const data = {};
  if ('displayName' in patch) data.displayName = clip(patch.displayName, 80).trim();
  if ('phone' in patch) data.phone = clip(normalizePhone(patch.phone) || patch.phone, 20);
  if ('notifyPrefs' in patch) data.notifyPrefs = patch.notifyPrefs;
  if ('defaultAddressId' in patch) data.defaultAddressId = patch.defaultAddressId;
  await updateDoc(doc(db, 'users', u.uid), { ...data, updatedAt: serverTimestamp() });
  if (data.displayName !== undefined) { try { await updateProfile(u, { displayName: data.displayName }); } catch { /* best effort */ } }
  state.profile = { ...(state.profile || {}), ...data };
  if (data.displayName !== undefined) state.user = { ...state.user, displayName: data.displayName };
  emit();
}

/* ───────────────────────── sign-in methods ───────────────────────── */

export async function signInEmail(email, password) {
  return signInWithEmailAndPassword(auth, String(email).trim(), password);
}
export async function signUpEmail({ name, email, password }) {
  signupName = clip(name, 80).trim();
  try {
    const cred = await createUserWithEmailAndPassword(auth, String(email).trim(), password);
    if (signupName) { try { await updateProfile(cred.user, { displayName: signupName }); } catch { /* best effort */ } }
    return cred;
  } finally { signupName = ''; }
}
export async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try { return await signInWithPopup(auth, provider); } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') { await signInWithRedirect(auth, provider); return null; }
    throw e;
  }
}
export const sendPasswordReset = (email) => sendPasswordResetEmail(auth, String(email).trim());
export async function logout() { await signOut(auth); }

let confirmation = null;
let verifier = null;
/** Step 1 of phone sign-in: sends an SMS code. `containerId` is an (empty) element id for the invisible reCAPTCHA. */
export async function startPhoneSignIn(phone, containerId) {
  const local = normalizePhone(phone);
  if (!local) throw Object.assign(new Error('Invalid phone'), { code: 'auth/invalid-phone-number' });
  if (verifier) { try { verifier.clear(); } catch { /* ignore */ } verifier = null; }
  verifier = new RecaptchaVerifier(auth, containerId, { size: 'invisible' });
  confirmation = await signInWithPhoneNumber(auth, `+88${local}`, verifier);
  return true;
}
/** Step 2: confirm the SMS code. */
export async function confirmPhoneCode(code) {
  if (!confirmation) throw Object.assign(new Error('Request a code first'), { code: 'auth/code-expired' });
  const res = await confirmation.confirm(String(code).trim());
  confirmation = null;
  return res;
}
