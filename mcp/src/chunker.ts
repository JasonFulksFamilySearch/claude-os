// chunker.ts — turn a file's text into an ordered set of Chunks.
//
// Two paths:
//   chunkingEnabled === false → exactly ONE whole-file chunk (behavior-preserving no-op).
//   chunkingEnabled === true  → per-entry chunks for learning/decision sources;
//                               heading-split for large context/project_claude_md/project_readme
//                               (≤2000 chars → whole-file; >2000 chars with headings → split).
//
// parseEntries is imported from novelty.ts (NOT relocated here).

import { parseEntries } from "./novelty.js";
import type { SourceType } from "./db.js";

export interface Chunk {
  anchor: string;
  title: string | null;
  parentTitle: string | null;
  content: string;
}

// Extract the first H1 from markdown content — mirrors indexer.ts parseFile behavior.
// Returns null when no H1 is present (the indexer fills this with basename(path, ".md"),
// but the chunker has no path; callers supply the basename fallback when writing to DB).
function extractH1(content: string): string | null {
  const m = content.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

// Produce a whole-file chunk with the conventional title derivation (H1 or null).
function wholeFileChunk(content: string): Chunk {
  return {
    anchor: "",
    title: extractH1(content),
    parentTitle: null,
    content,
  };
}

// Split a learning or decision file into per-entry chunks via parseEntries.
// anchor = entry.date; same-date collisions get ordinal suffixes (-2, -3, …) so
// every anchor is unique within the returned array.
// Falls back to a whole-file chunk when no dated entries are found.
function chunkByEntries(content: string): Chunk[] {
  const entries = parseEntries(content);
  if (entries.length === 0) {
    return [wholeFileChunk(content)];
  }

  const parentTitle = extractH1(content);

  // Build ordinal suffix map: track how many times each date has appeared.
  const dateCounts = new Map<string, number>();

  return entries.map((entry) => {
    const count = (dateCounts.get(entry.date) ?? 0) + 1;
    dateCounts.set(entry.date, count);
    const anchor = count === 1 ? entry.date : `${entry.date}-${count}`;

    return {
      anchor,
      title: entry.title,
      parentTitle,
      content: entry.raw,
    };
  });
}

// ---------------------------------------------------------------------------
// Heading-split implementation for context / project_claude_md / project_readme
// ---------------------------------------------------------------------------

// Token heuristic: 1 token ≈ 4 chars.
const CHARS_PER_TOKEN = 4;
// Pack sections into chunks targeting this many chars (~400–512 tokens).
const TARGET_CHUNK_CHARS = 480 * CHARS_PER_TOKEN; // ~1920 chars ≈ 480 tokens
// Overlap between adjacent chunks in chars (~80–100 tokens).
const OVERLAP_CHARS = 90 * CHARS_PER_TOKEN; // ~360 chars ≈ 90 tokens
// Files at or under this size are returned as a single whole-file chunk.
const SPLIT_THRESHOLD_CHARS = 2000;

// Slugify a heading string: lowercase, collapse whitespace → hyphens, strip
// non-alphanumeric characters except hyphens.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Return a deduplicated anchor for a raw heading string, given a running
// collision-counter map (mutated in place). First occurrence: `slug`.
// Subsequent: `slug-2`, `slug-3`, etc.
// When the slug is empty (e.g. heading "## ---" or "## !!!"), fall back to
// `section-<ordinal>` (1-based ordinal of this section within the file,
// supplied by the caller) so we never emit anchor='' for a heading-split chunk.
function uniqueAnchor(text: string, seen: Map<string, number>, sectionOrdinal: number): string {
  const raw = slugify(text);
  const base = raw.length > 0 ? raw : `section-${sectionOrdinal}`;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

// A parsed markdown section: the heading line and the body text that follows.
interface Section {
  headingLine: string; // the full original heading line (e.g. "#### Subsection A")
  headingText: string; // raw heading text stripped of leading #s (e.g. "Subsection A")
  body: string; // content from this heading to the next (excludes leading heading line)
}

// Split content on H2–H6 heading boundaries (`^#{2,6} `).
// The H1 line (if present) is NOT treated as a section boundary — it is
// extracted separately as the file's parentTitle (see chunkByHeadings).
// Returns the preamble (all text before the first H2+, including any H1 line
// and text between H1 and first H2) separately and the ordered list of
// H2+-rooted sections.
function parseSections(content: string): { preamble: string; sections: Section[] } {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let preamble = "";
  let currentHeadingLine: string | null = null;
  let currentHeadingText: string | null = null;
  const bodyLines: string[] = [];

  for (const line of lines) {
    // Only split on H2–H6; H1 is left in the preamble block (extractH1 reads it
    // separately) so it does not generate its own section/chunk.
    if (/^#{2,6} /.test(line)) {
      if (currentHeadingLine === null) {
        // Everything before the first H2+ heading is preamble (may include an H1 line).
        preamble = bodyLines.join("\n");
        bodyLines.length = 0;
      } else {
        sections.push({
          headingLine: currentHeadingLine,
          headingText: currentHeadingText!,
          body: bodyLines.join("\n"),
        });
        bodyLines.length = 0;
      }
      currentHeadingLine = line;
      currentHeadingText = line.replace(/^#{2,6} /, "").trim();
    } else {
      bodyLines.push(line);
    }
  }

  // Flush last section (or preamble if there were no H2+ headings at all).
  if (currentHeadingLine === null) {
    preamble = bodyLines.join("\n");
  } else {
    sections.push({
      headingLine: currentHeadingLine,
      headingText: currentHeadingText!,
      body: bodyLines.join("\n"),
    });
  }

  return { preamble, sections };
}

// Pack sections into Chunks, targeting TARGET_CHUNK_CHARS chars each.
// Adjacent chunks carry OVERLAP_CHARS of overlap (the tail of the previous
// chunk's text is prepended to the next chunk).
function packSections(
  sections: Section[],
  preamble: string,
  parentTitle: string | null,
  content: string
): Chunk[] {
  if (sections.length === 0) {
    return [wholeFileChunk(content)];
  }

  const seen = new Map<string, number>();
  const chunks: Chunk[] = [];

  // Materialise each section as its full text (original heading line + body).
  // headingLine preserves the original #-level (e.g. "####") so structural info
  // is not lost by hard-coding a different level in the reconstructed chunk.
  const sectionTexts = sections.map(
    (s) => `${s.headingLine}\n${s.body}`
  );

  // Build groups: greedily pack sections until the target size is hit.
  let groupStart = 0;
  // Carry overlap text forward from the previous chunk.
  let overlapText = preamble.length > 0 ? preamble + "\n\n" : "";

  while (groupStart < sections.length) {
    let groupChars = overlapText.length;
    let groupEnd = groupStart;

    // Add sections to this group until we exceed the target.
    while (groupEnd < sections.length) {
      const candidate = sectionTexts[groupEnd];
      if (groupEnd > groupStart && groupChars + candidate.length + 2 > TARGET_CHUNK_CHARS) {
        break;
      }
      groupChars += candidate.length + 2; // +2 for the "\n\n" separator
      groupEnd++;
    }

    // Build the chunk text.
    const groupSections = sectionTexts.slice(groupStart, groupEnd);
    const chunkContent = overlapText + groupSections.join("\n\n");

    // Anchor from the first heading in this group (slug-deduped).
    // When multiple sections pack into one chunk, the chunk's anchor is the FIRST
    // packed section's slug (per-chunk addressing); later-packed sections share
    // that anchor — they have no independent chunk to address.
    // sectionOrdinal is 1-based index in the ORIGINAL sections array — used only
    // when the slug of the heading is empty (fallback to "section-N").
    const anchor = uniqueAnchor(sections[groupStart].headingText, seen, groupStart + 1);
    const title = sections[groupStart].headingText;

    chunks.push({ anchor, title, parentTitle, content: chunkContent });

    // Compute overlap for the next chunk: tail of current chunk text.
    const tail = chunkContent.slice(-OVERLAP_CHARS);
    overlapText = tail;

    groupStart = groupEnd;
  }

  return chunks;
}

// Entry point for the three topic/project source types.
// Files ≤ SPLIT_THRESHOLD_CHARS or without any H2+ headings → whole-file chunk.
// Files > SPLIT_THRESHOLD_CHARS with at least one H2+ heading → heading-split.
//
// Special case: file has an H1 but NO H2–H6 headings. We cannot split at
// heading boundaries (there are none below H1), so we emit ONE chunk whose
// anchor is the slug of the H1 (not '' — that would collide with the whole-file
// sentinel) and whose parentTitle and title are both the H1 text.
function chunkByHeadings(content: string): Chunk[] {
  if (content.length <= SPLIT_THRESHOLD_CHARS) {
    return [wholeFileChunk(content)];
  }

  const { preamble, sections } = parseSections(content);
  const parentTitle = extractH1(content);

  if (sections.length === 0) {
    // No H2+ headings found — can't split on heading boundaries.
    // If there is an H1, emit one chunk addressed by the H1 slug so the anchor
    // is non-empty and meaningful. If there is no H1 either, fall back to the
    // whole-file chunk (anchor='').
    if (parentTitle !== null) {
      const seen = new Map<string, number>();
      const anchor = uniqueAnchor(parentTitle, seen, 1);
      return [{ anchor, title: parentTitle, parentTitle, content }];
    }
    return [wholeFileChunk(content)];
  }

  return packSections(sections, preamble, parentTitle, content);
}

export function chunkFile(args: {
  sourceType: SourceType;
  content: string;
  chunkingEnabled: boolean;
}): Chunk[] {
  const { sourceType, content, chunkingEnabled } = args;

  // Flag-off: always return a single whole-file chunk regardless of source type.
  if (!chunkingEnabled) {
    return [wholeFileChunk(content)];
  }

  // Flag-on: route by source type.
  switch (sourceType) {
    case "learning":
    case "decision":
      return chunkByEntries(content);

    // Heading-split for large topic/project docs.
    // Files ≤ ~2000 chars or without headings return whole-file; larger files
    // are split on heading boundaries with overlap between adjacent chunks.
    case "context":
    case "project_claude_md":
    case "project_readme":
      return chunkByHeadings(content);

    // Episodes and agent files are not entry-structured; always whole-file.
    case "episode":
    case "agent":
      return [wholeFileChunk(content)];

    default: {
      // Exhaustiveness guard — should never reach here if SourceType is complete.
      const _exhaustive: never = sourceType;
      return [wholeFileChunk(content)];
    }
  }
}
