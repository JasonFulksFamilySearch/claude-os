import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { openDb } from "../src/db.js";
import { checkBaselineStale, checkBrokenLabels, checkOrphanEmbeddings, checkSchemaCurrent, checkStaleLock, clearStaleLock, dropDeadLabel, recaptureBaseline, reembedMissing, runMigrateFix, type FixResult } from "../src/doctor.js";
import { isV3Schema, runMigrations, verifyBackup } from "../src/migrations.js";
import { main as migrateMain } from "../src/scripts/migrate.js";
import { countMissingVectors } from "../src/indexer.js";

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

// ---------------------------------------------------------------------------
// Task 12: reembedMissing
// ---------------------------------------------------------------------------

describe("doctor.fixes — reembedMissing", () => {
  let dir: string;
  let db: import("better-sqlite3").Database;
  let dbPath: string;

  // Seed a v3 observation row with NO vec_items entry — an orphan.
  function seedOrphan(d: import("better-sqlite3").Database, path: string) {
    d.prepare(`INSERT INTO observations
      (source_type, source_path, anchor, parent_title, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
      VALUES ('context', ?, '', NULL, NULL, NULL, 'T', 'body', ?, 1, 2, NULL)`)
      .run(path, "h" + path);
    // Intentionally do NOT insert a vec_items row — this is the orphan state.
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-reembed-"));
    dbPath = join(dir, "memory.db");
    db = openDb(dbPath);
    seedOrphan(db, "/orphan.md");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Before-fix: checkOrphanEmbeddings reports FAIL with remediation "re-embed"
  // -------------------------------------------------------------------------

  it("before fix: checkOrphanEmbeddings reports FAIL with remediation re-embed", async () => {
    const res = await checkOrphanEmbeddings({ db } as any);
    expect(res.status).toBe("FAIL");
    expect(res.fixable).toBe(true);
    expect(res.remediation?.id).toBe("re-embed");
    // There is at least 1 orphan.
    expect(countMissingVectors(db)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Backup-first + verify: snapshot written and verifyBackup passes BEFORE sweep
  // -------------------------------------------------------------------------

  it("backup-first: backupDb writes a snapshot and verifyBackup passes with the live observation count", async () => {
    const backupPath = join(dir, "memory.db.bak");
    const liveCount = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;

    // Run the fix — embedder is mocked so the sweep resolves a zero-vector.
    await reembedMissing({ db, dbPath, backupPath });

    // The backup file must exist and pass verifyBackup with the pre-sweep count.
    // verifyBackup throws on failure; no throw = backup is valid and count-consistent.
    expect(() => verifyBackup(backupPath, liveCount)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Apply: after fix, countMissingVectors === 0 and checkOrphanEmbeddings PASS
  // -------------------------------------------------------------------------

  it("apply: after reembedMissing, countMissingVectors is 0 and checkOrphanEmbeddings reports PASS", async () => {
    const backupPath = join(dir, "memory.db.bak");

    const res: FixResult = await reembedMissing({ db, dbPath, backupPath });

    expect(res.applied).toBe(true);
    expect(res.backupPath).toBe(backupPath);

    // All orphans healed.
    expect(countMissingVectors(db)).toBe(0);

    // Check reports PASS.
    const check = await checkOrphanEmbeddings({ db } as any);
    expect(check.status).toBe("PASS");
  });

  // -------------------------------------------------------------------------
  // Abort-on-bad-backup: verifyBackup throws → vectorCoverageSweep never runs
  // -------------------------------------------------------------------------

  it("abort-on-bad-backup: if verifyBackup would fail (wrong expectedCount), the orphans remain unhealed", async () => {
    // Strategy: write a real backup, then pass the wrong expectedCount to verifyBackup
    // by forcing it to mismatch. We do this by writing a zero-byte file at the backup path
    // so verifyBackup's size-floor check (< 4096 bytes) throws before any sweep.
    const backupPath = join(dir, "memory.db.bad.bak");
    // Write a 0-byte file — verifyBackup will throw "below 4096-byte floor".
    writeFileSync(backupPath, "");

    // Patch backupDb in this test: instead of VACUUM INTO (which would write a valid backup),
    // we seed the bad file ourselves and override by closing + reopening — but the simplest
    // approach is: call reembedMissing with a backupPath that already exists as a corrupt file.
    // backupDb does `VACUUM INTO`; VACUUM INTO throws if the destination file already exists in
    // some SQLite builds, or overwrites it. In practice, better-sqlite3 / SQLite will overwrite
    // with the real DB. So instead, we test the abort by directly verifying that verifyBackup
    // with a deliberately wrong count throws, and that countMissingVectors(db) still > 0 after.
    //
    // The load-bearing test: we spy on vectorCoverageSweep via a wrapping pattern — the
    // simplest production-code-faithful approach is to use a bad backupPath that causes
    // verifyBackup to throw. We achieve this by temporarily making the backup file a corrupt
    // stub AFTER backupDb runs but before verifyBackup checks. Since we cannot intercept mid-
    // function in a unit test without mocking the whole module, we instead construct the scenario
    // by verifying that verifyBackup with a mismatched expectedCount throws, which IS the abort
    // path — and assert the orphans remain in db (unchanged).
    //
    // Direct: call reembedMissing with an impossible expectedCount via module-level spy.
    // The cleanest safe approach: mock verifyBackup to throw for this test only.
    const { verifyBackup: vb } = await import("../src/migrations.js");
    const spy = vi.spyOn(await import("../src/migrations.js"), "verifyBackup")
      .mockImplementationOnce(() => { throw new Error("simulated: backup count mismatch"); });

    await expect(reembedMissing({ db, dbPath, backupPath: join(dir, "memory.db.abort.bak") }))
      .rejects.toThrow("simulated: backup count mismatch");

    // Orphans must still be present — vectorCoverageSweep did not run.
    expect(countMissingVectors(db)).toBeGreaterThan(0);

    spy.mockRestore();
    // Suppress unused variable lint — vb is imported for its side effect (module load).
    void vb;
  });

  // -------------------------------------------------------------------------
  // Idempotency: re-run with 0 orphans → sweep early-returns; check still PASS
  // -------------------------------------------------------------------------

  it("idempotency: re-run when 0 orphans exist keeps checkOrphanEmbeddings at PASS", async () => {
    const backupPath1 = join(dir, "memory.db.bak1");
    const backupPath2 = join(dir, "memory.db.bak2");

    // First run — heals the orphan.
    await reembedMissing({ db, dbPath, backupPath: backupPath1 });
    expect(countMissingVectors(db)).toBe(0);

    // Second run — 0 orphans; vectorCoverageSweep early-returns {before:0,healed:0,after:0}.
    // Use a distinct backupPath because VACUUM INTO refuses to overwrite an existing file.
    const res2: FixResult = await reembedMissing({ db, dbPath, backupPath: backupPath2 });
    expect(res2.applied).toBe(true);
    expect(countMissingVectors(db)).toBe(0);

    const check = await checkOrphanEmbeddings({ db } as any);
    expect(check.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Task 13: clearStaleLock
// ---------------------------------------------------------------------------
import { mkdirSync as mkdirSyncLock, utimesSync, copyFileSync as copyFileSyncFs } from "node:fs";
import { HEARTBEAT_REFRESH_MS, STALENESS_MULTIPLE } from "../src/election.js";

describe("doctor.fixes — clearStaleLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-clear-lock-"));
    lockPath = join(dir, "memory.db.writer.lock.d");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Helper: create a lock dir whose mtime is `ageMs` milliseconds before `now`.
  function makeStaleLock(now: number, ageMs: number): void {
    mkdirSyncLock(lockPath);
    const mtimeSec = (now - ageMs) / 1000;
    utimesSync(lockPath, mtimeSec, mtimeSec);
  }

  // Helper: touch the lock dir to `freshMs` relative to `now` (makes it non-stale).
  function touchFresh(now: number): void {
    const mtimeSec = now / 1000;
    utimesSync(lockPath, mtimeSec, mtimeSec);
  }

  // -------------------------------------------------------------------------
  // Stale → cleared: diagnose FAIL, fix removes dir, check reports PASS after
  // -------------------------------------------------------------------------

  it("stale lock: checkStaleLock FAIL then clearStaleLock removes the dir and check reports PASS", async () => {
    const now = 200 * HEARTBEAT_REFRESH_MS;
    // Age is slightly more than the staleness threshold so isStale returns true.
    const ageMs = STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 5_000;
    makeStaleLock(now, ageMs);

    // Before fix: check reports FAIL with remediation clear-stale-lock.
    const before = await checkStaleLock({ lockPath, now } as any);
    expect(before.status).toBe("FAIL");
    expect(before.remediation?.id).toBe("clear-stale-lock");

    // Apply the fix.
    const res: FixResult = clearStaleLock({ lockPath, now });
    expect(res.applied).toBe(true);

    // Lock dir must be gone.
    expect(existsSync(lockPath)).toBe(false);

    // After fix: check reports PASS (no lock dir).
    const after = await checkStaleLock({ lockPath, now } as any);
    expect(after.status).toBe("PASS");
  });

  // -------------------------------------------------------------------------
  // APPLY-TIME REFUSAL (load-bearing): stale at diagnose, re-heartbeated
  // before apply — clearStaleLock MUST refuse and leave the dir intact.
  // -------------------------------------------------------------------------

  it("apply-time refusal: lock re-heartbeated between diagnose and apply — refused, dir survives", async () => {
    const now = 200 * HEARTBEAT_REFRESH_MS;
    const ageMs = STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 5_000;
    makeStaleLock(now, ageMs);

    // Verify it IS stale at diagnose time.
    const diagnoseResult = await checkStaleLock({ lockPath, now } as any);
    expect(diagnoseResult.status).toBe("FAIL");

    // Simulate a live writer re-heartbeating between diagnose and apply:
    // touch the lock dir to `now` so isStale(lockPath, now) returns false.
    touchFresh(now);

    // clearStaleLock must re-call isStale at apply time and refuse.
    const res: FixResult = clearStaleLock({ lockPath, now });
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/no longer stale/i);

    // The lock dir must still exist — clearStaleLock did not remove it.
    expect(existsSync(lockPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // No-lock idempotency: absent lockPath → applied:false, no throw
  // -------------------------------------------------------------------------

  it("no-lock idempotency: absent lockPath returns applied:false and does not throw", () => {
    // lockPath was never created.
    expect(existsSync(lockPath)).toBe(false);

    const res: FixResult = clearStaleLock({ lockPath, now: Date.now() });
    expect(res.applied).toBe(false);

    // No throw, no side effects.
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 14: recaptureBaseline — code-enforced fresh-PASS gate
// ---------------------------------------------------------------------------
import { writeBaseline } from "../src/eval_inspect.js";
import type { Baseline } from "../src/eval_inspect.js";

describe("doctor.fixes — recaptureBaseline", () => {
  let dir: string;
  let db: import("better-sqlite3").Database;
  let dbPath: string;
  let baselinePath: string;

  // Writes a minimal but structurally valid baseline at the given path.
  function seedBaseline(path: string, chunked: boolean): void {
    const b: Baseline = {
      captured_at: "2025-01-01T00:00:00.000Z",
      captured_on_ref: "old-ref",
      corpus: { db_path: "/old/path", observation_count: 10, chunking_enabled: chunked },
      presence: { mean_recall_at_k: 0.5, mrr: 0.5, k: 5 },
      absence: {},
    };
    writeBaseline(path, b);
  }

  // Sets the meta.c2_chunking_enabled flag on the DB to make chunkingEnabled() return the value.
  function setChunkingEnabled(d: import("better-sqlite3").Database, enabled: boolean): void {
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('c2_chunking_enabled', ?)")
      .run(enabled ? "1" : "0");
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-recapture-"));
    dbPath = join(dir, "memory.db");
    db = openDb(dbPath);
    baselinePath = join(dir, "eval-baseline.json");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // REFUSAL (highest-priority): non-PASS eval — baseline file untouched
  // -------------------------------------------------------------------------

  it("refuses when runEval returns verdict INCONCLUSIVE — baseline file is NOT written", async () => {
    // No baseline file exists yet.
    expect(existsSync(baselinePath)).toBe(false);

    const res: FixResult = await recaptureBaseline({
      db,
      baselinePath,
      runEval: () => Promise.resolve({ verdict: "INCONCLUSIVE", ok: true }),
    });

    // Refused.
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/refusing to recapture/);
    expect(res.detail).toMatch(/gate is in code/);

    // Baseline file must NOT have been created — the guard fired before any write.
    expect(existsSync(baselinePath)).toBe(false);
  });

  it("refuses when runEval returns verdict FAIL — baseline file is NOT written", async () => {
    expect(existsSync(baselinePath)).toBe(false);

    const res: FixResult = await recaptureBaseline({
      db,
      baselinePath,
      runEval: () => Promise.resolve({ verdict: "FAIL", ok: true }),
    });

    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/refusing to recapture/);
    expect(existsSync(baselinePath)).toBe(false);
  });

  it("refuses when runEval returns ok:false — baseline file is NOT written", async () => {
    expect(existsSync(baselinePath)).toBe(false);

    const res: FixResult = await recaptureBaseline({
      db,
      baselinePath,
      runEval: () => Promise.resolve({ verdict: "PASS", ok: false, reason: "subprocess error" }),
    });

    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/refusing to recapture/);
    expect(existsSync(baselinePath)).toBe(false);
  });

  it("refuses on non-PASS with a pre-existing baseline — pre-existing file bytes are UNCHANGED", async () => {
    // Seed a prior baseline so we can verify it survives unchanged.
    seedBaseline(baselinePath, false);
    const preImage = readFileSync(baselinePath, "utf8");

    const res: FixResult = await recaptureBaseline({
      db,
      baselinePath,
      runEval: () => Promise.resolve({ verdict: "INCONCLUSIVE", ok: true }),
    });

    expect(res.applied).toBe(false);
    // File is untouched — same bytes as the pre-image.
    expect(readFileSync(baselinePath, "utf8")).toBe(preImage);
    // And no .bak was created (the guard fired before any write).
    expect(existsSync(baselinePath + ".bak")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // BACKUP-BEFORE-OVERWRITE + SUCCESS
  // -------------------------------------------------------------------------

  it("on PASS with a prior baseline: backs up pre-image BEFORE write, new baseline records live chunking_enabled, applied:true", async () => {
    // Seed a prior baseline (unchunked) and capture its bytes.
    seedBaseline(baselinePath, false);
    const preImage = readFileSync(baselinePath, "utf8");

    // Set the live DB to chunked so we can verify the new baseline picks it up.
    setChunkingEnabled(db, true);

    const res: FixResult = await recaptureBaseline({
      db,
      baselinePath,
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });

    // Applied.
    expect(res.applied).toBe(true);
    expect(res.verdictAfter).toBe("PASS");
    expect(res.backupPath).toBe(baselinePath + ".bak");

    // .bak must contain the pre-image (old baseline).
    expect(existsSync(baselinePath + ".bak")).toBe(true);
    expect(readFileSync(baselinePath + ".bak", "utf8")).toBe(preImage);

    // New baseline must record chunking_enabled matching the live index (true).
    const newBaseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
    expect(newBaseline.corpus.chunking_enabled).toBe(true);
  });

  it("on PASS with no prior baseline: no backup path, new baseline written, applied:true", async () => {
    expect(existsSync(baselinePath)).toBe(false);
    setChunkingEnabled(db, false);

    const res: FixResult = await recaptureBaseline({
      db,
      baselinePath,
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });

    expect(res.applied).toBe(true);
    expect(res.verdictAfter).toBe("PASS");
    // No backup when there was no prior baseline.
    expect(res.backupPath).toBeUndefined();
    expect(existsSync(baselinePath + ".bak")).toBe(false);

    // Baseline file was created.
    expect(existsSync(baselinePath)).toBe(true);
    const written = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
    expect(written.corpus.chunking_enabled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // checkBaselineStale reports PASS after recapture (idempotency)
  // -------------------------------------------------------------------------

  it("after successful recapture, checkBaselineStale reports PASS (idempotency)", async () => {
    // Set the DB to chunked. Seed a baseline that says unchunked → stale.
    setChunkingEnabled(db, true);
    seedBaseline(baselinePath, false);

    // Before fix: stale — isCutoverBoundary(false, true) is true.
    const before = await checkBaselineStale({ db, baselinePath } as any);
    expect(before.status).toBe("FAIL");

    // Apply the fix.
    const res: FixResult = await recaptureBaseline({
      db,
      baselinePath,
      runEval: () => Promise.resolve({ verdict: "PASS", ok: true }),
    });
    expect(res.applied).toBe(true);

    // Now the baseline records chunking_enabled:true; live index is also chunked → PASS.
    const after = await checkBaselineStale({ db, baselinePath } as any);
    expect(after.status).toBe("PASS");
  });
});
