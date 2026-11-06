/*
 * Tiny, safe Markdown subset → HTML for product descriptions and static pages.
 * Supported: # ## ### headings, **bold**, *italic*, `code`, [text](https://link), bullet and numbered
 * lists, > quotes, --- rules, paragraphs and line breaks. Everything else is HTML-escaped; only
 * http(s)/mailto/tel links are emitted (with rel="noopener noreferrer"), so stored content cannot inject markup.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = url.replace(/&amp;/g, '&');
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(u)) return label;
    return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return s;
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); closeList(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    closeList();
    para.push(line);
  }
  flushPara(); closeList();
  return out.join('\n');
}

/** Plain-text excerpt (for meta descriptions / cards). */
export function stripMarkdown(src, max = 160) {
  const t = String(src ?? '').replace(/[#>*`_\-]+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}
