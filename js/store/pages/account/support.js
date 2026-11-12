/*
 * Account → support
 *   /account/support          my requests (newest activity first) + "New request"; `?order=TV-…` opens the form for that order
 *   /account/support/:id      one request: the conversation, and a reply box (a reply re-opens a closed request)
 *
 * Tickets are supportTickets/{id} (+ /messages). Replies from the team show up here after a refresh; there is no live push.
 */
import { html, render, bindActions, readForm, withBusy } from '../../../core/dom.js';
import { registerBoth, t, lbl } from '../../../core/i18n.js';
import { icon } from '../../../core/icons.js';
import { skeletonRows, emptyState, errorState, fieldHtml, ticketBadge, toast, toastError, formDialog } from '../../../core/ui.js';
import { showFormErrors } from '../../../core/validate.js';
import { explainError } from '../../../core/errors.js';
import { fmtDateTime, relTime } from '../../../core/format.js';
import { getAuthState, currentUid } from '../../../data/auth.js';
import { listMyOrders } from '../../../data/orders.js';
import { createTicket, listMyTickets, getTicket, listMessages, replyToTicket, validateTicket } from '../../../data/support.js';
import { ORDER_STATUS, PATTERNS } from '../../../shared/constants.js';

registerBoth({
  'sp.title': ['Support', 'সাপোর্ট'],
  'sp.intro': ['Ask about an order, a product or a return. Our replies appear in the request itself.', 'অর্ডার, পণ্য বা রিটার্ন নিয়ে প্রশ্ন করুন। আমাদের উত্তর অনুরোধের ভেতরেই দেখা যাবে।'],
  'sp.new': ['New request', 'নতুন অনুরোধ'],
  'sp.empty': ['No requests yet', 'এখনও কোনো অনুরোধ নেই'],
  'sp.emptyText': ['When you write to us, the conversation is kept here.', 'আমাদের লিখলে কথোপকথনটি এখানে থাকবে।'],
  'sp.order': ['Order', 'অর্ডার'],
  'sp.newReply': ['New reply from the team', 'টিমের নতুন উত্তর'],
  'sp.loadError': ['Your requests could not be loaded.', 'অনুরোধগুলো লোড করা যায়নি।'],
  'sp.threadError': ['This request could not be loaded.', 'অনুরোধটি লোড করা যায়নি।'],
  'sp.notFound': ['Request not found', 'অনুরোধটি পাওয়া যায়নি'],
  'sp.notFoundText': ['It may belong to another account or may have been removed.', 'এটি অন্য অ্যাকাউন্টের হতে পারে বা মুছে ফেলা হয়েছে।'],
  'sp.back': ['All requests', 'সব অনুরোধ'],
  'sp.dlgTitle': ['New support request', 'নতুন সাপোর্ট অনুরোধ'],
  'sp.send': ['Send request', 'অনুরোধ পাঠান'],
  'sp.f.name': ['Your name', 'আপনার নাম'],
  'sp.f.phone': ['Mobile number', 'মোবাইল নম্বর'],
  'sp.f.phoneHintOpt': ['Optional — we use your account email otherwise.', 'ঐচ্ছিক — না দিলে অ্যাকাউন্টের ইমেইল ব্যবহার হবে।'],
  'sp.f.phoneHintReq': ['We will use it to reach you.', 'যোগাযোগের জন্য ব্যবহার হবে।'],
  'sp.f.order': ['Related order (optional)', 'সংশ্লিষ্ট অর্ডার (ঐচ্ছিক)'],
  'sp.noOrder': ['Not about a specific order', 'নির্দিষ্ট অর্ডার সম্পর্কিত নয়'],
  'sp.f.subject': ['Subject', 'বিষয়'],
  'sp.f.message': ['How can we help?', 'কীভাবে সাহায্য করতে পারি?'],
  'sp.subjectOrder': ['Question about order {n}', 'অর্ডার {n} সম্পর্কে প্রশ্ন'],
  'sp.created': ['Request sent', 'অনুরোধ পাঠানো হয়েছে'],
  'sp.sent': ['Message sent', 'বার্তা পাঠানো হয়েছে'],
  'sp.created_at': ['Opened {when}', 'শুরু হয়েছে {when}'],
  'sp.conversation': ['Conversation', 'কথোপকথন'],
  'sp.you': ['You', 'আপনি'],
  'sp.team': ['Support team', 'সাপোর্ট টিম'],
  'sp.yourReply': ['Your message', 'আপনার বার্তা'],
  'sp.reply': ['Send message', 'বার্তা পাঠান'],
  'sp.hint.open': ['We have your request. Replies will appear in this conversation.', 'আপনার অনুরোধ আমরা পেয়েছি। উত্তর এই কথোপকথনেই দেখা যাবে।'],
  'sp.hint.answered': ['The team has replied. You can answer below.', 'টিম উত্তর দিয়েছে। নিচে জবাব লিখতে পারেন।'],
  'sp.hint.closed': ['This request is closed. Writing again will re-open it.', 'অনুরোধটি বন্ধ আছে। আবার লিখলে এটি পুনরায় খুলবে।'],
});

