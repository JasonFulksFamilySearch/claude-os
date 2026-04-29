import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export const getRecentLearningsInput = z.object({
  scope: z.enum(["agent", "project", "all"]),
  limit: z.number().int().positive().max(20).optional(),
  project: z.string().optional(),
});

export type GetRecentLearningsInput = z.infer<typeof getRecentLearningsInput>;

export interface LearningEntry {
  scope: "agent" | "project";
  project: string | null;
  path: string;
  date: string;
  title: string | null;
  content: string;
}

export const getRecentLearningsDefinition = {
  name: "get_recent_learnings",
  description:
    "Fetch the N most recent learning entries across agent and/or project scopes. Entries are parsed from H2 dated headings of the form '## YYYY-MM-DD — title' in learnings.md files. Use this at session start to refresh on what was learned recently, or when looking for a specific recent decision.",
  inputSchema: {
    type: "object" as const,
    properties: {
      scope: {
        type: "string",
        enum: ["agent", "project", "all"],
        description:
          "'agent' = ~/.claude-data/agent/learnings.md only. 'project' = a specific project's learnings.md (requires project). 'all' = both agent and all projects merged.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 5,
        description: "Max entries to return (default 5, max 20).",
      },
      project: {
        type: "string",
        description:
          "Project slug. Required when scope is 'project'. Optional filter when scope is 'all'.",
      },
    },
    required: ["scope"],
  },
};

const DATA_ROOT = join(homedir(), ".claude-data");

interface ParsedHeading {
  date: string;
  title: string | null;
  body: string;
}

const headingRe = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.+?))?\s*$/;

function parseLearningsFile(text: string): ParsedHeading[] {
  const lines = text.split(/\r?\n/);
  const entries: ParsedHeading[] = [];
  let current: ParsedHeading | null = null;
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      if (current) entries.push(current);
      current = {
        date: m[1],
        title: m[2] ? m[2].trim() : null,
        body: "",
      };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) entries.push(current);
  return entries;
}

function readEntries(
  path: string,
  scope: "agent" | "project",
  project: string | null,
): LearningEntry[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return parseLearningsFile(text).map((p) => ({
    scope,
    project,
    path,
    date: p.date,
    title: p.title,
    content: p.body.trim(),
  }));
}

export function getRecentLearnings(
  rawArgs: unknown,
  dataRoot: string = DATA_ROOT,
): LearningEntry[] {
  const args = getRecentLearningsInput.parse(rawArgs);
  const limit = args.limit ?? 5;

  if (args.scope === "project" && !args.project) {
    throw new Error("project is required when scope is 'project'");
  }

  const all: LearningEntry[] = [];

  if (args.scope === "agent" || args.scope === "all") {
    const p = join(dataRoot, "agent", "learnings.md");
    all.push(...readEntries(p, "agent", null));
  }

  if (args.scope === "project" && args.project) {
    const p = join(dataRoot, "projects", args.project, "learnings.md");
    all.push(...readEntries(p, "project", args.project));
  }

  if (args.scope === "all") {
    const projectsDir = join(dataRoot, "projects");
    if (existsSync(projectsDir)) {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (args.project && entry.name !== args.project) continue;
        const p = join(projectsDir, entry.name, "learnings.md");
        all.push(...readEntries(p, "project", entry.name));
      }
    }
  }

  all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return all.slice(0, limit);
}
