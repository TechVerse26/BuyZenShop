/*
 * Admin entry point: sign-in gate → role check → layout (sidebar, top bar) → hash router.
 *
 *   not signed in          → sign-in form (email/password or Google)
 *   signed in, no staff doc → "no access" screen that shows the UID (this is also the secure bootstrap
 *                             path for the FIRST Super Admin: create staff/<uid> in the Firebase console)
 *   active staff member    → full panel, menu filtered by role; every page is gated again by firestore.rules
 */
import { initTheme, toggleTheme, effectiveTheme } from '../core/theme.js';
import { initI18n, onLangChange, getLang, setLang, t, pick, lbl, registerBoth } from '../core/i18n.js';
import { installGlobalErrorHandlers, explainError, reportError } from '../core/errors.js';
import { html, render, bindActions, readForm, withBusy, copyText } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, toastError, announce, openMenu, fieldHtml } from '../core/ui.js';
import { createRouter } from '../core/router.js';
import { setMeta } from '../core/dom.js';
import { validateForm, showFormErrors, required, email as emailRule } from '../core/validate.js';
import { initAuth, onAuthChange, whenAuthReady, getAuthState, isStaff, can, signInEmail, signInGoogle, sendPasswordReset, logout, refreshAuthState } from '../data/auth.js';
import { loadSettings, settings, onSettings } from '../data/settings.js';
import { ROLES, STORAGE_KEYS } from '../shared/constants.js';
import { initPwa } from '../core/pwa.js';
import { NAV } from './nav.js';
import { routes, notFound } from './routes.js';

registerBoth({
  'admin.update': ['A new version of the admin panel is ready.', 'অ্যাডমিন প্যানেলের নতুন সংস্করণ প্রস্তুত।'],
  'admin.updateNow': ['Reload', 'রিলোড'],
  'admin.title': ['Admin', 'অ্যাডমিন'],
  'admin.signin': ['Admin sign in', 'অ্যাডমিন লগইন'],
  'admin.signinLead': ['Use the account your store owner added as staff.', 'স্টোর মালিক যে অ্যাকাউন্ট স্টাফ হিসেবে যোগ করেছেন সেটি দিয়ে লগইন করুন।'],
  'admin.password': ['Password', 'পাসওয়ার্ড'],
  'admin.google': ['Continue with Google', 'গুগল দিয়ে চালিয়ে যান'],
  'admin.forgot': ['Forgot password?', 'পাসওয়ার্ড ভুলে গেছেন?'],
  'admin.resetSent': ['Password reset email sent (check spam too).', 'পাসওয়ার্ড রিসেট ইমেইল পাঠানো হয়েছে (স্প্যামও দেখুন)।'],
  'admin.needEmail': ['Enter your email first.', 'আগে ইমেইল দিন।'],
  'admin.noAccessTitle': ['You do not have access', 'আপনার অ্যাক্সেস নেই'],
  'admin.noAccessText': ['Your role does not include this page. Ask a Super Admin if you need it.', 'আপনার রোলে এই পেজ নেই। প্রয়োজন হলে সুপার অ্যাডমিনকে বলুন।'],
  'admin.notStaffTitle': ['This account is not staff', 'এই অ্যাকাউন্ট স্টাফ নয়'],
  'admin.notStaffText': ['You are signed in, but there is no active staff record for this account. A Super Admin can add it under Staff & roles.', 'আপনি লগইন করেছেন, কিন্তু এই অ্যাকাউন্টের জন্য সক্রিয় স্টাফ রেকর্ড নেই। সুপার অ্যাডমিন "স্টাফ ও রোল" থেকে এটি যোগ করতে পারেন।'],
  'admin.firstAdmin': ['Setting up the store for the first time?', 'প্রথমবার স্টোর সেটআপ করছেন?'],
  'admin.firstAdminSteps': ['Deploy firestore.rules, then open Firebase console → Firestore → create collection "staff" → add a document whose ID is your UID (below) with these fields. This is the only way to create the first Super Admin; nothing in the website can do it for you.', 'আগে firestore.rules ডিপ্লয় করুন। তারপর Firebase console → Firestore → "staff" কালেকশন বানিয়ে নিচের UID-কে ডকুমেন্ট আইডি ধরে এই ফিল্ডগুলো দিয়ে একটি ডকুমেন্ট যোগ করুন। প্রথম সুপার অ্যাডমিন বানানোর এটিই একমাত্র উপায়; ওয়েবসাইট থেকে এটি করা যায় না।'],
  'admin.yourUid': ['Your UID', 'আপনার UID'],
  'admin.recheck': ['Check again', 'আবার যাচাই করুন'],
  'admin.viewStore': ['View store', 'স্টোর দেখুন'],
  'admin.menu': ['Menu', 'মেনু'],
  'admin.switchLang': ['বাংলা / English', 'English / বাংলা'],
  'admin.role': ['Role', 'রোল'],
  'admin.authFailed': ['Could not check your sign-in. Check your connection and retry.', 'লগইন যাচাই করা যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।'],
  'admin.notFound': ['Page not found', 'পেজ পাওয়া যায়নি'],
  'admin.goDashboard': ['Go to dashboard', 'ড্যাশবোর্ডে যান'],
});

