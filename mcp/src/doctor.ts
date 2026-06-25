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

// FixResult — the shared return shape for all Phase 3 fix functions.
export interface FixResult {
  applied: boolean;
  backupPath?: string;
  verdictAfter?: "PASS" | "FAIL" | "INCONCLUSIVE" | "CAPTURING" | null;
  detail: string;
}

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

// ---------------------------------------------------------------------------
// Task 5: index/cutover checks
// ---------------------------------------------------------------------------
import { readFileSync as readFile } from "node:fs";
import { isV3Schema } from "./migrations.js";
import { chunkFile } from "./chunker.js";
import type { SourceType } from "./db.js";
// chunkingEnabled is already imported from "./eval_inspect.js" in Task 4's block; reuse it
// here rather than reimplementing the meta.c2_chunking_enabled read (the plan's "Reuse,
// don't reimplement" contract — and exactly what Task 5's Interfaces block promises).

export function checkChunkingMarker(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("index/chunking-marker", () => {
    const on = chunkingEnabled(ctx.db);
    const anchored = (ctx.db.prepare("SELECT COUNT(*) c FROM observations WHERE anchor != ''").get() as { c: number }).c;
    if (on && anchored === 0) return { id: "index/chunking-marker", status: "FAIL", fixable: false,
      detail: "c2_chunking_enabled marker is on but no chunked rows (anchor != '') exist — run the cutover/reindex." };
    if (!on && anchored > 0) return { id: "index/chunking-marker", status: "FAIL", fixable: false,
      detail: `marker is off but ${anchored} chunked rows exist — inconsistent index state.` };
    return { id: "index/chunking-marker", status: "PASS", detail: `chunking marker ${on ? "on" : "off"}, consistent with the index.`, fixable: false };
  });
}

export function checkSchemaCurrent(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("index/schema-current", () => {
    if (!isV3Schema(ctx.db)) return { id: "index/schema-current", status: "FAIL", fixable: true,
      detail: "schema is pre-C2 (no anchor column) — migrate before the server refuses to start.",
      remediation: { id: "run-migrate", description: "run the v2->v3 migration", command: "npm run migrate" } };
    return { id: "index/schema-current", status: "PASS", detail: `schema current (v3, user_version ${ctx.db.pragma("user_version", { simple: true })}).`, fixable: false };
  });
}

const setsEqual = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function checkChunkShapeDivergence(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("index/chunk-shape-divergence", () => {
    if (!chunkingEnabled(ctx.db)) return { id: "index/chunk-shape-divergence", status: "PASS",
      detail: "chunking not enabled — divergence check is not applicable.", fixable: false };
    const rows = ctx.db.prepare("SELECT source_path, source_type, anchor FROM observations").all() as
      { source_path: string; source_type: SourceType; anchor: string }[];
    const byPath = new Map<string, { type: SourceType; anchors: Set<string> }>();
    for (const r of rows) {
      const e = byPath.get(r.source_path) ?? { type: r.source_type, anchors: new Set<string>() };
      e.anchors.add(r.anchor); byPath.set(r.source_path, e);
    }
    let divergence = 0;
    for (const [path, { type, anchors }] of byPath) {
      let content: string;
      try { content = readFile(path, "utf8"); } catch { divergence++; continue; }
      const produced = new Set(chunkFile({ sourceType: type, content, chunkingEnabled: true }).map((c) => c.anchor));
      if (!setsEqual(produced, anchors)) divergence++;
    }
    if (divergence > 0) return { id: "index/chunk-shape-divergence", status: "FAIL", fixable: false,
      detail: `${divergence} file(s) whose indexed chunk-shape diverges from what the chunker produces today — reindex to converge (cause not attributed; a fresh \`npm run cutover\` separates a missed split from a stale-but-correct index).` };
    return { id: "index/chunk-shape-divergence", status: "PASS", detail: "no chunk-shape divergence.", fixable: false };
  });
}

// ---------------------------------------------------------------------------
// Task 6: corpus checks
// ---------------------------------------------------------------------------
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { countMissingVectors } from "./indexer.js";

export function checkIntegrity(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("corpus/integrity", () => {
    const ic = ctx.db.pragma("integrity_check", { simple: true });
    if (ic !== "ok") return { id: "corpus/integrity", status: "FAIL", fixable: false,
      detail: `SQLite integrity_check returned "${String(ic)}" — see the rollback procedure (not auto-fixable).` };
    return { id: "corpus/integrity", status: "PASS", detail: "integrity_check ok.", fixable: false };
  });
}

export function checkCorpusShape(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("corpus/shape", () => {
    const total = (ctx.db.prepare("SELECT COUNT(*) c FROM observations").get() as { c: number }).c;
    if (total === 0) return { id: "corpus/shape", status: "FAIL", fixable: false, detail: "corpus is empty — nothing is indexed." };
    const distinct = (ctx.db.prepare("SELECT COUNT(DISTINCT source_path) c FROM observations").get() as { c: number }).c;
    return { id: "corpus/shape", status: "PASS", detail: `${total} rows across ${distinct} distinct files.`, fixable: false };
  });
}

