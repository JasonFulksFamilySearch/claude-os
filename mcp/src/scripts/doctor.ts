// mcp/src/scripts/doctor.ts — thin headless runner. Never spawns a Claude session;
// never imports the embedder. eval/audit/tsc/test run as subprocesses.
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import { DEFAULT_DB_PATH } from "../db.js";
import {
  diagnose, composeVerdict, type CheckResult, type DoctorContext,
  type EvalResult, type AuditResult, type SubprocessResult, type FixResult,
  dropDeadLabel, runMigrateFix, reembedMissing, clearStaleLock, recaptureBaseline,
  checkBrokenLabels,
} from "../doctor.js";

function group(results: CheckResult[]): Map<string, CheckResult[]> {
  const m = new Map<string, CheckResult[]>();
  for (const r of results) {
    const cat = r.id.split("/")[0];
    let bucket = m.get(cat);
    if (!bucket) { bucket = []; m.set(cat, bucket); }
    bucket.push(r);
  }
  return m;
}

export function formatReport(results: CheckResult[]): string {
  const verdict = composeVerdict(results);
  const advisory = results.filter((r) => r.status === "ADVISORY");
  const graded = results.filter((r) => r.status !== "ADVISORY");
  let out = `VERDICT: ${verdict}\n\n`;
  for (const [cat, rows] of group(graded)) {
    out += `### ${cat}\n`;
    for (const r of rows) {
      out += `- ${r.status.padEnd(13)} ${r.id} — ${r.detail}`;
      if (r.fixable && r.remediation) out += ` (fix: ${r.remediation.id})`;
      out += `\n`;
    }
    out += `\n`;
  }
  if (advisory.length) {
    out += `## Advisory — standing conditions\n`;
    for (const r of advisory) out += `- ${r.id} — ${r.detail}\n`;
  }
  return out;
}

export function jsonTrailer(results: CheckResult[]): string {
  return `\n<doctor-json>${JSON.stringify({
    verdict: composeVerdict(results),
    checks: results.map((r) => ({ id: r.id, status: r.status, fixable: r.fixable })),
  })}</doctor-json>\n`;
}

// Real subprocess runners (the seams the registry injects). Each parses structured output
// and NEVER throws past safeCheck — a non-zero/parse failure becomes ok:false.

// parseEvalVerdict maps the eval script's `VERDICT:` line to an EvalResult. The no-baseline
// run prints `VERDICT: BASELINE CAPTURED (...)` (eval.ts) — NOT the literal "CAPTURING" — so
// that line is recognized first and mapped to the CAPTURING verdict, letting checkLastVerdict
// report the honest CAPTURING→INCONCLUSIVE "no baseline yet" state instead of a parse failure.
// Checked before the PASS|FAIL|INCONCLUSIVE regex so a real verdict line is never misread.
export function parseEvalVerdict(out: string): EvalResult {
  if (/VERDICT:\s*BASELINE CAPTURED/.test(out)) return { verdict: "CAPTURING", ok: true };
  const m = out.match(/VERDICT:\s*(PASS|FAIL|INCONCLUSIVE|CAPTURING)/);
  return m
    ? { verdict: m[1] as EvalResult["verdict"], ok: true }
    : { verdict: "INCONCLUSIVE", ok: false, reason: "could not parse eval verdict" };
}

