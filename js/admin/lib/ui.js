/*
 * Helpers shared by every admin page.
 *
 *   await safeMount(ctx, async () => { …load data, render into ctx.el… })   // spinner + error/retry state
 *   pageHead({ title, sub, actions })
 *   await runAction(button, async () => { … }, { ok: 'Saved' })              // busy + toast + friendly error
 *   kpiCard({ label, value, sub })
 *   exportCsv('orders.csv', headers, rows)
 *   needs(ctx, 'orders.update')  → true when allowed (UI gating; the rules enforce for real)
 */
import { html, render, raw, esc, bindActions, withBusy, downloadFile } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { toast, toastError, spinnerBlock, errorState, emptyState } from '../../core/ui.js';
import { explainError, reportError } from '../../core/errors.js';
import { toCsv } from '../../shared/csv.js';
import { can } from '../../data/auth.js';

/** Render a spinner, run `fn`, and show a retryable error state if it throws. */
export async function safeMount(ctx, fn) {
  let disposeRetry = null;
  const run = async () => {
    if (disposeRetry) { disposeRetry(); disposeRetry = null; }
    render(ctx.el, spinnerBlock());
    try { await fn(); } catch (e) {
      if (ctx.signal.aborted) return;
      reportError(e, ctx.path);
      render(ctx.el, errorState({ text: explainError(e) }));
      disposeRetry = bindActions(ctx.el, { retry: run });
    }
  };
  ctx.cleanup(() => { if (disposeRetry) disposeRetry(); });
  await run();
}

export function pageHead({ title, sub = '', actions = null }) {
  return html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="page-sub">${sub}</p>` : ''}</div>${actions ? html`<div class="page-actions">${actions}</div>` : ''}</div>`;
}

/**
 * Run an async action behind a button: busy state, success toast, friendly error toast.
 * Resolves { ok: true, value } or { ok: false, error }.
 */
export async function runAction(btn, fn, { ok = t('common.saved'), quiet = false } = {}) {
  try {
    const value = await withBusy(btn, fn);
    if (!quiet && ok) toast(ok);
    return { ok: true, value };
  } catch (e) {
    reportError(e, 'admin.action');
    toastError(e && e.userMessage ? e.userMessage : (e && e.name === 'AppError' ? e.message : explainError(e)));
    return { ok: false, error: e };
  }
}

export const kpiCard = ({ label, value, sub = '', tone = '' }) => html`<div class="stat"><div class="stat-label">${label}</div><div class="stat-value ${tone ? 'text-' + tone : ''}">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ''}</div>`;

export function exportCsv(filename, headers, rows) {
  downloadFile(filename, toCsv(headers, rows), 'text/csv;charset=utf-8');
}

/** UI gating: renders a "no access" panel and returns false when the permission is missing. */
export function needs(ctx, perm) {
  const list = Array.isArray(perm) ? perm : [perm];
  if (list.some(can)) return true;
  render(ctx.el, emptyState({ icon: 'lock', title: t('admin.noAccessTitle'), text: t('admin.noAccessText') }));
  return false;
}

/** Search box. `bind` names a data-input handler for bindActions(root, {}, { input: { <bind>: fn } }). */
export const searchField = ({ id = 'q', value = '', placeholder = t('common.search'), label = t('common.search'), bind = '' } = {}) =>
  html`<div class="search-field grow-search">${icon('search')}<input class="input" type="search" id="${id}" name="${id}" value="${value}" placeholder="${placeholder}" aria-label="${label}" autocomplete="off" ${bind ? raw(`data-input="${esc(bind)}"`) : ''}></div>`;

/** Small "key: value" definition list. rows: [[label, value], …] (values may be SafeHtml). */
export const kvList = (rows) => html`<dl class="kv">${rows.filter(Boolean).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;

export { raw };
