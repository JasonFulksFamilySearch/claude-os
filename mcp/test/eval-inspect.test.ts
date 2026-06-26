import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  resolveRelevantIds,
  distinctSourcePaths,
  chunkingEnabled,
  readBaseline,
  readPresenceQueries,
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

describe("readPresenceQueries (single labeled-set key-path accessor)", () => {
  // The conformance guard: the original PR #105 false-PASS happened because readers
  // hardcoded top-level `.queries` while the canonical schema nests under
  // `presence.queries`. This accessor is now the ONE place that path is resolved; these
  // tests pin it against the COMMITTED template (the in-repo, stable schema source — the
  // live labeled set is machine-local/gitignored) so a regression back to `.queries`
  // fails CI instead of silently false-PASSing on a real install.
  const templatePath = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "eval",
    "labeled-queries.template.json",
  );

  it("resolves presence.queries to a non-empty, correctly-shaped array against the real template", () => {
    const queries = readPresenceQueries(templatePath);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(typeof q.query).toBe("string");
      expect(Array.isArray(q.expectedPathContains)).toBe(true);
    }
  });

  it("returns [] for a top-level `queries` shape — proving it reads presence.queries, not .queries", () => {
    // This is the exact bug shape: a file with queries at the TOP level. The canonical
    // accessor must NOT find them there (it would have to read `presence.queries`), so a
    // reader that regressed to `.queries` would diverge from this accessor and be caught.
    const wrongShape = join(workDir, "wrong-shape.json");
    writeFileSync(wrongShape, JSON.stringify({ queries: [{ query: "x", expectedPathContains: ["x"] }] }));
    expect(readPresenceQueries(wrongShape)).toEqual([]);
  });

  it("returns [] when presence is absent entirely (no throw)", () => {
    const empty = join(workDir, "empty.json");
    writeFileSync(empty, JSON.stringify({ k: 5 }));
    expect(readPresenceQueries(empty)).toEqual([]);
  });

  it("returns [] when presence is present but queries is absent (a real empty set)", () => {
    const noQueries = join(workDir, "no-queries.json");
    writeFileSync(noQueries, JSON.stringify({ presence: { k: 5 } }));
    expect(readPresenceQueries(noQueries)).toEqual([]);
  });

  it("returns the array for a valid presence.queries shape", () => {
    const valid = join(workDir, "valid.json");
    const queries = [{ query: "x", expectedPathContains: ["x"] }];
    writeFileSync(valid, JSON.stringify({ presence: { queries } }));
    expect(readPresenceQueries(valid)).toEqual(queries);
  });

  it("THROWS when presence.queries is present but not an array (corruption ≠ empty)", () => {
    // The absent-vs-corrupt distinction: a non-array queries is schema corruption, not an
    // empty set. Coercing it to [] would let a corrupt labels file false-PASS broken-labels;
    // throwing makes safeCheck resolve checkBrokenLabels to INCONCLUSIVE instead.
    for (const corrupt of [
      { presence: { queries: "not-an-array" } },
      { presence: { queries: { query: "x" } } },
      { presence: { queries: 42 } },
    ]) {
      const path = join(workDir, "corrupt.json");
      writeFileSync(path, JSON.stringify(corrupt));
      expect(() => readPresenceQueries(path)).toThrow(/not an array.*corrupt/);
    }
  });
});