function makeEvalRunner(dbPath: string): () => Promise<EvalResult> {
  return async () => {
    try {
      const out = execFileSync("npm", ["run", "--silent", "eval"], {
        env: { ...process.env, CLAUDE_OS_DB_PATH: dbPath }, encoding: "utf8",
      });
      return parseEvalVerdict(out);
    } catch (e) {
      return { verdict: "INCONCLUSIVE", ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };
}

// Run `npm audit --json` (optionally --omit=dev) and return the per-severity counts,
// or null if it could not run/parse. npm audit exits non-zero WHEN vulns exist but still
// prints JSON on stdout, so a non-zero exit is recovered from e.stdout — only a genuine
// parse failure returns null.
function auditCounts(extraArgs: string[]): { critical: number; high: number; moderate: number; low: number } | null {
  const parse = (raw: string) => {
    const v = JSON.parse(raw).metadata?.vulnerabilities ?? {};
    return { critical: v.critical ?? 0, high: v.high ?? 0, moderate: v.moderate ?? 0, low: v.low ?? 0 };
  };
  try {
    return parse(execFileSync("npm", ["audit", "--json", ...extraArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch (e: any) {
    try { return parse(e.stdout?.toString() ?? ""); } catch { return null; }
  }
}

function makeAuditRunner(): () => Promise<AuditResult> {
  return async () => {
    // The plain run is load-bearing: it produces the counts the check reports.
    const full = auditCounts([]);
    if (full === null) return { ok: false, reason: "npm audit could not run or parse" };

    // dev-only classification is best-effort. `--omit=dev` re-audits the production-only
    // tree; a vuln is dev-only iff it disappears when dev deps are omitted. If this second
    // run fails, leave devOnly UNDEFINED (silence) — never emit a false "runtime" or a
    // false "dev-only" from a classification we could not actually make.
    const total = (c: { critical: number; high: number; moderate: number; low: number }) =>
      c.critical + c.high + c.moderate + c.low;
    const prod = auditCounts(["--omit=dev"]);
    const devOnly = prod === null ? undefined : total(full) > 0 && total(prod) === 0;

    return { ok: true, vulnerabilities: full, devOnly };
  };
}

function makeSubprocessRunner(args: string[]): () => Promise<SubprocessResult> {
  return async () => {
    try {
      execFileSync("npm", args, { encoding: "utf8", stdio: "ignore" });
      return { ok: true, passed: true };
    } catch (e: any) {
      return e.status != null ? { ok: true, passed: false } : { ok: false, passed: false, reason: e?.message ?? "could not run" };
    }
  };
}

function makeMigrateRunner(dbPath: string): () => Promise<{ ok: boolean; reason?: string }> {
  return async () => {
    try {
      execFileSync("npm", ["run", "migrate"], {
        env: { ...process.env, CLAUDE_OS_DB_PATH: dbPath }, encoding: "utf8", stdio: "ignore",
      });
      return { ok: true };
    } catch (e: any) {
      const reason = e.stderr?.toString().trim() || e.message || "unknown error";
      return { ok: false, reason };
    }
  };
}

// The eval script owns baseline capture — it writes the real file_set_hash, presence
// metrics, and chunking state. recaptureBaseline delegates the capture here rather than
// hand-writing a baseline that would break the gate it repairs.
function makeRebaselineRunner(dbPath: string): () => Promise<{ ok: boolean; reason?: string }> {
  return async () => {
    try {
      execFileSync("npm", ["run", "eval", "--", "--rebaseline"], {
        env: { ...process.env, CLAUDE_OS_DB_PATH: dbPath }, encoding: "utf8", stdio: "ignore",
      });
      return { ok: true };
    } catch (e: any) {
      const reason = e.stderr?.toString().trim() || e.message || "unknown error";
      return { ok: false, reason };
    }
  };
}

function buildContext(dbPath: string, full: boolean): { ctx: DoctorContext; db: Database.Database } {
  // Raw open (NOT openDb) so a pre-C2 schema is diagnosable instead of throwing.
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); sqliteVec.load(db);
  const dataRoot = join(homedir(), ".claude-data");
  const ctx: DoctorContext = {
    db, dbPath,
    baselinePath: join(dataRoot, "eval-baseline.json"),
    labelsPath: join(dataRoot, "eval", "labeled-queries.json"),
    lockPath: join(dataRoot, "memory.db.writer.lock.d"),
    repoRoot: join(fileURLToPath(import.meta.url), "..", "..", "..", ".."), // mcp/src/scripts -> repo root
    full,
    runEval: makeEvalRunner(dbPath),
    runAudit: makeAuditRunner(),
    runBuild: makeSubprocessRunner(["run", "build"]),
    runTest: makeSubprocessRunner(["test"]),
  };
  return { ctx, db };
}

export async function applyFix(fixId: string, ctx: DoctorContext): Promise<FixResult> {
  switch (fixId) {
    case "drop-dead-label": {
      // Re-run the broken-labels check at apply-time (held-out doctrine: never trust
      // diagnose-time data) and read the dead query from its STRUCTURED context — not by
      // re-parsing the human-readable detail, which would silently break on a reword.
      const check = await checkBrokenLabels(ctx);
      if (!check.fixable || check.remediation?.id !== "drop-dead-label") {
        return { applied: false, detail: "no dead label to drop — broken-labels check did not report a dead label." };
      }
      const deadQuery = check.context?.deadQuery;
      if (deadQuery === undefined) {
        return { applied: false, detail: "broken-labels check did not carry a dead query to drop." };
      }
      return dropDeadLabel({ db: ctx.db, labelsPath: ctx.labelsPath, deadQuery, runEval: makeEvalRunner(ctx.dbPath) });
    }
    case "run-migrate":
      return runMigrateFix({ db: ctx.db, migrateRunner: makeMigrateRunner(ctx.dbPath) });
    case "re-embed": {
      // CRITICAL: fresh timestamped backupPath — VACUUM INTO refuses to overwrite an existing file.
      const backupPath = `${ctx.dbPath}.pre-reembed.${Date.now()}.bak`;
      return reembedMissing({ db: ctx.db, dbPath: ctx.dbPath, backupPath });
    }
    case "clear-stale-lock":
      return clearStaleLock({ lockPath: ctx.lockPath });
    case "recapture-baseline":
      return recaptureBaseline({
        baselinePath: ctx.baselinePath,
        runEval: makeEvalRunner(ctx.dbPath),
        rebaselineRunner: makeRebaselineRunner(ctx.dbPath),
      });
    default:
      return { applied: false, detail: `unknown fix id: ${fixId}` };
  }
}

export async function run(opts: { full: boolean; fix: boolean; dbPath: string }): Promise<"PASS" | "FAIL" | "INCONCLUSIVE"> {
  if (opts.fix) {
    process.stdout.write(
      "repair (--fix) is session-gated: run the /doctor skill, which drives per-fix confirmation one finding at a time.\n",
    );
  }
  const { ctx, db } = buildContext(opts.dbPath, opts.full);
  try {
    const { results, verdict } = await diagnose(ctx);
    process.stdout.write(formatReport(results));
    process.stdout.write(jsonTrailer(results));
    return verdict;
  } finally {
    db.close();
  }
}

// Direct-entry guard — verbatim pattern from cutover.ts:100-104 (never fires under test import).
const isDirectEntry =
  argv[1] != null &&
  fileURLToPath(import.meta.url).endsWith(argv[1].replace(/\\/g, "/").split("/").pop() ?? "");

if (isDirectEntry) {
  const dbPath = process.env["CLAUDE_OS_DB_PATH"] ?? DEFAULT_DB_PATH;
  const applyFixArg = argv.find((a) => a.startsWith("--apply-fix="));
  if (applyFixArg) {
    const fixId = applyFixArg.slice("--apply-fix=".length);
    const { ctx, db } = buildContext(dbPath, false);
    try {
      const result = await applyFix(fixId, ctx);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exitCode = result.applied ? 0 : 1;
    } finally {
      db.close();
    }
  } else {
    const verdict = await run({ full: argv.includes("--full"), fix: argv.includes("--fix"), dbPath });
    process.exitCode = verdict === "PASS" ? 0 : 1;
  }
}
