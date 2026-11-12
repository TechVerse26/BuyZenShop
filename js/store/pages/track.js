/*
 * Order tracking — /track (enter an order number, or pick a recent order) and /track/:id (live progress).
 * Sign-in is required because an order can only be read by the account that placed it (firestore.rules: orders get/list).
 * The page updates by itself while it is open: staff status changes arrive through a realtime listener.
 */
import { html, render, bindActions, readForm, setMeta } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { loadCss, skeletonRows, emptyState, fieldHtml, statusBadge, paymentBadge } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { fmtDateTime, money, num } from '../../core/format.js';
import { currentUid } from '../../data/auth.js';
import { listMyOrders, watchMyOrder, listOrderEvents } from '../../data/orders.js';
import { orderRowHtml, stepsHtml, paymentNote, timelineEntries, eventsHtml } from '../components/orderParts.js';
import { trackUrl, orderUrl } from '../lib/links.js';

registerBoth({
  'trk.title': ['Track your order', 'অর্ডার ট্র্যাক করুন'],
  'trk.intro': ['Enter the order number from your confirmation, for example {example}.', 'কনফার্মেশনে দেওয়া অর্ডার নম্বর লিখুন, যেমন {example}।'],
  'trk.number': ['Order number', 'অর্ডার নম্বর'],
  'trk.go': ['Track', 'ট্র্যাক করুন'],
  'trk.err.number': ['Enter a valid order number (letters, digits and hyphens).', 'সঠিক অর্ডার নম্বর লিখুন (ইংরেজি অক্ষর, সংখ্যা ও হাইফেন)।'],
  'trk.recent': ['Your recent orders', 'আপনার সাম্প্রতিক অর্ডার'],
  'trk.another': ['Track another order', 'অন্য অর্ডার ট্র্যাক করুন'],
  'trk.orderLabel': ['Order', 'অর্ডার'],
  'trk.placed': ['Placed {date}', 'অর্ডারের সময় {date}'],
  'trk.progress': ['Progress', 'অগ্রগতি'],
  'trk.history': ['History', 'ইতিহাস'],
  'trk.summary': ['{items} items · {total}', '{items}টি পণ্য · {total}'],
  'trk.full': ['View full order details', 'অর্ডারের পূর্ণ বিবরণ দেখুন'],
  'trk.help': ['Question about this order?', 'এই অর্ডার নিয়ে প্রশ্ন আছে?'],
  'trk.helpLink': ['Contact support', 'সাপোর্টে লিখুন'],
  'trk.notFound': ['Order not found', 'অর্ডার পাওয়া যায়নি'],
  'trk.notFoundText': ['Check the number, and make sure you are signed in with the account that placed the order.', 'নম্বরটি আবার দেখুন, এবং যে অ্যাকাউন্ট থেকে অর্ডার করেছেন সেটি দিয়ে সাইন ইন আছেন কি না দেখুন।'],
  'trk.loadError': ['Tracking could not be loaded.', 'ট্র্যাকিং লোড করা যায়নি।'],
});

const normalize = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '');
const VALID = /^[A-Z0-9][A-Z0-9-]{5,39}$/;

/* ───────────────────────────── /track ───────────────────────────── */

async function mountForm(ctx) {
  render(ctx.el, html`<div class="container page trk">
    <h1 class="page-title">${t('trk.title')}</h1>
    <p class="muted">${t('trk.intro', { example: 'SV-261025-AB12CD' })}</p>
    <form class="trk-form" data-form="track" novalidate>
      ${fieldHtml({ name: 'order', label: t('trk.number'), required: true, autocomplete: 'off', attrs: { autocapitalize: 'characters', spellcheck: 'false', maxlength: 40 } })}
      <button type="submit" class="btn btn-primary">${icon('search', { size: 18 })}<span>${t('trk.go')}</span></button>
    </form>
    <section class="trk-recent" id="trk-recent" aria-labelledby="trk-recent-h" hidden></section>
  </div>`);
  ctx.cleanup(bindActions(ctx.el, {}, {
    submit: {
      track: (form) => {
        const no = normalize(readForm(form).order);
        const ok = VALID.test(no);
        showFormErrors(form, ok ? {} : { order: t('trk.err.number') });
        if (ok) ctx.router.navigate(trackUrl(no));
      },
    },
  }));

  try {
    const orders = (await listMyOrders(currentUid(), { limit: 5 }));
    const host = ctx.el.querySelector('#trk-recent');
    if (ctx.signal.aborted || !host || !orders.length) return;
    host.hidden = false;
    render(host, html`<h2 id="trk-recent-h">${t('trk.recent')}</h2><ul class="ord-list">${orders.map((o) => orderRowHtml(o, { href: trackUrl(o.id) }))}</ul>`);
  } catch (e) { console.warn('recent orders unavailable', e); }
}

