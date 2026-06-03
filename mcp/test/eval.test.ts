import { describe, it, expect } from "vitest";
import { recallAtK, reciprocalRank, mean } from "../src/eval.js";

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
