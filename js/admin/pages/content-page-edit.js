/*
 * Content → one page (create or edit). Permission: content.write (Super Admin, Store Admin, Product Manager).
 * Route /content/pages/new creates, /content/pages/<address> edits. The address (the part after /page/) is chosen once and cannot change afterwards — a changed
 * address would be a different page and break every link to the old one. The text is Markdown (# heading, **bold**, - list, [link](https://…)); the preview uses the very
 * same renderer as the shop, which escapes everything and only emits a few safe tags. Saving checks the fields again (title, address, length) and writes the audit log.
 * Rules of the game: shared/contentFlow.js + shared/contentModel.js.
 */
import { html, render, raw, bindActions, delegate, readForm, withBusy } from '../../core/dom.js';
import { registerBoth, t, pick } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { errorState, spinnerBlock, fieldHtml, toast, toastError, loadCss } from '../../core/ui.js';
import { showFormErrors } from '../../core/validate.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, fmtDateTime } from '../../core/format.js';
import { slugify } from '../../shared/slug.js';
import { renderMarkdown } from '../../shared/markdown.js';
import { PAGE_LIMITS } from '../../shared/contentModel.js';
import { safeMount, pageHead, needs } from '../lib/ui.js';
import { loadPageDoc, savePage } from '../data/content.js';

registerBoth({
  'cpe.new': ['New page', 'নতুন পেজ'],
  'cpe.edit': ['Edit page', 'পেজ সম্পাদনা'],
  'cpe.back': ['All pages', 'সব পেজ'],
  'cpe.sub.new': ['Write the text, choose the address and decide whether visitors can see it.', 'লেখা লিখুন, ঠিকানা বেছে নিন এবং ঠিক করুন ভিজিটররা এটি দেখতে পাবেন কি না।'],
  'cpe.sub.edit': ['Changes reach visitors as soon as you save.', 'সংরক্ষণ করার সাথে সাথেই পরিবর্তন ভিজিটরদের কাছে পৌঁছায়।'],
  'cpe.view': ['View page', 'পেজ দেখুন'],
  'cpe.notfound': ['This page does not exist (anymore).', 'এই পেজটি নেই (বা আর নেই)।'],
  'cpe.f.title': ['Title', 'শিরোনাম'],
  'cpe.f.slug': ['Address', 'ঠিকানা'],
  'cpe.f.slugHint': ['Lower-case letters, digits and hyphens. It cannot be changed after saving.', 'ছোট হাতের ইংরেজি অক্ষর, সংখ্যা ও হাইফেন। সংরক্ষণের পর এটি বদলানো যায় না।'],
  'cpe.f.slugFixed': ['The address cannot be changed.', 'ঠিকানা বদলানো যায় না।'],
  'cpe.f.body': ['Text', 'লেখা'],
  'cpe.f.bodyHint': ['Markdown: # heading, **bold**, - list, [link](https://…)', 'Markdown: # শিরোনাম, **গাঢ়**, - তালিকা, [লিংক](https://…)'],
  'cpe.tab.write': ['Write', 'লিখুন'],
  'cpe.tab.preview': ['Preview', 'প্রিভিউ'],
  'cpe.preview.empty': ['Nothing to preview yet.', 'প্রিভিউ করার মতো কিছু এখনও নেই।'],
  'cpe.f.visible': ['Show this page to visitors', 'এই পেজ ভিজিটরদের দেখান'],
  'cpe.f.visibleHint': ['Off = visitors get a "page not found". You can still edit it here.', 'বন্ধ থাকলে ভিজিটররা "পেজ পাওয়া যায়নি" দেখবেন। এখানে আপনি তবুও সম্পাদনা করতে পারবেন।'],
  'cpe.f.footer': ['List this page in the footer', 'এই পেজ ফুটারে তালিকাভুক্ত করুন'],
  'cpe.f.order': ['Order in the footer', 'ফুটারে ক্রম'],
  'cpe.f.orderHint': ['Smaller numbers come first.', 'ছোট সংখ্যা আগে আসে।'],
  'cpe.seo': ['Search engines', 'সার্চ ইঞ্জিন'],
  'cpe.f.seoTitle': ['Search title', 'সার্চ শিরোনাম'],
  'cpe.f.seoTitleHint': ['Optional. Shown in browser tabs and search results; the page title is used when empty.', 'ঐচ্ছিক। ব্রাউজার ট্যাব ও সার্চ রেজাল্টে দেখানো হয়; খালি থাকলে পেজের শিরোনাম ব্যবহার হয়।'],
  'cpe.f.seoDesc': ['Search description', 'সার্চ বর্ণনা'],
  'cpe.f.seoDescHint': ['Optional. One or two sentences; the start of the text is used when empty.', 'ঐচ্ছিক। এক বা দুই বাক্য; খালি থাকলে লেখার শুরুর অংশ ব্যবহার হয়।'],
  'cpe.count': ['{n} / {max}', '{n} / {max}'],
  'cpe.save': ['Save', 'সংরক্ষণ'],
  'cpe.saved': ['Page saved', 'পেজ সংরক্ষিত হয়েছে'],
  'cpe.created': ['Page created', 'পেজ তৈরি হয়েছে'],
  'cpe.unsaved': ['You have unsaved changes.', 'আপনার অসংরক্ষিত পরিবর্তন আছে।'],
  'cpe.nochange': ['Nothing has changed since the last save.', 'শেষ সংরক্ষণের পর কিছুই বদলায়নি।'],
  'cpe.updated': ['Last saved {when}', 'সর্বশেষ সংরক্ষণ {when}'],
});

