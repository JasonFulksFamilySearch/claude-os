import { describe, it, expect } from "vitest";
import {
  RRF_K,
  CANDIDATE_MULTIPLIER,
  CANDIDATE_CAP,
  HALF_LIFE_DAYS,
  FREQ_SATURATION,
  W_REINFORCE,
  W_EXACT_TITLE,
  W_EXACT_CONTENT,
} from "../src/search_config.js";

describe("search_config constants", () => {
  it("pins the RRF and candidate-pool defaults", () => {
    expect(RRF_K).toBe(60);
    expect(CANDIDATE_MULTIPLIER).toBe(4);
    expect(CANDIDATE_CAP).toBe(100);
  });

  it("pins the reinforcement decay/saturation defaults", () => {
    expect(HALF_LIFE_DAYS).toBe(30);
    expect(FREQ_SATURATION).toBe(20);
    expect(W_REINFORCE).toBe(0.01);
  });

  it("pins the exact-match boost weights on the RRF rank-1 scale", () => {
    expect(W_EXACT_TITLE).toBe(0.016);
    expect(W_EXACT_CONTENT).toBe(0.008);
  });

  it("keeps reinforcement tie-breaker-class: max bonus below a single rank-1 RRF term", () => {
    // Bound invariant (b): the reinforcement bonus maxes at W_REINFORCE, which must
    // stay below one retriever's rank-1 contribution 1/(RRF_K+1) so reinforcement can
    // only reorder candidates whose RRF scores already sit within that band.
    expect(W_REINFORCE).toBeLessThan(1 / (RRF_K + 1));
  });
});
