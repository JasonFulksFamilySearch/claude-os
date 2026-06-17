// Offline retrieval-quality eval — run by hand (`npm run eval [dbPath] [--rebaseline]`), NOT in CI.
//
// Scores the live ranker against a HELD-OUT labeled set (~/.claude-data/eval/labeled-queries.json):
// presence (recall@k, MRR) and forgetting-absence (Stage 2; armed in C2). Runs against a
// throwaway COPY of the DB so reinforcement writes never mutate the real store. Weights are
// fixed defaults (search_config.ts) — this set must never tune them (train/test leakage).
//
// Stage 1 (archive exclusion) is enforced by the indexer unit suite (npm test), NOT here.
// Baseline: machine-local ~/.claude-data/eval-baseline.json, captured once on the pre-change
// index. The gate is presence non-regression AND every armed absence stage 100%.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { openDb, DEFAULT_DB_PATH } from "../db.js";
import { searchMemory } from "../tools/search_memory.js";
import {
  fileLevelRecallAtK,
  fileLevelReciprocalRank,
  mean,
  fileSetHash,
  isFileSetShapeChange,
  absenceProbePass,
  aggregateAbsenceStage,
  presenceVerdict,
  composeVerdict,
  isBaselineCapture,
  type ForbiddenTarget,
  type StageResult,
  type PresenceMetrics,
} from "../eval.js";
import { log } from "../logger.js";

interface PresenceQuery {
  query: string;
  expectedPathContains: string[];
}
interface AbsenceQuery {
  query: string;
  forbidden: ForbiddenTarget;
}
interface AbsenceStage {
  armed: boolean;
  depends_on?: string;
  granularity?: string;
  description?: string;
  queries: AbsenceQuery[];
}
interface LabeledSetV2 {
  k: number;
  curation?: { date: string | null; approver: string | null; corpus_snapshot: string | null };
  presence: { queries: PresenceQuery[] };
  stages: Record<string, AbsenceStage>;
}

