# Doctor / Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only `doctor` diagnosis command and an opt-in, per-fix-confirmed `repair` mode that codify the manual recovery playbook for a Dioscuri (claude-os) memory-engine installation.

**Architecture:** Three layers. (1) A promoted eval-gate *inspection* module (`mcp/src/eval_inspect.ts`) that both the eval script and doctor share, so the DB probes never diverge. (2) A pure-logic check registry (`mcp/src/doctor.ts`) — independent, unit-testable check functions plus verdict composition and the confirm-then-apply fix functions. (3) A thin headless CLI runner (`mcp/src/scripts/doctor.ts`) and a `/doctor` skill that owns the per-fix consent loop. The runner never imports the embedder; eval/tsc/test/audit run as subprocesses.

**Tech Stack:** TypeScript, `better-sqlite3`, `sqlite-vec`, `tsx` (script runner), `vitest` (tests, embedder mocked). Source of truth: `docs/2026-06-22-doctor-repair-prd.md`.

## Global Constraints

- **Honesty invariant (the spine):** the composed verdict is `PASS` only when every check actually ran and passed. A check that could not run resolves `INCONCLUSIVE`, never silently `PASS`. Precedence: `FAIL > INCONCLUSIVE > PASS`. `ADVISORY` is excluded from composition by construction.
- **Verdict vocabulary:** reuse the eval gate's words. Per-check status is one of `PASS` / `FAIL` / `INCONCLUSIVE` / `ADVISORY`. The eval gate's 4th verdict `CAPTURING` (returned by `npm run eval` when no baseline exists yet) maps to doctor's `INCONCLUSIVE` — same no-baseline root cause as the baseline-present check.
- **Subprocess boundary:** eval, tsc, test, and `npm audit` run as **subprocesses** (`npm run eval`, `tsc --noEmit`/`npm run build`, `npm test`, `npm audit --json`) and their structured output is parsed. Never import the eval/embedder internals into doctor's process (avoids the onnxruntime-node cleanup SIGABRT and the 400MB embedder load).
- **`npm audit fix --force` is NEVER invoked** by doctor or repair under any flag.
- **Repair is confirm-then-apply, session-gated:** default mode is diagnosis (read-only). `--fix` is opt-in and refused headless. Every mutating fix backs up its target first; preconditions are re-verified at apply-time; `recapture-baseline` proceeds only on a code-verified fresh `PASS`. Destructive operations never auto-run.
- **Report-only set (never mutated by doctor):** `npm audit`/vitest drift, build/test failures, the #82 retrieval gap.
- **Reuse, don't reimplement:** `isV3Schema`, `backupDb`/`verifyBackup` (`migrations.ts`), `countMissingVectors`/`vectorCoverageSweep` (`indexer.ts`), `isStale`/`defaultLockPath` (`election.ts`), `chunkFile` (`chunker.ts`), `composeVerdict`/`isCutoverBoundary` (`eval.ts`) are read through existing modules.
- **DB path:** read `CLAUDE_OS_DB_PATH`, default `DEFAULT_DB_PATH` (`~/.claude-data/memory.db`), matching the eval/migrate/cutover scripts.
- **No new persistent machine state:** every check reads existing artifacts; every fix writes to a store that already exists. The only provisioning is the `doctor` npm script line and the `skills/doctor/` install — no new `update.sh` step.
- **Test convention:** vitest; `mkdtempSync` temp dirs; fixture DBs via `openDb(dbPath)`; embedder mocked via `vi.mock("../src/embedder.js", ...)` returning `new Float32Array(768).fill(0)`; pre-C2 v2 fixtures built by raw `CREATE TABLE observations (...)` without an `anchor` column (pattern in `migrations.test.ts:42-60`).

**Interface reconciliation notes (resolved across the independently-drafted phases):**
- The broken-label probe is exported from `eval_inspect.ts` as **`resolveRelevantIds`** (descriptive rename of the original private `resolveRelevant`). Every consumer (Phase 2 Task 4, Phase 3 Task 1) uses `resolveRelevantIds`.
- `doctor.ts` exports **`diagnose(ctx)`**, **`runChecks(ctx)`**, and **`composeVerdict(results)`**. The Phase 3 runner consumes `diagnose` and `composeVerdict` (NOT the earlier-drafted `runAllChecks`/`composeDoctorVerdict` names).

---

## Phase 1 — Eval-gate inspector extraction

This phase lifts the three DB-reading eval-gate inspectors out of the eval *script* into a new pure module, `mcp/src/eval_inspect.ts`, that both `mcp/src/scripts/eval.ts` and (later) `mcp/src/doctor.ts` import. Scope is exactly the helpers doctor needs — no broader refactor (PRD: *"Scope is limited to the helpers doctor needs"*).

**Why `mcp/src/eval_inspect.ts` and not `mcp/src/eval.ts`.** `mcp/src/eval.ts` is documented as DB-free pure metrics (`eval.ts:1-2`). These inspectors take a `better-sqlite3` `Database.Database` — adding them to `eval.ts` would break that no-DB invariant. A sibling `eval_inspect.ts` keeps the metrics module pure while giving doctor and the eval script one shared inspector surface.

**Why the baseline reader/writer stay in `scripts/eval.ts` and are re-exported, not relocated.** `readBaseline`/`writeBaseline`/`type Baseline` already export from `scripts/eval.ts` and are imported under that path by `eval-runner.test.ts:5`. Relocating their definitions would force editing that test's import — wider than scope allows. `eval_inspect.ts` re-exports them so doctor has one import surface while the eval script keeps the definitions and the existing test keeps its import path.

### Task 1: Extract the three DB inspectors into `mcp/src/eval_inspect.ts` and re-point the eval script

**Files:**
- Create: `mcp/src/eval_inspect.ts`
- Modify: `mcp/src/scripts/eval.ts` — delete the three private function bodies (`resolveRelevant` at `:113-120`, `distinctSourcePaths` at `:124-128`, `chunkingEnabled` at `:135-140`); add an import of all three (under the renamed `resolveRelevantIds`) from `../eval_inspect.js`; update the local call site at `:191` from `resolveRelevant(` to `resolveRelevantIds(`. Call sites at `:231` (`distinctSourcePaths`) and `:233` (`chunkingEnabled`) are unchanged.
- Test: Create `mcp/test/eval-inspect.test.ts`

**Interfaces:**
- Consumes: `Database.Database` (a DB whose `observations`/`meta` tables follow `mcp/src/db.ts:46-63, 142-145`). Re-exports the baseline surface from `../scripts/eval.js`: `readBaseline`, `writeBaseline`, `type Baseline`.
- Produces (exact signatures — downstream tasks import these verbatim):
  ```ts
  export function resolveRelevantIds(db: Database.Database, substrings: string[]): number[]
  export function distinctSourcePaths(db: Database.Database): string[]
  export function chunkingEnabled(db: Database.Database): boolean
  export { readBaseline, writeBaseline, type Baseline } from "./scripts/eval.js"
  ```

- [ ] **Step 1: Write the failing test.** Create `mcp/test/eval-inspect.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  resolveRelevantIds,
  distinctSourcePaths,
  chunkingEnabled,
  readBaseline,
} from "../src/eval_inspect.js";

let workDir: string;
let dbPath: string;
let db: Database.Database;

function seedObs(database: Database.Database, sourcePath: string, anchor = ""): void {
  database
    .prepare(
      `INSERT INTO observations
         (source_type, source_path, anchor, content, content_hash, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("learning", sourcePath, anchor, "body", "h", 0, 0);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-eval-inspect-"));
  dbPath = join(workDir, "test.db");
  db = openDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("resolveRelevantIds (broken-labels probe)", () => {
  it("returns ids of observations whose source_path contains any substring", () => {
    seedObs(db, "a/learnings.md");
    seedObs(db, "b/jira.md");
    seedObs(db, "c/github.md");
    expect(resolveRelevantIds(db, ["learnings", "github"]).sort((x, y) => x - y)).toEqual([1, 3]);
  });
  it("is empty when no source_path matches (the dead-label signal)", () => {
    seedObs(db, "a/learnings.md");
    expect(resolveRelevantIds(db, ["does-not-exist"])).toEqual([]);
  });
  it("uses case-sensitive literal instr() — no case fold", () => {
    seedObs(db, "a/Learnings.md");
    expect(resolveRelevantIds(db, ["learnings"])).toEqual([]);
  });
  it("dedupes ids when several substrings match the same row", () => {
    seedObs(db, "a/jira-and-github.md");
    expect(resolveRelevantIds(db, ["jira", "github"])).toEqual([1]);
  });
});

describe("distinctSourcePaths (corpus distinct-file query)", () => {
  it("is granularity-invariant: a chunk-split adds rows but not distinct paths", () => {
    seedObs(db, "a/x.md", "h2-one");
    seedObs(db, "a/x.md", "h2-two");
    seedObs(db, "b/y.md");
    expect(distinctSourcePaths(db).sort()).toEqual(["a/x.md", "b/y.md"]);
  });
  it("is empty on an empty corpus", () => {
    expect(distinctSourcePaths(db)).toEqual([]);
  });
});

describe("chunkingEnabled (c2_chunking_enabled marker reader)", () => {
  it("is false when the meta marker is absent", () => {
    expect(chunkingEnabled(db)).toBe(false);
  });
  it("is true only when the marker is exactly '1'", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '1')").run();
    expect(chunkingEnabled(db)).toBe(true);
  });
  it("is false for any non-'1' marker value", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '0')").run();
    expect(chunkingEnabled(db)).toBe(false);
  });
});

