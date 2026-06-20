/**
 * ccr-query.ts — the CCR retrieve-time query path (DIO-11 / FR-D2).
 *
 * The `query` half of `retrieve(hash, query)`: given a resolved original (a JSON array
 * of records served from one of the three CCR stores), narrow it to the rows relevant
 * to a query. This file owns the part of FR-D2 that needs SQLite/FTS5 — which lives ONLY
 * in mcp/ (better-sqlite3 is an mcp dependency; the hook runtime has no SQLite). The
 * reactive retrieve contract and the three-store resolution live in hooks/lib/ccr-retrieve.js;
 * this is the `queryFn` it injects where SQLite is available.
 *
 * ── THE HARD HYGIENE RULES (FR-D2) ────────────────────────────────────────────
 *
 * 1. THROWAWAY, SINGLE-BLOB index. The query builds a brand-new in-memory FTS5 index
 *    over JUST the resolved blob's rows, runs the query, and discards it. It NEVER writes
 *    into the shared `observations_fts` table — doing so would reintroduce eval-corpus
 *    pollution through the query path after the storage path was closed (FR-D3). The index
 *    is `:memory:`, so it cannot touch `memory.db` at all.
 *
 * 2. TOKENIZER PARITY (the cold-eye Flaw 3 AC — BLOCKS DIO-11). The throwaway index MUST
 *    be created with a tokenizer configuration BYTE-IDENTICAL to the main index's
 *    `tokenize='porter unicode61'` (db.ts:66). We export that exact string as the single
 *    source of truth (`CCR_FTS_TOKENIZE`) and the parity test asserts it equals db.ts's.
 *    Failure mode prevented: building the throwaway index with FTS5's DEFAULT tokenizer
 *    (no Porter stemming) → `retrieve(hash, "crushing")` silently fails to match a blob
 *    containing "crushed" while `search_memory` (which stems) matches it — same input,
 *    divergent results, no error.
 *
 * ── EXPLICIT NON-CLAIM (FR-D2) ────────────────────────────────────────────────
 * This asserts TOKENIZER / MATCH parity — the SAME tokens hit the SAME rows — NOT BM25
 * score-magnitude equivalence. The throwaway index has N=1..few documents, so its IDF
 * term is degenerate and its absolute bm25() scores are corpus-size-dependent and NOT
 * comparable to the full-corpus index by construction. Ordering the returned subset by
 * bm25() WITHIN the single blob is self-consistent and acceptable; cross-index score
 * equivalence is neither required nor achievable.
 */

import Database from "better-sqlite3";

/**
 * The FTS5 tokenizer configuration. This MUST stay byte-identical to db.ts's
 * `observations_fts` tokenizer (`tokenize='porter unicode61'`, db.ts:66). It is exported
 * so the parity test can assert equality against the value db.ts uses — a single source
 * of truth, so a future edit to one without the other is caught, not silently divergent.
 */
export const CCR_FTS_TOKENIZE = "porter unicode61";

/**
 * Flatten a record into the text an FTS index sees. Mirrors what the main index would
 * tokenize for a row: all string-ish values concatenated. Deterministic (key-sorted) so
 * the same row always produces the same indexed text.
 */
function rowToText(row: unknown): string {
  if (row == null) return "";
  if (typeof row === "string") return row;
  if (typeof row !== "object") return String(row);
  // Sorted keys → stable text; include both keys and string/number values so a query
  // can match field names or values, as the main index does over `content`.
  const parts: string[] = [];
  const obj = row as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v == null) continue;
    if (typeof v === "object") {
      parts.push(key, JSON.stringify(v));
    } else {
      parts.push(key, String(v));
    }
  }
  return parts.join(" ");
}

/**
 * Build a THROWAWAY in-memory FTS5 index over `rows` using the parity tokenizer, run
 * `query` as a MATCH, and return the row positions that hit, ordered by bm25() within the
 * single blob. The index is created fresh and discarded on `db.close()` — it never
 * touches `memory.db` or `observations_fts`.
 *
 * Returns the ORIGINAL-array positions (0-based) of matching rows, so the caller can map
 * back to the resolved original. Ordering is bm25() within the throwaway index — self-
 * consistent for ranking the subset, NOT comparable to the corpus index (the non-claim).
 */
export function ftsMatchPositions(rows: unknown[], query: string): number[] {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE VIRTUAL TABLE blob_fts USING fts5(
        body,
        tokenize='${CCR_FTS_TOKENIZE}'
      );
    `);
    const insert = db.prepare("INSERT INTO blob_fts(rowid, body) VALUES (?, ?)");
    const insertMany = db.transaction((items: string[]) => {
      // rowid is 1-based; map back to 0-based array position on read.
      items.forEach((text, i) => insert.run(i + 1, text));
    });
    insertMany(rows.map(rowToText));

    let hits: { rowid: number }[];
    try {
      hits = db
        .prepare(
          "SELECT rowid FROM blob_fts WHERE blob_fts MATCH ? ORDER BY bm25(blob_fts)",
        )
        .all(query) as { rowid: number }[];
    } catch {
      // Malformed FTS query (e.g. unbalanced quotes) → no rows, never throw into the
      // retrieve path. Mirrors search_memory's tolerant catch (search_memory.ts:132).
      hits = [];
    }
    return hits.map((h) => h.rowid - 1);
  } finally {
    db.close();
  }
}

/**
 * The FR-D2 `queryFn` the hook's `createRetrieve` injects when SQLite is available: given
 * the resolved original (a JSON array) and a query, return the relevant SUBSET — the rows
 * that match, in bm25-within-blob order, preserving each row's full content. This is the
 * tokenizer-parity path (Porter stemming + unicode61 folding identical to the main index).
 *
 * Non-array originals: a single record is treated as a one-row blob; a match returns it,
 * a miss returns []. Empty query returns the whole original (no narrowing requested).
 */
export function queryWithFtsParity(
  _hash: string,
  query: string,
  original: unknown,
): unknown[] {
  const rows: unknown[] = Array.isArray(original) ? original : [original];
  if (!query) return rows;
  const positions = ftsMatchPositions(rows, query);
  return positions.map((p) => rows[p]);
}
