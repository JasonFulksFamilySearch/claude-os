import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

let workDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-db-"));
  dbPath = join(workDir, "test.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

function insertObservation(overrides: Partial<Record<string, unknown>> = {}): number {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO observations (
      source_type, source_path, project, topic, title,
      content, content_hash, file_mtime, indexed_at, frontmatter
    ) VALUES (
      @source_type, @source_path, @project, @topic, @title,
      @content, @content_hash, @file_mtime, @indexed_at, @frontmatter
    )
  `);
  const result = stmt.run({
    source_type: "context",
    source_path: `/tmp/fake-${Math.random()}.md`,
    project: null,
    topic: "java",
    title: "Java Conventions",
    content: "Run mvn clean test before committing.",
    content_hash: "abc123",
    file_mtime: now,
    indexed_at: now,
    frontmatter: null,
    ...overrides,
  });
  return Number(result.lastInsertRowid);
}

function ftsSearch(query: string): { rowid: number }[] {
  return db
    .prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?",
    )
    .all(query) as { rowid: number }[];
}

describe("db", () => {
  it("openDb is idempotent", () => {
    db.close();
    db = openDb(dbPath);
    db.close();
    db = openDb(dbPath);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("phase") as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("4");
  });

  it("FTS trigger fires on insert", () => {
    const id = insertObservation({
      source_path: "/tmp/insert.md",
      content: "checkstyle violations matter",
    });
    const hits = ftsSearch("checkstyle");
    expect(hits.map((h) => h.rowid)).toContain(id);
  });

  it("FTS trigger fires on update", () => {
    const id = insertObservation({
      source_path: "/tmp/update.md",
      content: "alpha bravo charlie",
    });
    expect(ftsSearch("bravo").map((h) => h.rowid)).toContain(id);

    db.prepare("UPDATE observations SET content = ? WHERE id = ?").run(
      "delta echo foxtrot",
      id,
    );

    expect(ftsSearch("bravo").map((h) => h.rowid)).not.toContain(id);
    expect(ftsSearch("foxtrot").map((h) => h.rowid)).toContain(id);
  });

  it("FTS trigger fires on delete", () => {
    const id = insertObservation({
      source_path: "/tmp/delete.md",
      content: "ephemeral kangaroo",
    });
    expect(ftsSearch("kangaroo").map((h) => h.rowid)).toContain(id);

    db.prepare("DELETE FROM observations WHERE id = ?").run(id);
    expect(ftsSearch("kangaroo").map((h) => h.rowid)).not.toContain(id);
  });
});

describe("access_stats", () => {
  it("creates the access_stats table (idempotent across opens)", () => {
    db.close();
    db = openDb(dbPath);
    const id = insertObservation({ source_path: "/tmp/acc-create.md" });
    db.prepare(
      "INSERT INTO access_stats(observation_id, last_accessed, access_count) VALUES (?, ?, ?)",
    ).run(id, 1000, 1);
    const row = db
      .prepare("SELECT access_count FROM access_stats WHERE observation_id = ?")
      .get(id) as { access_count: number } | undefined;
    expect(row?.access_count).toBe(1);
  });

  it("cascades delete: removing an observation drops its access_stats row", () => {
    const id = insertObservation({ source_path: "/tmp/acc-cascade.md" });
    db.prepare(
      "INSERT INTO access_stats(observation_id, last_accessed, access_count) VALUES (?, ?, ?)",
    ).run(id, 1000, 3);
    expect(
      db.prepare("SELECT 1 FROM access_stats WHERE observation_id = ?").get(id),
    ).toBeTruthy();

    db.prepare("DELETE FROM observations WHERE id = ?").run(id);

    expect(
      db.prepare("SELECT 1 FROM access_stats WHERE observation_id = ?").get(id),
    ).toBeUndefined();
  });
});
