import Database from "better-sqlite3";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { indexFile, defaultConfig } from "../indexer.js";
import type { IndexerConfig } from "../indexer.js";

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

  return {
    scope: args.scope,
    project: args.project ?? null,
    path,
    bytes_appended: Buffer.byteLength(block, "utf8"),
  };
}
