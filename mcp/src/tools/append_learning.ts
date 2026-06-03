import Database from "better-sqlite3";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { indexFile, defaultConfig } from "../indexer.js";
import type { IndexerConfig } from "../indexer.js";
import {
  parseEntries,
  lexicalSimilarity,
  canonicalPairOrder,
  type ParsedEntry,
} from "../novelty.js";
import { NOVELTY_LEXICAL_DUP } from "../search_config.js";

export const appendLearningInput = z.object({
  scope: z.enum(["agent", "project"]),
  content: z.string().min(1),
  project: z.string().optional(),
  title: z.string().optional(),
});

export type AppendLearningInput = z.infer<typeof appendLearningInput>;

export interface AppendLearningResult {
  scope: "agent" | "project";
  project: string | null;
  path: string;
  bytes_appended: number;
  // Set when the just-written entry closely matches an existing entry in the same file
  // (best-effort write-time lexical check); a pending novelty_flags row is also recorded.
  novelty_warning?: {
    matched_date: string;
    matched_title: string;
    similarity: number;
  };
}

export const appendLearningDefinition = {
  name: "append_learning",
  description:
    "Append a dated learning entry to either the agent's cross-project learnings file or a specific project's learnings file. Creates the file with a default header if it doesn't exist. Use this at the end of a session whenever you've captured a non-obvious lesson, correction, or decision worth keeping. The entry becomes searchable via search_memory immediately.",
  inputSchema: {
    type: "object" as const,
    properties: {
      scope: {
        type: "string",
        enum: ["agent", "project"],
        description:
          "'agent' writes to ~/.claude-data/agent/learnings.md (cross-project). 'project' writes to ~/.claude-data/projects/<project>/learnings.md.",
      },
      content: {
        type: "string",
        description:
          "Markdown body of the learning. Will be placed under a dated H2 heading.",
      },
      project: {
        type: "string",
        description:
          "Project slug (required when scope is 'project'). Lowercase, hyphenated.",
      },
      title: {
        type: "string",
        description: "Optional H2 title; defaults to 'Learning'.",
      },
    },
    required: ["scope", "content"],
  },
};

function todayLocal(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function appendLearning(
  db: Database.Database,
  rawArgs: unknown,
  config: IndexerConfig = defaultConfig(),
): AppendLearningResult {
  const args = appendLearningInput.parse(rawArgs);

  if (args.scope === "project" && !args.project) {
    throw new Error("project is required when scope is 'project'");
  }
  if (args.project && !/^[a-z0-9][a-z0-9-]*$/.test(args.project)) {
    throw new Error(
      "project slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase, hyphenated)",
    );
  }

  const dataRoot = config.dataRoot;
  const path =
    args.scope === "agent"
      ? join(dataRoot, "agent", "learnings.md")
      : join(dataRoot, "projects", args.project as string, "learnings.md");

  mkdirSync(dirname(path), { recursive: true });

  if (!existsSync(path)) {
    writeFileSync(
      path,
      "# Learnings\n\nDated entries below — append-only.\n",
      "utf8",
    );
  }

  const date = todayLocal();
  const title = args.title ?? "Learning";
  const block = `\n\n## ${date} — ${title}\n\n${args.content.trim()}\n`;
  appendFileSync(path, block, "utf8");

  indexFile(db, path, config);

  // A2 write-time novelty: best-effort cheap lexical check of the just-appended entry against
  // the file's prior entries. Records a pending flag and surfaces a warning; a failure here
  // must never fail the learning write.
  let noveltyWarning: AppendLearningResult["novelty_warning"];
  try {
    const entries = parseEntries(readFileSync(path, "utf8"));
    if (entries.length >= 2) {
      const fresh = entries[entries.length - 1];
      let best: { entry: ParsedEntry; sim: number } | null = null;
      for (const prior of entries.slice(0, -1)) {
        const sim = prior.hash === fresh.hash ? 1 : lexicalSimilarity(fresh.body, prior.body);
        if (sim >= NOVELTY_LEXICAL_DUP && (best === null || sim > best.sim)) {
          best = { entry: prior, sim };
        }
      }
      if (best) {
        const now = Math.floor(Date.now() / 1000);
        // Canonical pair order so a write-detected flag dedups against a scan-detected one.
        const [e, m] = canonicalPairOrder(
          { path, date: fresh.date, hash: fresh.hash },
          { path, date: best.entry.date, hash: best.entry.hash },
        );
        db.prepare(
          `INSERT OR IGNORE INTO novelty_flags(
             source_path, entry_date, entry_hash, match_path, match_date, match_hash,
             similarity, kind, detected_by, status, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'duplicate', 'write', 'pending', ?)`,
        ).run(e.path, e.date, e.hash, m.path, m.date, m.hash, best.sim, now);
        noveltyWarning = {
          matched_date: best.entry.date,
          matched_title: best.entry.title ?? "(untitled)",
          similarity: best.sim,
        };
      }
    }
  } catch {
    // best-effort: novelty flagging never fails the learning write
  }

  return {
    scope: args.scope,
    project: args.project ?? null,
    path,
    bytes_appended: Buffer.byteLength(block, "utf8"),
    novelty_warning: noveltyWarning,
  };
}
