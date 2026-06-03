import type Database from "better-sqlite3";
import { embedDocument, serializeVector } from "./embedder.js";

export interface ReembedSummary {
  /** Number of vectors removed from the prior index (0 if it was empty). */
  cleared: number;
  /** Number of observations embedded and inserted. */
  reembedded: number;
  durationMs: number;
}

/**
 * Re-embed every observation and atomically swap the vector index.
 *
 * Phase A (async, zero DB writes): embed all observations into memory. An interruption
 * here — Ctrl-C, OOM, a throw — leaves the existing index fully intact.
 *
 * Phase B (synchronous, atomic): in a single transaction, clear vec_items and insert the
 * new vectors. If any insert throws, the whole DELETE+INSERT rolls back to the prior index,
 * so there is no half-rebuilt terminal state. Lossless (vec_items is derived from
 * observations) and idempotent — re-running after reverting the embedding dtype performs rollback.
 */
export async function reembedAll(db: Database.Database): Promise<ReembedSummary> {
  const start = Date.now();

  const rows = db
    .prepare("SELECT id, content FROM observations ORDER BY id")
    .all() as { id: number; content: string }[];

  const vectors: { id: number; bytes: Buffer }[] = [];
  for (const row of rows) {
    vectors.push({ id: row.id, bytes: serializeVector(await embedDocument(row.content)) });
  }

  // sqlite-vec vec0 primary keys must be bound as BigInt — better-sqlite3 binds plain
  // JS numbers as SQLITE_FLOAT, which vec0 rejects ("Only integers are allowed").
  const swap = db.transaction((vecs: { id: number; bytes: Buffer }[]): number => {
    const cleared = db.prepare("DELETE FROM vec_items").run().changes;
    const insert = db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?, ?)");
    for (const v of vecs) insert.run(BigInt(v.id), v.bytes);
    return cleared;
  });
  const cleared = swap(vectors);

  return { cleared, reembedded: vectors.length, durationMs: Date.now() - start };
}
