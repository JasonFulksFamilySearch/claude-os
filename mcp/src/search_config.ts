// Tuning constants for the reinforcement-weighted hybrid re-rank in search_memory.
//
// These are FIXED, principled defaults — deliberately NOT fit to the offline-eval
// labeled set (that set is a held-out regression gate, not a tuning target). Any
// future calibration must use a disjoint query set, or it is train/test leakage.

// Reciprocal Rank Fusion constant. 60 is the canonical RRF default. A candidate's
// fused base score is the sum, over the retrievers that returned it, of
// 1 / (RRF_K + 1-based-position).
export const RRF_K = 60;

// Each retriever oversamples to C = min(CANDIDATE_CAP, limit * CANDIDATE_MULTIPLIER)
// candidates before fusion, so a hit found by both retrievers but ranked deep in one
// list still gets both RRF terms.
export const CANDIDATE_MULTIPLIER = 4;
export const CANDIDATE_CAP = 100;

// Reinforcement recency term: recency = exp(-age_days / HALF_LIFE_DAYS), where age is
// measured from last_accessed.
export const HALF_LIFE_DAYS = 30;
// Reinforcement frequency term saturates:
// frequency = min(1, ln(1 + access_count) / ln(1 + FREQ_SATURATION)).
export const FREQ_SATURATION = 20;
// Maximum reinforcement bonus. Kept below a single rank-1 RRF term (1/(RRF_K+1) ≈ 0.0164)
// so reinforcement stays tie-breaker-class: it can only reorder candidates whose RRF
// scores already differ by less than W_REINFORCE, and (being additive) never lowers a score.
export const W_REINFORCE = 0.01;

// Exact-match boost, rescaled to RRF units. A literal 0.15 (HAL-OS, on a 0–1 scale)
// would dominate RRF's ~0.016-scale scores; these sit on the rank-1 RRF scale. A
// verbatim title match is the stronger signal; a body phrase match the weaker one.
export const W_EXACT_TITLE = 0.016;
export const W_EXACT_CONTENT = 0.008;

// --- A2 novelty flagging (write-time lexical + review-time semantic) ---
// Fixed, principled defaults — not fit to any labeled set.

// Write-time lexical near-duplicate: token-overlap (Jaccard) ratio at or above which a
// newly-appended entry is flagged as a likely duplicate of an existing entry in the same file.
export const NOVELTY_LEXICAL_DUP = 0.8;

// Review-time semantic threshold (cosine over unit-normalized embeddings). v1 surfaces only
// near-duplicates (cosine >= NEAR_DUP). NOVELTY_CONTRADICTION_COSINE is RESERVED for a future
// contradiction-detection pass (the [CONTRADICTION, NEAR_DUP) band): deferred because a
// real-corpus run showed that band is mostly thematically-related noise, and vectors give
// proximity, not polarity.
export const NOVELTY_NEAR_DUP_COSINE = 0.92;
export const NOVELTY_CONTRADICTION_COSINE = 0.82;

// Top-k nearest neighbors considered per entry during the review-time scan.
export const NOVELTY_SCAN_NEIGHBORS = 5;

// --- B1 cross-session experience synthesis (episode clustering) ---
// Fixed, principled defaults — not fit to any labeled set.

// Thematic relatedness threshold (cosine over unit-normalized embeddings) for grouping episodes
// into one experience cluster. Deliberately well below NOVELTY_NEAR_DUP_COSINE (0.92): near-dup
// detection wants "almost the same text"; experience synthesis wants "the same kind of situation
// recurring across sessions" — a looser thematic bar.
export const EXPERIENCE_CLUSTER_COSINE = 0.7;

// Minimum episodes in a cluster worth synthesizing. Tied to /grade-proposal's evidence band: its
// top evidence_strength score requires 3+ distinct sessions, so a cluster of fewer than 3 cannot
// earn a strong grade and is not surfaced.
export const EXPERIENCE_MIN_CLUSTER_SIZE = 3;

// Cap on how many of the most-recent unpromoted episodes one synthesis run considers, bounding
// cost as the episode archive grows.
export const EXPERIENCE_MAX_EPISODES = 200;
