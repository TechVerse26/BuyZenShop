/*
 * Sign in / create account / password reset / phone code: one form, two hosts.
 *   openAuthModal({ mode, onSuccess }) → Promise<boolean>        dialog; focus moves in and back, Esc closes
 *   mountAuthForm(el, { mode, onDone, heading, onMode }) → fn     the same form inline (login page); returns a disposer
 * Talks to js/data/auth.js only. Failures go through explainError (never e.message) and credentials are never logged.
 */
import { html, render, readForm, bindActions, withBusy, focusFirst } from '../../core/dom.js';
import { openModal, fieldHtml, toast } from '../../core/ui.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import {
  validateForm, showFormErrors, required, minLen, maxLen, custom,
  password as passwordRule, email as emailRule, phone as phoneRule,
} from '../../core/validate.js';
import { explainError, reportError } from '../../core/errors.js';
import {
  isSignedIn, onAuthChange, getAuthState, signInEmail, signUpEmail, signInGoogle,
  sendPasswordReset, startPhoneSignIn, confirmPhoneCode,
} from '../../data/auth.js';

registerBoth({
  'auth.signUp': ['Create account', 'অ্যাকাউন্ট খুলুন'],
  'auth.reset': ['Reset password', 'পাসওয়ার্ড রিসেট'],
  'auth.phoneTitle': ['Sign in with phone', 'ফোন নম্বর দিয়ে লগইন'],
  'auth.subSignin': ['Sign in to see your orders and saved items.', 'আপনার অর্ডার ও পছন্দের তালিকা দেখতে লগইন করুন।'],
  'auth.subSignup': ['Create an account to track orders and check out faster.', 'অর্ডার ট্র্যাক করতে এবং দ্রুত কেনাকাটা সারতে অ্যাকাউন্ট খুলুন।'],
  'auth.subReset': ['Enter your email. We will send you a link to set a new password.', 'আপনার ইমেইল দিন। নতুন পাসওয়ার্ড দেওয়ার জন্য একটি লিংক পাঠানো হবে।'],
  'auth.subPhone': ['We will text a 6-digit code to your mobile number.', 'আপনার মোবাইল নম্বরে ৬ সংখ্যার একটি কোড এসএমএস করা হবে।'],
  'auth.name': ['Full name', 'পূর্ণ নাম'],
  'auth.email': ['Email', 'ইমেইল'],
  'auth.password': ['Password', 'পাসওয়ার্ড'],
  'auth.passwordHint': ['At least 8 characters.', 'কমপক্ষে ৮টি অক্ষর।'],
  'auth.showPw': ['Show password', 'পাসওয়ার্ড দেখান'],
  'auth.hidePw': ['Hide password', 'পাসওয়ার্ড লুকান'],
  'auth.forgot': ['Forgot password?', 'পাসওয়ার্ড ভুলে গেছেন?'],
  'auth.submitSignin': ['Sign in', 'লগইন করুন'],
  'auth.submitSignup': ['Create account', 'অ্যাকাউন্ট খুলুন'],
  'auth.submitReset': ['Send reset link', 'রিসেট লিংক পাঠান'],
  'auth.noAccount': ['New here?', 'নতুন এসেছেন?'],
  'auth.haveAccount': ['Already have an account?', 'আগেই অ্যাকাউন্ট আছে?'],
  'auth.toSignup': ['Create an account', 'অ্যাকাউন্ট খুলুন'],
  'auth.toSignin': ['Sign in', 'লগইন করুন'],
  'auth.backToSignin': ['Back to sign in', 'লগইনে ফিরে যান'],
  'auth.backToEmail': ['Use email instead', 'ইমেইল দিয়ে লগইন করুন'],
  'auth.or': ['or', 'অথবা'],
  'auth.google': ['Continue with Google', 'গুগল দিয়ে চালিয়ে যান'],
  'auth.usePhone': ['Sign in with phone number', 'ফোন নম্বর দিয়ে লগইন'],
  'auth.phoneLabel': ['Mobile number', 'মোবাইল নম্বর'],
  'auth.phoneHint': ['For example 01XXXXXXXXX', 'যেমন ০১XXXXXXXXX'],
  'auth.sendCode': ['Send code', 'কোড পাঠান'],
  'auth.code': ['Verification code', 'ভেরিফিকেশন কোড'],
  'auth.codeFormat': ['Enter the 6-digit code.', '৬ সংখ্যার কোডটি দিন।'],
  'auth.verify': ['Verify and sign in', 'যাচাই করে লগইন করুন'],
  'auth.changeNumber': ['Use a different number', 'অন্য নম্বর দিন'],
  'auth.codeSent': ['We sent a code to {phone}.', '{phone} নম্বরে একটি কোড পাঠানো হয়েছে।'],
  'auth.resetSent': ['If there is an account for {email}, a reset link is on its way. Check your inbox and spam folder.', '{email} ঠিকানায় অ্যাকাউন্ট থাকলে রিসেট লিংক পাঠানো হয়েছে। ইনবক্স ও স্প্যাম ফোল্ডার দেখুন।'],
  'auth.redirecting': ['Taking you to Google…', 'গুগলে নিয়ে যাওয়া হচ্ছে…'],
  'auth.welcome': ['You are signed in.', 'আপনি লগইন করেছেন।'],
  'auth.disabled': ['This account has been disabled. Please contact the store for help.', 'এই অ্যাকাউন্টটি বন্ধ করে রাখা হয়েছে। সাহায্যের জন্য দোকানের সঙ্গে যোগাযোগ করুন।'],
  'auth.restricted': ['Your account is restricted, so orders cannot be placed right now. Please contact the store.', 'আপনার অ্যাকাউন্টে সীমাবদ্ধতা আছে, তাই এখন অর্ডার করা যাবে না। দোকানের সঙ্গে যোগাযোগ করুন।'],
  'auth.otherMethod': ['This email already uses a different sign-in method. Try Google, or reset your password.', 'এই ইমেইলে অন্য পদ্ধতিতে অ্যাকাউন্ট আছে। গুগল দিয়ে চেষ্টা করুন, অথবা পাসওয়ার্ড রিসেট করুন।'],
});

