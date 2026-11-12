/* Runs every *.test.mjs file below the given directories with the built-in node:test runner.
 * (Passing directories to `node --test` is not portable across Node versions, so we list the files.) */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const files = [];
function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.mjs')) files.push(resolve(p));
  }
}
for (const d of dirs) walk(d);
if (!files.length) { console.error('No test files found in', dirs.join(', ')); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...flags, ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
