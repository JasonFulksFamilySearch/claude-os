import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  resolveRelevantIds,
  distinctSourcePaths,
  chunkingEnabled,
  readBaseline,
} from "../src/eval_inspect.js";

let workDir: string;
let dbPath: string;
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-eval-inspect-"));
  dbPath = join(workDir, "test.db");
  db = openDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("resolveRelevantIds (broken-labels probe)", () => {
  it("returns ids of observations whose source_path contains any substring", () => {
    seedObs(db, "a/learnings.md");
    seedObs(db, "b/jira.md");
    seedObs(db, "c/github.md");
    expect(resolveRelevantIds(db, ["learnings", "github"]).sort((x, y) => x - y)).toEqual([1, 3]);
  });
  it("is empty when no source_path matches (the dead-label signal)", () => {
    seedObs(db, "a/learnings.md");
    expect(resolveRelevantIds(db, ["does-not-exist"])).toEqual([]);
  });
  it("uses case-sensitive literal instr() — no case fold", () => {
    seedObs(db, "a/Learnings.md");
    expect(resolveRelevantIds(db, ["learnings"])).toEqual([]);
  });
  it("dedupes ids when several substrings match the same row", () => {
    seedObs(db, "a/jira-and-github.md");
    expect(resolveRelevantIds(db, ["jira", "github"])).toEqual([1]);
  });
});

describe("distinctSourcePaths (corpus distinct-file query)", () => {
  it("is granularity-invariant: a chunk-split adds rows but not distinct paths", () => {
    seedObs(db, "a/x.md", "h2-one");
    seedObs(db, "a/x.md", "h2-two");
    seedObs(db, "b/y.md");
    expect(distinctSourcePaths(db).sort()).toEqual(["a/x.md", "b/y.md"]);
  });
  it("is empty on an empty corpus", () => {
    expect(distinctSourcePaths(db)).toEqual([]);
  });
});

describe("chunkingEnabled (c2_chunking_enabled marker reader)", () => {
  it("is false when the meta marker is absent", () => {
    expect(chunkingEnabled(db)).toBe(false);
  });
  it("is true only when the marker is exactly '1'", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '1')").run();
    expect(chunkingEnabled(db)).toBe(true);
  });
  it("is false for any non-'1' marker value", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '0')").run();
    expect(chunkingEnabled(db)).toBe(false);
  });
});

describe("re-exported baseline surface", () => {
  it("readBaseline is reachable through eval_inspect and returns null when absent", () => {
    expect(readBaseline(join(workDir, "nope.json"))).toBeNull();
  });
});
