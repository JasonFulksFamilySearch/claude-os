// Pure retrieval-quality metrics for the offline eval harness (see src/scripts/eval.ts).
// Kept dependency-free so the metrics are unit-testable without a DB or model.

// Fraction of the relevant items that appear within the top-k ranked results.
// Returns 0 (not NaN) when there are no relevant items.
export function recallAtK(rankedIds: number[], relevantIds: number[], k: number): number {
  if (relevantIds.length === 0) return 0;
  const topK = new Set(rankedIds.slice(0, k));
  const found = relevantIds.filter((id) => topK.has(id)).length;
  return found / relevantIds.length;
}

// Reciprocal of the 1-based rank of the first relevant hit; 0 if none is relevant.
export function reciprocalRank(rankedIds: number[], relevantIds: number[]): number {
  const relevant = new Set(relevantIds);
  for (let i = 0; i < rankedIds.length; i++) {
    if (relevant.has(rankedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

// Arithmetic mean; 0 (not NaN) for an empty list. Mean recall@k / mean reciprocal rank
// (MRR) over the labeled query set are the gate metrics.
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
