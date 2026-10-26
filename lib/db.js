'use strict';
// ── Tag database ──────────────────────────────────────────────────────────────
// Backed by Bun's built-in sqlite (bun:sqlite). Lazily required so that the
// rest of server.js can still run under a non-Bun runtime if ever needed —
// only the tag-related routes touch this module.
//
// Schema is optimized for the shape of this workload: up to ~10k images,
// each with a handful of unique tags, and two access patterns that need to
// stay fast — "find every image with a given tag" and "find the tags for a
// given image". Both directions are covered by indexes on the join table,
// and tag names are deduplicated case-insensitively (COLLATE NOCASE) so
// "Anime" and "anime" are the same tag.

const path = require('path');

const DB_FILENAME = 'gallery.db';

/**
 * Normalize a (dir, file) pair from the gallery API into the single
 * forward-slash-separated relative path used as the primary key in the
 * `images` table. `dir` is relative to the gallery root, using whatever
 * separator the OS gave us; `file` is the bare filename within that dir.
 */
function toRelPath(dir, file) {
  const joined = dir ? `${dir}/${file}` : file;
  return joined.split(path.sep).join('/').replace(/^\/+/, '');
}

/** Split a stored relative path back into { dir, name }. */
function splitRelPath(relPath) {
  const idx = relPath.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: relPath };
  return { dir: relPath.slice(0, idx), name: relPath.slice(idx + 1) };
}

function escapeLike(str) {
  return str.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const dbCache = new Map(); // rootDir -> Database

/**
 * Open (creating if necessary) the tag database for a given gallery root.
 * The database file lives at <rootDir>/gallery.db, as requested, so it
 * travels with the gallery rather than with the server install.
 */
function openDb(rootDir) {
  const cached = dbCache.get(rootDir);
  if (cached) return cached;

  // Lazy require: only Bun ships `bun:sqlite`.
  const { Database } = require('bun:sqlite');

  const dbPath = path.join(rootDir, DB_FILENAME);
  const db = new Database(dbPath, { create: true });

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE IF NOT EXISTS image_tags (
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
      PRIMARY KEY (image_id, tag_id)
    );

    -- Fast "all images for this tag" (tag cloud, tag: search token).
    CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id);
    -- Fast "all tags for this image" (lightbox tag editor).
    CREATE INDEX IF NOT EXISTS idx_image_tags_image ON image_tags(image_id);
    -- Fast tag name lookup / LIKE search.
    CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
    -- Fast filename / path LIKE search.
    CREATE INDEX IF NOT EXISTS idx_images_path ON images(path);
  `);

  dbCache.set(rootDir, db);
  return db;
}

function getOrCreateImageId(db, relPath) {
  const row = db.query('SELECT id FROM images WHERE path = ?').get(relPath);
  if (row) return row.id;
  const info = db.query('INSERT INTO images (path) VALUES (?)').run(relPath);
  return info.lastInsertRowid;
}

function getOrCreateTagId(db, name) {
  const row = db.query('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name);
  if (row) return row.id;
  const info = db.query('INSERT INTO tags (name) VALUES (?)').run(name);
  return info.lastInsertRowid;
}

/** Get the current tags for one image, alphabetically. */
function getImageTags(db, relPath) {
  return db
    .query(
      `SELECT t.name AS name
       FROM tags t
       JOIN image_tags it ON it.tag_id = t.id
       JOIN images i ON i.id = it.image_id
       WHERE i.path = ?
       ORDER BY t.name COLLATE NOCASE`
    )
    .all(relPath)
    .map((r) => r.name);
}

/**
 * Replace the full tag set for one image. Creates the image row and any
 * missing tag rows as needed. Also sweeps tags that end up with zero
 * images attached, so renaming/removing tags doesn't leave clutter behind
 * (cheap at this scale — a few thousand tags at most).
 */
function setImageTags(db, relPath, tagNames) {
  const clean = [...new Set(tagNames.map((t) => String(t).trim()).filter(Boolean))];

  const run = db.transaction((names) => {
    const imageId = getOrCreateImageId(db, relPath);
    db.query('DELETE FROM image_tags WHERE image_id = ?').run(imageId);
    for (const name of names) {
      const tagId = getOrCreateTagId(db, name);
      db.query('INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)').run(imageId, tagId);
    }
    db.query('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM image_tags)').run();
  });
  run(clean);

  return getImageTags(db, relPath);
}

/** Most-used tags, most common first. */
function getTopTags(db, limit = 40) {
  return db
    .query(
      `SELECT t.name AS name, COUNT(*) AS count
       FROM image_tags it
       JOIN tags t ON t.id = it.tag_id
       GROUP BY it.tag_id
       ORDER BY count DESC, t.name COLLATE NOCASE ASC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * Search images by filename/path and/or tag.
 *
 * Query syntax: space-separated tokens, ANDed together. A token of the
 * form `tag:<name>` requires an exact (case-insensitive) tag match; any
 * other token matches if it's a substring of the image's relative path OR
 * of one of its tag names. Returns relative paths, sorted.
 *
 * Filename matching is NOT limited to the `images` table — that table only
 * ever gains a row once an image has been tagged at least once, so a
 * filename-only search needs to see every image on disk too. The caller
 * passes `fsPaths`, the full list of relative image paths currently on
 * disk (see server.js's filesystem index), which this function treats as
 * the universe for the filename side of the match; the tag side is always
 * resolved against the database.
 */
function searchImages(db, queryStr, fsPaths, limit = 300) {
  const tokens = queryStr.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];

  let candidates = null; // Set<string> of relative paths

  for (const token of tokens) {
    const tagMatch = /^tag:(.+)$/i.exec(token);
    let matchSet;

    if (tagMatch) {
      const tagName = tagMatch[1].trim();
      const rows = db
        .query(
          `SELECT i.path AS path
           FROM image_tags it
           JOIN tags t ON t.id = it.tag_id
           JOIN images i ON i.id = it.image_id
           WHERE t.name = ? COLLATE NOCASE`
        )
        .all(tagName);
      matchSet = new Set(rows.map((r) => r.path));
    } else {
      const needle = token.toLowerCase();
      const byFilename = fsPaths.filter((p) => p.toLowerCase().includes(needle));

      const like = `%${escapeLike(token)}%`;
      const byTag = db
        .query(
          `SELECT DISTINCT i.path AS path
           FROM image_tags it
           JOIN tags t ON t.id = it.tag_id
           JOIN images i ON i.id = it.image_id
           WHERE t.name LIKE ? ESCAPE '\\'`
        )
        .all(like)
        .map((r) => r.path);

      matchSet = new Set([...byFilename, ...byTag]);
    }

    candidates = candidates === null ? matchSet : new Set([...candidates].filter((p) => matchSet.has(p)));
    if (candidates.size === 0) break;
  }

  if (!candidates || candidates.size === 0) return [];

  const result = [...candidates].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return result.slice(0, limit);
}

module.exports = {
  DB_FILENAME,
  openDb,
  toRelPath,
  splitRelPath,
  getImageTags,
  setImageTags,
  getTopTags,
  searchImages,
};
