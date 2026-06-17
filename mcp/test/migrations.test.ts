import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { openDb } from "../src/db.js";
import { isV3Schema, runMigrations, backupDb, verifyV3 } from "../src/migrations.js";
import { main as migrateMain } from "../src/scripts/migrate.js";

let workDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-migrations-"));
  dbPath = join(workDir, "test.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("isV3Schema", () => {
  it("isV3Schema is true for a fresh DB", () => { expect(isV3Schema(db)).toBe(true); });
});

describe("openDb fail-fast on pre-C2 schema", () => {
  it("throws with npm run migrate directive when observations table lacks anchor column", () => {
    // Build a v2 DB: create observations WITHOUT the anchor column, then close
    const v2Dir = mkdtempSync(join(tmpdir(), "claude-os-v2-"));
    const v2Path = join(v2Dir, "v2.db");
    try {
      const raw = new Database(v2Path);
      raw.pragma("journal_mode = WAL");
      sqliteVec.load(raw);
      // Pre-C2 shape: faithful v2 columns, no anchor or parent_title
      raw.exec(`
        CREATE TABLE observations (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source_type  TEXT NOT NULL,
          source_path  TEXT NOT NULL,
          project      TEXT,
          topic        TEXT,
          title        TEXT,
          frontmatter  TEXT,
          content      TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          file_mtime   INTEGER NOT NULL,
          indexed_at   INTEGER NOT NULL,
          UNIQUE(source_path)
        );
      `);
      raw.close();

      // openDb must throw because anchor is absent
      expect(() => openDb(v2Path)).toThrowError(/npm run migrate/);
    } finally {
      rmSync(v2Dir, { recursive: true, force: true });
    }
  });

  it("does NOT throw for a fresh DB (initSchema just created v3)", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "claude-os-fresh-"));
    const freshPath = join(freshDir, "fresh.db");
    try {
      expect(() => openDb(freshPath)).not.toThrow();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3: v2 → v3 migration framework (runMigrations / backupDb / verifyV3)
// ---------------------------------------------------------------------------

// vec0 stores the embedding as raw little-endian float32 bytes. We avoid the
// real embedder (transformers) and serialize a fixed vector inline.
function vec(fill: number): Buffer {
  const v = new Float32Array(768).fill(fill);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Build a faithful pre-C2 (v2) database that mirrors mcp/src/db.ts as it stood
 * before the anchor column was introduced: the v2 observations table
 * (UNIQUE(source_path), NO anchor / parent_title), the FTS5 external-content
 * observations_fts virtual table WITH its ai/ad/au sync triggers, the vec_items
 * vec0 table, and the access_stats side table. Seeds two rows with KNOWN ids
 * (1, 2) plus matching vec_items (BigInt-bound) and one access_stats row, so the
 * migration tests can prove id preservation and side-table survival.
 *
 * Returns the open raw handle (caller owns it). The DB is NOT opened through
 * openDb — openDb fail-fasts on a pre-C2 schema by design.
 */
function makeV2(dbPath: string): Database.Database {
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  sqliteVec.load(raw);

  raw.exec(`
    CREATE TABLE observations (
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

    CREATE INDEX idx_obs_source_type ON observations(source_type);
    CREATE INDEX idx_obs_project ON observations(project);
    CREATE INDEX idx_obs_topic ON observations(topic);
    CREATE INDEX idx_obs_indexed_at ON observations(indexed_at);

    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title,
      content,
      topic,
      content='observations',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, topic)
      VALUES (new.id, new.title, new.content, new.topic);
    END;
    CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, topic)
      VALUES ('delete', old.id, old.title, old.content, old.topic);
    END;
    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, topic)
      VALUES ('delete', old.id, old.title, old.content, old.topic);
      INSERT INTO observations_fts(rowid, title, content, topic)
      VALUES (new.id, new.title, new.content, new.topic);
    END;

    CREATE VIRTUAL TABLE vec_items USING vec0(
      observation_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    );

    CREATE TABLE access_stats (
      observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
      last_accessed  INTEGER,
      access_count   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Seed two rows with KNOWN explicit ids. Row 1 carries a rare term so the FTS
  // probe is deterministic; row 2 proves multi-row id preservation.
  const ins = raw.prepare(`
    INSERT INTO observations
      (id, source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  ins.run(1, "learning", "/a/learnings.md", "claude-os", "java", "First", "the rare unicornfish swims here", "h1", 100, 200, null);
  ins.run(2, "context", "/b/context.md", null, "infra", "Second", "ordinary content about checkstyle", "h2", 101, 201, null);

  // Matching vec_items (vec0 PK must be bound as BigInt).
  const vins = raw.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?, ?)");
  vins.run(BigInt(1), vec(0.1));
  vins.run(BigInt(2), vec(0.2));

  // One access_stats row keyed to observation 1.
  raw.prepare("INSERT INTO access_stats(observation_id, last_accessed, access_count) VALUES (?, ?, ?)")
    .run(1, 999, 5);

  return raw;
}

function openRaw(p: string): Database.Database {
  const raw = new Database(p);
  sqliteVec.load(raw);
  return raw;
}

describe("runMigrations v2 → v3", () => {
  let v2Dir: string;
  let v2Path: string;
  let v2: Database.Database;

  beforeEach(() => {
    v2Dir = mkdtempSync(join(tmpdir(), "claude-os-v2mig-"));
    v2Path = join(v2Dir, "v2.db");
    v2 = makeV2(v2Path);
  });

  afterEach(() => {
    try { v2.close(); } catch { /* already closed */ }
    rmSync(v2Dir, { recursive: true, force: true });
  });

  it("migrates v2→v3 preserving every id", () => {
    const r = runMigrations(v2);
    expect(r.migrated).toBe(true);
    expect((v2.prepare("SELECT id FROM observations ORDER BY id").all() as { id: number }[]).map(x => x.id)).toEqual([1, 2]);
    expect(isV3Schema(v2)).toBe(true);
    expect((v2.prepare("SELECT anchor FROM observations").all() as { anchor: string }[]).every(x => x.anchor === "")).toBe(true);
    // parent_title defaults to NULL for migrated rows
    expect((v2.prepare("SELECT parent_title FROM observations").all() as { parent_title: unknown }[]).every(x => x.parent_title === null)).toBe(true);
  });

  it("preserves vec_items and access_stats by id", () => {
    runMigrations(v2);
    expect((v2.prepare("SELECT COUNT(*) c FROM vec_items").get() as { c: number }).c).toBe(2);
    expect((v2.prepare("SELECT access_count FROM access_stats WHERE observation_id=1").get() as { access_count: number }).access_count).toBe(5);
    // vec_items rows still key to the preserved ids
    const vecIds = (v2.prepare("SELECT observation_id FROM vec_items ORDER BY observation_id").all() as { observation_id: number }[]).map(x => x.observation_id);
    expect(vecIds).toEqual([1, 2]);
  });

  it("FTS returns pre-migration content after rebuild", () => {
    runMigrations(v2);
    const hit = v2.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'unicornfish'").get() as { rowid: number } | undefined;
    expect(hit?.rowid).toBe(1);
    // The riskier direction: row 2's term resolves to ITS rowid, not desynced to row 1.
    const hit2 = v2.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'checkstyle'").get() as { rowid: number } | undefined;
    expect(hit2?.rowid).toBe(2);
  });

  it("is idempotent — second run is a no-op", () => {
    const r1 = runMigrations(v2);
    expect(r1.migrated).toBe(true);
    const r2 = runMigrations(v2);
    expect(r2.migrated).toBe(false);
  });

  it("advances user_version to 3", () => {
    runMigrations(v2);
    expect(v2.pragma("user_version", { simple: true })).toBe(3);
  });

  it("backupDb writes a readable copy", () => {
    const backupPath = join(v2Dir, "backup.db");
    backupDb(v2, backupPath);
    expect(existsSync(backupPath)).toBe(true);
    const c = openRaw(backupPath);
    try {
      expect((c.prepare("SELECT COUNT(*) c FROM observations").get() as { c: number }).c).toBeGreaterThan(0);
    } finally {
      c.close();
    }
  });

  it("verifyV3 throws on a corrupted FTS mapping", () => {
    runMigrations(v2);
    // Tamper: delete the external-content shadow rows directly from the FTS
    // index without going through the triggers, so the FTS probe term no longer
    // resolves to any rowid — a silent desync verifyV3 must catch.
    v2.exec("INSERT INTO observations_fts(observations_fts) VALUES('delete-all')");
    expect(() => verifyV3(v2)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 4: migrate.ts operator script smoke test
// ---------------------------------------------------------------------------

describe("migrate script main()", () => {
  let smokeDir: string;
  let smokeDbPath: string;
  let smokeBackupPath: string;

  beforeEach(() => {
    smokeDir = mkdtempSync(join(tmpdir(), "claude-os-migrate-smoke-"));
    smokeDbPath = join(smokeDir, "smoke.db");
    smokeBackupPath = join(smokeDir, "smoke.db.pre-c2.bak");

    // Build a v2 DB to drive the script against
    const raw = makeV2(smokeDbPath);
    raw.close();
  });

  afterEach(() => {
    rmSync(smokeDir, { recursive: true, force: true });
  });

  it("creates a backup and upgrades the DB to v3", async () => {
    await migrateMain(smokeDbPath, smokeBackupPath);

    // Backup must exist and be a readable SQLite file
    expect(existsSync(smokeBackupPath)).toBe(true);
    const bak = new Database(smokeBackupPath);
    try {
      // Backup was taken before migration — it should still be a v2 snapshot
      // (no anchor column). Confirm it has the observations table at all.
      const rows = bak.prepare("SELECT COUNT(*) AS c FROM observations").get() as { c: number };
      expect(rows.c).toBeGreaterThanOrEqual(0);
    } finally {
      bak.close();
    }

    // The live DB must now be v3
    const upgraded = new Database(smokeDbPath);
    sqliteVec.load(upgraded);
    try {
      expect(isV3Schema(upgraded)).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  it("is idempotent — running twice on a v3 DB does not throw", async () => {
    await migrateMain(smokeDbPath, smokeBackupPath);
    // Second run: backup already exists, script should still succeed (no-op migration)
    await migrateMain(smokeDbPath, smokeBackupPath + ".2");
  });
});