const MODES = ['signin', 'signup', 'reset', 'phone'];
const TITLE_KEY = { signin: 'common.signIn', signup: 'auth.signUp', reset: 'auth.reset', phone: 'auth.phoneTitle' };
const SUB_KEY = { signin: 'auth.subSignin', signup: 'auth.subSignup', reset: 'auth.subReset', phone: 'auth.subPhone' };

/** Localised heading for a mode (also used for the login page title). */
export const authTitle = (mode) => t(TITLE_KEY[mode] || TITLE_KEY.signin);

let seq = 0;

/** Resolves once auth.js reports a signed-in user (the SDK promise can settle a tick before the shared state does). */
function whenSignedIn(ms = 6000) {
  return new Promise((resolve) => {
    let off = null;
    let finished = false;
    const done = () => { if (finished) return; finished = true; clearTimeout(timer); if (off) off(); resolve(); };
    const timer = setTimeout(done, ms);
    off = onAuthChange((s) => { if (s.user) done(); });
    if (finished) off();
  });
}

function errorText(e) {
  const code = String((e && e.code) || '');
  if (code === 'auth/user-disabled') return t('auth.disabled');
  if (code === 'auth/account-exists-with-different-credential') return t('auth.otherMethod');
  if (!code.startsWith('auth/')) reportError(e, 'auth');   // unexpected failures only; the error never carries the password
  return explainError(e);
}

