import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(dataDir, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'kitchen.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    share_enabled INTEGER NOT NULL DEFAULT 0,
    share_token   TEXT UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entries (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'Mains',
    recipe_url   TEXT,
    image_url    TEXT,
    ingredients  TEXT NOT NULL DEFAULT '[]',
    instructions TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    made_on      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id);

  CREATE TABLE IF NOT EXISTS photos (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_photos_entry ON photos(entry_id);

  -- One featured recipe per ISO week. The snapshot keeps the recipe readable even if
  -- the owner later edits or deletes the original entry.
  CREATE TABLE IF NOT EXISTS spotlights (
    week       TEXT PRIMARY KEY,               -- e.g. 2026-W47
    entry_id   INTEGER REFERENCES entries(id) ON DELETE SET NULL,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    snapshot   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Community "cook-along" entries for a spotlight: one per user per week.
  CREATE TABLE IF NOT EXISTS spotlight_submissions (
    id         INTEGER PRIMARY KEY,
    week       TEXT NOT NULL REFERENCES spotlights(week) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    caption    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (week, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sub_entry ON spotlight_submissions(entry_id);
`);

// Clear out expired sessions on boot.
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
