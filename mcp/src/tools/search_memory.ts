import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { embedQuery, serializeVector } from "../embedder.js";
import { rankCandidates, type RankCandidate } from "../ranking.js";
import { shapeResults } from "../result_shaper.js";
import { buildFallbackQuery, isIntentionalFts5 } from "../fts_query.js";
import { log } from "../logger.js";
import { CANDIDATE_MULTIPLIER, CANDIDATE_CAP } from "../search_config.js";

export const searchMemoryInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
  source_filter: z.array(z.string()).optional(),
  project_filter: z.string().optional(),
  // AC-4 gate (issue #55): reinforcement records a retrieval as a recall signal (bumps
  // access_stats and the access_queries telemetry). Defaults to true — the human-recall
  // behavior. A machine-originated retrieval (graph selection / enrich / graph-auditor)
  // must pass reinforce:false so its access is NOT counted as recall. This is a function-
  // level parameter for internal callers; it is intentionally NOT advertised on the MCP
  // tool surface, so the model-facing search is always human recall.
  reinforce: z.boolean().optional(),
});

export type SearchMemoryInput = z.infer<typeof searchMemoryInput>;

export interface SearchMemoryResult {
  id: number;
  source_type: string;
  source_path: string;
  anchor: string;
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
  anchor: string;
  project: string | null;
  topic: string | null;
  title: string | null;
  parent_title: string | null;
  content: string;
  indexed_at: number;
  last_accessed: number | null;
  access_count: number | null;
}

function wordSnippet(content: string): string {
  const words = content.split(/\s+/).slice(0, 32).join(" ");
  return words.length < content.length ? words + "…" : words;
}

// Best-effort logging for the FTS fallback catches: logger.log uses appendFileSync and can
// throw (full disk, bad path). These log calls sit INSIDE catches whose contract is "never
// fail the read", so a log-write failure must be swallowed, not propagated.
function safeLog(...args: Parameters<typeof log>): void {
  try {
    log(...args);
  } catch {
    // Logging is diagnostic; its failure must never break the search read path.
  }
}

