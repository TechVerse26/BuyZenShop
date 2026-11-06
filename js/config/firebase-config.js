/*
 * Firebase web-app configuration for project "shopverse-signup".
 *
 * These values are PUBLIC identifiers, not secrets: they ship to every browser by design. What
 * protects the data is firestore.rules / storage.rules (and Authentication settings), never this file.
 * Restrict the API key to your domains in Google Cloud Console → APIs & Services → Credentials,
 * and keep "Authorized domains" in Firebase Authentication limited to your own hosts.
 *
 * To use another Firebase project, replace the object below and update .firebaserc.
 */

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const firebaseConfig = {
  apiKey: "AIzaSyDH22biJRJa_1_auI8NxZYrgJw7MJyt1lA",
  authDomain: "buyzenshops.firebaseapp.com",
  projectId: "buyzenshops",
  storageBucket: "buyzenshops.firebasestorage.app",
  messagingSenderId: "855250261492",
  appId: "1:855250261492:web:8f17edcff6a6a525df95a1",
  measurementId: "G-CEDHDB979K"
};

/** Pinned SDK version. The service worker and the CSP allow only this CDN path. */
export const SDK_VERSION = '10.8.2';
export const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
