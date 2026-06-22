import Database from "better-sqlite3";
import { z } from "zod";
import { HALF_LIFE_DAYS } from "../search_config.js";

// Badge thresholds — OpenClaw shipped defaults.
// These are principled minimums, not tuned against the held-out eval set.
const BADGE_MIN_RECALL = 3;
const BADGE_MIN_DISTINCT_QUERIES = 3;

const SECONDS_PER_DAY = 86400;

export const getUsageDossierInput = z.object({
  // Mirrors search_memory's established input names exactly.
  source_filter: z.array(z.string()).optional(),
  project_filter: z.string().optional(),
  // C3-specific: filter by source_path prefix.
  path_prefix: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export type GetUsageDossierInput = z.infer<typeof getUsageDossierInput>;

export interface UsageDossier {
  source_path: string;
  anchor: string;
  title: string | null;
  access_count: number;
  distinct_queries: number;
  /** Days since last access (or since indexed_at for never-accessed rows). Rounded for display. */
  days_since_last_access: number;
  /**
   * Server-side decay score: exp(-ageDays / HALF_LIFE_DAYS).
   * Byte-identical to the recency term in reinforcementBonus (ranking.ts:50).
   * effectiveLast = last_accessed ?? indexed_at — cold-start rows age from indexed_at.
   */
  decay_score: number;
  /** true iff access_count >= BADGE_MIN_RECALL AND distinct_queries >= BADGE_MIN_DISTINCT_QUERIES */
  badge: boolean;
}

export const getUsageDossierDefinition = {
  name: "get_usage_dossier",
  description:
    "Return per-observation usage evidence (access counts, distinct queries, recency decay, badge) " +
    "for observations in the memory corpus. Read-only — performs no writes. " +
    "Decay score is byte-identical to the reinforcement recency term in the re-ranker: " +
    "exp(-ageDays / HALF_LIFE_DAYS), with cold-start rows aging from indexed_at. " +
    "Badge signals a well-recalled observation (access_count >= 3 AND distinct_queries >= 3).",
  inputSchema: {
    type: "object" as const,
    properties: {
      source_filter: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of source_type values to include (e.g. [\"learning\", \"context\"]). " +
          "Omit to include all source types.",
      },
      project_filter: {
        type: "string",
        description: "Optional project name to filter by.",
      },
      path_prefix: {
        type: "string",
        description:
          "Optional source_path prefix filter (e.g. \"/Users/foo/.claude-data/context/\").",
      },
      limit: {
        type: "integer",
        description: "Maximum rows to return (default: 100, max: 500).",
      },
    },
    required: [],
  },
};

interface RawDossierRow {
  source_path: string;
  anchor: string;
  title: string | null;
  indexed_at: number;
  access_count: number | null;
  last_accessed: number | null;
  distinct_queries: number;
}

export function getUsageDossier(db: Database.Database, rawArgs: unknown): UsageDossier[] {
  const args = getUsageDossierInput.parse(rawArgs);
  const limit = args.limit ?? 100;

  // Build WHERE clauses dynamically.
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (args.source_filter && args.source_filter.length > 0) {
    const placeholders = args.source_filter.map(() => "?").join(", ");
    conditions.push(`o.source_type IN (${placeholders})`);
    bindings.push(...args.source_filter);
  }
  if (args.project_filter !== undefined) {
    conditions.push("o.project = ?");
    bindings.push(args.project_filter);
  }
  if (args.path_prefix !== undefined) {
    // Treat path_prefix as a LITERAL prefix: escape LIKE's wildcards (% and _) so a
    // path containing them (e.g. "_index.md") matches verbatim, not as a pattern.
    const literalPrefix = args.path_prefix.replace(/([\\%_])/g, "\\$1");
    conditions.push("o.source_path LIKE ? || '%' ESCAPE '\\'");
    bindings.push(literalPrefix);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      o.source_path,
      o.anchor,
      o.title,
      o.indexed_at,
      s.access_count,
      s.last_accessed,
      COALESCE(
        -- The (observation_id, query_hash) PK makes query_hash unique per observation,
        -- so COUNT(*) per observation IS the distinct-query count (cf. db.ts:110).
        (SELECT COUNT(*)
           FROM access_queries q
          WHERE q.observation_id = o.id),
        0
      ) AS distinct_queries
    FROM observations o
    LEFT JOIN access_stats s ON s.observation_id = o.id
    ${where}
    ORDER BY o.id
    LIMIT ?
  `;

  bindings.push(limit);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows = db.prepare(sql).all(...bindings) as RawDossierRow[];

  return rows.map((row) => {
    const accessCount = row.access_count ?? 0;
    // Cold-start fallback: when last_accessed is NULL (never recalled), age from indexed_at.
    // This mirrors reinforcementBonus's effectiveLast = lastAccessed ?? indexedAt (ranking.ts:48).
    const effectiveLast = row.last_accessed ?? row.indexed_at;
    const ageDays = Math.max(0, (nowSeconds - effectiveLast) / SECONDS_PER_DAY);
    // exp(-ageDays / HALF_LIFE_DAYS) — identical formula to ranking.ts:50.
    // This is an e-folding decay (at 30 days: e^-1 ≈ 0.368), NOT a true half-life (0.5 at 30 days).
    const decay_score = Math.exp(-ageDays / HALF_LIFE_DAYS);
    const days_since_last_access = Math.round(ageDays);
    const distinct_queries = Number(row.distinct_queries);

    return {
      source_path: row.source_path,
      anchor: row.anchor,
      title: row.title,
      access_count: accessCount,
      distinct_queries,
      days_since_last_access,
      decay_score,
      badge: accessCount >= BADGE_MIN_RECALL && distinct_queries >= BADGE_MIN_DISTINCT_QUERIES,
    };
  });
}
