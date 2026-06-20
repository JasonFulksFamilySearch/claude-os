'use strict';

const { createHash } = require('node:crypto');

/**
 * injection-ranking.js — the six-factor INJECTION ranker (PRD FR-E / DIO-13).
 *
 * WHAT THIS IS. When the graph-selected candidate set exceeds the injection budget,
 * this module orders the candidates so the most-worth-injecting survive the cut. It is
 * the PRECISION half of FR-E2's recall/precision layering: the graph already did
 * SELECTION (recall — "what is structurally reachable / contract-relevant"); this module
 * only ORDERS an already-selected set. It NEVER re-selects, re-queries, or expands the
 * set — `rankInjection` takes the candidates it is handed and returns them re-ordered
 * (and, optionally, truncated to budget). Removing it reverts to unranked/over-budget
 * truncation (the reversibility floor, ticket Reversibility note).
 *
 * ── WHERE IT LIVES, AND WHY HOOKS (NOT mcp/) ──────────────────────────────────
 * This is pure-Node, in hooks/lib, alongside the enrich path it feeds (the ContentRouter
 * `additionalContext` seam, posttooluse-content-router.js). Three reasons it does NOT
 * belong in mcp/:
 *   1. FR-E5: six-factor scores a DIFFERENT UNIT at a DIFFERENT STAGE than the engine's
 *      RRF corpus retrieval (ranking.ts). It is "held isolated from the RRF path
 *      (FR-E4)"; co-locating it with ranking.ts invites exactly the numeric entanglement
 *      FR-E4 forbids. A separate module in a separate layer makes the isolation
 *      structural, not merely asserted.
 *   2. The EVAL-GATE boundary (CLAUDE.md): a change to a ranking/embedding/indexing
 *      module in mcp/ must clear the offline retrieval eval gate. This ranker is a
 *      DISTINCT concern — INJECTION ordering of a graph-selected set, not corpus
 *      retrieval ranking — so it is built as a NEW module OUTSIDE mcp/, touching neither
 *      ranking.ts nor search_config.ts. The eval gate is not triggered.
 *   3. sqlite-vec is NOT needed HERE. FR-E1/FR-E4 require that retrieval signal enter
 *      six-factor ONLY through the pre-normalized `semantic_similarity` factor ([0,1]).
 *      So this module CONSUMES an already-normalized similarity as an input feature; it
 *      does not compute embeddings. The embedding/sqlite-vec lookup (when present) is the
 *      CALLER's job, upstream, producing the [0,1] number this scorer reads. That keeps
 *      the scorer pure, deterministic, and dependency-free — and is precisely what
 *      FR-E4's "enters six-factor only through a declared factor, pre-normalized to [0,1]"
 *      mandates.
 *
 * ── FR-E4 NUMERIC SCALE ISOLATION (the load-bearing hazard) ───────────────────
 * The six factors are each in [0,1] and the weights sum to 1, so a six-factor score is in
 * [0,1]. The engine's RRF score (ranking.ts:78-83, ~0.003–0.033) MUST NOT be added,
 * averaged, or otherwise combined into this score. This module CANNOT do so by
 * construction: it does not import ranking.ts / search_config.ts, has no `rrf` field in
 * its feature shape, and its scoring expression references ONLY the six declared factors.
 * Any RRF/retrieval signal a candidate carries enters EXCLUSIVELY through the normalized
 * `semantic_similarity` feature the caller supplies. The test file asserts both halves:
 * (a) two candidates with identical six-factor inputs but full-range-different RRF rank in
 * UNCHANGED order, and (b) a static scan that this source references no RRF identifier.
 *
 * ── AC-4 WEIGHTS ARE SPEC-FIXED CONSTANTS (a gated-change knob, not a tuning knob) ──
 * The six weights below are FIXED BY SPEC (FR-E1). They are NOT fit to any labeled set —
 * tuning them against the held-out eval set (~/.claude-data/eval/labeled-queries.json)
 * would be train/test leakage that voids the eval gate (CLAUDE.md). A weight change does
 * NOT auto-apply: per AC-4 it routes through the monthly promotion + /red-blue-judge gate.
 * Treat WEIGHTS as a compile-time constant whose edit is a GATED action, never a runtime
 * mutation and never an eval-optimization target.
 *
 * Determinism: pure function of its inputs. No Date.now()/Math.random()/new Date() — the
 * caller supplies any timestamp (the `now` arg of `recencyFactor`), exactly as
 * findings-buffer.js and the foundation modules do. The static determinism guard in the
 * test file enforces this.
 */

