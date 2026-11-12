/*
 * Audit log. Permission: audit.read (Super Admin, Store Admin).
 *
 * Every staff action is written to `auditLogs` in the same atomic batch as the change itself (who, what, on what, before → after); the rules let nobody edit or delete an entry.
 * This page lists the newest entries — 100 at a time ("Load more", at most 1 000 in the page) — for a chosen period. Search, area and person filter what is LOADED
 * (the database is asked only for the period, so no composite index is needed); a note says so. "Details" shows the entry field by field: what changed, and the raw snapshots.
 * Rules of the game: shared/auditView.js.
 */
import { html, render, raw, bindActions, debounce } from '../../core/dom.js';
import { registerBoth, t, tn, lbl } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { emptyState, errorState, spinnerBlock, paginationHtml, openModal, badge, loadCss } from '../../core/ui.js';
import { explainError, reportError } from '../../core/errors.js';
import { num, fmtDateTime, relTime } from '../../core/format.js';
import { local } from '../../core/storage.js';
import { can } from '../../data/auth.js';
import { ROLES } from '../../shared/constants.js';
import { AUDIT, PERIODS, isPeriod, diffEntry, rawJson, entityRoute, matchesFilters, tally } from '../../shared/auditView.js';
import { timeKey } from '../../shared/reportFlow.js';
import { safeMount, pageHead, needs, searchField, kvList, runAction } from '../lib/ui.js';
import { loadAuditPage } from '../data/audit.js';

const ENTITIES = {
  order: ['Order', 'অর্ডার'], product: ['Product', 'প্রোডাক্ট'], inventory: ['Inventory', 'ইনভেন্টরি'], category: ['Category', 'ক্যাটাগরি'], brand: ['Brand', 'ব্র্যান্ড'],
  coupon: ['Coupon', 'কুপন'], customer: ['Customer', 'কাস্টমার'], staff: ['Staff', 'স্টাফ'], settings: ['Settings', 'সেটিংস'], content: ['Homepage', 'হোমপেজ'],
  page: ['Page', 'পেজ'], review: ['Review', 'রিভিউ'], ticket: ['Support request', 'সাপোর্ট রিকোয়েস্ট'], shipping_zone: ['Shipping zone', 'শিপিং জোন'],
  report: ['Report', 'রিপোর্ট'], newsletter: ['Newsletter', 'নিউজলেটার'], system: ['System', 'সিস্টেম'],
};

