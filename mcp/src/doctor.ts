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
import { isCutoverBoundary, fileSetHash } from "./eval.js";

export function checkBaselinePresent(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/baseline-present", () => {
    if (readBaseline(ctx.baselinePath) === null) return {
      id: "eval/baseline-present", status: "INCONCLUSIVE", fixable: true,
      detail: "no eval baseline — the regression gate is not armed; capture one.",
      // recaptureBaseline IS the apply-time capture path (gated on a fresh eval PASS). The
      // id MUST match a real applyFix case; "capture-baseline" had no case and printed a fix
      // that --apply-fix would reject as unknown.
      remediation: { id: "recapture-baseline", description: "capture an eval baseline on the current index (gated on a fresh PASS)", command: "npm run eval -- --rebaseline" },
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

export function checkCorpusDrift(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/corpus-drift", () => {
    const baseline = readBaseline(ctx.baselinePath);
    if (baseline === null) return {
      id: "eval/corpus-drift", status: "INCONCLUSIVE", fixable: false,
      detail: "no baseline to compare corpus shape against.",
    };
    const storedHash = baseline.corpus?.file_set_hash;
    if (storedHash == null) return {
      id: "eval/corpus-drift", status: "INCONCLUSIVE", fixable: true,
      detail: "baseline predates the file-set-hash shape signal — re-baseline to record it.",
      remediation: { id: "recapture-baseline", description: "recapture the baseline to record the file-set-hash shape signal" },
    };
    const liveHash = fileSetHash(distinctSourcePaths(ctx.db));
    if (storedHash !== liveHash) return {
      id: "eval/corpus-drift", status: "FAIL", fixable: true,
      detail: "the live corpus file-set differs from the baseline (corpus drifted since capture) — re-baseline after a PASS.",
      remediation: { id: "recapture-baseline", description: "recapture the baseline after a fresh eval PASS" },
    };
    return { id: "eval/corpus-drift", status: "PASS", detail: "live corpus file-set matches the baseline shape hash.", fixable: false };
  });
}

