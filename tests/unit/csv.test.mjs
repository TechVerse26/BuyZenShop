/* CSV in (inventory import, customers) and out (every export): quoting, line endings, the BOM Excel wants, and spreadsheet formula injection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvObjects, toCsv } from '../../js/shared/csv.js';

const BOM = '﻿';

test('plain rows, CRLF, LF and a lone CR all separate records; blank lines are skipped', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n\n\n1,2\n\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv('\n\n'), []);
  assert.deepEqual(parseCsv('single'), [['single']]);
});

test('empty cells stay empty cells', () => {
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv(',,'), [['', '', '']]);
  assert.deepEqual(parseCsv('a,b,'), [['a', 'b', '']]);
});

test('quoted cells may hold commas, line breaks and doubled quotes', () => {
  assert.deepEqual(parseCsv('a,"b, c",d'), [['a', 'b, c', 'd']]);
  assert.deepEqual(parseCsv('"x\ny",z'), [['x\ny', 'z']]);
  assert.deepEqual(parseCsv('a,"b ""q"" c"'), [['a', 'b "q" c']]);
  assert.deepEqual(parseCsv('"a\r\nb",c\r\n"d",e'), [['a\r\nb', 'c'], ['d', 'e']]);
  assert.deepEqual(parseCsv('"",x'), [['', 'x']]);
});

test('a leading byte-order mark (Excel "UTF-8 CSV") does not end up in the first header', () => {
  assert.deepEqual(parseCsv(`${BOM}sku,stock\nA,1`), [['sku', 'stock'], ['A', '1']]);
  const { headers } = parseCsvObjects(`${BOM}SKU, Stock \nA,1`);
  assert.deepEqual(headers, ['sku', 'stock']);
});

test('objects are keyed by the trimmed, lower-cased header; short rows get empty strings; values are trimmed', () => {
  const r = parseCsvObjects('SKU, Stock ,Note\n A1 , 5 \nB2,7');
  assert.deepEqual(r.headers, ['sku', 'stock', 'note']);
  assert.deepEqual(r.rows, [{ sku: 'A1', stock: '5', note: '' }, { sku: 'B2', stock: '7', note: '' }]);
  assert.deepEqual(parseCsvObjects(''), { headers: [], rows: [] });
  assert.deepEqual(parseCsvObjects('only,headers').rows, []);
});

test('writing: BOM first, CRLF between lines, a final CRLF, quotes only where needed', () => {
  const out = toCsv(['name', 'note'], [{ name: 'Shirt', note: 'blue, large' }, { name: 'He said "hi"', note: 'two\nlines' }]);
  assert.equal(out, `${BOM}name,note\r\nShirt,"blue, large"\r\n"He said ""hi""",\"two\nlines\"\r\n`);
});

test('writing accepts objects or arrays, numbers, null/undefined, booleans and dates', () => {
  const d = new Date(Date.UTC(2026, 5, 1, 6, 0, 0));
  const out = toCsv(['a', 'b', 'c', 'd', 'e'], [[1, null, undefined, true, d], { a: 2, b: 'x', c: 0, d: false }]);
  assert.equal(out, `${BOM}a,b,c,d,e\r\n1,,,true,2026-06-01T06:00:00.000Z\r\n2,x,0,false,\r\n`);
});

test('formula injection: a text cell that starts like a formula is written as plain text', () => {
  for (const evil of ['=SUM(A1:A9)', '+1+1', '-2+3', '@cmd', '\tTAB', '\rCR', '=HYPERLINK("http://x","y")']) {
    const line = toCsv(['v'], [{ v: evil }]).split('\r\n')[1];
    assert.ok(line.startsWith("'") || line.startsWith('"\''), `${JSON.stringify(evil)} → ${line}`);
  }
  assert.equal(toCsv(['v'], [{ v: -5 }]).split('\r\n')[1], '-5', 'a real negative number stays a number');
  assert.equal(toCsv(['v'], [{ v: 'safe=ok' }]).split('\r\n')[1], 'safe=ok', 'only the first character matters');
});

test('what we write, we can read back', () => {
  const rows = [
    { sku: 'A-1', name: 'Plain', note: '' },
    { sku: 'B-2', name: 'Comma, and "quotes"', note: 'line one\nline two' },
    { sku: 'C-3', name: 'বাংলা নাম', note: '১২৩' },
  ];
  const back = parseCsvObjects(toCsv(['sku', 'name', 'note'], rows));
  assert.deepEqual(back.headers, ['sku', 'name', 'note']);
  assert.deepEqual(back.rows, rows.map((r) => ({ ...r, note: r.note.trim() })));
});
