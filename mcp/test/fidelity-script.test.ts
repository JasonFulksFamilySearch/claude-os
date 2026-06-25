import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeFidelityVerdict,
  labeledSetHash,
  type FidelityBaseline,
} from "../src/scripts/fidelity.js";

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
    const hash = labeledSetHash([{ array: [{ a: 1 }, { b: 2 }], important_indices: [0] }]);
    const cur: FidelityBaseline = {
      rate: 0.8,
      total_attributable: 10,
      labeled_set_hash: hash,
      captured_on_ref: "x",
    };
    expect(composeFidelityVerdict(null, cur).status).toBe("CAPTURED");
    const prev: FidelityBaseline = {
      rate: 0.9,
      total_attributable: 10,
      labeled_set_hash: hash,
      captured_on_ref: "w",
    };
    expect(composeFidelityVerdict(prev, cur).status).toBe("REGRESSED"); // 0.8 < 0.9
  });

  it("returns INCONCLUSIVE when current rate is null (degenerate set — no measurement)", () => {
    // Guards the null-rate contract: a null rate must never be captured or composed against.
    // JSON.stringify(NaN) === 'null', so a null that slipped into a baseline could later be
    // misread as 0 → spurious PASS. INCONCLUSIVE is the hard abort.
    const nullCur = {
      rate: null,
      total_attributable: 0,
      captured_on_ref: "y",
    } as any;
    expect(composeFidelityVerdict(null, nullCur).status).toBe("INCONCLUSIVE");
    const prev: FidelityBaseline = {
      rate: 0.9,
      total_attributable: 10,
      labeled_set_hash: "AAA",
      captured_on_ref: "w",
    };
    expect(composeFidelityVerdict(prev, nullCur).status).toBe("INCONCLUSIVE");
  });

  it("returns INCONCLUSIVE when prior baseline rate is null (corrupt prior baseline)", () => {
    // Guards the corrupt-prior guard: if a stored baseline somehow has rate: null
    // (e.g. JSON.stringify(NaN) written in a prior session), composing against it
    // must abort rather than yield a misleading PASS or REGRESSED verdict.
    const corruptPrev = {
      rate: null,
      total_attributable: 0,
      labeled_set_hash: "AAA",
      captured_on_ref: "x",
    } as any;
    const cur: FidelityBaseline = {
      rate: 0.8,
      total_attributable: 10,
      labeled_set_hash: "AAA",
      captured_on_ref: "y",
    };
    const result = composeFidelityVerdict(corruptPrev, cur);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reason).toMatch(/baseline/i);
  });

  it("returns INCONCLUSIVE when baseline predates the content-hash guard (no labeled_set_hash)", () => {
    // A pre-fix baseline has no labeled_set_hash. Composing against it must force a
    // re-capture rather than silently skipping the comparability check.
    const prevNohash: FidelityBaseline = {
      rate: 0.5,
      total_attributable: 30,
      captured_on_ref: "x",
      // labeled_set_hash intentionally absent
    };
    const cur: FidelityBaseline = {
      rate: 0.99,
      total_attributable: 30,
      labeled_set_hash: "BBB",
      captured_on_ref: "y",
    };
    const result = composeFidelityVerdict(prevNohash, cur);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reason).toMatch(/predates/i);
  });

  it("returns INCONCLUSIVE when labeled-set CONTENT changed at equal total_attributable (the exact hole the old count guard missed)", () => {
    // The old guard compared total_attributable counts and missed content swaps that keep
    // the count stable (same 30 attributable rows, different payload content).
    // composeFidelityVerdict({rate:0.40, total_attributable:30, labeled_set_hash:"AAA"},
    //                        {rate:0.99, total_attributable:30, labeled_set_hash:"BBB"})
    // MUST return INCONCLUSIVE — a higher current rate must NOT mask the content swap.
    const prev: FidelityBaseline = {
      rate: 0.4,
      total_attributable: 30,
      labeled_set_hash: "AAA",
      captured_on_ref: "x",
    };
    const cur: FidelityBaseline = {
      rate: 0.99,
      total_attributable: 30,
      labeled_set_hash: "BBB",
      captured_on_ref: "y",
    };
    const result = composeFidelityVerdict(prev, cur);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reason).toMatch(/labeled set content/i);
  });

  it("returns PASS when labeled-set content is unchanged and rate did not regress", () => {
    // The hash guard must not over-fire: matching hashes with equal/better rate → PASS.
    const hash = "SAME_HASH";
    const prev: FidelityBaseline = {
      rate: 0.8,
      total_attributable: 30,
      labeled_set_hash: hash,
      captured_on_ref: "x",
    };
    const cur: FidelityBaseline = {
      rate: 0.85,
      total_attributable: 30,
      labeled_set_hash: hash,
      captured_on_ref: "y",
    };
    expect(composeFidelityVerdict(prev, cur).status).toBe("PASS");
  });

  it("returns REGRESSED when labeled-set content is unchanged and rate regressed", () => {
    // The hash guard must not over-fire: matching hashes with a lower rate → REGRESSED.
    const hash = "SAME_HASH";
    const prev: FidelityBaseline = {
      rate: 0.9,
      total_attributable: 30,
      labeled_set_hash: hash,
      captured_on_ref: "x",
    };
    const cur: FidelityBaseline = {
      rate: 0.7,
      total_attributable: 30,
      labeled_set_hash: hash,
      captured_on_ref: "y",
    };
    expect(composeFidelityVerdict(prev, cur).status).toBe("REGRESSED");
  });

  it("labeledSetHash is stable across calls (deterministic) and excludes notes", () => {
    const payloads1 = [{ array: [{ a: 1 }, { b: 2 }], important_indices: [0] }];
    const payloads2 = [
      {
        array: [{ a: 1 }, { b: 2 }],
        important_indices: [0],
        notes: "different note",
      },
    ];
    // Same content → same hash
    expect(labeledSetHash(payloads1)).toBe(labeledSetHash(payloads1));
    // Notes difference → same hash (notes excluded from measurement fields)
    expect(labeledSetHash(payloads1)).toBe(labeledSetHash(payloads2));
    // Different content → different hash
    const payloads3 = [
      { array: [{ a: 99 }, { b: 2 }], important_indices: [0] },
    ];
    expect(labeledSetHash(payloads1)).not.toBe(labeledSetHash(payloads3));
  });
});
