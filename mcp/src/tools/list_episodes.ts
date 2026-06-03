import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { listEpisodeFiles, type EpisodeRecord } from "../episodes.js";

export const listEpisodesInput = z.object({
  limit: z.number().int().positive().max(50).optional(),
  project: z.string().optional(),
  promoted: z.boolean().optional(),
});

export type ListEpisodesInput = z.infer<typeof listEpisodesInput>;

// The public episode shape is the shared EpisodeRecord (enumerated by episodes.ts).
export type EpisodeEntry = EpisodeRecord;

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

// Internal implementation — accepts test-injectable episodesDir.
// Public surface (listEpisodes) never exposes this param to callers.
export function listEpisodesImpl(
  rawArgs: unknown,
  episodesDir: string,
): EpisodeEntry[] {
  const args = listEpisodesInput.parse(rawArgs);
  const limit = args.limit ?? 10;

  const entries = listEpisodeFiles(episodesDir, {
    project: args.project,
    promoted: args.promoted,
  });

  // Sort by date descending. Break ties on session_id (descending) so two episodes from the
  // same day always sort deterministically across runs — V8's stable sort otherwise yields
  // readdirSync order, which is OS-dependent.
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
