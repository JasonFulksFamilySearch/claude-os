// Offline fidelity measurement — run by hand (`npm run fidelity`), NOT in CI.
//
// Measures the bigram importance ranker's fidelity: for each curated payload, what
// fraction of importance-attributable rows survive compression? Loads a disjoint
// labeled set (~/.claude-data/eval/fidelity-payloads.json) that must NEVER share
// rows with the held-out retrieval eval set (train/test leakage voids the gate).
// See docs/eval-gate-protocol.md for the disjointness doctrine.
//
// Baseline: machine-local ~/.claude-data/eval/fidelity-baseline.json, captured once
// on the pre-change compressor. The gate is micro-average fidelity non-regression.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { measurePayload, microAverage, type PayloadResult } from "../fidelity-measure.js";
import { log } from "../logger.js";

interface PayloadEntry {
  array: unknown[];
  important_indices: number[];
  notes?: string;
}

interface FidelityLabeledSet {
  // The template carries a leading `_note` JSON key (disjointness + placeholder warning); it is
  // human annotation read by people, not the script, so it is intentionally not typed here.
  curation?: {
    date: string | null;
    approver: string | null;
    corpus_snapshot: string | null;
    fidelity_floor?: number | null;
    _criterion?: string;
  };
  payloads: PayloadEntry[];
}

export interface FidelityBaseline {
  rate: number;
  total_attributable: number; // provenance only — comparability is decided by labeled_set_hash
  labeled_set_hash?: string;
  captured_on_ref: string;
}

// Stable content hash of the fidelity labeled set's measurement-determining fields.
// Mirrors eval.ts's fileSetHash idiom: only fields that affect measurement are hashed
// (array + important_indices); notes is human annotation and does not affect the result.
// Hashes the raw JSON.stringify (no key canonicalization). The labeled set is a single
// committed file parsed identically every run, so this is deterministic run-over-run. The
// raw form is intentionally fail-SAFE for comparability: a no-op object-key reorder of a
// payload moves the hash and forces a re-baseline (harmless), but a real content change can
// never preserve the hash — so it can never let a non-comparable baseline compose a spurious
// PASS, which is the property this guard exists to protect.
export function labeledSetHash(payloads: PayloadEntry[]): string {
  const stable = JSON.stringify(
    payloads.map((p) => [p.array, p.important_indices]),
  );
  return createHash("sha256").update(stable).digest("hex");
}

interface VerdictResult {
  status: "CAPTURED" | "PASS" | "REGRESSED" | "INCONCLUSIVE";
  // `cur.rate` is `number | null`: on the degenerate (null-rate) INCONCLUSIVE branch it is
  // null, never a fabricated 0 — so a future caller that reads `verdict.cur.rate` without
  // checking `status` can never mistake "no measurement" for a real 0% survival rate. Only
  // the CAPTURED branch (where rate is a real number) is ever persisted via writeBaseline.
  cur: { rate: number | null; total_attributable: number; labeled_set_hash?: string; captured_on_ref: string };
  prev: FidelityBaseline | null;
  reason?: string;
}

// Small epsilon to absorb floating-point rounding when comparing rates.
const EPSILON = 1e-9;

// Machine-local paths — DATA that lives alongside memory.db, never committed.
// update.sh provisions fidelity-payloads.json from the committed template (only-if-absent).
const LABELS_PATH = join(
  homedir(),
  ".claude-data",
  "eval",
  "fidelity-payloads.json",
);
const BASELINE_PATH = join(
  homedir(),
  ".claude-data",
  "eval",
  "fidelity-baseline.json",
);

export function readBaseline(path: string): FidelityBaseline | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as FidelityBaseline;
}

export function writeBaseline(path: string, baseline: FidelityBaseline): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

