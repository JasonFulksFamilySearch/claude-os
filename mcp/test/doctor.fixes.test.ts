import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { openDb } from "../src/db.js";
import { checkBrokenLabels, checkCorpusSnapshot, checkSchemaCurrent, dropDeadLabel, recomputeCorpusSnapshot, runMigrateFix, type FixResult } from "../src/doctor.js";
import { isV3Schema, runMigrations } from "../src/migrations.js";
import { main as migrateMain } from "../src/scripts/migrate.js";

// Mock the embedder so these tests never load @huggingface/transformers.
vi.mock("../src/embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedder.js")>();
  return {
    ...actual,
    embedDocument: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
    embedQuery: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
  };
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function seedRow(db: import("better-sqlite3").Database, sourcePath: string) {
  db.prepare(`INSERT INTO observations
    (source_type, source_path, anchor, parent_title, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
    VALUES ('context', ?, '', NULL, NULL, NULL, 'T', 'body', ?, 1, 2, NULL)`)
    .run(sourcePath, "h" + sourcePath);
}

// The labels file contains one dead label (matches nothing) and one live label (matches /a.md).
function writeLabels(labelsPath: string) {
  writeFileSync(labelsPath, JSON.stringify({
    queries: [
      { query: "find a", expectedPathContains: ["/a.md"] },
      { query: "the pruned episode", expectedPathContains: ["episodes/2026-05-01"] },
    ],
  }));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("doctor.fixes — dropDeadLabel", () => {
  let dir: string;
  let db: import("better-sqlite3").Database;
  let dbPath: string;
  let labelsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-fixes-"));
    dbPath = join(dir, "memory.db");
    db = openDb(dbPath);
    labelsPath = join(dir, "labeled-queries.json");

    // Seed one real row for "/a.md" so "find a" resolves; "the pruned episode" resolves to 0 rows.
    seedRow(db, "/a.md");
    writeLabels(labelsPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Before-fix: checkBrokenLabels should report INCONCLUSIVE + fixable
  // -------------------------------------------------------------------------

  it("before fix: broken-labels reports INCONCLUSIVE fixable", async () => {
    const res = await checkBrokenLabels({ db, labelsPath } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.fixable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Backup-first + apply
  // -------------------------------------------------------------------------

  it("backs up labels, drops only the dead label, re-runs eval, returns verdictAfter", async () => {
    const preImage = readFileSync(labelsPath, "utf8");

    const res: FixResult = await dropDeadLabel({
      db,
      labelsPath,
      deadQuery: "the pruned episode",
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });

    // Backup exists and matches the pre-image.
    expect(existsSync(labelsPath + ".bak")).toBe(true);
    expect(readFileSync(labelsPath + ".bak", "utf8")).toBe(preImage);

    // Applied successfully.
    expect(res.applied).toBe(true);
    expect(res.backupPath).toBe(labelsPath + ".bak");
    expect(res.verdictAfter).toBe("PASS");

    // Dead label gone; live label preserved.
    const after = JSON.parse(readFileSync(labelsPath, "utf8"));
    expect(after.queries.find((q: any) => q.query === "the pruned episode")).toBeUndefined();
    expect(after.queries.find((q: any) => q.query === "find a")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Refuse-live: the held-out doctrine — never drop a label that resolves rows
  // -------------------------------------------------------------------------

  it("refuses to drop a label that is actually live (resolves >=1 row)", async () => {
    const preImage = readFileSync(labelsPath, "utf8");

    const res: FixResult = await dropDeadLabel({
      db,
      labelsPath,
      deadQuery: "find a",   // live — /a.md is seeded in observations
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });

    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/not dead/i);

    // File must be unchanged.
    expect(readFileSync(labelsPath, "utf8")).toBe(preImage);
  });

  // -------------------------------------------------------------------------
  // Idempotency: second call for an already-absent query returns applied:false
  // -------------------------------------------------------------------------

  it("is idempotent — second call for the already-dropped query returns applied:false", async () => {
    // First call — succeeds.
    const first = await dropDeadLabel({
      db,
      labelsPath,
      deadQuery: "the pruned episode",
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });
    expect(first.applied).toBe(true);

    const afterFirst = readFileSync(labelsPath, "utf8");

    // Second call — label is already gone.
    const second = await dropDeadLabel({
      db,
      labelsPath,
      deadQuery: "the pruned episode",
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });
    expect(second.applied).toBe(false);

    // File unchanged after second call.
    expect(readFileSync(labelsPath, "utf8")).toBe(afterFirst);
  });

  // -------------------------------------------------------------------------
  // After-fix: checkBrokenLabels should report PASS
  // -------------------------------------------------------------------------

  it("after dropping the dead label, checkBrokenLabels reports PASS", async () => {
    await dropDeadLabel({
      db,
      labelsPath,
      deadQuery: "the pruned episode",
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });

    const res = await checkBrokenLabels({ db, labelsPath } as any);
    expect(res.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Task 10: recomputeCorpusSnapshot
// ---------------------------------------------------------------------------

describe("doctor.fixes — recomputeCorpusSnapshot", () => {
  let dir: string;
  let db: import("better-sqlite3").Database;
  let dbPath: string;
  let labelsPath: string;

  // Fixture: 3 distinct source paths in the DB; labels file has stale corpus_snapshot = 387.
  function writeSnapshotLabels(path: string, snapshot: number) {
    writeFileSync(path, JSON.stringify({
      curation: { corpus_snapshot: snapshot },
      queries: [],
    }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-corpus-snap-"));
    dbPath = join(dir, "memory.db");
    db = openDb(dbPath);
    labelsPath = join(dir, "labeled-queries.json");

    // Seed 3 distinct source paths so the live count is 3.
    seedRow(db, "/file-a.md");
    seedRow(db, "/file-b.md");
    seedRow(db, "/file-c.md");

    writeSnapshotLabels(labelsPath, 387);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Before-fix: checkCorpusSnapshot should report FAIL naming both numbers
  // -------------------------------------------------------------------------

  it("before fix: corpus-snapshot reports FAIL naming both the stale and live count", async () => {
    const res = await checkCorpusSnapshot({ db, labelsPath } as any);
    expect(res.status).toBe("FAIL");
    expect(res.fixable).toBe(true);
    expect(res.detail).toMatch(/387/);
    expect(res.detail).toMatch(/3/);
  });

  // -------------------------------------------------------------------------
  // Backup-first: .bak exists and equals the pre-image
  // -------------------------------------------------------------------------

  it("backs up labels to <labelsPath>.bak before overwriting corpus_snapshot", () => {
    const preImage = readFileSync(labelsPath, "utf8");

    recomputeCorpusSnapshot({ db, labelsPath });

    expect(existsSync(labelsPath + ".bak")).toBe(true);
    expect(readFileSync(labelsPath + ".bak", "utf8")).toBe(preImage);
  });

  // -------------------------------------------------------------------------
  // Apply: written value equals the live count, checkCorpusSnapshot → PASS
  // -------------------------------------------------------------------------

  it("writes the live distinct-file count and checkCorpusSnapshot reports PASS after", async () => {
    const res: FixResult = recomputeCorpusSnapshot({ db, labelsPath });

    expect(res.applied).toBe(true);
    expect(res.backupPath).toBe(labelsPath + ".bak");

    // The written file now carries the live count (3), not the stale 387.
    const after = JSON.parse(readFileSync(labelsPath, "utf8"));
    expect(after.curation.corpus_snapshot).toBe(3);

    // checkCorpusSnapshot now reports PASS.
    const check = await checkCorpusSnapshot({ db, labelsPath } as any);
    expect(check.status).toBe("PASS");
  });

  // -------------------------------------------------------------------------
  // Idempotency: re-run leaves it PASS
  // -------------------------------------------------------------------------

  it("is idempotent — re-run leaves corpus_snapshot correct and checkCorpusSnapshot PASS", async () => {
    recomputeCorpusSnapshot({ db, labelsPath });
    // Second run — snapshot already equals live count.
    recomputeCorpusSnapshot({ db, labelsPath });

    const after = JSON.parse(readFileSync(labelsPath, "utf8"));
    expect(after.curation.corpus_snapshot).toBe(3);

    const check = await checkCorpusSnapshot({ db, labelsPath } as any);
    expect(check.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Task 11: runMigrateFix
// ---------------------------------------------------------------------------

/**
 * Build a faithful pre-C2 (v2) database — same shape as the helper in
 * migrations.test.ts — opened raw (NOT through openDb, which fail-fasts on v2).
 */
function makeV2Fixture(dbPath: string): Database.Database {
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
  `);

  raw.prepare(`
    INSERT INTO observations
      (id, source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
    VALUES (1, 'learning', '/a/learnings.md', 'proj', 'java', 'First', 'the migrate fixture content', 'h1', 100, 200, null)
  `).run();

  return raw;
}

describe("doctor.fixes — runMigrateFix", () => {
  let dir: string;
  let dbPath: string;
  let v2: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-migrate-fix-"));
    dbPath = join(dir, "memory.db");
    v2 = makeV2Fixture(dbPath);
  });

  afterEach(() => {
    try { v2.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Before: checkSchemaCurrent reports FAIL with remediation "run-migrate"
  // -------------------------------------------------------------------------

  it("before fix: checkSchemaCurrent reports FAIL with remediation id run-migrate", async () => {
    const res = await checkSchemaCurrent({ db: v2 } as any);
    expect(res.status).toBe("FAIL");
    expect(res.fixable).toBe(true);
    expect(res.remediation?.id).toBe("run-migrate");
    expect(isV3Schema(v2)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Apply: migrateRunner actually migrates → isV3Schema true, checkSchemaCurrent PASS
  // -------------------------------------------------------------------------

  it("applies migration via injected runner — isV3Schema becomes true and checkSchemaCurrent reports PASS", async () => {
    // Inject a runner that calls runMigrations directly on the fixture DB.
    const res: FixResult = await runMigrateFix({
      db: v2,
      migrateRunner: async () => {
        try {
          runMigrations(v2);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    expect(res.applied).toBe(true);
    expect(isV3Schema(v2)).toBe(true);

    const check = await checkSchemaCurrent({ db: v2 } as any);
    expect(check.status).toBe("PASS");
  });

  // -------------------------------------------------------------------------
  // Apply (real migrate path): migrateMain as runner → .pre-c2.bak produced
  // -------------------------------------------------------------------------

  it("real migrate path: migrateMain runner produces a .pre-c2.bak and migrates to v3", async () => {
    const backupPath = dbPath + ".pre-c2.bak";

    // Close the raw handle — migrateMain opens its own handle against the file.
    v2.close();

    const res: FixResult = await runMigrateFix({
      db: v2, // db arg not used in the runner body (migrateMain uses the path)
      migrateRunner: async () => {
        try {
          migrateMain(dbPath, backupPath);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    expect(res.applied).toBe(true);

    // Migrate's own backup must be present.
    expect(existsSync(backupPath)).toBe(true);

    // Reopen to verify v3 — migrateMain closes the handle it opened.
    const upgraded = new Database(dbPath);
    sqliteVec.load(upgraded);
    try {
      expect(isV3Schema(upgraded)).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  // -------------------------------------------------------------------------
  // Failure surfaced: migrateRunner returns ok:false → applied:false, reason in detail
  // -------------------------------------------------------------------------

  it("failure surfaced: migrateRunner returning ok:false yields applied:false with reason in detail", async () => {
    const res: FixResult = await runMigrateFix({
      db: v2,
      migrateRunner: async () => ({ ok: false, reason: "boom" }),
    });

    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/migrate failed/i);
    expect(res.detail).toMatch(/boom/);

    // DB is still v2 — the fix did not throw, just reported the failure.
    expect(isV3Schema(v2)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // No double-backup: runMigrateFix never calls backupDb itself
  // (structural: the function body must not reference backupDb — verified in code;
  // this test confirms re-running on an already-v3 DB stays PASS via migrate's own no-op)
  // -------------------------------------------------------------------------

  it("idempotency: after migration, re-run with a no-op runner leaves checkSchemaCurrent PASS", async () => {
    // First run — migrate the fixture.
    await runMigrateFix({
      db: v2,
      migrateRunner: async () => {
        runMigrations(v2);
        return { ok: true };
      },
    });
    expect(isV3Schema(v2)).toBe(true);

    // Second run — migrate's "already v3, exit 0" path via runMigrations (no-op).
    const res2: FixResult = await runMigrateFix({
      db: v2,
      migrateRunner: async () => {
        runMigrations(v2); // idempotent — returns {migrated:false}, no mutation
        return { ok: true };
      },
    });
    expect(res2.applied).toBe(true);

    // DB stays v3; checkSchemaCurrent stays PASS.
    expect(isV3Schema(v2)).toBe(true);
    const check = await checkSchemaCurrent({ db: v2 } as any);
    expect(check.status).toBe("PASS");
  });
});