export interface Baseline {
  captured_at: string;
  captured_on_ref: string;
  // observation_count is human-readable provenance only; the SHAPE signal is file_set_hash
  // (a stable hash of the distinct source_path set). Optional because baselines captured
  // before the D-b fix lack it — the mandatory re-baseline at the version boundary recaptures it.
  corpus: { db_path: string; observation_count: number; file_set_hash?: string };
  presence: { mean_recall_at_k: number; mrr: number; k: number };
  absence: Record<string, { armed: boolean; pass_rate: number | null; n: number }>;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// The labeled set is machine-local DATA (curated per-corpus), so it lives under
// ~/.claude-data/ alongside eval-baseline.json and memory.db — NOT inside the repo.
// update.sh Step 2.6 provisions it from the committed template on a fresh machine.
const LABELS_PATH = join(homedir(), ".claude-data", "eval", "labeled-queries.json");
const BASELINE_PATH = join(homedir(), ".claude-data", "eval-baseline.json");

export function readBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

export function writeBaseline(path: string, baseline: Baseline): void {
  // Ensure the parent dir exists — a custom DB path on a fresh machine may not have ~/.claude-data/.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

function gitRef(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Broken-labels probe (NOT the recall denominator any more — that is file-level now).
// Returns every observation whose source_path contains any expected substring; the runner
// only checks whether this is empty, which means the labels match nothing in the corpus.
function resolveRelevant(db: Database.Database, substrings: string[]): number[] {
  const ids = new Set<number>();
  const stmt = db.prepare("SELECT id FROM observations WHERE source_path LIKE ?");
  for (const s of substrings) {
    for (const row of stmt.all(`%${s}%`) as { id: number }[]) ids.add(row.id);
  }
  return [...ids];
}

// The corpus's distinct file set, used to compute the shape-guard hash. Granularity-invariant:
// a chunk-split adds rows but not distinct source_paths.
function distinctSourcePaths(db: Database.Database): string[] {
  return (db.prepare("SELECT DISTINCT source_path FROM observations").all() as {
    source_path: string;
  }[]).map((r) => r.source_path);
}

// Whether the index is at the post-chunk-split cutover boundary, where the file-set guard
// runs. Reads the same meta.c2_chunking_enabled marker the indexer's chunking chokepoint
// uses — here purely to discriminate the boundary, never to drive chunking. Default '0' (off)
// when the meta row is absent (a routine whole-file corpus).
function atCutoverBoundary(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'c2_chunking_enabled'").get() as
    | { value: string }
    | undefined;
  return row?.value === "1";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rebaseline = args.includes("--rebaseline");
  const srcDb = args.find((a) => !a.startsWith("--")) ?? DEFAULT_DB_PATH;

  if (!existsSync(srcDb)) {
    console.error(`DB not found: ${srcDb}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(LABELS_PATH)) {
    console.error(
      `Labeled set not found: ${LABELS_PATH}\n` +
        `Run ~/.claude-os/update.sh to provision it from the template, then curate it.`,
    );
    process.exitCode = 1;
    return;
  }

  const set = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as LabeledSetV2;
  const k = set.k ?? 5;

  // Throwaway copy so eval reinforcement never touches the real store.
  const tmp = mkdtempSync(join(tmpdir(), "claude-os-eval-"));
  const copyPath = join(tmp, "eval.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, copyPath + suffix);
  }

  const db = openDb(copyPath);
  try {
    // --- Presence ---
    const recalls: number[] = [];
    const rrs: number[] = [];
    let brokenLabels = false;
    console.log(`Offline eval — recall@${k} / MRR over ${set.presence.queries.length} presence queries`);
    console.log(`DB (copy of): ${srcDb}\n`);
    for (const q of set.presence.queries) {
      const results = await searchMemory(db, { query: q.query, limit: Math.max(k, 10) });
      // File-level (granularity-aware) scoring: resolve each ranked result to its source_path
      // and score recall/MRR over EXPECTED FILES, so a chunked index scores the same as a
      // whole-file one for identical retrieval quality.
      const rankedPaths = results.map((r) => r.source_path);
      const recall = fileLevelRecallAtK(rankedPaths, q.expectedPathContains, k);
      const rr = fileLevelReciprocalRank(rankedPaths, q.expectedPathContains);
      recalls.push(recall);
      rrs.push(rr);
      // resolveRelevant survives only as the broken-labels probe: labels that match no
      // observation row at all drive presence INCONCLUSIVE (fix labels, not the ranker).
      const labelsMatchNothing = resolveRelevant(db, q.expectedPathContains).length === 0;
      if (labelsMatchNothing) brokenLabels = true;
      const flag = labelsMatchNothing ? "  [no ground-truth match — fix labels]" : "";
      console.log(`  r@${k}=${recall.toFixed(2)}  rr=${rr.toFixed(2)}  "${q.query}"${flag}`);
    }
    const metrics: PresenceMetrics = { meanRecallAtK: mean(recalls), mrr: mean(rrs) };
    console.log(`\nMean recall@${k}: ${metrics.meanRecallAtK.toFixed(4)}`);
    console.log(`MRR:             ${metrics.mrr.toFixed(4)}`);

    // --- Absence stages (Stage 2; SKIPPED while unarmed at C1) ---
    const stageResults: Record<string, StageResult> = {};
    console.log("");
    // The probe loop is dormant at C1 (every stage is armed:false → SKIPPED); it is
    // the scaffolding C2 arms by flipping armed:true and adding anchor resolution.
    for (const [name, stage] of Object.entries(set.stages)) {
      const probePasses: boolean[] = [];
      if (stage.armed) {
        for (const aq of stage.queries) {
          const results = await searchMemory(db, { query: aq.query, limit: Math.max(k, 10) });
          const topPaths = results.slice(0, k).map((r) => r.source_path);
          probePasses.push(absenceProbePass(topPaths, aq.forbidden));
        }
      }
      const res = aggregateAbsenceStage(stage.armed, probePasses);
      stageResults[name] = res;
      const detail =
        res.status === "SKIPPED"
          ? "SKIPPED (armed:false)"
          : res.status === "INCONCLUSIVE"
            ? "INCONCLUSIVE (armed, n=0)"
            : `${res.status} (${res.passes}/${res.n})`;
      console.log(`  ${name}: ${detail}`);
    }
    console.log("  (Stage 1 — archive exclusion — is enforced by the indexer unit suite: npm test)");

    // --- Baseline: capture or compose ---
    const obsCount = (db.prepare("SELECT COUNT(*) AS c FROM observations").get() as { c: number }).c;
    // Corpus-shape signal: the distinct file set (hash) and whether we are at the cutover
    // boundary where the file-set guard runs.
    const filePaths = distinctSourcePaths(db);
    const currentFileSetHash = fileSetHash(filePaths);
    const boundary = atCutoverBoundary(db);
    const existing = readBaseline(BASELINE_PATH);
    if (isBaselineCapture(existing !== null, rebaseline)) {
      const baseline: Baseline = {
        captured_at: new Date().toISOString(),
        captured_on_ref: gitRef(),
        corpus: { db_path: srcDb, observation_count: obsCount, file_set_hash: currentFileSetHash },
        presence: { mean_recall_at_k: metrics.meanRecallAtK, mrr: metrics.mrr, k },
        absence: Object.fromEntries(
          Object.entries(stageResults).map(([n, r]) => [
            n,
            { armed: r.status !== "SKIPPED", pass_rate: r.n > 0 ? r.passes / r.n : null, n: r.n },
          ]),
        ),
      };
      writeBaseline(BASELINE_PATH, baseline);
      // Every terminal branch emits a VERDICT: line so the output parses uniformly
      // (the memory-merger closing step reads it). Capture renders no pass/fail.
      console.log(`\nVERDICT: BASELINE CAPTURED (recorded → ${BASELINE_PATH}; no pass/fail this run)`);
    } else {
      const base = existing as Baseline;
      if (k !== base.presence.k) {
        // recall@k across different k is not comparable — INCONCLUSIVE rather than a
        // misleading PASS/FAIL. Re-baseline to compose a verdict against the new k.
        console.log(
          `\nVERDICT: INCONCLUSIVE (baseline stale — captured at k=${base.presence.k}, current k=${k}; re-baseline with --rebaseline)`,
        );
        process.exitCode = 1;
      } else {
        const presence = presenceVerdict(
          metrics,
          { meanRecallAtK: base.presence.mean_recall_at_k, mrr: base.presence.mrr },
          brokenLabels,
        );
        // Corpus-shape guard (WARN W2): only at the cutover boundary, a change to the file set
        // escalates to INCONCLUSIVE. A chunk-count jump (same files) does not trip it; off the
        // boundary the guard does not run, so routine file churn never nags.
        const shapeChanged = isFileSetShapeChange(
          base.corpus.file_set_hash,
          currentFileSetHash,
          boundary,
        );
        const verdict = composeVerdict(presence, Object.values(stageResults), shapeChanged);
        console.log(`\nPresence: ${presence}  (baseline r@${k}=${base.presence.mean_recall_at_k.toFixed(4)} mrr=${base.presence.mrr.toFixed(4)})`);
        // Echo the cause on the verdict line — this gate runs unattended at memory-merger
        // close, where a bare INCONCLUSIVE costs an investigation round-trip. The reason
        // attaches only to an INCONCLUSIVE verdict; a shape change at the cutover boundary
        // takes precedence in the message over broken labels (a dominating FAIL needs no note —
        // the Presence line above already names the regression).
        const reason =
          verdict === "INCONCLUSIVE" && shapeChanged
            ? ` (cutover changed the file set — current ${filePaths.length} distinct files, file-set hash differs from baseline; investigate before composing a verdict)`
            : verdict === "INCONCLUSIVE" && presence === "INCONCLUSIVE"
              ? " (presence labels broken — see the [fix labels] flags above)"
              : "";
        console.log(`VERDICT: ${verdict}${reason}`);
        if (verdict === "FAIL" || verdict === "INCONCLUSIVE") process.exitCode = 1;
      }
    }

    console.log(
      "\nWeights are FIXED (search_config.ts) — never tune them against this set.\n" +
        "Labeled set is HELD-OUT. Re-baseline only via --rebaseline.",
    );
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Only run when invoked directly as a script (npm run eval), never on import (tests).
// pathToFileURL resolves a relative argv[1] against cwd (it does not throw); npm runs
// from the package root and tsx sets argv[1] to this file, so the comparison holds.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log("error", "eval failed", { error: msg });
    console.error("eval failed:", msg);
    process.exitCode = 1;
  });
}
