/**
 * In-memory SQLite DB for presenting engine.
 * Mirrors presenting/engine/services/database.py (aiosqlite + sqlmodel)
 * but using synchronous better-sqlite3 — no greenlet equivalent needed.
 */
import Database from "better-sqlite3";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error("Presenting DB not initialized — call initDb() first");
  return _db;
}

export function initDb(): void {
  if (_db) return;
  _db = new Database(":memory:");
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS presentations (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL DEFAULT 'v2-standard',
      content TEXT NOT NULL DEFAULT '',
      n_slides INTEGER NOT NULL DEFAULT 0,
      language TEXT,
      title TEXT,
      file_paths TEXT,
      outlines TEXT,
      layout TEXT,
      structure TEXT,
      instructions TEXT,
      tone TEXT,
      verbosity TEXT,
      include_table_of_contents INTEGER NOT NULL DEFAULT 0,
      include_title_slide INTEGER NOT NULL DEFAULT 1,
      web_search INTEGER NOT NULL DEFAULT 0,
      generation_mode TEXT NOT NULL DEFAULT 'standard',
      theme TEXT,
      fonts TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS slides (
      id TEXT PRIMARY KEY,
      presentation_id TEXT NOT NULL REFERENCES presentations(id),
      layout_group TEXT,
      layout TEXT,
      slide_index INTEGER NOT NULL DEFAULT 0,
      content TEXT,
      html_content TEXT,
      speaker_note TEXT,
      properties TEXT,
      ui TEXT
    );

    CREATE TABLE IF NOT EXISTS key_value (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_history_messages (
      id TEXT PRIMARY KEY,
      presentation_id TEXT NOT NULL REFERENCES presentations(id),
      role TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
