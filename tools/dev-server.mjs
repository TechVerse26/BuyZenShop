#!/usr/bin/env node
/*
 * Zero-dependency static server that behaves like vercel.json:
 *   /admin, /admin/  → admin/index.html (hash routing inside)
 *   a real file      → that file
 *   any other extensionless path → index.html (history routing of the storefront)
 *
 * Usage:  node tools/dev-server.mjs [port=5173]
 * Also exported: startServer({ port, root, quiet }) → Promise<{ server, port, url, close }>   (used by tests/e2e/run.mjs)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff2': 'font/woff2', '.rules': 'text/plain; charset=utf-8',
};

export function startServer({ port = 0, root = ROOT, quiet = true } = {}) {
  const server = http.createServer((req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (rel.includes('\0')) { res.writeHead(400).end(); return; }
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
      const send = (f) => {
        res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        fs.createReadStream(f).pipe(res);
      };
      const isFile = fs.existsSync(file) && fs.statSync(file).isFile();
      if (rel === '/admin' || rel === '/admin/') return send(path.join(root, 'admin/index.html'));
      if (isFile) return send(file);
      if (!path.extname(rel)) return send(path.join(root, 'index.html'));
      res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('not found');
    } catch (e) { res.writeHead(500).end(String(e)); }
    return undefined;
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    if (!quiet) console.log(`Shop Verse dev server → http://localhost:${p}   (admin: /admin/)`);
    resolve({ server, port: p, url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.argv[2]) || 5173, quiet: false });
}
