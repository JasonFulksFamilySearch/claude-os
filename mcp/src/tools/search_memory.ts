import Database from "better-sqlite3";
import { z } from "zod";
import { embedQuery, serializeVector } from "../embedder.js";
import { rankCandidates, type RankCandidate } from "../ranking.js";
import { CANDIDATE_MULTIPLIER, CANDIDATE_CAP } from "../search_config.js";

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
  // Fused relevance score (RRF + reinforcement + exact-match), higher = better.
  // Results are returned pre-sorted best-first; consumers should rely on array order.
  score: number;
}

export const searchMemoryDefinition = {
  name: "search_memory",
  description:
    "Hybrid full-text + semantic search across Jason's memory: agent identity, context topics, learnings, decisions, watched-project CLAUDE.md/README.md, and session episodes. Keyword (FTS5) and semantic (vector) matches are fused into one relevance score (higher = better) and returned pre-sorted best-first — rely on the result order. Retrieving a memory lightly reinforces it (a best-effort write), so frequently-useful memories resurface more easily over time. Use source_filter: [\"episode\"] to scope to episodic memory only. Use this before answering questions about Jason's projects, conventions, accumulated learnings, or past session decisions.",
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
          "Optional array of source types to restrict results. Allowed values: context, learning, decision, project_claude_md, project_readme, agent, episode.",
      },
      project_filter: {
        type: "string",
        description: "Optional project slug to scope results to one project.",
      },
    },
    required: ["query"],
  },
};

interface FtsHit {
  id: number;
  snippet: string;
}

interface MetaRow {
  id: number;
  source_type: string;
  source_path: string;
  project: string | null;
  topic: string | null;
  title: string | null;
  content: string;
  indexed_at: number;
  last_accessed: number | null;
  access_count: number | null;
}

function wordSnippet(content: string): string {
  const words = content.split(/\s+/).slice(0, 32).join(" ");
  return words.length < content.length ? words + "…" : words;
}

export async function searchMemory(
  db: Database.Database,
  rawArgs: unknown,
): Promise<SearchMemoryResult[]> {
  const args = searchMemoryInput.parse(rawArgs);
  const limit = args.limit ?? 10;
  // Oversample each retriever so a hit found by both but ranked deep in one list
  // still receives both RRF terms at fusion time.
  const poolSize = Math.min(CANDIDATE_CAP, limit * CANDIDATE_MULTIPLIER);

  // Filter predicates shared by both retrievers (alias `o` = observations).
  const filterSql: string[] = [];
  const filterParams: unknown[] = [];
  if (args.source_filter && args.source_filter.length > 0) {
    filterSql.push(`o.source_type IN (${args.source_filter.map(() => "?").join(",")})`);
    filterParams.push(...args.source_filter);
  }
  if (args.project_filter) {
    filterSql.push("o.project = ?");
    filterParams.push(args.project_filter);
  }
  const filterClause = filterSql.length > 0 ? " AND " + filterSql.join(" AND ") : "";

  // 1. FTS keyword retriever, bm25 order. 1-based position = array index + 1.
  const ftsPos = new Map<number, number>();
  const ftsSnippet = new Map<number, string>();
  try {
    const ftsRows = db
      .prepare(
        `SELECT o.id AS id,
                snippet(observations_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         WHERE observations_fts MATCH ?${filterClause}
         ORDER BY bm25(observations_fts)
         LIMIT ?`,
      )
      .all(args.query, ...filterParams, poolSize) as FtsHit[];
    ftsRows.forEach((r, i) => {
      ftsPos.set(r.id, i + 1);
      ftsSnippet.set(r.id, r.snippet);
    });
  } catch {
    // Malformed FTS query — the keyword retriever contributes nothing this call.
  }

  // 2. Vector semantic retriever, distance order.
  const vecOrder: number[] = [];
  try {
    const queryVec = serializeVector(await embedQuery(args.query));
    const vecRows = db
      .prepare(
        `SELECT observation_id FROM vec_items
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(queryVec, poolSize) as Array<{ observation_id: number }>;
    for (const v of vecRows) vecOrder.push(v.observation_id);
  } catch {
    // Embedder/vec index unavailable — the semantic retriever contributes nothing.
  }

  // 3. Fetch metadata + access state for the candidate union, applying filters
  //    (this also drops filtered-out vector hits). LEFT JOIN ⇒ null cold-start.
  const unionIds = Array.from(new Set<number>([...ftsPos.keys(), ...vecOrder]));
  if (unionIds.length === 0) return [];

  const meta = new Map<number, MetaRow>();
  const metaRows = db
    .prepare(
      `SELECT o.id AS id, o.source_type, o.source_path, o.project, o.topic, o.title,
              o.content, o.indexed_at, a.last_accessed, a.access_count
       FROM observations o
       LEFT JOIN access_stats a ON a.observation_id = o.id
       WHERE o.id IN (${unionIds.map(() => "?").join(",")})${filterClause}`,
    )
    .all(...unionIds, ...filterParams) as MetaRow[];
  for (const m of metaRows) meta.set(m.id, m);

  // Assign vector positions 1..k over filtered survivors, in distance order.
  const vecPos = new Map<number, number>();
  let v = 0;
  for (const id of vecOrder) {
    if (meta.has(id)) vecPos.set(id, ++v);
  }

  // 4. Build candidates and rank.
  const candidates: RankCandidate[] = [];
  for (const m of meta.values()) {
    candidates.push({
      id: m.id,
      ftsPos: ftsPos.get(m.id) ?? null,
      vecPos: vecPos.get(m.id) ?? null,
      title: m.title,
      content: m.content,
      indexed_at: m.indexed_at,
      last_accessed: m.last_accessed,
      access_count: m.access_count ?? 0,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const ranked = rankCandidates(candidates, args.query, now, limit);

  // 5. Materialize results in ranked order (FTS snippet when available, else a slice).
  const results: SearchMemoryResult[] = ranked.map((rc) => {
    const m = meta.get(rc.id) as MetaRow;
    return {
      id: m.id,
      source_type: m.source_type,
      source_path: m.source_path,
      project: m.project,
      topic: m.topic,
      title: m.title,
      snippet: ftsSnippet.get(m.id) ?? wordSnippet(m.content),
      score: rc.score,
    };
  });

  // 6. Best-effort reinforcement: bump ONLY the returned rows. Writes to access_stats
  //    (not observations) so it never fires the FTS-sync triggers, and is wrapped so a
  //    transient write failure never fails the read.
  try {
    const upsert = db.prepare(
      `INSERT INTO access_stats(observation_id, last_accessed, access_count)
       VALUES (?, ?, 1)
       ON CONFLICT(observation_id) DO UPDATE SET
         last_accessed = excluded.last_accessed,
         access_count = access_count + 1`,
    );
    const bump = db.transaction((rows: SearchMemoryResult[]) => {
      for (const r of rows) upsert.run(r.id, now);
    });
    bump(results);
  } catch {
    // Reinforcement is best-effort; a write failure must not fail search.
  }

  return results;
}
