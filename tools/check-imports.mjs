#!/usr/bin/env node
/*
 * Static import-graph check for the browser modules (no browser, no bundler needed).
 *   node tools/check-imports.mjs            # whole project
 *   node tools/check-imports.mjs js/store   # only files under a folder
 *
 * For every relative `import … from './x.js'` and `import('./x.js')` it verifies that
 *   1. the target file exists, and
 *   2. every imported NAME is exported by the target (regex-based export scan),
 * and flags default imports from modules without a default export. https:// imports are skipped.
 * Also verifies that the Firebase SDK version in js/core/firebase.js matches js/config/firebase-config.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : null;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'tests', 'docs'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

const exportCache = new Map();
function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const src = strip(fs.readFileSync(file, 'utf8'));
  const names = new Set();
  let hasDefault = false;
  let m;
  const decl = /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = decl.exec(src))) names.add(m[1]);
  const list = /export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g;
  while ((m = list.exec(src))) {
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default\b/.test(src)) hasDefault = true;
  const star = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  const stars = [];
  while ((m = star.exec(src))) stars.push(m[1]);
  const res = { names, hasDefault, stars: stars.map((s) => path.resolve(path.dirname(file), s)) };
  exportCache.set(file, res);
  return res;
}
function hasName(file, name, seen = new Set()) {
  if (seen.has(file)) return false; seen.add(file);
  const e = exportsOf(file);
  if (e.names.has(name)) return true;
  return e.stars.some((s) => fs.existsSync(s) && hasName(s, name, seen));
}

const problems = [];
const files = walk(ROOT).filter((f) => !only || f.startsWith(only));
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const src = strip(fs.readFileSync(file, 'utf8'));
  // static imports
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+[\w$]+|\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const [, def, named, spec] = m;
    if (/^https?:/.test(spec)) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const target = spec.startsWith('/') ? path.join(ROOT, spec) : path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) { problems.push(`${rel}: cannot resolve '${spec}'`); continue; }
    if (!target.endsWith('.js')) continue;
    if (def && !exportsOf(target).hasDefault) problems.push(`${rel}: '${spec}' has no default export (imported as ${def})`);
    if (named) {
      for (const part of named.split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim();
        if (n && !hasName(target, n)) problems.push(`${rel}: '${n}' is not exported by '${spec}'`);
      }
    }
  }
  // side-effect imports: import './x.js'
  const side = /import\s*['"](\.[^'"]+)['"]/g;
  while ((m = side.exec(src))) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) problems.push(`${rel}: cannot resolve '${m[1]}'`);
  }
  // dynamic imports with literal paths
  const dyn = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(src))) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) problems.push(`${rel}: dynamic import '${m[1]}' does not exist`);
  }
}

// Firebase SDK version agreement
try {
  const fb = fs.readFileSync(path.join(ROOT, 'js/core/firebase.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(ROOT, 'js/config/firebase-config.js'), 'utf8');
  const v = /SDK_VERSION\s*=\s*'([\d.]+)'/.exec(cfg)?.[1];
  const used = new Set([...fb.matchAll(/firebasejs\/([\d.]+)\//g)].map((x) => x[1]));
  if (!v || used.size !== 1 || !used.has(v)) problems.push(`js/core/firebase.js imports SDK ${[...used].join(',')} but firebase-config.js says ${v}`);
} catch { /* optional */ }

if (problems.length) {
  console.error(`✗ ${problems.length} import problem(s):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`✓ ${files.length} files: all relative imports resolve and every imported name is exported.`);
