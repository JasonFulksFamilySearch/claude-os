import type Database from "better-sqlite3";

export type CheckStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "ADVISORY";
export type DoctorVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface Remediation { id: string; description: string; command?: string; }
export interface CheckResult { id: string; status: CheckStatus; detail: string; fixable: boolean; remediation?: Remediation; }

// Injected subprocess seams — real implementations live in the Phase 3 thin runner.
export interface EvalResult { verdict: "PASS" | "FAIL" | "INCONCLUSIVE" | "CAPTURING"; ok: boolean; reason?: string; }
export type EvalRunner = () => Promise<EvalResult>;
export interface AuditResult { ok: boolean; vulnerabilities?: { critical: number; high: number; moderate: number; low: number }; devOnly?: boolean; reason?: string; }
export type AuditRunner = () => Promise<AuditResult>;
export interface SubprocessResult { ok: boolean; passed: boolean; reason?: string; }
export type SubprocessRunner = () => Promise<SubprocessResult>;

export interface DoctorContext {
  db: Database.Database;       // raw-opened (Task 4 of Phase 3) so pre-C2 DBs are diagnosable
  dbPath: string;
  baselinePath: string;       // ~/.claude-data/eval-baseline.json
  labelsPath: string;         // ~/.claude-data/eval/labeled-queries.json
  lockPath: string;           // ~/.claude-data/memory.db.writer.lock.d
  repoRoot: string;           // for context-templates/
  full: boolean;              // --full flag arms tsc/test
  now?: number;               // injectable clock for lock staleness
  runEval: EvalRunner;
  runAudit: AuditRunner;
  runBuild: SubprocessRunner;
  runTest: SubprocessRunner;
}
export type Check = (ctx: DoctorContext) => CheckResult | Promise<CheckResult>;

// FAIL > INCONCLUSIVE > PASS; ADVISORY excluded (mirrors eval.ts composeVerdict's SKIPPED filter).
export function composeVerdict(results: CheckResult[]): DoctorVerdict {
  const scored = results.filter((r) => r.status !== "ADVISORY");
  if (scored.some((r) => r.status === "FAIL")) return "FAIL";
  if (scored.some((r) => r.status === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

// The honesty invariant in one place: any throw becomes INCONCLUSIVE, never absent/PASS.
export async function safeCheck(
  id: string,
  fn: () => CheckResult | Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { id, status: "INCONCLUSIVE", detail: `could not run: ${reason}`, fixable: false };
  }
}

// ---------------------------------------------------------------------------
// Task 4: eval-gate checks
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { readBaseline, resolveRelevantIds, distinctSourcePaths, chunkingEnabled } from "./eval_inspect.js";
import { isCutoverBoundary } from "./eval.js";

export function checkBaselinePresent(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/baseline-present", () => {
    if (readBaseline(ctx.baselinePath) === null) return {
      id: "eval/baseline-present", status: "INCONCLUSIVE", fixable: true,
      detail: "no eval baseline — the regression gate is not armed; capture one.",
      remediation: { id: "capture-baseline", description: "capture an eval baseline on the current index", command: "npm run eval" },
    };
    return { id: "eval/baseline-present", status: "PASS", detail: "eval baseline present.", fixable: false };
  });
}

export function checkBaselineStale(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/baseline-stale", () => {
    const baseline = readBaseline(ctx.baselinePath) as any;
    if (baseline === null) return { id: "eval/baseline-stale", status: "INCONCLUSIVE", detail: "no baseline to compare.", fixable: false };
    if (isCutoverBoundary(!!baseline.corpus?.chunking_enabled, chunkingEnabled(ctx.db))) return {
      id: "eval/baseline-stale", status: "FAIL", fixable: true,
      detail: "baseline predates the cutover; re-baseline on the chunked index after a PASS.",
      remediation: { id: "recapture-baseline", description: "recapture the baseline on the chunked index (gated on a fresh PASS)" },
    };
    return { id: "eval/baseline-stale", status: "PASS", detail: "baseline chunking state matches the live index.", fixable: false };
  });
}

export function checkCorpusSnapshot(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/corpus-snapshot", () => {
    const snapshot = JSON.parse(readFileSync(ctx.labelsPath, "utf8"))?.curation?.corpus_snapshot;
    const live = distinctSourcePaths(ctx.db).length; // doctor recomputes; never trusts the snapshot
    if (typeof snapshot === "number" && snapshot !== live) return {
      id: "eval/corpus-snapshot", status: "FAIL", fixable: true,
      detail: `labeled-set corpus_snapshot is ${snapshot} but the live corpus has ${live} distinct files.`,
      remediation: { id: "recompute-corpus-snapshot", description: `recompute corpus_snapshot to ${live}` },
    };
    return { id: "eval/corpus-snapshot", status: "PASS", detail: `corpus_snapshot matches the live count (${live}).`, fixable: false };
  });
}

export function checkBrokenLabels(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/broken-labels", () => {
    const queries: { query: string; expectedPathContains: string[] }[] =
      JSON.parse(readFileSync(ctx.labelsPath, "utf8")).queries ?? [];
    const dead = queries
      .map((q) => ({ q, ids: resolveRelevantIds(ctx.db, q.expectedPathContains) }))
      .filter((x) => x.ids.length === 0);
    if (dead.length > 0) {
      const { q } = dead[0];
      return {
        id: "eval/broken-labels", status: "INCONCLUSIVE", fixable: true,
        detail: `label "${q.query}" matches 0 observation rows (dead path ${q.expectedPathContains.join(", ")}) — fix the labels, not the ranker.`,
        remediation: { id: "drop-dead-label", description: `drop or re-point the dead label "${q.query}", then re-run eval` },
      };
    }
    return { id: "eval/broken-labels", status: "PASS", detail: "every held-out label resolves to >=1 row.", fixable: false };
  });
}

export function checkLastVerdict(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/last-verdict", async () => {
    const rr = await ctx.runEval(); // throw => safeCheck => INCONCLUSIVE
    if (!rr.ok) return { id: "eval/last-verdict", status: "INCONCLUSIVE", detail: `eval could not compose a verdict: ${rr.reason ?? "unknown"}.`, fixable: false };
    if (rr.verdict === "CAPTURING") return { id: "eval/last-verdict", status: "INCONCLUSIVE", detail: "eval returned CAPTURING — no baseline yet, the gate is not armed (capture one).", fixable: false };
    return { id: "eval/last-verdict", status: rr.verdict, detail: `eval composed ${rr.verdict}.`, fixable: false };
  });
}
