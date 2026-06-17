import { describe, it, expect } from "vitest";
import { shapeResults } from "../src/result_shaper.js";

// Minimal shaped candidate: only the fields shapeResults cares about.
interface Candidate {
  source_path: string;
  anchor: string;
  score: number;
  // tag to verify identity through shaping (not inspected by shapeResults itself)
  tag: string;
}

function c(source_path: string, anchor: string, score: number, tag: string): Candidate {
  return { source_path, anchor, score, tag };
}

describe("shapeResults", () => {
  it("collapses siblings: two entries with same (path, anchor) → best-scored kept", () => {
    const ranked: Candidate[] = [
      c("a.md", "#h1", 0.9, "high"),
      c("a.md", "#h1", 0.5, "low"),
    ];
    const result = shapeResults(ranked);
    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe("high");
  });

  it("caps per file: three entries same path, different anchors → top 2 retained", () => {
    const ranked: Candidate[] = [
      c("b.md", "#h1", 0.9, "first"),
      c("b.md", "#h2", 0.7, "second"),
      c("b.md", "#h3", 0.5, "third"),
    ];
    const result = shapeResults(ranked);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.tag)).toEqual(["first", "second"]);
  });

  it("no-op when all anchors are empty string (one entry per path)", () => {
    // anchor='' means entry-granular indexing is off; no siblings to collapse,
    // and each path appears exactly once, so the cap is irrelevant.
    const ranked: Candidate[] = [
      c("x.md", "", 0.9, "x"),
      c("y.md", "", 0.7, "y"),
      c("z.md", "", 0.4, "z"),
    ];
    const result = shapeResults(ranked);
    expect(result).toHaveLength(3);
    expect(result).toEqual(ranked);
  });

  it("preserves rank order in output", () => {
    // Mixed paths and anchors; output must follow score order of survivors.
    const ranked: Candidate[] = [
      c("p.md", "#a", 0.95, "p-a"),
      c("q.md", "#b", 0.85, "q-b"),
      c("p.md", "#c", 0.75, "p-c"),
      c("q.md", "#b", 0.60, "q-b-dup"), // sibling of q-b → dropped
      c("p.md", "#d", 0.50, "p-d"),     // p already has 2 survivors above → dropped
    ];
    const result = shapeResults(ranked);
    // Expected survivors in ranked order: p-a, q-b, p-c
    expect(result.map((r) => r.tag)).toEqual(["p-a", "q-b", "p-c"]);
  });

  it("respects a custom maxPerFile argument", () => {
    const ranked: Candidate[] = [
      c("m.md", "#1", 0.9, "first"),
      c("m.md", "#2", 0.8, "second"),
      c("m.md", "#3", 0.7, "third"),
    ];
    const result = shapeResults(ranked, 3);
    expect(result).toHaveLength(3);
  });
});
