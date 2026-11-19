import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, UPLOAD_DIR } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, loadUser, requireAuth,
  loginBlocked, recordLoginFailure, clearLoginFailures,
} from './auth.js';
import { CATEGORIES, suggestTags, guessCategory, titleCase } from './tagger.js';
import { importRecipe, importFromHtml, importFromText } from './recipeImport.js';
import { normalizeItems, rankMyEntries, searchOnline } from './suggest.js';
import {
  fail, photoUrl, photosFor, toEntry, withPhotos, removePhotoFile, createEntryCopy,
} from './entries.js';
import { registerSpotlightRoutes, entrySpotlightInfo } from './spotlight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
// Clipped pages carry the whole HTML document, so that one route gets a bigger limit.
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '8mb' });
app.use((req, res, next) => (req.path === '/api/import/html' ? jsonLarge : jsonSmall)(req, res, next));
app.use(loadUser);
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// Small helper so async handlers can just throw.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================ helpers
function getOwnedEntry(userId, id) {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw fail(404, 'Entry not found.');
  return row;
}

const isHttpUrl = (s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };

function cleanEntry(body = {}) {
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
    recipeUrl: recipeUrl || null,
    imageUrl: imageUrl && isHttpUrl(imageUrl) && imageUrl.length <= 2000 ? imageUrl : null,
    instructions: String(body.instructions ?? '').slice(0, 20000),
    notes: String(body.notes ?? '').slice(0, 10000),
  };
}

// ============================================================ uploads
const ALLOWED_IMAGE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + ALLOWED_IMAGE[file.mimetype]),
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => (ALLOWED_IMAGE[file.mimetype]
    ? cb(null, true)
    : cb(fail(400, `"${file.originalname}" isn't a supported image (use JPG, PNG, WebP, GIF or AVIF).`))),
});

// ============================================================ auth routes
app.get('/api/meta', (_req, res) => res.json({ categories: CATEGORIES }));

app.post('/api/auth/register', h(async (req, res) => {
  const username = String(req.body.username ?? '').trim();
  const password = String(req.body.password ?? '');
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) throw fail(400, 'Username must be 3–30 characters: letters, numbers, . _ or -');
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw fail(409, 'That username is taken.');
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hashPassword(password));
  createSession(res, Number(lastInsertRowid), req);
  res.status(201).json({ user: { id: Number(lastInsertRowid), username } });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const username = String(req.body.username ?? '').trim();
  const password = String(req.body.password ?? '');
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (loginBlocked(key)) throw fail(429, 'Too many failed attempts. Try again in 15 minutes.');
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(key);
    throw fail(401, 'Wrong username or password.');
  }
  clearLoginFailures(key);
  createSession(res, user.id, req);
  res.json({ user: { id: user.id, username: user.username } });
}));

app.post('/api/auth/logout', (req, res) => { destroySession(req, res); res.status(204).end(); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null }));

