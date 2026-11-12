/*
 * Reviews — moderation. Permission: reviews.moderate (Super Admin, Store Admin, Product Manager, Customer Support).
 *
 *   Pending    the queue, oldest first       Approved    live on the product page, counted in the star rating
 *   Rejected   not shown anywhere            Reported    reviews a customer flagged (any status), most reports first
 *   Each review: stars, title, text, who and when, verified purchase, helpful votes, reports (reason + date), the product.
 *   Approve / Reject (optional reason the author can see) / Move back to pending / Delete / Dismiss reports.
 *   A review counts towards the product's rating only while approved; every change rewrites that rating from the stored reviews.
 * Rules of the game: shared/reviewFlow.js. Lists are one query per status (first 200); search and filters work on what is loaded.
 */
import { html, render, bindActions, readForm, raw, debounce } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { badge, emptyState, errorState, spinnerBlock, stars, toast, toastError, formDialog, confirmDialog, fieldHtml, openMenu, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, fmtDateTime } from '../../core/format.js';
import { can } from '../../data/auth.js';
import { filterReviews, orderReviews } from '../../shared/reviewFlow.js';
import { safeMount, pageHead, needs, searchField } from '../lib/ui.js';
import { loadReviewList, loadReports, loadReviewsByIds, productNames, moderateReview, deleteReview, dismissReports, LIST_CAP } from '../data/reviews.js';