/* ───────────────────────────── /track/:id ───────────────────────────── */

async function mountOrder(ctx, id) {
  const uid = currentUid();
  const host = ctx.el;
  render(host, html`<div class="container page trk">${skeletonRows(4)}</div>`);
  let order = null; let events = []; let lastStatus = null; let first = true;

  const notFound = () => render(host, html`<div class="container page trk"><a class="back-link" href="/track">${icon('arrow-left', { size: 16 })}<span>${t('trk.another')}</span></a>${emptyState({ icon: 'package', title: t('trk.notFound'), text: t('trk.notFoundText') })}</div>`);

  const paint = () => {
    const note = paymentNote(order);
    const items = order.items.reduce((s, l) => s + l.qty, 0);
    render(host, html`<div class="container page trk">
      <a class="back-link" href="/track">${icon('arrow-left', { size: 16 })}<span>${t('trk.another')}</span></a>
      <section class="ord-card trk-head" aria-labelledby="trk-h">
        <div>
          <h1 class="page-title trk-title" id="trk-h">${t('trk.orderLabel')} <span class="mono">${order.orderNumber}</span></h1>
          ${order.createdAtMs ? html`<p class="muted small">${t('trk.placed', { date: fmtDateTime(order.createdAtMs) })}</p>` : ''}
        </div>
        <div class="trk-badges">${statusBadge(order.status)}${paymentBadge(order.payment.status)}</div>
      </section>
      <section class="ord-card" aria-label="${t('trk.progress')}">${stepsHtml(order)}</section>
      ${note ? html`<p class="alert">${icon('info', { size: 18 })}<span>${note}</span></p>` : ''}
      <section class="ord-card" aria-labelledby="trk-hist-h"><h2 id="trk-hist-h">${t('trk.history')}</h2>${eventsHtml(timelineEntries(order, events))}</section>
      <section class="ord-card trk-foot">
        <p>${t('trk.summary', { items: num(items), total: money(order.totals.total) })}</p>
        <a class="btn btn-secondary" href="${orderUrl(order.id)}">${t('trk.full')}</a>
      </section>
      <p class="muted trk-help">${t('trk.help')} <a href="/account/support?order=${encodeURIComponent(order.orderNumber)}">${t('trk.helpLink')}</a></p>
    </div>`);
  };

  const off = watchMyOrder(id, async (o) => {
    if (ctx.signal.aborted) return;
    if (!o || o.userId !== uid) { order = null; notFound(); return; }
    order = o;
    if (first || o.status !== lastStatus) {                                  // the history only changes when the status does
      first = false; lastStatus = o.status;
      try { events = await listOrderEvents(id, uid); } catch { events = []; }
      if (ctx.signal.aborted) return;
    }
    paint();
  }, (e) => {
    if (ctx.signal.aborted) return;
    // A number that does not exist (or is somebody else's) is refused by the rules; both look the same to the visitor.
    console.warn('order not readable', e && e.code);
    notFound();
  });
  ctx.cleanup(off);
}

export default {
  async mount(ctx) {
    loadCss('/css/pages/track.css');
    setMeta({ title: t('trk.title'), noindex: true });
    const id = ctx.params && ctx.params.id ? normalize(decodeURIComponent(ctx.params.id)) : '';
    if (!id) return mountForm(ctx);
    if (!VALID.test(id)) { render(ctx.el, html`<div class="container page trk"><a class="back-link" href="/track">${icon('arrow-left', { size: 16 })}<span>${t('trk.another')}</span></a>${emptyState({ icon: 'package', title: t('trk.notFound'), text: t('trk.notFoundText') })}</div>`); return undefined; }
    return mountOrder(ctx, id);
  },
};

