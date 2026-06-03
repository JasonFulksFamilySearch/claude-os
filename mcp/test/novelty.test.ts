import { describe, it, expect } from "vitest";
import {
  parseEntries,
  entryIdentity,
  matchByIdentity,
  lexicalSimilarity,
  findNearDuplicateEntries,
  canonicalPairOrder,
  type ParsedEntry,
} from "../src/novelty.js";
import { NOVELTY_NEAR_DUP_COSINE } from "../src/search_config.js";

const FILE = [
  "# Learnings",
  "",
  "## 2026-05-01 — first lesson",
  "",
  "Always run mvn clean test before committing.",
  "",
  "## 2026-05-02 — second lesson",
  "",
  "Use gh to verify PR merge state before trusting Jira.",
  "",
].join("\n");

const DUP_FILE =
  FILE + "\n## 2026-05-01 — first lesson\n\nAlways run mvn clean test before committing.\n";

describe("parseEntries", () => {
  it("splits a learnings file into dated entries (date, title, body)", () => {
    const entries = parseEntries(FILE);
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe("2026-05-01");
    expect(entries[0].title).toBe("first lesson");
    expect(entries[0].body).toContain("mvn clean test");
    expect(entries[0].body).not.toContain("## 2026-05-01"); // heading excluded from body
    expect(entries[1].date).toBe("2026-05-02");
  });

  it("returns [] for content with no dated entries", () => {
    expect(parseEntries("# Learnings\n\nno dated entries here\n")).toEqual([]);
  });

  it("parses a title-less heading (date only) with a null title — shared-parser parity", () => {
    const entries = parseEntries("## 2026-05-01\n\nlesson body without a title\n");
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe("2026-05-01");
    expect(entries[0].title).toBeNull();
    expect(entries[0].body).toContain("without a title");
  });

  it("gives byte-identical blocks the same hash and distinct blocks different hashes", () => {
    const entries = parseEntries(FILE);
    expect(entries[0].hash).not.toBe(entries[1].hash);
    const dup = parseEntries(DUP_FILE).filter(
      (e) => e.date === "2026-05-01" && e.title === "first lesson",
    );
    expect(dup).toHaveLength(2);
    expect(dup[0].hash).toBe(dup[1].hash);
  });
});

describe("matchByIdentity", () => {
  it("returns exactly one block for a unique entry", () => {
    const entries = parseEntries(FILE);
    expect(matchByIdentity(entries, entryIdentity(entries[1]))).toHaveLength(1);
  });

  it("returns N>1 blocks for byte-identical duplicates (the collapse case)", () => {
    const entries = parseEntries(DUP_FILE);
    const id = entryIdentity(entries.find((e) => e.date === "2026-05-01")!);
    expect(matchByIdentity(entries, id).length).toBeGreaterThanOrEqual(2);
  });

  it("returns zero for an identity no longer present (stale flag)", () => {
    const entries = parseEntries(FILE);
    expect(matchByIdentity(entries, { date: "2026-05-01", hash: "deadbeef" })).toHaveLength(0);
  });
});

describe("lexicalSimilarity", () => {
  it("is 1 for identical text and 0 for disjoint text", () => {
    expect(lexicalSimilarity("run the tests", "run the tests")).toBe(1);
    expect(lexicalSimilarity("alpha bravo", "charlie delta")).toBe(0);
  });

  it("is case-insensitive and strictly between 0 and 1 for partial overlap", () => {
    const s = lexicalSimilarity("Run The Tests Now", "run the tests later");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("findNearDuplicateEntries", () => {
  const mk = (date: string, body: string): ParsedEntry => ({
    date,
    title: "t",
    body,
    raw: `## ${date} — t\n\n${body}`,
    hash: date + body,
  });
  const unit = (v: number[]): Float32Array => {
    const n = Math.hypot(...v) || 1;
    return new Float32Array(v.map((x) => x / n));
  };

  it("flags identical-vector entries as a duplicate pair", () => {
    const pairs = findNearDuplicateEntries(
      [mk("2026-05-01", "x"), mk("2026-05-02", "y")],
      [unit([1, 0, 0]), unit([1, 0, 0])],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].kind).toBe("duplicate");
    expect(pairs[0].cosine).toBeGreaterThanOrEqual(NOVELTY_NEAR_DUP_COSINE);
  });

  it("does not pair clearly-distinct vectors", () => {
    const pairs = findNearDuplicateEntries(
      [mk("2026-05-01", "x"), mk("2026-05-02", "y")],
      [unit([1, 0, 0]), unit([0, 1, 0])],
    );
    expect(pairs).toHaveLength(0);
  });

  it("does not surface a sub-near-duplicate pair (v1 flags only near-duplicates)", () => {
    // cosine 0.85 is in the old contradiction band, below NEAR_DUP — deferred in v1.
    const pairs = findNearDuplicateEntries(
      [mk("2026-05-01", "x"), mk("2026-05-02", "y")],
      [unit([1, 0, 0]), unit([0.85, Math.sqrt(1 - 0.85 * 0.85), 0])],
    );
    expect(pairs).toHaveLength(0);
  });
});

describe("canonicalPairOrder", () => {
  const A = { path: "/a/learnings.md", date: "2026-05-01", hash: "h1" };
  const B = { path: "/a/learnings.md", date: "2026-06-01", hash: "h2" };

  it("orders a pair identically regardless of input order", () => {
    // Write-time stores (newer, older); scan stores (older, newer). Canonical ordering must
    // collapse both to one tuple so the order-sensitive UNIQUE dedups across detectors.
    expect(canonicalPairOrder(A, B)).toEqual(canonicalPairOrder(B, A));
  });

  it("is a stable total order (first element is deterministic)", () => {
    const [first] = canonicalPairOrder(B, A);
    expect(first).toEqual(A); // A sorts before B
  });
});
