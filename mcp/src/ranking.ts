// Pure ranking model for the hybrid re-rank. Kept free of SQLite/embedder so the
// fusion + reinforcement + exact-match + total-order logic is unit-testable in
// isolation (the search_memory orchestrator supplies retriever positions and
// access state). See docs/2026-06-03-reinforcement-rerank-prd.md.

import {
  RRF_K,
  W_REINFORCE,
  W_EXACT_TITLE,
  W_EXACT_CONTENT,
  HALF_LIFE_DAYS,
  FREQ_SATURATION,
} from "./search_config.js";

export interface RankCandidate {
  id: number;
  // 1-based position in each retriever's result list, or null if not returned by it.
  ftsPos: number | null;
  vecPos: number | null;
  title: string | null;
  content: string;
  indexed_at: number; // epoch seconds
  // From access_stats via LEFT JOIN: null/0 mean never accessed (lazy cold start).
  last_accessed: number | null;
  access_count: number;
}

export interface RankedCandidate {
  id: number;
  score: number;
  rrf: number;
}

const SECONDS_PER_DAY = 86400;

// Bounded, additive, non-penalizing reinforcement. Range [0, W_REINFORCE]:
// recency = exp(-age/half-life) over time since last access (cold start: indexed_at);
// frequency = log-saturating in access_count. Additive ⇒ never lowers a score; capped
// at W_REINFORCE ⇒ can only reorder candidates whose RRF scores are within that band.
export function reinforcementBonus(
  lastAccessed: number | null,
  accessCount: number,
  indexedAt: number,
  nowSeconds: number,
): number {
  const effectiveLast = lastAccessed ?? indexedAt;
  const ageDays = Math.max(0, (nowSeconds - effectiveLast) / SECONDS_PER_DAY);
  const recency = Math.exp(-ageDays / HALF_LIFE_DAYS); // (0, 1]
  const frequency =
    accessCount > 0
      ? Math.min(1, Math.log1p(accessCount) / Math.log1p(FREQ_SATURATION)) // [0, 1]
      : 0;
  return (W_REINFORCE * (recency + frequency)) / 2;
}

// Rescaled exact-match boost: a verbatim (case-folded) query substring in the title is
// the strongest signal; in the body, weaker. Deliberately relevance-strength, so it may
// exceed W_REINFORCE — exact-match is relevance, not a tie-breaker.
export function exactMatchBonus(
  query: string,
  title: string | null,
  content: string,
): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  if (title && title.toLowerCase().includes(q)) return W_EXACT_TITLE;
  if (content.toLowerCase().includes(q)) return W_EXACT_CONTENT;
  return 0;
}

function rrfScore(ftsPos: number | null, vecPos: number | null): number {
  return (
    (ftsPos !== null ? 1 / (RRF_K + ftsPos) : 0) +
    (vecPos !== null ? 1 / (RRF_K + vecPos) : 0)
  );
}

// Fuse, score, and order candidates, then truncate to `limit`. The sort is a true
// total order — score desc, rrf desc, indexed_at desc, id asc — so distinct rows can
// never tie (id is unique), making output deterministic regardless of input order.
export function rankCandidates(
  candidates: RankCandidate[],
  query: string,
  nowSeconds: number,
  limit: number,
): RankedCandidate[] {
  const scored = candidates.map((c) => {
    const rrf = rrfScore(c.ftsPos, c.vecPos);
    const score =
      rrf +
      reinforcementBonus(c.last_accessed, c.access_count, c.indexed_at, nowSeconds) +
      exactMatchBonus(query, c.title, c.content);
    return { id: c.id, score, rrf, indexed_at: c.indexed_at };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.rrf !== a.rrf) return b.rrf - a.rrf;
    if (b.indexed_at !== a.indexed_at) return b.indexed_at - a.indexed_at;
    return a.id - b.id; // unique, stable final key — guarantees a total order
  });

  return scored.slice(0, limit).map(({ id, score, rrf }) => ({ id, score, rrf }));
}