export function checkOrphanEmbeddings(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("corpus/orphan-embeddings", () => {
    const missing = countMissingVectors(ctx.db);
    if (missing > 0) return { id: "corpus/orphan-embeddings", status: "FAIL", fixable: true,
      detail: `${missing} observation row(s) have no embedding — silent retrieval degradation.`,
      remediation: { id: "re-embed", description: `re-embed ${missing} missing row(s)`, command: "npm run reembed" } };
    return { id: "corpus/orphan-embeddings", status: "PASS", detail: "every observation has an embedding.", fixable: false };
  });
}

export function checkExpectedContextFiles(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("corpus/expected-context", () => {
    const templates = readdirSync(join(ctx.repoRoot, "context-templates")).filter((f) => f.endsWith(".md"));
    const indexed = (ctx.db.prepare("SELECT source_path FROM observations WHERE source_type='context'").all() as { source_path: string }[]).map((r) => r.source_path);
    const missing = templates.filter((t) => !indexed.some((p) => p.endsWith("/" + t) || p.endsWith(t)));
    if (missing.length > 0) return { id: "corpus/expected-context", status: "FAIL", fixable: false,
      detail: `expected context file(s) missing from the index: ${missing.join(", ")} (derived from context-templates/).` };
    return { id: "corpus/expected-context", status: "PASS", detail: "every provisioned context template is indexed.", fixable: false };
  });
}

// ---------------------------------------------------------------------------
// Task 7: election / deps / backup / advisory checks
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isStale } from "./election.js";

export function checkStaleLock(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("election/stale-lock", () => {
    if (!existsSync(ctx.lockPath)) return { id: "election/stale-lock", status: "PASS", detail: "no writer lock held.", fixable: false };
    if (isStale(ctx.lockPath, ctx.now ?? Date.now())) return { id: "election/stale-lock", status: "FAIL", fixable: true,
      detail: "writer-lock holder is past staleness (3 × 60s) — a crashed session is blocking index maintenance.",
      remediation: { id: "clear-stale-lock", description: "clear the stale writer lock (re-verified stale at apply-time)" } };
    return { id: "election/stale-lock", status: "PASS", detail: "writer lock is fresh.", fixable: false };
  });
}

export function checkNpmAudit(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("deps/npm-audit", async () => {
    const rr = await ctx.runAudit();
    if (!rr.ok) return { id: "deps/npm-audit", status: "INCONCLUSIVE", detail: `npm audit could not run: ${rr.reason ?? "unknown"}.`, fixable: false };
    const v = rr.vulnerabilities ?? { critical: 0, high: 0, moderate: 0, low: 0 };
    const summary = `${v.critical} critical / ${v.high} high / ${v.moderate} moderate / ${v.low} low${rr.devOnly ? " (dev-only)" : ""}`;
    return { id: "deps/npm-audit", status: "ADVISORY", fixable: false,
      detail: `npm audit: ${summary}. Report-only — tracked in #84; doctor never runs npm audit fix.` };
  });
}

function reportOnlySubprocess(id: string, label: string, runner: SubprocessRunner | undefined, full: boolean): Promise<CheckResult> {
  return safeCheck(id, async () => {
    if (!full) return { id, status: "ADVISORY", detail: `${label} not run — pass --full to include it.`, fixable: false };
    const rr = await runner!();
    if (!rr.ok) return { id, status: "INCONCLUSIVE", detail: `${label} could not run: ${rr.reason ?? "unknown"}.`, fixable: false };
    return { id, status: rr.passed ? "PASS" : "FAIL", detail: `${label} ${rr.passed ? "passed" : "failed"} (report-only).`, fixable: false };
  });
}
export const checkBuild: Check = (ctx) => reportOnlySubprocess("deps/tsc", "tsc build", ctx.runBuild, ctx.full);
export const checkTestSuite: Check = (ctx) => reportOnlySubprocess("deps/test", "test suite", ctx.runTest, ctx.full);

