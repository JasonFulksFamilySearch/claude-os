import { describe, it, expect } from "vitest";
import {
  rankCandidates,
  reinforcementBonus,
  exactMatchBonus,
  type RankCandidate,
} from "../src/ranking.js";
import { W_REINFORCE, W_EXACT_TITLE, W_EXACT_CONTENT } from "../src/search_config.js";

const NOW = 1_800_000_000; // fixed reference epoch-seconds for deterministic tests
const TEN_YEARS = 3650 * 86400;

// Neutral candidate: old last_accessed + zero count ⇒ reinforcement ≈ 0, and a
// title/content that won't contain the test query ("zzqq") ⇒ no exact-match boost.
// Each test overrides only the fields it exercises.
function cand(over: Partial<RankCandidate> & { id: number }): RankCandidate {
  return {
    ftsPos: null,
    vecPos: null,
    title: "neutral title",
    content: "neutral body text",
    indexed_at: NOW,
    last_accessed: NOW - TEN_YEARS,
    access_count: 0,
    ...over,
  };
}

const ids = (rs: { id: number }[]) => rs.map((r) => r.id);

describe("reinforcementBonus", () => {
  it("is non-negative and never lowers a score", () => {
    expect(reinforcementBonus(NOW, 0, NOW, NOW)).toBeGreaterThanOrEqual(0);
    expect(reinforcementBonus(NOW - TEN_YEARS, 0, NOW - TEN_YEARS, NOW)).toBeGreaterThanOrEqual(0);
  });

  it("maxes at W_REINFORCE (recency=1, frequency=1)", () => {
    // last_accessed = now ⇒ recency 1; access_count past saturation ⇒ frequency 1.
    expect(reinforcementBonus(NOW, 100, NOW, NOW)).toBeCloseTo(W_REINFORCE, 10);
  });

  it("cold start (no access row) falls back to indexed_at for recency, count 0", () => {
    // null last_accessed ⇒ uses indexed_at; recency 1, frequency 0 ⇒ W/2.
    expect(reinforcementBonus(null, 0, NOW, NOW)).toBeCloseTo(W_REINFORCE / 2, 10);
  });

  it("decays toward ~0 for old, never-accessed memories (no age penalty, just no bonus)", () => {
    const r = reinforcementBonus(NOW - TEN_YEARS, 0, NOW - TEN_YEARS, NOW);
    expect(r).toBeLessThan(1e-6);
    expect(r).toBeGreaterThanOrEqual(0);
  });
});

describe("exactMatchBonus", () => {
  it("rewards a verbatim title substring most", () => {
    expect(exactMatchBonus("foo", "a foo title", "body")).toBe(W_EXACT_TITLE);
  });
  it("rewards a body phrase match less", () => {
    expect(exactMatchBonus("foo", "title", "a foo body")).toBe(W_EXACT_CONTENT);
  });
  it("is case-insensitive", () => {
    expect(exactMatchBonus("FOO", "the foo", "body")).toBe(W_EXACT_TITLE);
  });
  it("returns 0 when the query appears nowhere", () => {
    expect(exactMatchBonus("foo", "title", "body")).toBe(0);
  });
  it("returns 0 for an empty/whitespace query", () => {
    expect(exactMatchBonus("   ", "foo title", "foo body")).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("fuses both retrievers: a both-retriever hit outscores a solo rank-1 hit", () => {
    const both = cand({ id: 1, ftsPos: 1, vecPos: 1 }); // rrf = 2/61
    const solo = cand({ id: 2, ftsPos: 1, vecPos: null }); // rrf = 1/61
    const ranked = rankCandidates([solo, both], "zzqq", NOW, 10);
    expect(ids(ranked)).toEqual([1, 2]);
  });

  it("never returns a sentinel score; scores are sorted strictly by the model", () => {
    const ranked = rankCandidates(
      [cand({ id: 1, ftsPos: 1 }), cand({ id: 2, vecPos: 1 })],
      "zzqq",
      NOW,
      10,
    );
    for (const r of ranked) expect(r.score).toBeLessThan(1); // no 999+distance sentinel
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it("reinforcement breaks a genuine RRF tie", () => {
    // Equal rrf (fts pos 3 vs vec pos 3 = 1/63 each); reinforced one wins.
    const reinforced = cand({ id: 1, ftsPos: 3, last_accessed: NOW, access_count: 100 });
    const cold = cand({ id: 2, vecPos: 3 });
    expect(ids(rankCandidates([cold, reinforced], "zzqq", NOW, 10))).toEqual([1, 2]);
  });

  it("reinforcement cannot overcome an RRF gap >= W_REINFORCE", () => {
    // A: both@1 ⇒ rrf 2/61 ≈ 0.0328, no reinforcement. B: fts@1 ⇒ rrf 1/61 ≈ 0.0164,
    // MAX reinforcement (+0.01). Gap 0.0164 > W_REINFORCE ⇒ A must still win.
    const a = cand({ id: 1, ftsPos: 1, vecPos: 1 });
    const b = cand({ id: 2, ftsPos: 1, last_accessed: NOW, access_count: 100 });
    expect(ids(rankCandidates([b, a], "zzqq", NOW, 10))).toEqual([1, 2]);
  });

  it("breaks full ties deterministically by id ascending, independent of input order", () => {
    // Identical rrf (vec@3 each), same indexed_at, equal (≈0) reinforcement, no exact-match.
    const a = cand({ id: 5, vecPos: 3 });
    const b = cand({ id: 2, vecPos: 3 });
    expect(ids(rankCandidates([a, b], "zzqq", NOW, 10))).toEqual([2, 5]);
    expect(ids(rankCandidates([b, a], "zzqq", NOW, 10))).toEqual([2, 5]);
  });

  it("truncates to limit, keeping the top-scored", () => {
    const ranked = rankCandidates(
      [cand({ id: 1, ftsPos: 1 }), cand({ id: 2, ftsPos: 2 }), cand({ id: 3, ftsPos: 3 })],
      "zzqq",
      NOW,
      2,
    );
    expect(ids(ranked)).toEqual([1, 2]);
  });
});