registerBoth({
  'aud.title': ['Audit log', 'অডিট লগ'],
  'aud.sub': ['Who did what, and when. Every staff change is recorded here together with the values before and after — an entry can never be edited or deleted.', 'কে কী করেছেন, কখন — প্রতিটি স্টাফ-পরিবর্তন আগের ও পরের মানসহ এখানে জমা হয়। কোনো এন্ট্রি বদলানো বা মোছা যায় না।'],
  'aud.search': ['Search summary, action, order number or e-mail', 'সারাংশ, অ্যাকশন, অর্ডার নম্বর বা ইমেইল খুঁজুন'],
  'aud.f.area': ['Area', 'এলাকা'],
  'aud.f.areaAll': ['All areas', 'সব এলাকা'],
  'aud.f.person': ['Person', 'ব্যক্তি'],
  'aud.f.personAll': ['Everyone', 'সবাই'],
  'aud.f.period': ['Period', 'সময়'],
  'aud.period.24h': ['Last 24 hours', 'গত ২৪ ঘণ্টা'],
  'aud.period.7d': ['Last 7 days', 'গত ৭ দিন'],
  'aud.period.30d': ['Last 30 days', 'গত ৩০ দিন'],
  'aud.period.all': ['Everything', 'সব সময়'],
  'aud.clear': ['Clear filters', 'ফিল্টার মুছুন'],
  'aud.count_one': ['1 of the {loaded} loaded entries', 'লোড হওয়া {loaded}টির মধ্যে ১টি এন্ট্রি'],
  'aud.count_other': ['{n} of the {loaded} loaded entries', 'লোড হওয়া {loaded}টির মধ্যে {n}টি এন্ট্রি'],
  'aud.col.when': ['When', 'কখন'],
  'aud.col.who': ['Who', 'কে'],
  'aud.col.what': ['What happened', 'কী হয়েছে'],
  'aud.col.about': ['About', 'কোনটি সম্পর্কে'],
  'aud.details': ['Details', 'বিস্তারিত'],
  'aud.detailsFor': ['Details of: {summary}', 'বিস্তারিত: {summary}'],
  'aud.footer': ['Showing {shown} of {total}', '{total}টির মধ্যে {shown}টি দেখানো হচ্ছে'],
  'aud.loadMore': ['Load {n} older entries', 'আরও {n}টি পুরোনো এন্ট্রি আনুন'],
  'aud.filterNote': ['Search and filters look at the entries loaded so far. Load older entries to search further back.', 'সার্চ ও ফিল্টার এখন পর্যন্ত লোড হওয়া এন্ট্রিতে কাজ করে। আরও পেছনে খুঁজতে পুরোনো এন্ট্রি আনুন।'],
  'aud.capped': ['The newest {n} entries of this period are loaded. Pick a shorter period to look at a specific time.', 'এই সময়ের নতুন {n}টি এন্ট্রি লোড হয়েছে। নির্দিষ্ট সময় দেখতে ছোট সময় বেছে নিন।'],
  'aud.none': ['Nothing recorded in this period', 'এই সময়ে কিছু রেকর্ড হয়নি'],
  'aud.noneText.period': ['Pick a longer period to look further back.', 'আরও পেছনে দেখতে বড় সময় বেছে নিন।'],
  'aud.noneText.all': ['Staff actions will appear here as they happen.', 'স্টাফের কাজ হলে এখানে দেখা যাবে।'],
  'aud.noMatch': ['No loaded entry matches', 'লোড হওয়া কোনো এন্ট্রি মেলেনি'],
  'aud.noMatchText': ['Change the filters, or load older entries.', 'ফিল্টার বদলান, অথবা পুরোনো এন্ট্রি আনুন।'],
  'aud.d.title': ['Entry details', 'এন্ট্রির বিস্তারিত'],
  'aud.d.when': ['When (Bangladesh time)', 'কখন (বাংলাদেশ সময়)'],
  'aud.d.who': ['Who', 'কে'],
  'aud.d.action': ['Action', 'অ্যাকশন'],
  'aud.d.about': ['About', 'কোনটি সম্পর্কে'],
  'aud.d.summary': ['Summary', 'সারাংশ'],
  'aud.d.open': ['Open {what}', '{what} খুলুন'],
  'aud.d.changes': ['What changed', 'কী বদলেছে'],
  'aud.d.none': ['No before / after values were recorded for this action.', 'এই কাজের আগে/পরের কোনো মান রেকর্ড করা হয়নি।'],
  'aud.d.same': ['The two snapshots do not differ.', 'আগের ও পরের মানে কোনো পার্থক্য নেই।'],
  'aud.d.created': ['Created — these values were set:', 'তৈরি হয়েছে — এই মানগুলো বসানো হয়েছে:'],
  'aud.d.deleted': ['Removed — these values were deleted:', 'মুছে ফেলা হয়েছে — এই মানগুলো মুছেছে:'],
  'aud.d.changed': ['Only the fields that differ are listed.', 'শুধু যে ফিল্ডগুলো আলাদা সেগুলো দেখানো হলো।'],
  'aud.d.field': ['Field', 'ফিল্ড'],
  'aud.d.before': ['Before', 'আগে'],
  'aud.d.after': ['After', 'পরে'],
  'aud.d.more': ['{n} more fields are not listed — see the raw data.', 'আরও {n}টি ফিল্ড তালিকায় নেই — র ডেটা দেখুন।'],
  'aud.d.raw': ['Raw data', 'র ডেটা'],
  'aud.chg.added': ['Added', 'নতুন'],
  'aud.chg.removed': ['Removed', 'মোছা'],
  'aud.chg.changed': ['Changed', 'বদলেছে'],
  ...Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [`aud.entity.${k}`, v])),
});

