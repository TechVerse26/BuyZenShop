/*
 * Support → one request. Permission: support.read to look; support.reply (Super Admin, Store Admin, Customer Support) to answer and to change
 * the status or priority. The Order Manager can read the conversation but gets no reply box.
 *
 *   conversation: the customer's first message, then every reply, oldest first (loaded when the page opens; "Refresh" loads it again)
 *   reply: 1–2000 characters. "Send reply" marks the request answered, "Send and close" closes it. A customer with an account is notified in the app;
 *          a guest cannot read replies at all, so the reply can also be queued as an e-mail (sent only if the "Trigger Email from Firestore" extension is installed)
 *   side: who wrote, how to reach them, the order, and the status / priority selectors
 * Rules of the game: shared/supportFlow.js (audit entries never carry the message text).
 */
import { html, render, bindActions, raw } from '../../core/dom.js';
import { registerBoth, t, lbl } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, fieldHtml, toast, toastError, ticketBadge, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { fmtDateTime, relTime } from '../../core/format.js';
import { can, currentUid } from '../../data/auth.js';
import { PATTERNS, TICKET_STATUS, TICKET_STATUS_IDS, TICKET_PRIORITY, TICKET_PRIORITY_IDS } from '../../shared/constants.js';
import { SUPPORT } from '../../shared/supportFlow.js';
import { safeMount, needs, kvList, priorityBadge } from '../lib/ui.js';
import { loadTicket, sendReply, setStatus, setPriority } from '../data/tickets.js';

registerBoth({
  'tkm.back': ['All requests', 'সব অনুরোধ'],
  'tkm.notFound': ['Request not found', 'অনুরোধটি পাওয়া যায়নি'],
  'tkm.notFoundText': ['It may have been removed, or the link is wrong.', 'এটি মুছে ফেলা হয়েছে বা লিংকটি ভুল।'],
  'tkm.opened': ['Opened {when}', 'শুরু হয়েছে {when}'],
  'tkm.conversation': ['Conversation', 'কথোপকথন'],
  'tkm.customer': ['Customer', 'ক্রেতা'],
  'tkm.team': ['Support team', 'সাপোর্ট টিম'],
  'tkm.you': ['You (support team)', 'আপনি (সাপোর্ট টিম)'],
  'tkm.reply': ['Reply', 'উত্তর'],
  'tkm.reply.label': ['Your reply', 'আপনার উত্তর'],
  'tkm.reply.count': ['{n} of {max} characters', '{max} অক্ষরের মধ্যে {n}টি'],
  'tkm.send': ['Send reply', 'উত্তর পাঠান'],
  'tkm.sendClose': ['Send and close', 'পাঠিয়ে বন্ধ করুন'],
  'tkm.email': ['Also send this reply by e-mail to {email}', 'এই উত্তর {email} ঠিকানায় ইমেইলেও পাঠান'],
  'tkm.emailHint': ['The e-mail is queued. It is only sent when the “Trigger Email from Firestore” extension is installed.', 'ইমেইলটি কিউতে যায়। “Trigger Email from Firestore” এক্সটেনশন বসানো থাকলেই তা পাঠানো হয়।'],
  'tkm.hint.account': ['The customer sees your reply in their account and gets a notification.', 'ক্রেতা নিজের অ্যাকাউন্টে আপনার উত্তর দেখবেন এবং নোটিফিকেশন পাবেন।'],
  'tkm.hint.guest': ['This customer wrote without an account and cannot read replies here. Tick the e-mail option, or contact them directly.', 'এই ক্রেতা অ্যাকাউন্ট ছাড়া লিখেছেন, তাই এখানে উত্তর পড়তে পারবেন না। ইমেইল অপশনটি বেছে নিন বা সরাসরি যোগাযোগ করুন।'],
  'tkm.hint.guestNoMail': ['This customer wrote without an account and left no e-mail address, so they cannot read a reply here. Contact them by phone: {phone}.', 'এই ক্রেতা অ্যাকাউন্ট ও ইমেইল ছাড়া লিখেছেন, তাই এখানে উত্তর পড়তে পারবেন না। ফোনে যোগাযোগ করুন: {phone}।'],
  'tkm.closedHint': ['This request is closed. Sending a reply marks it as answered again.', 'অনুরোধটি বন্ধ আছে। উত্তর পাঠালে এটি আবার ‘উত্তর দেওয়া’ হবে।'],
  'tkm.readOnly': ['You can read this request but not answer it.', 'আপনি অনুরোধটি পড়তে পারবেন, উত্তর দিতে পারবেন না।'],
  'tkm.details': ['Details', 'বিস্তারিত'],
  'tkm.d.name': ['Name', 'নাম'],
  'tkm.d.email': ['E-mail', 'ইমেইল'],
  'tkm.d.phone': ['Phone', 'ফোন'],
  'tkm.d.account': ['Account', 'অ্যাকাউন্ট'],
  'tkm.d.hasAccount': ['Signed-in customer', 'অ্যাকাউন্টধারী ক্রেতা'],
  'tkm.d.viewAccount': ['Open the customer', 'ক্রেতার পেজ খুলুন'],
  'tkm.d.order': ['Order', 'অর্ডার'],
  'tkm.d.opened': ['Opened', 'শুরু'],
  'tkm.d.updated': ['Last activity', 'শেষ কার্যকলাপ'],
  'tkm.d.status': ['Status', 'স্ট্যাটাস'],
  'tkm.d.priority': ['Priority', 'প্রায়োরিটি'],
  'tkm.d.none': ['—', '—'],
  'tkm.err.textRequired': ['Write a reply first.', 'আগে উত্তর লিখুন।'],
  'tkm.err.textLong': ['The reply is too long ({max} characters at most).', 'উত্তরটি অনেক লম্বা (সর্বোচ্চ {max} অক্ষর)।'],
  'tkm.toast.sent': ['Reply sent', 'উত্তর পাঠানো হয়েছে'],
  'tkm.toast.sentClosed': ['Reply sent and the request closed', 'উত্তর পাঠানো হয়েছে এবং অনুরোধ বন্ধ হয়েছে'],
  'tkm.toast.emailed': ['e-mail queued', 'ইমেইল কিউতে'],
  'tkm.toast.status': ['Status changed', 'স্ট্যাটাস বদলানো হয়েছে'],
  'tkm.toast.priority': ['Priority changed', 'প্রায়োরিটি বদলানো হয়েছে'],
});