const statusHint = (status) => t(`sp.hint.${['answered', 'closed'].includes(status) ? status : 'open'}`);

function rowHtml(k) {
  const replied = k.lastAuthor === 'staff' && k.status !== 'closed';
  return html`<li><a class="tk-row" href="/account/support/${encodeURIComponent(k.id)}">
    <span class="tk-row-top"><strong class="tk-subject">${k.subject}</strong>${ticketBadge(k.status)}</span>
    <span class="tk-row-meta muted"><span class="mono">${k.id}</span>${k.orderNumber ? html` · ${t('sp.order')} <span class="mono">${k.orderNumber}</span>` : ''} · ${relTime(k.updatedMs)}</span>
    ${replied ? html`<span class="tk-flag">${icon('message-circle', { size: 14 })} ${t('sp.newReply')}</span>` : ''}
  </a></li>`;
}

function bubbleHtml({ staff, text, ms }) {
  return html`<li class="tk-msg ${staff ? 'is-staff' : 'is-me'}">
    <div class="tk-msg-head"><strong>${staff ? t('sp.team') : t('sp.you')}</strong><time class="muted" title="${fmtDateTime(ms)}">${relTime(ms)}</time></div>
    <p class="tk-msg-text">${text}</p>
  </li>`;
}

/* ───────────────────────────── list + new request ───────────────────────────── */

async function mountList(ctx, uid) {
  const host = ctx.el;
  render(host, skeletonRows(4));
  let tickets; let orders;
  try {
    [tickets, orders] = await Promise.all([listMyTickets(uid), listMyOrders(uid, { limit: 30 }).catch(() => [])]);
  } catch (e) {
    if (ctx.signal.aborted) return;
    console.error(e);
    render(host, errorState({ text: t('sp.loadError') }));
    ctx.cleanup(bindActions(host, { retry: () => ctx.router.reload() }));
    return;
  }
  if (ctx.signal.aborted) return;

  render(host, html`
    <section class="acc-card" aria-labelledby="sp-title">
      <div class="acc-card-head">
        <h2 id="sp-title" tabindex="-1">${t('sp.title')}</h2>
        <button type="button" class="btn btn-primary btn-sm" data-action="new">${icon('plus', { size: 16 })}<span>${t('sp.new')}</span></button>
      </div>
      <p class="muted">${t('sp.intro')}</p>
      ${tickets.length ? html`<ul class="tk-list">${tickets.map(rowHtml)}</ul>` : emptyState({ icon: 'headset', title: t('sp.empty'), text: t('sp.emptyText') })}
    </section>`);

  const openNew = ({ orderNumber = '' } = {}) => {
    const { user, profile } = getAuthState();
    const name = (profile && profile.displayName) || (user && user.displayName) || '';
    const accountEmail = String((profile && profile.email) || (user && user.email) || '').trim();
    const email = PATTERNS.email.test(accountEmail) ? accountEmail : '';
    const orderOptions = [{ value: '', label: t('sp.noOrder') }, ...orders.map((o) => {
      const n = o.orderNumber || o.id;
      return { value: n, label: `${n} · ${lbl(ORDER_STATUS[o.status] || ORDER_STATUS.pending)}` };
    })];
    if (orderNumber && !orderOptions.some((o) => o.value === orderNumber)) orderOptions.push({ value: orderNumber, label: orderNumber });

    return formDialog({
      title: t('sp.dlgTitle'),
      confirmText: t('sp.send'),
      body: html`<form class="tk-form" data-form="ticket" novalidate>
        <div class="form-grid">
          ${name ? '' : fieldHtml({ name: 'name', label: t('sp.f.name'), required: true, autocomplete: 'name', span2: true, attrs: { maxlength: 80 } })}
          ${fieldHtml({ name: 'phone', label: t('sp.f.phone'), type: 'tel', value: (profile && profile.phone) || '', required: !email, autocomplete: 'tel', inputmode: 'tel', hint: email ? t('sp.f.phoneHintOpt') : t('sp.f.phoneHintReq'), span2: true })}
          ${fieldHtml({ name: 'orderNumber', label: t('sp.f.order'), type: 'select', options: orderOptions, value: orderNumber, span2: true })}
          ${fieldHtml({ name: 'subject', label: t('sp.f.subject'), value: orderNumber ? t('sp.subjectOrder', { n: orderNumber }) : '', required: true, span2: true, attrs: { maxlength: 120 } })}
          ${fieldHtml({ name: 'message', label: t('sp.f.message'), type: 'textarea', rows: 5, required: true, span2: true, attrs: { maxlength: 2000 } })}
        </div>
        <button type="submit" hidden></button>
      </form>`,
      onSubmit: async (form) => {
        const v = readForm(form);
        const input = { uid, name: name || v.name, email, phone: v.phone, subject: v.subject, message: v.message, orderNumber: v.orderNumber };
        const errors = validateTicket(input);
        if (errors.contact) { errors.phone = errors.phone || errors.contact; delete errors.contact; }
        showFormErrors(form, errors);
        if (Object.keys(errors).length) return false;
        let id;
        try { id = await createTicket(input); } catch (e) { toastError(explainError(e)); return false; }
        toast(t('sp.created'));
        ctx.router.navigate(`/account/support/${encodeURIComponent(id)}`);
        return true;
      },
    });
  };

  ctx.cleanup(bindActions(host, { new: () => openNew() }));
  if (ctx.query && ctx.query.order) {
    const orderNumber = String(ctx.query.order).slice(0, 40);
    ctx.router.setQuery({}, { replace: true }); // the form opens once; a reload will not open it again
    openNew({ orderNumber });
  }
}

