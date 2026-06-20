'use strict';

/**
 * injection-enrich.js — the LIVE graph-enrich handler (PRD FR-A1/FR-E, DIO-13).
 *
 * WHAT THIS IS. The wiring that makes the six-factor INJECTION ranker
 * (injection-ranking.js) live end-to-end on the FROZEN ContentRouter seam
 * (posttooluse-content-router.js). It takes the GRAPH-SELECTED candidate set (the recall
 * set DIO-9's graph produces — FR-E2), and when that set exceeds the injection budget it
 * ORDERS + TRUNCATES it with `rankInjection` and emits the survivors as the router's
 * `additionalContext` field. Without this module the ranker is dead code; with it, a
 * graph-selected over-budget set actually gets six-factor-ranked and injected.
 *
 * ── WHERE THE SEAM PLUGS IN (the freeze) ──────────────────────────────────────
 * Seam doc §5: "DIO-13 (graph enrich) APPENDS a new handler returning { additionalContext }."
 * This module is that handler. It registers on `HANDLERS` AFTER the compressor, so a single
 * tool result can be BOTH compressed (`updatedToolOutput`, Headroom) AND enriched
 * (`additionalContext`, Gortex) in one pass (FR-A1) — the two fields co-carry on one
 * `hookSpecificOutput` and NEVER collide (they are different keys; the router merges them).
 * The seam, input decode, output schema, and skip mechanism are untouched — that is the freeze.
 *
 * ── WHY THE semantic_similarity COMPUTE LIVES HERE, NOT IN mcp/ (eval-gate boundary) ──
 * FR-E1/FR-E4 require retrieval signal to enter six-factor ONLY through the pre-normalized
 * `semantic_similarity` factor ([0,1]). The CALLER is the producer of that number. This
 * handler computes it from a candidate's PRECOMPUTED embedding vector via an injected
 * `similarityResolver` — a pure cosine over unit-normalized vectors, normalized to [0,1]
 * HERE in hooks. It reads NO eval-gated module: not ranking.ts, not search_config.ts, not
 * embedder.ts, not indexer.ts, not db.ts. It does not re-embed, re-rank the corpus, or
 * change any index. The cosine of two already-normalized 768-dim vectors is a 30-line dot
 * product — there is no reason to cross into mcp/ for it, and crossing would needlessly arm
 * the eval gate. Keeping it in hooks SIDESTEPS the gate by construction (CLAUDE.md: the gate
 * binds changes to ranking/embedding/indexing modules in mcp/; this is none of those).
 *
 * ── FR-E4 SCALE ISOLATION (the load-bearing hazard) ───────────────────────────
 * The handler feeds the scorer ONLY normalized [0,1] features. `semantic_similarity` is
 * normalized to [0,1] BEFORE it reaches `rankInjection`. No RRF magnitude (ranking.ts's
 * ~0.003–0.033 score) is ever read, passed, or combined — this module does not import the
 * RRF path and has no `rrf` field anywhere in its candidate shape.
 *
 * ── DETERMINISM (foundation convention) ───────────────────────────────────────
 * Pure function of its inputs. No Date.now()/Math.random()/new Date(). The recency clock
 * (`nowSeconds`) is threaded explicitly from the caller, exactly as injection-ranking.js and
 * the foundation modules do. The static determinism guard in the test enforces this.
 *
 * ── FAIL-SAFE (DIO-4 seam posture) ────────────────────────────────────────────
 * A ranking error MUST fall back to the raw/unranked set, never break the hook. The handler
 * `route()` is wrapped so any throw inside the ranking path degrades to the unranked
 * candidate text (or, if even that fails, emits nothing → raw append). The seam never fails
 * a tool call (seam doc §7).
 */

const ranking = require('./injection-ranking.js');

// The default per-pass injection budget: at most this many candidates survive to
// `additionalContext`. A principled default (NOT fit to any labeled set) — over-budget is
// exactly when ordering matters (FR-E2 precision), and an unbounded inject would defeat the
// token-savings purpose of the whole pipeline. The caller may override per call.
const DEFAULT_INJECTION_BUDGET = 8;

