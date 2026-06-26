import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import * as doctor from "../src/doctor.js";
import { applyFix, parseEvalVerdict, parseAuditJson, runApplyFix } from "../src/scripts/doctor.js";
import type { DoctorContext } from "../src/doctor.js";

// Mock the embedder so importing the doctor graph never loads @huggingface/transformers.
vi.mock("../src/embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedder.js")>();
  return {
    ...actual,
    embedDocument: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
    embedQuery: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
  };
});

// ---------------------------------------------------------------------------
// applyFix() dispatcher — the wiring layer DEFECT 2 was about. The 5 fix
// functions are unit-tested in isolation elsewhere; this suite covers the
// dispatch itself: id→function mapping, the cross-task re-embed backup-path
// contract, the unknown-id path, and that a dispatched fix actually reaches
// its function. It does NOT re-test the fix bodies.
// ---------------------------------------------------------------------------

function makeCtx(dir: string): { ctx: DoctorContext; close: () => void } {
  const dbPath = join(dir, "memory.db");
  const db = openDb(dbPath);
  const ctx: DoctorContext = {
    db,
    dbPath,
    baselinePath: join(dir, "eval-baseline.json"),
    labelsPath: join(dir, "labeled-queries.json"),
    lockPath: join(dir, "memory.db.writer.lock.d"),
    repoRoot: dir,
    full: false,
    // The dispatcher builds its own subprocess runners internally; these are
    // never invoked by the paths under test (unknown-id, re-embed-spied,
    // clear-stale-lock-no-lock), so a throwing stub documents that.
    runEval: async () => { throw new Error("ctx.runEval must not be called by these paths"); },
    runAudit: async () => { throw new Error("ctx.runAudit must not be called by these paths"); },
    runBuild: async () => { throw new Error("ctx.runBuild must not be called by these paths"); },
    runTest: async () => { throw new Error("ctx.runTest must not be called by these paths"); },
  };
  return { ctx, close: () => db.close() };
}

describe("applyFix dispatcher", () => {
  let dir: string;
  let ctx: DoctorContext;
  let close: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-dispatch-"));
    ({ ctx, close } = makeCtx(dir));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns applied:false with the id echoed for an unknown fix id (no side effects)", async () => {
    const result = await applyFix("bogus-id", ctx);
    expect(result.applied).toBe(false);
    expect(result.detail).toBe("unknown fix id: bogus-id");
  });

  it("dispatches re-embed with a FRESH timestamped backupPath (cross-task contract)", async () => {
    // Spy on the leaf so no real VACUUM/sweep runs — we assert only the wiring:
    // applyFix must hand reembedMissing a <dbPath>.pre-reembed.<ts>.bak path.
    // A reused/static path would throw at VACUUM INTO (it refuses to overwrite).
    const spy = vi.spyOn(doctor, "reembedMissing").mockResolvedValue({
      applied: true,
      backupPath: "stub",
      detail: "stub",
    });

    await applyFix("re-embed", ctx);

    expect(spy).toHaveBeenCalledOnce();
    const passed = spy.mock.calls[0][0] as { db: unknown; dbPath: string; backupPath: string };
    expect(passed.dbPath).toBe(ctx.dbPath);
    // Fresh + timestamped: <dbPath>.pre-reembed.<digits>.bak
    expect(passed.backupPath).toMatch(
      new RegExp(`^${ctx.dbPath.replace(/[.]/g, "\\.")}\\.pre-reembed\\.\\d+\\.bak$`),
    );
  });

  it("routes clear-stale-lock through to clearStaleLock (no lock present → refuse)", async () => {
    // End-to-end through the dispatcher: with no lock dir, the real fix function
    // returns its no-lock refusal — proving the id actually reaches the function.
    expect(existsSync(ctx.lockPath)).toBe(false);
    const result = await applyFix("clear-stale-lock", ctx);
    expect(result.applied).toBe(false);
    expect(result.detail).toBe("no writer lock present — nothing to clear.");
  });

  it("drop-dead-label reads the dead query from STRUCTURED context, not the detail string", async () => {
    // Regression guard for the regex de-coupling: the check's detail is deliberately
    // reworded here so any prose-parsing approach would fail to recover the query. The
    // dispatcher must read context.deadQuery and still hand the right query to dropDeadLabel.
    vi.spyOn(doctor, "checkBrokenLabels").mockResolvedValue({
      id: "eval/broken-labels",
      status: "INCONCLUSIVE",
      fixable: true,
      detail: "completely reworded message that no regex would parse",
      context: { deadQuery: "the dead query" },
      remediation: { id: "drop-dead-label", description: "drop it" },
    });
    const dropSpy = vi.spyOn(doctor, "dropDeadLabel").mockResolvedValue({
      applied: true,
      detail: "dropped",
    });

    await applyFix("drop-dead-label", ctx);

    expect(dropSpy).toHaveBeenCalledOnce();
    expect((dropSpy.mock.calls[0][0] as { deadQuery: string }).deadQuery).toBe("the dead query");
  });

  it("drop-dead-label refuses when the check carries no dead query (no detail parsing fallback)", async () => {
    vi.spyOn(doctor, "checkBrokenLabels").mockResolvedValue({
      id: "eval/broken-labels",
      status: "INCONCLUSIVE",
      fixable: true,
      detail: 'label "x" matches 0 observation rows', // parseable prose, but no context
      remediation: { id: "drop-dead-label", description: "drop it" },
    });
    const dropSpy = vi.spyOn(doctor, "dropDeadLabel");

    const result = await applyFix("drop-dead-label", ctx);

    expect(result.applied).toBe(false);
    expect(result.detail).toContain("did not carry a dead query");
    expect(dropSpy).not.toHaveBeenCalled();
  });
});

