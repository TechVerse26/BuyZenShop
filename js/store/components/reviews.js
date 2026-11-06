/*
 * Reviews block of the product page: summary + distribution, sortable list, write / edit form, "helpful" votes, reports.
 *
 *   const rv = mountReviews(el, product)      → { dispose }
 *
 * Reviews are fetched when the block nears the viewport (one query: productId == … and status == 'approved').
 * New reviews start as 'pending' (moderated in the admin panel); the author sees their own pending review here.
 */
import { html, render, bindActions, readForm, withBusy, aria } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { toast, toastError, openModal, promptDialog, confirmDialog, stars, errorState, skeletonRows } from '../../core/ui.js';
import { explainError, AppError } from '../../core/errors.js';
import { num, fmtDate } from '../../core/format.js';
import { onAuthChange, getAuthState, isSignedIn, currentUid } from '../../data/auth.js';
import { loadApprovedReviews, getMyReview, submitReview, editMyReview, deleteMyReview, voteHelpful, reportReview, hasVoted, hasReported } from '../../data/reviews.js';
import { summarize, sortReviews, REVIEW_SORTS, REVIEW_LIMITS } from '../../shared/reviewModel.js';
import { openAuthModal } from './authModal.js';

registerBoth({
  'rev.title': ['Customer reviews', 'গ্রাহকদের রিভিউ'],
  'rev.count_one': ['{n} review', '{n}টি রিভিউ'],
  'rev.count_other': ['{n} reviews', '{n}টি রিভিউ'],
  'rev.none': ['No reviews yet', 'এখনো কোনো রিভিউ নেই'],
  'rev.noneText': ['Bought this? Be the first to share what you think.', 'কিনেছেন? সবার আগে আপনার মতামত জানান।'],
  'rev.write': ['Write a review', 'রিভিউ লিখুন'],
  'rev.signIn': ['Sign in to write a review', 'রিভিউ লিখতে লগইন করুন'],
  'rev.edit': ['Edit your review', 'আপনার রিভিউ সম্পাদনা'],
  'rev.rating': ['Your rating', 'আপনার রেটিং'],
  'rev.star': ['{n} stars', '{n} স্টার'],
  'rev.fTitle': ['Title', 'শিরোনাম'],
  'rev.fTitlePh': ['Sum it up in a few words', 'কয়েকটি শব্দে সারাংশ'],
  'rev.fText': ['Your review', 'আপনার রিভিউ'],
  'rev.fTextPh': ['What did you like or dislike?', 'কী ভালো বা খারাপ লেগেছে?'],
  'rev.submit': ['Submit review', 'রিভিউ জমা দিন'],
  'rev.saveChanges': ['Save changes', 'পরিবর্তন সংরক্ষণ'],
  'rev.thanks': ['Thank you! Your review will appear once it is approved.', 'ধন্যবাদ! অনুমোদনের পর আপনার রিভিউ দেখা যাবে।'],
  'rev.updated': ['Review updated', 'রিভিউ আপডেট হয়েছে'],
  'rev.deleted': ['Review deleted', 'রিভিউ মুছে ফেলা হয়েছে'],
  'rev.mine.pending': ['Your review is waiting for approval.', 'আপনার রিভিউ অনুমোদনের অপেক্ষায় আছে।'],
  'rev.mine.rejected': ['Your review was not published. Contact support if you think this is a mistake.', 'আপনার রিভিউটি প্রকাশ করা হয়নি। ভুল মনে হলে সাপোর্টে জানান।'],
  'rev.mine.tag': ['Your review', 'আপনার রিভিউ'],
  'rev.verified': ['Verified purchase', 'যাচাইকৃত ক্রয়'],
  'rev.helpful': ['Helpful', 'সহায়ক'],
  'rev.helpfulN': ['Helpful ({n})', 'সহায়ক ({n})'],
  'rev.thanksVote': ['Thanks for your feedback', 'আপনার মতামতের জন্য ধন্যবাদ'],
  'rev.alreadyVoted': ['You already marked this review.', 'আপনি এই রিভিউ আগেই চিহ্নিত করেছেন।'],
  'rev.report': ['Report', 'রিপোর্ট'],
  'rev.reportTitle': ['Report this review', 'এই রিভিউ রিপোর্ট করুন'],
  'rev.reportLabel': ['What is wrong with it?', 'সমস্যাটা কী?'],
  'rev.reportSend': ['Send report', 'রিপোর্ট পাঠান'],
  'rev.reported': ['Thanks — our team will take a look.', 'ধন্যবাদ — আমাদের টিম দেখবে।'],
  'rev.alreadyReported': ['You already reported this review.', 'আপনি এই রিভিউ আগেই রিপোর্ট করেছেন।'],
  'rev.sort': ['Sort reviews', 'রিভিউ সাজান'],
  'rev.sort.newest': ['Newest', 'নতুন আগে'],
  'rev.sort.helpful': ['Most helpful', 'সবচেয়ে সহায়ক'],
  'rev.sort.highest': ['Highest rating', 'সর্বোচ্চ রেটিং'],
  'rev.sort.lowest': ['Lowest rating', 'সর্বনিম্ন রেটিং'],
  'rev.more': ['Show more reviews', 'আরও রিভিউ দেখুন'],
  'rev.loadError': ['Reviews could not be loaded.', 'রিভিউ লোড করা যায়নি।'],
  'rev.e.required': ['Required', 'আবশ্যক'],
  'rev.e.short': ['Too short', 'খুব ছোট'],
  'rev.e.long': ['Too long', 'খুব বড়'],
  'rev.deleteAsk': ['Delete your review?', 'আপনার রিভিউ মুছবেন?'],
  'rev.deleteText': ['This cannot be undone.', 'এটি আর ফেরানো যাবে না।'],
  'rev.anon': ['Customer', 'গ্রাহক'],
  'rev.distRow': ['{n}-star reviews: {c}', '{n} স্টার রিভিউ: {c}'],
  'rev.cancel': ['Cancel', 'বাতিল'],
});

