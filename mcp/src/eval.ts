// Pure retrieval-quality metrics for the offline eval harness (see src/scripts/eval.ts).
// Kept dependency-free (no DB, no model) so the metrics are unit-testable in isolation.

import { createHash } from "node:crypto";

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

// --- File-level (granularity-aware) metrics — the core D-b fix ---
//
// recallAtK/reciprocalRank above score over observation-ROW ids, so a chunk-split (one
// file → N anchored rows) inflates the denominator and mechanically suppresses recall even
// when retrieval is unchanged. The presence path scores at FILE granularity instead: a
// query is a "hit" for an expected file if ANY of its chunks surfaces in top-k, and the
// denominator is the count of EXPECTED FILES — identical at whole-file and chunked
// granularities by construction. An expected file is identified by literal, case-sensitive
// substring containment of its label in a result's source_path (String.includes — the same
// semantics as absenceProbePass; note this is stricter than the broken-labels probe's SQL
// LIKE, which is case-insensitive and treats %/_ as wildcards).

// File-level recall@k: of the query's expected-file substrings, the fraction for which at
// least one of the top-k ranked results' source_path contains that substring. 0 (not NaN)
// when there are no expected files.
export function fileLevelRecallAtK(
  rankedSourcePaths: string[],
  expectedSubstrings: string[],
  k: number,
): number {
  if (expectedSubstrings.length === 0) return 0;
  const topK = rankedSourcePaths.slice(0, k);
  const hits = expectedSubstrings.filter((sub) => topK.some((p) => p.includes(sub))).length;
  return hits / expectedSubstrings.length;
}

// File-level reciprocal rank: reciprocal of the 1-based rank of the first ranked result
// whose source_path matches ANY expected substring; 0 if none. Computed over the full ranked
// order in result order (not k-truncated), mirroring reciprocalRank.
export function fileLevelReciprocalRank(
  rankedSourcePaths: string[],
  expectedSubstrings: string[],
): number {
  for (let i = 0; i < rankedSourcePaths.length; i++) {
    if (expectedSubstrings.some((sub) => rankedSourcePaths[i].includes(sub))) return 1 / (i + 1);
  }
  return 0;
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

// --- File-set corpus-shape guard (WARN W2) ---
//
// The shape signal is the corpus's distinct FILE SET, not its observation-row count. A
// chunk-split multiplies rows but leaves the file set identical, so a file-set guard
// composes a real verdict at the cutover instead of forcing a permanent post-cutover
// INCONCLUSIVE the way a row-count guard would. Only a file genuinely added or removed
// moves the hash.

// Stable hash of a corpus's distinct file set: dedupe, sort, join, sha256. Order- and
// duplicate-invariant, so chunk multiplicity (many rows per path) does not change it. Stored
// in the baseline so the full set need not be persisted.
export function fileSetHash(sourcePaths: string[]): string {
  const distinctSorted = [...new Set(sourcePaths)].sort();
  return createHash("sha256").update(distinctSorted.join("\n")).digest("hex");
}

// Whether this run is at the cutover boundary: the chunking marker flipped ON since the
// baseline was captured (whole-file baseline → chunked current). The boundary is a one-time
// TRANSITION, not the steady marker state — the chunking flag stays on permanently after a
// cutover, so keying on "flag === on" would re-run the guard on every subsequent run and nag
// on routine memory-merger churn. Once the operator re-baselines on the chunked index, both
// sides read chunking-on and this returns false, retiring the guard (Locked Decision #2,
// Story 6).
export function isCutoverBoundary(baselineChunking: boolean, currentChunking: boolean): boolean {
  return currentChunking && !baselineChunking;
}

// Shape-guard decision (pure). The guard runs ONLY at the cutover boundary
// (atCutoverBoundary — see isCutoverBoundary); off the boundary — a routine memory-merger
// close — file churn is expected and the guard does not run. At the boundary, any change to
// the file set (hashes differ) is a shape change. A baseline that predates this field
// (undefined hash) cannot be compared, so it is NOT a shape change — the mandatory re-baseline
// at the version boundary recaptures it.
export function isFileSetShapeChange(
  baselineHash: string | null | undefined,
  currentHash: string,
  atCutoverBoundary: boolean,
): boolean {
  if (!atCutoverBoundary) return false;
  if (baselineHash == null) return false;
  return baselineHash !== currentHash;
}

// Compose the gate verdict from presence + absence stages, plus the corpus-shape guard.
// Precedence: CAPTURING > FAIL > INCONCLUSIVE > PASS. SKIPPED stages are excluded.
// shapeChanged (default false, so existing two-arg call sites compose unchanged) folds in as
// an INCONCLUSIVE-class input: it overrides a bare PASS but never masks a genuine FAIL, and a
// capture still short-circuits first.
export function composeVerdict(
  presence: PresenceStatus,
  stages: StageResult[],
  shapeChanged = false,
): Verdict {
  if (presence === "CAPTURING") return "CAPTURING";
  const armed = stages.filter((s) => s.status !== "SKIPPED");
  const statuses: (PresenceStatus | StageStatus)[] = [presence, ...armed.map((s) => s.status)];
  if (statuses.includes("FAIL")) return "FAIL";
  if (shapeChanged || statuses.includes("INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

// Whether this run captures a baseline (vs composes a verdict).
export function isBaselineCapture(baselineExists: boolean, rebaseline: boolean): boolean {
  return rebaseline || !baselineExists;
}
