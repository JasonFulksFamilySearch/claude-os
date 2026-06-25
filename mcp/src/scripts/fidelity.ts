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
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { measurePayload, microAverage } from "../fidelity-measure.js";
import { log } from "../logger.js";

interface PayloadEntry {
  array: unknown[];
  important_indices: number[];
  notes?: string;
}

interface FidelityLabeledSet {
  _note?: string;
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
  total_attributable: number;
  captured_on_ref: string;
}

interface VerdictResult {
  status: "CAPTURED" | "PASS" | "REGRESSED" | "INCONCLUSIVE";
  cur: FidelityBaseline;
  prev: FidelityBaseline | null;
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
    captured_on_ref?: string;
  },
): VerdictResult {
  const curRef = cur.captured_on_ref ?? "";

  if (cur.rate === null) {
    // Degenerate set — no attributable rows anywhere. Never capture or compare.
    return {
      status: "INCONCLUSIVE",
      cur: {
        rate: 0,
        total_attributable: cur.total_attributable,
        captured_on_ref: curRef,
      },
      prev,
    };
  }

  const curBaseline: FidelityBaseline = {
    rate: cur.rate,
    total_attributable: cur.total_attributable,
    captured_on_ref: curRef,
  };

  if (prev === null) {
    // No prior baseline — this is a first-run capture.
    return { status: "CAPTURED", cur: curBaseline, prev: null };
  }

  if (prev.rate === null) {
    // A prior baseline with a null rate is invalid (should never have been written,
    // but guard defensively so a corrupt file doesn't yield a misleading pass/fail).
    return { status: "INCONCLUSIVE", cur: curBaseline, prev };
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
  const results = [];

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
  console.log(`Total attributable: ${avg.totalAttributable}`);
  console.log(`Total survived:     ${avg.totalSurvived}`);
  console.log(`Excluded P1 (preserved class): ${totalExcludedP1}`);
  console.log(`Excluded P2 (position band):   ${totalExcludedP2}`);

  const ref = gitRef();
  const prev = readBaseline(BASELINE_PATH);

  const verdict = composeFidelityVerdict(prev, {
    rate: avg.rate,
    total_attributable: avg.totalAttributable,
    captured_on_ref: ref,
  });

  if (verdict.status === "INCONCLUSIVE") {
    console.log(
      `\nVERDICT: INCONCLUSIVE (null rate — degenerate labeled set; no attributable rows; never captured)`,
    );
    process.exitCode = 1;
    return;
  }

  if (verdict.status === "CAPTURED") {
    writeBaseline(BASELINE_PATH, verdict.cur);
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
