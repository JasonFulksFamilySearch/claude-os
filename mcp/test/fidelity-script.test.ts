import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeFidelityVerdict,
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
    const cur: FidelityBaseline = {
      rate: 0.8,
      total_attributable: 10,
      captured_on_ref: "x",
    };
    expect(composeFidelityVerdict(null, cur).status).toBe("CAPTURED");
    const prev: FidelityBaseline = {
      rate: 0.9,
      total_attributable: 10,
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
      captured_on_ref: "x",
    } as any;
    const cur: FidelityBaseline = {
      rate: 0.8,
      total_attributable: 10,
      captured_on_ref: "y",
    };
    const result = composeFidelityVerdict(corruptPrev, cur);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reason).toMatch(/baseline/i);
  });

  it("returns INCONCLUSIVE when labeled-set attributable population changed (shape mismatch)", () => {
    // Comparability guard: a baseline captured on one labeled set (attributable=30) composed
    // against a run on a re-curated set (attributable=25) is not comparable — even when the
    // current rate is higher (0.9 > 0.5). A higher rate must NOT mask the shape change.
    const prev: FidelityBaseline = {
      rate: 0.5,
      total_attributable: 30,
      captured_on_ref: "x",
    };
    const cur: FidelityBaseline = {
      rate: 0.9,
      total_attributable: 25,
      captured_on_ref: "y",
    };
    const result = composeFidelityVerdict(prev, cur);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reason).toMatch(/attributable/i);
  });
});