const mailto = (a) => `mailto:${encodeURIComponent(a).replace(/%40/g, '@')}`;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'support.read')) return;
    await loadCss('/css/pages/admin-support.css');
    await safeMount(ctx, async () => {
      const id = decodeURIComponent(String(ctx.params.id || ''));
      const href = (p) => ctx.router.href(p);
      const back = html`<a class="back-link" href="${href('/support')}">${icon('arrow-left', { size: 16 })}<span>${t('tkm.back')}</span></a>`;
      let data = await loadTicket(id);
      if (ctx.signal.aborted) return;
      if (!data) { render(ctx.el, html`${back}${emptyState({ icon: 'headset', title: t('tkm.notFound'), text: t('tkm.notFoundText') })}`); return; }

      const canReply = can('support.reply');
      const canMail = can('mail.send');
      const me = currentUid();
      const dash = t('tkm.d.none');
      const emailOk = () => PATTERNS.email.test(data.ticket.email || '');

      /* ── drawing: the reply form is rendered once so that typing is never lost; everything else is repainted ── */
      const headHtml = () => { const k = data.ticket; return html`<div class="page-head"><div><h1>${k.subject}</h1>
        <p class="page-sub"><span class="mono">${k.id}</span> · ${t('tkm.opened', { when: relTime(k.createdMs) })}</p></div>
        <div class="page-actions tkm-badges">${ticketBadge(k.status)}${priorityBadge(k.priority)}</div></div>`; };

      const threadHtml = () => {
        const k = data.ticket;
        const first = { authorType: 'customer', authorUid: '', text: k.message, createdMs: k.createdMs };
        return [first, ...data.messages].map((m) => {
          const staff = m.authorType === 'staff';
          const who = staff ? (m.authorUid && m.authorUid === me ? t('tkm.you') : t('tkm.team')) : (k.name || t('tkm.customer'));
          return html`<li class="tkm-msg ${staff ? 'is-staff' : 'is-customer'}">
            <div class="tkm-msg-head"><strong>${who}</strong><time class="muted" title="${fmtDateTime(m.createdMs)}">${relTime(m.createdMs)}</time></div>
            <p class="tkm-msg-text">${m.text}</p></li>`;
        });
      };

      const hintHtml = () => {
        const k = data.ticket;
        return html`${k.status === 'closed' ? html`<div class="alert alert-info" role="note">${icon('info', { size: 18 })}<div>${t('tkm.closedHint')}</div></div>` : ''}
          ${k.userId ? html`<p class="muted small">${t('tkm.hint.account')}</p>`
            : html`<div class="alert alert-warn" role="note">${icon('alert-triangle', { size: 18 })}<div>${k.email ? t('tkm.hint.guest') : t('tkm.hint.guestNoMail', { phone: k.phone || dash })}</div></div>`}`;
      };

      const replyHtml = () => {
        if (!canReply) return html`<div class="alert alert-info" role="note">${icon('info', { size: 18 })}<div>${t('tkm.readOnly')}</div></div>`;
        const k = data.ticket;
        return html`<form novalidate data-form="reply" class="stack">
          <div class="stack" id="tkm-hint">${hintHtml()}</div>
          ${fieldHtml({ name: 'text', label: t('tkm.reply.label'), type: 'textarea', rows: 5, attrs: { maxlength: SUPPORT.REPLY_MAX, autocomplete: 'off' } })}
          <p class="muted small" id="tkm-count" aria-live="off">${t('tkm.reply.count', { n: 0, max: SUPPORT.REPLY_MAX })}</p>
          ${canMail && emailOk() ? fieldHtml({ name: 'email', type: 'checkbox', label: t('tkm.email', { email: k.email }), value: !k.userId, hint: t('tkm.emailHint') }) : ''}
          <div class="tkm-send">
            <button type="button" class="btn btn-primary" data-action="send">${icon('send', { size: 18 })}<span>${t('tkm.send')}</span></button>
            <button type="button" class="btn" data-action="send-close">${t('tkm.sendClose')}</button>
          </div></form>`;
      };

      const sideHtml = () => {
        const k = data.ticket;
        const rows = [
          [t('tkm.d.name'), html`${k.name}`],
          [t('tkm.d.email'), k.email ? html`<a href="${mailto(k.email)}">${k.email}</a>` : dash],
          [t('tkm.d.phone'), k.phone ? html`<a href="tel:${encodeURIComponent(k.phone)}">${k.phone}</a>` : dash],
          [t('tkm.d.account'), k.userId ? (can('customers.read') ? html`<a href="${href('/customers/' + encodeURIComponent(k.userId))}">${t('tkm.d.viewAccount')}</a>` : t('tkm.d.hasAccount')) : badge(t('tkm.guest'), 'neutral')],
          [t('tkm.d.order'), k.orderNumber ? (can('orders.read') ? html`<a class="mono" href="${href('/orders/' + encodeURIComponent(k.orderNumber))}">${k.orderNumber}</a>` : html`<span class="mono">${k.orderNumber}</span>`) : dash],
          [t('tkm.d.opened'), fmtDateTime(k.createdMs)],
          [t('tkm.d.updated'), fmtDateTime(k.updatedMs)],
        ];
        return html`<section class="panel" aria-labelledby="tkm-side-h"><div class="panel-head"><h2 id="tkm-side-h">${t('tkm.details')}</h2></div>
          <div class="panel-body stack">${kvList(rows)}
            ${canReply ? html`<div class="stack tkm-selects">
              ${fieldHtml({ name: 'status', label: t('tkm.d.status'), type: 'select', value: k.status, options: TICKET_STATUS_IDS.map((s) => ({ value: s, label: lbl(TICKET_STATUS[s]) })), attrs: { 'data-change': 'status' } })}
              ${fieldHtml({ name: 'priority', label: t('tkm.d.priority'), type: 'select', value: k.priority, options: TICKET_PRIORITY_IDS.map((p) => ({ value: p, label: lbl(TICKET_PRIORITY[p]) })), attrs: { 'data-change': 'priority' } })}
            </div>` : ''}
          </div></section>`;
      };

      render(ctx.el, html`<div class="tkm">${back}<div id="tkm-head"></div>
        <div class="split">
          <div class="stack">
            <section class="panel" aria-labelledby="tkm-thread-h">
              <div class="panel-head"><h2 id="tkm-thread-h">${t('tkm.conversation')}</h2>
                <button type="button" class="btn btn-ghost btn-sm" data-action="reload">${icon('refresh', { size: 16 })}<span>${t('common.refresh')}</span></button></div>
              <div class="panel-body"><ul class="tkm-msgs" id="tkm-thread"></ul></div>
            </section>
            <section class="panel" aria-labelledby="tkm-reply-h"><div class="panel-head"><h2 id="tkm-reply-h">${t('tkm.reply')}</h2></div>
              <div class="panel-body" id="tkm-reply">${replyHtml()}</div></section>
          </div>
          <aside id="tkm-side"></aside>
        </div></div>`);
      const host = (sel) => ctx.el.querySelector(sel);
      const paint = () => {
        render(host('#tkm-head'), headHtml());
        render(host('#tkm-thread'), html`${threadHtml()}`);
        render(host('#tkm-side'), sideHtml());
        const hint = host('#tkm-hint');
        if (hint) render(hint, hintHtml());
      };
      paint();

      const refresh = async () => {
        const fresh = await loadTicket(id);
        if (ctx.signal.aborted) return;
        if (fresh) data = fresh;
        paint();
      };
      const fail = (e, where, form = null) => {
        if (form && e && e.errors && e.errors.text) { showFormErrors(form, { text: e.errors.text === 'too_long' ? t('tkm.err.textLong', { max: SUPPORT.REPLY_MAX }) : t('tkm.err.textRequired') }); return; }
        if (!isRefusal(e)) reportError(e, where);
        toastError(explainError(e));
      };

      const send = async (close) => {
        const form = host('form[data-form="reply"]');
        if (!form) return;
        showFormErrors(form, {});
        const buttons = [...form.querySelectorAll('button')];
        buttons.forEach((b) => { b.disabled = true; });
        try {
          const alsoEmail = !!(form.elements.email && form.elements.email.checked);
          const plan = await sendReply({ id, text: form.elements.text.value, close, alsoEmail });
          form.elements.text.value = '';
          host('#tkm-count').textContent = t('tkm.reply.count', { n: 0, max: SUPPORT.REPLY_MAX });
          toast(`${t(close ? 'tkm.toast.sentClosed' : 'tkm.toast.sent')}${plan.emailed ? ` · ${t('tkm.toast.emailed')}` : ''}`);
          await refresh();
          form.elements.text.focus();
        } catch (e) { fail(e, 'support.reply', form); } finally { buttons.forEach((b) => { b.disabled = false; }); }
      };

      const change = async (apply, okKey, el) => {
        el.disabled = true;
        try { await apply(); toast(t(okKey)); } catch (e) { fail(e, 'support.change'); }
        try { await refresh(); } catch (e) { fail(e, 'support.refresh'); }
      };

      ctx.cleanup(bindActions(ctx.el, {
        send: () => send(false),
        'send-close': () => send(true),
        reload: async () => { try { await refresh(); } catch (e) { fail(e, 'support.refresh'); } },
      }, {
        input: { text: (el) => { host('#tkm-count').textContent = t('tkm.reply.count', { n: el.value.length, max: SUPPORT.REPLY_MAX }); } },
        change: {
          status: (el) => change(() => setStatus({ id, to: el.value }), 'tkm.toast.status', el),
          priority: (el) => change(() => setPriority({ id, to: el.value }), 'tkm.toast.priority', el),
        },
      }));
    });
  },
};
