// chunker.ts — turn a file's text into an ordered set of Chunks.
//
// Two paths:
//   chunkingEnabled === false → exactly ONE whole-file chunk (behavior-preserving no-op).
//   chunkingEnabled === true  → per-entry chunks for learning/decision sources;
//                               whole-file stub for all other source types (Task 6 adds
//                               heading-split for context/project_claude_md/project_readme).
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

    // Heading-split for large topic/project docs is intentionally stubbed here.
    // Task 6 implements the real heading-split for these types.
    case "context":
    case "project_claude_md":
    case "project_readme":
      return [wholeFileChunk(content)];

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
