/*
 * Content → Pages. Permission: content.write (Super Admin, Store Admin, Product Manager).
 * The static pages of the shop (About, Delivery & returns, Privacy …) live at /page/<address>. This list shows every page — also the hidden ones —
 * with two quick switches (shown to visitors · listed in the footer), a link to the editor and delete. Each switch is saved at once and written to the audit log.
 * Rules of the game: shared/contentFlow.js.
 */
import { html, render, raw, delegate } from '../../core/dom.js';
import { registerBoth, t, tn } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { emptyState, errorState, spinnerBlock, badge, toast, toastError, confirmDialog, loadCss } from '../../core/ui.js';
import { explainError, isRefusal, reportError } from '../../core/errors.js';
import { num, relTime, fmtDateTime } from '../../core/format.js';
import { safeMount, pageHead, needs, runAction } from '../lib/ui.js';
import { loadPages, setPageFlag, deletePage } from '../data/content.js';

registerBoth({
  'cpg.title': ['Pages', 'পেজ'],
  'cpg.sub': ['The fixed pages of your shop — About, Delivery & returns, Privacy and so on. Visitors open them at /page/…', 'আপনার শপের স্থায়ী পেজ — আমাদের সম্পর্কে, ডেলিভারি ও রিটার্ন, প্রাইভেসি ইত্যাদি। ভিজিটররা /page/… ঠিকানায় খোলেন।'],
  'cpg.new': ['New page', 'নতুন পেজ'],
  'cpg.empty': ['No pages yet', 'এখনও কোনো পেজ নেই'],
  'cpg.emptyText': ['Create the first page, for example "About us" or "Delivery & returns".', 'প্রথম পেজটি বানান, যেমন "আমাদের সম্পর্কে" বা "ডেলিভারি ও রিটার্ন"।'],
  'cpg.col.page': ['Page', 'পেজ'],
  'cpg.col.visible': ['Shown to visitors', 'ভিজিটরদের দেখানো'],
  'cpg.col.footer': ['In the footer', 'ফুটারে'],
  'cpg.col.order': ['Order', 'ক্রম'],
  'cpg.col.updated': ['Updated', 'হালনাগাদ'],
  'cpg.visibleLabel': ['Show "{title}" to visitors', '"{title}" ভিজিটরদের দেখান'],
  'cpg.footerLabel': ['List "{title}" in the footer', '"{title}" ফুটারে তালিকাভুক্ত করুন'],
  'cpg.hidden': ['Hidden', 'লুকানো'],
  'cpg.edit': ['Edit', 'সম্পাদনা'],
  'cpg.editLabel': ['Edit {title}', '{title} সম্পাদনা'],
  'cpg.view': ['Open the page in the shop', 'শপে পেজটি খুলুন'],
  'cpg.viewLabel': ['Open {title} in the shop', 'শপে {title} খুলুন'],
  'cpg.delete': ['Delete', 'মুছুন'],
  'cpg.deleteLabel': ['Delete {title}', '{title} মুছুন'],
  'cpg.delete.title': ['Delete this page?', 'এই পেজ মুছবেন?'],
  'cpg.delete.text': ['"{title}" is removed for good. Its address stops working. This cannot be undone.', '"{title}" চিরতরে মুছে যাবে। এর ঠিকানা আর কাজ করবে না। এটি ফেরানো যায় না।'],
  'cpg.deleted': ['Page deleted', 'পেজ মুছে ফেলা হয়েছে'],
  'cpg.on.visible': ['"{title}" is now shown to visitors', '"{title}" এখন ভিজিটরদের দেখানো হচ্ছে'],
  'cpg.off.visible': ['"{title}" is now hidden', '"{title}" এখন লুকানো'],
  'cpg.on.footer': ['"{title}" is now listed in the footer', '"{title}" এখন ফুটারে আছে'],
  'cpg.off.footer': ['"{title}" is no longer listed in the footer', '"{title}" আর ফুটারে নেই'],
  'cpg.hint': ['Only pages that are shown to visitors can be listed in the footer. A hidden page looks like a missing page to visitors.', 'শুধু যেসব পেজ ভিজিটরদের দেখানো হয় সেগুলোই ফুটারে থাকতে পারে। লুকানো পেজ ভিজিটরের কাছে অনুপস্থিত পেজের মতো দেখায়।'],
  'cpg.footer_one': ['{n} page', '{n}টি পেজ'],
  'cpg.footer_other': ['{n} pages', '{n}টি পেজ'],
  'cpg.capped': ['Only the first {n} pages are listed.', 'শুধু প্রথম {n}টি পেজ দেখানো হচ্ছে।'],
  'cpg.never': ['Never', 'কখনো নয়'],
});

