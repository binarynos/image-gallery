#!/usr/bin/env bun
'use strict';
// ── CLI: import-tags ─────────────────────────────────────────────────────────
// Imports a `tags.txt` file from a gallery subfolder into the tag database.
//
// Usage:
//   bun scripts/import-tags.js <galleryRoot> <subfolder> [--dry-run]
//
// Example:
//   bun scripts/import-tags.js "E:\Gallery" "E:\Gallery\Anime"
//
// Expects a `tags.txt` directly inside <subfolder>, one image per line:
//   image.jpg ["anime", "one-piece"]
//   another image.png ["scenery", "sunset", "4k"]
//
// Tags are stored against the image's path relative to <galleryRoot>
// (e.g. "Anime/image.jpg"), matching how the web UI addresses images, so
// they show up immediately in search and in the lightbox tag editor.

const fs = require('fs');
const path = require('path');
const { openDb, toRelPath, setImageTags } = require('../lib/db');

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage: bun scripts/import-tags.js <galleryRoot> <subfolder> [--dry-run]');
  console.error('Example: bun scripts/import-tags.js "E:\\Gallery" "E:\\Gallery\\Anime"');
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const positional = rawArgs.filter((a) => a !== '--dry-run');

if (positional.length < 2) usage('expected <galleryRoot> and <subfolder> arguments');

const rootDir = path.resolve(positional[0]);
const subfolder = path.resolve(positional[1]);

if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
  usage(`gallery root does not exist or is not a directory: ${rootDir}`);
}
if (!fs.existsSync(subfolder) || !fs.statSync(subfolder).isDirectory()) {
  usage(`subfolder does not exist or is not a directory: ${subfolder}`);
}

// Normalize both to compare safely across OS separators / trailing slashes.
const normRoot = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
if (subfolder !== rootDir && !subfolder.startsWith(normRoot)) {
  usage(`subfolder must be inside galleryRoot\n  galleryRoot: ${rootDir}\n  subfolder:   ${subfolder}`);
}

const tagsFile = path.join(subfolder, 'tags.txt');
if (!fs.existsSync(tagsFile)) {
  usage(`no tags.txt found in ${subfolder}`);
}

const relDir = path.relative(rootDir, subfolder).split(path.sep).join('/');

// Matches: <filename>  <json array>
// Non-greedy filename capture, since the split point is "whitespace right
// before the opening bracket" — works even for filenames containing spaces.
const LINE_RE = /^(.+?)\s*(\[[\s\S]*\])\s*$/;

const lines = fs.readFileSync(tagsFile, 'utf8').split(/\r?\n/);

let imported = 0;
let skipped = 0;
let missingOnDisk = 0;

const db = dryRun ? null : openDb(rootDir);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const match = LINE_RE.exec(line);
  if (!match) {
    console.warn(`  [line ${i + 1}] could not parse, skipping: ${line}`);
    skipped++;
    continue;
  }

  const [, filename, tagsJson] = match;
  let tags;
  try {
    tags = JSON.parse(tagsJson);
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      throw new Error('expected a JSON array of strings');
    }
  } catch (err) {
    console.warn(`  [line ${i + 1}] invalid tag list for "${filename}", skipping (${err.message})`);
    skipped++;
    continue;
  }

  const imageAbs = path.join(subfolder, filename);
  if (!fs.existsSync(imageAbs)) {
    console.warn(`  [line ${i + 1}] image not found on disk, importing tags anyway: ${imageAbs}`);
    missingOnDisk++;
  }

  const relPath = toRelPath(relDir, filename);

  if (dryRun) {
    console.log(`  [dry-run] ${relPath}  ->  [${tags.join(', ')}]`);
  } else {
    setImageTags(db, relPath, tags);
  }
  imported++;
}

console.log('');
console.log(`Done. ${imported} image(s) imported${dryRun ? ' (dry run — nothing written)' : ''}, ${skipped} line(s) skipped, ${missingOnDisk} file(s) not found on disk.`);
if (!dryRun) {
  console.log(`Database: ${path.join(rootDir, 'gallery.db')}`);
}
