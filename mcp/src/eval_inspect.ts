// Shared eval-gate INSPECTION helpers: the DB-reading probes the offline eval
// script and the doctor registry both need, lifted here so the two never diverge.
// Kept separate from src/eval.ts (deliberately DB-free pure metrics) so that
// module's no-DB invariant holds. Scope is exactly the helpers doctor needs.
import type Database from "better-sqlite3";

// Baseline reader/writer still LIVE in scripts/eval.ts (eval-runner.test imports them
// from there). Re-export so doctor pulls its whole eval-gate surface from one module.
export { readBaseline, writeBaseline, type Baseline } from "./scripts/eval.js";

// Broken-labels probe. Returns every observation whose source_path contains any
// expected substring; the caller checks whether this is empty (labels match nothing).
// Uses instr() (case-sensitive, literal substring) — same semantics as the file-level
// scorer's String.includes — so a label can never pass this probe yet be unhittable.
export function resolveRelevantIds(db: Database.Database, substrings: string[]): number[] {
  const ids = new Set<number>();
  const stmt = db.prepare("SELECT id FROM observations WHERE instr(source_path, ?) > 0");
  for (const s of substrings) {
    for (const row of stmt.all(s) as { id: number }[]) ids.add(row.id);
  }
  return [...ids];
}

// The corpus's distinct file set. Granularity-invariant: a chunk-split adds rows but
// not distinct source_paths.
export function distinctSourcePaths(db: Database.Database): string[] {
  return (db.prepare("SELECT DISTINCT source_path FROM observations").all() as {
    source_path: string;
  }[]).map((r) => r.source_path);
}

// Whether chunking is enabled on this index (meta.c2_chunking_enabled). Default '0'
// (off) when the meta row is absent (a routine whole-file corpus).
export function chunkingEnabled(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'c2_chunking_enabled'").get() as
    | { value: string }
    | undefined;
  return row?.value === "1";
}
