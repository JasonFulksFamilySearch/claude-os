import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { checkBrokenLabels, checkCorpusSnapshot, dropDeadLabel, recomputeCorpusSnapshot, type FixResult } from "../src/doctor.js";

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
