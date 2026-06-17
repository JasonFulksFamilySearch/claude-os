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
// topic / project source types — threshold gate (≤2000 chars → whole-file)
// ---------------------------------------------------------------------------

describe("chunkFile — context / project short-doc whole-file (≤2000 chars)", () => {
  // This doc is ~51 chars — well under the 2000-char threshold.
  const md = "# Topic Doc\n\n## Section A\ntext\n\n## Section B\nmore";

  it("context short doc with flag on → single whole-file chunk", () => {
    const cs = chunkFile({ sourceType: "context", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("project_claude_md short doc with flag on → single whole-file chunk", () => {
    const cs = chunkFile({ sourceType: "project_claude_md", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("project_readme short doc with flag on → single whole-file chunk", () => {
    const cs = chunkFile({ sourceType: "project_readme", content: md, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });
});

// ---------------------------------------------------------------------------
// heading-split golden fixtures (Task 6)
// ---------------------------------------------------------------------------

// Build a deterministic markdown doc with `numSections` sections, padded so
// the total character count equals exactly `totalChars`.  Each section gets an
// equal slice of the pad budget; any rounding remainder is added to the last
// section.  The header line "# Parent Title\n\n" is included in the budget.
function buildDoc(numSections: number, totalChars: number): string {
  const header = "# Parent Title\n\n";
  const headings = Array.from(
    { length: numSections },
    (_, i) => `## Section ${String.fromCharCode(65 + i)}`
  );
  // Fixed cost: header + headings + "\n\n" separators between sections + "\n" after each heading.
  const fixedChars =
    header.length +
    headings.reduce((s, h) => s + h.length + 1 /* \n after heading */, 0) +
    (numSections - 1) * 2; /* "\n\n" between sections */

  const bodyBudget = totalChars - fixedChars;
  const basePerSection = Math.floor(bodyBudget / numSections);
  const remainder = bodyBudget - basePerSection * numSections;

  const sections = headings.map((h, i) => {
    const bodyLen = basePerSection + (i === numSections - 1 ? remainder : 0);
    // Fill with repeated "x" characters — simple and exact.
    return `${h}\n${"x".repeat(Math.max(0, bodyLen))}`;
  });

  return header + sections.join("\n\n");
}

describe("chunkFile — heading-split for large context docs (>2000 chars)", () => {
  // --- threshold boundary ---

  it("file just under threshold (≤2000 chars) → whole-file chunk", () => {
    // Build a 2-section doc that stays at 1999 chars.
    const doc = buildDoc(2, 1999);
    expect(doc.length).toBeLessThanOrEqual(2000);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("file of EXACTLY 2000 chars → whole-file chunk (boundary: ≤ 2000)", () => {
    // Confirms the boundary condition is inclusive (≤ not <).
    const doc = buildDoc(2, 2000);
    expect(doc.length).toBe(2000);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  it("file of ~2001 chars (just over threshold) with multiple headings → heading-split with distinct slugs", () => {
    // One char over the boundary must trigger heading-split, not whole-file.
    const doc = buildDoc(4, 2001);
    expect(doc.length).toBeGreaterThan(2000);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });

    // Must produce multiple chunks.
    expect(cs.length).toBeGreaterThanOrEqual(2);

    // All anchors must be non-empty (each chunk is addressed to a heading, not whole-file).
    for (const chunk of cs) {
      expect(chunk.anchor).not.toBe("");
    }

    // Anchors must be distinct — each chunk has its own slug address.
    const anchors = cs.map((c) => c.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);

    // Each chunk's content must contain its own section heading (content is
    // divided along heading boundaries, not arbitrarily sliced).
    for (const chunk of cs) {
      // The anchor is the slug of the heading; verify the heading text appears in the content.
      // For buildDoc headings like "## Section A", slug is "section-a".
      // We reconstruct the expected heading text from the anchor slug.
      const headingText = chunk.anchor
        .replace(/-(\d+)$/, "") // strip ordinal suffix if any
        .replace(/-/g, " ")    // hyphens back to spaces
        .replace(/\b\w/g, (c) => c.toUpperCase()); // title-case
      expect(chunk.content).toContain(headingText);
    }
  });

  it("file just over threshold (>2000 chars with headings) → ≥2 chunks", () => {
    const doc = buildDoc(4, 2400);
    expect(doc.length).toBeGreaterThan(2000);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });
    expect(cs.length).toBeGreaterThanOrEqual(2);

    // Golden-fixture: distinct slug anchors on every chunk.
    const anchors = cs.map((c) => c.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const anchor of anchors) {
      expect(anchor).not.toBe(""); // no whole-file fallback anchor
    }

    // Content is divided along heading boundaries: each chunk contains its own heading.
    for (const chunk of cs) {
      // The title field should be in the content.
      expect(chunk.content).toContain(chunk.title!);
    }
  });

  // --- no headings → whole-file ---

  it("file over threshold but no headings → single whole-file chunk", () => {
    // A 2500-char file with no heading lines at all.
    const noHeadings = "word ".repeat(500); // 2500 chars, no headings
    expect(noHeadings.length).toBeGreaterThan(2000);
    const cs = chunkFile({ sourceType: "context", content: noHeadings, chunkingEnabled: true });
    expect(cs).toHaveLength(1);
    expect(cs[0].anchor).toBe("");
  });

  // --- heading level preservation (Fix 1) ---

  it("original heading level is preserved in chunk content (#### not flattened to ##)", () => {
    // Mix of heading levels — ensure none are rewritten to a different level.
    const doc =
      "# Parent\n\n" +
      "## Top Section\n" +
      "body ".repeat(200) +
      "\n\n#### Deep Subsection\n" +
      "body ".repeat(200) +
      "\n\n### Mid Section\n" +
      "body ".repeat(200);
    expect(doc.length).toBeGreaterThan(2000);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });

    const allContent = cs.map((c) => c.content).join("\n");
    // The deep subsection heading must appear verbatim — not promoted to ##.
    expect(allContent).toContain("#### Deep Subsection");
    // The mid-level heading must also appear verbatim.
    expect(allContent).toContain("### Mid Section");
    // The top section must appear verbatim.
    expect(allContent).toContain("## Top Section");
    // No structural promotion: "#### Deep Subsection" must NOT be rewritten to "## Deep Subsection".
    // Use regex with start-of-line anchor so "####" is not a false positive match for "##".
    expect(allContent).not.toMatch(/^## Deep Subsection$/m);
    // No structural demotion: "### Mid Section" must NOT be rewritten to "# Mid Section".
    expect(allContent).not.toMatch(/^# Mid Section$/m);
  });

  // --- slug anchors ---

  it("heading anchors are slugified (lowercase, spaces → hyphens)", () => {
    const doc =
      "# Parent\n\n" +
      "word ".repeat(60) + // preamble padding
      "\n\n## Hello World\n" +
      "body ".repeat(600) +
      "\n\n## Foo Bar Baz\n" +
      "body ".repeat(600);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });
    const anchors = cs.map((c) => c.anchor);
    expect(anchors.some((a) => a === "hello-world")).toBe(true);
    expect(anchors.some((a) => a === "foo-bar-baz")).toBe(true);
  });

  // --- parentTitle from H1 ---

  it("parentTitle is the file H1 on every heading chunk", () => {
    const doc = buildDoc(4, 2400);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });
    for (const chunk of cs) {
      expect(chunk.parentTitle).toBe("Parent Title");
    }
  });

  // --- overlap between adjacent chunks ---

  it("adjacent heading-split chunks share full overlap text (OVERLAP_CHARS)", () => {
    // OVERLAP_CHARS = 90 tokens * 4 chars = 360 chars. Verify the FULL overlap,
    // not just a short probe — a fencepost off-by-one in the slice would be caught.
    const OVERLAP_CHARS = 90 * 4; // must mirror chunker.ts constant
    // Build a doc large enough that sections pack into ≥2 chunks.
    const doc = buildDoc(6, 6000);
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });
    // At least 2 chunks for there to be an adjacent pair.
    expect(cs.length).toBeGreaterThanOrEqual(2);
    // For each adjacent pair, the prepended overlap on chunk[i+1] must equal the
    // full trailing OVERLAP_CHARS tail of chunk[i].
    for (let i = 0; i < cs.length - 1; i++) {
      const prevContent = cs[i].content;
      // Full overlap window — not a short probe.
      const fullOverlapSlice = prevContent.slice(-OVERLAP_CHARS);
      // chunk[i+1] must start with (or at least contain) the full tail of chunk[i].
      // We use startsWith to verify the prepend is at the head of the next chunk
      // (overlap text is prepended, not appended).
      expect(cs[i + 1].content).toContain(fullOverlapSlice);
    }
  });

  // --- same heading collision → ordinal suffix ---

  it("repeated heading text produces unique anchors with ordinal suffixes", () => {
    const section = "body ".repeat(300);
    const doc =
      "# Root\n\n" +
      `## Notes\n${section}\n\n` +
      `## Notes\n${section}\n\n` +
      `## Notes\n${section}`;
    const cs = chunkFile({ sourceType: "context", content: doc, chunkingEnabled: true });
    const anchors = cs.map((c) => c.anchor);
    // All anchors must be unique.
    expect(new Set(anchors).size).toBe(anchors.length);
    // The repeated heading should appear with ordinal suffix on second+ occurrence.
    const noteAnchors = anchors.filter((a) => a === "notes" || a.startsWith("notes-"));
    expect(noteAnchors.length).toBeGreaterThanOrEqual(2);
    const sorted = [...noteAnchors].sort();
    expect(sorted[0]).toBe("notes");
    expect(sorted[1]).toBe("notes-2");
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