initTheme(STORAGE_KEYS.adminTheme);
initI18n({ key: STORAGE_KEYS.adminLang });
installGlobalErrorHandlers((msg) => toastError(msg));

const root = document.getElementById('admin-root');
let router = null;
let mountedUid = null;
let unsubNav = null;

/* ───────────────────────── full-screen views ───────────────────────── */

const loadingView = () => render(root, html`<div class="auth-screen"><span class="spinner" role="status" aria-label="${t('common.loading')}"></span></div>`);

function loginView() {
  setMeta({ title: t('admin.signin'), siteName: 'Shop Verse Admin', noindex: true });
  render(root, html`<div class="auth-screen"><div class="auth-card">
    <div class="row gap-3 mb-4"><span class="avatar" style="background:var(--brand-600);color:var(--on-brand)">${icon('store')}</span><strong>${settings().storeName} · ${t('admin.title')}</strong></div>
    <h1>${t('admin.signin')}</h1><p class="muted mb-6">${t('admin.signinLead')}</p>
    <form data-form="login" class="stack" novalidate>
      ${fieldHtml({ name: 'email', label: t('common.email'), type: 'email', required: true, autocomplete: 'username', attrs: { autofocus: true } })}
      ${fieldHtml({ name: 'password', label: t('admin.password'), type: 'password', required: true, autocomplete: 'current-password' })}
      <div class="field-error" id="form-error" role="alert"></div>
      <button class="btn btn-primary btn-block" type="submit">${t('common.signIn')}</button>
      <button class="btn btn-block" type="button" data-action="google">${t('admin.google')}</button>
      <button class="btn btn-link" type="button" data-action="forgot" style="align-self:center">${t('admin.forgot')}</button>
    </form>
    <div class="row mt-6" style="justify-content:space-between">
      <button class="btn btn-ghost btn-sm" type="button" data-action="lang">${icon('globe')} ${t('admin.switchLang')}</button>
      <button class="btn btn-ghost btn-sm" type="button" data-action="theme">${icon(effectiveTheme() === 'dark' ? 'sun' : 'moon')}</button>
    </div></div></div>`);
  const form = root.querySelector('form');
  const err = root.querySelector('#form-error');
  const fail = (e) => { err.textContent = explainError(e); };
  bindActions(root, {
    google: async (btn) => { err.textContent = ''; try { await withBusy(btn, signInGoogle); } catch (e) { fail(e); } },
    forgot: async (btn) => {
      const em = form.elements.email.value.trim();
      if (!em) { err.textContent = t('admin.needEmail'); form.elements.email.focus(); return; }
      try { await withBusy(btn, () => sendPasswordReset(em)); toast(t('admin.resetSent')); } catch (e) { fail(e); }
    },
    lang: () => setLang(getLang() === 'bn' ? 'en' : 'bn'),
    theme: () => { toggleTheme(STORAGE_KEYS.adminTheme); loginView(); },
  }, {
    submit: {
      login: async () => {
        err.textContent = '';
        const v = readForm(form);
        const res = validateForm(v, { email: [required, emailRule], password: [required] });
        if (!showFormErrors(form, res.errors)) return;
        try { await withBusy(form.querySelector('[type=submit]'), () => signInEmail(v.email, v.password)); } catch (e) { fail(e); }
      },
    },
  });
}

