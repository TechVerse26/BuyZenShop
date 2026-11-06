/*
 * Service worker registration, update prompt and install prompt.
 *   initPwa({ onUpdate(apply) })   – onUpdate gets a function that activates the waiting worker
 *   canInstall() / promptInstall() / onInstallAvailable(fn)
 * The worker itself is /sw.js: pages network-only (offline page on failure), same-origin code/images network-first; Firebase/Firestore/Auth traffic is never touched.
 * Used by the storefront and the admin panel.
 */
let deferredPrompt = null;
const installListeners = new Set();

export const canInstall = () => !!deferredPrompt;
export function onInstallAvailable(fn) { installListeners.add(fn); if (deferredPrompt) fn(true); return () => installListeners.delete(fn); }
export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null; installListeners.forEach((fn) => fn(false));
  return outcome === 'accepted';
}

export function initPwa({ onUpdate } = {}) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installListeners.forEach((fn) => fn(true)); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; installListeners.forEach((fn) => fn(false)); });

  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  // Reload once when a NEW version takes over — but not on the very first install (clients.claim() also fires controllerchange then).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController || reloading) return; reloading = true; location.reload(); });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const offer = (worker) => { if (onUpdate) onUpdate(() => worker.postMessage({ type: 'SKIP_WAITING' })); };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch (e) { console.warn('Service worker registration failed', e); }
  });
}
