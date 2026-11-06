/*
 * Contact — /contact
 * Shows only the contact details the shop has configured (settings → contact) and a message form for everybody, signed in or not.
 * A message becomes a support ticket (supportTickets/{id}, status "open"); signed-in customers can follow it under Account → Support.
 * Guests cannot read a ticket back, so the confirmation tells them the reply comes to the email / phone they gave.
 * Spam: a hidden honeypot field and a short cooldown per browser — a courtesy, not a security boundary.
 */
import { html, render, bindActions, readForm, withBusy, setMeta } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, fieldHtml, toastError } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError } from '../../core/errors.js';
import { local } from '../../core/storage.js';
import { getAuthState, currentUid } from '../../data/auth.js';
import { settings } from '../../data/settings.js';
import { createTicket, validateTicket } from '../../data/support.js';
import { absoluteUrl } from '../lib/links.js';

registerBoth({
  'ct.title': ['Contact us', 'যোগাযোগ করুন'],
  'ct.lead': ['Questions about a product, an order or delivery? Write to us and we will reply.', 'পণ্য, অর্ডার বা ডেলিভারি নিয়ে প্রশ্ন? আমাদের লিখুন, আমরা উত্তর দেব।'],
  'ct.direct': ['Reach us directly', 'সরাসরি যোগাযোগ'],
  'ct.whatsapp': ['Chat on WhatsApp', 'হোয়াটসঅ্যাপে চ্যাট করুন'],
  'ct.formTitle': ['Send a message', 'বার্তা পাঠান'],
  'ct.name': ['Your name', 'আপনার নাম'],
  'ct.email': ['Email', 'ইমেইল'],
  'ct.phone': ['Mobile number', 'মোবাইল নম্বর'],
  'ct.reachHint': ['Give an email or a mobile number — we reply there.', 'ইমেইল বা মোবাইল নম্বর দিন — উত্তর সেখানেই যাবে।'],
  'ct.subject': ['Subject', 'বিষয়'],
  'ct.message': ['Message', 'বার্তা'],
  'ct.website': ['Leave this field empty', 'এই ঘরটি ফাঁকা রাখুন'],
  'ct.send': ['Send message', 'বার্তা পাঠান'],
  'ct.wait': ['You just sent a message. Please wait a moment before sending another.', 'আপনি এইমাত্র বার্তা পাঠিয়েছেন। আরেকটি পাঠানোর আগে একটু অপেক্ষা করুন।'],
  'ct.doneTitle': ['Message sent', 'বার্তা পাঠানো হয়েছে'],
  'ct.doneText': ['Thank you. We will reply to the email or mobile number you gave.', 'ধন্যবাদ। আপনার দেওয়া ইমেইল বা মোবাইল নম্বরে আমরা উত্তর দেব।'],
  'ct.doneRef': ['Reference', 'রেফারেন্স'],
  'ct.follow': ['Follow this conversation', 'কথোপকথন দেখুন'],
  'ct.another': ['Send another message', 'আরেকটি বার্তা পাঠান'],
});

const COOLDOWN_MS = 30000;
const LAST_KEY = 'sv.contact.last';

