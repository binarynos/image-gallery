#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ROOT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.env.HOME || '.', 'Pictures');

const PAGE_SIZE = 60; // items per page

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.avif', '.bmp', '.svg', '.tiff', '.tif',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
};

const isBun = typeof Bun !== "undefined";

// ── Helpers ───────────────────────────────────────────────────────────────────
function isImage(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function safePath(requestedPath) {
  // Decode and normalise, then ensure it stays inside ROOT_DIR
  const decoded = decodeURIComponent(requestedPath || '');
  const abs = path.resolve(ROOT_DIR, decoded.replace(/^\/+/, ''));
  if (!abs.startsWith(ROOT_DIR)) return null;
  return abs;
}

function etag(stat) {
  return `"${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}"`;
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, { error: message }, status);
}

// ── Route: GET /api/list?path=...&page=N ──────────────────────────────────────
function handleList(req, res, url) {
  const relPath = url.searchParams.get('path') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

  const abs = safePath(relPath);
  if (!abs) return sendError(res, 403, 'Forbidden');

  let stat;
  try { stat = fs.statSync(abs); } catch { return sendError(res, 404, 'Not found'); }
  if (!stat.isDirectory()) return sendError(res, 400, 'Not a directory');

  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch { return sendError(res, 403, 'Cannot read directory'); }

  const dirs = [];
  const images = [];
  const others = [];

  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip hidden
    if (e.isDirectory()) {
      dirs.push({ name: e.name, type: 'dir' });
    } else if (e.isFile()) {
      if (isImage(e.name)) {
        images.push({ name: e.name, type: 'image' });
      } else {
        others.push({ name: e.name, type: 'file', ext: path.extname(e.name).slice(1).toLowerCase() });
      }
    }
  }

  // Sort each bucket alphabetically
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  dirs.sort(cmp); images.sort(cmp); others.sort(cmp);

  // All items in order: dirs → images → others
  const all = [...dirs, ...images, ...others];
  const totalItems = all.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = all.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Breadcrumb — relative to ROOT_DIR
  const rel = path.relative(ROOT_DIR, abs);
  const parts = rel ? rel.split(path.sep) : [];
  const breadcrumb = [{ name: 'Home', path: '' }];
  for (let i = 0; i < parts.length; i++) {
    breadcrumb.push({ name: parts[i], path: parts.slice(0, i + 1).join('/') });
  }

  // Count of images in this folder (for lightbox ordering)
  const imageNames = images.map(i => i.name);

  sendJSON(res, {
    path: rel || '',
    breadcrumb,
    items: slice,
    imageNames,       // full sorted image list for lightbox navigation
    page: safePage,
    totalPages,
    totalItems,
    pageSize: PAGE_SIZE,
  });
}

// ── Route: GET /api/thumb?path=...&file=... ───────────────────────────────────
// Streams the raw image; browser does the scaling via CSS / <img> width attr.
// For large images we could resize server-side, but that requires a native dep.
// Instead we stream with a reasonable cache header so repeated loads are free.
async function handleFile(req, res, url) {
  const relPath = url.searchParams.get('path') || '';
  const file = url.searchParams.get('file') || '';
  const openExplorer = url.searchParams.has('open-explorer');
  const size = parseInt(url.searchParams.get('size'))
  console.log('size', size)
  if (!file) return sendError(res, 400, 'Missing file param');

  const dirAbs = safePath(relPath);
  if (!dirAbs) return sendError(res, 403, 'Forbidden');

  const fileAbs = path.join(dirAbs, file);
  // Extra safety: make sure we didn't escape via file param
  if (!fileAbs.startsWith(ROOT_DIR)) return sendError(res, 403, 'Forbidden');

  if (openExplorer) try {
    Bun.spawn(["explorer.exe", "/select,", fileAbs], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    return sendJSON(res, { done: true });
  } catch (e) {
    console.log(e);
    return sendJSON(res, { done: false });
  };

  let stat;
  try { stat = fs.statSync(fileAbs); } catch { return sendError(res, 404, 'Not found'); }
  if (!stat.isFile()) return sendError(res, 400, 'Not a file');

  const tag = etag(stat);
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304); res.end(); return;
  }

  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  const headers = new Headers({
    'Content-Type': mime,
    'ETag': tag,
    'Cache-Control': 'public, max-age=86400',
  })

  res.setHeaders(headers)

  if (typeof size === 'number' && !Number.isNaN(size) && isBun) {
    try {
      const image = await new Bun.Image(Bun.file(fileAbs)).resize(size).bytes()
      res.writeHead(200, { 'Content-Length': image.length })
      res.end(image)
    }
    catch (err) {
      res.writeHead(200, { 'Content-Length': stat.size })
      fs.createReadStream(fileAbs).pipe(res);
    }
  } else {
    res.writeHead(200, { 'Content-Length': stat.size })
    fs.createReadStream(fileAbs).pipe(res);
  }
}

// ── Static file server (serves /public/*) ────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');

function handleStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }

  let stat;
  try { stat = fs.statSync(abs); } catch {
    res.writeHead(404); res.end('Not found'); return;
  }

  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext] || 'text/plain';
  const tag = etag(stat);

  if (req.headers['if-none-match'] === tag) { res.writeHead(304); res.end(); return; }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'ETag': tag,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(abs).pipe(res);
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS for dev convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/api/list') handleList(req, res, url);
  else if (pathname === '/api/file') handleFile(req, res, url);
  else handleStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`\n📂  Gallery server running`);
  console.log(`    Root directory : ${ROOT_DIR}`);
  console.log(`    Open browser   : http://localhost:${PORT}\n`);
});
