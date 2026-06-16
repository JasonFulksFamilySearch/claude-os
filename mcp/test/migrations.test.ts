import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { openDb } from "../src/db.js";
import { isV3Schema } from "../src/migrations.js";

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
