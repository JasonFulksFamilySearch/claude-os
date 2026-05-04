import Database from "better-sqlite3";
import { z } from "zod";
import { embedQuery, serializeVector } from "../embedder.js";

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
    "Hybrid full-text + semantic search across Jason's curated memory: agent identity, context topics, learnings, decisions, and watched-project CLAUDE.md/README.md. Returns ranked snippets with paths so you can fetch the canonical file when you need full content. Use this before answering questions about Jason's projects, conventions, or accumulated learnings.",
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

export async function searchMemory(
  db: Database.Database,
  rawArgs: unknown,
): Promise<SearchMemoryResult[]> {
  const args = searchMemoryInput.parse(rawArgs);
  const limit = args.limit ?? 10;

  const whereClauses: string[] = [];
  const params: Record<string, unknown> = { query: args.query, limit };

  if (args.source_filter && args.source_filter.length > 0) {
    const placeholders = args.source_filter.map((_, i) => `@src${i}`).join(",");
    whereClauses.push(`o.source_type IN (${placeholders})`);
    args.source_filter.forEach((v, i) => { params[`src${i}`] = v; });
  }
  if (args.project_filter) {
    whereClauses.push("o.project = @project_filter");
    params.project_filter = args.project_filter;
  }

  const whereSql = whereClauses.length > 0 ? "AND " + whereClauses.join(" AND ") : "";

  // 1. FTS5 keyword search
  const ftsSql = `
    SELECT
      o.id,
      o.source_type,
      o.source_path,
      o.project,
      o.topic,
      o.title,
      o.content,
      snippet(observations_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
      bm25(observations_fts) AS rank
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH @query
    ${whereSql}
    ORDER BY rank
    LIMIT @limit
  `;

  type FtsRow = SearchMemoryResult & { content: string };
  let ftsRows: FtsRow[] = [];
  try {
    ftsRows = db.prepare(ftsSql).all(params) as FtsRow[];
  } catch {
    // FTS query may be malformed — treat as empty and fall through to vector
  }

  const seenIds = new Set(ftsRows.map(r => r.id));
  const results: SearchMemoryResult[] = ftsRows.map(({ content: _c, ...r }) => r);

  // 2. Vector semantic search — append hits not already in FTS results
  try {
    const queryVec = serializeVector(await embedQuery(args.query));
    const vecSql = `
      SELECT v.observation_id, v.distance
      FROM vec_items v
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `;
    const vecRows = db.prepare(vecSql).all(queryVec, limit) as Array<{
      observation_id: number;
      distance: number;
    }>;

    for (const vr of vecRows) {
      if (seenIds.has(vr.observation_id)) continue;

      // Apply source/project filters to vector hits too
      const filterClauses: string[] = ["o.id = ?"];
      const filterParams: unknown[] = [vr.observation_id];
      if (args.source_filter && args.source_filter.length > 0) {
        filterClauses.push(`o.source_type IN (${args.source_filter.map(() => "?").join(",")})`);
        filterParams.push(...args.source_filter);
      }
      if (args.project_filter) {
        filterClauses.push("o.project = ?");
        filterParams.push(args.project_filter);
      }

      const obsRow = db.prepare(
        `SELECT id, source_type, source_path, project, topic, title, content FROM observations WHERE ${filterClauses.join(" AND ")}`
      ).get(...filterParams) as (FtsRow & { id: number }) | undefined;

      if (!obsRow) continue;

      const words = obsRow.content.split(/\s+/).slice(0, 32).join(" ");
      results.push({
        id: obsRow.id,
        source_type: obsRow.source_type,
        source_path: obsRow.source_path,
        project: obsRow.project,
        topic: obsRow.topic,
        title: obsRow.title,
        snippet: words.length < obsRow.content.length ? words + "…" : words,
        rank: 999 + vr.distance,
      });
      seenIds.add(vr.observation_id);
    }
  } catch {
    // Vector search unavailable (model not yet loaded, no vec_items rows) — FTS results stand
  }

  return results;
}
