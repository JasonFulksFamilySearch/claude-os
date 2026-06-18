// Pure post-ranking shaper. Operates on the already-ranked candidate list produced
// by the search pipeline. Two passes:
//
//   1. Sibling collapse — when entry-granular indexing is on, multiple chunks from
//      the same section (source_path + anchor) may surface. Keep only the top-scored
//      representative so the section is not counted twice.
//
//   2. Per-file cap — prevent a single popular file from monopolising the result
//      window. Defaults to 2 chunks per file; caller may override.
//
// Rank order of the input is preserved in the output (no re-sort).

export function shapeResults<T extends { source_path: string; anchor: string; score: number }>(
  ranked: T[],
  maxPerFile = 2,
): T[] {
  // Track the best representative already accepted for each (path, anchor) key.
  // Because the input is sorted by descending score, the first time we see a key
  // we are guaranteed it is the best-scored entry for that section.
  const seenSection = new Set<string>();
  // Count how many entries we have already accepted per file.
  const countPerFile = new Map<string, number>();

  const result: T[] = [];

  for (const entry of ranked) {
    const sectionKey = `${entry.source_path}\0${entry.anchor}`;

    // Pass 1: drop siblings (same section, lower score).
    if (seenSection.has(sectionKey)) continue;
    seenSection.add(sectionKey);

    // Pass 2: drop if we already hit the per-file cap.
    const count = countPerFile.get(entry.source_path) ?? 0;
    if (count >= maxPerFile) continue;
    countPerFile.set(entry.source_path, count + 1);

    result.push(entry);
  }

  return result;
}