export async function searchMemory(
  db: Database.Database,
  rawArgs: unknown,
): Promise<SearchMemoryResult[]> {
  const args = searchMemoryInput.parse(rawArgs);
  const limit = args.limit ?? 10;
  const reinforce = args.reinforce ?? true;
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
  //
  // Fallback strategy (see fts_query.ts): the raw query runs against MATCH as-written first,
  // preserving the advertised FTS5 contract (phrase quoting, boolean operators) for callers
  // who send valid syntax. The keyword retriever falls back to a sanitized, OR-combined query
  // ONLY when the as-written query (a) throws, or (b) returns zero rows AND is bare natural
  // language. A valid FTS5 query — quoted or boolean — that legitimately returns zero rows is
  // a correct empty result, not a construction failure, so it is left as-is.
  const ftsPos = new Map<number, number>();
  const ftsSnippet = new Map<number, string>();
  const runFts = (matchExpr: string): FtsHit[] =>
    db
      .prepare(
        `SELECT o.id AS id,
                snippet(observations_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         WHERE observations_fts MATCH ?${filterClause}
         ORDER BY bm25(observations_fts)
         LIMIT ?`,
      )
      .all(matchExpr, ...filterParams, poolSize) as FtsHit[];
  const recordFts = (rows: FtsHit[]): void => {
    rows.forEach((r, i) => {
      ftsPos.set(r.id, i + 1);
      ftsSnippet.set(r.id, r.snippet);
    });
  };

  let ftsRows: FtsHit[] | null = null;
  try {
    ftsRows = runFts(args.query);
  } catch (err) {
    // The as-written query is invalid FTS5 (e.g. an unescaped comma/em-dash/hyphen). This is
    // why the bug stayed invisible: the catch silently disabled the keyword retriever. Log it
    // (Decision 6) so a future regression is diagnosable, then fall back below. The log itself
    // is best-effort — logger.log uses appendFileSync and can throw; it must NOT break the read
    // path inside the very catch whose job is to tolerate a malformed query.
    safeLog("warn", "FTS as-written query failed; attempting sanitized fallback", {
      query: args.query,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Trigger the sanitized fallback on a throw (ftsRows still null), or on a zero-hit result
  // ONLY when the query is bare natural language — never flatten an intentional FTS5 query
  // (quoted phrase / boolean / column filter) that legitimately matched nothing.
  if (ftsRows === null || (ftsRows.length === 0 && !isIntentionalFts5(args.query))) {
    const fallbackExpr = buildFallbackQuery(args.query);
    // A null fallback means the input reduced to zero usable terms — skip FTS entirely and
    // let the search proceed on the vector retriever alone (never throws).
    if (fallbackExpr !== null) {
      try {
        ftsRows = runFts(fallbackExpr);
      } catch (err) {
        // buildFallbackQuery only emits bare alphanumeric terms joined by OR, so this cannot
        // throw on a valid FTS index — but keep the safety net so a malformed query can never
        // fail the read. Log it (best-effort) and contribute nothing this call.
        safeLog("error", "sanitized FTS fallback unexpectedly failed", {
          fallback: fallbackExpr,
          error: err instanceof Error ? err.message : String(err),
        });
        ftsRows = null;
      }
    }
  }

  if (ftsRows !== null) recordFts(ftsRows);

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
      `SELECT o.id AS id, o.source_type, o.source_path, o.anchor, o.project, o.topic, o.title,
              o.parent_title, o.content, o.indexed_at, a.last_accessed, a.access_count
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
      parent_title: m.parent_title,
      content: m.content,
      indexed_at: m.indexed_at,
      last_accessed: m.last_accessed,
      access_count: m.access_count ?? 0,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  // Rank the FULL candidate pool (no pre-truncation to `limit`). The pool is
  // already bounded by CANDIDATE_CAP, so this is a bounded operation.
  // We must rank first, then shape (per-file cap), then slice — otherwise the
  // cap drops chunks from a hot file without backfilling from other files, and
  // the result window shrinks (e.g. limit=10 but only 2 results returned).
  const ranked = rankCandidates(candidates, args.query, now, candidates.length);

  // 4a. Apply result shaper: collapse same-(path,anchor) siblings, cap per-file.
  //     shapeResults requires descending-score input — rankCandidates guarantees this.
  //     With whole-file rows (all anchor=''), each path has exactly one row so
  //     this is a no-op, preserving today's behavior.
  // After shaping, slice to `limit` so dropped chunks are backfilled from other
  // files before the window is truncated.
  const shaped = shapeResults(
    ranked.map((rc) => { const m = meta.get(rc.id)!; return { ...rc, source_path: m.source_path, anchor: m.anchor }; }),
  ).slice(0, limit);

  // 5. Materialize results in ranked order (FTS snippet when available, else a slice).
  const results: SearchMemoryResult[] = shaped.map((rc) => {
    const m = meta.get(rc.id) as MetaRow;
    return {
      id: m.id,
      source_type: m.source_type,
      source_path: m.source_path,
      anchor: m.anchor,
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
  //
  //    AC-4 gate (issue #55): a machine-originated retrieval passes reinforce:false, which
  //    skips the ENTIRE reinforcement write — neither access_stats (the ranking tie-breaker
  //    read back in ranking.ts) nor the access_queries recall telemetry is touched. A
  //    machine access is not a recall signal. The read-back is unchanged: a reinforce:false
  //    search still BENEFITS from prior organic reinforcement, it just writes none of its own.
  if (reinforce) {
    try {
      const query_hash = createHash("sha256")
        .update(args.query.trim().toLowerCase())
        .digest("hex");
      const upsert = db.prepare(
        `INSERT INTO access_stats(observation_id, last_accessed, access_count)
         VALUES (?, ?, 1)
         ON CONFLICT(observation_id) DO UPDATE SET
           last_accessed = excluded.last_accessed,
           access_count = access_count + 1`,
      );
      // Per-query access telemetry (C3): one (observation_id, query_hash) pair per returned
      // row, riding the SAME best-effort transaction so it can never fail the read.
      const upsertQuery = db.prepare(
        `INSERT INTO access_queries(observation_id, query_hash, access_count, first_seen, last_seen)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(observation_id, query_hash) DO UPDATE SET
           access_count = access_count + 1,
           last_seen = excluded.last_seen`,
      );
      const bump = db.transaction((rows: SearchMemoryResult[]) => {
        for (const r of rows) {
          upsert.run(r.id, now);
          upsertQuery.run(r.id, query_hash, now, now);
        }
      });
      bump(results);
    } catch {
      // Reinforcement is best-effort; a write failure must not fail search.
    }
  }

  return results;
}