/**
 * Cosine similarity of two embedding vectors, normalized to [0,1].
 *
 * The embedder (mcp/src/embedder.ts) emits UNIT-NORMALIZED vectors, so the raw cosine is the
 * dot product in [-1,1] (mirrors mcp/src/novelty.ts `cosine`, re-implemented here so this
 * module imports NO eval-gated mcp source). We map [-1,1] → [0,1] via (cos + 1) / 2 so the
 * value is a valid six-factor feature: a perfectly aligned vector → 1, orthogonal → 0.5,
 * opposed → 0. The result is clamped defensively (a non-unit input cannot push it out of range).
 *
 * @param {ArrayLike<number>} a embedding vector (e.g. the query's)
 * @param {ArrayLike<number>} b embedding vector (e.g. a candidate's, read from vec_items)
 * @returns {number} normalized similarity in [0,1]; 0 when either vector is missing/empty
 */
function cosineSimilarity01(a, b) {
  if (!a || !b || typeof a.length !== 'number' || typeof b.length !== 'number') return 0;
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  // [-1,1] → [0,1]. clamp01 fails closed on any non-finite/out-of-range result.
  return ranking.clamp01((dot + 1) / 2);
}

/**
 * Resolve a candidate's `semantic_similarity` feature ([0,1]) for this enrich pass.
 *
 * Resolution order (first that yields a value wins):
 *   1. A caller-injected `similarityResolver(candidate, ctx)` returning a [0,1] number —
 *      the production path when the caller has computed similarity upstream (the cheapest:
 *      no compute crosses this module at all).
 *   2. A precomputed embedding pair on the candidate (`candidate.embedding`) against a
 *      `queryEmbedding` in ctx — this module computes the cosine→[0,1] itself, reading
 *      ONLY the precomputed vectors (never re-embedding, never an mcp gated module).
 *   3. A pre-supplied `candidate.features.semantic_similarity` already in [0,1].
 *   4. 0 — no similarity evidence (fail-closed; the candidate still ranks on its other factors).
 *
 * Every branch clamps to [0,1] so what reaches the scorer is ALWAYS a valid normalized
 * feature (FR-E4: the handler normalizes BEFORE the scorer sees it).
 *
 * @param {object} candidate the graph-selected candidate (carries id, features, maybe embedding)
 * @param {object} ctx { similarityResolver?, queryEmbedding? }
 * @returns {number} semantic_similarity in [0,1]
 */
function resolveSemanticSimilarity(candidate, ctx = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};

  if (typeof ctx.similarityResolver === 'function') {
    const v = ctx.similarityResolver(c, ctx);
    if (typeof v === 'number' && Number.isFinite(v)) return ranking.clamp01(v);
  }

  if (c.embedding && ctx.queryEmbedding) {
    return cosineSimilarity01(ctx.queryEmbedding, c.embedding);
  }

  const pre = c.features && typeof c.features === 'object' ? c.features.semantic_similarity : undefined;
  if (typeof pre === 'number' && Number.isFinite(pre)) return ranking.clamp01(pre);

  return 0;
}

/**
 * Project ONE graph-selected candidate onto a scorable unit, attaching the freshly-computed
 * `semantic_similarity`. The candidate may arrive in two shapes:
 *   - a raw graph ContractFinding (has `symbol_id`/`severity`) → projected via
 *     ranking.projectFinding so a contract violation lands on error_indicator (FR-E3); the
 *     computed similarity is merged in as an extra normalized feature.
 *   - an already-shaped `{ id, features }` unit → carried through, with semantic_similarity
 *     overwritten by the freshly-resolved value (so the handler is the single producer of it).
 *
 * In BOTH cases semantic_similarity is normalized to [0,1] by resolveSemanticSimilarity
 * BEFORE it lands on `features` — the FR-E4 guarantee, asserted by the test.
 *
 * @returns {{id: string, features: object, finding?: object}} a scorable unit
 */
function projectCandidate(candidate, ctx = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const semantic_similarity = resolveSemanticSimilarity(c, ctx);

  // A raw graph finding: project it (violation → error_indicator) and merge similarity in.
  const looksLikeFinding =
    c.symbol_id !== undefined || c.severity !== undefined || c.rule_id !== undefined;
  if (looksLikeFinding && c.features === undefined) {
    const base = c.extraFeatures && typeof c.extraFeatures === 'object' ? c.extraFeatures : {};
    return ranking.projectFinding(c, { ...base, semantic_similarity });
  }

  // An already-shaped unit: carry it through; the handler is the sole producer of
  // semantic_similarity, so it OVERWRITES any stale value on the way in.
  const features = c.features && typeof c.features === 'object' ? c.features : {};
  return {
    ...c,
    id: String(c.id ?? ''),
    features: { ...features, semantic_similarity },
  };
}

