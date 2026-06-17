import { describe, it, expect } from "vitest";
import { chunkFile } from "../src/chunker.js";
import { parseEntries } from "../src/novelty.js";

// ---------------------------------------------------------------------------
// flag-off path (chunkingEnabled === false)
// ---------------------------------------------------------------------------

describe("chunkFile — flag off", () => {
  it("returns exactly one whole-file chunk with an empty anchor", () => {
    const cs = chunkFile({
      sourceType: "learning",
      content: "## 2026-01-01 — A\nx\n## 2026-01-02 — B\ny",
      chunkingEnabled: false,
    });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("whole-file chunk has null parentTitle", () => {
    const cs = chunkFile({
      sourceType: "learning",
      content: "# My Learnings\n\n## 2026-01-01 — A\nx",
      chunkingEnabled: false,
    });
    expect(cs[0].parentTitle).toBeNull();
  });

  it("derives title from H1 when present", () => {
    const cs = chunkFile({
      sourceType: "learning",
      content: "# Willis Learnings\n\n## 2026-01-01 — A\nx",
      chunkingEnabled: false,
    });
    expect(cs[0].title).toBe("Willis Learnings");
  });

  it("whole-file title is null when no H1 present", () => {
    const cs = chunkFile({
      sourceType: "learning",
      content: "## 2026-01-01 — A\nx",
      chunkingEnabled: false,
    });
    expect(cs[0].title).toBeNull();
  });

  it("content equals the full file content", () => {
    const content = "# Title\n\n## 2026-01-01 — A\nx";
    const cs = chunkFile({ sourceType: "learning", content, chunkingEnabled: false });
    expect(cs[0].content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// flag-on path — learning / decision source types
// ---------------------------------------------------------------------------

describe("chunkFile — flag on, learning source", () => {
  const md = "# Learnings\n\n## 2026-01-01 — Alpha\nfirst\n\n## 2026-01-02 — Beta\nsecond";

  it("returns one chunk per dated entry", () => {
    const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(2);
  });

  it("anchors match entry dates in order", () => {
    const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
    expect(cs[0].anchor).toBe("2026-01-01");
    expect(cs[1].anchor).toBe("2026-01-02");
  });

  it("title matches the entry title", () => {
    const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
    expect(cs[0].title).toBe("Alpha");
    expect(cs[1].title).toBe("Beta");
  });

  it("parentTitle is the file H1", () => {
    const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
    expect(cs[0].parentTitle).toBe("Learnings");
    expect(cs[1].parentTitle).toBe("Learnings");
  });

  it("parentTitle is null when file has no H1", () => {
    const noH1 = "## 2026-01-01 — Alpha\nfirst";
    const cs = chunkFile({ sourceType: "learning", content: noH1, chunkingEnabled: true });
    expect(cs[0].parentTitle).toBeNull();
  });

  it("title is null for a date-only heading", () => {
    const dateOnly = "## 2026-01-01\nbody";
    const cs = chunkFile({ sourceType: "learning", content: dateOnly, chunkingEnabled: true });
    expect(cs[0].title).toBeNull();
  });

  it("content is the entry raw block", () => {
    const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
    expect(cs[0].content).toContain("## 2026-01-01 — Alpha");
    expect(cs[0].content).toContain("first");
  });

  it("file with no dated entries returns a single whole-file chunk", () => {
    const noEntries = "# Context\n\nSome narrative with no dated entries.";
    const cs = chunkFile({ sourceType: "learning", content: noEntries, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });
});

describe("chunkFile — flag on, decision source", () => {
  it("also splits by dated entries for decision source type", () => {
    const md = "# Decisions\n\n## 2026-03-10 — Use vitest\nReason: fast.\n\n## 2026-03-11 — Keep novelty in one file\nReason: single definition.";
    const cs = chunkFile({ sourceType: "decision", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(2);
    expect(cs[0].anchor).toBe("2026-03-10");
    expect(cs[1].anchor).toBe("2026-03-11");
  });
});

// ---------------------------------------------------------------------------
// same-date collision → ordinal suffix
// ---------------------------------------------------------------------------

describe("chunkFile — same-date anchor de-duplication", () => {
  const dupMd =
    "## 2026-01-01 — First\nbody1\n\n## 2026-01-01 — Second\nbody2\n\n## 2026-01-01 — Third\nbody3";

  it("first occurrence has no suffix, subsequent get -2, -3, …", () => {
    const cs = chunkFile({ sourceType: "learning", content: dupMd, chunkingEnabled: true });
    expect(cs).toHaveLength(3);
    expect(cs[0].anchor).toBe("2026-01-01");
    expect(cs[1].anchor).toBe("2026-01-01-2");
    expect(cs[2].anchor).toBe("2026-01-01-3");
  });

  it("all anchors are unique within the file", () => {
    const cs = chunkFile({ sourceType: "learning", content: dupMd, chunkingEnabled: true });
    const anchors = cs.map((c) => c.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});

// ---------------------------------------------------------------------------
// episode and agent source types → whole-file regardless of flag
// ---------------------------------------------------------------------------

describe("chunkFile — episode / agent always whole-file", () => {
  const md = "# Episode\n\n## 2026-01-01 — Something\nbody";

  it("episode with flag on → single whole-file chunk", () => {
    const cs = chunkFile({ sourceType: "episode", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("agent with flag on → single whole-file chunk", () => {
    const cs = chunkFile({ sourceType: "agent", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });
});

// ---------------------------------------------------------------------------
// topic / project source types → stub whole-file (Task 6 fills heading-split)
// ---------------------------------------------------------------------------

describe("chunkFile — context / project stub (Task 6 heading-split not yet implemented)", () => {
  const md = "# Topic Doc\n\n## Section A\ntext\n\n## Section B\nmore";

  it("context with flag on → single whole-file chunk (stub)", () => {
    const cs = chunkFile({ sourceType: "context", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("project_claude_md with flag on → single whole-file chunk (stub)", () => {
    const cs = chunkFile({ sourceType: "project_claude_md", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("project_readme with flag on → single whole-file chunk (stub)", () => {
    const cs = chunkFile({ sourceType: "project_readme", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Parity test: chunker entry set == novelty parseEntries (required by brief)
// ---------------------------------------------------------------------------

describe("parity: chunker anchors 1:1 with novelty parseEntries", () => {
  it("anchor list matches parseEntries date list for a standard learnings file", () => {
    const md = "## 2026-01-01 — A\nx\n## 2026-01-02 — B\ny";
    const noveltyEntries = parseEntries(md);
    const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
    expect(cs.map((c) => c.anchor)).toEqual(noveltyEntries.map((e) => e.date));
  });

  it("parity holds with same-date entries (ordinal suffixes applied consistently)", () => {
    const md = "## 2026-01-01 — A\nx\n## 2026-01-01 — B\ny\n## 2026-01-02 — C\nz";
    const noveltyEntries = parseEntries(md);
    const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
    // Same count, and first occurrence of each date matches
    expect(cs).toHaveLength(noveltyEntries.length);
    // The anchors for non-duplicate dates equal the date directly
    expect(cs[0].anchor).toBe(noveltyEntries[0].date);
    expect(cs[2].anchor).toBe(noveltyEntries[2].date);
    // Duplicate date gets -2 suffix
    expect(cs[1].anchor).toBe(`${noveltyEntries[1].date}-2`);
  });
});