/**
 * The six-factor weights — FIXED BY SPEC (FR-E1 / DIO-13 AC). They sum to 1.0, so a
 * weighted score over six [0,1] factors is itself in [0,1].
 *
 * ⚠️ GATED CONSTANT (AC-4). Do NOT tune these against the offline eval labeled set —
 * that is train/test leakage and voids the eval gate (CLAUDE.md "memory-engine changes
 * must pass the retrieval eval gate"). Any change routes through the monthly promotion +
 * /red-blue-judge gate; it does not auto-apply at runtime. Editing this object is a
 * design action, not a calibration step.
 */
const WEIGHTS = Object.freeze({
  recency: 0.2,
  semantic_similarity: 0.2,
  toin_importance: 0.25,
  error_indicator: 0.15,
  forward_reference: 0.15,
  token_density: 0.05,
});

// The canonical factor order — fixes a deterministic iteration order for scoring and for
// the (test-asserted) "weights sum to 1" invariant. Frozen so it cannot drift from WEIGHTS.
const FACTOR_KEYS = Object.freeze([
  'recency',
  'semantic_similarity',
  'toin_importance',
  'error_indicator',
  'forward_reference',
  'token_density',
]);

// Recency half-life: a candidate's recency factor falls to EXACTLY 0.5 after this many
// days (a true half-life, recencyFactor below uses exp(-age·ln2/HL) so the constant's name
// and behaviour agree — unlike ranking.ts's `exp(-age/HALF_LIFE_DAYS)`, which is a time
// constant misnamed a half-life: there the factor is 0.5 only at HL·ln2 ≈ 0.69·HL days. We
// avoid that silent trap here). A principled default (30 days), NOT fit to any labeled set.
// Lives here, not in search_config.ts, so it never touches the eval-gated surface.
const RECENCY_HALF_LIFE_DAYS = 30;
const SECONDS_PER_DAY = 86400;
const LN2 = Math.log(2);

// Token-density saturation: a candidate's information density (signal tokens / total
// tokens, already a ratio in [0,1]) is consumed directly. A separate saturation knob is
// intentionally omitted — density is a ratio by construction.

