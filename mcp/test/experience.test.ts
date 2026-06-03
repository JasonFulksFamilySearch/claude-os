import { describe, it, expect } from "vitest";
import {
  clusterByEmbedding,
  validateExperienceProposalShape,
  verifyCitations,
  type ExperienceProposal,
} from "../src/experience.js";
import { EXPERIENCE_CLUSTER_COSINE, EXPERIENCE_MIN_CLUSTER_SIZE } from "../src/search_config.js";

// 2D unit vectors by angle — cosine(a,b) = cos(angle difference). The clustering cosine
// helper sums over the shared length, so 2D test vectors exercise it exactly like 768-dim ones.
const DEG = Math.PI / 180;
const vec = (deg: number): Float32Array =>
  new Float32Array([Math.cos(deg * DEG), Math.sin(deg * DEG)]);

describe("clusterByEmbedding", () => {
  it("groups a connected chain via union-find even when the ends are not directly similar", () => {
    // A(0°)-B(40°): cos40≈0.77 ≥0.7 ✓; B(40°)-C(80°): cos40≈0.77 ✓; A-C: cos80≈0.17 ✗.
    // Transitive closure must still put A,B,C in one cluster; D(180°) is isolated.
    const items = ["A", "B", "C", "D"];
    const vectors = [vec(0), vec(40), vec(80), vec(180)];
    const clusters = clusterByEmbedding(items, vectors, { threshold: 0.7, minSize: 3 });
    expect(clusters).toHaveLength(1);
    expect([...clusters[0].members].sort()).toEqual(["A", "B", "C"]);
    expect(clusters[0].members).not.toContain("D");
  });

  it("drops clusters smaller than minSize", () => {
    const items = ["A", "B"];
    const vectors = [vec(0), vec(40)]; // a similar pair (cos40≈0.77)
    expect(clusterByEmbedding(items, vectors, { threshold: 0.7, minSize: 3 })).toHaveLength(0);
    expect(clusterByEmbedding(items, vectors, { threshold: 0.7, minSize: 2 })).toHaveLength(1);
  });

  it("returns no clusters when every pair is below threshold", () => {
    const items = ["A", "B", "C"];
    const vectors = [vec(0), vec(80), vec(160)]; // all pairwise cos ≤ cos80 ≈ 0.17
    expect(clusterByEmbedding(items, vectors, { threshold: 0.7, minSize: 2 })).toHaveLength(0);
  });

  it("separates two distinct themes into two clusters, largest first", () => {
    const items = ["a1", "a2", "a3", "b1", "b2", "b3", "b4"];
    const vectors = [
      vec(0), vec(10), vec(20), // theme A (tight)
      vec(180), vec(185), vec(190), vec(195), // theme B (tight, larger)
    ];
    const clusters = clusterByEmbedding(items, vectors, { threshold: 0.7, minSize: 3 });
    expect(clusters).toHaveLength(2);
    expect(clusters[0].members).toHaveLength(4); // largest cluster first
    expect(clusters[1].members).toHaveLength(3);
  });

  it("reports a cohesion in (0,1] that is the mean intra-cluster cosine", () => {
    const clusters = clusterByEmbedding(["A", "B", "C"], [vec(0), vec(10), vec(20)], {
      threshold: 0.7,
      minSize: 3,
    });
    expect(clusters[0].cohesion).toBeGreaterThan(0.7);
    expect(clusters[0].cohesion).toBeLessThanOrEqual(1);
  });

  it("defaults threshold and minSize from search_config", () => {
    // No opts → uses EXPERIENCE_CLUSTER_COSINE (0.70) and EXPERIENCE_MIN_CLUSTER_SIZE (3).
    const items = ["A", "B", "C"];
    const tight = [vec(0), vec(10), vec(20)]; // well above 0.70
    expect(clusterByEmbedding(items, tight)).toHaveLength(1);
    expect(EXPERIENCE_MIN_CLUSTER_SIZE).toBe(3);
    expect(EXPERIENCE_CLUSTER_COSINE).toBeGreaterThan(0);
    expect(EXPERIENCE_CLUSTER_COSINE).toBeLessThan(0.92); // looser than A2's near-dup bar
  });
});

const validProposal = (): ExperienceProposal => ({
  id: "P001",
  priority: "MEDIUM",
  category: "EXPERIENCE_LEARNING",
  title: "Worktree sessions reset cwd; run merges from the main checkout",
  description:
    "Across several sessions the worktree-pinned cwd silently reset, breaking merges run from inside the worktree. Run merges from the main checkout instead.",
  evidence: [
    "session 2026-06-03-aaa: cwd reset during A2 merge",
    "session 2026-06-03-bbb: same reset re-observed",
    "session 2026-05-30-ccc: earlier worktree friction",
  ],
  proposed_change: {
    file: "/Users/x/.claude-data/agent/learnings.md",
    action: "APPEND_LEARNING",
    content: "Worktree sessions reset cwd; run merges from the main checkout.",
  },
  estimated_weekly_savings_minutes: 10,
});

