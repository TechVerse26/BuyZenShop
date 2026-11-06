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
export const firebaseConfig = {
  apiKey: 'AIzaSyD_2mcIc6bsva2zJiAJl9vBZCn_d7K4-2Y',
  authDomain: 'shopverse-signup.firebaseapp.com',
  projectId: 'shopverse-signup',
  storageBucket: 'shopverse-signup.firebasestorage.app',
  messagingSenderId: '139812126519',
  appId: '1:139812126519:web:30efeceee0b54a0a5964b2',
};

/** Pinned SDK version. The service worker and the CSP allow only this CDN path. */
export const SDK_VERSION = '10.8.1';
export const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
