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
  type EvalResult, type AuditResult, type SubprocessResult,
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
function makeEvalRunner(dbPath: string): () => Promise<EvalResult> {
  return async () => {
    try {
      const out = execFileSync("npm", ["run", "--silent", "eval"], {
        env: { ...process.env, CLAUDE_OS_DB_PATH: dbPath }, encoding: "utf8",
      });
      const m = out.match(/VERDICT:\s*(PASS|FAIL|INCONCLUSIVE|CAPTURING)/);
      return m ? { verdict: m[1] as EvalResult["verdict"], ok: true } : { verdict: "INCONCLUSIVE", ok: false, reason: "could not parse eval verdict" };
    } catch (e) {
      return { verdict: "INCONCLUSIVE", ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };
}

function makeAuditRunner(): () => Promise<AuditResult> {
  return async () => {
    try {
      const out = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const j = JSON.parse(out);
      const v = j.metadata?.vulnerabilities ?? {};
      return { ok: true, vulnerabilities: { critical: v.critical ?? 0, high: v.high ?? 0, moderate: v.moderate ?? 0, low: v.low ?? 0 } };
    } catch (e: any) {
      // npm audit exits non-zero WHEN vulns exist but still prints JSON — recover it.
      try {
        const j = JSON.parse(e.stdout?.toString() ?? "");
        const v = j.metadata?.vulnerabilities ?? {};
        return { ok: true, vulnerabilities: { critical: v.critical ?? 0, high: v.high ?? 0, moderate: v.moderate ?? 0, low: v.low ?? 0 } };
      } catch {
        return { ok: false, reason: "npm audit could not run or parse" };
      }
    }
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
  const verdict = await run({ full: argv.includes("--full"), fix: argv.includes("--fix"), dbPath });
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
