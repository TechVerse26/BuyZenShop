#!/usr/bin/env node
/*
 * Project lint (no dependencies, no browser):
 *   node tools/check-syntax.mjs            # whole project
 *   node tools/check-syntax.mjs js/store   # only files under a folder
 *
 * 1. Syntax: `node --check` on every .js / .mjs file.
 * 2. Safety rules for browser code under js/ (errors):
 *      - innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / new Function outside js/core/dom.js
 *        (render() with html`` is the only allowed writer; add `// lint-allow` on a line to whitelist a reviewed exception)
 *      - inline event-handler attributes (onclick="…") and javascript: URLs
 *      - aria-pressed / -expanded / -selected / -checked fed a bare boolean (html`` prints true/false as nothing; use aria(value))
 *      - Firebase SDK imported anywhere except js/core/firebase.js (the single importer the test mock relies on)
 *      - direct localStorage / sessionStorage use outside js/core/storage.js and js/theme-init.js
 * 3. Hints (warnings, do not fail): console.log, TODO / FIXME, "lorem ipsum".
 * 4. Manifests: every page referenced by js/store/routes.js and js/admin/routes.js exists and has `export default { mount }`;
 *    every admin NAV path matches a route; local files referenced by index.html / admin/index.html exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : null;
const errors = [];
const warns = [];
const rel = (f) => path.relative(ROOT, f);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.artifacts'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const all = [...walk(path.join(ROOT, 'js')), ...walk(path.join(ROOT, 'tools')), ...walk(path.join(ROOT, 'tests')), ...(fs.existsSync(path.join(ROOT, 'sw.js')) ? [path.join(ROOT, 'sw.js')] : [])]
  .filter((f) => !only || f.startsWith(only) || f === only);

/* 1 ── syntax */
for (const f of all) {
  // sw.js is a classic script, everything else is an ES module (package.json "type": "module")
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) errors.push(`${rel(f)}: syntax error\n${(r.stderr || '').split('\n').slice(0, 4).join('\n')}`);
}

/* 2 + 3 ── source rules */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const RULES = [
  { re: /\.(innerHTML|outerHTML)\s*(\+?=)(?!=)/, msg: 'assigns innerHTML/outerHTML (use render(el, html`…`))', allow: ['js/core/dom.js'] },
  { re: /\.insertAdjacentHTML\s*\(/, msg: 'uses insertAdjacentHTML', allow: ['js/core/dom.js'] },
  { re: /document\.write\s*\(/, msg: 'uses document.write' },
  { re: /(^|[^.\w$])eval\s*\(/, msg: 'uses eval()' },
  { re: /new\s+Function\s*\(/, msg: 'uses new Function()' },
  { re: /\son[a-z]{3,}\s*=\s*["'`]/, msg: 'inline event-handler attribute (use data-action + bindActions)' },
  { re: /javascript:/i, msg: 'javascript: URL', allow: ['js/core/dom.js'] },
  { re: /aria-(pressed|expanded|selected|checked)="\$\{(?![^}]*\?)(?![^}]*aria\()[^}]*\}"/, msg: 'boolean ARIA attribute built from a bare value: html`` renders true/false as empty text (use aria(value))' },
  { re: /(from\s*|import\s*\(\s*)['"`]https:\/\/www\.gstatic\.com\/firebasejs/, msg: 'imports the Firebase SDK directly (import from js/core/firebase.js)', allow: ['js/core/firebase.js'] },
  { re: /(^|[^.\w$])(localStorage|sessionStorage)\s*[.[]/, msg: 'touches localStorage/sessionStorage directly (use core/storage.js)', allow: ['js/core/storage.js', 'js/theme-init.js'] },
];
const HINTS = [
  { re: /console\.log\s*\(/, msg: 'console.log' },
  { re: /\b(TODO|FIXME|XXX)\b/, msg: 'TODO/FIXME marker' },
  { re: /lorem ipsum/i, msg: '"lorem ipsum" placeholder text' },
];
for (const f of all) {
  const r = rel(f).replace(/\\/g, '/');
  if (!r.startsWith('js/')) continue;
  const lines = strip(fs.readFileSync(f, 'utf8')).split('\n');
  const original = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/lint-allow/.test(original[i])) return;
    for (const rule of RULES) if (rule.re.test(line) && !(rule.allow || []).includes(r)) errors.push(`${r}:${i + 1}: ${rule.msg}`);
    for (const h of HINTS) if (h.re.test(original[i]) && !/lint-allow/.test(original[i])) warns.push(`${r}:${i + 1}: ${h.msg}`);
  });
}

/* 4 ── manifests */
function routeFiles(routesFile) {
  const p = path.join(ROOT, routesFile);
  if (!fs.existsSync(p)) return [];
  const src = fs.readFileSync(p, 'utf8');
  const dir = path.dirname(p);
  const files = new Set([...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => path.resolve(dir, m[1])));
  const paths = [...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  return { files: [...files], paths };
}
for (const rf of ['js/store/routes.js', 'js/admin/routes.js']) {
  const info = routeFiles(rf);
  if (!info.files) continue;
  for (const file of info.files) {
    if (only && !file.startsWith(only) && !rf.startsWith(rel(only))) continue;
    if (!fs.existsSync(file)) { errors.push(`${rf}: page file missing: ${rel(file)}`); continue; }
    const s = strip(fs.readFileSync(file, 'utf8'));
    if (!/export\s+default\b/.test(s) || !/\bmount\s*\(/.test(s)) errors.push(`${rel(file)}: must \`export default { mount(ctx) { … } }\``);
  }
  if (rf === 'js/admin/routes.js') {
    const navSrc = fs.readFileSync(path.join(ROOT, 'js/admin/nav.js'), 'utf8');
    const compile = (pat) => new RegExp('^' + pat.split('/').filter(Boolean).map((s) => (s.startsWith(':') ? '[^/]+' : s.startsWith('*') ? '.*' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '/?$');
    const res = info.paths.map((p) => compile(p === '/' ? '' : p));
    for (const m of navSrc.matchAll(/path:\s*'([^']+)'/g)) {
      if (!res.some((re) => re.test(m[1].replace(/^\//, '')))) errors.push(`js/admin/nav.js: nav path ${m[1]} has no matching route`);
    }
  }
}
for (const html of ['index.html', 'admin/index.html']) {
  const p = path.join(ROOT, html);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  for (const m of src.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)) {
    const target = path.join(ROOT, m[1]);
    if (!fs.existsSync(target)) errors.push(`${html}: references ${m[1]} which does not exist`);
  }
}

/* report */
if (warns.length) {
  console.warn(`⚠ ${warns.length} hint(s):`);
  for (const w of warns.slice(0, 40)) console.warn('  - ' + w);
  if (warns.length > 40) console.warn(`  … and ${warns.length - 40} more`);
}
if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`✓ ${all.length} files: syntax OK, safety rules OK, route/nav manifests OK.`);
