/*
 * Minimal RFC 4180 CSV parser / writer.
 *  - parseCsv handles quoted fields, embedded commas/newlines/escaped quotes, CRLF, and a UTF-8 BOM.
 *  - toCsv guards against spreadsheet formula injection (cells starting with = + - @ are prefixed with ').
 */

export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

/** → array of objects keyed by the (trimmed, lower-cased) header row. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return {
    headers,
    rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))),
  };
}

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v));
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => cell(Array.isArray(r) ? r[headers.indexOf(h)] : r[h])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