function noAccessView(s) {
  setMeta({ title: t('admin.notStaffTitle'), siteName: 'Shop Verse Admin', noindex: true });
  const snippet = JSON.stringify({ role: 'super_admin', active: true, email: s.user.email, name: s.user.displayName || '', createdAt: '(timestamp: now)' }, null, 2);
  render(root, html`<div class="auth-screen"><div class="auth-card" style="max-width:560px">
    <span class="avatar mb-4" style="background:var(--warning-bg);color:var(--warning)">${icon('lock')}</span>
    <h1>${t('admin.notStaffTitle')}</h1>
    <p class="muted mb-4">${t('admin.notStaffText')}</p>
    <dl class="kv mb-4"><dt>${t('common.email')}</dt><dd>${s.user.email || '—'}</dd><dt>${t('admin.yourUid')}</dt><dd class="mono">${s.user.uid} <button class="btn btn-ghost btn-sm" data-action="copy-uid" aria-label="${t('common.copy')}">${icon('copy')}</button></dd></dl>
    <details class="mb-4"><summary class="strong" style="cursor:pointer">${t('admin.firstAdmin')}</summary>
      <p class="small muted mt-2">${t('admin.firstAdminSteps')}</p><pre class="code-block mt-2">${snippet}</pre></details>
    <div class="row row-wrap gap-2">
      <button class="btn btn-primary" data-action="recheck">${icon('refresh')} ${t('admin.recheck')}</button>
      <a class="btn" href="/" data-native>${icon('store')} ${t('admin.viewStore')}</a>
      <button class="btn btn-ghost" data-action="logout">${icon('log-out')} ${t('common.signOut')}</button>
    </div></div></div>`);
  bindActions(root, {
    'copy-uid': async () => { if (await copyText(s.user.uid)) toast(t('common.copied'), { timeout: 1500 }); },
    recheck: async (btn) => { await withBusy(btn, refreshAuthState); },
    logout: () => logout(),
  });
}

/* ───────────────────────── layout ───────────────────────── */

const visible = (perm) => perm === null || perm === undefined || (Array.isArray(perm) ? perm.some(can) : can(perm));

function navHtml(activeId) {
  return html`${NAV.map((g) => {
    const items = g.items.filter((i) => !i.soon && visible(i.perm));
    if (!items.length) return '';
    return html`<div class="nav-group">${pick(...g.group)}</div>${items.map((i) => html`<a class="nav-link" href="${router ? router.href(i.path) : '#' + i.path}" ${i.id === activeId ? html`aria-current="page"` : ''}>${icon(i.icon)}<span>${pick(...i.label)}</span></a>`)}`;
  })}`;
}

