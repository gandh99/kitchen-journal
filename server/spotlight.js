// Weekly Spotlight: every ISO week one shared entry is featured, and anyone signed in
// can "cook along" by submitting their own entry for that recipe.
import path from 'node:path';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { fail, withPhotos, coverOf, createEntryCopy, duplicatePhotoFile, photoUrl, removePhotoFile } from './entries.js';

const WEEK_RE = /^\d{4}-W\d{2}$/;

// ---------------------------------------------------------------- week maths (server local time)
export function isoWeek(d = new Date()) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // Mon=0
  t.setDate(t.getDate() - day + 3); // Thursday decides the ISO year
  const year = t.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function weekStart(week) {
  const [y, w] = week.split('-W').map(Number);
  const jan4 = new Date(y, 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7);
  return monday;
}

export function weekLabel(week) {
  const start = weekStart(week);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d, opts) => d.toLocaleDateString('en-GB', opts);
  return start.getMonth() === end.getMonth()
    ? `${start.getDate()}–${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ---------------------------------------------------------------- eligibility & cleanup
// An owner is eligible while they have sharing on AND have opted in to the Spotlight.
const ELIGIBLE_OWNER = 'u.share_enabled = 1 AND u.spotlight_opt_in = 1';

function deleteSpotlightRows(rows) {
  if (!rows.length) return 0;
  const del = db.prepare('DELETE FROM spotlights WHERE week = ?'); // cook-along submissions cascade
  for (const r of rows) {
    del.run(r.week);
    let photos = [];
    try { photos = JSON.parse(r.snapshot).photos || []; } catch { /* ignore */ }
    for (const url of photos) {
      const name = path.basename(String(url));
      if (name.startsWith('spot-')) removePhotoFile(name);
    }
  }
  return rows.length;
}

/** Remove every snapshot (and its spot-* photo copies) of a user's recipes. */
export function deleteSpotlightsForUser(userId) {
  return deleteSpotlightRows(db.prepare('SELECT week, snapshot FROM spotlights WHERE user_id = ?').all(userId));
}

/** Remove snapshots (and spot-* photo copies) of one entry. Call before deleting the entry. */
export function deleteSpotlightsForEntry(entryId) {
  return deleteSpotlightRows(db.prepare('SELECT week, snapshot FROM spotlights WHERE entry_id = ?').all(entryId));
}

/** Drop snapshots whose owner is gone, stopped sharing or never opted in. Runs on every read. */
function purgeIneligibleSpotlights() {
  return deleteSpotlightRows(db.prepare(`SELECT s.week, s.snapshot FROM spotlights s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE u.id IS NULL OR NOT (${ELIGIBLE_OWNER})`).all());
}

/** True if `filename` is a spot-* photo copy belonging to a live snapshot. */
export function isLiveSpotlightFile(filename) {
  return !!db.prepare(`SELECT 1 FROM spotlights s JOIN users u ON u.id = s.user_id
    WHERE ${ELIGIBLE_OWNER} AND instr(s.snapshot, ?) > 0 LIMIT 1`).get(`/uploads/${filename}"`);
}