// ============================================================ entries (CRUD)
app.get('/api/entries', requireAuth, (req, res) => {
  const terms = String(req.query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const where = ['user_id = ?'];
  const params = [req.user.id];
  for (const t of terms) {
    where.push(`lower(name || ' ' || tags || ' ' || ingredients || ' ' || notes || ' ' || category) LIKE ? ESCAPE '\\'`);
    params.push(`%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  }
  if (CATEGORIES.includes(req.query.category)) { where.push('category = ?'); params.push(req.query.category); }
  const rows = db.prepare(`SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC`).all(...params);
  res.json({ entries: withPhotos(rows) });
});

app.get('/api/entries/:id', requireAuth, (req, res) => {
  const row = getOwnedEntry(req.user.id, req.params.id);
  res.json({ entry: { ...withPhotos([row])[0], spotlight: entrySpotlightInfo(row.id) } });
});

app.post('/api/entries', requireAuth, (req, res) => {
  const e = cleanEntry(req.body);
  const { lastInsertRowid } = db.prepare(`INSERT INTO entries
    (user_id, name, category, recipe_url, image_url, ingredients, instructions, notes, tags, made_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, e.name, e.category, e.recipeUrl, e.imageUrl, JSON.stringify(e.ingredients),
    e.instructions, e.notes, JSON.stringify(e.tags), e.madeOn);
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ entry: toEntry(row, []) });
});

app.put('/api/entries/:id', requireAuth, (req, res) => {
  const existing = getOwnedEntry(req.user.id, req.params.id);
  const e = cleanEntry(req.body);
  db.prepare(`UPDATE entries SET name = ?, category = ?, recipe_url = ?, image_url = ?, ingredients = ?,
    instructions = ?, notes = ?, tags = ?, made_on = ?, updated_at = datetime('now') WHERE id = ?`).run(
    e.name, e.category, e.recipeUrl, e.imageUrl, JSON.stringify(e.ingredients),
    e.instructions, e.notes, JSON.stringify(e.tags), e.madeOn, existing.id);
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(existing.id);
  res.json({ entry: withPhotos([row])[0] });
});

app.delete('/api/entries/:id', requireAuth, (req, res) => {
  const existing = getOwnedEntry(req.user.id, req.params.id);
  const files = db.prepare('SELECT filename FROM photos WHERE entry_id = ?').all(existing.id);
  db.prepare('DELETE FROM entries WHERE id = ?').run(existing.id);
  files.forEach((f) => removePhotoFile(f.filename));
  res.status(204).end();
});

// ---- photos
app.post('/api/entries/:id/photos', requireAuth, (req, res, next) => {
  let entry;
  try { entry = getOwnedEntry(req.user.id, req.params.id); } catch (e) { return next(e); }
  upload.array('photos', 12)(req, res, (err) => {
    if (err) {
      (req.files || []).forEach((f) => removePhotoFile(f.filename));
      if (err instanceof multer.MulterError) err.status = 400;
      return next(err);
    }
    const insert = db.prepare('INSERT INTO photos (entry_id, filename) VALUES (?, ?)');
    for (const f of req.files || []) insert.run(entry.id, f.filename);
    db.prepare("UPDATE entries SET updated_at = datetime('now') WHERE id = ?").run(entry.id);
    res.status(201).json({ photos: photosFor([entry.id]).get(entry.id) });
  });
});

app.delete('/api/entries/:id/photos/:photoId', requireAuth, (req, res) => {
  const entry = getOwnedEntry(req.user.id, req.params.id);
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND entry_id = ?').get(Number(req.params.photoId), entry.id);
  if (!photo) throw fail(404, 'Photo not found.');
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  removePhotoFile(photo.filename);
  res.status(204).end();
});

// ============================================================ smart helpers
app.post('/api/tags/suggest', requireAuth, (req, res) => {
  const ingredients = Array.isArray(req.body.ingredients) ? req.body.ingredients.map(String).slice(0, 200) : [];
  const name = String(req.body.name ?? '').slice(0, 200);
  res.json({ tags: suggestTags({ name, ingredients }), category: guessCategory(name, ingredients) });
});

app.post('/api/import', requireAuth, h(async (req, res) => {
  const url = String(req.body.url ?? '').trim();
  if (!url) throw fail(400, 'Paste a recipe link first.');
  res.json({ recipe: withTags(await importRecipe(url)) });
}));

// The "Clip" bookmarklet: HTML of a page the user already opened in their own browser.
app.post('/api/import/html', requireAuth, (req, res) => {
  const html = String(req.body.html ?? '');
  if (html.length < 50) throw fail(400, 'No page content was received.');
  res.json({ recipe: withTags(importFromHtml(html, String(req.body.url ?? ''))) });
});

// Recipe text pasted by the user.
app.post('/api/import/text', requireAuth, (req, res) => {
  const text = String(req.body.text ?? '');
  if (text.trim().length < 10) throw fail(400, 'Paste the recipe text first.');
  res.json({ recipe: withTags(importFromText(text, String(req.body.url ?? ''))) });
});

function withTags(recipe) {
  recipe.tags = suggestTags({ name: recipe.name, ingredients: recipe.ingredients, hints: recipe.hints });
  delete recipe.hints;
  return recipe;
}

app.post('/api/suggest', requireAuth, h(async (req, res) => {
  const items = normalizeItems(req.body.items);
  if (!items.length) throw fail(400, 'List at least one ingredient you have.');
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ?').all(req.user.id);
  const mine = rankMyEntries(withPhotos(rows), items);
  let online = [];
  let onlineError = null;
  try { online = await searchOnline(items); } catch (e) { onlineError = e.message; }
  const webSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(`recipe with ${items.join(', ')}`)}`;
  res.json({ items, mine, online, onlineError, webSearchUrl });
}));

// ============================================================ sharing / social
function shareInfo(userId) {
  const u = db.prepare('SELECT share_enabled, share_token FROM users WHERE id = ?').get(userId);
  return { enabled: !!u.share_enabled, token: u.share_enabled ? u.share_token : null };
}

app.get('/api/share', requireAuth, (req, res) => res.json(shareInfo(req.user.id)));

app.post('/api/share', requireAuth, (req, res) => {
  const enabled = !!req.body.enabled;
  const u = db.prepare('SELECT share_token FROM users WHERE id = ?').get(req.user.id);
  const token = (req.body.regenerate || !u.share_token) ? crypto.randomBytes(12).toString('base64url') : u.share_token;
  db.prepare('UPDATE users SET share_enabled = ?, share_token = ? WHERE id = ?').run(enabled ? 1 : 0, token, req.user.id);
  res.json(shareInfo(req.user.id));
});

function sharedOwner(token) {
  const owner = db.prepare('SELECT id, username FROM users WHERE share_token = ? AND share_enabled = 1').get(String(token));
  if (!owner) throw fail(404, "This collection isn't shared (or the link has changed).");
  return owner;
}

// Public: anyone with the link can view, no account needed.
app.get('/api/shared/:token', (req, res) => {
  const owner = sharedOwner(req.params.token);
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY updated_at DESC, id DESC').all(owner.id);
  res.json({ owner: { username: owner.username }, entries: withPhotos(rows), isOwner: req.user?.id === owner.id });
});

app.get('/api/shared/:token/entries/:id', (req, res) => {
  const owner = sharedOwner(req.params.token);
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(Number(req.params.id), owner.id);
  if (!row) throw fail(404, 'Entry not found.');
  res.json({ owner: { username: owner.username }, entry: withPhotos([row])[0], isOwner: req.user?.id === owner.id });
});

// Copy someone's shared entry (including photos) into your own collection.
app.post('/api/shared/:token/entries/:id/save', requireAuth, (req, res) => {
  const owner = sharedOwner(req.params.token);
  const src = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(Number(req.params.id), owner.id);
  if (!src) throw fail(404, 'Entry not found.');
  const note = `Saved from ${owner.username}'s kitchen.` + (src.notes ? `\n\n${src.notes}` : '');
  const files = db.prepare('SELECT filename FROM photos WHERE entry_id = ? ORDER BY id').all(src.id).map((p) => p.filename);
  const id = createEntryCopy(req.user.id, toEntry(src), { notes: note, photoFiles: files });
  res.status(201).json({ id });
});

registerSpotlightRoutes(app);

// Logged-in users can browse everyone who has turned sharing on.
app.get('/api/community', requireAuth, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.share_token AS token, COUNT(e.id) AS count, MAX(e.updated_at) AS lastUpdated
    FROM users u LEFT JOIN entries e ON e.user_id = u.id
    WHERE u.share_enabled = 1
    GROUP BY u.id ORDER BY lastUpdated DESC NULLS LAST`).all();
  const coverStmt = db.prepare(`
    SELECT e.image_url, (SELECT filename FROM photos p WHERE p.entry_id = e.id ORDER BY p.id LIMIT 1) AS photo, e.tags
    FROM entries e WHERE e.user_id = ? ORDER BY e.updated_at DESC LIMIT 4`);
  res.json({
    collections: users.map((u) => {
      const recent = coverStmt.all(u.id);
      const covers = recent.map((r) => (r.photo ? photoUrl(r.photo) : r.image_url)).filter(Boolean).slice(0, 3);
      const tagCount = {};
      recent.forEach((r) => JSON.parse(r.tags).forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
      const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
      return { username: u.username, token: u.token, count: u.count, covers, topTags, isMe: u.id === req.user.id };
    }),
  });
});

// ============================================================ static + errors
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, _req, res, _next) => {
  // Errors we raised on purpose carry a status and a user-facing message; anything else is a bug.
  const status = err.status || err.statusCode || 500;
  if (!err.status) console.error(err);
  res.status(status).json({ error: err.status ? err.message : 'Something went wrong on the server.', code: err.code });
});

app.listen(PORT, () => console.log(`Kitchen Journal running at http://localhost:${PORT}`));