export function checkBackupPresent(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("backup/present", () => {
    const base = basename(ctx.dbPath);
    const siblings = readdirSync(dirname(ctx.dbPath));
    const found = siblings.some((f) =>
      new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.pre-cutover\\.\\d{8}T\\d{6}Z\\.bak$`).test(f) || f === `${base}.pre-c2.bak`);
    if (found) return { id: "backup/present", status: "PASS", detail: "a pre-cutover/recovery snapshot is present — rollback is possible.", fixable: false };
    return { id: "backup/present", status: "FAIL", fixable: false, detail: "no pre-cutover or pre-c2 backup found — a rollback is not currently possible." };
  });
}

export function checkAdvisorySingleRowContext(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("advisory/single-row-context", () => {
    const n = (ctx.db.prepare(
      "SELECT COUNT(*) c FROM (SELECT source_path FROM observations WHERE source_type='context' GROUP BY source_path HAVING COUNT(*) = 1)")
      .get() as { c: number }).c;
    return { id: "advisory/single-row-context", status: "ADVISORY", fixable: false,
      detail: `${n} single-row context file(s) may rank poorly (issue #82) — a known standing condition, not a fault.` };
  });
}

// ---------------------------------------------------------------------------
// Task 9: fix functions — Phase 3 repair mutations
// ---------------------------------------------------------------------------
import { copyFileSync, writeFileSync } from "node:fs";

// dropDeadLabel: backs up the labels file, confirms the target label is STILL
// dead at apply-time (held-out doctrine: never drop a live label), removes it,
// writes back, then re-runs eval via the injected runner.
export async function dropDeadLabel(opts: {
  db: Database.Database;
  labelsPath: string;
  deadQuery: string;
  runEval: EvalRunner;
}): Promise<FixResult> {
  const { db, labelsPath, deadQuery, runEval } = opts;
  const raw = readFileSync(labelsPath, "utf8");
  const parsed = JSON.parse(raw) as { queries?: { query: string; expectedPathContains: string[] }[] };
  const queries = parsed.queries ?? [];

  const target = queries.find((q) => q.query === deadQuery);
  if (target === undefined) {
    // Already gone — idempotent.
    return { applied: false, detail: `label "${deadQuery}" not found in labels file — nothing to drop.` };
  }

  // Held-out doctrine: re-verify deadness at apply-time.
  const liveIds = resolveRelevantIds(db, target.expectedPathContains);
  if (liveIds.length > 0) {
    return { applied: false, detail: `label "${deadQuery}" is not dead (matches ${liveIds.length} row(s)) — refusing to drop.` };
  }

  // Backup BEFORE mutation.
  const backupPath = labelsPath + ".bak";
  copyFileSync(labelsPath, backupPath);

  // Remove the dead entry and write back.
  const updated = { ...parsed, queries: queries.filter((q) => q.query !== deadQuery) };
  writeFileSync(labelsPath, JSON.stringify(updated, null, 2), "utf8");

  // Re-run eval to check the post-fix verdict.
  const r = await runEval();
  const verdictAfter = r.ok ? r.verdict : null;

  return { applied: true, backupPath, verdictAfter, detail: `dropped dead label "${deadQuery}"; eval re-run: ${verdictAfter ?? "inconclusive"}.` };
}

// recomputeCorpusSnapshot: backs up the labels file, then writes the LIVE
// distinct-file count into curation.corpus_snapshot (never trusts the stored
// value — the stored value is precisely what may be stale). Synchronous; no
// eval re-run needed (checkCorpusSnapshot re-reads the live count on demand).
export function recomputeCorpusSnapshot(opts: {
  db: Database.Database;
  labelsPath: string;
}): FixResult {
  const { db, labelsPath } = opts;
  const raw = readFileSync(labelsPath, "utf8");
  const parsed = JSON.parse(raw) as { curation?: { corpus_snapshot?: number }; [k: string]: unknown };

  const liveCount = distinctSourcePaths(db).length;

  // Backup BEFORE mutation (idempotent is not reversible — recomputing silently overwrites).
  const backupPath = labelsPath + ".bak";
  copyFileSync(labelsPath, backupPath);

  // Write the live count into curation.corpus_snapshot.
  const updated = {
    ...parsed,
    curation: { ...(parsed.curation ?? {}), corpus_snapshot: liveCount },
  };
  writeFileSync(labelsPath, JSON.stringify(updated, null, 2), "utf8");

  return {
    applied: true,
    backupPath,
    detail: `recomputed corpus_snapshot to ${liveCount} (live distinct-file count).`,
  };
}

// ---------------------------------------------------------------------------
// Task 8: registry assembly + diagnose() end-to-end composition
// ---------------------------------------------------------------------------

export const CHECKS: Check[] = [
  checkBaselinePresent, checkBaselineStale, checkBrokenLabels, checkCorpusSnapshot, checkLastVerdict,
  checkChunkingMarker, checkChunkShapeDivergence, checkSchemaCurrent,
  checkIntegrity, checkCorpusShape, checkOrphanEmbeddings, checkExpectedContextFiles,
  checkStaleLock,
  checkNpmAudit, checkBuild, checkTestSuite,
  checkBackupPresent,
  checkAdvisorySingleRowContext,
];

export async function runChecks(ctx: DoctorContext): Promise<CheckResult[]> {
  return Promise.all(CHECKS.map((c) => Promise.resolve(c(ctx))));
}

export async function diagnose(ctx: DoctorContext): Promise<{ results: CheckResult[]; verdict: DoctorVerdict }> {
  const results = await runChecks(ctx);
  return { results, verdict: composeVerdict(results) };
}