/** Clamp a number to [0,1]; coerce non-finite input to 0 (fail-closed, never NaN). */
function clamp01(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * recency factor ∈ [0,1] from a note timestamp. exp(-age_days / HALF_LIFE). A note with
 * timestamp == now scores 1; one HALF_LIFE old scores 0.5. Future timestamps (clock skew)
 * clamp to age 0 → 1. `now` is an EXPLICIT argument (epoch seconds) — never generated here
 * (determinism). A missing/invalid timestamp scores 0 (no recency evidence).
 *
 * "Reuse note timestamps" (FR-E1): the timestamp is the scorable unit's own note time,
 * supplied by the caller — this function does not read a clock.
 */
function recencyFactor(noteTimestampSeconds, nowSeconds) {
  if (
    typeof noteTimestampSeconds !== 'number' ||
    !Number.isFinite(noteTimestampSeconds) ||
    typeof nowSeconds !== 'number' ||
    !Number.isFinite(nowSeconds)
  ) {
    return 0;
  }
  const ageDays = Math.max(0, (nowSeconds - noteTimestampSeconds) / SECONDS_PER_DAY);
  // True half-life: factor = 0.5 at exactly RECENCY_HALF_LIFE_DAYS (so the name is honest).
  return Math.exp((-ageDays * LN2) / RECENCY_HALF_LIFE_DAYS); // (0, 1]
}

/**
 * The candidate FEATURE shape the scorer consumes. Every field is ALREADY NORMALIZED to
 * [0,1] by the caller EXCEPT `note_timestamp` (epoch seconds, turned into the recency
 * factor here). There is DELIBERATELY no `rrf` / retrieval-score field — FR-E4 forbids it;
 * retrieval signal enters ONLY via `semantic_similarity`.
 *
 * @typedef {object} InjectionFeatures
 * @property {number} [note_timestamp]        epoch SECONDS of the note (→ recency). Missing → recency 0.
 * @property {number} [semantic_similarity]   [0,1], from sqlite-vec UPSTREAM (caller-normalized).
 * @property {number} [toin_importance]       [0,1], topic-of-interest importance.
 * @property {number} [error_indicator]       [0,1]; a graph contract violation projects onto this (FR-E3).
 * @property {number} [forward_reference]     [0,1]; references-yet-to-come signal.
 * @property {number} [token_density]         [0,1]; signal-token ratio.
 */

/**
 * Compute the six factor values (each [0,1]) for one candidate's features. Separated from
 * the weighted sum so a test can inspect the factors directly and so the scoring
 * expression is auditable: it references EXACTLY the six declared factors and nothing else
 * (FR-E4 static check).
 */
function computeFactors(features, nowSeconds) {
  const f = features && typeof features === 'object' ? features : {};
  return {
    recency: clamp01(recencyFactor(f.note_timestamp, nowSeconds)),
    semantic_similarity: clamp01(f.semantic_similarity),
    toin_importance: clamp01(f.toin_importance),
    error_indicator: clamp01(f.error_indicator),
    forward_reference: clamp01(f.forward_reference),
    token_density: clamp01(f.token_density),
  };
}

/**
 * The six-factor score ∈ [0,1] for one candidate: the weighted sum of its six factors.
 *
 * FR-E4: this expression references ONLY the six declared factors (via FACTOR_KEYS) and
 * the spec weights. It does NOT read any RRF value — there is no RRF input to read. That
 * is the structural guarantee, asserted statically by the test.
 */
function sixFactorScore(features, nowSeconds) {
  const factors = computeFactors(features, nowSeconds);
  let score = 0;
  for (const key of FACTOR_KEYS) {
    score += WEIGHTS[key] * factors[key];
  }
  return score; // [0,1] since weights sum to 1 and each factor ∈ [0,1]
}

/**
 * Canonical stringify: a key-sorted JSON serialization, so two structurally-equal objects
 * (regardless of key insertion order) produce byte-identical output. Mirrors the foundation
 * determinism convention (smart-crusher.js stableStringify/sortKeys) in spirit — kept local
 * rather than imported across the lib boundary so this module stays self-contained and the
 * FR-E4 static guard can audit it in isolation.
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/**
 * A deterministic content hash of a candidate's SCORED FACTORS — the THIRD sort key, after
 * score and id (FR-E4-safe).
 *
 * Why factors, not the whole candidate: FR-E4 forbids any retrieval/RRF signal from touching
 * the injection order at ANY level, including a tie-break. A candidate may carry arbitrary
 * extra fields (the FR-E4 test attaches a full-range retrieval value to prove it is ignored);
 * hashing the whole object would let such a field decide order on a score+id tie — exactly the
 * entanglement FR-E4 forbids. So the hash is taken over the SIX computed factors ALONE (the
 * same unit the score is built from). This is an ORDINAL, not a magnitude: it never enters the
 * weighted sum, never ranks one candidate "up", and is consulted ONLY after score AND id have
 * already tied.
 *
 * It is NOT, on its own, a total order: two candidates with the SAME id and the SAME six
 * factors hash IDENTICALLY here even when their carried payload differs (same-id/same-factors/
 * different-meta). The TERMINAL key (contentIdentityHash) closes that last gap.
 */
function factorTieBreakHash(features, nowSeconds) {
  const factors = computeFactors(features, nowSeconds);
  return createHash('sha256').update(JSON.stringify(sortKeys(factors))).digest('hex');
}

/**
 * Keys stripped before the TERMINAL content-identity hash, so that hash is content-IDENTITY
 * (what makes two same-id/same-factor units genuinely distinct) and NOT a score term:
 *
 *   • `features`  — holds the six factor INPUTS (and the FR-E4 retrieval channel
 *                   `semantic_similarity`). The factors already drive `score` and the
 *                   factor-hash key; re-hashing them here would make the terminal key a
 *                   factor term. Stripped whole.
 *   • `score`     — the annotation rankInjection itself attaches; it is the score key, not
 *                   carried identity. (Inputs never carry it, but strip defensively.)
 *   • retrieval surface — `rrf`, `retrieval_rank`, `retrieval_score`, `retrieval`. FR-E4
 *                   forbids ANY retrieval/RRF value from touching the order at any level,
 *                   including this terminal key. The FR-E4 test attaches a top-level `rrf`;
 *                   these names cover the retrieval surface a candidate could carry.
 *
 * What SURVIVES is the inert carried payload that legitimately distinguishes two units of the
 * same id and same factors — e.g. `meta`, `summary`, `finding`, `call_path`. Hashing that
 * gives a stable, input-order-independent order for the same-id/same-factor/distinct-payload
 * case, with NO factor value and NO retrieval value participating.
 */
const TERMINAL_HASH_STRIP_KEYS = Object.freeze([
  'features',
  'score',
  'rrf',
  'retrieval_rank',
  'retrieval_score',
  'retrieval',
]);

/**
 * The TERMINAL tie-break key: a sha256 over the candidate's INERT CARRIED CONTENT with the six
 * factors and the retrieval/RRF surface stripped (TERMINAL_HASH_STRIP_KEYS). This is the key
 * that makes the order a TOTAL order: two units identical in id AND all six factors but
 * differing in carried payload (e.g. meta src A vs B) get a stable, input-order-independent
 * order here. Two units identical in id, factors, AND inert content hash identically and are
 * genuinely interchangeable (either order yields byte-identical output). FR-E4-safe by
 * construction: it references no factor value and no retrieval/RRF value — only the stripped
 * remainder of the carried payload.
 */
function contentIdentityHash(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const inert = {};
  for (const key of Object.keys(c)) {
    if (TERMINAL_HASH_STRIP_KEYS.includes(key)) continue;
    inert[key] = c[key];
  }
  return createHash('sha256').update(JSON.stringify(sortKeys(inert))).digest('hex');
}

/**
 * Rank an ALREADY-SELECTED candidate set by six-factor score, descending, and (when a
 * budget is given) truncate to it. The graph already chose WHICH candidates are eligible
 * (FR-E2 recall); this only ORDERS them (FR-E2 precision). It never adds, re-queries, or
 * expands candidates.
 *
 * A candidate is `{ id, features }` (any extra fields are carried through untouched, so the
 * caller's projected unit rides along). `nowSeconds` is the explicit clock for the recency
 * factor (never read from the system here — determinism).
 *
 * Sort keys, in order: score desc, then id asc, then factor-hash asc, then content-identity
 * hash asc. The output is deterministic and input-order-independent for any two candidates
 * that differ in id, in any of the six factors, OR in their inert carried payload — that is
 * the total order. Two candidates identical in ALL of those (same id, same six factors, same
 * inert content) are interchangeable: their keys all tie, and either input order produces
 * byte-identical output, so there is no observable order to diverge.
 *
 * The keys layer to close successive gaps: `id` alone is not total (ids can collide); the
 * factor-hash breaks a score+id tie when factors differ but CANNOT break it when factors are
 * also identical (identical factors hash identically); the TERMINAL content-identity hash
 * breaks that last case using the carried payload (meta/summary/finding/call_path) that makes
 * two same-id/same-factor units genuinely distinct.
 *
 * NOTE neither tie-break references a retrieval/RRF value (ranking.ts uses an rrf tie-break;
 * this module MUST NOT) — FR-E4: no RRF value participates in the six-factor ordering at any
 * level, not even as a tie-break. The factor-hash hashes the SIX FACTORS ONLY; the terminal
 * content-identity hash STRIPS the factors and the retrieval surface (TERMINAL_HASH_STRIP_KEYS)
 * before hashing, so no retrieval signal can sneak in through either key.
 *
 * @param {Array<{id: string|number, features: InjectionFeatures}>} candidates already-selected set
 * @param {number} nowSeconds epoch seconds for the recency factor (explicit clock)
 * @param {number} [budget] keep at most this many top-ranked; omit/<=0 → return all, ordered
 * @returns {Array<object>} the input candidates, re-ordered (and truncated to budget),
 *          each annotated with `score` (its six-factor score) for observability/tests.
 */
function rankInjection(candidates, nowSeconds, budget) {
  if (!Array.isArray(candidates)) return [];
  const scored = candidates.map((c) => {
    const features = c && typeof c === 'object' ? c.features : undefined;
    return {
      candidate: c,
      score: sixFactorScore(features, nowSeconds),
      // Tie-break keys, precomputed once per candidate (sort comparators run O(n log n) times).
      // factorHash hashes the SIX FACTORS ONLY; contentHash hashes the inert carried payload
      // with the factors AND the retrieval/RRF surface stripped. Neither reads a retrieval/RRF
      // value, so no such value can enter the order through a tie-break (FR-E4).
      factorHash: factorTieBreakHash(features, nowSeconds),
      contentHash: contentIdentityHash(c),
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // String-compare ids coerced to string so mixed/number ids order consistently.
    const ai = a.candidate && a.candidate.id;
    const bi = b.candidate && b.candidate.id;
    const byId = String(ai).localeCompare(String(bi));
    if (byId !== 0) return byId;
    // Ids collide (e.g. the id-less `id: ''` projection fallback) — fall to the factor-hash,
    // which separates candidates whose six factors differ.
    if (a.factorHash !== b.factorHash) return a.factorHash < b.factorHash ? -1 : 1;
    // Same id AND same six factors — the factor-hash also ties. The TERMINAL content-identity
    // hash breaks it using the inert carried payload (meta/summary/finding/...), making the
    // order total and input-order-independent. Truly-identical units hash equally here and are
    // interchangeable (either order → byte-identical output).
    return a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0;
  });

  const ordered = scored.map(({ candidate, score }) => ({ ...candidate, score }));
  if (typeof budget === 'number' && budget > 0) return ordered.slice(0, budget);
  return ordered;
}

// ── B10 PROJECTION: graph findings → six-factor scorable unit (FR-E3) ─────────
/**
 * Severity → error_indicator magnitude. A contract VIOLATION is a defect/invariant fact;
 * projecting it onto error_indicator is what makes "defect facts rank up by construction"
 * (FR-E3 / B10). Severity graduates the signal: an `error` violation is the strongest
 * error indicator (1.0), a `warning` strong-but-not-maximal, `info` modest. The mapping is
 * a fixed, principled default (NOT fit to any labeled set) — it lives here, off the
 * eval-gated surface.
 */
const SEVERITY_ERROR_INDICATOR = Object.freeze({
  error: 1.0,
  warning: 0.6,
  info: 0.3,
});

/**
 * Project ONE graph ContractFinding onto a six-factor scorable unit (FR-E3, resolves B10).
 *
 * The graph speaks in SYMBOLS / CALL-PATHS; the six-factor ranker scores UNITS (messages /
 * working-memory notes). Before "rank within the candidate set" is even well-defined, a
 * finding must become a scorable unit. This is that projection. The load-bearing mapping:
 * a contract violation lands on `error_indicator` (graduated by severity) — so the graph
 * is a first-class PRODUCER of error_indicator and defect/invariant facts rank UP by
 * construction, not by tuning.
 *
 * The finding's `id` for ranking is its symbol_id (stable, repo-relative). The summary +
 * call_path ride along on the projected unit so the enrich text can cite concrete evidence
 * (FR-H4: a finding without a call path is not shippable). Other factors default to 0
 * UNLESS the caller overrides via `extraFeatures` (e.g. a recency/similarity it computed
 * upstream) — the projection asserts the error_indicator; it does not invent recency.
 *
 * ID FALLBACK (determinism robustness). A well-formed finding carries a symbol_id (FR-H4),
 * so its id is that. But a malformed, symbol-less, rule-less finding would otherwise project
 * to `id: ''` — and two such would COLLIDE on the empty id, leaving rankInjection's id key
 * unable to separate them. Rather than emit a colliding empty id, derive a deterministic
 * `auto:<hash>` id from the finding's own inert content (severity/kind/summary/call_path).
 * Distinct malformed findings then carry distinct ids, so the id key orders them without
 * input-order dependence; truly-identical findings share an id and are interchangeable (the
 * factor-hash backstop in rankInjection then ties them too). No retrieval signal participates
 * — the derivation reads ONLY the finding's carried evidence, never a score/RRF value.
 *
 * @param {object} finding a ContractFinding (graph/types.ts): { rule_id, severity, kind,
 *        symbol_id, call_path, summary, index_commit }
 * @param {InjectionFeatures} [extraFeatures] caller-supplied normalized features to merge
 *        (e.g. semantic_similarity from sqlite-vec, note_timestamp). error_indicator from
 *        the violation WINS over any extraFeatures.error_indicator only if it is larger —
 *        a projected violation can raise, never lower, the error signal.
 * @returns {{id: string, features: InjectionFeatures, finding: object}} a scorable unit
 */
/**
 * Deterministic content-derived id for a symbol-less, rule-less finding (the malformed-input
 * fallback — see projectFinding's ID FALLBACK note). Hashes ONLY the finding's inert carried
 * evidence so distinct malformed findings get distinct ids; no score/RRF value is read.
 */
function autoFindingId(fnd) {
  const content = {
    severity: fnd.severity,
    kind: fnd.kind,
    summary: fnd.summary,
    call_path: Array.isArray(fnd.call_path) ? fnd.call_path : [],
  };
  const digest = createHash('sha256').update(JSON.stringify(sortKeys(content))).digest('hex');
  return `auto:${digest.slice(0, 16)}`;
}

function projectFinding(finding, extraFeatures) {
  const fnd = finding && typeof finding === 'object' ? finding : {};
  const severity = fnd.severity;
  const violationIndicator = clamp01(SEVERITY_ERROR_INDICATOR[severity] ?? 0);

  const base = extraFeatures && typeof extraFeatures === 'object' ? extraFeatures : {};
  // A projected violation RAISES error_indicator (never lowers it): take the max of any
  // caller-supplied error_indicator and the violation's. Defects rank up by construction.
  const error_indicator = Math.max(clamp01(base.error_indicator), violationIndicator);

  // Prefer the stable symbol_id (then rule_id); fall back to a content-derived id so a
  // malformed symbol-less finding does NOT project to a colliding empty id (determinism).
  const stableId = fnd.symbol_id ?? fnd.rule_id;
  const id = stableId != null && stableId !== '' ? String(stableId) : autoFindingId(fnd);

  return {
    id,
    features: {
      ...base,
      error_indicator,
    },
    // Evidence carried onto the unit so enrich text can cite the concrete call path.
    finding: {
      rule_id: fnd.rule_id,
      severity: fnd.severity,
      kind: fnd.kind,
      symbol_id: fnd.symbol_id,
      call_path: Array.isArray(fnd.call_path) ? fnd.call_path : [],
      summary: fnd.summary,
    },
  };
}

/**
 * Project a list of graph findings into scorable candidates (the common path: the graph's
 * `findings` array → injection candidates). `extraFeaturesFor(finding)` lets the caller
 * attach per-finding normalized features (similarity, recency) computed upstream; it
 * defaults to none. Order is preserved (rankInjection imposes the deterministic order).
 *
 * @param {object[]} findings ContractFinding[]
 * @param {(finding: object) => InjectionFeatures} [extraFeaturesFor]
 * @returns {Array<{id: string, features: InjectionFeatures, finding: object}>}
 */
function projectFindings(findings, extraFeaturesFor) {
  if (!Array.isArray(findings)) return [];
  const fn = typeof extraFeaturesFor === 'function' ? extraFeaturesFor : () => undefined;
  return findings.map((f) => projectFinding(f, fn(f)));
}

module.exports = {
  // spec-fixed constants (AC-4: gated change, never an eval-tuning target)
  WEIGHTS,
  FACTOR_KEYS,
  RECENCY_HALF_LIFE_DAYS,
  SEVERITY_ERROR_INDICATOR,
  // factor helpers
  clamp01,
  recencyFactor,
  computeFactors,
  // the scorer + ranker (FR-E1, FR-E2, FR-E4)
  sixFactorScore,
  rankInjection,
  // B10 projection (FR-E3): graph findings → scorable unit; violation → error_indicator
  projectFinding,
  projectFindings,
};
