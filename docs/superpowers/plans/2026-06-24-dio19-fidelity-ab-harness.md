# DIO-19 Fidelity A/B Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the DIO-19 offline fidelity A/B harness — a measurement-only `npm run fidelity` instrument that reports the **importance-attributable survival rate** of compressed tool-output over a held-out-disjoint labeled set, producing the number that gates DIO-18 (#72) arming.

**Architecture:** A new `mcp/src/scripts/fidelity.ts` (mirroring `eval.ts`) loads a disjoint content-level labeled set, runs each payload through `compress()`, and recomputes — from `compress()`'s **exported** surface — which curated "important" rows are *importance-attributable* (droppable AND outside the schema-head/recency-tail position bands), then reports the micro-average survival of that set against a machine-local baseline. It is measurement-only; the sole existing-file change is exporting two slot-fraction constants from `smart-crusher.js`.

**Tech Stack:** TypeScript (`tsx` script in `mcp/`, mirroring `eval`/`migrate`/`cutover`/`graph:build`); `vitest` (the mcp test runner); the live `compress()` from `hooks/lib/smart-crusher.js` (CommonJS, imported into the TS harness).

## Global Constraints

- **Measurement-only, no writes to shared state.** No runtime behavior change; reads `compress()`, writes only a machine-local baseline under `~/.claude-data/eval/`. (PRD §Solution.)
- **The denominator is the IMPORTANCE-ATTRIBUTABLE SET only.** A curated `important_index` counts iff `verdict === 'droppable'` (NOT P1 preserved) AND its rank in the droppable pool is outside the first `schemaCount` / last `recencyCount` bands (NOT P2 position). Only P3 (the bigram importance ranker) survival is credited. (PRD ID-1, ID-11.)
- **Determinism.** No `Date.now()`/`Math.random()` in the measure; identical labeled set ⇒ byte-identical rate. (PRD US-3.)
- **Disjoint labeled set.** The fidelity set MUST be disjoint from the eval presence set (`mcp/eval/labeled-queries.template.json`); reusing it is train/test leakage that voids the eval gate. (PRD ID-6; `docs/eval-gate-protocol.md:56-59`.)
- **Aggregation = micro-average; empty importance-attributable set ⇒ contributes 0/0, per-payload rate `n/a`.** (PRD ID-1.)
- **Compression floor.** Every labeled payload MUST have `originalCount >= MIN_ROWS_TO_COMPRESS`; the harness asserts `compressed === true` per payload. (PRD ID-12.)
- **Contract tripwire.** Assert `verdicts.length === originalCount` per `compress()` result; mismatch aborts loud. (PRD ID-8.)
- **No eval-gated module touched** (`search_config.ts`/`ranking.ts`/`indexer.ts`/`embedder.ts`); the one existing-file edit is exports-only in `smart-crusher.js`. (PRD ID-13, §Out-of-Scope.)
- **Out of scope:** the #72 arming flip, the error/anomaly/boundary slice (AC-5b's), pinning a floor number, routing through `npm run eval`, a live model judge.

---

### Task 1: Export the slot fractions from smart-crusher.js

**Files:**
- Modify: `hooks/lib/smart-crusher.js` (the `module.exports` block, ~`:464-475`)
- Test: `hooks/test/smart-crusher-exports.test.js` (new — a focused export-surface assertion)

**Interfaces:**
- Consumes: nothing.
- Produces: `SCHEMA_FRACTION` (number, 0.30) and `RECENCY_FRACTION` (number, 0.15) added to `smart-crusher.js`'s exports, alongside the already-exported `classifyRows`, `kneedleBudget`, `MIN_ROWS_TO_COMPRESS`. Task 2 imports all five.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('../lib/smart-crusher.js');

