// HTTP routes for Markdown export (zip / single recipe) and import (parse -> preview -> confirm).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Zip, ZipDeflate, ZipPassThrough, strToU8, unzipSync, strFromU8 } from 'fflate';
import { db, UPLOAD_DIR } from './db.js';
import { requireAuth } from './auth.js';
import { fail, withPhotos, cleanEntry, insertEntry } from './entries.js';
import { planExport, exportTextFiles, recipeMarkdown, buildImportPreview, isImagePath, slugify } from './markdown.js';

const IMAGE_TYPES = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.webp': 'webp', '.gif': 'gif', '.avif': 'avif' };
const MAX_ZIP = 500 * 1024 * 1024;
const MAX_IMPORTED_PHOTO = 15 * 1024 * 1024;

// Zip imports keep their images here between "preview" and "confirm".
const stash = new Map();
const STASH_TTL = 30 * 60 * 1000;
setInterval(() => { for (const [k, v] of stash) if (v.expires < Date.now()) stash.delete(k); }, 60 * 1000).unref();

const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP, files: 1 } });

/** Validate image bytes by magic number (never trust the extension alone). */
function sniffImage(buf) {
  const b = Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, Math.min(buf.length, 16));
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (b.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (b.toString('ascii', 4, 12).startsWith('ftypavi')) return '.avif';
  return null;
}

/** Strip a single common top folder ("Food/…", "kitchen-journal/…") so paths are comparable. */
function stripCommonRoot(paths) {
  const firsts = new Set(paths.map((p) => p.split('/')[0]));
  if (firsts.size === 1 && paths.every((p) => p.includes('/'))) {
    const root = [...firsts][0] + '/';
    return (p) => (p.startsWith(root) ? p.slice(root.length) : p);
  }
  return (p) => p;
}

const userEntries = (userId) => withPhotos(db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId));

