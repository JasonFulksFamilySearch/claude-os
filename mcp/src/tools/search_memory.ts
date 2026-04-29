import Database from "better-sqlite3";
import { z } from "zod";

export const searchMemoryInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
  source_filter: z.array(z.string()).optional(),
  project_filter: z.string().optional(),
});

export type SearchMemoryInput = z.infer<typeof searchMemoryInput>;

export interface SearchMemoryResult {
  id: number;
  source_type: string;
  source_path: string;
  project: string | null;
  topic: string | null;
  title: string | null;
  snippet: string;
  rank: number;
}

export const searchMemoryDefinition = {
  name: "search_memory",
  description:
    "Full-text search across Jason's curated memory: agent identity, context topics, learnings, decisions, and watched-project CLAUDE.md/README.md. Returns ranked snippets with paths so you can fetch the canonical file when you need full content. Use this before answering questions about Jason's projects, conventions, or accumulated learnings.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "FTS5 query. Phrase quoting allowed (e.g. \"checkstyle\"). Boolean operators OR/AND/NOT are supported.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 10,
        description: "Max results (default 10, max 50).",
      },
      source_filter: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional filter by source_type (e.g. ['context','learning']). Allowed: context, learning, decision, project_claude_md, project_readme, agent.",
      },
      project_filter: {
        type: "string",
        description: "Optional project slug to scope results to one project.",
      },
    },
    required: ["query"],
  },
};

export function searchMemory(
  db: Database.Database,
  rawArgs: unknown,
): SearchMemoryResult[] {
  const args = searchMemoryInput.parse(rawArgs);
  const limit = args.limit ?? 10;

  const whereClauses: string[] = [];
  const params: Record<string, unknown> = { query: args.query, limit };

  if (args.source_filter && args.source_filter.length > 0) {
    const placeholders = args.source_filter
      .map((_, i) => `@src${i}`)
      .join(",");
    whereClauses.push(`o.source_type IN (${placeholders})`);
    args.source_filter.forEach((v, i) => {
      params[`src${i}`] = v;
    });
  }
  if (args.project_filter) {
    whereClauses.push("o.project = @project_filter");
    params.project_filter = args.project_filter;
  }

  const whereSql = whereClauses.length > 0 ? "AND " + whereClauses.join(" AND ") : "";

  const sql = `
    SELECT
      o.id,
      o.source_type,
      o.source_path,
      o.project,
      o.topic,
      o.title,
      snippet(observations_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
      bm25(observations_fts) AS rank
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH @query
    ${whereSql}
    ORDER BY rank
    LIMIT @limit
  `;

  const rows = db.prepare(sql).all(params) as SearchMemoryResult[];
  return rows;
}