registerBoth({
  'rvm.title': ['Reviews', 'রিভিউ'],
  'rvm.sub': ['Check what customers write before it goes on the product page. Only approved reviews are public and count in the star rating.', 'ক্রেতারা যা লেখেন তা পণ্যের পেজে যাওয়ার আগে যাচাই করুন। শুধু অনুমোদিত রিভিউ সবাই দেখে এবং তারকা-রেটিংয়ে গোনা হয়।'],
  'rvm.tabs': ['Review lists', 'রিভিউ তালিকা'],
  'rvm.tab.pending': ['Pending', 'অপেক্ষমাণ'],
  'rvm.tab.approved': ['Approved', 'অনুমোদিত'],
  'rvm.tab.rejected': ['Rejected', 'বাতিল'],
  'rvm.tab.reported': ['Reported', 'রিপোর্টকৃত'],
  'rvm.status.pending': ['Pending', 'অপেক্ষমাণ'],
  'rvm.status.approved': ['Approved', 'অনুমোদিত'],
  'rvm.status.rejected': ['Rejected', 'বাতিল'],
  'rvm.search': ['Search review, customer or product', 'রিভিউ, ক্রেতা বা পণ্য খুঁজুন'],
  'rvm.f.rating': ['Stars', 'তারা'],
  'rvm.f.allRatings': ['All ratings', 'সব রেটিং'],
  'rvm.f.stars_one': ['{n} star', '{n} তারা'],
  'rvm.f.stars_other': ['{n} stars', '{n} তারা'],
  'rvm.f.purchase': ['Purchase', 'ক্রয়'],
  'rvm.f.allPurchases': ['All reviews', 'সব রিভিউ'],
  'rvm.f.verified': ['Verified purchase', 'যাচাইকৃত ক্রয়'],
  'rvm.f.unverified': ['Not verified', 'যাচাইকৃত নয়'],
  'rvm.empty.pending': ['Nothing is waiting', 'অপেক্ষায় কিছু নেই'],
  'rvm.emptyText.pending': ['New reviews appear here until you approve or reject them.', 'নতুন রিভিউ এখানে আসবে, আপনি অনুমোদন বা বাতিল না করা পর্যন্ত।'],
  'rvm.empty.approved': ['No approved reviews yet', 'এখনও কোনো অনুমোদিত রিভিউ নেই'],
  'rvm.emptyText.approved': ['Approved reviews show on the product page.', 'অনুমোদিত রিভিউ পণ্যের পেজে দেখা যায়।'],
  'rvm.empty.rejected': ['No rejected reviews', 'কোনো বাতিল রিভিউ নেই'],
  'rvm.emptyText.rejected': ['Rejected reviews are kept here until you delete them.', 'বাতিল রিভিউ আপনি না মোছা পর্যন্ত এখানে থাকে।'],
  'rvm.empty.reported': ['No reported reviews', 'কোনো রিপোর্টকৃত রিভিউ নেই'],
  'rvm.emptyText.reported': ['When a customer reports a review, it shows up here.', 'কোনো ক্রেতা রিভিউ রিপোর্ট করলে তা এখানে দেখা যাবে।'],
  'rvm.noMatch': ['Nothing matches', 'কিছুই মেলেনি'],
  'rvm.noMatchText': ['Change the search or the filters.', 'সার্চ বা ফিল্টার বদলান।'],
  'rvm.capped': ['Only the first {n} reviews of this list are loaded. Work through them, then reload for the rest.', 'এই তালিকার প্রথম {n}টি রিভিউ লোড হয়েছে। এগুলো শেষ করে বাকিগুলোর জন্য রিলোড করুন।'],
  'rvm.reportsCapped': ['Some reports could not be loaded. Handle these first, then reload.', 'কিছু রিপোর্ট লোড করা যায়নি। এগুলো আগে সামলে রিলোড করুন।'],
  'rvm.footer': ['Showing {shown} of {total}', '{total}টির মধ্যে {shown}টি দেখানো হচ্ছে'],
  'rvm.anon': ['Customer', 'ক্রেতা'],
  'rvm.verified': ['Verified purchase', 'যাচাইকৃত ক্রয়'],
  'rvm.helpful_one': ['{n} found it helpful', '{n}জন কাজের মনে করেছেন'],
  'rvm.helpful_other': ['{n} found it helpful', '{n}জন কাজের মনে করেছেন'],
  'rvm.reports_one': ['{n} report', '{n}টি রিপোর্ট'],
  'rvm.reports_other': ['{n} reports', '{n}টি রিপোর্ট'],
  'rvm.reports.title': ['Reported because', 'রিপোর্টের কারণ'],
  'rvm.reports.more': ['and {n} more', 'আরও {n}টি'],
  'rvm.product': ['Product', 'পণ্য'],
  'rvm.productGone': ['This product no longer exists', 'এই পণ্যটি আর নেই'],
  'rvm.reason': ['Reason given:', 'কারণ:'],
  'rvm.approve': ['Approve', 'অনুমোদন'],
  'rvm.reject': ['Reject', 'বাতিল করুন'],
  'rvm.dismiss': ['Dismiss reports', 'রিপোর্ট বাতিল'],
  'rvm.menu.more': ['More actions for this review', 'এই রিভিউয়ের আরও অ্যাকশন'],
  'rvm.menu.pending': ['Move back to pending', 'অপেক্ষমাণে ফেরান'],
  'rvm.menu.delete': ['Delete', 'মুছুন'],
  'rvm.reject.title': ['Reject this review?', 'রিভিউটি বাতিল করবেন?'],
  'rvm.reject.text': ['It will not be shown on the product page and will not count in the star rating. The author will see that it was not published.', 'এটি পণ্যের পেজে দেখানো হবে না এবং তারকা-রেটিংয়ে গোনা হবে না। লেখক দেখবেন যে এটি প্রকাশ করা হয়নি।'],
  'rvm.reject.note': ['Reason (optional)', 'কারণ (ঐচ্ছিক)'],
  'rvm.reject.noteHint': ['The author can read this. 200 characters at most.', 'লেখক এটি পড়তে পারবেন। সর্বোচ্চ ২০০ অক্ষর।'],
  'rvm.del.title': ['Delete this review?', 'রিভিউটি মুছবেন?'],
  'rvm.del.text': ['It is removed for good, together with its reports. The customer can write a new review for this product.', 'রিপোর্টসহ এটি চিরতরে মুছে যাবে। ক্রেতা এই পণ্যের জন্য নতুন রিভিউ লিখতে পারবেন।'],
  'rvm.dismiss.title': ['Dismiss the reports?', 'রিপোর্টগুলো বাতিল করবেন?'],
  'rvm.dismiss.text_one': ['The review stays as it is. The report is deleted.', 'রিভিউ যেমন আছে তেমনই থাকবে। রিপোর্টটি মুছে যাবে।'],
  'rvm.dismiss.text_other': ['The review stays as it is. The {n} reports are deleted.', 'রিভিউ যেমন আছে তেমনই থাকবে। {n}টি রিপোর্ট মুছে যাবে।'],
  'rvm.toast.approved': ['Review approved', 'রিভিউ অনুমোদিত হয়েছে'],
  'rvm.toast.rejected': ['Review rejected', 'রিভিউ বাতিল হয়েছে'],
  'rvm.toast.pending': ['Moved back to pending', 'অপেক্ষমাণে ফেরানো হয়েছে'],
  'rvm.toast.deleted': ['Review deleted', 'রিভিউ মুছে ফেলা হয়েছে'],
  'rvm.toast.dismissed': ['Reports dismissed', 'রিপোর্ট বাতিল হয়েছে'],
  'rvm.toast.rating': ['Product rating is now {avg} from {n}', 'পণ্যের রেটিং এখন {avg} ({n}টি রিভিউ থেকে)'],
});