export function registerMarkdownRoutes(app) {
  // ---------------------------------------------------------------- export everything (zip, streamed)
  app.get('/api/export/markdown', requireAuth, async (req, res, next) => {
    try {
      const includePhotos = req.query.photos !== '0';
      const entries = userEntries(req.user.id).map((e) => ({
        ...e, photos: e.photos.map((p) => ({ ...p, file: path.basename(p.url) })),
      }));
      const plans = planExport(entries);
      const root = 'kitchen-journal';
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="kitchen-journal-${stamp}.zip"`);

      const zip = new Zip((err, chunk, final) => {
        if (err) { res.destroy(err); return; }
        res.write(Buffer.from(chunk));
        if (final) res.end();
      });
      for (const [p, text] of exportTextFiles(plans, { username: req.user.username, includePhotos })) {
        const f = new ZipDeflate(`${root}/${p}`, { level: 6 });
        zip.add(f);
        f.push(strToU8(text), true);
      }
      if (includePhotos) {
        for (const plan of plans) {
          for (const pic of plan.pictures) {
            let data;
            try { data = await fs.promises.readFile(path.join(UPLOAD_DIR, pic.src)); } catch { continue; }
            const f = new ZipPassThrough(`${root}/${pic.zipPath}`); // photos are already compressed
            zip.add(f);
            f.push(data, true);
          }
        }
      }
      zip.end();
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- one recipe as .md
  app.get('/api/entries/:id/markdown', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!row) throw fail(404, 'Entry not found.');
    const [e] = withPhotos([row]);
    const origin = `${req.protocol}://${req.get('host')}`;
    const md = recipeMarkdown(e, { photoLinks: e.photos.map((p) => origin + p.url), absolutePhotos: true });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slugify(e.name)}.md"`);
    res.send(md);
  });

  // ---------------------------------------------------------------- import step 1: parse -> preview
  // Either JSON {files:[{path,text}], imagePaths:[…], maxPhotos} (folder / .md files picked in the
  // browser; photos are uploaded afterwards), or multipart with one .zip in "archive".
  app.post('/api/markdown/parse', requireAuth, (req, res, next) => {
    const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/');
    const run = () => {
      const maxPhotos = Math.max(0, Math.min(50, Number(req.body.maxPhotos ?? 12) || 0));
      let files = [];
      let imagePaths = [];
      let importId = null;

      if (req.file) {
        let entries;
        try {
          entries = unzipSync(new Uint8Array(req.file.buffer), {
            filter: (f) => !f.name.endsWith('/') && (f.name.toLowerCase().endsWith('.md') || isImagePath(f.name)) && !/(^|\/)(__MACOSX|\.git)\//.test(f.name),
          });
        } catch { throw fail(400, "That file isn't a readable .zip archive."); }
        const names = Object.keys(entries);
        const strip = stripCommonRoot(names);
        const images = new Map();
        for (const name of names) {
          const p = strip(name);
          if (name.toLowerCase().endsWith('.md')) files.push({ path: p, text: strFromU8(entries[name]) });
          else if (entries[name].length <= MAX_IMPORTED_PHOTO) { images.set(p, entries[name]); imagePaths.push(p); }
        }
        importId = crypto.randomBytes(12).toString('hex');
        stash.set(importId, { userId: req.user.id, images, expires: Date.now() + STASH_TTL });
      } else {
        if (!Array.isArray(req.body.files)) throw fail(400, 'No Markdown files were received.');
        const all = req.body.files.slice(0, 2000).map((f) => ({ path: String(f.path || 'file.md').replace(/\\/g, '/'), text: String(f.text || '').slice(0, 2_000_000) }));
        imagePaths = (Array.isArray(req.body.imagePaths) ? req.body.imagePaths : []).slice(0, 50000).map((p) => String(p).replace(/\\/g, '/'));
        const strip = stripCommonRoot([...all.map((f) => f.path), ...imagePaths]);
        files = all.map((f) => ({ ...f, path: strip(f.path) }));
        // Keep a map back to the browser's original paths so it can find the File objects.
        const back = new Map(imagePaths.map((p) => [strip(p), p]));
        imagePaths = [...back.keys()];
        req.pathBack = back;
      }
      if (!files.length) throw fail(400, 'No Markdown (.md) files found. Pick your notes folder, .md files, or an exported .zip.');

      const { items, skipped } = buildImportPreview({ files, imagePaths, existing: userEntries(req.user.id), maxPhotos });
      if (req.pathBack) for (const it of items) it.photos = it.photos.map((p) => req.pathBack.get(p) || p);
      res.json({ importId, items, skipped, stats: { markdownFiles: files.length, images: imagePaths.length } });
    };
    if (isMultipart) {
      zipUpload.single('archive')(req, res, (err) => {
        if (err) return next(err.code === 'LIMIT_FILE_SIZE' ? fail(413, 'That zip is larger than 500 MB.') : err);
        try { run(); } catch (e) { next(e); }
      });
    } else {
      try { run(); } catch (e) { next(e); }
    }
  });

  // ---------------------------------------------------------------- import step 2: create entries
  app.post('/api/markdown/import', requireAuth, (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 5000) : [];
    if (!items.length) throw fail(400, 'Nothing selected to import.');
    const zipStash = req.body.importId ? stash.get(String(req.body.importId)) : null;
    if (req.body.importId && (!zipStash || zipStash.userId !== req.user.id)) {
      throw fail(410, 'This import expired. Choose the zip again.');
    }
    const okDate = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace('T', ' ').slice(0, 19) : null);
    const insertPhoto = db.prepare('INSERT INTO photos (entry_id, filename) VALUES (?, ?)');
    const created = [];
    const errors = [];
    let photosSaved = 0;

    db.exec('BEGIN');
    try {
      for (const item of items) {
        try {
          const clean = cleanEntry(item);
          const id = insertEntry(req.user.id, { ...clean, createdAt: okDate(item.createdAt), updatedAt: okDate(item.updatedAt) });
          created.push({ key: item.key, id });
          if (zipStash && Array.isArray(item.photos)) {
            for (const p of item.photos.slice(0, 50)) {
              const data = zipStash.images.get(p);
              const ext = data && sniffImage(data);
              if (!ext) continue;
              const filename = crypto.randomBytes(16).toString('hex') + ext;
              fs.writeFileSync(path.join(UPLOAD_DIR, filename), data);
              insertPhoto.run(id, filename);
              photosSaved++;
            }
          }
        } catch (e) {
          errors.push({ key: item.key, name: item.name, error: e.message });
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (zipStash) stash.delete(String(req.body.importId));
    res.status(201).json({ created, errors, photosSaved });
  });
}
