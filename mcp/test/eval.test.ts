import { describe, it, expect } from "vitest";
import {
  recallAtK,
  reciprocalRank,
  mean,
  absenceProbePass,
  aggregateAbsenceStage,
  presenceVerdict,
  composeVerdict,
  isBaselineCapture,
} from "../src/eval.js";

describe("recallAtK", () => {
  it("counts relevant items found within the top k", () => {
    // top2 = [3,1]; relevant {1,2}; found {1} ⇒ 1/2.
    expect(recallAtK([3, 1, 2], [1, 2], 2)).toBeCloseTo(0.5, 10);
  });
  it("is 1 when all relevant items are within k", () => {
    expect(recallAtK([1, 2, 3], [1, 2], 5)).toBeCloseTo(1, 10);
  });
  it("is 0 when no relevant item is within k", () => {
    expect(recallAtK([1, 2], [2], 1)).toBe(0);
  });
  it("is 0 (not NaN) when there are no relevant items", () => {
    expect(recallAtK([1, 2, 3], [], 3)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("is 1/rank of the first relevant hit (1-based)", () => {
    expect(reciprocalRank([3, 1, 2], [1])).toBeCloseTo(0.5, 10); // hit at position 2
  });
  it("is 1 when the first result is relevant", () => {
    expect(reciprocalRank([2, 5], [2])).toBe(1);
  });
  it("is 0 when no result is relevant", () => {
    expect(reciprocalRank([3, 4], [1])).toBe(0);
  });
});

describe("mean", () => {
  it("averages the values", () => {
    expect(mean([1, 0.5, 0])).toBeCloseTo(0.5, 10);
  });
  it("is 0 (not NaN) for an empty list", () => {
    expect(mean([])).toBe(0);
  });
});

describe("absenceProbePass", () => {
  it("passes when no top-k path contains the forbidden substring", () => {
    expect(absenceProbePass(["a/keep.md", "b/keep.md"], { sourcePathContains: "stale" })).toBe(true);
  });
  it("fails when a top-k path contains the forbidden substring", () => {
    expect(absenceProbePass(["a/keep.md", "x/stale.md"], { sourcePathContains: "stale" })).toBe(false);
  });
});

describe("aggregateAbsenceStage", () => {
  it("unarmed stage is SKIPPED regardless of probe results", () => {
    expect(aggregateAbsenceStage(false, [true, false])).toEqual({ status: "SKIPPED", n: 0, passes: 0 });
  });
  it("armed stage with zero probes is INCONCLUSIVE", () => {
    expect(aggregateAbsenceStage(true, [])).toEqual({ status: "INCONCLUSIVE", n: 0, passes: 0 });
  });
  it("armed stage with all probes passing is PASS", () => {
    expect(aggregateAbsenceStage(true, [true, true])).toEqual({ status: "PASS", n: 2, passes: 2 });
  });
  it("armed stage with any probe failing is FAIL", () => {
    expect(aggregateAbsenceStage(true, [true, false])).toEqual({ status: "FAIL", n: 2, passes: 1 });
  });
});

describe("presenceVerdict", () => {
  const base = { meanRecallAtK: 0.8, mrr: 0.7 };
  it("CAPTURING when no baseline yet", () => {
    expect(presenceVerdict({ meanRecallAtK: 0.8, mrr: 0.7 }, null, false)).toBe("CAPTURING");
  });
  it("INCONCLUSIVE when labels are broken", () => {
    expect(presenceVerdict({ meanRecallAtK: 0.9, mrr: 0.9 }, base, true)).toBe("INCONCLUSIVE");
  });
  it("PASS when both metrics are >= baseline", () => {
    expect(presenceVerdict({ meanRecallAtK: 0.8, mrr: 0.71 }, base, false)).toBe("PASS");
  });
  it("FAIL when recall regresses", () => {
    expect(presenceVerdict({ meanRecallAtK: 0.79, mrr: 0.71 }, base, false)).toBe("FAIL");
  });
  it("FAIL when MRR regresses", () => {
    expect(presenceVerdict({ meanRecallAtK: 0.81, mrr: 0.69 }, base, false)).toBe("FAIL");
  });
});

describe("composeVerdict (precedence CAPTURING > FAIL > INCONCLUSIVE > PASS)", () => {
  const skipped = { status: "SKIPPED" as const, n: 0, passes: 0 };
  const pass = { status: "PASS" as const, n: 1, passes: 1 };
  const fail = { status: "FAIL" as const, n: 1, passes: 0 };
  const inc = { status: "INCONCLUSIVE" as const, n: 0, passes: 0 };
  it("CAPTURING presence short-circuits to CAPTURING", () => {
    expect(composeVerdict("CAPTURING", [pass])).toBe("CAPTURING");
  });
  it("PASS when presence PASS and only SKIPPED stages (C1 state)", () => {
    expect(composeVerdict("PASS", [skipped])).toBe("PASS");
  });
  it("PASS when presence PASS and every armed stage PASS", () => {
    expect(composeVerdict("PASS", [pass, skipped])).toBe("PASS");
  });
  it("FAIL dominates over INCONCLUSIVE and PASS", () => {
    expect(composeVerdict("PASS", [fail, inc])).toBe("FAIL");
  });
  it("INCONCLUSIVE when no FAIL but an armed stage is INCONCLUSIVE", () => {
    expect(composeVerdict("PASS", [inc, skipped])).toBe("INCONCLUSIVE");
  });
  it("presence FAIL fails the composed verdict", () => {
    expect(composeVerdict("FAIL", [skipped])).toBe("FAIL");
  });
});

describe("isBaselineCapture", () => {
  it("captures when no baseline exists", () => {
    expect(isBaselineCapture(false, false)).toBe(true);
  });
  it("captures when --rebaseline is set even if a baseline exists", () => {
    expect(isBaselineCapture(true, true)).toBe(true);
  });
  it("composes (does not capture) when a baseline exists and no --rebaseline", () => {
    expect(isBaselineCapture(true, false)).toBe(false);
  });
});