const TABS = ['pending', 'approved', 'rejected', 'reported'];
const TAB_ICON = { pending: 'check-circle', approved: 'star', rejected: 'x-circle', reported: 'flag' };
const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad' };
const PAGE = 20;
const REASON_MAX = 200;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'reviews.moderate')) return;
    await loadCss('/css/pages/admin-reviews.css');
    await safeMount(ctx, async () => {
      const [names, repLoad, pending] = await Promise.all([productNames().catch(() => ({})), loadReports(), loadReviewList('pending')]);
      if (ctx.signal.aborted) return;
      const href = (p) => ctx.router.href(p);
      const canProducts = can('products.read');
      let reports = repLoad.grouped;
      let reportsCapped = repLoad.capped;
      const lists = { pending, approved: null, rejected: null, reported: null };     // { items, capped } once a tab has been opened
      const known = new Map();
      const state = { tab: 'pending', q: '', rating: 0, verified: '', shown: PAGE, error: null };
      const remember = (items) => items.forEach((r) => known.set(r.id, r));
      remember(pending.items);

      /* ── what the current tab shows ── */
      const tabItems = (tab) => {
        const l = lists[tab];
        if (!l) return [];
        return tab === 'reported' ? l.items.filter((r) => reports.has(r.id)) : l.items;
      };
      const visible = () => {
        const list = filterReviews(tabItems(state.tab), { q: state.q, rating: state.rating, verified: state.verified, names });
        if (state.tab !== 'reported') return orderReviews(list, state.tab);
        return list.slice().sort((a, b) => (reports.get(b.id).length - reports.get(a.id).length) || (b.createdMs - a.createdMs));
      };
      const tabCount = (tab) => {
        if (tab === 'reported') return reports.size;
        const l = lists[tab];
        return l ? l.items.length : null;
      };

      const ensure = async (tab) => {
        if (lists[tab]) return;
        if (tab === 'reported') {
          const ids = [...reports.keys()];
          lists.reported = { items: await loadReviewsByIds(ids), capped: ids.length > 60 };
        } else lists[tab] = await loadReviewList(tab);
        remember(lists[tab].items);
      };

      /* ── drawing ── */
      const reportsBlock = (reps) => html`<div class="rvm-reports">
        <p class="rvm-reports-t">${icon('flag', { size: 14 })}<span>${t('rvm.reports.title')}</span></p>
        <ul>${reps.slice(0, 3).map((x) => html`<li><span class="rvm-rr">${x.reason}</span> <span class="rvm-rd">${fmtDateTime(x.createdMs)}</span></li>`)}</ul>
        ${reps.length > 3 ? html`<p class="rvm-more">${t('rvm.reports.more', { n: num(reps.length - 3) })}</p>` : ''}</div>`;

      const productLine = (r) => {
        const name = names[r.productId];
        if (!name) return html`<span class="rvm-gone">${t('rvm.productGone')}</span> <span class="mono">${r.productId}</span>`;
        return canProducts ? html`<a href="${href('/products/' + encodeURIComponent(r.productId))}">${name}</a>` : html`<span>${name}</span>`;
      };

      const card = (r) => {
        const reps = reports.get(r.id) || [];
        return html`<article class="card rvm-card" data-id="${r.id}" aria-labelledby="rvm-t-${r.id}">
          <div class="rvm-top">${stars(r.rating, { size: 16 })}<h2 class="rvm-title" id="rvm-t-${r.id}">${r.title}</h2></div>
          <p class="rvm-meta"><span>${r.userName || t('rvm.anon')}</span><span aria-hidden="true">·</span><span>${fmtDateTime(r.createdMs)}</span>
            ${state.tab === 'reported' ? badge(t(`rvm.status.${r.status}`), TONE[r.status]) : ''}
            ${r.verified ? badge(t('rvm.verified'), 'ok') : ''}
            ${reps.length ? badge(tn('rvm.reports', reps.length, { n: num(reps.length) }), 'bad') : ''}
            ${r.helpfulCount ? html`<span class="rvm-helpful">${icon('thumbs-up', { size: 14 })}${tn('rvm.helpful', r.helpfulCount, { n: num(r.helpfulCount) })}</span>` : ''}</p>
          <p class="rvm-product">${icon('tag', { size: 14 })}<span class="sr-only">${t('rvm.product')}: </span>${productLine(r)}</p>
          <p class="rvm-text">${r.text}</p>
          ${r.status === 'rejected' && r.note ? html`<p class="rvm-reason"><strong>${t('rvm.reason')}</strong> ${r.note}</p>` : ''}
          ${reps.length ? reportsBlock(reps) : ''}
          <div class="rvm-actions">
            ${r.status !== 'approved' ? html`<button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${r.id}">${icon('check', { size: 16 })}<span>${t('rvm.approve')}</span></button>` : ''}
            ${reps.length ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="dismiss" data-id="${r.id}">${t('rvm.dismiss')}</button>` : ''}
            ${r.status !== 'rejected' ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="reject" data-id="${r.id}">${t('rvm.reject')}</button>` : ''}
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="row-menu" data-id="${r.id}" aria-haspopup="menu" aria-label="${t('rvm.menu.more')}">${icon('more-horizontal', { size: 18 })}</button>
          </div></article>`;
      };

      const results = () => {
        if (state.error) return errorState({ text: state.error });
        const l = lists[state.tab];
        if (!l) return spinnerBlock();
        const all = tabItems(state.tab);
        if (!all.length) return emptyState({ icon: TAB_ICON[state.tab], title: t(`rvm.empty.${state.tab}`), text: t(`rvm.emptyText.${state.tab}`) });
        const list = visible();
        if (!list.length) return emptyState({ icon: 'search', title: t('rvm.noMatch'), text: t('rvm.noMatchText') });
        const slice = list.slice(0, state.shown);
        const note = l.capped && state.tab !== 'reported' ? t('rvm.capped', { n: num(LIST_CAP) }) : (state.tab === 'reported' && (reportsCapped || l.capped) ? t('rvm.reportsCapped') : '');
        return html`${note ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${note}</div></div>` : ''}
          <div class="rvm-list">${slice.map(card)}</div>
          <div class="rvm-foot"><span class="muted small">${t('rvm.footer', { shown: num(slice.length), total: num(list.length) })}</span>
            ${slice.length < list.length ? html`<button type="button" class="btn" data-action="more">${t('common.showMore')}</button>` : ''}</div>`;
      };

      const tabsHtml = () => html`<div class="tabs rvm-tabs" role="tablist" aria-label="${t('rvm.tabs')}">${TABS.map((tab) => {
        const n = tabCount(tab);
        const more = tab === 'pending' && lists.pending && lists.pending.capped ? '+' : '';
        return html`<button type="button" class="tab" role="tab" id="rvm-tab-${tab}" aria-selected="${state.tab === tab ? 'true' : 'false'}" tabindex="${state.tab === tab ? '0' : '-1'}" aria-controls="rvm-results" data-action="tab" data-tab="${tab}">${t(`rvm.tab.${tab}`)}${n !== null ? html`<span class="rvm-n">${num(n)}${more}</span>` : ''}</button>`;
      })}</div>`;

      const paintResults = () => { render(ctx.el.querySelector('#rvm-results'), results()); };
      const paintTabs = () => { render(ctx.el.querySelector('#rvm-tabs-wrap'), tabsHtml()); };
      const paint = () => render(ctx.el, html`
        ${pageHead({ title: t('rvm.title'), sub: t('rvm.sub'), actions: html`<button type="button" class="btn" data-action="reload">${icon('refresh', { size: 18 })}<span>${t('common.refresh')}</span></button>` })}
        <div id="rvm-tabs-wrap">${tabsHtml()}</div>
        <div class="toolbar" role="search">
          ${searchField({ id: 'q', value: state.q, placeholder: t('rvm.search'), label: t('rvm.search'), bind: 'q' })}
          <select class="select" id="rvm-rating" data-change="rating" aria-label="${t('rvm.f.rating')}"><option value="0">${t('rvm.f.allRatings')}</option>${[5, 4, 3, 2, 1].map((n) => html`<option value="${n}" ${state.rating === n ? raw('selected') : ''}>${tn('rvm.f.stars', n, { n: num(n) })}</option>`)}</select>
          <select class="select" id="rvm-verified" data-change="verified" aria-label="${t('rvm.f.purchase')}"><option value="">${t('rvm.f.allPurchases')}</option><option value="yes" ${state.verified === 'yes' ? raw('selected') : ''}>${t('rvm.f.verified')}</option><option value="no" ${state.verified === 'no' ? raw('selected') : ''}>${t('rvm.f.unverified')}</option></select>
        </div>
        <div id="rvm-results" role="tabpanel" aria-labelledby="rvm-tab-${state.tab}">${results()}</div>`);
      paint();

      /* ── switching tabs and reloading ── */
      const open = async (tab, { focus = false } = {}) => {
        state.tab = tab; state.shown = PAGE; state.error = null;
        paint();
        if (focus) ctx.el.querySelector(`#rvm-tab-${tab}`)?.focus();
        try { await ensure(tab); } catch (e) { reportError(e, 'reviews.load'); if (state.tab === tab) state.error = explainError(e); }
        if (ctx.signal.aborted || state.tab !== tab) return;
        paintTabs(); paintResults();
      };
      const reload = async () => {
        try {
          const [rep, p] = await Promise.all([loadReports(), loadReviewList('pending')]);
          reports = rep.grouped; reportsCapped = rep.capped; lists.pending = p;
          for (const k of ['approved', 'rejected']) if (lists[k]) lists[k] = await loadReviewList(k);
          lists.reported = null;
          known.clear();
          for (const k of ['pending', 'approved', 'rejected']) if (lists[k]) remember(lists[k].items);
          state.error = null;
        } catch (e) { reportError(e, 'reviews.reload'); toastError(explainError(e)); return; }
        await open(state.tab);
      };

      /* ── changing a review ── */
      const patchLocal = (r, to, note) => {
        for (const k of ['pending', 'approved', 'rejected']) if (lists[k]) lists[k].items = lists[k].items.filter((x) => x.id !== r.id);
        const next = { ...r, status: to, note: to === 'rejected' ? String(note || '').replace(/\s+/g, ' ').trim() : '' };
        known.set(r.id, next);
        if (lists[to]) lists[to].items.push(next);
        if (lists.reported) lists.reported.items = lists.reported.items.map((x) => (x.id === r.id ? next : x));
        if (to === 'rejected') reports.delete(r.id);                       // a rejection answers the reports
      };
      const dropLocal = (id) => {
        for (const k of ['pending', 'approved', 'rejected', 'reported']) if (lists[k]) lists[k].items = lists[k].items.filter((x) => x.id !== id);
        reports.delete(id); known.delete(id);
      };
      const lock = (id) => {
        const el = ctx.el.querySelector(`.rvm-card[data-id="${CSS.escape(id)}"]`);
        const btns = el ? [...el.querySelectorAll('button')] : [];
        btns.forEach((b) => { b.disabled = true; });
        if (el) el.setAttribute('aria-busy', 'true');
        return () => { btns.forEach((b) => { b.disabled = false; }); if (el) el.removeAttribute('aria-busy'); };
      };
      const failed = async (e, where, form = null) => {
        if (!isRefusal(e)) reportError(e, where);
        if (form && e && e.errors && e.errors.note) { showFormErrors(form, { note: t('rvm.err.invalid') }); return; }
        toastError(explainError(e));
        if (e && (e.code === 'not_found' || e.code === 'no_change')) await reload();      // somebody else got there first
      };
      const ratingNote = (plan) => (plan.rating ? ` · ${t('rvm.toast.rating', { avg: num(plan.rating.ratingAvg), n: num(plan.rating.ratingCount) })}` : '');

      const change = async (r, to, note = '', form = null) => {
        const unlock = lock(r.id);
        try {
          const plan = await moderateReview({ id: r.id, to, note });
          patchLocal(r, to, note);
          toast(`${t(`rvm.toast.${to}`)}${ratingNote(plan)}`);
          paintTabs(); paintResults();
          return true;
        } catch (e) { await failed(e, 'reviews.moderate', form); return false; } finally { unlock(); }
      };
      const rejectDialog = (r) => formDialog({
        title: t('rvm.reject.title'), confirmText: t('rvm.reject'),
        body: html`<form novalidate data-form="reject"><div class="stack"><p class="muted">${t('rvm.reject.text')}</p>
          ${fieldHtml({ name: 'note', label: t('rvm.reject.note'), type: 'textarea', rows: 3, hint: t('rvm.reject.noteHint'), attrs: { maxlength: REASON_MAX, autocomplete: 'off' } })}</div></form>`,
        onSubmit: async (form) => change(r, 'rejected', readForm(form).note || '', form),
      });
      const remove = async (r) => {
        if (!(await confirmDialog({ title: t('rvm.del.title'), message: t('rvm.del.text'), confirmText: t('rvm.menu.delete'), danger: true }))) return;
        const unlock = lock(r.id);
        try {
          const plan = await deleteReview({ id: r.id });
          dropLocal(r.id);
          toast(`${t('rvm.toast.deleted')}${ratingNote(plan)}`);
          paintTabs(); paintResults();
        } catch (e) { await failed(e, 'reviews.delete'); } finally { unlock(); }
      };
      const dismiss = async (r) => {
        const n = (reports.get(r.id) || []).length;
        if (!(await confirmDialog({ title: t('rvm.dismiss.title'), message: tn('rvm.dismiss.text', n, { n: num(n) }), confirmText: t('rvm.dismiss') }))) return;
        const unlock = lock(r.id);
        try {
          await dismissReports({ id: r.id });
          reports.delete(r.id);
          toast(t('rvm.toast.dismissed'));
          paintTabs(); paintResults();
        } catch (e) { await failed(e, 'reviews.dismiss'); } finally { unlock(); }
      };

      const onKey = (e) => {
        const tab = e.target.closest && e.target.closest('[role="tab"]');
        if (!tab) return;
        const i = TABS.indexOf(tab.dataset.tab);
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        open(TABS[(to + TABS.length) % TABS.length], { focus: true });
      };
      ctx.el.addEventListener('keydown', onKey);
      ctx.cleanup(() => ctx.el.removeEventListener('keydown', onKey));

      const byId = (el) => known.get(el.dataset.id);
      ctx.cleanup(bindActions(ctx.el, {
        tab: (el) => { if (el.dataset.tab !== state.tab) open(el.dataset.tab, { focus: true }); },
        more: () => { state.shown += PAGE; paintResults(); },
        reload,
        retry: () => open(state.tab),
        approve: (el) => { const r = byId(el); if (r) change(r, 'approved'); },
        reject: (el) => { const r = byId(el); if (r) rejectDialog(r); },
        dismiss: (el) => { const r = byId(el); if (r) dismiss(r); },
        'row-menu': (btn) => {
          const r = byId(btn);
          if (!r) return;
          const items = [];
          if (r.status !== 'pending') items.push({ label: t('rvm.menu.pending'), icon: 'undo', onClick: () => change(r, 'pending') });
          items.push({ label: t('rvm.menu.delete'), icon: 'trash', danger: true, onClick: () => remove(r) });
          openMenu({ anchor: btn, items });
        },
      }, {
        input: { q: debounce((el) => { state.q = el.value; state.shown = PAGE; paintResults(); }, 200) },
        change: {
          rating: (el) => { state.rating = Number(el.value) || 0; state.shown = PAGE; paintResults(); },
          verified: (el) => { state.verified = el.value; state.shown = PAGE; paintResults(); },
        },
      }));
    });
  },
};