/**
 * Render the ranked candidate set into the `additionalContext` text the seam injects. The
 * text cites concrete evidence per unit (FR-H4: a finding without a call path is not
 * shippable) — a graph-projected unit carries its `finding.call_path`, which is rendered so
 * the agent sees WHY the unit was injected, not just THAT it was.
 *
 * Deterministic: a pure function of the ranked array (already in total order). One line per
 * unit, capped, no clock, no randomness.
 */
function buildEnrichText(ranked) {
  if (!Array.isArray(ranked) || ranked.length === 0) return '';
  const lines = ['[graph-enrich] top-ranked context for this result:'];
  for (const unit of ranked) {
    const id = String(unit && unit.id != null ? unit.id : '');
    const score = typeof unit.score === 'number' ? unit.score.toFixed(3) : '—';
    let evidence = '';
    if (unit.finding && Array.isArray(unit.finding.call_path) && unit.finding.call_path.length > 0) {
      evidence = ` via ${unit.finding.call_path.join(' → ')}`;
    } else if (unit.finding && unit.finding.summary) {
      evidence = ` — ${unit.finding.summary}`;
    }
    lines.push(`  • ${id} (score ${score})${evidence}`);
  }
  return lines.join('\n');
}

/**
 * The LIVE enrich pass: graph-selected set → project (+ compute normalized similarity) →
 * rank/truncate when over budget → render injection text. Returns the `additionalContext`
 * string, or undefined when nothing should be injected (empty set).
 *
 * Over-budget is exactly when ordering matters (FR-E2 precision): under budget, every
 * candidate is injected in deterministic rank order; over budget, only the top `budget`
 * survive. Either way the order is the six-factor order — the ranker is LIVE on every pass.
 *
 * @param {Array<object>} candidates the graph-selected recall set (findings or shaped units)
 * @param {object} ctx { nowSeconds, budget?, similarityResolver?, queryEmbedding? }
 * @returns {string|undefined} the additionalContext text, or undefined for an empty set
 */
function enrich(candidates, ctx = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;

  const nowSeconds = ctx.nowSeconds; // explicit clock — never read from the system here
  const budget =
    typeof ctx.budget === 'number' && ctx.budget > 0 ? ctx.budget : DEFAULT_INJECTION_BUDGET;

  // 1. Project every candidate to a scorable unit, computing + normalizing semantic_similarity
  //    to [0,1] BEFORE it reaches the scorer (FR-E4).
  const units = candidates.map((c) => projectCandidate(c, ctx));

  // 2. Rank (and truncate to budget when over budget). rankInjection imposes the deterministic
  //    total order; over budget it keeps the top `budget` (FR-E2 precision); at/under budget it
  //    returns the whole set in rank order.
  const ranked = ranking.rankInjection(units, nowSeconds, budget);

  const text = buildEnrichText(ranked);
  return text.length > 0 ? text : undefined;
}

/**
 * Build the enrich handler for the ContentRouter `HANDLERS` chain (seam doc §5). The handler
 * is { id, detect, route }. It claims a tool call ONLY when the caller has staged a
 * graph-selected candidate set for it (under `toolInput._dioscuri.enrichCandidates`) — so it
 * does NOT spend tokens on every tool result (FR-A3: enrich fires only when there is a
 * selected set to inject). `route()` returns `{ additionalContext }` and NOTHING else, so it
 * can never collide with the compressor's `updatedToolOutput` (different keys; the router
 * co-carries both — FR-A1).
 *
 * FAIL-SAFE: the entire ranking path is wrapped. Any throw degrades to the UNRANKED candidate
 * text (best-effort raw injection); if even rendering the raw set throws, route() returns {}
 * → no `additionalContext` → raw append. A ranking error NEVER breaks the hook (seam doc §7).
 *
 * @param {object} [deps] { nowSecondsFn, similarityResolver, onEnrich } injected for
 *   determinism/testing. `nowSecondsFn` supplies the recency clock; it is the ONE place a clock
 *   may be read, and it is injected (never an inline Date.now()) so the module source stays
 *   clock-free.
 *
 *   `onEnrich` is the DIO-15 fire-volume SIGNAL tap — the additionalContext token-cost guard.
 *   It is called once per CLAIMED enrich pass with { fired, unitCount, injectedText } so the
 *   TOIN log records how often enrich injects and how much (the over-firing detector). SIGNAL
 *   ONLY: its return value is discarded and a throw is swallowed, so it can never change what
 *   route() emits or break the hook. Default = the TOIN logger's enrich record.
 */