function gitRef(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Compose a verdict from a previous baseline and the current run.
// NULL-RATE CONTRACT: if either rate is null, return INCONCLUSIVE immediately.
// JSON.stringify(NaN) === 'null' so a null that slipped into a stored baseline
// could later be misread as 0 → spurious PASS. Hard abort on any null rate.
export function composeFidelityVerdict(
  prev: FidelityBaseline | null,
  cur: {
    rate: number | null;
    total_attributable: number;
    labeled_set_hash?: string;
    captured_on_ref?: string;
  },
): VerdictResult {
  const curRef = cur.captured_on_ref ?? "";

  if (cur.rate === null) {
    // Degenerate set — no attributable rows anywhere. Never capture or compare.
    return {
      status: "INCONCLUSIVE",
      reason:
        "degenerate labeled set — no attributable rows in this run; nothing captured",
      cur: {
        rate: null, // honest: the rate is unknown, not 0 — never persisted on this branch
        total_attributable: cur.total_attributable,
        labeled_set_hash: cur.labeled_set_hash,
        captured_on_ref: curRef,
      },
      prev,
    };
  }

  const curBaseline: FidelityBaseline = {
    rate: cur.rate,
    total_attributable: cur.total_attributable,
    labeled_set_hash: cur.labeled_set_hash,
    captured_on_ref: curRef,
  };

  if (prev === null) {
    // No prior baseline — this is a first-run capture.
    return { status: "CAPTURED", cur: curBaseline, prev: null };
  }

  if (prev.rate === null || !Number.isFinite(prev.rate)) {
    // A prior baseline with a null or non-finite rate is invalid: a hand-edited file can
    // produce rate: NaN, Infinity, or a string that coerces to NaN. The downstream
    // comparison `cur.rate < prev.rate - EPSILON` then devolves into NaN math and always
    // evaluates to false — silently yielding PASS instead of failing safe.
    // Number.isFinite(null) is false, so this subsumes the null check; null is kept explicit
    // in the reason string so both cases produce an actionable message.
    return {
      status: "INCONCLUSIVE",
      reason:
        "corrupt prior baseline (stored rate is null or non-finite) — delete ~/.claude-data/eval/fidelity-baseline.json and re-capture",
      cur: curBaseline,
      prev,
    };
  }

  // COMPARABILITY GUARD: mirrors eval.ts's fileSetHash content-hash guard.
  // A baseline captured on labeled-set-V1 composed against a run on labeled-set-V2
  // (swapped payload content, same total_attributable) yields a plausible-but-wrong
  // verdict. A bare row count cannot detect a content swap — only a content hash can.
  //
  // "predates" branch: a baseline without labeled_set_hash was captured before this
  // guard existed; force a re-capture rather than silently skipping the check.
  if (prev.labeled_set_hash === undefined) {
    return {
      status: "INCONCLUSIVE",
      reason:
        "baseline predates the content-hash guard — re-capture (delete ~/.claude-data/eval/fidelity-baseline.json)",
      cur: curBaseline,
      prev,
    };
  }
  if (prev.labeled_set_hash !== cur.labeled_set_hash) {
    return {
      status: "INCONCLUSIVE",
      reason:
        "labeled set content changed since baseline — not comparable; re-capture the baseline (delete ~/.claude-data/eval/fidelity-baseline.json)",
      cur: curBaseline,
      prev,
    };
  }

  const regressed = cur.rate < prev.rate - EPSILON;
  return {
    status: regressed ? "REGRESSED" : "PASS",
    cur: curBaseline,
    prev,
  };
}

async function main(): Promise<void> {
  if (!existsSync(LABELS_PATH)) {
    console.error(
      `Fidelity labeled set not found: ${LABELS_PATH}\n` +
        `Run ~/.claude-os/update.sh to provision it from the template.`,
    );
    process.exitCode = 1;
    return;
  }

  const set = JSON.parse(
    readFileSync(LABELS_PATH, "utf8"),
  ) as FidelityLabeledSet;
  const payloads = set.payloads;

  if (!Array.isArray(payloads) || payloads.length === 0) {
    console.error("Fidelity labeled set has no payloads.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `Offline fidelity — importance-attributable survival rate over ${payloads.length} payload(s)`,
  );
  console.log(`Labels: ${LABELS_PATH}\n`);

  let totalExcludedP1 = 0;
  let totalExcludedP2 = 0;
  const results: PayloadResult[] = [];

  for (let i = 0; i < payloads.length; i++) {
    const entry = payloads[i];
    let result;
    try {
      result = measurePayload(entry.array, entry.important_indices);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  payload[${i}] ERROR: ${msg}`);
      process.exitCode = 1;
      return;
    }
    totalExcludedP1 += result.excludedP1;
    totalExcludedP2 += result.excludedP2;
    results.push(result);

    const rateStr =
      result.perPayloadRate === null ? "n/a" : result.perPayloadRate.toFixed(4);
    const noteStr = entry.notes ? `  # ${entry.notes}` : "";
    console.log(
      `  payload[${i}]: rate=${rateStr}  attributable=${result.attributable}  survived=${result.survived}  excP1=${result.excludedP1}  excP2=${result.excludedP2}${noteStr}`,
    );
  }

  const avg = microAverage(results);

  console.log("");
  console.log(
    `Micro-average fidelity rate: ${avg.rate === null ? "n/a (no attributable rows)" : avg.rate.toFixed(6)}`,
  );
  // Report the owner-set floor alongside the measured rate so the arming-decision reader
  // can compare them at a glance. Non-enforcement is intentional: the gate is baseline
  // non-regression; the floor is the human owner's committed threshold, surfaced here but
  // never used as a pass/fail branch (owner-set, agreed-before-arming design).
  const floor = set.curation?.fidelity_floor ?? null;
  console.log(
    `Owner-set fidelity floor (reported, not enforced): ${floor === null ? "n/a" : floor}`,
  );
  console.log(`Total attributable: ${avg.totalAttributable}`);
  console.log(`Total survived:     ${avg.totalSurvived}`);
  console.log(`Excluded P1 (preserved class): ${totalExcludedP1}`);
  console.log(`Excluded P2 (position band):   ${totalExcludedP2}`);

  const ref = gitRef();
  const prev = readBaseline(BASELINE_PATH);
  const curHash = labeledSetHash(payloads);

  const verdict = composeFidelityVerdict(prev, {
    rate: avg.rate,
    total_attributable: avg.totalAttributable,
    labeled_set_hash: curHash,
    captured_on_ref: ref,
  });

  if (verdict.status === "INCONCLUSIVE") {
    console.log(`\nVERDICT: INCONCLUSIVE (${verdict.reason})`);
    process.exitCode = 1;
    return;
  }

  if (verdict.status === "CAPTURED") {
    // CAPTURED is only returned for a non-null rate (the null branch is INCONCLUSIVE and
    // already returned above). Assert that here so a null rate can never reach the baseline.
    if (verdict.cur.rate === null) {
      throw new Error("unreachable: CAPTURED verdict with a null rate");
    }
    writeBaseline(BASELINE_PATH, { ...verdict.cur, rate: verdict.cur.rate });
    console.log(
      `\nVERDICT: BASELINE CAPTURED (rate=${verdict.cur.rate.toFixed(6)} recorded → ${BASELINE_PATH}; no pass/fail this run)`,
    );
    return;
  }

  // PASS or REGRESSED
  const prevRate = verdict.prev!.rate;
  console.log(
    `\nBaseline: rate=${prevRate.toFixed(6)}  ref=${verdict.prev!.captured_on_ref}`,
  );
  console.log(`VERDICT: ${verdict.status}`);
  if (verdict.status === "REGRESSED") {
    process.exitCode = 1;
  }

  console.log(
    "\nFidelity set is DISJOINT from the held-out retrieval eval set — never share rows (leakage).",
  );
}

// Only run when invoked directly as a script (npm run fidelity), never on import (tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log("error", "fidelity run failed", { error: msg });
    console.error("fidelity run failed:", msg);
    process.exitCode = 1;
  });
}