function mountLayout(s) {
  const role = ROLES[s.staff.role];
  render(root, html`<div class="admin-app" id="admin-app">
    <aside class="admin-side" id="admin-side" aria-label="${t('admin.menu')}">
      <div class="admin-brand"><span class="logo">${icon('store')}</span><div><span data-bind="store">${settings().storeName}</span><small>${t('admin.title')}</small></div></div>
      <nav class="admin-nav" id="admin-nav" aria-label="${t('admin.menu')}"></nav>
    </aside>
    <div class="admin-scrim" data-action="close-nav"></div>
    <div class="admin-main">
      <header class="admin-top">
        <button class="btn btn-ghost btn-icon admin-menu-btn" data-action="open-nav" aria-label="${t('admin.menu')}">${icon('menu')}</button>
        <div class="title truncate" id="admin-title"></div>
        <span class="ms-auto"></span>
        <span class="badge badge-brand only-desktop" title="${t('admin.role')}">${lbl(role)}</span>
        <button class="btn btn-ghost btn-sm" data-action="lang" aria-label="${t('common.language')}">${icon('globe')}<span class="only-desktop">${getLang() === 'bn' ? 'EN' : 'বাং'}</span></button>
        <button class="btn btn-ghost btn-icon btn-sm" data-action="theme" aria-label="${t('common.theme')}">${icon(effectiveTheme() === 'dark' ? 'sun' : 'moon')}</button>
        <button class="btn btn-ghost btn-sm" data-action="user" aria-haspopup="menu" aria-expanded="false"><span class="avatar" style="width:28px;height:28px;font-size:var(--fs-xs)">${(s.user.displayName || s.user.email || '?').trim()[0].toUpperCase()}</span></button>
      </header>
      <main class="admin-content" id="admin-main" tabindex="-1"></main>
    </div>
  </div>`);
  const app = root.querySelector('#admin-app');
  const closeNav = () => app.classList.remove('nav-open');
  bindActions(root, {
    'open-nav': () => app.classList.add('nav-open'),
    'close-nav': closeNav,
    lang: () => setLang(getLang() === 'bn' ? 'en' : 'bn'),
    theme: () => { toggleTheme(STORAGE_KEYS.adminTheme); mountLayoutChrome(); },
    user: (btn) => openMenu({
      anchor: btn,
      items: [
        { label: s.user.email || s.user.uid, icon: 'user', onClick: () => {} },
        { divider: true },
        { label: t('admin.viewStore'), icon: 'store', href: '/', native: true },
        { label: t('common.signOut'), icon: 'log-out', onClick: () => logout() },
      ],
    }),
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  const outlet = root.querySelector('#admin-main');

  router = createRouter({
    mode: 'hash', base: '/admin/', routes, notFound, outlet, announcer: announce,
    guard: async ({ route }) => {
      const p = route.meta && route.meta.perm;
      return visible(p) ? null : '/forbidden';
    },
    onChange: ({ route }) => {
      const title = route && route.meta && route.meta.title ? pick(...route.meta.title) : '';
      root.querySelector('#admin-title').textContent = title;
      setMeta({ title, siteName: `${settings().storeName} Admin`, noindex: true });
      render(root.querySelector('#admin-nav'), navHtml(route && route.meta ? route.meta.nav : ''));
      closeNav();
    },
  });
  router.start();
}

function mountLayoutChrome() {
  // theme toggle icon only: re-draw the button without touching the page
  const btn = root.querySelector('[data-action="theme"]');
  if (btn) render(btn, icon(effectiveTheme() === 'dark' ? 'sun' : 'moon'));
}

/* ───────────────────────── state machine ───────────────────────── */

async function draw(s) {
  if (!s.ready) { loadingView(); return; }
  if (!s.user) {
    if (router) { await router.stop(); router = null; }
    mountedUid = null; loginView(); return;
  }
  if (!isStaff()) {
    if (router) { await router.stop(); router = null; }
    mountedUid = null; noAccessView(s); return;
  }
  if (mountedUid === s.user.uid && router) return;           // already showing this staff member's panel
  mountedUid = s.user.uid;
  mountLayout(s);
}

onLangChange(() => {
  const s = getAuthState();
  if (s.ready && s.user && isStaff() && router) { const keep = location.hash; mountedUid = null; draw(s).then(() => { location.hash = keep; }); }
  else draw(s);
});
onSettings(() => { const el = root.querySelector('[data-bind="store"]'); if (el) el.textContent = settings().storeName; });

initPwa({ onUpdate: (apply) => toast(t('admin.update'), { type: 'info', timeout: 12000, action: { label: t('admin.updateNow'), onClick: apply } }) });

(async function boot() {
  loadingView();
  initAuth();
  const ok = await Promise.race([whenAuthReady().then(() => true), new Promise((r) => setTimeout(() => r(false), 12000))]);
  if (!ok) {
    render(root, html`<div class="auth-screen"><div class="auth-card center"><p class="mb-4">${t('admin.authFailed')}</p><button class="btn btn-primary" data-action="reload">${t('common.retry')}</button></div></div>`);
    bindActions(root, { reload: () => location.reload() });
    return;
  }
  loadSettings().catch((e) => reportError(e, 'admin.settings'));
  onAuthChange((s) => { draw(s).catch((e) => reportError(e, 'admin.draw')); });
})();
