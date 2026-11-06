/*
 * The ONLY file that imports the Firebase SDK (pinned 10.8.1 from gstatic).
 * Everything else imports from here, which keeps the API surface small and lets the test harness
 * swap the SDK for an in-browser mock (tests/e2e/mock-firebase) by intercepting these exact URLs.
 *
 * Static import specifiers must be literals: if you change the version, change SDK_VERSION in
 * js/config/firebase-config.js too (tools/check-syntax.mjs verifies they agree).
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, sendPasswordResetEmail,
  updateProfile, RecaptchaVerifier, signInWithPhoneNumber,
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, query, where,
  orderBy, limit, startAfter, onSnapshot, serverTimestamp, increment, deleteField, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { firebaseConfig, SDK_BASE } from '../config/firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, sendPasswordResetEmail,
  updateProfile, RecaptchaVerifier, signInWithPhoneNumber,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, query, where, orderBy, limit,
  startAfter, onSnapshot, serverTimestamp, increment, deleteField, Timestamp,
};

/** Storage is only needed by the admin panel (image uploads), so it is loaded on demand. */
let storagePromise = null;
export function storageApi() {
  if (!storagePromise) {
    storagePromise = import(`${SDK_BASE}/firebase-storage.js`).then((m) => ({
      storage: m.getStorage(app), ref: m.ref, uploadBytesResumable: m.uploadBytesResumable,
      getDownloadURL: m.getDownloadURL, deleteObject: m.deleteObject,
    }));
  }
  return storagePromise;
}
