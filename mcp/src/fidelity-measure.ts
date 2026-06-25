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
  kneedleBudget: (array: unknown[], droppableIndices: number[]) => number;
  MIN_ROWS_TO_COMPRESS: number;
  SCHEMA_FRACTION: number;
  RECENCY_FRACTION: number;
};
const { compress, kneedleBudget, MIN_ROWS_TO_COMPRESS, SCHEMA_FRACTION, RECENCY_FRACTION } = sc;

// The compressor's result shape the measure depends on (a local structural type — the hooks
// module ships no .d.ts). Only the fields the measure reads are declared.
interface CompressResult {
  compressed: boolean;
  retainedIndices: number[];
  verdicts: string[];
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
