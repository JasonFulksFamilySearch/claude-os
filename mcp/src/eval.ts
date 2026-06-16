// Pure retrieval-quality metrics for the offline eval harness (see src/scripts/eval.ts).
// Kept dependency-free so the metrics are unit-testable without a DB or model.

// Fraction of the relevant items that appear within the top-k ranked results.
// Returns 0 (not NaN) when there are no relevant items.
export function recallAtK(rankedIds: number[], relevantIds: number[], k: number): number {
  if (relevantIds.length === 0) return 0;
  const topK = new Set(rankedIds.slice(0, k));
  const found = relevantIds.filter((id) => topK.has(id)).length;
  return found / relevantIds.length;
}

// Reciprocal of the 1-based rank of the first relevant hit; 0 if none is relevant.
export function reciprocalRank(rankedIds: number[], relevantIds: number[]): number {
  const relevant = new Set(relevantIds);
  for (let i = 0; i < rankedIds.length; i++) {
    if (relevant.has(rankedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

// Arithmetic mean; 0 (not NaN) for an empty list. Mean recall@k / mean reciprocal rank
// (MRR) over the labeled query set are the gate metrics.
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// --- Forgetting-absence + verdict logic (Stage 2 + composed gate) ---
// Pure and dependency-free, like the metrics above, so the gate's decision rules
// are unit-testable without a DB. Stage 1 (archive exclusion) is NOT here — it is
// enforced by the indexer unit suite; see mcp/test/indexer.test.ts.

export interface ForbiddenTarget {
  sourcePathContains: string;
  entryDate?: string;
  noveltyStatus?: string;
}

export type StageStatus = "SKIPPED" | "INCONCLUSIVE" | "PASS" | "FAIL";
export type PresenceStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "CAPTURING";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "CAPTURING";

export interface StageResult {
  status: StageStatus;
  n: number; // armed probes evaluated
  passes: number; // of those, how many passed
}

export interface PresenceMetrics {
  meanRecallAtK: number;
  mrr: number;
}

// An absence probe passes when NO ranked top-k source_path matches the forbidden
// target. At C1 this is path-substring based; C2 adds entry-anchor resolution.
export function absenceProbePass(
  topKSourcePaths: string[],
  forbidden: ForbiddenTarget,
): boolean {
  return !topKSourcePaths.some((p) => p.includes(forbidden.sourcePathContains));
}

// Aggregate one absence stage. armed:false => SKIPPED (cannot touch the verdict).
// armed + zero probes => INCONCLUSIVE (a gate that cannot fail must not pass silently).
// armed + probes => PASS iff all pass, else FAIL.
export function aggregateAbsenceStage(armed: boolean, probePasses: boolean[]): StageResult {
  if (!armed) return { status: "SKIPPED", n: 0, passes: 0 };
  const n = probePasses.length;
  if (n === 0) return { status: "INCONCLUSIVE", n: 0, passes: 0 };
  const passes = probePasses.filter(Boolean).length;
  return { status: passes === n ? "PASS" : "FAIL", n, passes };
}

// Presence verdict vs a recorded baseline: non-regression on BOTH metrics.
// baseline null => CAPTURING (first run records the baseline; no verdict).
// brokenLabels => INCONCLUSIVE (a query resolved zero relevant ids — fix labels).
export function presenceVerdict(
  current: PresenceMetrics,
  baseline: PresenceMetrics | null,
  brokenLabels: boolean,
): PresenceStatus {
  if (baseline === null) return "CAPTURING";
  if (brokenLabels) return "INCONCLUSIVE";
  const nonRegressing =
    current.meanRecallAtK >= baseline.meanRecallAtK && current.mrr >= baseline.mrr;
  return nonRegressing ? "PASS" : "FAIL";
}

// Compose the gate verdict from presence + absence stages.
// Precedence: CAPTURING > FAIL > INCONCLUSIVE > PASS. SKIPPED stages are excluded.
export function composeVerdict(presence: PresenceStatus, stages: StageResult[]): Verdict {
  if (presence === "CAPTURING") return "CAPTURING";
  const armed = stages.filter((s) => s.status !== "SKIPPED");
  const statuses: (PresenceStatus | StageStatus)[] = [presence, ...armed.map((s) => s.status)];
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

// Whether this run captures a baseline (vs composes a verdict).
export function isBaselineCapture(baselineExists: boolean, rebaseline: boolean): boolean {
  return rebaseline || !baselineExists;
}
