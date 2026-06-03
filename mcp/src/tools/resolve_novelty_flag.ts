import Database from "better-sqlite3";
import { z } from "zod";

export const resolveNoveltyFlagInput = z.object({
  id: z.number().int().positive(),
  status: z.enum(["dismissed", "superseded"]),
});

export type ResolveNoveltyFlagInput = z.infer<typeof resolveNoveltyFlagInput>;

export interface ResolveNoveltyFlagResult {
  id: number;
  status: "dismissed" | "superseded";
  updated: boolean;
}

export const resolveNoveltyFlagDefinition = {
  name: "resolve_novelty_flag",
  description:
    "Record a human-gated resolution of a novelty flag: 'dismissed' (a false positive — not a real duplicate/contradiction) or 'superseded' (the older entry has been retired). Call only AFTER Jason approves it in /memory-merger; the actual markdown edit (archiving + retiring the entry) is done separately by the skill. Idempotent; returns updated:false for an unknown id.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "integer",
        description: "The novelty_flags row id (from scan_novelty's candidate.flag_id).",
      },
      status: {
        type: "string",
        enum: ["dismissed", "superseded"],
        description: "The resolution to persist.",
      },
    },
    required: ["id", "status"],
  },
};

// Atomic single-state-flip on one flag row, mirroring mark_episode_promoted's narrow shape.
export function resolveNoveltyFlag(
  db: Database.Database,
  rawArgs: unknown,
): ResolveNoveltyFlagResult {
  const args = resolveNoveltyFlagInput.parse(rawArgs);
  const res = db
    .prepare("UPDATE novelty_flags SET status = ? WHERE id = ?")
    .run(args.status, args.id);
  return { id: args.id, status: args.status, updated: res.changes > 0 };
}