const PAGE = 5;
const ensureSignedIn = async () => isSignedIn() || openAuthModal({ mode: 'login' });

export function mountReviews(el, product) {
  const st = { phase: 'idle', list: [], mine: null, sort: 'newest', shown: PAGE };
  let disposed = false;
  let io = null;

  const reviewItem = (r, { mine = false } = {}) => html`<article class="rev">
    <div class="rev-head">${stars(r.rating, { size: 16 })}<strong class="rev-title">${r.title}</strong></div>
    <p class="rev-meta"><span>${r.userName || t('rev.anon')}</span><span aria-hidden="true">·</span><span>${fmtDate(r.createdMs)}</span>${r.verified ? html`<span class="badge badge-ok">${icon('check', { size: 14 })}${t('rev.verified')}</span>` : ''}${mine && r.status === 'approved' ? html`<span class="badge badge-info">${t('rev.mine.tag')}</span>` : ''}</p>
    <p class="rev-text">${r.text}</p>
    ${r.status === 'approved' ? html`<div class="rev-foot">
      <button type="button" class="btn btn-ghost btn-sm" data-action="helpful" data-id="${r.id}" data-fkey="h:${r.id}" ${mine || hasVoted(r.id) ? 'disabled' : ''}>${icon('thumbs-up', { size: 16 })}<span>${r.helpfulCount ? t('rev.helpfulN', { n: num(r.helpfulCount) }) : t('rev.helpful')}</span></button>
      ${mine ? '' : html`<button type="button" class="btn btn-link btn-sm" data-action="report" data-id="${r.id}" data-fkey="r:${r.id}" ${hasReported(r.id) ? 'disabled' : ''}>${icon('flag', { size: 14 })}<span>${t('rev.report')}</span></button>`}
    </div>` : ''}
  </article>`;

  const ctaHtml = () => {
    if (!isSignedIn()) return html`<button type="button" class="btn btn-secondary" data-action="write">${t('rev.signIn')}</button>`;
    if (st.mine) return '';
    return html`<button type="button" class="btn btn-primary" data-action="write">${icon('edit', { size: 18 })}<span>${t('rev.write')}</span></button>`;
  };

  const mineHtml = () => {
    const m = st.mine;
    if (!m || m.status === 'approved') return '';           // approved reviews are part of the list
    return html`<div class="rev-mine">
      <p><strong>${t('rev.mine.tag')}</strong> — ${m.status === 'pending' ? t('rev.mine.pending') : t('rev.mine.rejected')}</p>
      ${reviewItem(m, { mine: true })}
      ${m.status === 'pending' ? html`<div class="row row-wrap gap-2"><button type="button" class="btn btn-secondary btn-sm" data-action="edit">${t('rev.edit')}</button><button type="button" class="btn btn-ghost btn-sm" data-action="del">${t('common.delete')}</button></div>` : ''}
    </div>`;
  };

  const readyHtml = () => {
    const s = summarize(st.list);
    const sorted = sortReviews(st.list, st.sort);
    const mineApproved = st.mine && st.mine.status === 'approved' ? st.mine.id : '';
    if (!s.count) {
      return html`<div class="rev-top rev-empty"><div><h3>${t('rev.none')}</h3><p class="muted">${t('rev.noneText')}</p></div><div class="rev-cta">${ctaHtml()}</div></div>${mineHtml()}`;
    }
    return html`
      <div class="rev-top">
        <div class="rev-avg"><strong>${s.count ? num(s.avg, { decimals: 1 }) : '–'}</strong>${stars(s.avg, { size: 18 })}<span class="muted small">${tn('rev.count', s.count)}</span></div>
        <ul class="rev-dist">${[5, 4, 3, 2, 1].map((n) => html`<li><span>${num(n)}</span><progress class="rev-bar" max="${s.count || 1}" value="${s.dist[n - 1]}" aria-label="${t('rev.distRow', { n: num(n), c: num(s.dist[n - 1]) })}"></progress><span class="num">${num(s.dist[n - 1])}</span></li>`)}</ul>
        <div class="rev-cta">${ctaHtml()}</div>
      </div>
      ${mineHtml()}
      <div class="rev-toolbar">
        <label class="shop-sort"><span class="muted small">${t('rev.sort')}</span>
          <select class="select input-sm" data-change="sort" data-fkey="sort">${REVIEW_SORTS.map((m) => html`<option value="${m}" ${m === st.sort ? 'selected' : ''}>${t(`rev.sort.${m}`)}</option>`)}</select></label>
      </div>
      <div class="rev-list">${sorted.slice(0, st.shown).map((r) => reviewItem(r, { mine: r.id === mineApproved }))}</div>
      ${sorted.length > st.shown ? html`<button type="button" class="btn btn-secondary" data-action="more" data-fkey="more">${t('rev.more')}</button>` : ''}`;
  };

  const paint = () => {
    const active = document.activeElement;
    const keep = active && el.contains(active) ? active.dataset.fkey : '';
    render(el, html`<h2 id="rev-h">${t('rev.title')}</h2>
      ${st.phase === 'ready' ? readyHtml() : st.phase === 'error' ? errorState({ title: t('rev.loadError') }) : st.phase === 'loading' ? html`<div aria-busy="true">${skeletonRows(3)}</div>` : ''}`);
    if (keep) { const n = [...el.querySelectorAll('[data-fkey]')].find((x) => x.dataset.fkey === keep); if (n) n.focus({ preventScroll: true }); }
  };

  const load = async () => {
    st.phase = 'loading'; paint();
    try {
      const uid = currentUid();
      const [list, mine] = await Promise.all([loadApprovedReviews(product.id), uid ? getMyReview(product.id, uid) : Promise.resolve(null)]);
      if (disposed) return;
      st.list = list; st.mine = mine; st.phase = 'ready';
    } catch (e) {
      if (disposed) return;
      console.error(e); st.phase = 'error';
    }
    paint();
  };
  const reloadMine = async () => {
    try { st.mine = currentUid() ? await getMyReview(product.id, currentUid()) : null; } catch { st.mine = null; }
    if (!disposed) paint();
  };

  /* ───────── write / edit form ───────── */
  const openForm = (review) => {
    let rating = review ? review.rating : 0;
    const modal = openModal({
      title: review ? t('rev.edit') : t('rev.write'),
      body: html`<form class="rev-form" data-form="rev" novalidate>
        <div class="field"><span class="label" id="rev-rate-l">${t('rev.rating')}</span>
          <div class="rating-input" role="radiogroup" aria-labelledby="rev-rate-l">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" role="radio" class="${n <= rating ? 'is-on' : ''}" aria-checked="${aria(n === rating)}" aria-label="${t('rev.star', { n: num(n) })}" data-action="star" data-n="${n}">${icon('star', { size: 28 })}</button>`)}</div>
          <div class="field-error" data-err="rating" aria-live="polite"></div></div>
        <div class="field"><label class="label" for="rev-title">${t('rev.fTitle')}</label>
          <input class="input" id="rev-title" name="title" maxlength="${REVIEW_LIMITS.TITLE_MAX}" autocomplete="off" placeholder="${t('rev.fTitlePh')}" value="${review ? review.title : ''}">
          <div class="field-error" data-err="title" aria-live="polite"></div></div>
        <div class="field"><label class="label" for="rev-text">${t('rev.fText')}</label>
          <textarea class="textarea" id="rev-text" name="text" rows="5" maxlength="${REVIEW_LIMITS.TEXT_MAX}" data-input="count" placeholder="${t('rev.fTextPh')}">${review ? review.text : ''}</textarea>
          <div class="field-hint"><span data-count>${num(review ? review.text.length : 0)}</span> / ${num(REVIEW_LIMITS.TEXT_MAX)}</div>
          <div class="field-error" data-err="text" aria-live="polite"></div></div>
        <button type="submit" class="btn btn-primary btn-block">${review ? t('rev.saveChanges') : t('rev.submit')}</button>
      </form>`,
    });
    const showErrors = (fields = {}) => {
      modal.el.querySelectorAll('[data-err]').forEach((n) => { const code = fields[n.dataset.err]; n.textContent = code ? t(`rev.e.${code}`) : ''; });
      const bad = ['title', 'text'].find((k) => fields[k]);
      if (bad) { const input = modal.el.querySelector(`[name="${bad}"]`); if (input) input.focus(); }
    };
    bindActions(modal.el, {
      star: (b) => {
        rating = Number(b.dataset.n);
        modal.el.querySelectorAll('[data-action="star"]').forEach((s) => { const n = Number(s.dataset.n); s.classList.toggle('is-on', n <= rating); s.setAttribute('aria-checked', String(n === rating)); });
        showErrors({});
      },
    }, {
      input: { count: (box) => { const c = modal.el.querySelector('[data-count]'); if (c) c.textContent = num(box.value.length); } },
      submit: {
        rev: (form) => withBusy(form.querySelector('[type="submit"]'), async () => {
          const f = readForm(form);
          const s = getAuthState();
          try {
            if (review) await editMyReview(review, currentUid(), { rating, title: f.title, text: f.text });
            else await submitReview({ product, uid: currentUid(), user: { displayName: (s.profile && s.profile.displayName) || (s.user && s.user.displayName) || '' }, rating, title: f.title, text: f.text });
          } catch (e) {
            if (e instanceof AppError && e.fields) { showErrors(e.fields); return; }
            toastError(explainError(e)); return;
          }
          modal.close();
          toast(review ? t('rev.updated') : t('rev.thanks'));
          await reloadMine();
        }),
      },
    });
  };

  /* ───────── actions ───────── */
  const find = (id) => st.list.find((r) => r.id === id);
  const off = bindActions(el, {
    retry: () => load(),
    more: () => { st.shown += 10; paint(); },
    write: async () => {
      if (!(await ensureSignedIn())) return;
      await reloadMine();
      if (!st.mine) openForm(null);
    },
    edit: () => { if (st.mine) openForm(st.mine); },
    del: async () => {
      if (!st.mine) return;
      const ok = await confirmDialog({ title: t('rev.deleteAsk'), message: t('rev.deleteText'), confirmText: t('common.delete'), danger: true });
      if (!ok) return;
      try { await deleteMyReview(st.mine, currentUid()); toast(t('rev.deleted')); st.mine = null; paint(); } catch (e) { toastError(explainError(e)); }
    },
    helpful: async (b) => {
      if (!(await ensureSignedIn())) return;
      const r = find(b.dataset.id);
      if (!r || r.userId === currentUid()) return;
      if (hasVoted(r.id)) { toast(t('rev.alreadyVoted'), { type: 'info' }); return; }
      try {
        if (await voteHelpful(r, currentUid())) { r.helpfulCount += 1; toast(t('rev.thanksVote')); } else toast(t('rev.alreadyVoted'), { type: 'info' });
      } catch (e) { toastError(explainError(e)); }
      paint();
    },
    report: async (b) => {
      if (!(await ensureSignedIn())) return;
      const r = find(b.dataset.id);
      if (!r) return;
      if (hasReported(r.id)) { toast(t('rev.alreadyReported'), { type: 'info' }); return; }
      const reason = await promptDialog({ title: t('rev.reportTitle'), label: t('rev.reportLabel'), multiline: true, required: true, confirmText: t('rev.reportSend') });
      if (!reason) return;
      try { toast((await reportReview(r, currentUid(), reason)) ? t('rev.reported') : t('rev.alreadyReported')); } catch (e) { toastError(explainError(e)); }
      paint();
    },
  }, { change: { sort: (sel) => { st.sort = sel.value; st.shown = PAGE; paint(); } } });

  const offAuth = onAuthChange(() => { if (st.phase === 'ready') reloadMine(); }, { immediate: false });

  // fetch when the block is about to scroll into view
  paint();
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: '600px 0px' });
    io.observe(el);
  } else load();

  return { dispose() { disposed = true; off(); offAuth(); if (io) io.disconnect(); } };
}