export function checkBrokenLabels(ctx: DoctorContext): Promise<CheckResult> {
  return safeCheck("eval/broken-labels", () => {
    // Canonical labeled-set shape is LabeledSetV2 (eval.ts): queries are nested under
    // presence.queries, NOT top-level .queries. Reading the wrong key silently yields an
    // empty list and a false PASS on every real install — the exact honesty violation this
    // check exists to catch.
    const parsed = JSON.parse(readFileSync(ctx.labelsPath, "utf8"));
    const queries: { query: string; expectedPathContains: string[] }[] = parsed.presence?.queries ?? [];
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
  // Canonical shape (eval.ts LabeledSetV2): queries live under presence.queries.
  // Read AND write that nesting — a top-level .queries read finds nothing (silent no-op)
  // and a top-level write would inject a phantom key while the real list stays dead.
  const parsed = JSON.parse(raw) as { presence?: { queries?: { query: string; expectedPathContains: string[] }[] } };
  const queries = parsed.presence?.queries ?? [];

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

  // Remove the dead entry and write back, preserving the presence nesting.
  const updated = { ...parsed, presence: { ...parsed.presence, queries: queries.filter((q) => q.query !== deadQuery) } };
  writeFileSync(labelsPath, JSON.stringify(updated, null, 2), "utf8");

  // Re-run eval to check the post-fix verdict.
  const r = await runEval();
  const verdictAfter = r.ok ? r.verdict : null;

  return { applied: true, backupPath, verdictAfter, detail: `dropped dead label "${deadQuery}"; eval re-run: ${verdictAfter ?? "inconclusive"}.` };
}

// runMigrateFix: delegates the v2→v3 schema migration to the injected
// migrateRunner (the real impl shells `npm run migrate` with CLAUDE_OS_DB_PATH).
// The migrate script owns its own VACUUM INTO backup — this fix does NOT
// double-backup the DB. On runner failure the reason is surfaced in detail
// (never swallowed). On success, checkSchemaCurrent will report PASS because
// the DB now has the anchor column (isV3Schema returns true).
export async function runMigrateFix(opts: {
  db: Database.Database;
  migrateRunner: () => Promise<{ ok: boolean; reason?: string }>;
}): Promise<FixResult> {
  const { migrateRunner } = opts;
  const result = await migrateRunner();
  if (!result.ok) {
    return {
      applied: false,
      detail: `migrate failed: ${result.reason ?? "unknown error"}`,
    };
  }
  return {
    applied: true,
    detail: "v2→v3 migration applied via migrate runner; schema is now current.",
  };
}

// ---------------------------------------------------------------------------
// Task 12: reembedMissing fix — back up DB, verify, then vectorCoverageSweep
// ---------------------------------------------------------------------------
import { backupDb, verifyBackup } from "./migrations.js";
import { vectorCoverageSweep } from "./indexer.js";

// reembedMissing: snapshots the DB (VACUUM INTO), verifies the backup is
// complete and structurally correct, then runs vectorCoverageSweep to
// re-embed any observation rows that have no vec_items entry.
//
// The backup→verify→mutate order is the load-bearing safety contract:
// re-embedding is not trivially undoable (new vec_items rows are written),
// so the DB is snapshotted first. If verifyBackup throws the function aborts
// before any sweep mutation — a bad backup means no safe re-embed.
export async function reembedMissing(opts: {
  db: Database.Database;
  dbPath: string;
  backupPath: string;
}): Promise<FixResult> {
  const { db, backupPath } = opts;

  // Capture live observation count BEFORE backup — verifyBackup requires the
  // exact count to detect a truncated or stale snapshot.
  const count = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;

  // Step 1: back up the DB (VACUUM INTO).
  backupDb(db, backupPath);

  // Step 2: verify the backup is complete and not corrupted.
  // If this throws, no mutation has occurred — let the throw propagate so the
  // caller knows the fix could not proceed safely.
  verifyBackup(backupPath, count);

  // Step 3: re-embed orphan observations.
  const sweep = await vectorCoverageSweep(db);

  return {
    applied: true,
    backupPath,
    detail: `re-embedded ${sweep.healed} orphan(s); ${sweep.after} remaining (before: ${sweep.before}, after: ${sweep.after}).`,
  };
}

// ---------------------------------------------------------------------------
// Task 13: clearStaleLock fix — apply-time staleness re-verification
// ---------------------------------------------------------------------------
import { rmSync as rmSyncLock } from "node:fs";

// clearStaleLock: removes the stale writer-lock directory so a crashed session
// stops blocking index maintenance.
//
// Safety contract: isStale is re-called AT APPLY TIME with the same lockPath
// and now. Only rmSync the lock dir if it is STILL stale. If a live writer
// re-heartbeated between diagnose and apply (bumping the mtime past the
// threshold) the fix REFUSES: applied:false, dir intact. Clearing a lock a live
// writer holds would corrupt single-writer election.
//
// Idempotent: if the lock dir doesn't exist, nothing to clear — applied:false.
// rmSync with force:true does not throw on an absent dir.
export function clearStaleLock(opts: { lockPath: string; now?: number }): FixResult {
  const { lockPath } = opts;
  const now = opts.now ?? Date.now();

  // No lock dir — already healthy.
  if (!existsSync(lockPath)) {
    return { applied: false, detail: "no writer lock present — nothing to clear." };
  }

  // Apply-time re-verification: re-call isStale at this moment. A live writer
  // may have re-heartbeated between diagnose and now, making the lock fresh.
  if (!isStale(lockPath, now)) {
    return {
      applied: false,
      detail: "lock is no longer stale — refusing to clear (a live writer may hold it).",
    };
  }

  // Lock is still stale: clear it. force:true makes a concurrent removal benign.
  rmSyncLock(lockPath, { recursive: true, force: true });

  return {
    applied: true,
    detail: "stale writer-lock directory cleared; index maintenance may now proceed.",
  };
}

// ---------------------------------------------------------------------------
// Task 14: recaptureBaseline fix — code-enforced fresh-PASS gate
// ---------------------------------------------------------------------------

// recaptureBaseline: re-records the eval baseline on the current (chunked) index,
// but ONLY after a fresh eval composes PASS. The refusal is a code guard — not a
// log line, not operator discipline — executed BEFORE any write.
//
// The capture itself is DELEGATED to the eval script's own --rebaseline path (via the
// injected rebaselineRunner, the same way runMigrateFix delegates to migrate). The eval
// script is the authority that knows the real presence metrics (recall@k/MRR), the live
// file_set_hash, and the chunking state — a baseline it writes arms the gate. A baseline
// hand-written here could only hard-zero the metrics (neutering the regression floor) and
// omit file_set_hash (forcing checkCorpusDrift INCONCLUSIVE) — the exact gate-breakage this
// fix is meant to repair.
//
// Safety contract (load-bearing):
//   1. Run eval FIRST. If verdict !== "PASS" OR ok === false → refuse immediately;
//      the baseline file is provably untouched (no rebaseline has run).
//   2. If a baseline file already exists → copy it to <baselinePath>.bak BEFORE
//      delegating the overwrite. Pre-image backup is always written before the rebaseline.
//   3. Delegate the actual capture to the eval --rebaseline runner.
//   4. Return { applied:true, backupPath?, verdictAfter:"PASS", detail }.
//
// Idempotent: after a successful recapture, checkBaselineStale reports PASS; a
// re-offer only proceeds if a fresh eval still PASSes (the guard re-runs).
export async function recaptureBaseline(opts: {
  baselinePath: string;
  runEval: EvalRunner;
  rebaselineRunner: () => Promise<{ ok: boolean; reason?: string }>;
}): Promise<FixResult> {
  const { baselinePath, runEval, rebaselineRunner } = opts;

  // Step 1 (load-bearing guard): run eval and refuse on any non-PASS result.
  // This guard is a code gate — no write has occurred yet at this point.
  const r = await runEval();
  if (!r.ok || r.verdict !== "PASS") {
    return {
      applied: false,
      detail: "refusing to recapture — eval did not compose a fresh PASS (the gate is in code, not operator discipline)",
    };
  }

  // Step 2: back up any existing baseline BEFORE the rebaseline overwrites it.
  let backupPath: string | undefined;
  if (existsSync(baselinePath)) {
    backupPath = baselinePath + ".bak";
    copyFileSync(baselinePath, backupPath);
  }

  // Step 3: delegate the capture to the eval script's --rebaseline path. It writes a
  // real baseline — live file_set_hash, real presence metrics, current chunking state.
  const cap = await rebaselineRunner();
  if (!cap.ok) {
    return {
      applied: false,
      backupPath,
      detail: `eval --rebaseline failed: ${cap.reason ?? "unknown error"}${backupPath ? ` (pre-image preserved at ${backupPath})` : ""}.`,
    };
  }

  return {
    applied: true,
    backupPath,
    verdictAfter: "PASS",
    detail: `recaptured baseline via eval --rebaseline; pre-image backed up at ${backupPath ?? "(none — no prior baseline)"}.`,
  };
}

// ---------------------------------------------------------------------------
// Task 8: registry assembly + diagnose() end-to-end composition
// ---------------------------------------------------------------------------

export const CHECKS: Check[] = [
  checkBaselinePresent, checkBaselineStale, checkBrokenLabels, checkCorpusDrift, checkLastVerdict,
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