function createEnrichHandler(deps = {}) {
  const nowSecondsFn = typeof deps.nowSecondsFn === 'function' ? deps.nowSecondsFn : null;
  const defaultSimilarityResolver =
    typeof deps.similarityResolver === 'function' ? deps.similarityResolver : undefined;

  // The fire-volume signal tap. Fire-and-forget; never throws into route(). Default emits the
  // TOIN enrich record. The token estimate is computed by the record builder from the text
  // LENGTH only — the injected text itself is never logged (signal = size, not content).
  const onEnrich =
    typeof deps.onEnrich === 'function'
      ? deps.onEnrich
      : (ev) => {
          try {
            require('./toin-log.js').defaultLogger().logEnrich(ev);
          } catch {
            /* signal logging is best-effort; never break the hook */
          }
        };
  function signalEnrich(ev) {
    try {
      onEnrich(ev);
    } catch {
      /* a throwing tap never affects the route() emission */
    }
  }

  return Object.freeze({
    id: 'graph-enrich',
    // Claim ONLY when a graph-selected candidate set is staged for injection (FR-A3: do not
    // spend tokens on every result). Reads the per-call control channel the seam established.
    detect: (input) => {
      const ctl = (input && input.toolInput && input.toolInput._dioscuri) || {};
      return Array.isArray(ctl.enrichCandidates) && ctl.enrichCandidates.length > 0;
    },
    route: (input) => {
      const ctl = (input && input.toolInput && input.toolInput._dioscuri) || {};
      const candidates = Array.isArray(ctl.enrichCandidates) ? ctl.enrichCandidates : [];

      // The recency clock is injected (determinism). Fall back to the per-call value the
      // caller may stage, else 0 (recency contributes nothing rather than reading a clock here).
      const nowSeconds = nowSecondsFn
        ? nowSecondsFn()
        : typeof ctl.nowSeconds === 'number'
          ? ctl.nowSeconds
          : 0;

      const ctx = {
        nowSeconds,
        budget: ctl.budget,
        // Per-call query embedding (for the cosine compute) + a similarity resolver. A
        // per-call resolver overrides the handler default.
        queryEmbedding: ctl.queryEmbedding,
        similarityResolver:
          typeof ctl.similarityResolver === 'function'
            ? ctl.similarityResolver
            : defaultSimilarityResolver,
      };

      try {
        const additionalContext = enrich(candidates, ctx);
        const fired = additionalContext !== undefined;
        // SIGNAL fire-volume (AC-1c): this pass CLAIMED (a set was staged) — record whether it
        // injected, how many candidates were in play, and the injected size. The token estimate
        // is derived from the text length only; the text is never stored.
        signalEnrich({ fired, unitCount: candidates.length, injectedText: fired ? additionalContext : '' });
        return fired ? { additionalContext } : {};
      } catch {
        // FAIL-SAFE: ranking threw → degrade to the UNRANKED candidate set as raw injection
        // text (best-effort), never break the hook. If even this throws, fall through to {}.
        try {
          const rawText = buildEnrichText(
            candidates.map((c, i) => ({
              id: String((c && (c.id ?? c.symbol_id)) ?? i),
              finding: c && c.call_path ? { call_path: c.call_path, summary: c.summary } : undefined,
            })),
          );
          const fired = rawText.length > 0;
          signalEnrich({ fired, unitCount: candidates.length, injectedText: fired ? rawText : '' });
          return fired ? { additionalContext: rawText } : {};
        } catch {
          return {}; // last-resort: emit nothing → raw append
        }
      }
    },
  });
}

module.exports = {
  DEFAULT_INJECTION_BUDGET,
  cosineSimilarity01,
  resolveSemanticSimilarity,
  projectCandidate,
  buildEnrichText,
  enrich,
  createEnrichHandler,
};