export function mountAuthForm(el, { mode = 'signin', onDone, heading = true, onMode } = {}) {
  const uid = ++seq;
  let m = MODES.includes(mode) ? mode : 'signin';
  let step = 'number';                 // phone flow: number → code
  let busy = false;
  let disposed = false;
  let notice = null;                   // { kind: 'ok' | 'bad', text }
  const draft = { name: '', email: '', phone: '' };   // survives mode switches; the password is never kept

  /* ───────── views ───────── */
  const noticeHtml = () => (notice
    ? html`<div class="alert ${notice.kind === 'ok' ? 'alert-ok' : 'alert-bad'}" role="${notice.kind === 'ok' ? 'status' : 'alert'}">${icon(notice.kind === 'ok' ? 'check-circle' : 'alert-circle')}<div>${notice.text}</div></div>`
    : html``);

  const emailField = () => fieldHtml({
    name: 'email', label: t('auth.email'), type: 'email', value: draft.email, required: true,
    autocomplete: m === 'signin' ? 'username' : 'email', inputmode: 'email',
    attrs: { autocapitalize: 'none', spellcheck: 'false' },
  });

  const passwordField = () => fieldHtml({
    name: 'password', label: t('auth.password'), type: 'password', required: true,
    autocomplete: m === 'signup' ? 'new-password' : 'current-password',
    hint: m === 'signup' ? t('auth.passwordHint') : '',
    attrs: { autocapitalize: 'none', spellcheck: 'false' },
    suffix: html`<button type="button" class="auth-eye" data-action="togglePw" aria-pressed="false" aria-label="${t('auth.showPw')}">${icon('eye')}</button>`,
  });

  const credView = () => html`
    <form class="auth-form" data-form="${m}" novalidate>
      ${m === 'signup' ? fieldHtml({ name: 'name', label: t('auth.name'), value: draft.name, required: true, autocomplete: 'name', attrs: { maxlength: 80 } }) : ''}
      ${emailField()}
      ${passwordField()}
      ${m === 'signin' ? html`<div class="auth-row"><button type="button" class="btn-link" data-action="goto" data-mode="reset">${t('auth.forgot')}</button></div>` : ''}
      <button type="submit" class="btn btn-primary btn-block">${m === 'signin' ? t('auth.submitSignin') : t('auth.submitSignup')}</button>
    </form>
    <div class="auth-or"><span>${t('auth.or')}</span></div>
    <div class="auth-alt">
      <button type="button" class="btn btn-secondary btn-block" data-action="google">${t('auth.google')}</button>
      <button type="button" class="btn btn-ghost btn-block" data-action="goto" data-mode="phone">${icon('smartphone')}<span>${t('auth.usePhone')}</span></button>
    </div>
    <div class="auth-switch">
      <span>${m === 'signin' ? t('auth.noAccount') : t('auth.haveAccount')}</span>
      <button type="button" class="btn-link" data-action="goto" data-mode="${m === 'signin' ? 'signup' : 'signin'}">${m === 'signin' ? t('auth.toSignup') : t('auth.toSignin')}</button>
    </div>`;

  const resetView = () => html`
    <form class="auth-form" data-form="reset" novalidate>
      ${emailField()}
      <button type="submit" class="btn btn-primary btn-block">${t('auth.submitReset')}</button>
    </form>
    <div class="auth-switch"><button type="button" class="btn-link" data-action="goto" data-mode="signin">${icon('arrow-left', { size: 16 })}<span>${t('auth.backToSignin')}</span></button></div>`;

  const phoneView = () => (step === 'code'
    ? html`
      <form class="auth-form" data-form="code" novalidate>
        <p class="auth-note">${t('auth.codeSent', { phone: draft.phone })}</p>
        ${fieldHtml({ name: 'code', label: t('auth.code'), required: true, autocomplete: 'one-time-code', inputmode: 'numeric', attrs: { maxlength: 6, pattern: '[0-9]*' } })}
        <button type="submit" class="btn btn-primary btn-block">${t('auth.verify')}</button>
      </form>
      <div class="auth-switch"><button type="button" class="btn-link" data-action="phoneBack">${t('auth.changeNumber')}</button></div>`
    : html`
      <form class="auth-form" data-form="phone" novalidate>
        ${fieldHtml({ name: 'phone', label: t('auth.phoneLabel'), type: 'tel', value: draft.phone, required: true, autocomplete: 'tel', inputmode: 'tel', hint: t('auth.phoneHint') })}
        <div id="auth-captcha-${uid}" class="auth-captcha"></div>
        <button type="submit" class="btn btn-primary btn-block">${t('auth.sendCode')}</button>
      </form>
      <div class="auth-switch"><button type="button" class="btn-link" data-action="goto" data-mode="signin">${icon('arrow-left', { size: 16 })}<span>${t('auth.backToEmail')}</span></button></div>`);

  const view = () => html`
    <div class="auth" data-mode="${m}">
      ${heading
        ? html`<div class="auth-head"><h1 class="auth-title">${authTitle(m)}</h1><p class="auth-sub">${t(SUB_KEY[m])}</p></div>`
        : html`<p class="auth-sub">${t(SUB_KEY[m])}</p>`}
      <div class="auth-msg" data-msg>${noticeHtml()}</div>
      ${m === 'reset' ? resetView() : m === 'phone' ? phoneView() : credView()}
    </div>`;

  /* ───────── state helpers ───────── */
  const paint = (focus) => {
    render(el, view());
    if (focus) focusFirst(el.querySelector('form') || el);
  };

  const setNotice = (kind, text) => {
    notice = text ? { kind, text } : null;
    const box = el.querySelector('[data-msg]');
    if (!box) return;
    render(box, noticeHtml());
    if (notice && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
  };

  const carry = () => {
    const form = el.querySelector('form');
    if (!form) return;
    const v = readForm(form);
    for (const k of ['name', 'email', 'phone']) if (typeof v[k] === 'string' && v[k].trim()) draft[k] = v[k].trim();
  };

  const go = (next) => {
    if (busy || !MODES.includes(next)) return;
    carry();
    m = next; step = 'number'; notice = null;
    paint(true);
    if (onMode) onMode(m);
  };

  const check = (form, values, schema) => {
    const res = validateForm(values, schema);
    showFormErrors(form, res.errors);
    if (!res.ok) { const bad = form.querySelector('[aria-invalid="true"]'); if (bad) bad.focus(); }
    return res.ok;
  };

  async function guarded(btn, fn) {
    if (busy) return;
    busy = true; setNotice('', '');
    try { await withBusy(btn, fn); } catch (e) { setNotice('bad', errorText(e)); } finally { busy = false; }
  }
  const submitBtn = (form) => form.querySelector('[type="submit"]');

  async function complete() {
    await whenSignedIn();
    const st = getAuthState();
    if (st.profile && st.profile.restricted === true) toast(t('auth.restricted'), { type: 'warn', timeout: 9000 });
    else toast(t('auth.welcome'));
    if (!disposed && onDone) onDone({ mode: m });
  }

  /* ───────── wiring (once; the host element persists across re-renders) ───────── */
  const off = bindActions(el, {
    goto: (btn) => go(btn.dataset.mode),
    phoneBack: () => { if (busy) return; step = 'number'; notice = null; paint(true); },
    togglePw: (btn) => {
      const group = btn.closest('.input-group');
      const input = group && group.querySelector('input');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? t('auth.hidePw') : t('auth.showPw'));
      render(btn, icon(show ? 'eye-off' : 'eye'));
    },
    google: (btn) => guarded(btn, async () => {
      const res = await signInGoogle();
      if (res === null) { setNotice('ok', t('auth.redirecting')); return; }   // popup blocked → redirect flow, the page is about to leave
      await complete();
    }),
  }, {
    submit: {
      signin: (form) => guarded(submitBtn(form), async () => {
        const v = readForm(form);
        if (!check(form, v, { email: [required, emailRule], password: [required] })) return;
        draft.email = v.email.trim();
        await signInEmail(v.email, v.password);
        await complete();
      }),
      signup: (form) => guarded(submitBtn(form), async () => {
        const v = readForm(form);
        if (!check(form, v, { name: [required, minLen(2), maxLen(80)], email: [required, emailRule], password: [required, passwordRule] })) return;
        draft.name = v.name.trim(); draft.email = v.email.trim();
        await signUpEmail({ name: v.name, email: v.email, password: v.password });
        await complete();
      }),
      reset: (form) => guarded(submitBtn(form), async () => {
        const v = readForm(form);
        if (!check(form, v, { email: [required, emailRule] })) return;
        const addr = v.email.trim();
        // "user-not-found" gets the same answer as success, so the form cannot be used to probe which emails have accounts
        try { await sendPasswordReset(addr); } catch (e) { if (!e || e.code !== 'auth/user-not-found') throw e; }
        draft.email = addr; m = 'signin'; step = 'number';
        notice = { kind: 'ok', text: t('auth.resetSent', { email: addr }) };
        paint(true);
        if (onMode) onMode(m);
      }),
      phone: (form) => guarded(submitBtn(form), async () => {
        const v = readForm(form);
        if (!check(form, v, { phone: [required, phoneRule] })) return;
        draft.phone = v.phone.trim();
        await startPhoneSignIn(draft.phone, `auth-captcha-${uid}`);
        step = 'code';
        paint(true);
      }),
      code: (form) => guarded(submitBtn(form), async () => {
        const v = readForm(form);
        const six = custom((x) => (/^\d{6}$/.test(String(x).trim()) ? '' : t('auth.codeFormat')));
        if (!check(form, v, { code: [required, six] })) return;
        await confirmPhoneCode(v.code);
        await complete();
      }),
    },
  });

  paint(false);
  return () => { disposed = true; off(); };
}

export function openAuthModal({ mode = 'signin', onSuccess } = {}) {
  const fire = () => {
    if (typeof onSuccess !== 'function') return;
    try { onSuccess(); } catch (e) { reportError(e, 'auth.onSuccess'); }
  };
  if (isSignedIn()) { fire(); return Promise.resolve(true); }

  const start = MODES.includes(mode) ? mode : 'signin';
  const host = document.createElement('div');
  const modal = openModal({ title: authTitle(start), body: host, size: 'sm', className: 'auth-modal', initialFocus: 'input:not([type="hidden"])' });
  let done = false;
  const dispose = mountAuthForm(host, {
    mode: start,
    heading: false,
    onMode: (next) => modal.setTitle(authTitle(next)),
    onDone: () => { done = true; modal.close(true); },
  });
  return modal.closed.then(() => {
    dispose();
    const ok = done || isSignedIn();
    if (ok) fire();
    return ok;
  });
}