describe("validateExperienceProposalShape", () => {
  it("accepts a well-formed experience proposal", () => {
    const r = validateExperienceProposalShape(validProposal());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects a wrong category", () => {
    const p = { ...validProposal(), category: "CLAUDE_MD_RULE" };
    const r = validateExperienceProposalShape(p);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/category/);
  });

  it("rejects fewer than two evidence items", () => {
    const p = { ...validProposal(), evidence: ["only one"] };
    expect(validateExperienceProposalShape(p).valid).toBe(false);
  });

  it("rejects a non-APPEND_LEARNING action", () => {
    const p = validProposal();
    const r = validateExperienceProposalShape({
      ...p,
      proposed_change: { ...p.proposed_change, action: "ADD_RULE" },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/action/);
  });

  it("rejects an out-of-range impact estimate and a too-short description", () => {
    expect(
      validateExperienceProposalShape({ ...validProposal(), estimated_weekly_savings_minutes: 9999 }).valid,
    ).toBe(false);
    expect(validateExperienceProposalShape({ ...validProposal(), description: "too short" }).valid).toBe(false);
  });

  it("rejects a malformed id", () => {
    expect(validateExperienceProposalShape({ ...validProposal(), id: "X1" }).valid).toBe(false);
  });
});

describe("verifyCitations", () => {
  const known = [
    { session_id: "2026-06-03-aaa", path: "/e/2026-06-03-aaa.md" },
    { session_id: "2026-06-03-bbb", path: "/e/2026-06-03-bbb.md" },
    { session_id: "2026-05-30-ccc", path: "/e/2026-05-30-ccc.md" },
  ];

  it("passes when every evidence string resolves to a known episode and the floor is met", () => {
    const r = verifyCitations(validProposal().evidence, known, 3);
    expect(r.valid).toBe(true);
    expect(r.resolved).toBe(3);
    expect(r.unresolved).toEqual([]);
  });

  it("fails when an evidence string cites an episode that does not exist (anti-fabrication)", () => {
    const evidence = [
      "session 2026-06-03-aaa: real",
      "session 2026-06-03-bbb: real",
      "session 9999-99-99-fake: fabricated citation", // resolves to nothing
    ];
    const r = verifyCitations(evidence, known, 3);
    expect(r.valid).toBe(false);
    expect(r.unresolved).toHaveLength(1);
  });

  it("fails when fewer than the required distinct episodes are cited", () => {
    const evidence = ["session 2026-06-03-aaa: one", "session 2026-06-03-aaa: same again"];
    const r = verifyCitations(evidence, known, 3);
    expect(r.valid).toBe(false);
    expect(r.resolved).toBe(1); // distinct, not count of strings
  });

  it("resolves a citation by file path when the episode has no session_id", () => {
    // The null-session_id episode can ONLY be matched by path — isolates the path branch.
    const knownNoId = [
      { session_id: null, path: "/e/2026-06-03-zzz.md" },
      { session_id: "2026-06-03-bbb", path: "/e/2026-06-03-bbb.md" },
      { session_id: "2026-05-30-ccc", path: "/e/2026-05-30-ccc.md" },
    ];
    const r = verifyCitations(
      ["see /e/2026-06-03-zzz.md", "session 2026-06-03-bbb", "session 2026-05-30-ccc"],
      knownNoId,
      3,
    );
    expect(r.valid).toBe(true);
  });

  it("counts distinct EPISODES, not session_id strings, when episodes share a session_id", () => {
    // One Claude Code session emits several episode files, all carrying the same session_id.
    // Citing each by its unique PATH must resolve to 3 distinct episodes; counting session_id
    // strings (the prior bug) would collapse them to 1 and reject a legitimate proposal.
    const sameSession = [
      { session_id: "S", path: "/e/a.md" },
      { session_id: "S", path: "/e/b.md" },
      { session_id: "S", path: "/e/c.md" },
    ];
    const byPath = verifyCitations(["see /e/a.md", "see /e/b.md", "see /e/c.md"], sameSession, 3);
    expect(byPath.valid).toBe(true);
    expect(byPath.resolved).toBe(3);

    // Citing only the shared session_id is ambiguous — it cannot establish 3 distinct episodes.
    const byId = verifyCitations(["session S", "session S", "session S"], sameSession, 3);
    expect(byId.valid).toBe(false);
    expect(byId.resolved).toBe(1);
  });
});
