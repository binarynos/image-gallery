#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tagDb = require('./lib/db');

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

// The tag database lives in the gallery root (gallery.db, plus its WAL /
// shared-memory sidecar files) — hide it from folder listings so it
// doesn't clutter the gallery itself.
function isTagDbFile(name) {
  return name === tagDb.DB_FILENAME
    || name === `${tagDb.DB_FILENAME}-wal`
    || name === `${tagDb.DB_FILENAME}-shm`
    || name === `${tagDb.DB_FILENAME}-journal`;
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

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      data += chunk;
      if (data.length > maxBytes) {
        tooBig = true;
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => { if (!tooBig) resolve(data); });
    req.on('error', reject);
  });
}

let _db = null;
function getDb() {
  if (!_db) _db = tagDb.openDb(ROOT_DIR);
  return _db;
}

// ── Filesystem image index (for filename search) ───────────────────────────────
// The tag database only has a row for an image once it's been tagged, so
// filename search needs its own view of every image actually on disk.
// Walking all 10k-ish images on every keystroke would be wasteful, so this
// is built once and cached for a short TTL — long enough to make repeated
// searches cheap, short enough that newly dropped-in files show up without
// a restart.
const FS_INDEX_TTL_MS = 60_000;
let fsIndexCache = { builtAt: 0, paths: [] };

function walkImages(dirAbs, relDir, out) {
  let entries;
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      walkImages(path.join(dirAbs, e.name), relDir ? `${relDir}/${e.name}` : e.name, out);
    } else if (e.isFile() && isImage(e.name)) {
      out.push(relDir ? `${relDir}/${e.name}` : e.name);
    }
  }
}

function getFsImageIndex() {
  const now = Date.now();
  if (now - fsIndexCache.builtAt > FS_INDEX_TTL_MS) {
    const paths = [];
    walkImages(ROOT_DIR, '', paths);
    fsIndexCache = { builtAt: now, paths };
  }
  return fsIndexCache.paths;
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
    if (isTagDbFile(e.name)) continue; // skip the tag database itself
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

// ── Route: GET /api/tags?limit=N ──────────────────────────────────────────────
// Most common tags, for the "browse tags" modal.
function handleTags(req, res, url) {
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '40', 10)));
  try {
    const tags = tagDb.getTopTags(getDb(), limit);
    sendJSON(res, { tags });
  } catch (err) {
    sendError(res, 500, `Tag database error: ${err.message}`);
  }
}

// ── Route: GET /api/search?q=... ──────────────────────────────────────────────
// Searches filenames and tags across the whole gallery. Supports `tag:name`
// tokens for exact tag filtering (space-separated tokens are ANDed).
function handleSearch(req, res, url) {
  const q = url.searchParams.get('q') || '';
  if (!q.trim()) return sendJSON(res, { query: q, items: [], imageCount: 0 });

  try {
    const fsPaths = getFsImageIndex();
    const paths = tagDb.searchImages(getDb(), q, fsPaths, 300);
    const items = paths.map((p) => tagDb.splitRelPath(p));
    sendJSON(res, { query: q, items, imageCount: items.length });
  } catch (err) {
    sendError(res, 500, `Search error: ${err.message}`);
  }
}

// ── Route: GET /api/image-tags?path=...&file=... ──────────────────────────────
function handleGetImageTags(req, res, url) {
  const relPath = url.searchParams.get('path') || '';
  const file = url.searchParams.get('file') || '';
  if (!file) return sendError(res, 400, 'Missing file param');

  try {
    const rel = tagDb.toRelPath(relPath, file);
    const tags = tagDb.getImageTags(getDb(), rel);
    sendJSON(res, { path: relPath, file, tags });
  } catch (err) {
    sendError(res, 500, `Tag database error: ${err.message}`);
  }
}

// ── Route: POST /api/image-tags ───────────────────────────────────────────────
// Body: { path, file, tags: string[] }. Replaces the full tag set for one
// image (the lightbox tag editor sends the whole list on every change).
async function handleSetImageTags(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch {
    return sendError(res, 400, 'Invalid JSON body');
  }

  const relPath = typeof body.path === 'string' ? body.path : '';
  const file = typeof body.file === 'string' ? body.file : '';
  const tags = body.tags;

  if (!file) return sendError(res, 400, 'Missing file');
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
    return sendError(res, 400, 'tags must be an array of strings');
  }

  // Reuse the same path-containment check as file serving, so tags can only
  // be attached to files actually inside ROOT_DIR.
  const dirAbs = safePath(relPath);
  if (!dirAbs) return sendError(res, 403, 'Forbidden');
  const fileAbs = path.join(dirAbs, file);
  if (!fileAbs.startsWith(ROOT_DIR)) return sendError(res, 403, 'Forbidden');

  try {
    const rel = tagDb.toRelPath(relPath, file);
    const updated = tagDb.setImageTags(getDb(), rel, tags);
    sendJSON(res, { path: relPath, file, tags: updated });
  } catch (err) {
    sendError(res, 500, `Tag database error: ${err.message}`);
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'GET') {
    if (pathname === '/api/list') return handleList(req, res, url);
    if (pathname === '/api/file') return handleFile(req, res, url);
    if (pathname === '/api/tags') return handleTags(req, res, url);
    if (pathname === '/api/search') return handleSearch(req, res, url);
    if (pathname === '/api/image-tags') return handleGetImageTags(req, res, url);
    return handleStatic(req, res, pathname);
  }

  if (req.method === 'POST' && pathname === '/api/image-tags') {
    return handleSetImageTags(req, res);
  }

  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  console.log(`\n📂  Gallery server running`);
  console.log(`    Root directory : ${ROOT_DIR}`);
  console.log(`    Open browser   : http://localhost:${PORT}\n`);
});
