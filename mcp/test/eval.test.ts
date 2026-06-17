import { describe, it, expect } from "vitest";
import {
  recallAtK,
  reciprocalRank,
  mean,
  fileLevelRecallAtK,
  fileLevelReciprocalRank,
  fileSetHash,
  isFileSetShapeChange,
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

describe("fileLevelRecallAtK", () => {
  it("hits when ANY chunk of an expected file is in the top-k", () => {
    // learnings surfaces as 3 chunks; still exactly one file-level hit ⇒ 1/1.
    expect(
      fileLevelRecallAtK(["a/learnings.md", "a/learnings.md", "a/learnings.md"], ["learnings"], 5),
    ).toBeCloseTo(1, 10);
  });
  it("misses when no top-k path contains the expected substring", () => {
    expect(fileLevelRecallAtK(["a/jira.md", "b/github.md"], ["episode"], 5)).toBe(0);
  });
  it("denominator is the expected-file count, independent of chunk count", () => {
    // jira surfaced (3 chunks), github not ⇒ 1 of 2 expected files = 0.5.
    expect(
      fileLevelRecallAtK(["a/jira.md", "a/jira.md", "c/misc.md"], ["jira", "github"], 5),
    ).toBeCloseTo(0.5, 10);
  });
  it("is 0 (not NaN) when there are no expected files", () => {
    expect(fileLevelRecallAtK(["a/x.md"], [], 5)).toBe(0);
  });
  it("counts a file surfaced at exactly rank k, not at rank k+1", () => {
    const ranked = ["m1", "m2", "m3", "m4", "c/github.md", "c/jira.md"];
    expect(fileLevelRecallAtK(ranked, ["github"], 5)).toBeCloseTo(1, 10); // rank 5 counts
    expect(fileLevelRecallAtK(ranked, ["jira"], 5)).toBe(0); // rank 6 excluded
  });
});

describe("fileLevelReciprocalRank", () => {
  it("is 1/rank of the first ranked path matching any expected substring", () => {
    expect(fileLevelReciprocalRank(["a/x.md", "b/jira.md", "c/y.md"], ["jira"])).toBeCloseTo(0.5, 10);
  });
  it("is 1 when the first result matches", () => {
    expect(fileLevelReciprocalRank(["a/jira.md", "b/x.md"], ["jira", "github"])).toBe(1);
  });
  it("is 0 when no result matches", () => {
    expect(fileLevelReciprocalRank(["a/x.md", "b/y.md"], ["jira"])).toBe(0);
  });
});

describe("file-level metric is granularity-invariant (the cure for D-b)", () => {
  // The same retrieval quality expressed at two granularities. Whole-file = one row per
  // file; chunked = N rows sharing a source_path per file. jira surfaces (any chunk),
  // github does not, in BOTH — so file-level recall must be identical (0.5), even though
  // the chunked top-k is crowded with 3 jira chunks. This is the case the old
  // observation-row denominator would have suppressed.
  const expected = ["jira", "github"];
  const wholeFile = ["a/jira.md", "b/other.md", "c/misc.md", "d/foo.md", "e/bar.md"];
  const chunked = ["a/jira.md", "a/jira.md", "c/misc.md", "a/jira.md", "e/bar.md"];
  it("yields identical file-level recall at both granularities", () => {
    expect(fileLevelRecallAtK(chunked, expected, 5)).toBeCloseTo(
      fileLevelRecallAtK(wholeFile, expected, 5),
      10,
    );
    expect(fileLevelRecallAtK(wholeFile, expected, 5)).toBeCloseTo(0.5, 10);
  });
  it("yields identical file-level MRR at both granularities", () => {
    expect(fileLevelReciprocalRank(chunked, expected)).toBeCloseTo(
      fileLevelReciprocalRank(wholeFile, expected),
      10,
    );
    expect(fileLevelReciprocalRank(wholeFile, expected)).toBe(1);
  });
});

describe("fileSetHash", () => {
  it("is stable regardless of input order or chunk-multiplicity duplicates", () => {
    expect(fileSetHash(["b.md", "a.md", "b.md"])).toBe(fileSetHash(["a.md", "b.md"]));
  });
  it("differs when a file is added or removed", () => {
    expect(fileSetHash(["a.md", "b.md"])).not.toBe(fileSetHash(["a.md", "b.md", "c.md"]));
  });
  it("a chunk-split (more rows, same file set) does not change the hash", () => {
    const wholeFile = ["a.md", "b.md"];
    const chunked = ["a.md", "a.md", "a.md", "b.md", "b.md"]; // same files, many rows
    expect(fileSetHash(chunked)).toBe(fileSetHash(wholeFile));
  });
});

describe("isFileSetShapeChange (boundary-gated, zero-tolerance)", () => {
  it("off the cutover boundary, never a shape change even if the file set differs", () => {
    expect(isFileSetShapeChange("h1", "h2", false)).toBe(false);
  });
  it("at the boundary with identical hashes (chunk-count jump only) is not a shape change", () => {
    expect(isFileSetShapeChange("h1", "h1", true)).toBe(false);
  });
  it("at the boundary with differing hashes (file added/removed) is a shape change", () => {
    expect(isFileSetShapeChange("h1", "h2", true)).toBe(true);
  });
  it("a pre-fix baseline lacking the hash cannot be compared ⇒ not a shape change", () => {
    expect(isFileSetShapeChange(undefined, "h2", true)).toBe(false);
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

describe("composeVerdict shape-change escalation (WARN W2)", () => {
  const skipped = { status: "SKIPPED" as const, n: 0, passes: 0 };
  const fail = { status: "FAIL" as const, n: 1, passes: 0 };
  it("back-compat: a two-arg call composes exactly as before (shapeChanged defaults false)", () => {
    expect(composeVerdict("PASS", [skipped])).toBe("PASS");
  });
  it("a shape change over an otherwise-PASS yields INCONCLUSIVE", () => {
    expect(composeVerdict("PASS", [skipped], true)).toBe("INCONCLUSIVE");
  });
  it("a genuine presence/absence FAIL dominates a shape change (never masks a regression)", () => {
    expect(composeVerdict("PASS", [fail], true)).toBe("FAIL");
    expect(composeVerdict("FAIL", [skipped], true)).toBe("FAIL");
  });
  it("CAPTURING short-circuits even with a shape change", () => {
    expect(composeVerdict("CAPTURING", [skipped], true)).toBe("CAPTURING");
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
