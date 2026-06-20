'use strict';

/**
 * injection-enrich.test.js — DIO-13 LIVE enrich path (the wiring that makes the six-factor
 * ranker live end-to-end). Covers the new handler's logic and re-asserts the THREE hazards
 * on the new code:
 *   HAZARD 1 — wrapped-envelope contract: the enrich path, if it rehydrates a compressed
 *     unit, consumes the router's WRAPPED `_dioscuri` envelope, never a bare compress() result.
 *   HAZARD 2 — FR-E4 scale isolation: the handler feeds the scorer ONLY normalized [0,1]
 *     features; semantic_similarity is normalized to [0,1] BEFORE the scorer; no RRF leaks in.
 *   HAZARD 3 — eval weight leakage: this module never tunes the six weights (it consumes the
 *     scorer; it does not own the weights) and references no eval-gated mcp module.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_INJECTION_BUDGET,
  cosineSimilarity01,
  resolveSemanticSimilarity,
  projectCandidate,
  buildEnrichText,
  enrich,
  createEnrichHandler,
} = require('../injection-enrich.js');

const crusher = require('../smart-crusher.js');
const ccr = require('../ccr-retrieve.js');
const router = require('../../posttooluse-content-router.js');

const NOW = 1_700_000_000; // fixed epoch seconds — explicit clock, never the system clock

// ── semantic_similarity compute: cosine → [0,1] normalization (the one real compute) ──

test('cosineSimilarity01: unit vectors normalize cos∈[-1,1] → [0,1]', () => {
  const a = [1, 0, 0];
  assert.equal(cosineSimilarity01(a, [1, 0, 0]), 1, 'aligned → 1');
  assert.equal(cosineSimilarity01(a, [0, 1, 0]), 0.5, 'orthogonal → 0.5');
  assert.equal(cosineSimilarity01(a, [-1, 0, 0]), 0, 'opposed → 0');
});

test('cosineSimilarity01: missing/empty vectors fail closed to 0 (no NaN)', () => {
  assert.equal(cosineSimilarity01(null, [1, 0]), 0);
  assert.equal(cosineSimilarity01([1, 0], undefined), 0);
  assert.equal(cosineSimilarity01([], []), 0);
});

test('cosineSimilarity01: the output is ALWAYS in [0,1] (clamped), never out of range', () => {
  // A non-unit input could push the raw dot product past ±1; the [0,1] clamp must hold.
  const big = [10, 10, 10];
  const v = cosineSimilarity01(big, big);
  assert.ok(v >= 0 && v <= 1, `normalized similarity ${v} must be in [0,1]`);
});

// ── HAZARD 2 (FR-E4): the handler normalizes similarity to [0,1] BEFORE the scorer ────

test('HAZARD 2 (FR-E4): resolveSemanticSimilarity ALWAYS returns a [0,1] value', () => {
  // Injected resolver returning an out-of-range value is clamped (never reaches the scorer raw).
  assert.equal(resolveSemanticSimilarity({}, { similarityResolver: () => 5 }), 1);
  assert.equal(resolveSemanticSimilarity({}, { similarityResolver: () => -3 }), 0);
  assert.equal(resolveSemanticSimilarity({}, { similarityResolver: () => 0.42 }), 0.42);
  // A precomputed feature already in [0,1] is honored; out-of-range is clamped.
  assert.equal(resolveSemanticSimilarity({ features: { semantic_similarity: 0.7 } }, {}), 0.7);
  assert.equal(resolveSemanticSimilarity({ features: { semantic_similarity: 9 } }, {}), 1);
  // No evidence → 0 (fail-closed), not NaN.
  assert.equal(resolveSemanticSimilarity({}, {}), 0);
});

test('HAZARD 2 (FR-E4): the embedding path computes the cosine→[0,1] in hooks (no mcp module)', () => {
  // queryEmbedding + candidate.embedding → the handler itself computes the normalized cosine.
  const sim = resolveSemanticSimilarity(
    { embedding: [1, 0, 0] },
    { queryEmbedding: [1, 0, 0] },
  );
  assert.equal(sim, 1, 'aligned precomputed vectors → similarity 1, computed in-hook');
});

test('HAZARD 2 (FR-E4): projectCandidate lands a NORMALIZED similarity on features before scoring', () => {
  const unit = projectCandidate(
    { id: 'x', features: { toin_importance: 0.5 } },
    { similarityResolver: () => 7 }, // out of range on purpose
  );
  assert.ok(
    unit.features.semantic_similarity >= 0 && unit.features.semantic_similarity <= 1,
    'similarity is normalized to [0,1] on the projected unit',
  );
  assert.equal(unit.features.semantic_similarity, 1, 'clamped to 1 before it can reach the scorer');
});

test('HAZARD 2 (FR-E4): the enrich source references NO RRF identifier / no gated mcp module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'injection-enrich.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\brrf\b/i.test(code), 'no rrf-typed value participates in the enrich path');
  assert.ok(!/RRF_K/.test(code), 'no RRF_K (search_config.ts) reference');
  assert.ok(!/ranking\.ts|search_config|\bembedder\b|indexer\.ts/.test(code),
    'must not import any eval-gated mcp module (ranking/search_config/embedder/indexer)');
});

// ── HAZARD 3: this module consumes the scorer; it never owns/tunes the six weights ────

test('HAZARD 3: the enrich module does not define or mutate the six weights', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'injection-enrich.js'), 'utf8');
  // It must NOT declare a WEIGHTS object (that lives in injection-ranking.js, the gated-knob
  // owner) — the enrich layer is wiring, not a place a weight could be tuned against the eval set.
  assert.ok(!/const\s+WEIGHTS\b/.test(src), 'enrich must not declare its own weights');
});

// ── HAZARD 1: a rehydrated/compressed unit flows through the WRAPPED envelope ──────────

function makeCompressible(n = 40, errorAt = 20) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      i === errorAt
        ? { idx: i, status: 'FAIL', msg: 'contract violated', kind: 'check' }
        : { idx: i, status: 'OK', msg: 'ran', kind: 'check' },
    );
  }
  return rows;
}

test('HAZARD 1: enriching rehydrated rows uses the WRAPPED envelope (no silent degradation)', () => {
  const result = crusher.compress(makeCompressible());
  const envelope = router.buildCompressedEnvelope(result); // the shape that flows on updatedToolOutput
  const rehydrated = ccr.rehydrateEnvelope(envelope);
  assert.notEqual(rehydrated.originalHash, null, 'wrapped envelope preserves the hash — consume only this');

  // Project the rehydrated rows into enrich candidates and rank — the FAIL row must survive.
  const candidates = rehydrated.rows.map((row, i) => ({
    id: `row-${row.idx ?? i}`,
    features: {
      note_timestamp: NOW,
      error_indicator: row.status === 'FAIL' ? 1 : 0,
      semantic_similarity: 0.4,
    },
  }));
  const text = enrich(candidates, { nowSeconds: NOW, budget: 3 });
  assert.ok(typeof text === 'string' && text.includes('row-20'), 'the error-bearing row survives the budget cut');
});

// ── The LIVE enrich pass: project → compute similarity → rank → render ────────────────

test('enrich: an over-budget set is six-factor-ranked + truncated to budget', () => {
  const candidates = [
    { id: 'a', features: { toin_importance: 0.1 } },
    { id: 'b', features: { toin_importance: 0.9 } },
    { id: 'c', features: { toin_importance: 0.5 } },
    { id: 'd', features: { toin_importance: 0.7 } },
  ];
  const text = enrich(candidates, { nowSeconds: NOW, budget: 2 });
  // Top 2 by toin_importance are b (0.9) and d (0.7); a and c are cut.
  assert.ok(text.includes('b ') && text.includes('d '), 'the two highest-scored survive');
  assert.ok(!/\ba \(/.test(text) && !/\bc \(/.test(text), 'the lower-scored are truncated');
});

test('enrich: similarity drives ordering — a high-similarity candidate ranks up', () => {
  // Two otherwise-identical candidates; the one the resolver scores higher on similarity ranks first.
  const candidates = [
    { id: 'low-sim', features: { toin_importance: 0.5 } },
    { id: 'high-sim', features: { toin_importance: 0.5 } },
  ];
  const similarityResolver = (c) => (c.id === 'high-sim' ? 1 : 0);
  const text = enrich(candidates, { nowSeconds: NOW, similarityResolver });
  const firstLineIdx = text.indexOf('high-sim');
  const secondLineIdx = text.indexOf('low-sim');
  assert.ok(firstLineIdx > -1 && secondLineIdx > -1);
  assert.ok(firstLineIdx < secondLineIdx, 'the high-similarity candidate is rendered first (ranks up)');
});

test('enrich: an empty/non-array set injects nothing (undefined → no additionalContext)', () => {
  assert.equal(enrich([], { nowSeconds: NOW }), undefined);
  assert.equal(enrich(null, { nowSeconds: NOW }), undefined);
});

test('enrich: a graph finding is projected (violation → error_indicator) and ranks up', () => {
  const violation = {
    rule_id: 'search-pool-nonempty',
    severity: 'error',
    symbol_id: 'mcp/src/search.ts#searchMemory',
    call_path: ['a#x', 'mcp/src/search.ts#searchMemory'],
    summary: 'path reaches provider without the required guard',
  };
  const cleanNote = { id: 'clean#1', features: { toin_importance: 0.3 } };
  const text = enrich([cleanNote, violation], { nowSeconds: NOW });
  // The violation (error_indicator → 1.0) outranks the clean note — and its call path is cited.
  const vIdx = text.indexOf('searchMemory');
  const cIdx = text.indexOf('clean#1');
  assert.ok(vIdx > -1 && vIdx < cIdx, 'the contract violation ranks first by construction');
  assert.ok(text.includes('a#x → mcp/src/search.ts#searchMemory'), 'the call path is cited (FR-H4)');
});

test('buildEnrichText: deterministic, one line per unit, cites call-path evidence', () => {
  const ranked = [
    { id: 'x', score: 0.5, finding: { call_path: ['a#1', 'b#2'] } },
    { id: 'y', score: 0.25 },
  ];
  const t1 = buildEnrichText(ranked);
  const t2 = buildEnrichText(ranked);
  assert.equal(t1, t2, 'pure function of input — byte-identical');
  assert.ok(t1.includes('a#1 → b#2'), 'call path rendered as evidence');
  assert.ok(t1.includes('(score 0.500)'), 'score rendered for observability');
});

// ── Determinism (foundation convention) ────────────────────────────────────────────────

test('DETERMINISM: enrich output is identical regardless of input order', () => {
  const set = [
    { id: 'a', features: { toin_importance: 0.5, semantic_similarity: 0.2 } },
    { id: 'b', features: { toin_importance: 0.5, semantic_similarity: 0.2 } },
    { id: 'c', features: { toin_importance: 0.9 } },
  ];
  const forward = enrich(set, { nowSeconds: NOW });
  const reversed = enrich([...set].reverse(), { nowSeconds: NOW });
  assert.equal(forward, reversed, 'input order must not change the injected text (total order)');
});

test('DETERMINISM: no wall-clock / random in the enrich module source (static guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'injection-enrich.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now() — nondeterministic');
  assert.ok(!/Math\.random\s*\(/.test(code), 'no Math.random() — nondeterministic');
  assert.ok(!/new\s+Date\s*\(/.test(code), 'no new Date() — nondeterministic');
});

// ── The handler factory: detect (FR-A3 gating) + fail-safe ──────────────────────────────

test('detect: the handler claims ONLY when a graph-selected candidate set is staged (FR-A3)', () => {
  const handler = createEnrichHandler();
  assert.equal(handler.detect({ toolInput: {} }), false, 'no staged set → not claimed (no token spend)');
  assert.equal(
    handler.detect({ toolInput: { _dioscuri: { enrichCandidates: [] } } }),
    false,
    'empty staged set → not claimed',
  );
  assert.equal(
    handler.detect({ toolInput: { _dioscuri: { enrichCandidates: [{ id: 'x', features: {} }] } } }),
    true,
    'a non-empty staged set → claimed',
  );
});

test('route: returns ONLY additionalContext (never updatedToolOutput — no field collision)', () => {
  const handler = createEnrichHandler({ nowSecondsFn: () => NOW });
  const out = handler.route({
    toolInput: { _dioscuri: { enrichCandidates: [{ id: 'x', features: { toin_importance: 0.9 } }] } },
  });
  assert.ok('additionalContext' in out, 'enrich emits additionalContext');
  assert.ok(!('updatedToolOutput' in out), 'enrich NEVER emits updatedToolOutput (compressor owns it)');
});

test('FAIL-SAFE: a throwing similarity resolver degrades to raw unranked injection, never breaks', () => {
  const handler = createEnrichHandler({
    nowSecondsFn: () => NOW,
    similarityResolver: () => {
      throw new Error('boom in the ranking path');
    },
  });
  const out = handler.route({
    toolInput: {
      _dioscuri: {
        enrichCandidates: [
          { id: 'c1', call_path: ['a#1'], summary: 'still injectable raw' },
          { id: 'c2' },
        ],
      },
    },
  });
  // The ranking path threw (resolver throws on every candidate) → fail-safe to the raw set.
  assert.ok('additionalContext' in out, 'fail-safe still injects the raw candidate set');
  assert.ok(out.additionalContext.includes('c1'), 'raw injection lists the candidates');
  assert.ok(out.additionalContext.includes('a#1'), 'raw injection preserves call-path evidence');
});

test('FAIL-SAFE: a handler default clock keeps the module clock-free (injected, not inline)', () => {
  // With no injected clock and no per-call nowSeconds, recency contributes nothing — but the
  // pass still runs and ranks on the other factors (it must not crash for a missing clock).
  const handler = createEnrichHandler();
  const out = handler.route({
    toolInput: { _dioscuri: { enrichCandidates: [{ id: 'x', features: { toin_importance: 0.9 } }] } },
  });
  assert.ok('additionalContext' in out, 'ranks fine with no clock (recency just contributes 0)');
});

test('DEFAULT_INJECTION_BUDGET is a positive integer (a real cap, not unbounded)', () => {
  assert.ok(Number.isInteger(DEFAULT_INJECTION_BUDGET) && DEFAULT_INJECTION_BUDGET > 0);
});

// ── DIO-15 FIRE-VOLUME SIGNAL: the enrich handler logs every claimed pass ──────

test('DIO-15 SIGNAL: a CLAIMED enrich pass fires the onEnrich tap with fired/unitCount/size', () => {
  const events = [];
  const handler = createEnrichHandler({
    nowSecondsFn: () => NOW,
    onEnrich: (ev) => events.push(ev),
  });
  const candidates = [
    { id: 'c1', features: { toin_importance: 0.9, note_timestamp: NOW } },
    { id: 'c2', features: { toin_importance: 0.5, note_timestamp: NOW } },
    { id: 'c3', features: { toin_importance: 0.1, note_timestamp: NOW } },
  ];
  const out = handler.route({ toolInput: { _dioscuri: { enrichCandidates: candidates, budget: 2 } } });

  assert.ok('additionalContext' in out, 'the pass injected');
  assert.equal(events.length, 1, 'exactly one fire-volume signal per claimed pass');
  const ev = events[0];
  assert.equal(ev.fired, true, 'fire-volume records that enrich injected');
  assert.equal(ev.unitCount, 3, 'records the candidate set size (over-firing detector)');
  // The signal carries the injected TEXT to the tap; the record builder measures its size only.
  assert.equal(ev.injectedText, out.additionalContext, 'the tap receives the injected text to size it');
});

test('DIO-15 SIGNAL: the fire-volume tap is read-only — a throwing tap never breaks route()', () => {
  const handler = createEnrichHandler({
    nowSecondsFn: () => NOW,
    onEnrich: () => { throw new Error('logging blew up'); },
  });
  let out;
  assert.doesNotThrow(() => {
    out = handler.route({
      toolInput: { _dioscuri: { enrichCandidates: [{ id: 'x', features: { toin_importance: 0.9, note_timestamp: NOW } }] } },
    });
  }, 'a throwing fire-volume tap must not surface');
  assert.ok('additionalContext' in out, 'route() still injects despite the failed signal');
});

test('DIO-15 SIGNAL: the fire-volume tap also fires on the FAIL-SAFE raw path', () => {
  const events = [];
  const handler = createEnrichHandler({
    nowSecondsFn: () => NOW,
    // A similarity resolver that throws forces the ranking path into the fail-safe raw branch.
    similarityResolver: () => { throw new Error('rank path down'); },
    onEnrich: (ev) => events.push(ev),
  });
  const out = handler.route({
    toolInput: {
      _dioscuri: {
        enrichCandidates: [{ id: 'c1', call_path: ['a#1'], summary: 'raw' }],
      },
    },
  });
  assert.ok('additionalContext' in out, 'fail-safe still injects the raw set');
  assert.equal(events.length, 1, 'the fail-safe raw injection is ALSO logged as fire-volume');
  assert.equal(events[0].fired, true);
});
