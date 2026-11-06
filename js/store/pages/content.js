/*
 * CMS pages — /page/:slug (about, delivery & returns, privacy …), edited in Admin → Content → Pages.
 * The body is Markdown rendered by shared/markdown.js, which escapes everything and only emits a small set of safe tags,
 * so stored content cannot inject markup. A page that does not exist or is not published looks the same: the 404 page.
 */
import { html, render, raw, setMeta } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { loadCss, skeletonRows } from '../../core/ui.js';
import { fmtDate } from '../../core/format.js';
import { loadPage } from '../../data/settings.js';
import { renderMarkdown, stripMarkdown } from '../../shared/markdown.js';
import { normalizePage, PAGE_SLUG_RE } from '../../shared/contentModel.js';
import { pageUrl, absoluteUrl } from '../lib/links.js';

registerBoth({
  'cms.updated': ['Last updated {date}', 'সর্বশেষ হালনাগাদ {date}'],
});

export default {
  async mount(ctx) {
    loadCss('/css/pages/content.css');
    const slug = String(ctx.params.slug || '');
    render(ctx.el, html`<div class="container page cms">${skeletonRows(5)}</div>`);
    const doc = PAGE_SLUG_RE.test(slug) ? await loadPage(slug) : null;
    if (ctx.signal.aborted) return undefined;
    const page = doc ? normalizePage(slug, doc) : null;
    if (!page || !page.visible) {
      const nf = await import('./not-found.js');
      return nf.default.mount(ctx);
    }
    setMeta({
      title: page.seoTitle || page.title,
      description: page.seoDescription || stripMarkdown(page.body, 160),
      canonical: absoluteUrl(pageUrl(slug)),
    });
    render(ctx.el, html`<article class="container page cms">
      <h1 class="page-title">${page.title}</h1>
      <div class="prose cms-body">${raw(renderMarkdown(page.body))}</div>
      ${page.updatedAtMs ? html`<p class="muted small cms-updated">${t('cms.updated', { date: fmtDate(page.updatedAtMs) })}</p>` : ''}
    </article>`);
    return undefined;
  },
};
