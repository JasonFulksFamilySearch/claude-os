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
