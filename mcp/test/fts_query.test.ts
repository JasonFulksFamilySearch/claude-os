import { describe, it, expect } from "vitest";
import { buildFallbackQuery, isIntentionalFts5 } from "../src/fts_query.js";

// These dev/test queries are a DISJOINT, SYNTHETIC set — deliberately NOT the held-out
// labeled queries (~/.claude-data/eval/labeled-queries.json). Developing the builder
// against the held-out set would be train/test leakage and void the eval gate.

describe("buildFallbackQuery — produces a valid, OR-combined FTS5 expression", () => {
  it("strips commas that would otherwise throw a syntax error", () => {
    // "familysearch role, team, and tech stack" — the comma is FTS5 syntax and throws.
    const out = buildFallbackQuery("familysearch role, team, and tech stack");
    expect(out).not.toBeNull();
    expect(out).not.toContain(",");
    // Survivors are OR-combined so a strong partial match counts.
    expect(out).toContain(" OR ");
    expect(out).toContain("familysearch");
  });

  it("strips em-dashes", () => {
    const out = buildFallbackQuery("commit quality goals — fix percentage and rework");
    expect(out).not.toBeNull();
    expect(out).not.toContain("—");
    expect(out).toContain("quality");
  });

  it("splits hyphenated terms into component tokens (pre-commit, claude-os)", () => {
    const out = buildFallbackQuery("maven clean test and checkstyle pre-commit gate");
    expect(out).not.toBeNull();
    // The hyphen is gone; both halves survive as their own terms.
    expect(out).not.toContain("-");
    expect(out).toContain("pre");
    expect(out).toContain("commit");
  });

  it("lowercases input terms so an operator keyword becomes a term, not an operator", () => {
    // If "OR"/"AND" reached MATCH uppercased and bare, it would be parsed as an operator
    // and could throw or mis-parse. Lowercased, it is a search term. Behavior under test:
    // every survivor term is lowercase (the " OR " join is the builder's only uppercase).
    const out = buildFallbackQuery("claude-os GitHub MCP endpoint and token setup");
    expect(out).not.toBeNull();
    const terms = out!.split(" OR ");
    for (const term of terms) expect(term).toBe(term.toLowerCase());
    // The input word "and" survives as a lowercase term, never as a bare AND operator.
    expect(terms).toContain("and");
  });

  it("drops empty and single-character tokens", () => {
    const out = buildFallbackQuery("a b familysearch x team");
    expect(out).not.toBeNull();
    // Single-char tokens a, b, x are dropped; real terms survive.
    expect(out).toContain("familysearch");
    expect(out).toContain("team");
    expect(out!.split(" OR ")).not.toContain("a");
    expect(out!.split(" OR ")).not.toContain("b");
    expect(out!.split(" OR ")).not.toContain("x");
  });

  it("OR-combines survivors (a partial match counts, not implicit-AND-of-all)", () => {
    const out = buildFallbackQuery("background agents scheduled cron jobs");
    expect(out).toBe("background OR agents OR scheduled OR cron OR jobs");
  });

  it("dedupes repeated tokens, preserving first-occurrence order", () => {
    // A repeated word (e.g. "java java maven") should yield each term once — repeated
    // OR-terms are valid FTS5 but redundant and could perturb bm25/parse edge-cases.
    const out = buildFallbackQuery("java java maven java");
    expect(out).toBe("java OR maven");
  });
});

describe("buildFallbackQuery — degenerate input signals 'no FTS query'", () => {
  it("returns null when the input reduces to zero usable terms", () => {
    expect(buildFallbackQuery("a , — b")).toBeNull();
  });

  it("returns null for an empty / whitespace-only input", () => {
    expect(buildFallbackQuery("   ")).toBeNull();
  });

  it("returns null when every token is FTS5 punctuation", () => {
    expect(buildFallbackQuery("- , — :")).toBeNull();
  });
});

describe("isIntentionalFts5 — detects deliberate FTS5 syntax", () => {
  it("is true for a double-quoted phrase", () => {
    expect(isIntentionalFts5('context "exact phrase"')).toBe(true);
  });

  it("is true for a boolean operator used as an operator (OR/AND/NOT/NEAR)", () => {
    expect(isIntentionalFts5("checkstyle NOT gradle")).toBe(true);
    expect(isIntentionalFts5("java OR jira")).toBe(true);
    expect(isIntentionalFts5("a AND b")).toBe(true);
    expect(isIntentionalFts5("NEAR(foo bar)")).toBe(true);
  });

  it("is true for a column: filter", () => {
    expect(isIntentionalFts5("title:checkstyle")).toBe(true);
  });

  it("is false for bare natural language (no quotes / operators / column filters)", () => {
    expect(isIntentionalFts5("familysearch role, team, and tech stack")).toBe(false);
    expect(isIntentionalFts5("background agents scheduled cron jobs")).toBe(false);
  });

  it("is false when an operator keyword appears only as lowercase data", () => {
    // "and" lowercased is ordinary English, not a deliberate boolean operator.
    expect(isIntentionalFts5("maven clean test and checkstyle")).toBe(false);
  });
});
