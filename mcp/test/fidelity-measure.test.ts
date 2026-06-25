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
    // Verified: arr.length=20, budget=11, schemaCount=3, recencyCount=2
    // positionBand={0,1,2,18,19}; idx=6: droppable=true, inBand=false, inRetained=true
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
    // Verified: arr.length=30, budget=10, schemaCount=3, recencyCount=2
    // positionBand={0,1,2,28,29}; idx=18: droppable=true, inBand=false, inRetained=false
    // (importance budget kept indices 13-17 among the middle; 18 falls outside that budget)
    const dropped = 18;
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
    // Verified: arr.length=27, budget=11, schemaCount=3, recencyCount=2
    // positionBand={0,1,2,25,26}
    // idx=3: droppable=true, inBand=false, inRetained=true  (rich row → kept by importance)
    // idx=4: droppable=true, inBand=false, inRetained=false (terse y0 row → dropped)
    const keptIdx = 3, droppedIdx = 4;
    const r = measurePayload(arr, [keptIdx, droppedIdx]);
    expect(r.attributable).toBe(2);
    expect(r.survived).toBe(1);
    expect(r.perPayloadRate).toBe(0.5);
  });

  it("skips a sub-floor payload (compressed:false) — no vacuous 100%", () => {
    const arr = rows(5); // < MIN_ROWS_TO_COMPRESS
    expect(() => measurePayload(arr, [2])).toThrow(/below the compression floor/);
  });

  it("aborts loud on an out-of-range important_index — a curation typo must not silently become P1", () => {
    // An index past the payload's end is a malformed labeled set, not a measurable row.
    // Bucketing it as P1 would silently understate the attributable denominator and skew
    // the gated arming number — so the measure throws rather than swallowing it.
    const arr = rows(12);
    expect(() => measurePayload(arr, [45])).toThrow(/out of range/);
    expect(() => measurePayload(arr, [-1])).toThrow(/out of range/);
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