export default {
  mount(ctx) {
    loadCss('/css/pages/contact.css');
    const st = settings();
    setMeta({ title: t('ct.title'), canonical: absoluteUrl('/contact') });
    const c = st.contact || {};
    const phone = String(c.phone || '').trim();
    const wa = String(c.whatsapp || '').replace(/\D/g, '');
    const hasDirect = !!(phone || wa.length >= 8 || c.email || c.address);
    const { user, profile } = getAuthState();
    const prefill = {
      name: (profile && profile.displayName) || (user && user.displayName) || '',
      email: (profile && profile.email) || (user && user.email) || '',
      phone: (profile && profile.phone) || '',
    };

    const formView = () => html`<div class="container page ct">
      <h1 class="page-title">${t('ct.title')}</h1>
      <p class="muted ct-lead">${t('ct.lead')}</p>
      <div class="ct-grid ${hasDirect ? '' : 'is-single'}">
        ${hasDirect ? html`<section class="ct-card" aria-labelledby="ct-direct-h"><h2 id="ct-direct-h">${t('ct.direct')}</h2>
          <ul class="ct-list">
            ${phone ? html`<li>${icon('phone', { size: 18 })}<a href="tel:${phone.replace(/[^\d+]/g, '')}">${phone}</a></li>` : ''}
            ${wa.length >= 8 ? html`<li>${icon('message-circle', { size: 18 })}<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">${t('ct.whatsapp')}</a></li>` : ''}
            ${c.email ? html`<li>${icon('mail', { size: 18 })}<a href="mailto:${c.email}">${c.email}</a></li>` : ''}
            ${c.address ? html`<li>${icon('map-pin', { size: 18 })}<span>${c.address}</span></li>` : ''}
          </ul></section>` : ''}
        <section class="ct-card" aria-labelledby="ct-form-h"><h2 id="ct-form-h">${t('ct.formTitle')}</h2>
          <form class="ct-form" data-form="contact" novalidate>
            ${fieldHtml({ name: 'name', label: t('ct.name'), value: prefill.name, required: true, autocomplete: 'name', attrs: { maxlength: 80 } })}
            ${fieldHtml({ name: 'email', label: t('ct.email'), type: 'email', value: prefill.email, autocomplete: 'email', inputmode: 'email', attrs: { maxlength: 120 } })}
            ${fieldHtml({ name: 'phone', label: t('ct.phone'), type: 'tel', value: prefill.phone, autocomplete: 'tel', inputmode: 'tel', hint: t('ct.reachHint') })}
            ${fieldHtml({ name: 'subject', label: t('ct.subject'), required: true, attrs: { maxlength: 120 } })}
            ${fieldHtml({ name: 'message', label: t('ct.message'), type: 'textarea', rows: 5, required: true, attrs: { maxlength: 2000 } })}
            <div class="ct-hp" aria-hidden="true"><label>${t('ct.website')}<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
            <div><button type="submit" class="btn btn-primary">${icon('send', { size: 16 })}<span>${t('ct.send')}</span></button></div>
          </form></section>
      </div></div>`;

    const doneView = (id, signedIn) => html`<div class="container page ct">
      <section class="ct-done" role="status">
        ${icon('check-circle', { size: 40 })}
        <h1>${t('ct.doneTitle')}</h1>
        <p class="muted">${t('ct.doneText')}</p>
        ${id ? html`<p>${t('ct.doneRef')}: <strong class="mono">${id}</strong></p>` : ''}
        <div class="ct-done-actions">
          ${id && signedIn ? html`<a class="btn btn-primary" href="/account/support/${encodeURIComponent(id)}">${t('ct.follow')}</a>` : ''}
          <button type="button" class="btn btn-secondary" data-action="again">${t('ct.another')}</button>
        </div>
      </section></div>`;

    const showForm = () => render(ctx.el, formView());
    showForm();

    ctx.cleanup(bindActions(ctx.el, { again: showForm }, {
      submit: {
        contact: async (form) => {
          const v = readForm(form);
          const input = { uid: currentUid(), name: v.name, email: v.email, phone: v.phone, subject: v.subject, message: v.message };
          const errors = validateTicket(input);
          if (errors.contact) { errors.email = errors.contact; delete errors.contact; }
          showFormErrors(form, errors);
          if (Object.keys(errors).length) return;
          if (v.website) { render(ctx.el, doneView('', false)); return; }       // a bot filled the hidden field: pretend it worked
          const last = Number(local.get(LAST_KEY, 0)) || 0;
          if (Date.now() - last < COOLDOWN_MS) { toastError(t('ct.wait')); return; }
          await withBusy(form.querySelector('[type="submit"]'), async () => {
            let id;
            try { id = await createTicket(input); } catch (e) { toastError(explainError(e)); return; }
            local.set(LAST_KEY, Date.now());
            if (!ctx.signal.aborted) { render(ctx.el, doneView(id, !!currentUid())); ctx.el.querySelector('h1')?.setAttribute('tabindex', '-1'); ctx.el.querySelector('h1')?.focus(); }
          });
        },
      },
    }));
  },
};