/* ───────────────────────────── one request ───────────────────────────── */

async function mountThread(ctx, uid, id) {
  const host = ctx.el;
  render(host, skeletonRows(4));
  let ticket; let messages = [];
  const fetchAll = async () => {
    ticket = await getTicket(id);
    if (ticket && ticket.userId !== uid) ticket = null;
    messages = ticket ? await listMessages(id) : [];
  };
  try { await fetchAll(); } catch (e) {
    if (ctx.signal.aborted) return;
    console.error(e);
    render(host, errorState({ text: t('sp.threadError') }));
    ctx.cleanup(bindActions(host, { retry: () => ctx.router.reload() }));
    return;
  }
  if (ctx.signal.aborted) return;
  if (!ticket) {
    render(host, html`<a class="back-link" href="/account/support">${icon('arrow-left', { size: 16 })}<span>${t('sp.back')}</span></a>${emptyState({ icon: 'inbox', title: t('sp.notFound'), text: t('sp.notFoundText') })}`);
    return;
  }

  const paint = ({ focusReply = false } = {}) => {
    render(host, html`
      <a class="back-link" href="/account/support">${icon('arrow-left', { size: 16 })}<span>${t('sp.back')}</span></a>
      <section class="acc-card" aria-labelledby="tk-title">
        <div class="tk-head">
          <div class="tk-head-text">
            <h2 id="tk-title">${ticket.subject}</h2>
            <p class="muted"><span class="mono">${ticket.id}</span>${ticket.orderNumber ? html` · ${t('sp.order')} <a class="mono" href="/account/orders/${encodeURIComponent(ticket.orderNumber)}">${ticket.orderNumber}</a>` : ''} · ${t('sp.created_at', { when: fmtDateTime(ticket.createdMs) })}</p>
          </div>
          ${ticketBadge(ticket.status)}
        </div>
        <p class="muted tk-hint">${statusHint(ticket.status)}</p>
        <ol class="tk-thread" aria-label="${t('sp.conversation')}">
          ${bubbleHtml({ staff: false, text: ticket.message, ms: ticket.createdMs })}
          ${messages.map((m) => bubbleHtml({ staff: m.authorType === 'staff', text: m.text, ms: m.createdMs }))}
        </ol>
        <form class="tk-reply" data-form="reply" novalidate>
          ${fieldHtml({ name: 'text', label: t('sp.yourReply'), type: 'textarea', rows: 4, required: true, attrs: { maxlength: 2000 } })}
          <div><button type="submit" class="btn btn-primary">${icon('send', { size: 16 })}<span>${t('sp.reply')}</span></button></div>
        </form>
      </section>`);
    if (focusReply) host.querySelector('#f-text')?.focus({ preventScroll: true });
  };
  paint();

  ctx.cleanup(bindActions(host, {}, {
    submit: {
      reply: async (form) => {
        const text = readForm(form).text;
        if (text.length < 2) { showFormErrors(form, { text: t('tk.err.reply') }); return; }
        showFormErrors(form, {});
        await withBusy(form.querySelector('[type="submit"]'), async () => {
          try { await replyToTicket(ticket, uid, text); } catch (e) { toastError(explainError(e)); return; }
          toast(t('sp.sent'));
          try { await fetchAll(); } catch (e) { console.error(e); }
          if (!ctx.signal.aborted && ticket) paint({ focusReply: true });
        });
      },
    },
  }));
}

export default {
  async mount(ctx) {
    const uid = currentUid();
    const id = ctx.params && ctx.params.id ? ctx.params.id : '';
    return id ? mountThread(ctx, uid, id) : mountList(ctx, uid);
  },
};