describe("re-exported baseline surface", () => {
  it("readBaseline is reachable through eval_inspect and returns null when absent", () => {
    expect(readBaseline(join(workDir, "nope.json"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**
  Run: `cd mcp && npx vitest run test/eval-inspect.test.ts`
  Expected: import-resolution failure — `Error: Failed to load url ../src/eval_inspect.js`, `1 failed`.

- [ ] **Step 3: Write minimal implementation.** Create `mcp/src/eval_inspect.ts` (the three bodies moved verbatim from `scripts/eval.ts:113-140`, renaming `resolveRelevant`→`resolveRelevantIds`):

```ts
// Shared eval-gate INSPECTION helpers: the DB-reading probes the offline eval
// script and the doctor registry both need, lifted here so the two never diverge.
// Kept separate from src/eval.ts (deliberately DB-free pure metrics) so that
// module's no-DB invariant holds. Scope is exactly the helpers doctor needs.
import type Database from "better-sqlite3";

// Baseline reader/writer still LIVE in scripts/eval.ts (eval-runner.test imports them
// from there). Re-export so doctor pulls its whole eval-gate surface from one module.
export { readBaseline, writeBaseline, type Baseline } from "./scripts/eval.js";

// Broken-labels probe. Returns every observation whose source_path contains any
// expected substring; the caller checks whether this is empty (labels match nothing).
// Uses instr() (case-sensitive, literal substring) — same semantics as the file-level
// scorer's String.includes — so a label can never pass this probe yet be unhittable.
export function resolveRelevantIds(db: Database.Database, substrings: string[]): number[] {
  const ids = new Set<number>();
  const stmt = db.prepare("SELECT id FROM observations WHERE instr(source_path, ?) > 0");
  for (const s of substrings) {
    for (const row of stmt.all(s) as { id: number }[]) ids.add(row.id);
  }
  return [...ids];
}

// The corpus's distinct file set. Granularity-invariant: a chunk-split adds rows but
// not distinct source_paths.
export function distinctSourcePaths(db: Database.Database): string[] {
  return (db.prepare("SELECT DISTINCT source_path FROM observations").all() as {
    source_path: string;
  }[]).map((r) => r.source_path);
}

// Whether chunking is enabled on this index (meta.c2_chunking_enabled). Default '0'
// (off) when the meta row is absent.
export function chunkingEnabled(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'c2_chunking_enabled'").get() as
    | { value: string }
    | undefined;
  return row?.value === "1";
}
```

  Then in `mcp/src/scripts/eval.ts`: delete the three private definitions and their doc-comments (`:113-120`, `:124-128`, `:135-140`), add beside the existing `../eval.js` import (~`:43`):
  ```ts
  import { resolveRelevantIds, distinctSourcePaths, chunkingEnabled } from "../eval_inspect.js";
  ```
  and change the call site at `:191` from `resolveRelevant(` to `resolveRelevantIds(`. Leave `readBaseline`/`writeBaseline`/`Baseline` defined in `scripts/eval.ts` (`:68-97`) as-is.

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/eval-inspect.test.ts test/eval.test.ts test/eval-runner.test.ts`
  Expected: `Test Files  3 passed (3)` — the new inspector suite plus the existing eval suites (proving the re-point left behavior intact).
  Then: `cd mcp && npx tsc --noEmit` — Expected: no output, exit 0.

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/eval_inspect.ts src/scripts/eval.ts test/eval-inspect.test.ts
  git commit -m "Extract eval-gate DB inspectors into shared eval_inspect module"
  ```

### Task 2: Regression test — the eval script composes IDENTICAL verdicts after extraction

PRD mandate: a regression test that the eval script still composes identical verdicts after the extraction. The test reconstructs the eval script's verdict pipeline (`scripts/eval.ts:191, 231-233, 286-292`) but sources its DB-derived inputs from the *new module*, and pins the composed verdicts — including the 2026-06-22 single-dead-label `INCONCLUSIVE` that motivated the PRD.

**Files:**
- Test: Create `mcp/test/eval-inspect-regression.test.ts`
- Modify: none

**Interfaces:**
- Consumes: `resolveRelevantIds`, `distinctSourcePaths`, `chunkingEnabled` (from `../src/eval_inspect.js`); `fileSetHash`, `isCutoverBoundary`, `isFileSetShapeChange`, `presenceVerdict`, `composeVerdict`, `type PresenceMetrics` (from `../src/eval.js`).
- Produces: a verification artifact only.

- [ ] **Step 1: Write the failing test.** Create `mcp/test/eval-inspect-regression.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { resolveRelevantIds, distinctSourcePaths, chunkingEnabled } from "../src/eval_inspect.js";
import {
  fileSetHash,
  isCutoverBoundary,
  isFileSetShapeChange,
  presenceVerdict,
  composeVerdict,
  type PresenceMetrics,
} from "../src/eval.js";

let workDir: string;
let db: Database.Database;

function seedObs(database: Database.Database, sourcePath: string, anchor = ""): void {
  database
    .prepare(
      `INSERT INTO observations
         (source_type, source_path, anchor, content, content_hash, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("learning", sourcePath, anchor, "body", "h", 0, 0);
}

// Replicates the eval script's verdict pipeline, sourcing every DB-derived input from
// the extracted module. If the extraction changed any inspector's behavior, the composed
// verdict here would differ from the pinned value.
function composeViaInspectors(
  database: Database.Database,
  labels: string[],
  current: PresenceMetrics,
  baseline: PresenceMetrics,
  baselineChunking: boolean,
  baselineFileSetHash: string,
): string {
  const brokenLabels = resolveRelevantIds(database, labels).length === 0;
  const currentHash = fileSetHash(distinctSourcePaths(database));
  const currentChunking = chunkingEnabled(database);
  const presence = presenceVerdict(current, baseline, brokenLabels);
  const boundary = isCutoverBoundary(baselineChunking, currentChunking);
  const shapeChanged = isFileSetShapeChange(baselineFileSetHash, currentHash, boundary);
  return composeVerdict(presence, [], shapeChanged);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-eval-regress-"));
  db = openDb(join(workDir, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("verdict composition is identical through the extracted inspectors", () => {
  const baseMetrics: PresenceMetrics = { meanRecallAtK: 0.27, mrr: 0.5 };

  it("a single dead label drives INCONCLUSIVE (the 2026-06-22 recovery scenario)", () => {
    seedObs(db, "context/jira.md");
    const hash = fileSetHash(distinctSourcePaths(db));
    expect(
      composeViaInspectors(
        db,
        ["jira", "pruned-episode-2026-06-17"],
        { meanRecallAtK: 0.76, mrr: 0.9 },
        baseMetrics,
        false,
        hash,
      ),
    ).toBe("INCONCLUSIVE");
  });

  it("all labels live + non-regressing metrics, no cutover boundary => PASS", () => {
    seedObs(db, "context/jira.md");
    seedObs(db, "context/github.md");
    const hash = fileSetHash(distinctSourcePaths(db));
    expect(
      composeViaInspectors(db, ["jira", "github"], { meanRecallAtK: 0.8, mrr: 0.9 }, baseMetrics, false, hash),
    ).toBe("PASS");
  });

  it("metrics regress => FAIL", () => {
    seedObs(db, "context/jira.md");
    const hash = fileSetHash(distinctSourcePaths(db));
    expect(
      composeViaInspectors(db, ["jira"], { meanRecallAtK: 0.1, mrr: 0.1 }, baseMetrics, false, hash),
    ).toBe("FAIL");
  });

  it("at the cutover boundary, a changed file set escalates an otherwise-PASS to INCONCLUSIVE", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '1')").run();
    seedObs(db, "context/jira.md");
    seedObs(db, "context/new-after-cutover.md");
    expect(
      composeViaInspectors(
        db,
        ["jira"],
        { meanRecallAtK: 0.8, mrr: 0.9 },
        baseMetrics,
        false,
        fileSetHash(["context/jira.md"]),
      ),
    ).toBe("INCONCLUSIVE");
  });

  it("post-cutover (both chunked) off the boundary, file churn does NOT escalate => PASS", () => {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('c2_chunking_enabled', '1')").run();
    seedObs(db, "context/jira.md");
    seedObs(db, "context/added-later.md");
    expect(
      composeViaInspectors(
        db,
        ["jira"],
        { meanRecallAtK: 0.8, mrr: 0.9 },
        baseMetrics,
        true,
        fileSetHash(["context/jira.md"]),
      ),
    ).toBe("PASS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (RED on a deliberate inspector break).** Temporarily break `chunkingEnabled` in `mcp/src/eval_inspect.ts` — change `return row?.value === "1";` to `return false;` — then:
  Run: `cd mcp && npx vitest run test/eval-inspect-regression.test.ts`
  Expected: the boundary-escalation case goes red — `AssertionError: expected 'PASS' to be 'INCONCLUSIVE'`, `1 failed`.
  Then revert the one-line break (restore `return row?.value === "1";`).

- [ ] **Step 3: Write minimal implementation.** None — the production code is already correct from Task 1; the deliberate break in Step 2 was reverted. (This step keeps the TDD cadence explicit: the regression test guards the un-broken Task 1 module.)

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/eval-inspect-regression.test.ts test/eval-inspect.test.ts test/eval.test.ts test/eval-runner.test.ts`
  Expected: `Test Files  4 passed (4)`.

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add test/eval-inspect-regression.test.ts
  git commit -m "Add regression test pinning identical eval verdicts after inspector extraction"
  ```

---

## Phase 2 — Doctor check registry (pure logic)

Builds `mcp/src/doctor.ts`: the registry of independent, unit-testable checks plus the verdict composer. Depends only on Phase 1's `eval_inspect.ts` and existing primitives. The honesty invariant is proven in Task 1 before any individual check exists.

Design constraints in every check task:
- Every check is `(ctx) => CheckResult` (sync) or `(ctx) => Promise<CheckResult>` (subprocess-backed). Each wraps its body in `safeCheck`, whose failure branch returns `INCONCLUSIVE` — never throws, never silently `PASS`.
- Subprocess-backed checks (eval, npm audit, tsc, test) take an **injected runner** so unit tests never spawn a real process. The runner's non-zero/throw path is the check's `INCONCLUSIVE` branch.
- `ADVISORY` is excluded from composition by construction.

### Task 3: CheckResult/Remediation interfaces + verdict composition + honesty invariant

**Files:**
- Create: `mcp/src/doctor.ts`
- Test: Create `mcp/test/doctor.test.ts`

**Interfaces:**
- Consumes: nothing (pure). Mirrors the literal-branch style of `composeVerdict` in `mcp/src/eval.ts:179-190`.
- Produces (canonical types reused verbatim by every later task):
  ```ts
  export type CheckStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "ADVISORY";
  export type DoctorVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";
  export interface Remediation { id: string; description: string; command?: string; }
  export interface CheckResult { id: string; status: CheckStatus; detail: string; fixable: boolean; remediation?: Remediation; }
  export function composeVerdict(results: CheckResult[]): DoctorVerdict;
  export async function safeCheck(id: string, fn: () => CheckResult | Promise<CheckResult>): Promise<CheckResult>;
  // plus the DoctorContext / Check / runner-seam types below.
  ```

- [ ] **Step 1: Write the failing test.** Create `mcp/test/doctor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { composeVerdict, safeCheck, type CheckResult } from "../src/doctor.js";

const r = (status: CheckResult["status"]): CheckResult =>
  ({ id: "x", status, detail: "", fixable: false });

describe("composeVerdict — FAIL > INCONCLUSIVE > PASS, ADVISORY excluded", () => {
  it("all PASS => PASS", () => {
    expect(composeVerdict([r("PASS"), r("PASS")])).toBe("PASS");
  });
  it("any FAIL => FAIL even with INCONCLUSIVE present", () => {
    expect(composeVerdict([r("PASS"), r("INCONCLUSIVE"), r("FAIL")])).toBe("FAIL");
  });
  it("any INCONCLUSIVE (no FAIL) => INCONCLUSIVE", () => {
    expect(composeVerdict([r("PASS"), r("INCONCLUSIVE")])).toBe("INCONCLUSIVE");
  });
  it("ADVISORY never reddens the verdict", () => {
    expect(composeVerdict([r("PASS"), r("ADVISORY")])).toBe("PASS");
  });
  it("a lone ADVISORY composes PASS", () => {
    expect(composeVerdict([r("ADVISORY")])).toBe("PASS");
  });
});

describe("THE HONESTY INVARIANT — a check that cannot run is INCONCLUSIVE, poisoning the verdict, never PASS", () => {
  it("safeCheck turns a thrown error into INCONCLUSIVE", async () => {
    const res = await safeCheck("eval/last-verdict", () => {
      throw new Error("eval subprocess exited 1");
    });
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.detail).toMatch(/eval subprocess exited 1/);
    expect(res.fixable).toBe(false);
  });
  it("an underlying op that throws makes the COMPOSED verdict INCONCLUSIVE while every other check passed", async () => {
    const broken = await safeCheck("corpus/integrity", () => {
      throw new Error("database is locked");
    });
    const verdict = composeVerdict([r("PASS"), r("PASS"), broken]);
    expect(verdict).toBe("INCONCLUSIVE");
    expect(verdict).not.toBe("PASS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts`
  Expected: `Error: Failed to load url ../src/doctor.js`, `1 failed`.

- [ ] **Step 3: Write minimal implementation.** Create `mcp/src/doctor.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts`
  Expected: 7 tests green (5 composition + 2 honesty).

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/doctor.ts test/doctor.test.ts
  git commit -m "doctor: verdict composition + honesty invariant (CheckResult/Remediation)"
  ```

> **Shared test helper (used by Tasks 4–12).** Add this `seed` helper near the top of `doctor.test.ts` after the Task 3 suites; later tasks reference it:
> ```ts
> import { openDb } from "../src/db.js";
> function seed(db: import("better-sqlite3").Database, paths: string[], type = "context"): void {
>   const ins = db.prepare(`INSERT INTO observations
>     (source_type, source_path, anchor, parent_title, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
>     VALUES (?, ?, '', NULL, NULL, NULL, 'T', 'body', ?, 1, 2, NULL)`);
>   paths.forEach((p, i) => ins.run(type, p, "h" + i));
> }
> ```

### Task 4: Eval-gate checks — baseline-present, baseline-stale, corpus-snapshot, broken-labels, last-verdict

**Files:**
- Modify: `mcp/src/doctor.ts`
- Test: `mcp/test/doctor.test.ts`

**Interfaces:**
- Consumes from `eval_inspect.ts`: `readBaseline(path): Baseline | null`, `resolveRelevantIds(db, substrings): number[]`, `distinctSourcePaths(db): string[]`, `chunkingEnabled(db): boolean`. From `eval.ts`: `isCutoverBoundary(baselineChunking, currentChunking): boolean`. Plus an injected `EvalRunner` (Task 3 type) for the last-verdict check.
- Produces: `checkBaselinePresent`, `checkBaselineStale`, `checkCorpusSnapshot`, `checkBrokenLabels`, `checkLastVerdict` — each `(ctx) => Promise<CheckResult>`.

Notes: broken-labels keys on **matches-zero-rows**, never **scores-zero-recall** (the held-out doctrine — dropping a low-recall label would curate the gate to pass, which the protocol forbids). The last-verdict check maps eval `CAPTURING` → doctor `INCONCLUSIVE` (the amendment).

- [ ] **Step 1: Write the failing test.** Append to `doctor.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBaselinePresent, checkBaselineStale, checkCorpusSnapshot,
  checkBrokenLabels, checkLastVerdict,
} from "../src/doctor.js";

const evalRunner = (r: any) => () => Promise.resolve(r);

describe("eval-gate checks", () => {
  let dir: string, db: any, dbPath: string, baselinePath: string, labelsPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-eval-"));
    dbPath = join(dir, "memory.db");
    db = openDb(dbPath);
    seed(db, ["/a.md", "/b.md", "/c.md"]);
    baselinePath = join(dir, "eval-baseline.json");
    labelsPath = join(dir, "labeled-queries.json");
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("baseline absent => INCONCLUSIVE, fixable", async () => {
    const res = await checkBaselinePresent({ baselinePath } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.fixable).toBe(true);
  });
  it("baseline present => PASS", async () => {
    writeFileSync(baselinePath, JSON.stringify({ corpus: { chunking_enabled: true } }));
    expect((await checkBaselinePresent({ baselinePath } as any)).status).toBe("PASS");
  });
  it("baseline chunking=false while live chunked => FAIL fixable by recapture-baseline", async () => {
    writeFileSync(baselinePath, JSON.stringify({ corpus: { chunking_enabled: false } }));
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('c2_chunking_enabled','1')").run();
    const res = await checkBaselineStale({ db, baselinePath } as any);
    expect(res.status).toBe("FAIL");
    expect(res.remediation?.id).toBe("recapture-baseline");
  });
  it("baseline chunking matches live => PASS (guard retired)", async () => {
    writeFileSync(baselinePath, JSON.stringify({ corpus: { chunking_enabled: true } }));
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('c2_chunking_enabled','1')").run();
    expect((await checkBaselineStale({ db, baselinePath } as any)).status).toBe("PASS");
  });
  it("corpus_snapshot mismatch vs live COUNT(DISTINCT) => FAIL fixable, names both numbers", async () => {
    writeFileSync(labelsPath, JSON.stringify({ curation: { corpus_snapshot: 387 } }));
    const res = await checkCorpusSnapshot({ db, labelsPath } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/387/);
    expect(res.detail).toMatch(/\b3\b/);
    expect(res.remediation?.id).toBe("recompute-corpus-snapshot");
  });
  it("corpus_snapshot matching live => PASS", async () => {
    writeFileSync(labelsPath, JSON.stringify({ curation: { corpus_snapshot: 3 } }));
    expect((await checkCorpusSnapshot({ db, labelsPath } as any)).status).toBe("PASS");
  });
  it("a label matching 0 rows => INCONCLUSIVE fixable, names the dead query + substring", async () => {
    writeFileSync(labelsPath, JSON.stringify({ queries: [
      { query: "find a", expectedPathContains: ["/a.md"] },
      { query: "the pruned episode", expectedPathContains: ["episodes/2026-05-01"] },
    ]}));
    const res = await checkBrokenLabels({ db, labelsPath } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.fixable).toBe(true);
    expect(res.detail).toMatch(/the pruned episode/);
    expect(res.remediation?.id).toBe("drop-dead-label");
  });
  it("all labels resolve to >=1 row => PASS", async () => {
    writeFileSync(labelsPath, JSON.stringify({ queries: [{ query: "find a", expectedPathContains: ["/a.md"] }] }));
    expect((await checkBrokenLabels({ db, labelsPath } as any)).status).toBe("PASS");
  });
  it("eval PASS => PASS; FAIL => FAIL; INCONCLUSIVE => INCONCLUSIVE", async () => {
    expect((await checkLastVerdict({ runEval: evalRunner({ verdict: "PASS", ok: true }) } as any)).status).toBe("PASS");
    expect((await checkLastVerdict({ runEval: evalRunner({ verdict: "FAIL", ok: true }) } as any)).status).toBe("FAIL");
    expect((await checkLastVerdict({ runEval: evalRunner({ verdict: "INCONCLUSIVE", ok: true }) } as any)).status).toBe("INCONCLUSIVE");
  });
  it("AMENDMENT: eval CAPTURING => doctor INCONCLUSIVE, never PASS", async () => {
    const res = await checkLastVerdict({ runEval: evalRunner({ verdict: "CAPTURING", ok: true }) } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.status).not.toBe("PASS");
    expect(res.detail).toMatch(/baseline/i);
  });
  it("eval subprocess errored => INCONCLUSIVE with reason, never PASS", async () => {
    const res = await checkLastVerdict({ runEval: () => Promise.reject(new Error("eval exited 1")) } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.detail).toMatch(/eval exited 1/);
  });
  it("runner ok:false => INCONCLUSIVE", async () => {
    const res = await checkLastVerdict({ runEval: evalRunner({ verdict: "INCONCLUSIVE", ok: false, reason: "embedder failed" }) } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.detail).toMatch(/embedder failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "eval-gate checks"`
  Expected: `checkBaselinePresent is not a function` (and siblings).

- [ ] **Step 3: Write minimal implementation.** Append to `doctor.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "eval-gate checks"`
  Expected: all eval-gate tests green (including CAPTURING → INCONCLUSIVE).

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/doctor.ts test/doctor.test.ts
  git commit -m "doctor: eval-gate checks (baseline, snapshot, broken-labels, last-verdict w/ CAPTURING)"
  ```

### Task 5: Index/cutover checks — chunking-marker, schema-current, chunk-shape-divergence

**Files:**
- Modify: `mcp/src/doctor.ts`
- Test: `mcp/test/doctor.test.ts`

**Interfaces:**
- Consumes from `migrations.ts`: `isV3Schema(db): boolean`. From `chunker.ts`: `chunkFile({ sourceType, content, chunkingEnabled }): Chunk[]` (each `Chunk.anchor: string`). From `eval_inspect.ts`: `chunkingEnabled(db)`. From `db.ts`: `type SourceType`.
- Produces: `checkChunkingMarker`, `checkSchemaCurrent`, `checkChunkShapeDivergence` — each `(ctx) => Promise<CheckResult>`.

The divergence check re-derives the cutover error count from index state using the chunker as oracle. It **claims only divergence, not its cause** (a not-yet-reindexed edit diverges identically to a missed split) — it must never assert "cutover failed." Whole-file-correct source types must NOT be counted.

- [ ] **Step 1: Write the failing test.** Append to `doctor.test.ts`:

```ts
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { writeFileSync, mkdtempSync as mkd } from "node:fs";
import { checkChunkingMarker, checkSchemaCurrent, checkChunkShapeDivergence } from "../src/doctor.js";

const ONE_ENTRY = ["# L", "", "## 2026-01-10 — a", "", "body a", ""].join("\n");
const TWO_ENTRY = ["# L", "", "## 2026-01-10 — a", "", "body a", "", "## 2026-01-11 — b", "", "body b", ""].join("\n");

describe("index/cutover checks", () => {
  let dir: string, db: any, dbPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-idx-")); dbPath = join(dir, "memory.db"); db = openDb(dbPath); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function setMarker(on: boolean) { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('c2_chunking_enabled',?)").run(on ? "1" : "0"); }
  function indexAnchors(sourceType: string, path: string, content: string, anchors: string[]) {
    writeFileSync(path, content, "utf8");
    const ins = db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES (?,?,?,NULL,NULL,NULL,'T',?,?,1,2,NULL)`);
    anchors.forEach((a, i) => ins.run(sourceType, path, a, content, "h" + path + i));
  }

  it("marker on AND anchored rows exist => PASS", async () => {
    setMarker(true);
    db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES ('learning','/l.md','2026-01-10',NULL,NULL,NULL,'T','b','h',1,2,NULL)`).run();
    expect((await checkChunkingMarker({ db } as any)).status).toBe("PASS");
  });
  it("marker claims chunked but NO anchored rows => FAIL", async () => {
    setMarker(true);
    const res = await checkChunkingMarker({ db } as any);
    expect(res.status).toBe("FAIL");
  });
  it("marker off and no anchored rows => PASS", async () => {
    setMarker(false);
    expect((await checkChunkingMarker({ db } as any)).status).toBe("PASS");
  });

  it("fresh v3 DB => schema current => PASS", async () => {
    expect((await checkSchemaCurrent({ db } as any)).status).toBe("PASS");
  });
  it("pre-C2 v2 DB (no anchor column) => FAIL fixable by run-migrate", async () => {
    const v2dir = mkd(join(tmpdir(), "doctor-v2-"));
    const v2 = new Database(join(v2dir, "v2.db"));
    v2.pragma("journal_mode = WAL"); sqliteVec.load(v2);
    v2.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL,
      source_path TEXT NOT NULL, project TEXT, topic TEXT, title TEXT, frontmatter TEXT, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, file_mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL, UNIQUE(source_path));`);
    try {
      const res = await checkSchemaCurrent({ db: v2 } as any);
      expect(res.status).toBe("FAIL");
      expect(res.remediation?.id).toBe("run-migrate");
    } finally { v2.close(); rmSync(v2dir, { recursive: true, force: true }); }
  });

  it("indexed anchors match chunkFile output => divergence 0 => PASS", async () => {
    setMarker(true);
    indexAnchors("learning", join(dir, "match.md"), TWO_ENTRY, ["2026-01-10 — a", "2026-01-11 — b"]);
    expect((await checkChunkShapeDivergence({ db } as any)).status).toBe("PASS");
  });
  it("an episode indexed whole-file (anchor '') does NOT count as divergence", async () => {
    setMarker(true);
    indexAnchors("episode", join(dir, "ep.md"), "# E\n\nsome episode body", [""]);
    expect((await checkChunkShapeDivergence({ db } as any)).status).toBe("PASS");
  });
  it("on-disk content grew a dated entry the index lacks => divergence 1 => FAIL, never claims cutover failed", async () => {
    setMarker(true);
    const p = join(dir, "drift.md");
    indexAnchors("learning", p, ONE_ENTRY, ["2026-01-10 — a"]);
    writeFileSync(p, TWO_ENTRY, "utf8");
    const res = await checkChunkShapeDivergence({ db } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/1\b/);
    expect(res.detail).not.toMatch(/cutover failed/i);
  });
});
```

> **Anchor-format pin (do this during Step 1):** the test's `indexAnchors` anchor strings must match exactly what `chunkByEntries` emits for `TWO_ENTRY`. Before finalizing, run a one-off: `cd mcp && npx tsx -e "import {chunkFile} from './src/chunker.js'; console.log(chunkFile({sourceType:'learning',content:'# L\n\n## 2026-01-10 — a\n\nbody a\n\n## 2026-01-11 — b\n\nbody b\n',chunkingEnabled:true}).map(c=>c.anchor))"` and substitute the printed anchors into the test. If they are bare dates (`2026-01-10`), use those.

- [ ] **Step 2: Run test to verify it fails.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "index/cutover checks"`
  Expected: the three functions are undefined.

- [ ] **Step 3: Write minimal implementation.** Append to `doctor.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "index/cutover checks"`
  Expected: 8 tests green (including the whole-file no-false-positive case).

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/doctor.ts test/doctor.test.ts
  git commit -m "doctor: chunking-marker, schema-current, chunk-shape-divergence checks"
  ```

### Task 6: Corpus checks — integrity, corpus-shape, orphan-embeddings, expected-context-files

**Files:**
- Modify: `mcp/src/doctor.ts`
- Test: `mcp/test/doctor.test.ts`

**Interfaces:**
- Consumes: `db.pragma("integrity_check", { simple: true })`; live `COUNT(*)`/`COUNT(DISTINCT source_path)`; `countMissingVectors(db)` from `indexer.ts`; `readdirSync` of `<repoRoot>/context-templates/` compared against indexed `context/*` source_paths.
- Produces: `checkIntegrity`, `checkCorpusShape`, `checkOrphanEmbeddings`, `checkExpectedContextFiles` — each `(ctx) => Promise<CheckResult>`.

- [ ] **Step 1: Write the failing test.** Append to `doctor.test.ts`:

```ts
import { mkdirSync } from "node:fs";
import { checkIntegrity, checkCorpusShape, checkOrphanEmbeddings, checkExpectedContextFiles } from "../src/doctor.js";

function vec(fill: number) { const v = new Float32Array(768).fill(fill); return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }

describe("corpus checks", () => {
  let dir: string, db: any, dbPath: string, repoRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-corpus-")); dbPath = join(dir, "memory.db"); db = openDb(dbPath);
    repoRoot = join(dir, "repo"); mkdirSync(join(repoRoot, "context-templates"), { recursive: true });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function seedContext(name: string) {
    return db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES ('context',?, '',NULL,NULL,NULL,'T','b',?,1,2,NULL)`).run("/data/context/" + name, "h" + name).lastInsertRowid;
  }

  it("integrity_check ok => PASS", async () => {
    expect((await checkIntegrity({ db } as any)).status).toBe("PASS");
  });
  it("empty corpus => FAIL", async () => {
    const res = await checkCorpusShape({ db } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/empty/i);
  });
  it("non-empty corpus => PASS", async () => {
    seedContext("java.md"); seedContext("github.md");
    expect((await checkCorpusShape({ db } as any)).status).toBe("PASS");
  });
  it("every observation has a vec_items row => PASS", async () => {
    const id = seedContext("a.md");
    db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?,?)").run(BigInt(id), vec(0.1));
    expect((await checkOrphanEmbeddings({ db } as any)).status).toBe("PASS");
  });
  it("an observation with no vec_items row => FAIL fixable by re-embed", async () => {
    seedContext("a.md");
    const res = await checkOrphanEmbeddings({ db } as any);
    expect(res.status).toBe("FAIL");
    expect(res.remediation?.id).toBe("re-embed");
  });
  it("a template whose context copy is absent from the index => FAIL naming the missing file", async () => {
    writeFileSync(join(repoRoot, "context-templates", "java.md"), "x");
    writeFileSync(join(repoRoot, "context-templates", "github.md"), "x");
    seedContext("java.md");
    const res = await checkExpectedContextFiles({ db, repoRoot } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/github\.md/);
  });
  it("every template present in the index => PASS", async () => {
    writeFileSync(join(repoRoot, "context-templates", "java.md"), "x");
    seedContext("java.md");
    expect((await checkExpectedContextFiles({ db, repoRoot } as any)).status).toBe("PASS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "corpus checks"`
  Expected: functions undefined.

- [ ] **Step 3: Write minimal implementation.** Append to `doctor.ts`:

```ts
import { readdirSync } from "node:fs";
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
```
(`join` is already imported in `doctor.ts` via the eval-gate task's `node:path` import; if not, add `import { join } from "node:path";`.)

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "corpus checks"`
  Expected: 7 tests green.

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/doctor.ts test/doctor.test.ts
  git commit -m "doctor: integrity, corpus-shape, orphan-embeddings, expected-context checks"
  ```

### Task 7: Election + dependency/build + backup + advisory checks

**Files:**
- Modify: `mcp/src/doctor.ts`
- Test: `mcp/test/doctor.test.ts`

**Interfaces:**
- Consumes from `election.ts`: `isStale(lockPath, now)`, `HEARTBEAT_REFRESH_MS`, `STALENESS_MULTIPLE`. Injected `AuditRunner`/`SubprocessRunner` (Task 3 types). Glob of the DB directory for backups.
- Produces: `checkStaleLock`, `checkNpmAudit`, `checkBuild`, `checkTestSuite`, `checkBackupPresent`, `checkAdvisorySingleRowContext` — each `(ctx) => Promise<CheckResult>`.

Hard rule baked in: no remediation or command ever contains `--force`. `tsc`/`test` are `ADVISORY` when `ctx.full` is false (deferred ≠ couldn't-run), else `PASS`/`FAIL`/`INCONCLUSIVE`. The advisory check is always `ADVISORY`.

- [ ] **Step 1: Write the failing test.** Append to `doctor.test.ts`:

```ts
import { utimesSync } from "node:fs";
import { HEARTBEAT_REFRESH_MS, STALENESS_MULTIPLE } from "../src/election.js";
import {
  checkStaleLock, checkNpmAudit, checkBuild, checkTestSuite,
  checkBackupPresent, checkAdvisorySingleRowContext,
} from "../src/doctor.js";

const auditRunner = (r: any) => () => Promise.resolve(r);
const subRunner = (r: any) => () => Promise.resolve(r);

describe("election / deps / backup / advisory checks", () => {
  let dir: string, db: any, dbPath: string, lockPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-misc-")); dbPath = join(dir, "memory.db"); db = openDb(dbPath); lockPath = join(dir, "memory.db.writer.lock.d"); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("no lock dir => PASS", async () => {
    expect((await checkStaleLock({ lockPath, now: 1_000_000 } as any)).status).toBe("PASS");
  });
  it("stale lock => FAIL fixable by clear-stale-lock", async () => {
    mkdirSync(lockPath);
    const now = 100 * HEARTBEAT_REFRESH_MS;
    const old = (now - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 5000)) / 1000;
    utimesSync(lockPath, old, old);
    const res = await checkStaleLock({ lockPath, now } as any);
    expect(res.status).toBe("FAIL");
    expect(res.remediation?.id).toBe("clear-stale-lock");
  });
  it("fresh lock => PASS", async () => {
    mkdirSync(lockPath);
    const now = 100 * HEARTBEAT_REFRESH_MS;
    utimesSync(lockPath, now / 1000, now / 1000);
    expect((await checkStaleLock({ lockPath, now } as any)).status).toBe("PASS");
  });

  it("npm audit with vulns => ADVISORY, never offers --force, names #84", async () => {
    const res = await checkNpmAudit({ runAudit: auditRunner({ ok: true, vulnerabilities: { critical: 1, high: 1, moderate: 0, low: 0 }, devOnly: true }) } as any);
    expect(res.status).toBe("ADVISORY");
    expect(res.fixable).toBe(false);
    expect(res.detail).toMatch(/1 critical/);
    expect(res.detail).toMatch(/#84/);
    expect(res.detail).not.toMatch(/--force/);
  });
  it("npm audit itself failed => INCONCLUSIVE, never PASS", async () => {
    expect((await checkNpmAudit({ runAudit: auditRunner({ ok: false, reason: "registry unreachable" }) } as any)).status).toBe("INCONCLUSIVE");
  });
  it("tsc/test are ADVISORY when --full off", async () => {
    expect((await checkBuild({ full: false } as any)).status).toBe("ADVISORY");
    expect((await checkTestSuite({ full: false } as any)).status).toBe("ADVISORY");
  });
  it("tsc passes under --full => PASS; test fails => FAIL; can't-run => INCONCLUSIVE", async () => {
    expect((await checkBuild({ full: true, runBuild: subRunner({ ok: true, passed: true }) } as any)).status).toBe("PASS");
    expect((await checkTestSuite({ full: true, runTest: subRunner({ ok: true, passed: false }) } as any)).status).toBe("FAIL");
    expect((await checkBuild({ full: true, runBuild: subRunner({ ok: false, passed: false, reason: "tsc missing" }) } as any)).status).toBe("INCONCLUSIVE");
  });

  it("a .pre-cutover backup present => PASS; a .pre-c2.bak => PASS; none => FAIL", async () => {
    writeFileSync(dbPath + ".pre-cutover.20260622T120000Z.bak", "x");
    expect((await checkBackupPresent({ dbPath } as any)).status).toBe("PASS");
    rmSync(dbPath + ".pre-cutover.20260622T120000Z.bak");
    writeFileSync(dbPath + ".pre-c2.bak", "x");
    expect((await checkBackupPresent({ dbPath } as any)).status).toBe("PASS");
    rmSync(dbPath + ".pre-c2.bak");
    expect((await checkBackupPresent({ dbPath } as any)).status).toBe("FAIL");
  });

  it("single-row context standing condition is ADVISORY, references #82", async () => {
    db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES ('context','/data/context/tiny.md','',NULL,NULL,NULL,'T','b','h',1,2,NULL)`).run();
    const res = await checkAdvisorySingleRowContext({ db } as any);
    expect(res.status).toBe("ADVISORY");
    expect(res.detail).toMatch(/#82/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "election / deps"`
  Expected: functions undefined.

- [ ] **Step 3: Write minimal implementation.** Append to `doctor.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "election / deps"`
  Expected: 9 tests green.

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/doctor.ts test/doctor.test.ts
  git commit -m "doctor: stale-lock, npm-audit, tsc/test, backup, single-row-context advisory checks"
  ```

### Task 8: Registry assembly + diagnose() end-to-end composition

**Files:**
- Modify: `mcp/src/doctor.ts`
- Test: `mcp/test/doctor.test.ts`

**Interfaces:**
- Consumes every `check*` function above.
- Produces: `export const CHECKS: Check[]`, `export async function runChecks(ctx): Promise<CheckResult[]>`, `export async function diagnose(ctx): Promise<{ results: CheckResult[]; verdict: DoctorVerdict }>`. This is what the Phase 3 runner consumes.

- [ ] **Step 1: Write the failing test.** Append a `buildHealthyCtx()` helper that assembles every dependency in a healthy state (v3 DB with ≥1 context file + matching vec_items, baseline present + chunked, matching corpus_snapshot, valid labels, a fresh lock dir, a backup file, a `context-templates/` matching the indexed files, and injected `runEval: () => Promise.resolve({verdict:"PASS",ok:true})`, `runAudit: () => Promise.resolve({ok:true,vulnerabilities:{critical:0,high:0,moderate:0,low:0}})`, `runBuild`/`runTest` passing, `full:false`):

```ts
import { diagnose } from "../src/doctor.js";

describe("registry end-to-end composition", () => {
  // buildHealthyCtx assembles a fully-healthy DoctorContext in a fresh temp dir.
  // (Reuse the seed/seedContext/vec helpers; create baseline/labels/lock/backup/templates files.)
  function buildHealthyCtx() { /* …assemble per the description above; returns { ctx, cleanup } … */ }

  it("a fully healthy installation composes PASS", async () => {
    const { ctx, cleanup } = buildHealthyCtx();
    try { expect((await diagnose(ctx)).verdict).toBe("PASS"); } finally { cleanup(); }
  });
  it("HONESTY AT THE REGISTRY LEVEL: one un-runnable check (eval throws) drops the verdict to INCONCLUSIVE, not PASS", async () => {
    const { ctx, cleanup } = buildHealthyCtx();
    ctx.runEval = () => Promise.reject(new Error("eval exited 1"));
    try {
      const { results, verdict } = await diagnose(ctx);
      expect(verdict).toBe("INCONCLUSIVE");
      expect(verdict).not.toBe("PASS");
      expect(results.find((r) => r.id === "eval/last-verdict")?.status).toBe("INCONCLUSIVE");
      expect(results.filter((r) => r.status === "FAIL")).toHaveLength(0);
    } finally { cleanup(); }
  });
  it("a real FAIL (orphan embedding) composes FAIL, outranking any INCONCLUSIVE", async () => {
    const { ctx, cleanup } = buildHealthyCtx();
    ctx.db.prepare("DELETE FROM vec_items").run();
    try { expect((await diagnose(ctx)).verdict).toBe("FAIL"); } finally { cleanup(); }
  });
});
```

> Implementer note: write `buildHealthyCtx()` concretely by composing the per-suite fixture builders already in this file (the `seed`/`seedContext`/`vec`/lock/backup/template setup). Return `{ ctx, cleanup }` where `cleanup` closes the db and `rmSync`s the temp dir. This is the one place the whole context is assembled; keep it in the test file, not in `doctor.ts`.

- [ ] **Step 2: Run test to verify it fails.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts -t "registry end-to-end"`
  Expected: `diagnose is not a function`.

- [ ] **Step 3: Write minimal implementation.** Append to `doctor.ts`:

```ts
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
```
(Each `check*` already returns via `safeCheck`, so `runChecks` cannot throw.)

- [ ] **Step 4: Run test to verify it passes.**
  Run: `cd mcp && npx vitest run test/doctor.test.ts`
  Expected: the whole `doctor.test.ts` (Tasks 3–8) green.
  Then: `cd mcp && npx tsc --noEmit` — Expected: no output, exit 0.

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/doctor.ts test/doctor.test.ts
  git commit -m "doctor: registry assembly + diagnose() end-to-end composition"
  ```

---

## Phase 3 — Repair fix functions, runner, skill & wiring

Adds the unit-testable **fix functions** (Tasks 9–14) to `mcp/src/doctor.ts`, then the **glue**: the thin CLI runner (Task 15), the `/doctor` skill (Task 16), the npm-script wiring (Task 17), and the `/assimilate-claude-os` summary (Task 18). Fix functions live in `doctor.ts` so the runner imports them. The runner owns each fix as a discrete idempotent call; the SKILL owns the consent loop.

`FixResult` shape (defined once in Task 9, reused by all fixes):
```ts
export interface FixResult { applied: boolean; backupPath?: string; verdictAfter?: "PASS" | "FAIL" | "INCONCLUSIVE" | "CAPTURING" | null; detail: string; }
```

### Task 9: `dropDeadLabel` fix (back up labels, drop the dead label, re-run eval)

**Files:** Modify `mcp/src/doctor.ts` · Test `mcp/test/doctor.fixes.test.ts`

**Interfaces:** Consumes: `resolveRelevantIds` (the zero-row probe, to confirm deadness at apply-time); an injected `EvalRunner` for the post-fix re-run (subprocess boundary — never import eval). Produces: `export async function dropDeadLabel(opts: { db: Database.Database; labelsPath: string; deadQuery: string; runEval: EvalRunner }): Promise<FixResult>`.

- [ ] **Step 1: Write the failing test.** Create `mcp/test/doctor.fixes.test.ts` with the standard header (vitest, `vi.mock("../src/embedder.js", …)`, mkdtempSync). Seed a labels JSON with one dead label (substring matches 0 rows) + valid labels; assert `checkBrokenLabels` reports `INCONCLUSIVE`/`fixable` before the fix.
  ```ts
  it("before fix: broken-labels reports INCONCLUSIVE fixable", async () => {
    // …seed dead label…
    const res = await checkBrokenLabels({ db, labelsPath } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.fixable).toBe(true);
  });
  ```
  Run: `cd mcp && npx vitest run test/doctor.fixes.test.ts` → fails (`dropDeadLabel is not a function`).

- [ ] **Step 2: Failing test — backup-first + apply.** Assert `dropDeadLabel` writes a `<labelsPath>.bak` pre-image copy BEFORE removing the entry, removes ONLY the dead label, re-runs eval (injected), and returns `verdictAfter`. Inject `runEval: () => Promise.resolve({ verdict: "PASS", ok: true })`.
  ```ts
  it("backs up labels, drops only the dead label, re-runs eval", async () => {
    const res = await dropDeadLabel({ db, labelsPath, deadQuery: "the pruned episode", runEval: () => Promise.resolve({ verdict: "PASS", ok: true }) });
    expect(existsSync(labelsPath + ".bak")).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.verdictAfter).toBe("PASS");
    const after = JSON.parse(readFileSync(labelsPath, "utf8"));
    expect(after.queries.find((q: any) => q.query === "the pruned episode")).toBeUndefined();
    expect(after.queries.find((q: any) => q.query === "find a")).toBeDefined();
  });
  ```
  Run → fails.

- [ ] **Step 3: Implement.** In `doctor.ts`: copy the labels file to `<labelsPath>.bak`; parse, remove the query whose `query === deadQuery` ONLY IF `resolveRelevantIds(db, its expectedPathContains).length === 0` (re-confirm deadness — never drop a live label); write back; `await runEval()`; return `{ applied: true, backupPath, verdictAfter: r.ok ? r.verdict : null, detail }`. If the label is not actually dead at apply-time, return `{ applied: false, detail: "label is not dead — refusing to drop" }`.

- [ ] **Step 4: Passing test + idempotency.** After the fix, `checkBrokenLabels` reports `PASS`; a second `dropDeadLabel` for the same (now-absent) query returns `applied: false` and leaves labels unchanged.
  Run: `cd mcp && npx vitest run test/doctor.fixes.test.ts` → passes.

- [ ] **Step 5: Commit.**
  ```bash
  cd mcp
  git add src/doctor.ts test/doctor.fixes.test.ts
  git commit -m "doctor: drop-dead-label fix with labels backup and eval re-run"
  ```

### Task 10: `recomputeCorpusSnapshot` fix (back up labels, write live count)

**Files:** Modify `mcp/src/doctor.ts` · Test `mcp/test/doctor.fixes.test.ts`

**Interfaces:** Consumes: `distinctSourcePaths(db)`. Produces: `export function recomputeCorpusSnapshot(opts: { db: Database.Database; labelsPath: string }): FixResult`.

- [ ] **Step 1: Failing test.** Seed labels `curation.corpus_snapshot = 387` vs a fixture DB whose live distinct count is 3; assert `checkCorpusSnapshot` reports `FAIL` before. Run → fails (function undefined).
- [ ] **Step 2: Failing test — backup-first.** Assert `<labelsPath>.bak` pre-image exists before the snapshot is overwritten ("idempotent is not reversible — recomputing silently overwrites").
- [ ] **Step 3: Implement.** Back up labels; compute `distinctSourcePaths(db).length`; write it to `curation.corpus_snapshot`; return `{ applied: true, backupPath, detail }`.
- [ ] **Step 4: Passing + idempotency.** After fix, `checkCorpusSnapshot` reports `PASS` and the written value equals the live count; re-run is a no-op write, still `PASS`.
  Run: `cd mcp && npx vitest run test/doctor.fixes.test.ts -t "recompute"` → passes.
- [ ] **Step 5: Commit.** `cd mcp && git add src/doctor.ts test/doctor.fixes.test.ts && git commit -m "doctor: recompute-corpus-snapshot fix with labels backup"`

### Task 11: `runMigrateFix` fix (subprocess to `npm run migrate`)

**Files:** Modify `mcp/src/doctor.ts` · Test `mcp/test/doctor.fixes.test.ts`

**Interfaces:** Consumes: `isV3Schema(db)` for the post-check; an injected `migrateRunner: () => Promise<{ ok: boolean; reason?: string }>` (the real impl shells `npm run migrate` with `CLAUDE_OS_DB_PATH`; the migrate script owns its own backup via `VACUUM INTO`, so this fix does NOT double-backup). Produces: `export async function runMigrateFix(opts: { db: Database.Database; migrateRunner: () => Promise<{ ok: boolean; reason?: string }> }): Promise<FixResult>`.

- [ ] **Step 1: Failing test.** Build a v2 fixture DB (no `anchor`, per `migrations.test.ts:43-60`); assert `checkSchemaCurrent` reports `FAIL`/`run-migrate` before. Run → fails.
- [ ] **Step 2: Implement.** `await migrateRunner()`; on non-zero, return `{ applied: false, detail: "migrate failed: …" }` (do not swallow). On success, return `{ applied: true, detail }`.
- [ ] **Step 3: Passing test.** Inject a `migrateRunner` that runs the REAL `runMigrations`/`main` against the fixture (or stubs success and applies `runMigrations` directly in the test) so `isV3Schema(db)` becomes true and `checkSchemaCurrent` reports `PASS`. Assert a `.pre-c2.bak` was produced when the real migrate path is exercised.
- [ ] **Step 4: Idempotency.** Re-run → migrate's "already v3, exit 0" path makes it a no-op; check stays `PASS`.
  Run: `cd mcp && npx vitest run test/doctor.fixes.test.ts -t "migrate"` → passes.
- [ ] **Step 5: Commit.** `cd mcp && git add src/doctor.ts test/doctor.fixes.test.ts && git commit -m "doctor: run-migrate fix delegating to the migrate subprocess"`

### Task 12: `reembedMissing` fix (back up DB, then vectorCoverageSweep)

**Files:** Modify `mcp/src/doctor.ts` · Test `mcp/test/doctor.fixes.test.ts`

**Interfaces:** Consumes: `countMissingVectors(db)` (precondition + idempotency), `vectorCoverageSweep(db)` (the re-embed), `backupDb`/`verifyBackup` (re-embedding is not trivially undoable). Produces: `export async function reembedMissing(opts: { db: Database.Database; dbPath: string; backupPath: string }): Promise<FixResult>`.

- [ ] **Step 1: Failing test.** Seed ≥1 orphan observation (no `vec_items`); assert `checkOrphanEmbeddings` reports `FAIL`/`re-embed` before. Run → fails.
- [ ] **Step 2: Failing test — backup-first.** Capture live `COUNT(*)` from `observations`; assert `backupDb` writes a snapshot and `verifyBackup(backupPath, liveCount)` passes BEFORE `vectorCoverageSweep` mutates.
- [ ] **Step 3: Implement.** Capture count → `backupDb(db, backupPath)` → `verifyBackup(backupPath, count)` (a throw aborts before any mutation) → `await vectorCoverageSweep(db)` → return `{ applied: true, backupPath, detail }`. The embedder is mocked per `migrations.test.ts:12`.
- [ ] **Step 4: Passing + idempotency.** After fix, `countMissingVectors(db) === 0`, `checkOrphanEmbeddings` reports `PASS`; re-run → sweep early-returns `{before:0,…}`, still `PASS`.
  Run: `cd mcp && npx vitest run test/doctor.fixes.test.ts -t "re-embed"` → passes.
- [ ] **Step 5: Commit.** `cd mcp && git add src/doctor.ts test/doctor.fixes.test.ts && git commit -m "doctor: re-embed-missing fix with DB backup before vectorCoverageSweep"`

### Task 13: `clearStaleLock` fix (apply-time staleness re-verification)

**Files:** Modify `mcp/src/doctor.ts` · Test `mcp/test/doctor.fixes.test.ts`

**Interfaces:** Consumes: `isStale(lockPath, now)`; `rmSync`. NO DB backup (touches a lock dir, not the store). Produces: `export function clearStaleLock(opts: { lockPath: string; now?: number }): FixResult`.

- [ ] **Step 1: Failing test.** Create a lock dir whose mtime is older than `3 × 60s` (via `utimesSync`); assert `checkStaleLock` reports `FAIL`/`clear-stale-lock`. Run → fails.
- [ ] **Step 2: Failing test — apply-time re-verification (load-bearing).** Assert `clearStaleLock` calls `isStale` again at apply-time and REFUSES if no longer stale: touch the lock dir fresh between diagnose and apply (`utimesSync(lockPath, freshNow)`), then call `clearStaleLock({ lockPath, now: freshNow })` → `applied: false`, dir still present, detail explains the refusal.
- [ ] **Step 3: Implement.** Re-read `isStale(lockPath, now ?? Date.now())`; only `rmSync(lockPath, { recursive: true, force: true })` when still stale; else `{ applied: false, detail: "lock is no longer stale — refusing to clear (a live writer may hold it)" }`.
- [ ] **Step 4: Passing + idempotency.** Still-stale path → dir removed, `checkStaleLock` reports `PASS`; re-run against the absent lock → `PASS`, no throw (`force: true`), fix not re-offered.
  Run: `cd mcp && npx vitest run test/doctor.fixes.test.ts -t "clear-stale-lock"` → passes.
- [ ] **Step 5: Commit.** `cd mcp && git add src/doctor.ts test/doctor.fixes.test.ts && git commit -m "doctor: clear-stale-lock fix with apply-time staleness re-verification"`

### Task 14: `recaptureBaseline` fix (fresh-PASS gate enforced in code)

**Files:** Modify `mcp/src/doctor.ts` · Test `mcp/test/doctor.fixes.test.ts`

**Interfaces:** Consumes: an injected `EvalRunner` (compose a fresh verdict via subprocess); `writeBaseline` (from `eval_inspect.ts`); a pre-image backup of any existing baseline file. Produces: `export async function recaptureBaseline(opts: { db: Database.Database; baselinePath: string; runEval: EvalRunner }): Promise<FixResult>`.

- [ ] **Step 1: Failing test — REFUSAL path (highest priority).** Inject `runEval` composing `INCONCLUSIVE` (and a second case `FAIL`). Assert `recaptureBaseline` REFUSES: `applied: false`, the baseline file untouched, detail explains "the gate is enforced in code, not operator discipline." Run → fails.
- [ ] **Step 2: Failing test — backup-first on overwrite + SUCCESS.** With a prior baseline file present and `runEval` composing `PASS`: assert the old baseline is backed up before the new one is written, the new baseline records `chunking_enabled` matching the live chunked index, and `checkBaselineStale` now reports `PASS`.
- [ ] **Step 3: Implement.** `const r = await runEval(); if (!r.ok || r.verdict !== "PASS") return { applied: false, detail: "refusing to recapture — eval did not compose a fresh PASS (the gate is in code, not operator discipline)" };` Then: if a baseline file exists, copy it to `<baselinePath>.bak`; `writeBaseline(baselinePath, { corpus: { chunking_enabled: chunkingEnabled(db) }, … })`; return `{ applied: true, backupPath, verdictAfter: "PASS", detail }`.
- [ ] **Step 4: Passing + idempotency.** Success path green; after recapture, `checkBaselineStale` reports `PASS`; the fix is not re-offered while the baseline matches the index.
  Run: `cd mcp && npx vitest run test/doctor.fixes.test.ts -t "recapture"` → passes. Then full fixes file: `cd mcp && npx vitest run test/doctor.fixes.test.ts` → all green.
- [ ] **Step 5: Commit.** `cd mcp && git add src/doctor.ts test/doctor.fixes.test.ts && git commit -m "doctor: recapture-baseline fix gated on a code-verified fresh PASS"`

### Task 15: Thin CLI runner (`mcp/src/scripts/doctor.ts`) — manual verification

**Files:** Create `mcp/src/scripts/doctor.ts` (no unit test — formatting/exit-code glue, excluded from test scope per PRD Testing Decisions).

**Interfaces:** Consumes: `diagnose`, `composeVerdict`, `type CheckResult`, the six fix functions — all from `../doctor.js`; `DEFAULT_DB_PATH` from `../db.js`. The runner builds the real `DoctorContext` (raw-opens the DB so a pre-C2 schema is diagnosable, per PRD story 3; constructs the real subprocess runners for `runEval`/`runAudit`/`runBuild`/`runTest`). Produces: the `doctor` CLI entrypoint + exported testable `run()`; emits the grouped report + JSON trailer; sets `process.exitCode`. NEVER spawns a Claude session.

- [ ] **Step 1: Write the runner** with this real content:

```ts
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
      try { const j = JSON.parse(e.stdout?.toString() ?? ""); const v = j.metadata?.vulnerabilities ?? {};
        return { ok: true, vulnerabilities: { critical: v.critical ?? 0, high: v.high ?? 0, moderate: v.moderate ?? 0, low: v.low ?? 0 } }; }
      catch { return { ok: false, reason: "npm audit could not run or parse" }; }
    }
  };
}
function makeSubprocessRunner(args: string[]): () => Promise<SubprocessResult> {
  return async () => {
    try { execFileSync("npm", args, { encoding: "utf8", stdio: "ignore" }); return { ok: true, passed: true }; }
    catch (e: any) { return e.status != null ? { ok: true, passed: false } : { ok: false, passed: false, reason: e?.message ?? "could not run" }; }
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
```

- [ ] **Step 2: Manual verify — healthy PASS + exit 0.** (Requires Task 17's npm-script line; if running before Task 17, invoke `npx tsx src/scripts/doctor.ts` directly.)
  Run: `cd mcp && npx tsx src/scripts/doctor.ts; echo "exit=$?"`
  Expected: a `### `-grouped report, `VERDICT: PASS` (on a healthy install), a `<doctor-json>` trailer, `exit=0`, no Claude session.
- [ ] **Step 3: Manual verify — non-zero exit on non-PASS.**
  Run against a fixture with a known fault: `cd mcp && CLAUDE_OS_DB_PATH=/tmp/broken.db npx tsx src/scripts/doctor.ts; echo "exit=$?"`
  Expected: the faulting check in ALL-CAPS `FAIL`/`INCONCLUSIVE`, its remediation, `VERDICT:` non-PASS, `exit=1`.
- [ ] **Step 4: Manual verify — pre-C2 raw open (PRD story 3) + `--full`.**
  Run against a v2 fixture DB → reports the schema `FAIL` instead of crashing. Run with `--full` → `deps/tsc` + `deps/test` appear as `PASS`/`FAIL` rather than `ADVISORY`.
- [ ] **Step 5: Commit.** `cd mcp && git add src/scripts/doctor.ts && git commit -m "doctor: thin headless CLI runner (grouped report, JSON trailer, exit-code contract, raw open)"`

### Task 16: `/doctor` skill (`skills/doctor/SKILL.md`) — manual verification

**Files:** Create `skills/doctor/SKILL.md` (no unit test — the voice-confirmation loop is orchestration glue).

**Interfaces:** Consumes: the `doctor` npm script (Task 17) and its JSON trailer. The SKILL owns the consent loop; the SCRIPT owns each fix. Follows the sibling frontmatter convention verified against `skills/assimilate-claude-os/SKILL.md`.

- [ ] **Step 1: Write `skills/doctor/SKILL.md`** with this real content:

```markdown
---
name: doctor
description: >
  Diagnose the health of this Dioscuri installation and, with repair, apply only
  safe, individually-confirmed remediations. Use when the user invokes /doctor,
  "run doctor", "is my memory engine healthy", "diagnose my installation", or
  "repair my installation".
argument-hint: "[--fix] [--full]"
allowed-tools: Bash(cd:*), Bash(npm run doctor), Bash(npm run doctor -- --full), Bash(npm run migrate), Bash(npm run eval), Bash(npm run reembed)
---

<role>
You are the operator's Dioscuri health agent. You run the read-only doctor diagnosis,
relay its verdict plainly, and — only when asked to repair — drive remediation ONE
finding at a time, confirming each before it is applied. You never reimplement a check
or a fix; the npm script owns those. You never apply a fix the operator did not confirm.
</role>

<task>
Run `npm run doctor` (read-only) and relay the grouped report and top verdict. On repair
(`--fix`), re-run the checks and walk the fixable findings one at a time: for each,
describe exactly what the fix will do and why, ask, then apply-or-skip.

**Hard constraints:**
- Default (diagnosis) is read-only. Never repair unless the operator asked to.
- Repair is per-fix confirmed: ONE finding at a time, describe-then-ask-then-apply.
  Apply nothing the operator declines.
- Report-only findings (npm audit / build / test failures / the #82 retrieval gap) are
  surfaced but NEVER offered as fixes.
- recapture-baseline only proceeds on a fresh PASS — if the script refuses, relay the
  refusal; never pressure or work around it (the gate is in the script, by design).
- The script re-verifies preconditions at apply-time (e.g. a stale lock is re-checked
  before clearing). Trust it; do not bypass it.
- Never fabricate a verdict or status — read them from the script's output/trailer.
</task>

<instructions>
# Doctor

## 1. Diagnose (default)
```bash
cd ~/.claude-os/mcp && npm run doctor
```
(add `-- --full` only if the operator asked for the deep build/test screen). Relay the
top `VERDICT:` line, then each non-PASS check with its one-line meaning and remediation.

## 2. Repair (only when asked)
For EACH fixable finding, one at a time:
  a. Describe what the fix will do and why (e.g. "drop the dead label `<q>` whose target
     no longer exists, back up the labels file, then re-run eval").
  b. Ask the operator to confirm.
  c. On confirm: apply that single fix (the corresponding `npm run` action) and report the
     result — for label/baseline fixes, the new composed eval verdict. On decline: skip it.
Never bundle multiple fixes into one confirmation. Never re-offer a fix whose check now PASSes.

## 3. Report-only findings
List npm audit / build / test failures / the #82 advisory as report-only — never offer to fix them.
</instructions>

<success_criteria>
- `npm run doctor` was run (read-only) and its top verdict + non-PASS checks were relayed.
- In repair, each fixable finding was confirmed individually before any mutation; declined
  findings were left untouched.
- Report-only findings were surfaced as report-only, never offered as fixes.
- No verdict or status was fabricated — all relayed from the script output.
</success_criteria>

<examples>
<example label="healthy-diagnosis">
Input: /doctor
Ran `npm run doctor` → VERDICT: PASS. "Your installation is healthy — every check ran and passed."
</example>
<example label="repair-one-at-a-time">
Input: /doctor --fix
VERDICT: INCONCLUSIVE — broken-labels (dead label `auth flow` → 0 rows). "One fixable
finding: drop the dead label `auth flow` (its target no longer exists), back up labels,
re-run eval. Apply it?" → on confirm, applied; new eval verdict relayed.
</example>
<example label="baseline-gate-refusal">
Input: /doctor --fix
"recapture-baseline was offered, but the current eval composes INCONCLUSIVE, not PASS — the
script refuses to overwrite the reference with a non-PASS state. Resolve the failing checks
first, then re-run repair." (No bypass.)
</example>
</examples>
```

- [ ] **Step 2: Manual verify — invocation.** `/doctor` → skill runs `npm run doctor`, relays `VERDICT:` + non-PASS lines, fabricates no status.
- [ ] **Step 3: Manual verify — per-fix consent + report-only untouched.** `/doctor --fix` against a fixture with two fixable findings → presents ONE, asks, applies-or-skips, then the second; an `npm audit` finding is listed report-only with no fix offered.
- [ ] **Step 4: Commit.** `git add skills/doctor/SKILL.md && git commit -m "doctor: /doctor skill with per-fix consent loop"`

### Task 17: Wire the `doctor` npm script

**Files:** Modify `mcp/package.json` (no unit test — config glue).

**Interfaces:** Consumes: `tsx` (already in devDependencies). Produces: the `doctor` script, matching the eval/migrate/cutover pattern.

- [ ] **Step 1: Add one line** to `mcp/package.json` `scripts` (after `"cutover"`):
  ```diff
       "cutover": "tsx src/scripts/cutover.ts",
  +    "doctor": "tsx src/scripts/doctor.ts",
       "graph:build": "tsx src/scripts/graph-build.ts"
  ```
- [ ] **Step 2: Manual verify.** `cd mcp && npm run doctor` resolves the script and runs the runner (not "missing script"). Per project CLAUDE.md, doctor introduces no new persistent machine state, so no new `update.sh` step is required.
- [ ] **Step 3: Commit.** `cd mcp && git add package.json && git commit -m "doctor: wire doctor npm script"`

### Task 18: Append non-blocking doctor summary to `/assimilate-claude-os`

**Files:** Modify `skills/assimilate-claude-os/SKILL.md` (no unit test — orchestration glue).

**Interfaces:** Consumes: the `doctor` npm script (Task 17). Produces: a non-blocking health read at the END of every sync. A doctor non-PASS is surfaced as a WARNING but does NOT abort the completed update (PRD story 25).

- [ ] **Step 1: Append** after the existing final instructions step (before `</instructions>`), this real content:

```markdown
### Health read (non-blocking)

After the update is reported, run a read-only doctor pass so problems surface at the moment
they are introduced:

```bash
cd ~/.claude-os/mcp && npm run doctor
```

Relay the top `VERDICT:` line. This is NON-BLOCKING: a non-PASS verdict is surfaced as a
WARNING ("the update completed, but doctor reports <verdict> — run /doctor for detail") and
does NOT undo or abort the already-completed update. Never run `--fix` here; the post-sync
summary is diagnosis only.
```

  And add to `<success_criteria>`:
```markdown
- A non-blocking `npm run doctor` summary was appended after the update report; a non-PASS
  verdict was surfaced as a warning without aborting the completed update.
```

- [ ] **Step 2: Manual verify — PASS path.** `/assimilate-claude-os` on a healthy install → update report followed by a `VERDICT: PASS` summary; no warning.
- [ ] **Step 3: Manual verify — non-PASS does NOT abort + never `--fix`.** With a fixture fault, `/assimilate-claude-os` completes the update AND THEN emits the doctor non-PASS as a warning (pull/rebuild not rolled back); confirm the appended step runs read-only doctor only.
- [ ] **Step 4: Commit.** `git add skills/assimilate-claude-os/SKILL.md && git commit -m "doctor: append non-blocking doctor health summary to assimilate-claude-os"`

---

## Sequencing

- **Phase 1 first** (Tasks 1–2): doctor's checks import `eval_inspect.ts` and will not compile until it lands.
- **Phase 2** (Tasks 3–8): Task 3 (types + composition + honesty invariant) before all others; Tasks 4–7 are largely independent and may be done in any order, with one caveat — Task 5 reuses the `chunkingEnabled` import that Task 4's Step 3 adds to `doctor.ts`, so if Task 5 is done before Task 4, add that one import line (`import { chunkingEnabled } from "./eval_inspect.js";`) in Task 5's Step 3 instead. Either way the symbol resolves once both tasks have landed (they append to the same file). Task 8 (registry) last, after all checks exist.
- **Phase 3** (Tasks 9–18): fix functions 9–14 are independent of each other; Task 17 (npm script) before Task 15's manual-verify commands; then 15, 16, 18.

## Definition of Done

- All acceptance criteria pass; `npm test` and `npm run eval` both green; doctor itself reports `PASS` on a healthy install.
- Copilot requested on the PR (per repo rule — request, then verify-and-warn if absent).
- Test coverage: the doctor registry + every remediation covered (honesty invariant proven first).
- Documentation: a doctor note in the docs and the `/assimilate-claude-os` skill note.