describe("parseEvalVerdict — eval VERDICT line mapping", () => {
  it("maps `VERDICT: BASELINE CAPTURED (...)` to CAPTURING/ok:true (no-baseline run)", () => {
    // The eval script prints this exact line when no baseline exists yet — NOT the literal
    // "CAPTURING". The old regex didn't match it and returned ok:false, mislabeling a
    // first-install bootstrap as an unparseable verdict. It must map to CAPTURING/ok:true so
    // checkLastVerdict reports the honest "no baseline yet" INCONCLUSIVE.
    const out = "...\nVERDICT: BASELINE CAPTURED (recorded → ~/.claude-data/eval-baseline.json; no pass/fail this run)\n";
    expect(parseEvalVerdict(out)).toEqual({ verdict: "CAPTURING", ok: true });
  });
  it("still parses PASS / FAIL / INCONCLUSIVE verdict lines unchanged", () => {
    expect(parseEvalVerdict("VERDICT: PASS")).toEqual({ verdict: "PASS", ok: true });
    expect(parseEvalVerdict("VERDICT: FAIL (presence regressed)")).toEqual({ verdict: "FAIL", ok: true });
    expect(parseEvalVerdict("VERDICT: INCONCLUSIVE (baseline stale)")).toEqual({ verdict: "INCONCLUSIVE", ok: true });
  });
  it("a FAIL line is never misread as a capture (capture check is anchored to the BASELINE CAPTURED phrase)", () => {
    expect(parseEvalVerdict("VERDICT: FAIL").verdict).toBe("FAIL");
  });
  it("returns ok:false when no VERDICT line is present", () => {
    expect(parseEvalVerdict("eval crashed before composing")).toEqual({
      verdict: "INCONCLUSIVE", ok: false, reason: "could not parse eval verdict",
    });
  });
});

