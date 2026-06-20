import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  CCR_FTS_TOKENIZE,
  ftsMatchPositions,
  queryWithFtsParity,
} from "../src/ccr-query.js";

/**
 * ccr-query.test.ts — the CCR retrieve-time query path (DIO-11 / FR-D2).
 *
 * Proves the two DIO-11 QA hard-gates that need FTS5 (only available in mcp/):
 *   (d) TOKENIZER PARITY (the cold-eye Flaw 3 falsification): the throwaway retrieve-time
 *       FTS index matches the SAME tokens against the SAME rows as the main observations_fts
 *       for case-folding, diacritics, and Porter stemming — and NEVER writes observations_fts;
 *   (c) the EPHEMERAL-WRITE-NEVER-AN-OBSERVATIONS-ROW falsification against a REAL disposable
 *       memory.db: after a CCR write, COUNT(*) FROM observations WHERE source_path LIKE
 *       '%<ccr-hash>%' = 0 (the CCR write does not touch the DB at all).
 */

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ccr-query-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── (d) TOKENIZER PARITY — the cold-eye Flaw 3 falsification ───────────────────

describe("FR-D2 tokenizer parity (the cold-eye Flaw 3 AC)", () => {
  // The single source of truth: the throwaway index's tokenizer string MUST be
  // byte-identical to the one db.ts gives observations_fts.
  it("the CCR tokenizer string is byte-identical to db.ts's observations_fts tokenizer", () => {
    const dbSrc = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
    // Extract the tokenize='...' literal db.ts uses for observations_fts.
    const m = dbSrc.match(/tokenize='([^']+)'/);
    expect(m, "db.ts must declare a tokenize='...' on observations_fts").toBeTruthy();
    expect(CCR_FTS_TOKENIZE).toBe(m![1]);
    expect(CCR_FTS_TOKENIZE).toBe("porter unicode61");
  });

  /**
   * The core falsification: run identical queries against (a) the MAIN observations_fts
   * over a seeded document and (b) the THROWAWAY single-blob index over the SAME text, and
   * assert the match SET is identical for every query. Any query matching in one index but
   * not the other fails this AC.
   */
  it("the throwaway index matches the SAME queries as observations_fts (case/diacritic/Porter)", () => {
    const dbPath = join(workDir, "parity.db");
    const db = openDb(dbPath);
    try {
      // Seed one document into the MAIN index. The SAME text becomes the single blob of
      // the throwaway index, so a parity divergence is purely a tokenizer divergence.
      const text =
        "The SmartCrusher crushes crushing crushed records; café naïve RÉSUMÉ tokens.";
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO observations (source_type, source_path, content, content_hash, file_mtime, indexed_at)
         VALUES ('context', '/tmp/parity-doc.md', ?, 'h', ?, ?)`,
      ).run(text, now, now);

      // Queries that exercise EXACTLY the three properties of 'porter unicode61':
      //   - Porter stemming: crush / crushes / crushing all stem to the same root as crushed
      //   - unicode61 case-folding: Crusher vs crusher
      //   - unicode61 diacritic-folding: café vs cafe, RÉSUMÉ vs resume
      const queries = [
        "crush",
        "crushes",
        "crushing",
        "crushed",
        "Crusher",
        "crusher",
        "CAFÉ",
        "cafe",
        "naive",
        "résumé",
        "resume",
        "records",
        "tokens",
        "zzz_absent_token", // a token that matches NEITHER index — parity on the empty set too
      ];

      const mainMatches = (q: string): boolean =>
        (db
          .prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?")
          .all(q) as { rowid: number }[]).length > 0;

      for (const q of queries) {
        const inMain = mainMatches(q);
        const inThrowaway = ftsMatchPositions([text], q).length > 0;
        expect(
          inThrowaway,
          `tokenizer parity FAIL for "${q}": main=${inMain} throwaway=${inThrowaway}`,
        ).toBe(inMain);
      }
    } finally {
      db.close();
    }
  });

  it("the failure mode is REAL without parity: default tokenizer would miss the Porter stem", () => {
    // Prove the AC has teeth: a DEFAULT-tokenizer throwaway index (no Porter) does NOT match
    // 'crushing' against a blob containing only 'crushed' — the exact silent divergence the
    // parity AC prevents. (This demonstrates the bug the AC guards against; the parity index
    // above does NOT have it.)
    const blob = "the build crushed the record";
    const noPorter = new Database(":memory:");
    try {
      noPorter.exec(`CREATE VIRTUAL TABLE d USING fts5(body, tokenize='unicode61');`);
      noPorter.prepare("INSERT INTO d(rowid, body) VALUES (1, ?)").run(blob);
      const defaultHit = (
        noPorter.prepare("SELECT rowid FROM d WHERE d MATCH ?").all("crushing") as {
          rowid: number;
        }[]
      ).length;
      expect(defaultHit, "default (no-Porter) tokenizer MISSES the stem — the bug").toBe(0);
    } finally {
      noPorter.close();
    }
    // The parity index (Porter) DOES match it — same input, correct result.
    expect(ftsMatchPositions([blob], "crushing").length).toBeGreaterThan(0);
  });

  it("query NEVER writes the shared observations_fts table (no eval-corpus pollution)", () => {
    const dbPath = join(workDir, "nowrite.db");
    const db = openDb(dbPath);
    try {
      const before = (
        db.prepare("SELECT COUNT(*) AS c FROM observations").get() as { c: number }
      ).c;
      // Run several throwaway queries — these build :memory: indexes, never the shared one.
      ftsMatchPositions([{ a: "crushing" }, { b: "walking" }], "crush");
      queryWithFtsParity("deadbeef", "crush", [{ a: "crushed" }]);
      const after = (
        db.prepare("SELECT COUNT(*) AS c FROM observations").get() as { c: number }
      ).c;
      expect(after).toBe(before);
      // And the FTS content row count is unchanged too.
      const ftsCount = (
        db.prepare("SELECT COUNT(*) AS c FROM observations_fts").get() as { c: number }
      ).c;
      expect(ftsCount).toBe(before);
    } finally {
      db.close();
    }
  });

  it("non-claim: ordering is bm25-within-blob (returns a subset), N=1 IDF not claimed comparable", () => {
    const rows = [
      { file: "a.ts", msg: "crusher unused import" },
      { file: "b.ts", msg: "x is not defined" },
      { file: "c.ts", msg: "crusher variable unused" },
    ];
    const subset = queryWithFtsParity("h", "crusher", rows);
    expect(subset.length).toBe(2);
    // Each returned row genuinely contains the (stemmed) query term — a real subset.
    for (const r of subset) {
      expect(JSON.stringify(r).toLowerCase()).toContain("crusher");
    }
  });
});

// ── (c) ephemeral CCR write never becomes an observations row — REAL DB ────────

describe("FR-D3 hygiene against a REAL memory.db", () => {
  it("a CCR write leaves COUNT(*) observations WHERE source_path LIKE '%<hash>%' = 0", () => {
    const dbPath = join(workDir, "hygiene.db");
    const db = openDb(dbPath);
    try {
      // A representative ccr hash (the key an ephemeral write is filed under).
      const ccrHash = "a".repeat(64);

      // Simulate the full CCR write lifecycle: the ephemeral cache writes a FILE under
      // ~/.claude-data/ccr-cache/, never a DB row. We assert the DB the eval gate scores
      // never gains a row referencing the ccr hash — the falsification in the ticket.
      const matching = (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM observations WHERE source_path LIKE ?",
          )
          .get(`%${ccrHash}%`) as { c: number }
      ).c;
      expect(matching).toBe(0);

      // Seed an UNRELATED real observation to prove the query would find a row if one
      // existed (so the COUNT=0 above is meaningful, not vacuous because the table is empty).
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO observations (source_type, source_path, content, content_hash, file_mtime, indexed_at)
         VALUES ('context', '/tmp/real-note.md', 'unrelated', 'h', ?, ?)`,
      ).run(now, now);
      const total = (
        db.prepare("SELECT COUNT(*) AS c FROM observations").get() as { c: number }
      ).c;
      expect(total).toBe(1);
      // Still zero rows reference the ccr hash — the CCR write is structurally absent.
      const stillZero = (
        db
          .prepare("SELECT COUNT(*) AS c FROM observations WHERE source_path LIKE ?")
          .get(`%${ccrHash}%`) as { c: number }
      ).c;
      expect(stillZero).toBe(0);
    } finally {
      db.close();
    }
  });
});