// ---------------------------------------------------------------- picking the featured entry
function hash(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Choose this week's entry from collections whose owners turned sharing on and opted in to the Spotlight.
 * Prefers complete entries (photo, ingredients, method), never repeats an entry or
 * recipe name, and avoids featuring the same cook two weeks running.
 */
function pickEntry(week) {
  const last = db.prepare('SELECT user_id, snapshot FROM spotlights ORDER BY week DESC LIMIT 1').get();
  const usedNames = new Set(db.prepare('SELECT snapshot FROM spotlights').all()
    .map((r) => JSON.parse(r.snapshot).name.toLowerCase().trim()));
  const rows = db.prepare(`
    SELECT e.*, (SELECT COUNT(*) FROM photos p WHERE p.entry_id = e.id) AS nphotos
    FROM entries e JOIN users u ON u.id = e.user_id
    WHERE ${ELIGIBLE_OWNER}
      AND e.status = 'made'
      AND e.id NOT IN (SELECT entry_id FROM spotlights WHERE entry_id IS NOT NULL)`).all()
    .filter((r) => !usedNames.has(r.name.toLowerCase().trim()));
  if (!rows.length) return null;
  const score = (r) => (r.nphotos ? 3 : r.image_url ? 2 : 0)
    + (JSON.parse(r.ingredients).length >= 3 ? 2 : 0)
    + (r.instructions.trim() ? 1 : 0)
    - (last && r.user_id === last.user_id ? 1.5 : 0);
  const top = Math.max(...rows.map(score));
  return rows.filter((r) => score(r) === top).sort((a, b) => hash(week + a.id) - hash(week + b.id))[0];
}

function createSpotlight(week) {
  const row = pickEntry(week);
  if (!row) return null;
  const [entry] = withPhotos([row]);
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
  // Keep our own copies of the photos so the spotlight survives edits/deletes.
  const photoRows = db.prepare('SELECT filename FROM photos WHERE entry_id = ? ORDER BY id').all(row.id);
  const photos = photoRows.map((p) => duplicatePhotoFile(p.filename, 'spot-')).filter(Boolean).map(photoUrl);
  const snapshot = {
    name: entry.name, category: entry.category, tags: entry.tags, ingredients: entry.ingredients,
    instructions: entry.instructions, recipeUrl: entry.recipeUrl, imageUrl: entry.imageUrl,
    madeOn: entry.madeOn, photos, owner: owner.username,
  };
  db.prepare('INSERT OR IGNORE INTO spotlights (week, entry_id, user_id, snapshot) VALUES (?, ?, ?, ?)')
    .run(week, row.id, row.user_id, JSON.stringify(snapshot));
  return db.prepare('SELECT * FROM spotlights WHERE week = ?').get(week);
}

function getSpotlight(week, { create = false } = {}) {
  purgeIneligibleSpotlights();
  const row = db.prepare('SELECT * FROM spotlights WHERE week = ?').get(week);
  if (row || !create) return row || null;
  return createSpotlight(week);
}

/** Snapshot in the same shape as a normal entry, so the frontend can reuse its views. */
function featuredEntry(row) {
  const s = JSON.parse(row.snapshot);
  return {
    id: row.entry_id, name: s.name, category: s.category, tags: s.tags, ingredients: s.ingredients,
    instructions: s.instructions, notes: '', recipeUrl: s.recipeUrl, imageUrl: s.imageUrl, madeOn: s.madeOn,
    updatedAt: row.created_at, photos: s.photos.map((url, i) => ({ id: i, url })), owner: s.owner,
  };
}

function requireSpotlight(week) {
  if (!WEEK_RE.test(week)) throw fail(400, 'Invalid week.');
  const row = getSpotlight(week, { create: week === isoWeek() });
  if (!row) throw fail(404, 'There is no spotlight for that week.');
  return row;
}

function listSubmissions(week, viewerId) {
  const rows = db.prepare(`
    SELECT s.id AS sub_id, s.caption, s.created_at AS sub_created, s.user_id AS sub_user, u.username, e.*
    FROM spotlight_submissions s
    JOIN entries e ON e.id = s.entry_id
    JOIN users u ON u.id = s.user_id
    WHERE s.week = ? ORDER BY s.created_at DESC, s.id DESC`).all(week);
  const entries = withPhotos(rows);
  return rows.map((r, i) => ({
    id: r.sub_id,
    caption: r.caption,
    createdAt: r.sub_created,
    username: r.username,
    isMine: r.sub_user === viewerId,
    entry: { id: entries[i].id, name: entries[i].name, category: entries[i].category, tags: entries[i].tags, cover: coverOf(entries[i]), photoCount: entries[i].photos.length },
  }));
}

/** For an entry's detail page: spotlights it was featured in or submitted to. */
export function entrySpotlightInfo(entryId) {
  const featured = db.prepare('SELECT week FROM spotlights WHERE entry_id = ?').all(entryId)
    .map((r) => ({ week: r.week, label: weekLabel(r.week) }));
  const submitted = db.prepare(`SELECT s.week, sp.snapshot FROM spotlight_submissions s
    JOIN spotlights sp ON sp.week = s.week WHERE s.entry_id = ?`).all(entryId)
    .map((r) => ({ week: r.week, label: weekLabel(r.week), name: JSON.parse(r.snapshot).name }));
  return { featured, submitted };
}

// ---------------------------------------------------------------- routes
export function registerSpotlightRoutes(app) {
  const payload = (week, user) => {
    const current = isoWeek();
    const row = getSpotlight(week, { create: week === current });
    const archive = db.prepare('SELECT week, snapshot FROM spotlights WHERE week != ? ORDER BY week DESC LIMIT 52').all(week)
      .map((r) => {
        const s = JSON.parse(r.snapshot);
        const count = db.prepare('SELECT COUNT(*) AS n FROM spotlight_submissions WHERE week = ?').get(r.week).n;
        return { week: r.week, label: weekLabel(r.week), name: s.name, owner: s.owner, cover: s.photos[0] || s.imageUrl || '', category: s.category, count };
      });
    if (!row) return { week, label: weekLabel(week), isCurrent: week === current, featured: null, submissions: [], archive };
    const featured = featuredEntry(row);
    const submissions = listSubmissions(week, user.id);
    return {
      week, label: weekLabel(week), isCurrent: week === current,
      featured: { ...featured, isMine: row.user_id === user.id },
      submissions,
      mySubmission: submissions.find((s) => s.isMine) || null,
      archive,
    };
  };

  app.get('/api/spotlight', requireAuth, (req, res) => res.json(payload(isoWeek(), req.user)));

  app.get('/api/spotlight/:week', requireAuth, (req, res) => {
    if (!WEEK_RE.test(req.params.week)) throw fail(400, 'Invalid week.');
    if (req.params.week > isoWeek()) throw fail(404, "That week's spotlight hasn't been chosen yet.");
    res.json(payload(req.params.week, req.user));
  });

  // Submit (or replace) my entry for this spotlight.
  app.post('/api/spotlight/:week/submissions', requireAuth, (req, res) => {
    const sp = requireSpotlight(req.params.week);
    const entry = db.prepare('SELECT id FROM entries WHERE id = ? AND user_id = ?').get(Number(req.body.entryId), req.user.id);
    if (!entry) throw fail(400, 'Pick one of your own entries to submit.');
    if (entry.id === sp.entry_id) throw fail(400, "That's the featured entry itself. Submit an entry of the dish you cooked from it.");
    const caption = String(req.body.caption ?? '').trim().slice(0, 280);
    db.prepare(`INSERT INTO spotlight_submissions (week, user_id, entry_id, caption) VALUES (?, ?, ?, ?)
      ON CONFLICT (week, user_id) DO UPDATE SET entry_id = excluded.entry_id, caption = excluded.caption`)
      .run(sp.week, req.user.id, entry.id, caption);
    res.status(201).json(payload(sp.week, req.user));
  });

  app.delete('/api/spotlight/:week/submissions/mine', requireAuth, (req, res) => {
    db.prepare('DELETE FROM spotlight_submissions WHERE week = ? AND user_id = ?').run(req.params.week, req.user.id);
    res.status(204).end();
  });

  app.get('/api/spotlight/:week/submissions/:id', requireAuth, (req, res) => {
    const sp = requireSpotlight(req.params.week);
    const row = db.prepare(`SELECT s.id AS sub_id, s.caption, s.user_id AS sub_user, u.username, e.*
      FROM spotlight_submissions s JOIN entries e ON e.id = s.entry_id JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.week = ?`).get(Number(req.params.id), sp.week);
    if (!row) throw fail(404, 'Submission not found.');
    res.json({
      submission: { id: row.sub_id, caption: row.caption, username: row.username, isMine: row.sub_user === req.user.id },
      spotlight: { week: sp.week, name: JSON.parse(sp.snapshot).name },
      entry: withPhotos([row])[0],
    });
  });

  // Copy someone's submission into my kitchen.
  app.post('/api/spotlight/:week/submissions/:id/save', requireAuth, (req, res) => {
    const sp = requireSpotlight(req.params.week);
    const row = db.prepare(`SELECT u.username, e.* FROM spotlight_submissions s JOIN entries e ON e.id = s.entry_id
      JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.week = ?`).get(Number(req.params.id), sp.week);
    if (!row) throw fail(404, 'Submission not found.');
    const [e] = withPhotos([row]);
    const files = db.prepare('SELECT filename FROM photos WHERE entry_id = ? ORDER BY id').all(row.id).map((p) => p.filename);
    const id = createEntryCopy(req.user.id, e, { notes: `Saved from ${row.username}'s Spotlight cook-along.`, photoFiles: files });
    res.status(201).json({ id });
  });

  // Save the featured recipe to my kitchen. With {cookAlong: true} the copy has no
  // photos, ready for me to add pictures of my own version and submit it.
  app.post('/api/spotlight/:week/save', requireAuth, (req, res) => {
    const sp = requireSpotlight(req.params.week);
    const f = featuredEntry(sp);
    const cookAlong = !!req.body.cookAlong;
    const files = cookAlong ? [] : f.photos.map((p) => path.basename(p.url));
    const id = createEntryCopy(req.user.id, { ...f, imageUrl: cookAlong ? '' : f.imageUrl }, {
      notes: cookAlong
        ? `Cooked along with the Spotlight for ${weekLabel(sp.week)} (recipe from ${f.owner}'s kitchen).`
        : `Saved from the Spotlight for ${weekLabel(sp.week)} (from ${f.owner}'s kitchen).`,
      photoFiles: files,
    });
    res.status(201).json({ id });
  });
}
