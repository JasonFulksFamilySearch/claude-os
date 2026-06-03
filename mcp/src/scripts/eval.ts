// Offline retrieval-quality eval — run by hand (`npm run eval [dbPath]`), NOT in CI.
//
// Scores the live ranker against a HELD-OUT labeled set (eval/labeled-queries.json)
// using recall@k and MRR. Runs against a throwaway COPY of the DB so the eval's own
// reinforcement writes never mutate the real store. Weights are fixed defaults
// (search_config.ts) — this set must never be used to tune them (train/test leakage).
//
// Baseline: run this on `main` (pre-change), record Mean recall@k + MRR. The acceptance
// gate is `new >= baseline` on BOTH metrics. See docs/2026-06-03-reinforcement-rerank-prd.md.

import { copyFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb, DEFAULT_DB_PATH } from "../db.js";
import { searchMemory } from "../tools/search_memory.js";
import { recallAtK, reciprocalRank, mean } from "../eval.js";
import { log } from "../logger.js";

interface LabeledQuery {
  query: string;
  expectedPathContains: string[];
}
interface LabeledSet {
  k: number;
  queries: LabeledQuery[];
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = join(SCRIPT_DIR, "..", "..", "eval", "labeled-queries.json");

// Ground-truth relevant ids: every observation whose source_path contains any expected
// substring. Recall is measured over this full set, not just the rows that happened to rank.
function resolveRelevant(db: Database.Database, substrings: string[]): number[] {
  const ids = new Set<number>();
  const stmt = db.prepare("SELECT id FROM observations WHERE source_path LIKE ?");
  for (const s of substrings) {
    for (const row of stmt.all(`%${s}%`) as { id: number }[]) ids.add(row.id);
  }
  return [...ids];
}

async function main(): Promise<void> {
  const srcDb = process.argv[2] ?? DEFAULT_DB_PATH;
  if (!existsSync(srcDb)) {
    console.error(`DB not found: ${srcDb}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(LABELS_PATH)) {
    console.error(`Labeled set not found: ${LABELS_PATH}`);
    process.exitCode = 1;
    return;
  }

  const set = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as LabeledSet;
  const k = set.k ?? 5;

  // Throwaway copy so eval reinforcement never touches the real store.
  const tmp = mkdtempSync(join(tmpdir(), "claude-os-eval-"));
  const copyPath = join(tmp, "eval.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, copyPath + suffix);
  }

  const db = openDb(copyPath);
  try {
    const recalls: number[] = [];
    const rrs: number[] = [];
    console.log(`Offline eval — recall@${k} / MRR over ${set.queries.length} labeled queries`);
    console.log(`DB (copy of): ${srcDb}\n`);
    for (const q of set.queries) {
      const results = await searchMemory(db, { query: q.query, limit: Math.max(k, 10) });
      const rankedIds = results.map((r) => r.id);
      const relevantIds = resolveRelevant(db, q.expectedPathContains);
      const recall = recallAtK(rankedIds, relevantIds, k);
      const rr = reciprocalRank(rankedIds, relevantIds);
      recalls.push(recall);
      rrs.push(rr);
      const flag = relevantIds.length === 0 ? "  [no ground-truth match — fix labels]" : "";
      console.log(`  r@${k}=${recall.toFixed(2)}  rr=${rr.toFixed(2)}  "${q.query}"${flag}`);
    }
    console.log(`\nMean recall@${k}: ${mean(recalls).toFixed(4)}`);
    console.log(`MRR:             ${mean(rrs).toFixed(4)}`);
    console.log(
      "\nWeights are FIXED (search_config.ts) — never tune them against this set.\n" +
        "Gate: capture this on `main` first; require new >= baseline on BOTH metrics.",
    );
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log("error", "eval failed", { error: msg });
  console.error("eval failed:", msg);
  process.exitCode = 1;
});
