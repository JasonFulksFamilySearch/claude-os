// Shared episode enumeration — the single definition of "list the episode files under a
// directory, parsed and filtered." Both list_episodes (sorts + slices for browsing) and
// scan_experience (clusters the unpromoted backlog) build on this, so "what is an episode and
// which are unpromoted" lives in exactly one place.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";

export interface EpisodeRecord {
  date: string;
  session_id: string | null;
  project: string | null;
  turns: number | null;
  promoted: boolean;
  value_score: number | undefined;
  summary: string | null;
  path: string;
}

export interface EpisodeFilter {
  project?: string;
  promoted?: boolean;
}

// KEEP IN LOCKSTEP with hooks/lib/episode-utils.js extractSummary().
// Same logic, different module system. The CommonJS copy strips frontmatter
// manually first; this one trusts gray-matter to have done it. Update both
// files or neither.
//
// extractSummary: `(?:^|\n)##` instead of `^##` because gray-matter's
// `parsed.content` includes the leading newline after the closing `---`.
// `/m` is intentionally avoided — under `/m`, `$` matches end-of-line and
// would truncate multi-paragraph summaries at the first blank line.
//
// Empty-summary guard: if the regex captures whitespace OR the next section
// heading (which happens when the Summary body is empty and `\s*` greedily
// consumes the blank line), return null. trim().startsWith('##') is the
// signal that the capture ran past the Summary into a `## Decisions` heading.
export function extractSummary(body: string): string | null {
  const m = body.match(/(?:^|\n)##\s+Summary\s*\r?\n+([\s\S]+?)(?=\n##|$)/);
  if (!m) return null;
  const text = m[1].trim();
  if (text.length === 0 || text.startsWith("##")) return null;
  return text.slice(0, 300);
}

// Read every episode file under episodesDir, parse frontmatter, and apply the project/promoted
// filters. Returns UNSORTED records — callers sort and slice as they need. Malformed files are
// skipped silently. Files/dirs prefixed with `_` are ignored (mirrors the indexer/watcher).
export function listEpisodeFiles(
  episodesDir: string,
  filter: EpisodeFilter = {},
): EpisodeRecord[] {
  if (!existsSync(episodesDir)) return [];

  const files = readdirSync(episodesDir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  const out: EpisodeRecord[] = [];

  for (const file of files) {
    const path = join(episodesDir, file);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = matter(raw);
      const d = parsed.data;
      const promoted = d.promoted === true;
      const project =
        typeof d.project === "string" && d.project.length > 0 ? d.project : null;

      if (filter.project !== undefined && project !== filter.project) continue;
      if (filter.promoted !== undefined && promoted !== filter.promoted) continue;

      out.push({
        date:
          typeof d.date === "string"
            ? d.date
            : d.date instanceof Date
            ? (d.date as Date).toISOString().slice(0, 10)
            : basename(file, ".md").slice(0, 10),
        session_id: typeof d.session_id === "string" ? d.session_id : null,
        project,
        turns: typeof d.turns === "number" ? d.turns : null,
        promoted,
        value_score:
          typeof d.value_score === "number" && Number.isInteger(d.value_score) &&
          d.value_score >= 0 && d.value_score <= 4
            ? d.value_score
            : undefined,
        summary: extractSummary(parsed.content),
        path,
      });
    } catch {
      // skip malformed episode files
    }
  }

  return out;
}