const KEY = 'sv.admin.auditPeriod';
const ROWS = 50;
const entityLabel = (e) => (ENTITIES[e] ? t(`aud.entity.${e}`) : e || '—');
const roleName = (r) => (ROLES[r] ? lbl(ROLES[r]) : r);
const CHANGE_TONE = { added: 'ok', removed: 'bad', changed: 'info' };

export default {
  async mount(ctx) {
    if (!needs(ctx, 'audit.read')) return;
    await loadCss('/css/pages/admin-audit.css');
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      const saved = local.get(KEY, '7d');
      const state = {
        period: isPeriod(saved) ? saved : '7d',
        q: String(ctx.query.q || '').slice(0, 100),
        entity: /^[a-z_]{1,40}$/.test(String(ctx.query.entity || '')) ? String(ctx.query.entity) : '',
        actor: '', entries: [], cursor: null, more: false, status: 'loading', error: null, page: 1, gen: 0,
      };

      const filtered = () => state.entries.filter((e) => matchesFilters(e, state));
      const filtersOn = () => !!(state.q.trim() || state.entity || state.actor);

      /* ── the filter lists follow what is loaded; a chosen value stays selectable even when the loaded entries have none ── */
      const selectsHtml = () => {
        const areas = tally(state.entries, 'entity');
        const people = tally(state.entries, 'actorUid', (e) => e.actorEmail || e.actorUid);
        const withCurrent = (list, cur, label) => (cur && !list.some((x) => x.value === cur) ? [...list, { value: cur, label, count: 0 }] : list);
        const areaOpts = withCurrent(areas, state.entity, entityLabel(state.entity));
        const personOpts = withCurrent(people, state.actor, state.actor);
        const opt = (value, text, cur) => html`<option value="${value}" ${value === cur ? raw('selected') : ''}>${text}</option>`;
        return html`
          <div class="aud-sel"><label class="sr-only" for="f-entity">${t('aud.f.area')}</label>
            <select class="select" id="f-entity" data-change="entity">${opt('', t('aud.f.areaAll'), state.entity)}${areaOpts.map((a) => opt(a.value, `${entityLabel(a.value)} (${num(a.count)})`, state.entity))}</select></div>
          <div class="aud-sel"><label class="sr-only" for="f-actor">${t('aud.f.person')}</label>
            <select class="select" id="f-actor" data-change="actor">${opt('', t('aud.f.personAll'), state.actor)}${personOpts.map((a) => opt(a.value, `${a.label} (${num(a.count)})`, state.actor))}</select></div>
          <div class="aud-sel"><label class="sr-only" for="f-period">${t('aud.f.period')}</label>
            <select class="select" id="f-period" data-change="period">${PERIODS.map((p) => opt(p, t(`aud.period.${p}`), state.period))}</select></div>`;
      };

      const countHtml = () => {
        if (state.status !== 'ready' || !state.entries.length) return '';
        const n = filtered().length;
        return html`<span>${tn('aud.count', n, { n: num(n), loaded: num(state.entries.length) })}</span>${filtersOn() ? html` <button type="button" class="btn btn-ghost btn-sm" data-action="clear">${t('aud.clear')}</button>` : ''}`;
      };

      const row = (e) => {
        const route = entityRoute(e.entity, e.entityId, can);
        const what = e.summary || e.action;
        return html`<tr>
          <td class="cell-first"><div class="cell-main"><div><span class="t">${e.createdMs ? fmtDateTime(e.createdMs) : '—'}</span><div class="s">${e.createdMs ? relTime(e.createdMs) : ''}</div></div></div></td>
          <td data-label="${t('aud.col.who')}"><div class="aud-who"><span class="aud-mail">${e.actorEmail || e.actorUid || '—'}</span>${e.actorRole ? badge(roleName(e.actorRole), 'neutral') : ''}</div></td>
          <td data-label="${t('aud.col.what')}"><div class="aud-what"><span>${what}</span><code class="aud-code" translate="no">${e.action}</code></div></td>
          <td data-label="${t('aud.col.about')}"><span class="aud-about">${entityLabel(e.entity)}${e.entityId ? html` · ${route ? html`<a href="${href(route)}">${e.entityId}</a>` : e.entityId}` : ''}</span></td>
          <td class="cell-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="detail" data-id="${e.id}" aria-label="${t('aud.detailsFor', { summary: what })}">${icon('eye', { size: 16 })}<span>${t('aud.details')}</span></button></td>
        </tr>`;
      };

      const moreBlock = () => {
        if (!state.more) return '';
        if (state.entries.length >= AUDIT.MAX_LOADED) return html`<div class="alert alert-info mt-4" role="note">${icon('info', { size: 18 })}<div>${t('aud.capped', { n: num(AUDIT.MAX_LOADED) })}</div></div>`;
        return html`<div class="aud-more"><button type="button" class="btn" data-action="more">${icon('plus', { size: 18 })}<span>${t('aud.loadMore', { n: num(AUDIT.PAGE) })}</span></button></div>`;
      };

      const results = () => {
        if (state.status === 'loading') return spinnerBlock();
        if (state.status === 'error') return errorState({ text: state.error });
        if (!state.entries.length) return emptyState({ icon: 'history', title: t('aud.none'), text: t(state.period === 'all' ? 'aud.noneText.all' : 'aud.noneText.period') });
        const list = filtered();
        const note = state.more ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${t('aud.filterNote')}</div></div>` : '';
        if (!list.length) return html`${emptyState({ icon: 'search', title: t('aud.noMatch'), text: t('aud.noMatchText') })}${moreBlock()}`;
        const pages = Math.max(1, Math.ceil(list.length / ROWS));
        state.page = Math.min(state.page, pages);
        const slice = list.slice((state.page - 1) * ROWS, state.page * ROWS);
        return html`${filtersOn() ? note : ''}
          <div class="table-wrap"><table class="table table-stack table-cards aud-table" id="aud-table">
            <thead><tr><th scope="col">${t('aud.col.when')}</th><th scope="col">${t('aud.col.who')}</th><th scope="col">${t('aud.col.what')}</th><th scope="col">${t('aud.col.about')}</th><th scope="col"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
            <tbody>${slice.map(row)}</tbody></table>
            <div class="table-footer"><span>${t('aud.footer', { shown: num(slice.length), total: `${num(list.length)}${state.more ? '+' : ''}` })}</span></div></div>
          ${paginationHtml({ page: state.page, pages })}${moreBlock()}`;
      };

      const q = (sel) => ctx.el.querySelector(sel);
      const paintSelects = () => { const el = q('#aud-selects'); if (el) render(el, selectsHtml()); };
      const paintCount = () => { const el = q('#aud-count'); if (el) render(el, countHtml()); };
      const paintResults = () => { const el = q('#aud-results'); if (el) render(el, results()); };
      const paintAll = () => { paintSelects(); paintCount(); paintResults(); };

      render(ctx.el, html`<div class="aud">
        ${pageHead({ title: t('aud.title'), sub: t('aud.sub'), actions: html`<button type="button" class="btn" data-action="refresh">${icon('refresh', { size: 18 })}<span>${t('common.refresh')}</span></button>` })}
        <div class="toolbar aud-toolbar" role="search">
          ${searchField({ id: 'q', value: state.q, placeholder: t('aud.search'), label: t('aud.search'), bind: 'q' })}
          <div class="aud-selects" id="aud-selects">${selectsHtml()}</div>
        </div>
        <p class="aud-count muted" id="aud-count" role="status" aria-live="polite"></p>
        <div id="aud-results">${results()}</div></div>`);

      /** the first page of the chosen period (a newer call wins when the period is changed quickly) */
      const reset = async () => {
        const gen = ++state.gen;
        Object.assign(state, { status: 'loading', entries: [], cursor: null, more: false, page: 1, error: null });
        paintAll();
        try {
          const r = await loadAuditPage({ period: state.period });
          if (ctx.signal.aborted || gen !== state.gen) return;
          Object.assign(state, { entries: r.entries, cursor: r.cursor, more: r.more, status: 'ready' });
        } catch (e) {
          reportError(e, 'audit.load');
          if (ctx.signal.aborted || gen !== state.gen) return;
          Object.assign(state, { status: 'error', error: explainError(e) });
        }
        paintAll();
      };

      const loadMore = async (btn) => {
        const gen = state.gen;
        const r = await runAction(btn, () => loadAuditPage({ period: state.period, cursor: state.cursor }), { quiet: true });
        if (!r.ok || ctx.signal.aborted || gen !== state.gen) return;
        Object.assign(state, { entries: [...state.entries, ...r.value.entries], cursor: r.value.cursor, more: r.value.more });
        paintAll();
      };

      const detailsHtml = (e) => {
        const route = entityRoute(e.entity, e.entityId, can);
        const d = diffEntry(e.before, e.after);
        const lead = { none: 'aud.d.none', same: 'aud.d.same', created: 'aud.d.created', deleted: 'aud.d.deleted', changed: 'aud.d.changed' }[d.kind];
        const diffRow = (r) => html`<tr>
          <th scope="row" class="cell-first"><code class="aud-code" translate="no">${r.path}</code> ${badge(t(`aud.chg.${r.change}`), CHANGE_TONE[r.change])}</th>
          <td data-label="${t('aud.d.before')}"><span class="aud-val">${r.before}</span></td>
          <td data-label="${t('aud.d.after')}"><span class="aud-val">${r.after}</span></td></tr>`;
        return html`${kvList([
          [t('aud.d.when'), html`${e.createdMs ? timeKey(e.createdMs) : '—'} <span class="muted">· ${e.createdMs ? relTime(e.createdMs) : ''}</span>`],
          [t('aud.d.who'), html`<span class="aud-mail">${e.actorEmail || '—'}</span> ${e.actorRole ? badge(roleName(e.actorRole), 'neutral') : ''}<div class="aud-uid">${e.actorUid}</div>`],
          [t('aud.d.action'), html`<code class="aud-code" translate="no">${e.action}</code>`],
          [t('aud.d.about'), html`${entityLabel(e.entity)}${e.entityId ? html` · <span class="aud-id">${e.entityId}</span>` : ''}`],
          [t('aud.d.summary'), e.summary || '—'],
        ])}
          ${route ? html`<p class="aud-open"><a class="btn btn-sm" href="${href(route)}" data-modal-close>${t('aud.d.open', { what: entityLabel(e.entity) })}${icon('arrow-right', { size: 16 })}</a></p>` : ''}
          <h3 class="aud-h">${t('aud.d.changes')}</h3>
          <p class="muted" data-kind="${d.kind}">${t(lead)}</p>
          ${d.rows.length ? html`<div class="table-wrap"><table class="table table-stack table-cards aud-diff">
            <thead><tr><th scope="col">${t('aud.d.field')}</th><th scope="col">${t('aud.d.before')}</th><th scope="col">${t('aud.d.after')}</th></tr></thead>
            <tbody>${d.rows.map(diffRow)}</tbody></table></div>${d.hidden ? html`<p class="muted">${t('aud.d.more', { n: num(d.hidden) })}</p>` : ''}` : ''}
          <details class="aud-raw"><summary>${t('aud.d.raw')}</summary><pre tabindex="0">${rawJson(e.before, e.after)}</pre></details>`;
      };

      ctx.cleanup(bindActions(ctx.el, {
        refresh: reset,
        retry: reset,
        more: loadMore,
        detail: (el) => {
          const e = state.entries.find((x) => x.id === el.dataset.id);
          if (!e) return;
          const dlg = openModal({ title: t('aud.d.title'), size: 'lg', body: detailsHtml(e) });
          ctx.cleanup(() => dlg.close());
        },
        page: (el) => { state.page = Number(el.dataset.page) || 1; paintResults(); },
        clear: () => {
          Object.assign(state, { q: '', entity: '', actor: '', page: 1 });
          const input = q('#q'); if (input) input.value = '';
          paintAll();
        },
      }, {
        input: { q: debounce((el) => { state.q = el.value; state.page = 1; paintCount(); paintResults(); }, 200) },
        change: {
          entity: (el) => { state.entity = el.value; state.page = 1; paintCount(); paintResults(); },
          actor: (el) => { state.actor = el.value; state.page = 1; paintCount(); paintResults(); },
          period: (el) => { if (!isPeriod(el.value)) return; state.period = el.value; local.set(KEY, el.value); reset(); },
        },
      }));

      await reset();
    });
  },
};
