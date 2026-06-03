import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_DB_PATH = join(homedir(), ".claude-data", "memory.db");

export function openDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  initSchema(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type   TEXT NOT NULL,
      source_path   TEXT NOT NULL,
      project       TEXT,
      topic         TEXT,
      title         TEXT,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      file_mtime    INTEGER NOT NULL,
      indexed_at    INTEGER NOT NULL,
      frontmatter   TEXT,

      UNIQUE(source_path)
    );

    CREATE INDEX IF NOT EXISTS idx_obs_source_type ON observations(source_type);
    CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(topic);
    CREATE INDEX IF NOT EXISTS idx_obs_indexed_at ON observations(indexed_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title,
      content,
      topic,
      content='observations',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, topic)
      VALUES (new.id, new.title, new.content, new.topic);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, topic)
      VALUES ('delete', old.id, old.title, old.content, old.topic);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, topic)
      VALUES ('delete', old.id, old.title, old.content, old.topic);
      INSERT INTO observations_fts(rowid, title, content, topic)
      VALUES (new.id, new.title, new.content, new.topic);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
      observation_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    );

    -- Per-observation access reinforcement state, kept in a side table (not columns
    -- on observations) so the access-bump write never fires the observations FTS-sync
    -- triggers. Mirrors vec_items: a derived, per-observation table keyed by id.
    -- ON DELETE CASCADE (foreign_keys is enabled in openDb) auto-cleans on removal.
    CREATE TABLE IF NOT EXISTS access_stats (
      observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
      last_accessed  INTEGER,
      access_count   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '2');
    INSERT OR IGNORE INTO meta(key, value) VALUES ('phase', '4');
  `);
}

export type SourceType =
  | "context"
  | "learning"
  | "decision"
  | "project_claude_md"
  | "project_readme"
  | "agent"
  | "episode";

export interface ObservationRow {
  id: number;
  source_type: SourceType;
  source_path: string;
  project: string | null;
  topic: string | null;
  title: string | null;
  content: string;
  content_hash: string;
  file_mtime: number;
  indexed_at: number;
  frontmatter: string | null;
}
