// Shared helpers for turning entry rows into API objects and copying entries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, UPLOAD_DIR } from './db.js';
import { CATEGORIES, suggestTags, guessCategory, titleCase } from './tagger.js';

export const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

const isHttpUrl = (s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };

/** Validate and normalise an entry from the editor or an import. Throws a 400 on bad input. */
export function cleanEntry(body = {}) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  if (!name) throw fail(400, 'Please give the dish a name.');

  let ingredients = body.ingredients ?? [];
  if (typeof ingredients === 'string') ingredients = ingredients.split('\n');
  if (!Array.isArray(ingredients)) ingredients = [];
  ingredients = ingredients.map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, 200);

  const recipeUrl = String(body.recipeUrl ?? '').trim();
  if (recipeUrl && (!isHttpUrl(recipeUrl) || recipeUrl.length > 2000)) throw fail(400, 'Recipe link must be a valid http(s) URL.');
  const imageUrl = String(body.imageUrl ?? '').trim();

  let tags = Array.isArray(body.tags) ? body.tags : [];
  const seen = new Set();
  tags = tags.map((t) => titleCase(String(t).trim()).slice(0, 40))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 30);
  if (!tags.length) tags = suggestTags({ name, ingredients });

  const category = CATEGORIES.includes(body.category) ? body.category : guessCategory(name, ingredients);
  const madeOn = /^\d{4}-\d{2}-\d{2}$/.test(body.madeOn ?? '') ? body.madeOn : null;

  return {
    name, category, ingredients, tags, madeOn,
    favorite: !!body.favorite,
    status: body.status === 'wishlist' ? 'wishlist' : 'made',
    recipeUrl: recipeUrl || null,
    imageUrl: imageUrl && isHttpUrl(imageUrl) && imageUrl.length <= 2000 ? imageUrl : null,
    instructions: String(body.instructions ?? '').slice(0, 20000),
    notes: String(body.notes ?? '').slice(0, 20000),
  };
}

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
    favorite: !!row.favorite,
    status: row.status === 'wishlist' ? 'wishlist' : 'made',
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

/** Insert a cleaned entry object; returns the new id. Optional createdAt/updatedAt keep import history. */
export function insertEntry(userId, e) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO entries
    (user_id, name, category, recipe_url, image_url, ingredients, instructions, notes, tags, made_on, favorite, status,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`).run(
    userId, e.name, e.category || 'Mains', e.recipeUrl || null, e.imageUrl || null,
    JSON.stringify(e.ingredients || []), e.instructions || '', e.notes || '', JSON.stringify(e.tags || []),
    e.madeOn || null, e.favorite ? 1 : 0, e.status === 'wishlist' ? 'wishlist' : 'made',
    e.createdAt || null, e.updatedAt || null);
  return Number(lastInsertRowid);
}

export const coverOf =(e) => e.photos?.[0]?.url || e.imageUrl || '';

/**
 * Create a new entry for `userId` from a source entry-like object
 * ({name, category, recipeUrl, imageUrl, ingredients[], instructions, tags[]}).
 * `photoFiles` are upload filenames to duplicate into the copy.
 */
export function createEntryCopy(userId, src, { notes = '', photoFiles = [] } = {}) {
  const lastInsertRowid = insertEntry(userId, {
    ...src, notes, favorite: false, status: 'made', madeOn: null,
    // A saved copy is new to this kitchen: don't inherit the source entry's timestamps.
    createdAt: null, updatedAt: null,
  });
  const insert = db.prepare('INSERT INTO photos (entry_id, filename) VALUES (?, ?)');
  for (const f of photoFiles) {
    const copy = duplicatePhotoFile(f);
    if (copy) insert.run(lastInsertRowid, copy);
  }
  return Number(lastInsertRowid);
}