const LIST_CAP = 200;

export default {
  async mount(ctx) {
    if (!needs(ctx, 'content.write')) return;
    await loadCss('/css/pages/admin-content.css');
    await safeMount(ctx, async () => {
      const href = (p) => ctx.router.href(p);
      let pages = [];
      let error = '';

      const dash = html`<span class="muted">—</span>`;
      const storeHref = (slug) => `/page/${encodeURIComponent(slug)}`;

      const rowHtml = (p) => html`<tr data-slug="${p.slug}">
        <td class="cell-first"><div class="cell-main"><div>
          <a class="t cpg-title" href="${href('/content/pages/' + encodeURIComponent(p.slug))}" aria-label="${t('cpg.editLabel', { title: p.title })}">${p.title}</a>${p.visible ? '' : html` ${badge(t('cpg.hidden'), 'neutral')}`}
          <div class="s cpg-slug">/page/${p.slug}</div>
        </div></div></td>
        <td data-label="${t('cpg.col.visible')}"><label class="switch"><input type="checkbox" role="switch" data-flag="visible" data-slug="${p.slug}" ${p.visible ? raw('checked') : ''} aria-label="${t('cpg.visibleLabel', { title: p.title })}"><span class="track"></span></label></td>
        <td data-label="${t('cpg.col.footer')}"><label class="switch"><input type="checkbox" role="switch" data-flag="footer" data-slug="${p.slug}" ${p.footer ? raw('checked') : ''} aria-label="${t('cpg.footerLabel', { title: p.title })}"><span class="track"></span></label></td>
        <td data-label="${t('cpg.col.order')}" class="num">${num(p.sort)}</td>
        <td data-label="${t('cpg.col.updated')}">${p.updatedAtMs ? html`<span title="${fmtDateTime(p.updatedAtMs)}">${relTime(p.updatedAtMs)}</span>` : dash}</td>
        <td class="cpg-actions"><div class="row">
          <a class="btn btn-sm" href="${href('/content/pages/' + encodeURIComponent(p.slug))}" aria-label="${t('cpg.editLabel', { title: p.title })}">${icon('edit', { size: 16 })}<span>${t('cpg.edit')}</span></a>
          ${p.visible ? html`<a class="btn btn-ghost btn-sm btn-icon" href="${storeHref(p.slug)}" target="_blank" rel="noopener" aria-label="${t('cpg.viewLabel', { title: p.title })}" title="${t('cpg.view')}">${icon('external-link', { size: 16 })}</a>` : ''}
          <button type="button" class="btn btn-ghost btn-sm btn-icon" data-action="del" data-slug="${p.slug}" aria-label="${t('cpg.deleteLabel', { title: p.title })}" title="${t('cpg.delete')}">${icon('trash', { size: 16 })}</button>
        </div></td>
      </tr>`;

      const listHtml = () => {
        if (error) return errorState({ text: error });
        if (!pages.length) return emptyState({ icon: 'file-text', title: t('cpg.empty'), text: t('cpg.emptyText') });
        return html`${pages.length >= LIST_CAP ? html`<div class="alert alert-info mb-4" role="note">${icon('info', { size: 18 })}<div>${t('cpg.capped', { n: num(LIST_CAP) })}</div></div>` : ''}
          <div class="table-wrap"><table class="table table-stack table-cards cpg-table" id="cpg-table">
            <thead><tr><th scope="col">${t('cpg.col.page')}</th><th scope="col">${t('cpg.col.visible')}</th><th scope="col">${t('cpg.col.footer')}</th><th scope="col">${t('cpg.col.order')}</th><th scope="col">${t('cpg.col.updated')}</th><th scope="col"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
            <tbody>${pages.map(rowHtml)}</tbody></table>
            <div class="table-footer"><span>${tn('cpg.footer', pages.length, { n: num(pages.length) })}</span></div></div>
          <p class="muted small cpg-hint">${t('cpg.hint')}</p>`;
      };

      const paint = () => render(ctx.el.querySelector('#cpg-body'), listHtml());
      const refresh = async () => {
        try { pages = await loadPages(); error = ''; } catch (e) { reportError(e, 'pages.list'); error = explainError(e); }
        if (!ctx.signal.aborted) paint();
      };
      const rowOf = (slug) => [...ctx.el.querySelectorAll('tr[data-slug]')].find((tr) => tr.dataset.slug === slug) || null;
      const paintRow = (slug, focusFlag) => {
        const p = pages.find((x) => x.slug === slug); const old = rowOf(slug);
        if (!p || !old) return;
        const tmp = document.createElement('tbody');
        render(tmp, rowHtml(p));
        const fresh = tmp.firstElementChild;
        old.replaceWith(fresh);
        if (focusFlag) { const el = fresh.querySelector(`input[data-flag="${focusFlag}"]`); if (el) el.focus(); }
      };

      render(ctx.el, html`<div class="cpg">
        ${pageHead({ title: t('cpg.title'), sub: t('cpg.sub'), actions: html`<a class="btn btn-primary" href="${href('/content/pages/new')}" id="cpg-new">${icon('plus', { size: 18 })}<span>${t('cpg.new')}</span></a>` })}
        <div id="cpg-body" aria-live="polite">${spinnerBlock()}</div></div>`);
      await refresh();

      // the two switches save at once; a refusal puts the switch back where it was
      ctx.cleanup(delegate(ctx.el, 'change', 'input[data-flag]', async (ev, el) => {
        const slug = el.dataset.slug; const field = el.dataset.flag; const value = el.checked;
        const p = pages.find((x) => x.slug === slug);
        if (!p) return;
        el.disabled = true;
        try {
          await setPageFlag({ slug, field, value });
          p[field] = value;
          toast(t(`cpg.${value ? 'on' : 'off'}.${field}`, { title: p.title }));
          paintRow(slug, field);
        } catch (e) {
          if (e && e.code === 'no_change') { p[field] = value; paintRow(slug, field); return; }
          if (!isRefusal(e)) reportError(e, 'pages.flag');
          toastError(explainError(e));
          if (e && e.code === 'not_found') { await refresh(); return; }
          el.checked = !value; el.disabled = false; el.focus();
        }
      }));

      ctx.cleanup(delegate(ctx.el, 'click', '[data-action="del"]', async (ev, el) => {
        ev.preventDefault();
        const slug = el.dataset.slug; const p = pages.find((x) => x.slug === slug);
        if (!p) return;
        const yes = await confirmDialog({ title: t('cpg.delete.title'), message: t('cpg.delete.text', { title: p.title }), confirmText: t('cpg.delete'), danger: true });
        if (!yes) return;
        const r = await runAction(el, () => deletePage(slug), { ok: t('cpg.deleted') });
        if (r.ok || (r.error && r.error.code === 'not_found')) {
          pages = pages.filter((x) => x.slug !== slug);
          paint();
          const nb = ctx.el.querySelector('#cpg-new'); if (nb) nb.focus();
        }
      }));
    });
  },
};