test('smart-crusher exports the slot fractions DIO-19 needs to recompute the split', () => {
  assert.equal(sc.SCHEMA_FRACTION, 0.30);
  assert.equal(sc.RECENCY_FRACTION, 0.15);
  // already-exported surface the harness also relies on:
  assert.equal(typeof sc.classifyRows, 'function');
  assert.equal(typeof sc.kneedleBudget, 'function');
  assert.equal(typeof sc.MIN_ROWS_TO_COMPRESS, 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hooks && node --test test/smart-crusher-exports.test.js`
Expected: FAIL — `SCHEMA_FRACTION` is `undefined` (not yet exported).

- [ ] **Step 3: Add the two constants to the export block**

In `hooks/lib/smart-crusher.js`, add `SCHEMA_FRACTION` and `RECENCY_FRACTION` to the existing `module.exports = { ... }` object (they are module consts at `:47-48`). Exports-only; do not touch any logic. Add a one-line comment that these are exported for the DIO-19 fidelity harness to mirror the split sizing rather than hardcode it.

- [ ] **Step 4: Run test to verify it passes, and the existing suite still passes**

Run: `cd hooks && node --test test/smart-crusher-exports.test.js` → PASS.
Run: `cd hooks && node --test` → all hook tests green (the export addition breaks nothing; no test asserts an exact export set — verify).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/smart-crusher.js hooks/test/smart-crusher-exports.test.js
git commit -m "feat(dio19): export slot fractions from smart-crusher for the fidelity harness"
```

---

### Task 2: The importance-attributable survival measure (the core algorithm)

**Files:**
- Create: `mcp/src/fidelity-measure.ts` (the pure measure — no I/O, unit-testable)
- Test: `mcp/test/fidelity-measure.test.ts`

**Interfaces:**
- Consumes: from `hooks/lib/smart-crusher.js` (Task 1) — `compress`, `classifyRows`, `kneedleBudget`, `MIN_ROWS_TO_COMPRESS`, `SCHEMA_FRACTION`, `RECENCY_FRACTION`.
- Produces: `measurePayload(array: unknown[], importantIndices: number[], compressFn?: typeof compress): PayloadResult` where `PayloadResult = { attributable: number, survived: number, excludedP1: number, excludedP2: number, perPayloadRate: number | null }`; and `microAverage(results: PayloadResult[]): { rate: number, totalAttributable: number, totalSurvived: number }`. The optional `compressFn` (defaults to the real `compress`) exists ONLY so a test can stub a malformed result to drive the contract tripwire (ID-8/US-7) — production never passes it. These are the deterministic heart of the instrument; the script (Task 3) is I/O around them.

**This is the one genuinely non-obvious algorithm — it MUST mirror `compress()`'s slot logic exactly (`smart-crusher.js:389-432`), so the code is shown literally:**

- [ ] **Step 1: Write the failing tests (the confounder controls ARE the spec)**

```ts
import { describe, it, expect } from "vitest";
import { measurePayload, microAverage } from "../src/fidelity-measure.js";

// A payload large enough to compress (>= MIN_ROWS_TO_COMPRESS = 8), all plain droppable
// rows (no error/boundary/anomaly), so the whole array is the droppable pool.
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ k: `v${i}` }));

describe("measurePayload — importance-attributable survival", () => {
  it("excludes a P1 (preserved-class) important row from the denominator", () => {
    // index 0 is an error row → preserved → must be excluded as P1, not counted as survival.
    const arr = [{ error: "boom" }, ...rows(11)];
    const r = measurePayload(arr, [0]);
    expect(r.attributable).toBe(0);       // the only curated row was P1 → not attributable
    expect(r.excludedP1).toBe(1);
    expect(r.perPayloadRate).toBeNull();  // 0/0 → n/a, never 100%
  });

  it("excludes a P2 (position-band) important row from the denominator", () => {
    // A plain row at array index 0 lands in the schema-head band → P2 → excluded.
    const arr = rows(20);
    const r = measurePayload(arr, [0]);
    expect(r.excludedP2).toBe(1);
    expect(r.attributable).toBe(0);
    expect(r.perPayloadRate).toBeNull();
  });

  it("NUMERATOR — credits an importance-attributable row the ranker KEEPS (survived===1)", () => {
    // A mid-array row that is BOTH attributable (droppable, outside head/tail bands) AND
    // retained by the bigram importance ranker. This pins the numerator's KEEP branch:
    // survived MUST be 1, rate MUST be 1.0 — NOT a tautological "0 or 1".
    // Construct a payload where one mid-array row is bigram-rich (long distinctive content,
    // so the importance ranker keeps it) among otherwise-terse rows. The implementer picks
    // the index empirically: run compress(arr), confirm the chosen mid index ∈ retainedIndices
    // and verdicts[idx]==='droppable' and it is outside [0,schemaCount)∪tail-band, then assert:
    const arr = [
      ...rows(6),                                  // head fillers (terse)
      { k: "the-distinctive-richer-mid-row-aaa-bbb-ccc-ddd-eee" }, // index 6: bigram-rich, kept by importance
      ...rows(13),                                 // tail fillers (terse)
    ];
    const r = measurePayload(arr, [6]);
    expect(r.attributable).toBe(1);     // droppable + not position-guaranteed
    expect(r.survived).toBe(1);         // the ranker kept it — numerator KEEP branch
    expect(r.perPayloadRate).toBe(1);   // 1/1
  });

  it("NUMERATOR / US-2 DROP DETECTION — an attributable row the ranker DROPS lowers the rate (survived===0)", () => {
    // THE load-bearing US-2 case (PRD US-2 / Testing Decisions): an important row that
    // compress() DROPS must lower the rate, NOT be credited as survival. Construct a payload
    // whose budget keeps few importance-middle rows, so a terse low-bigram attributable row
    // is dropped. The implementer picks the index empirically: run compress(arr), confirm the
    // chosen mid index is verdict==='droppable', outside the position bands, and NOT in
    // retainedIndices (the importance budget didn't reach it), then assert:
    const arr = [
      ...rows(3),                                   // head band fillers
      ...Array.from({ length: 24 }, (_, i) => ({ k: `x${i}` })), // many terse droppables; budget can't keep all
      ...rows(3),                                   // tail band fillers
    ];
    // pick `dropped` = a mid index that compress() classifies droppable, is outside the
    // head schemaCount / tail recencyCount bands, and is absent from retainedIndices.
    const dropped = 18; // VERIFY against compress(arr).retainedIndices — must be droppable, non-position, AND absent from retainedIndices (15 is WRONG — it lands in the kept set; a dropped index provably exists in [3..12,18..27])
    const r = measurePayload(arr, [dropped]);
    expect(r.attributable).toBe(1);     // it IS importance-attributable (droppable, non-position)
    expect(r.survived).toBe(0);         // but the ranker dropped it — numerator DROP branch
    expect(r.perPayloadRate).toBe(0);   // 0/1 → the drop lowers the rate (US-2 proven)
  });

  it("a mixed payload yields a fractional rate (numerator AND denominator together)", () => {
    // Two attributable rows, one kept one dropped → rate 0.5. Proves survived is COUNTED,
    // not just bounded. Implementer constructs/verifies the two indices against compress().
    const arr = [
      ...rows(3),
      { k: "kept-rich-row-mmm-nnn-ooo-ppp-qqq-rrr" }, // index 3: kept by importance
      ...Array.from({ length: 20 }, (_, i) => ({ k: `y${i}` })),
      ...rows(3),
    ];
    // indices: one importance-kept (rich), one importance-dropped (terse), both attributable.
    const keptIdx = 3, droppedIdx = 4; // VERIFY against compress(arr) — keptIdx ∈ retainedIndices (rich row), droppedIdx droppable+non-position+absent from retainedIndices (14 is WRONG — kept; a satisfying dropped index provably exists)
    const r = measurePayload(arr, [keptIdx, droppedIdx]);
    expect(r.attributable).toBe(2);
    expect(r.survived).toBe(1);
    expect(r.perPayloadRate).toBe(0.5);
  });

  it("skips a sub-floor payload (compressed:false) — no vacuous 100%", () => {
    const arr = rows(5); // < MIN_ROWS_TO_COMPRESS
    expect(() => measurePayload(arr, [2])).toThrow(/below the compression floor/);
  });

  it("CONTRACT TRIPWIRE (ID-8/US-7) — a verdicts.length mismatch aborts loud", () => {
    // The real compress() never produces verdicts.length !== originalCount, so the tripwire
    // is only reachable via the injectable compressFn seam. STUB a malformed result (per
    // PRD Testing Decisions: "a stubbed compress() result with verdicts.length !== originalCount
    // makes the harness abort"). This proves the guard fires on a future DIO-7 indexing drift
    // instead of silently mismeasuring.
    const arr = rows(12);
    const badStub = (a: unknown[]) => ({
      compressed: true,
      retainedIndices: [0, 1, 2],
      retained: [],
      constants: {},
      verdicts: ["droppable"], // length 1 !== array length 12 — the contract violation
      droppedCount: 9,
      originalCount: a.length,
      originalHash: "stub",
    }) as any;
    expect(() => measurePayload(arr, [5], badStub)).toThrow(/contract tripwire/);
  });

  it("microAverage is row-weighted and ignores n/a payloads", () => {
    const a: any = { attributable: 4, survived: 3, excludedP1: 0, excludedP2: 0, perPayloadRate: 0.75 };
    const b: any = { attributable: 0, survived: 0, excludedP1: 2, excludedP2: 0, perPayloadRate: null };
    expect(microAverage([a, b])).toEqual({ rate: 0.75, totalAttributable: 4, totalSurvived: 3 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mcp && npx vitest run test/fidelity-measure.test.ts`
Expected: FAIL — `fidelity-measure.js` not found / functions undefined.

- [ ] **Step 3: Implement the measure (mirrors compress()'s split exactly)**

```ts
// mcp/src/fidelity-measure.ts
// Measurement-only. Recomputes which curated "important" rows are IMPORTANCE-ATTRIBUTABLE
// (droppable AND outside the schema-head/recency-tail position bands) so the survival rate
// credits ONLY the bigram importance ranker (P3) — never preserved-class (P1) or position (P2)
// survival. The slot logic MUST track smart-crusher.js:389-432.
//
// CROSS-BOUNDARY IMPORT: smart-crusher.js is UNTYPED CommonJS in hooks/; this file is strict
// ESM TypeScript in mcp/src/ (tsc-included). A static ESM `import ... from "../../hooks/..."`
// fails `tsc` with TS7016 (no .d.ts, noImplicitAny) — and update.sh runs `npm run build`=tsc
// on every mcp/ change. So cross the boundary via createRequire (the repo's established
// pattern — see mcp/test/episode-frontmatter-roundtrip.test.ts:9-12), with a LOCAL structural
// type for the compressor so the seam still type-checks under strict mode.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-var-requires */
const sc = require("../../hooks/lib/smart-crusher.js") as {
  compress: CompressFn;
  classifyRows: (array: unknown[]) => { verdicts: string[]; fields: unknown };
  kneedleBudget: (array: unknown[], droppableIndices: number[]) => number;
  MIN_ROWS_TO_COMPRESS: number;
  SCHEMA_FRACTION: number;
  RECENCY_FRACTION: number;
};
const { compress, classifyRows, kneedleBudget, MIN_ROWS_TO_COMPRESS, SCHEMA_FRACTION, RECENCY_FRACTION } = sc;

// The compressor's result shape the measure depends on (a local structural type — the hooks
// module ships no .d.ts). Only the fields the measure reads are declared.
interface CompressResult {
  compressed: boolean;
  retainedIndices: number[];
  verdicts: string[];
  originalCount: number;
}
type CompressFn = (array: unknown[]) => CompressResult;

export interface PayloadResult {
  attributable: number; survived: number; excludedP1: number; excludedP2: number;
  perPayloadRate: number | null;
}

// `compressFn` is injectable (defaults to the real compress) ONLY so a test can stub a
// malformed result to drive the contract tripwire (ID-8/US-7) — the real compress() never
// produces a verdicts.length mismatch, so without this seam the tripwire would be untestable
// dead code. Production always uses the default.
export function measurePayload(
  array: unknown[],
  importantIndices: number[],
  compressFn: CompressFn = compress,
): PayloadResult {
  if (array.length < MIN_ROWS_TO_COMPRESS) {
    throw new Error(`payload below the compression floor (${array.length} < ${MIN_ROWS_TO_COMPRESS})`);
  }
  const result = compressFn(array);
  if (result.compressed !== true) {
    throw new Error("payload below the compression floor (compress returned compressed:false)");
  }
  if (result.verdicts.length !== array.length) {
    throw new Error("contract tripwire: verdicts.length !== originalCount");
  }
  const retained = new Set<number>(result.retainedIndices);

  // P1: preserved class — verdict !== 'droppable'. droppableIndices in ascending original
  // order (matches smart-crusher.js:399-400: a forward scan over non-preserved indices).
  const verdicts: string[] = result.verdicts;
  const droppableIndices: number[] = [];
  for (let i = 0; i < array.length; i++) if (verdicts[i] === "droppable") droppableIndices.push(i);

  // P2 position bands: the first schemaCount and last recencyCount of the droppable pool,
  // sized to the importance budget exactly as compress() does (smart-crusher.js:404,:409-410).
  const budget = kneedleBudget(array, droppableIndices);
  const schemaCount = Math.round(budget * SCHEMA_FRACTION);
  const recencyCount = Math.round(budget * RECENCY_FRACTION);
  const positionGuaranteed = new Set<number>();
  for (let k = 0; k < schemaCount && k < droppableIndices.length; k++) {
    positionGuaranteed.add(droppableIndices[k]);
  }
  for (let k = 0; k < recencyCount && k < droppableIndices.length; k++) {
    positionGuaranteed.add(droppableIndices[droppableIndices.length - 1 - k]);
  }

  const droppableSet = new Set(droppableIndices);
  let attributable = 0, survived = 0, excludedP1 = 0, excludedP2 = 0;
  for (const idx of importantIndices) {
    if (!droppableSet.has(idx)) { excludedP1++; continue; }       // P1: preserved class
    if (positionGuaranteed.has(idx)) { excludedP2++; continue; }  // P2: position band
    attributable++;                                               // P3-eligible: importance ranker is the only keep path
    if (retained.has(idx)) survived++;
  }
  const perPayloadRate = attributable === 0 ? null : survived / attributable;
  return { attributable, survived, excludedP1, excludedP2, perPayloadRate };
}

export function microAverage(results: PayloadResult[]) {
  let totalAttributable = 0, totalSurvived = 0;
  for (const r of results) { totalAttributable += r.attributable; totalSurvived += r.survived; }
  // Whole-set-empty (no attributable rows across ANY payload) is degenerate and unreachable
  // under the PRD's mandated curation (every payload has attributable rows), but DON'T emit NaN:
  // JSON.stringify(NaN) === 'null', so a baseline would silently store null and a later compose
  // could mis-read it as 0 → spurious PASS. Return rate=null and let the caller treat a null-rate
  // run as "no measurement / abort", never as a passing 0 or a comparable number.
  const rate = totalAttributable === 0 ? null : totalSurvived / totalAttributable;
  return { rate, totalAttributable, totalSurvived };
}
```
(The script's `composeFidelityVerdict` MUST treat a `rate === null` current-or-prior run as a hard abort/INCONCLUSIVE — never CAPTURE a null baseline and never compare against one — so the degenerate whole-set-empty case can never serialize to a spurious PASS.)

- [ ] **Step 4: Run to verify it passes — vitest AND the gated build**

Run: `cd mcp && npx vitest run test/fidelity-measure.test.ts`
Expected: PASS — all tests, including BOTH confounder-control tests (P1 class, P2 position), the NUMERATOR keep test (survived===1), the NUMERATOR/US-2 DROP-detection test (survived===0, rate 0), the mixed-rate test (rate 0.5), and the CONTRACT TRIPWIRE stub test. Note: the survivor/drop/mixed tests pin concrete indices the implementer MUST verify against `compress(arr).retainedIndices` for each constructed payload — if a chosen index doesn't classify droppable / land outside the position bands / match the intended keep-or-drop, adjust the payload or index until it does (the assertion values — survived 1/0, rate 1/0/0.5 — are fixed; the indices are tuned to make them true against the real compressor). This is what proves the numerator, not a tautology.

Then run the GATED BUILD — this is mandatory, because `update.sh` runs `npm run build` (=tsc) on every mcp/ change, and vitest (esbuild, no type-check) will NOT catch a tsc error that provisioning would:

Run: `cd mcp && npm run build`
Expected: exit 0, no TS7016. The createRequire bridge (not a static ESM import of the untyped CJS hooks module) is what makes this pass under the strict tsconfig. If `tsc` errors on `../../hooks/lib/smart-crusher.js`, the cross-boundary import regressed to a static import — restore the createRequire pattern.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/fidelity-measure.ts mcp/test/fidelity-measure.test.ts
git commit -m "feat(dio19): importance-attributable survival measure (excludes P1/P2 confounders)"
```

---

### Task 3: The fidelity.ts script — load set, run measure, baseline, print (mirrors eval.ts)

**Files:**
- Create: `mcp/src/scripts/fidelity.ts`
- Create: `mcp/eval/fidelity-payloads.template.json` (the committed disjoint labeled-set template)
- Modify: `mcp/package.json` (add `"fidelity": "tsx src/scripts/fidelity.ts"`)
- Modify: `update.sh` (provision the template → `~/.claude-data/eval/fidelity-payloads.json`, only-if-absent, mirroring the eval-set step)
- Modify: `docs/eval-gate-protocol.md` (add the disjointness rule next to the held-out doctrine)
- Test: `mcp/test/fidelity-script.test.ts` (disjointness guard + baseline capture/compose)

**Interfaces:**
- Consumes: `measurePayload`, `microAverage` (Task 2); the `readBaseline`/`writeBaseline` pattern from `eval.ts`.
- Produces: `npm run fidelity` → loads `~/.claude-data/eval/fidelity-payloads.json`, measures each payload, prints the micro-average rate + audit counts (excludedP1/P2 totals) + per-payload breakdown (with `n/a` for empty sets), captures/compares a baseline at `~/.claude-data/eval/fidelity-baseline.json`.

- [ ] **Step 1: Write the failing tests**

Test the two things the script owns beyond the measure: (a) the labeled set is disjoint from the eval set, and (b) baseline capture-then-compose. Concretely:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { composeFidelityVerdict, type FidelityBaseline } from "../src/scripts/fidelity.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalTpl = join(here, "..", "eval", "labeled-queries.template.json");
const fidTpl = join(here, "..", "eval", "fidelity-payloads.template.json");

describe("fidelity labeled set", () => {
  it("is DISJOINT from the eval presence set (no shared entries)", () => {
    // Structurally different types (queries vs raw arrays). Assert no payload array
    // equals any eval query's content — the leakage tripwire (ID-6).
    const fid = JSON.parse(readFileSync(fidTpl, "utf8"));
    const ev = JSON.parse(readFileSync(evalTpl, "utf8"));
    const evalText = JSON.stringify(ev);
    for (const entry of fid.payloads) {
      expect(evalText).not.toContain(JSON.stringify(entry.array));
    }
  });
});

describe("composeFidelityVerdict", () => {
  it("captures on first run (no baseline), composes a delta on second", () => {
    const cur: FidelityBaseline = { rate: 0.8, total_attributable: 10, captured_on_ref: "x" };
    expect(composeFidelityVerdict(null, cur).status).toBe("CAPTURED");
    const prev: FidelityBaseline = { rate: 0.9, total_attributable: 10, captured_on_ref: "w" };
    expect(composeFidelityVerdict(prev, cur).status).toBe("REGRESSED"); // 0.8 < 0.9
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mcp && npx vitest run test/fidelity-script.test.ts`
Expected: FAIL — `fidelity.ts` / the template don't exist yet.

- [ ] **Step 3: Create the template, the script, the npm script, the provisioning, the doc**

- `mcp/eval/fidelity-payloads.template.json`: a `curation` block (`date`, `approver`, `corpus_snapshot`, `fidelity_floor`, and `_criterion` fixed to the ID-10 wording — droppable rows only, terse-high-value included, NO status/threshold/failure-signal) plus a `payloads` array of entries `{ array, important_indices, notes }`. Seed 8–15 representative payloads, each `>= MIN_ROWS_TO_COMPRESS`, with `important_indices` aimed at mid-array plain rows (the per-index `note` records the row's intent). A leading `_note` states the disjointness rule.
- `mcp/src/scripts/fidelity.ts`: mirror `eval.ts` — `LABELS_PATH = ~/.claude-data/eval/fidelity-payloads.json`, `BASELINE_PATH = ~/.claude-data/eval/fidelity-baseline.json`, a `gitRef()` provenance helper, `readBaseline`/`writeBaseline`, a `composeFidelityVerdict(prev, cur)` that returns `{ status: "CAPTURED" | "PASS" | "REGRESSED", … }` (REGRESSED when `cur.rate < prev.rate` beyond a small epsilon), and a `main()` that loads the set, maps `measurePayload` over it, computes `microAverage`, prints the rate + excludedP1/P2 totals + per-payload table (`n/a` for null), and captures/composes the baseline. Export `composeFidelityVerdict` and the `FidelityBaseline` type for the test.
- `mcp/package.json`: add `"fidelity": "tsx src/scripts/fidelity.ts"`.
- `update.sh`: add a step (mirroring the eval-set provisioning) that copies `mcp/eval/fidelity-payloads.template.json` → `~/.claude-data/eval/fidelity-payloads.json` only if absent.
- `docs/eval-gate-protocol.md`: add a short subsection stating the fidelity set is disjoint-by-construction from the held-out presence set and must never share rows (train/test leakage).

- [ ] **Step 4: Run to verify it passes**

Run: `cd mcp && npx vitest run test/fidelity-script.test.ts` → PASS.
Run: `cd mcp && npm run build` → exit 0 (the gated tsc build — fidelity.ts is in mcp/src/, so it must type-check; it imports the measure, which uses the createRequire bridge for the hooks boundary).
Run (smoke): provision the template to a temp path and `npm run fidelity` against it → prints a rate line + audit counts, exit 0.

- [ ] **Step 5: Run prettier + commit**

```bash
npx prettier --write mcp/src/scripts/fidelity.ts mcp/eval/fidelity-payloads.template.json mcp/package.json mcp/test/fidelity-script.test.ts
git add mcp/src/scripts/fidelity.ts mcp/eval/fidelity-payloads.template.json mcp/package.json update.sh docs/eval-gate-protocol.md mcp/test/fidelity-script.test.ts
git commit -m "feat(dio19): fidelity A/B harness script + disjoint labeled-set template"
```

---

### Task 4: QA verification (the make-it-so review lane consumes this)

**Files:** none new — this task is the verification pass, not code. It is the make-it-so Gate 3 + comprehensive-review lane over the implemented diff. (Tracked as task-manager Task #10.)

- [ ] **Step 1:** Confirm the full mcp suite green: `cd mcp && npx vitest run`.
- [ ] **Step 2:** Confirm the full hooks suite green: `cd hooks && node --test`.
- [ ] **Step 3:** Confirm the instrument's validity proof — ALL pass: both confounder-control tests (P1 class, P2 position); the **numerator KEEP test** (survived===1); the **numerator/US-2 DROP-detection test** (survived===0, rate 0 — an attributable row the ranker drops lowers the rate); the **mixed-rate test** (rate 0.5); the floor guard; determinism (run the measure twice over the template, byte-identical rate); the disjointness guard; the contract tripwire. The numerator KEEP+DROP pair is what proves the rate measures real survival, not a tautology.
- [ ] **Step 4:** Confirm the GATED BUILD passes: `cd mcp && npm run build` → exit 0, no TS7016 (this is what `update.sh` runs on every mcp/ change; vitest's esbuild does NOT type-check, so the build is a separate, mandatory gate — the cross-boundary import must use the createRequire bridge, not a static ESM import of the untyped hooks module).
- [ ] **Step 5:** Hand off to the make-it-so Gate 3 (red-blue-judge diff) + Step 5 review.

---

## Self-Review

**1. Spec coverage** (PRD → task): ID-1/ID-11 importance-attributable measure + both confounder exclusions → Task 2 (the algorithm + the two confounder-control tests). **US-2 drop-detection (the non-tautology premise) → Task 2's NUMERATOR tests: a kept attributable row (survived===1) AND a dropped attributable row (survived===0, rate lowered) AND a mixed 0.5 case — these pin the survival numerator, not just the denominator.** ID-13 export → Task 1. ID-4/ID-5/ID-6 disjoint template + provisioning + npm script + disjointness enforcement → Task 3. ID-8 contract tripwire → Task 2 (the `verdicts.length` check in `measurePayload` AND its dedicated stub test that drives the abort via the injectable `compressFn` seam — the tripwire is genuinely exercised, not just present). ID-9 fidelity_floor (owner-set) → Task 3 template `curation.fidelity_floor` + the REGRESSED compose. ID-10 criterion → Task 3 template `_criterion`. ID-12 floor guard → Task 2 (sub-floor throw) + Task 3 (`>= MIN_ROWS_TO_COMPRESS` payloads). Micro-average + 0/0 n/a → Task 2 (`microAverage`, `perPayloadRate`). US-3 determinism → Task 4 Step 3. **No gaps.**

**1b. Build correctness:** the measure crosses the mcp(strict-ESM-TS)↔hooks(untyped-CJS) boundary via `createRequire(import.meta.url)` + a local structural type, NOT a static ESM import — because a static import fails `tsc` (TS7016) and `update.sh` runs `npm run build` on every mcp/ change. Tasks 2 and 3 both add a `npm run build` (=tsc) step; Task 4 re-confirms it. This is the repo's only working mcp↔hooks precedent (`mcp/test/episode-frontmatter-roundtrip.test.ts:9-12`). ✅

**2. Placeholder scan:** the one non-obvious algorithm (the measure) is shown in full literal code; the script (Task 3) is described against the verified `eval.ts` pattern rather than reproduced (lean-plan rule — the script is boilerplate-shaped I/O around the measure, and Gate 3 verifies it). No TBD/TODO. ✅

**3. Type consistency:** `measurePayload`/`microAverage`/`PayloadResult` consistent Tasks 2/3/4. `composeFidelityVerdict`/`FidelityBaseline` consistent Task 3/its test. The exported names from Task 1 (`SCHEMA_FRACTION`/`RECENCY_FRACTION`/`classifyRows`/`kneedleBudget`/`MIN_ROWS_TO_COMPRESS`) match Task 2's import list. ✅

**Out of scope (not built):** the #72 arming flip, the error/anomaly/boundary slice, a pinned floor number, routing through `npm run eval`, a live model judge.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-dio19-fidelity-ab-harness.md`.** Next (per make-it-so): **Gate 2 — red-blue-judge (mode: plan)** against this plan with the approved PRD + codebase as ground truth, before any execution.