describe("parseAuditJson — error-JSON must not read as a clean audit", () => {
  it("returns counts when metadata.vulnerabilities is present, even at all-zero (a REAL clean audit)", () => {
    // A successful audit on a clean tree always carries the object with zero counts. That is a
    // real result and must be reported as ADVISORY 0/0/0/0 — never INCONCLUSIVE.
    const clean = JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } } });
    expect(parseAuditJson(clean)).toEqual({ critical: 0, high: 0, moderate: 0, low: 0 });
  });
  it("returns the real per-severity counts when vulns exist", () => {
    const vulns = JSON.stringify({ metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 3, low: 4 } } });
    expect(parseAuditJson(vulns)).toEqual({ critical: 1, high: 2, moderate: 3, low: 4 });
  });
  it("THROWS on an error payload with no vulnerabilities object (audit could not run, not clean)", () => {
    // {"error":{"code":"ENOLOCK",...}} is npm's "audit could not run" shape. Treating its
    // absent metadata.vulnerabilities as {} (→ 0/0/0/0, ok:true) would report a CLEAN audit
    // for one that actually failed — the honesty violation. It must throw → auditCounts null
    // → makeAuditRunner ok:false → checkNpmAudit INCONCLUSIVE.
    const errorPayload = JSON.stringify({ error: { code: "ENOLOCK", summary: "no lockfile" } });
    expect(() => parseAuditJson(errorPayload)).toThrow(/no metadata.vulnerabilities object/);
  });
  it("THROWS when metadata exists but vulnerabilities is absent or non-object", () => {
    expect(() => parseAuditJson(JSON.stringify({ metadata: {} }))).toThrow(/no metadata.vulnerabilities object/);
    expect(() => parseAuditJson(JSON.stringify({ metadata: { vulnerabilities: null } }))).toThrow(/no metadata.vulnerabilities object/);
  });
  it("THROWS when metadata.vulnerabilities is an array (corruption, not a valid count object)", () => {
    // Arrays pass typeof === 'object' but are not valid vulnerabilities objects. An array
    // would coerce to 0/0/0/0 and be misreported as clean. Reject arrays explicitly to
    // avoid honesty violations.
    const arrayVulns = JSON.stringify({ metadata: { vulnerabilities: [{ critical: 1 }] } });
    expect(() => parseAuditJson(arrayVulns)).toThrow(/no metadata.vulnerabilities object/);
  });
});

describe("runApplyFix — the --apply-fix CLI boundary always emits structured JSON + 0/1 exit", () => {
  let dir: string;
  let ctx: DoctorContext;
  let close: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-applyfix-"));
    ({ ctx, close } = makeCtx(dir));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an unknown fix id yields structured JSON (applied:false) and exit 1 — not a crash", async () => {
    const { json, exitCode } = await runApplyFix("bogus-id", ctx);
    expect(exitCode).toBe(1);
    expect(JSON.parse(json)).toEqual({ applied: false, detail: "unknown fix id: bogus-id" });
  });

  it("a successful fix yields structured JSON (applied:true) and exit 0", async () => {
    // clear-stale-lock with no lock present returns applied:false; instead spy the leaf to
    // assert the applied:true → exit 0 mapping at the boundary without a real mutation.
    vi.spyOn(doctor, "clearStaleLock").mockReturnValue({ applied: true, detail: "cleared" });
    const { json, exitCode } = await runApplyFix("clear-stale-lock", ctx);
    expect(exitCode).toBe(0);
    expect(JSON.parse(json)).toEqual({ applied: true, detail: "cleared" });
  });

  it("a THROWING fix is caught and converted to structured JSON + exit 1 (no raw stack trace)", async () => {
    // The crash-safety fix: applyFix can throw (e.g. readPresenceQueries on a corrupt labels
    // file, or readFileSync on a missing one). The boundary must convert that into a FixResult,
    // never let the stack escape. drop-dead-label calls checkBrokenLabels first, so a throw
    // there exercises the catch.
    vi.spyOn(doctor, "checkBrokenLabels").mockRejectedValue(new Error("labels file is corrupt"));
    const { json, exitCode } = await runApplyFix("drop-dead-label", ctx);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(json);
    expect(parsed.applied).toBe(false);
    expect(parsed.detail).toBe("fix failed: labels file is corrupt");
  });

  it("emits valid JSON terminated by a newline (the repair contract's wire shape)", async () => {
    const { json } = await runApplyFix("bogus-id", ctx);
    expect(json.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
