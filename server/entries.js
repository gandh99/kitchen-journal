// Shared helpers for turning entry rows into API objects and copying entries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, UPLOAD_DIR } from './db.js';

export const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

export const photoUrl = (filename) => `/uploads/${filename}`;

export function removePhotoFile(filename) {
  fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(filename))).catch(() => {});
}

/** Copy an uploaded photo to a new random filename; returns the new name or null. */
export function duplicatePhotoFile(filename, prefix = '') {
  const copy = prefix + crypto.randomBytes(16).toString('hex') + path.extname(filename);
  try {
    fs.copyFileSync(path.join(UPLOAD_DIR, path.basename(filename)), path.join(UPLOAD_DIR, copy));
    return copy;
  } catch { return null; }
}

export function photosFor(entryIds) {
  const map = new Map(entryIds.map((id) => [id, []]));
  if (!entryIds.length) return map;
  const rows = db.prepare(`SELECT id, entry_id, filename FROM photos
    WHERE entry_id IN (${entryIds.map(() => '?').join(',')}) ORDER BY id`).all(...entryIds);
  for (const r of rows) map.get(r.entry_id)?.push({ id: r.id, url: photoUrl(r.filename) });
  return map;
}

export function toEntry(row, photos = []) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    recipeUrl: row.recipe_url || '',
    imageUrl: row.image_url || '',
    ingredients: JSON.parse(row.ingredients),
    instructions: row.instructions,
    notes: row.notes,
    tags: JSON.parse(row.tags),
    madeOn: row.made_on || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    photos,
  };
}

export function withPhotos(rows) {
  const map = photosFor(rows.map((r) => r.id));
  return rows.map((r) => toEntry(r, map.get(r.id)));
}

export const coverOf = (e) => e.photos?.[0]?.url || e.imageUrl || '';

/**
 * Create a new entry for `userId` from a source entry-like object
 * ({name, category, recipeUrl, imageUrl, ingredients[], instructions, tags[]}).
 * `photoFiles` are upload filenames to duplicate into the copy.
 */
export function createEntryCopy(userId, src, { notes = '', photoFiles = [] } = {}) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO entries
    (user_id, name, category, recipe_url, image_url, ingredients, instructions, notes, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId, src.name, src.category || 'Mains', src.recipeUrl || null, src.imageUrl || null,
    JSON.stringify(src.ingredients || []), src.instructions || '', notes, JSON.stringify(src.tags || []));
  const insert = db.prepare('INSERT INTO photos (entry_id, filename) VALUES (?, ?)');
  for (const f of photoFiles) {
    const copy = duplicatePhotoFile(f);
    if (copy) insert.run(lastInsertRowid, copy);
  }
  return Number(lastInsertRowid);
}
