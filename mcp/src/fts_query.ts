// Pure FTS5 query construction for the hybrid search keyword retriever. Kept free of
// SQLite/embedder (mirrors ranking.ts) so it is unit-testable in isolation. The search
// orchestrator uses this ONLY as a fallback: it runs a caller's query as-written first,
// and reaches for buildFallbackQuery only when that query throws, or returns zero rows
// AND is bare natural language (isIntentionalFts5 === false). See
// docs/2026-06-22-retrieval-fts-query-construction-prd.md.

// FTS5 boolean operators are recognized only in UPPERCASE. So an uppercase standalone
// OR/AND/NOT/NEAR signals a caller deliberately using FTS5 boolean syntax; the same word
// lowercased is ordinary English data. buildFallbackQuery exploits this by lowercasing
// (neutralizing accidental operators), and isIntentionalFts5 keys on the uppercase form.
const FTS5_BOOLEAN_OPERATORS = ["OR", "AND", "NOT", "NEAR"];

// A token is "intentional FTS5" boolean syntax only when it is one of these operators in
// uppercase AND stands alone (whitespace-bounded). NEAR may be followed by '(' — NEAR(a b).
const BOOLEAN_OPERATOR_RE = new RegExp(
  `(^|\\s)(${FTS5_BOOLEAN_OPERATORS.join("|")})(\\s|\\(|$)`,
);

// A column filter like `title:foo` — a bareword (or "quoted") column name followed by ':'.
const COLUMN_FILTER_RE = /(^|\s)[A-Za-z_][A-Za-z0-9_]*\s*:/;

/**
 * Does this raw query deliberately use FTS5 syntax — a double-quoted phrase, an uppercase
 * boolean operator, or a `column:` filter? The orchestrator uses this to decide whether a
 * ZERO-HIT result should trigger the sanitized fallback: a valid FTS5 query that legitimately
 * matches nothing (e.g. `checkstyle NOT gradle`) is a correct empty result, NOT a construction
 * failure, so it must NOT be flattened into `checkstyle OR not OR gradle`.
 */
export function isIntentionalFts5(raw: string): boolean {
  if (raw.includes('"')) return true;
  if (BOOLEAN_OPERATOR_RE.test(raw)) return true;
  if (COLUMN_FILTER_RE.test(raw)) return true;
  return false;
}

/**
 * Build a sanitized, always-valid FTS5 MATCH expression from raw natural-language input, or
 * return null ("no usable FTS query") when the input reduces to zero usable terms. Rules
 * (principled, not fit to any query set): lowercase (so an operator keyword becomes a term);
 * split on any non-alphanumeric boundary (commas, em-dashes, hyphens, and all other FTS5
 * punctuation become token separators); drop empty and single-character tokens; OR-combine
 * the survivors (so a strong partial match counts instead of requiring every token). The
 * result is always FTS5-valid — bare alphanumeric terms joined by the OR operator.
 */
export function buildFallbackQuery(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    // Split on every run of non-alphanumeric characters. This strips ALL FTS5-significant
    // punctuation (commas, em-dashes, colons, quotes) AND splits hyphenated terms like
    // "pre-commit" into "pre"/"commit" — in one pass.
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

  // Dedupe (a Set preserves first-occurrence order): a repeated input word would otherwise
  // emit redundant OR-terms (e.g. "java java" → "java OR java"), which are valid but wasteful
  // and could perturb bm25/parse edge-cases. Semantics are unchanged.
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return null;
  return unique.join(" OR ");
}
