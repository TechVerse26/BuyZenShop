/*
 * Small, dependency-free charts for the admin panel (HTML + CSS, no canvas, no library).
 *
 *   barChart({ title, data: [{ label, value, note? }], format, tickFormat, summary })   → SafeHtml
 *   bindChart(root)                                                                       → disposer (hover / tap tooltip)
 *   rankList({ items: [{ label, value, sub? }], format })                                → SafeHtml (ranked horizontal bars)
 *
 * Design rules (dataviz): one colour for one series; thin marks anchored on a baseline; hairline grid; only a few
 * axis labels; the exact numbers are always available as a table (<details>), so a chart never hides data.
 */
import { html, delegate } from '../../core/dom.js';
import { registerBoth, t } from '../../core/i18n.js';
import { compact } from '../../core/format.js';

registerBoth({
  'chart.table': ['Show as table', 'টেবিল আকারে দেখুন'],
  'chart.empty': ['No data for this period yet.', 'এই সময়ের কোনো তথ্য এখনো নেই।'],
  'chart.col.label': ['Period', 'সময়'],
  'chart.col.value': ['Value', 'পরিমাণ'],
});

/** Round a maximum up to 1 / 2 / 2.5 / 5 / 10 × 10ⁿ so the axis ticks are friendly numbers. */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * p;
}

export function barChart({ title = '', data = [], format = (v) => String(v), tickFormat = compact, summary = '' }) {
  const values = data.map((d) => Math.max(0, Number(d.value) || 0));
  const total = values.reduce((s, v) => s + v, 0);
  if (!data.length || total === 0) return html`<p class="muted chart-empty">${t('chart.empty')}</p>`;
  const max = niceMax(Math.max(...values));
  const every = Math.max(1, Math.ceil(data.length / 6));                 // at most ~6 axis labels
  const label = `${title}${summary ? ': ' + summary : ''}`;
  return html`<figure class="chart" data-chart>
    <div class="chart-body" style="--n:${data.length}">
      <div class="chart-y" aria-hidden="true"><span>${tickFormat(max)}</span><span>${tickFormat(max / 2)}</span><span>${tickFormat(0)}</span></div>
      <div class="chart-plot" role="img" aria-label="${label}">
        <div class="chart-grid" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="chart-bars">${data.map((d, i) => html`<div class="chart-col" data-l="${d.label}" data-v="${format(values[i])}" data-n="${d.note || ''}"><span class="chart-bar" style="height:${Math.round((values[i] / max) * 1000) / 10}%"></span></div>`)}</div>
        <div class="chart-tip" aria-hidden="true" hidden></div>
      </div>
      <div class="chart-x" aria-hidden="true">${data.map((d, i) => html`<span>${i % every === 0 ? d.label : ''}</span>`)}</div>
    </div>
    <details class="chart-table">
      <summary>${t('chart.table')}</summary>
      <div class="table-wrap"><table class="table table-compact">
        <thead><tr><th scope="col">${t('chart.col.label')}</th><th scope="col" class="num">${t('chart.col.value')}</th></tr></thead>
        <tbody>${data.map((d, i) => html`<tr><th scope="row">${d.label}</th><td class="num">${format(values[i])}${d.note ? html` <span class="muted small">· ${d.note}</span>` : ''}</td></tr>`)}</tbody>
      </table></div>
    </details>
  </figure>`;
}

/** Hover / tap tooltip for every chart under `root`. Returns a disposer. */
export function bindChart(root) {
  const show = (ev, col) => {
    const plot = col.closest('.chart-plot');
    const tip = plot && plot.querySelector('.chart-tip');
    if (!tip) return;
    plot.querySelectorAll('.chart-col.is-active').forEach((c) => c.classList.remove('is-active'));
    col.classList.add('is-active');
    tip.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = col.dataset.l || '';
    tip.append(strong, ` ${col.dataset.v || ''}`);
    if (col.dataset.n) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = ` · ${col.dataset.n}`; tip.append(s); }
    tip.hidden = false;
    const w = tip.offsetWidth;
    const center = col.offsetLeft + col.offsetWidth / 2;
    const left = Math.min(Math.max(center, w / 2), plot.clientWidth - w / 2);
    tip.style.left = `${Math.round(left)}px`;
  };
  const hide = (ev, plot) => {
    if (ev.target !== plot) return;
    const tip = plot.querySelector('.chart-tip');
    if (tip) tip.hidden = true;
    plot.querySelectorAll('.chart-col.is-active').forEach((c) => c.classList.remove('is-active'));
  };
  const offs = [
    delegate(root, 'pointerover', '.chart-col', show),
    delegate(root, 'pointerdown', '.chart-col', show),
    delegate(root, 'pointerleave', '.chart-plot', hide, true),
  ];
  return () => offs.forEach((off) => off());
}

/** Ranked list with thin proportional bars (top products, payment methods, districts …). */
export function rankList({ items = [], format = (v) => String(v) }) {
  const max = Math.max(1, ...items.map((i) => Number(i.value) || 0));
  return html`<ol class="rank">${items.map((i) => html`<li>
    <div class="rank-top"><span class="rank-label">${i.label}</span><span class="rank-val">${format(i.value)}</span></div>
    <span class="rank-bar" aria-hidden="true"><span style="width:${Math.max(2, Math.round(((Number(i.value) || 0) / max) * 100))}%"></span></span>
    ${i.sub ? html`<span class="rank-sub">${i.sub}</span>` : ''}
  </li>`)}</ol>`;
}
