import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import matter from "gray-matter";

export const listEpisodesInput = z.object({
  limit: z.number().int().positive().max(50).optional(),
  project: z.string().optional(),
  promoted: z.boolean().optional(),
});

export type ListEpisodesInput = z.infer<typeof listEpisodesInput>;

export interface EpisodeEntry {
  date: string;
  session_id: string | null;
  project: string | null;
  turns: number | null;
  promoted: boolean;
  summary: string | null;
  path: string;
}

export const listEpisodesDefinition = {
  name: "list_episodes",
  description:
    "List recent session episodes from ~/.claude-data/episodes/. Each episode is a Haiku-generated session digest covering decisions, corrections, and discoveries. Use this to browse episodic memory. Filter by project slug or promoted status. For full-text search across episode content use search_memory with source_filter: [\"episode\"].",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 10,
        description: "Max results (default 10, max 50).",
      },
      project: {
        type: "string",
        description: "Optional project slug filter (e.g. 'arc', 'perch').",
      },
      promoted: {
        type: "boolean",
        description:
          "true = only promoted episodes; false = only unpromoted. Omit to return all.",
      },
    },
    required: [],
  },
};

const DEFAULT_EPISODES_DIR = join(homedir(), ".claude-data", "episodes");

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
function extractSummary(body: string): string | null {
  const m = body.match(/(?:^|\n)##\s+Summary\s*\r?\n+([\s\S]+?)(?=\n##|$)/);
  if (!m) return null;
  const text = m[1].trim();
  if (text.length === 0 || text.startsWith("##")) return null;
  return text.slice(0, 300);
}

// Internal implementation — accepts test-injectable episodesDir.
// Public surface (listEpisodes) never exposes this param to callers.
export function listEpisodesImpl(
  rawArgs: unknown,
  episodesDir: string,
): EpisodeEntry[] {
  const args = listEpisodesInput.parse(rawArgs);
  const limit = args.limit ?? 10;

  if (!existsSync(episodesDir)) return [];

  const files = readdirSync(episodesDir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));

  const entries: EpisodeEntry[] = [];
  for (const file of files) {
    const path = join(episodesDir, file);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = matter(raw);
      const d = parsed.data;
      const promoted = d.promoted === true;
      const project =
        typeof d.project === "string" && d.project.length > 0
          ? d.project
          : null;

      if (args.project !== undefined && project !== args.project) continue;
      if (args.promoted !== undefined && promoted !== args.promoted) continue;

      entries.push({
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
        summary: extractSummary(parsed.content),
        path,
      });
    } catch {
      // skip malformed episode files
    }
  }

  // Sort by date descending. Break ties on session_id (descending) so two
  // episodes from the same day always sort deterministically across runs —
  // V8's stable sort otherwise yields readdirSync order, which is OS-dependent.
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const aId = a.session_id ?? "";
    const bId = b.session_id ?? "";
    return aId < bId ? 1 : aId > bId ? -1 : 0;
  });
  return entries.slice(0, limit);
}

// Public entry point — episodesDir always comes from config, not the caller.
export function listEpisodes(rawArgs: unknown): EpisodeEntry[] {
  return listEpisodesImpl(rawArgs, DEFAULT_EPISODES_DIR);
}
