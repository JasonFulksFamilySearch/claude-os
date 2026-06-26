import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import * as doctor from "../src/doctor.js";
import { applyFix, parseEvalVerdict } from "../src/scripts/doctor.js";
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
