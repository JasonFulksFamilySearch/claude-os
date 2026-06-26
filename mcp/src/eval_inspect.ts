// Shared eval-gate INSPECTION helpers: the DB-reading probes the offline eval
// script and the doctor registry both need, lifted here so the two never diverge.
// Kept separate from src/eval.ts (deliberately DB-free pure metrics) so that
// module's no-DB invariant holds. Scope is exactly the helpers doctor needs.
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type { PresenceQuery } from "./scripts/eval.js";

// Baseline reader/writer still LIVE in scripts/eval.ts (eval-runner.test imports them
// from there). Re-export so doctor pulls its whole eval-gate surface from one module.
export { readBaseline, writeBaseline, type Baseline } from "./scripts/eval.js";
export type { PresenceQuery } from "./scripts/eval.js";

// The ONE place the labeled-set key path (presence.queries — the LabeledSetV2 shape)
// is resolved for the doctor readers. Both checkBrokenLabels and dropDeadLabel route
// through this, so the key path is defined once and can never drift per-reader — the
// top-level-.queries false-PASS that shipped in PR #105 is now structurally impossible,
// not merely test-detected. (The eval script reads set.presence.queries off the typed
// LabeledSetV2 directly, since it also needs k/stages from the same parse — TypeScript
// keeps that access drift-safe without this helper.)
export function readPresenceQueries(labelsPath: string): PresenceQuery[] {
  const parsed = JSON.parse(readFileSync(labelsPath, "utf8")) as {
    presence?: { queries?: PresenceQuery[] };
  };
  return parsed.presence?.queries ?? [];
}

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