const FIELDS = ['title', 'body', 'visible', 'footer', 'sort', 'seoTitle', 'seoDescription'];
const BLANK = Object.freeze({ slug: '', title: '', body: '', visible: false, footer: true, sort: 0, seoTitle: '', seoDescription: '' });

export default {
  async mount(ctx) {
    if (!needs(ctx, 'content.write')) return;
    await loadCss('/css/pages/admin-content.css');
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      const raw0 = String(ctx.params.slug || '');
      const creating = !raw0 || raw0 === 'new';          // /content/pages/new is a route of its own (no :slug), /content/pages/<address> edits
      const back = html`<a class="back-link" href="${href('/content/pages')}">${icon('arrow-left', { size: 18 })}<span>${t('cpe.back')}</span></a>`;

      let page = creating ? { ...BLANK } : await loadPageDoc(raw0);
      if (ctx.signal.aborted) return;
      if (!page) {
        render(ctx.el, html`<div class="cpe">${back}${errorState({ text: t('cpe.notfound') })}</div>`);
        return;
      }
      let isNew = creating;
      let saved = { ...page };                         // what is stored (baseline for the unsaved-changes note)
      let slugTouched = false;                         // once the person types an address, the title stops suggesting one
      let tab = 'write';

      const form = () => ctx.el.querySelector('form[data-form="page"]');
      const current = () => {
        const f = form(); if (!f) return { ...page };
        const v = readForm(f);
        return {
          slug: isNew ? String(v.slug || '').trim() : page.slug,
          title: String(v.title || ''), body: String(v.body ?? ''), visible: v.visible === true, footer: v.footer === true,
          sort: v.sort === '' || v.sort == null ? 0 : Number(v.sort), seoTitle: String(v.seoTitle || ''), seoDescription: String(v.seoDescription || ''),
        };
      };
      const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();   // the form trims text, the stored text may end in a line break
      const dirtyNow = () => { const c = current(); return isNew ? FIELDS.concat('slug').some((k) => !same(c[k], BLANK[k])) : FIELDS.some((k) => !same(c[k], saved[k])); };
      const paintBar = () => { const d = dirtyNow(); const m = ctx.el.querySelector('#cpe-dirty'); if (m) m.textContent = d ? t('cpe.unsaved') : ''; };
      const counter = (id, max) => { const el = form() && form().querySelector(`#f-${id}`); const out = ctx.el.querySelector(`#cpe-count-${id}`); if (el && out) out.textContent = t('cpe.count', { n: num(el.value.length), max: num(max) }); };

      const preview = () => {
        const f = form(); const box = ctx.el.querySelector('#cpe-preview'); if (!f || !box) return;
        const src = f.elements.body.value;
        const title = f.elements.title.value.trim();
        render(box, src.trim() || title
          ? html`${title ? html`<h2 class="cpe-pv-title">${title}</h2>` : ''}<div class="prose">${raw(renderMarkdown(src))}</div>`
          : html`<p class="muted">${t('cpe.preview.empty')}</p>`);
      };
      const paintTab = () => {
        for (const b of ctx.el.querySelectorAll('[data-tab]')) { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; }
        const w = ctx.el.querySelector('#cpe-write'); const p = ctx.el.querySelector('#cpe-preview');
        if (w) w.hidden = tab !== 'write';
        if (p) p.hidden = tab !== 'preview';
        if (tab === 'preview') preview();
      };

      const body = () => html`<form class="cpe-form stack" data-form="page" novalidate>
        <div class="panel"><div class="panel-body stack">
          ${fieldHtml({ name: 'title', label: t('cpe.f.title'), value: page.title, required: true, attrs: { maxlength: PAGE_LIMITS.TITLE, autocomplete: 'off' } })}
          ${isNew
            ? fieldHtml({ name: 'slug', label: t('cpe.f.slug'), value: page.slug, required: true, hint: t('cpe.f.slugHint'), prefix: '/page/', attrs: { maxlength: PAGE_LIMITS.SLUG, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', dir: 'ltr' } })
            : html`<div class="field"><span class="cpe-label">${t('cpe.f.slug')}</span><div class="cpe-fixed" id="cpe-slug-fixed"><code dir="ltr">/page/${page.slug}</code></div><div class="field-hint">${t('cpe.f.slugFixed')}</div></div>`}
          <div class="field">
            <div class="tabs cpe-tabs" role="tablist" aria-label="${t('cpe.f.body')}">
              <button type="button" class="tab" role="tab" id="cpe-tab-write" aria-selected="true" aria-controls="cpe-write" data-tab="write" data-action="tab">${t('cpe.tab.write')}</button>
              <button type="button" class="tab" role="tab" id="cpe-tab-preview" aria-selected="false" tabindex="-1" aria-controls="cpe-preview" data-tab="preview" data-action="tab">${t('cpe.tab.preview')}</button>
            </div>
            <div id="cpe-write" role="tabpanel" aria-labelledby="cpe-tab-write">${fieldHtml({ name: 'body', label: t('cpe.f.body'), type: 'textarea', value: page.body, rows: 16, hint: t('cpe.f.bodyHint'), attrs: { maxlength: PAGE_LIMITS.BODY } })}
              <div class="cpe-count muted small" id="cpe-count-body" aria-hidden="true"></div></div>
            <div id="cpe-preview" class="cpe-preview" role="tabpanel" aria-labelledby="cpe-tab-preview" hidden></div>
          </div>
        </div></div>
        <div class="panel"><div class="panel-body stack">
          ${fieldHtml({ name: 'visible', type: 'switch', label: t('cpe.f.visible'), value: page.visible, hint: t('cpe.f.visibleHint') })}
          ${fieldHtml({ name: 'footer', type: 'switch', label: t('cpe.f.footer'), value: page.footer })}
          ${fieldHtml({ name: 'sort', label: t('cpe.f.order'), type: 'number', value: page.sort, hint: t('cpe.f.orderHint'), attrs: { min: -9999, max: 9999, step: 1, inputmode: 'numeric' }, cls: 'cpe-order' })}
        </div></div>
        <div class="panel"><div class="panel-head"><h2>${t('cpe.seo')}</h2></div><div class="panel-body stack">
          ${fieldHtml({ name: 'seoTitle', label: t('cpe.f.seoTitle'), value: page.seoTitle, hint: t('cpe.f.seoTitleHint'), attrs: { maxlength: PAGE_LIMITS.SEO_TITLE, autocomplete: 'off' } })}<div class="cpe-count muted small" id="cpe-count-seoTitle" aria-hidden="true"></div>
          ${fieldHtml({ name: 'seoDescription', label: t('cpe.f.seoDesc'), type: 'textarea', rows: 3, value: page.seoDescription, hint: t('cpe.f.seoDescHint'), attrs: { maxlength: PAGE_LIMITS.SEO_DESC } })}<div class="cpe-count muted small" id="cpe-count-seoDescription" aria-hidden="true"></div>
        </div></div>
        <div class="sticky-bar cpe-bar"><span class="muted small" id="cpe-dirty" role="status"></span>
          <div class="row"><a class="btn" href="${href('/content/pages')}">${t('common.cancel')}</a><button type="submit" class="btn btn-primary" data-action="save" id="cpe-save">${icon('check', { size: 18 })}<span>${t('cpe.save')}</span></button></div></div>
      </form>`;

      const headHtml = () => pageHead({
        title: isNew ? t('cpe.new') : (saved.title || page.slug),
        sub: isNew ? t('cpe.sub.new') : `${t('cpe.sub.edit')}${saved.updatedAtMs ? ` ${t('cpe.updated', { when: fmtDateTime(saved.updatedAtMs) })}` : ''}`,
        actions: !isNew && saved.visible ? html`<a class="btn" href="/page/${encodeURIComponent(page.slug)}" target="_blank" rel="noopener">${icon('external-link', { size: 18 })}<span>${t('cpe.view')}</span></a>` : '',
      });
      render(ctx.el, html`<div class="cpe">${back}<div id="cpe-head">${headHtml()}</div>${body()}</div>`);
      paintTab(); counter('body', PAGE_LIMITS.BODY); counter('seoTitle', PAGE_LIMITS.SEO_TITLE); counter('seoDescription', PAGE_LIMITS.SEO_DESC); paintBar();

      const beforeUnload = (e) => { if (dirtyNow()) { e.preventDefault(); e.returnValue = ''; } };
      window.addEventListener('beforeunload', beforeUnload);
      ctx.cleanup(() => window.removeEventListener('beforeunload', beforeUnload));

      // typing: counters, the unsaved note and (while creating) a suggested address taken from the title
      ctx.cleanup(delegate(ctx.el, 'input', 'form[data-form="page"] input, form[data-form="page"] textarea', (ev, el) => {
        if (el.getAttribute('aria-invalid')) {              // a field that was marked wrong stops being marked as soon as it is edited
          el.removeAttribute('aria-invalid');
          const slot = form().querySelector(`#err-${CSS.escape(el.name)}`); if (slot) slot.textContent = '';
        }
        if (el.name === 'slug') slugTouched = true;
        if (el.name === 'title' && isNew && !slugTouched) {
          const slugEl = form().elements.slug; if (slugEl) slugEl.value = slugify(el.value, { max: PAGE_LIMITS.SLUG });
        }
        if (el.name === 'body') counter('body', PAGE_LIMITS.BODY);
        if (el.name === 'seoTitle') counter('seoTitle', PAGE_LIMITS.SEO_TITLE);
        if (el.name === 'seoDescription') counter('seoDescription', PAGE_LIMITS.SEO_DESC);
        paintBar();
      }));
      ctx.cleanup(delegate(ctx.el, 'change', 'form[data-form="page"] input[type="checkbox"]', () => paintBar()));

      const errorsOf = (e) => Object.fromEntries(Object.entries((e && e.errors) || {}).map(([k, v]) => [k, Array.isArray(v) ? pick(v[0], v[1]) : String(v)]));

      const doSave = async (btn) => {
        const f = form(); if (!f) return;
        showFormErrors(f, {});
        const draft = current();
        try { await withBusy(btn, () => savePage({ page: draft, isNew })); } catch (e) {
          if (e && e.errors) { showFormErrors(f, errorsOf(e)); return; }
          if (e && e.code === 'no_change') { toast(t('cpe.nochange')); return; }
          if (!isRefusal(e)) reportError(e, 'pages.save');
          toastError(explainError(e));
          return;
        }
        toast(isNew ? t('cpe.created') : t('cpe.saved'));
        if (isNew) {
          ctx.router.navigate(`/content/pages/${encodeURIComponent(draft.slug)}`, { replace: true });
          return;
        }
        saved = { ...saved, ...draft, updatedAtMs: Date.now() };
        page = { ...page, ...draft };
        render(ctx.el.querySelector('#cpe-head'), headHtml());
        paintBar();
      };

      // the two tabs: arrow keys, Home and End move between them (roving tabindex)
      ctx.cleanup(delegate(ctx.el, 'keydown', '[data-tab]', (ev) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
        ev.preventDefault();
        tab = ev.key === 'Home' ? 'write' : ev.key === 'End' ? 'preview' : (tab === 'write' ? 'preview' : 'write');
        paintTab(); const b = ctx.el.querySelector(`#cpe-tab-${tab}`); if (b) b.focus();
      }));
      ctx.cleanup(bindActions(ctx.el, {
        save: (el, ev) => { ev.preventDefault(); return doSave(el); },
        tab: (el) => { tab = el.dataset.tab; paintTab(); const b = ctx.el.querySelector(`#cpe-tab-${tab}`); if (b) b.focus(); },
      }, { submit: { page: (formEl) => doSave(formEl.querySelector('#cpe-save')) } }));
    });
  },
};
