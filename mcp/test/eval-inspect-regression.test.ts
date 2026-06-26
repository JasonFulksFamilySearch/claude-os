import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { resolveRelevantIds, distinctSourcePaths, chunkingEnabled } from "../src/eval_inspect.js";
import {
  fileSetHash,
  isCutoverBoundary,
  isFileSetShapeChange,
  presenceVerdict,
  composeVerdict,
  type PresenceMetrics,
} from "../src/eval.js";

let workDir: string;
let db: Database.Database;

function seedObs(database: Database.Database, sourcePath: string, anchor = ""): void {
  database
    .prepare(
      `INSERT INTO observations
         (source_type, source_path, anchor, content, content_hash, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("learning", sourcePath, anchor, "body", "h", 0, 0);
}

// Replicates the eval script's verdict pipeline, sourcing every DB-derived input from
// the extracted module. If the extraction changed any inspector's behavior, the composed
// verdict here would differ from the pinned value.
function composeViaInspectors(
  database: Database.Database,
  labels: string[],
  current: PresenceMetrics,
  baseline: PresenceMetrics,
  baselineChunking: boolean,
  baselineFileSetHash: string,
): string {
  const brokenLabels = resolveRelevantIds(database, labels).length === 0;
  const currentHash = fileSetHash(distinctSourcePaths(database));
  const currentChunking = chunkingEnabled(database);
  const presence = presenceVerdict(current, baseline, brokenLabels);
  const boundary = isCutoverBoundary(baselineChunking, currentChunking);
  const shapeChanged = isFileSetShapeChange(baselineFileSetHash, currentHash, boundary);
  return composeVerdict(presence, [], shapeChanged);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-eval-regress-"));
  db = openDb(join(workDir, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("verdict composition is identical through the extracted inspectors", () => {
  const baseMetrics: PresenceMetrics = { meanRecallAtK: 0.27, mrr: 0.5 };

  it("a single dead label drives INCONCLUSIVE (the 2026-06-22 recovery scenario)", () => {
    seedObs(db, "context/jira.md");
    const hash = fileSetHash(distinctSourcePaths(db));
    expect(
      composeViaInspectors(
        db,
        ["pruned-episode-2026-06-17"],
        { meanRecallAtK: 0.76, mrr: 0.9 },
        baseMetrics,
        false,
        hash,
      ),
    ).toBe("INCONCLUSIVE");
  });

  it("all labels live + non-regressing metrics, no cutover boundary => PASS", () => {
    seedObs(db, "context/jira.md");
    seedObs(db, "context/github.md");
    const hash = fileSetHash(distinctSourcePaths(db));
    expect(
      composeViaInspectors(db, ["jira", "github"], { meanRecallAtK: 0.8, mrr: 0.9 }, baseMetrics, false, hash),
    ).toBe("PASS");
  });

  it("metrics regress => FAIL", () => {
    seedObs(db, "context/jira.md");
    const hash = fileSetHash(distinctSourcePaths(db));
    expect(
      composeViaInspectors(db, ["jira"], { meanRecallAtK: 0.1, mrr: 0.1 }, baseMetrics, false, hash),
    ).toBe("FAIL");
  });

  it("at the cutover boundary, a changed file set escalates an otherwise-PASS to INCONCLUSIVE", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '1')").run();
    seedObs(db, "context/jira.md");
    seedObs(db, "context/new-after-cutover.md");
    expect(
      composeViaInspectors(
        db,
        ["jira"],
        { meanRecallAtK: 0.8, mrr: 0.9 },
        baseMetrics,
        false,
        fileSetHash(["context/jira.md"]),
      ),
    ).toBe("INCONCLUSIVE");
  });

  it("post-cutover (both chunked) off the boundary, file churn does NOT escalate => PASS", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '1')").run();
    seedObs(db, "context/jira.md");
    seedObs(db, "context/added-later.md");
    expect(
      composeViaInspectors(
        db,
        ["jira"],
        { meanRecallAtK: 0.8, mrr: 0.9 },
        baseMetrics,
        true,
        fileSetHash(["context/jira.md"]),
      ),
    ).toBe("PASS");
  });
});
