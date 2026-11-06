/*
 * Storefront entry point: theme, language, error handling, auth/cart/wishlist wiring, router, chrome.
 * Pages live in ./pages/*.js (see routes.js); header/footer/tab bar in ./components/.
 */
import { initTheme } from '../core/theme.js';
import { initI18n, onLangChange, t, registerBoth } from '../core/i18n.js';
import { installGlobalErrorHandlers } from '../core/errors.js';
import { toast, toastError, announce } from '../core/ui.js';
import { createRouter, buildQuery } from '../core/router.js';
import { initAuth, onAuthChange, whenAuthReady, isSignedIn } from '../data/auth.js';
import { bindCartToAuth } from '../data/cart.js';
import { bindWishlistToAuth } from '../data/wishlist.js';
import { loadSettings, onSettings, settings } from '../data/settings.js';
import { loadCatalog } from '../data/catalog.js';
import { STORAGE_KEYS } from '../shared/constants.js';
import { routes, notFound } from './routes.js';
import { setRouter, loginUrl } from './lib/links.js';
import { initPwa } from './pwa.js';
import { mountHeader } from './components/header.js';
import { mountFooter } from './components/footer.js';
import { mountTabbar } from './components/tabbar.js';

registerBoth({
  'app.update': ['A new version is ready.', 'নতুন সংস্করণ প্রস্তুত।'],
  'app.updateNow': ['Update', 'আপডেট'],
  'app.online': ['Back online', 'আবার অনলাইনে'],
  'app.offline': ['You are offline. Some things may not load.', 'আপনি অফলাইনে আছেন। কিছু জিনিস লোড নাও হতে পারে।'],
});

initTheme(STORAGE_KEYS.theme);
initI18n({ key: STORAGE_KEYS.lang });
installGlobalErrorHandlers((msg) => toastError(msg));

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

async function guard({ route, path, query }) {
  if (route.meta && route.meta.auth) {
    await withTimeout(whenAuthReady(), 6000);
    if (!isSignedIn()) return loginUrl(path + buildQuery(query));
  }
  return null;
}

const outlet = document.getElementById('main');
const router = createRouter({ mode: 'history', routes, notFound, outlet, guard, announcer: announce });
setRouter(router);

/* ───────────── data wiring ───────────── */
initAuth();
bindCartToAuth(onAuthChange);
bindWishlistToAuth(onAuthChange);
loadSettings();
loadCatalog().catch((e) => console.warn('catalog preload failed', e));   // pages await it again; this just starts the fetch early

/* ───────────── chrome ───────────── */
mountHeader(document.getElementById('site-header'), { router });
mountFooter(document.getElementById('site-footer'), { router });
mountTabbar(document.getElementById('tabbar'), { router });

onLangChange(() => router.reload());

/* ───────────── live chat (optional, configured in Settings → Integrations) ───────────── */
let chatLoaded = false;
function loadChat(s) {
  const c = s.integrations && s.integrations.tawk;
  if (chatLoaded || !c || c.enabled !== true || !/^[a-z0-9]{10,40}$/i.test(c.propertyId || '') || !/^[a-z0-9]{3,20}$/i.test(c.widgetId || '')) return;
  chatLoaded = true;
  const start = () => {
    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_LoadStart = new Date();
    window.Tawk_API.customStyle = { visibility: { desktop: { yOffset: 100 }, mobile: { yOffset: 80 } } };
    const s1 = document.createElement('script');
    s1.async = true; s1.src = `https://embed.tawk.to/${c.propertyId}/${c.widgetId}`; s1.charset = 'UTF-8'; s1.setAttribute('crossorigin', '*');
    document.head.appendChild(s1);
  };
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 4000 }); else setTimeout(start, 2500);
}
onSettings(loadChat);
loadChat(settings());

/* ───────────── PWA & connectivity ───────────── */
initPwa({
  onUpdate: (apply) => toast(t('app.update'), { type: 'info', timeout: 12000, action: { label: t('app.updateNow'), onClick: apply } }),
});
window.addEventListener('offline', () => toast(t('app.offline'), { type: 'warn', timeout: 5000 }));
window.addEventListener('online', () => { toast(t('app.online'), { timeout: 2500 }); loadSettings({ force: true }); });

router.start();
