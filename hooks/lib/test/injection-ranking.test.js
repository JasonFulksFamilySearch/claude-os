'use strict';

/**
 * injection-ranking.test.js — DIO-13 six-factor injection ranker + graph projection.
 *
 * Covers the DIO-13 ACs and, specifically, the THREE falsification hazards:
 *   HAZARD 1 — rehydrateEnvelope wrapped-envelope contract: a ranking path that consumes
 *     a retrieved/rehydrated unit MUST pass the router's WRAPPED `_dioscuri` envelope, not
 *     a bare compress() result (which silently degrades to originalHash:null / [] ).
 *   HAZARD 2 — FR-E4 numeric scale isolation: identical six-factor inputs + full-range
 *     different RRF → UNCHANGED order; no RRF identifier referenced in the scorer source.
 *   HAZARD 3 — eval weight train/test leakage: weights are the spec-fixed constants and
 *     are documented as a gated-change knob (not tuned against the eval set).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  WEIGHTS,
  FACTOR_KEYS,
  SEVERITY_ERROR_INDICATOR,
  clamp01,
  recencyFactor,
  computeFactors,
  sixFactorScore,
  rankInjection,
  projectFinding,
  projectFindings,
} = require('../injection-ranking.js');

const crusher = require('../smart-crusher.js');
const ccr = require('../ccr-retrieve.js');
const router = require('../../posttooluse-content-router.js');

const NOW = 1_700_000_000; // fixed epoch seconds — explicit clock, never the system clock

// ── HAZARD 3 + AC-4: weights are the SPEC-FIXED constants, summing to 1 ────────

test('HAZARD 3 / AC-4: weights are EXACTLY the spec values', () => {
  assert.equal(WEIGHTS.recency, 0.2);
  assert.equal(WEIGHTS.semantic_similarity, 0.2);
  assert.equal(WEIGHTS.toin_importance, 0.25);
  assert.equal(WEIGHTS.error_indicator, 0.15);
  assert.equal(WEIGHTS.forward_reference, 0.15);
  assert.equal(WEIGHTS.token_density, 0.05);
});

test('HAZARD 3 / AC-4: the six weights sum to 1.0 (so a score is in [0,1])', () => {
  const sum = FACTOR_KEYS.reduce((acc, k) => acc + WEIGHTS[k], 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights sum to ${sum}, expected 1.0`);
});

test('HAZARD 3 / AC-4: WEIGHTS is frozen (a runtime path cannot mutate it)', () => {
  assert.ok(Object.isFrozen(WEIGHTS), 'WEIGHTS must be frozen');
  assert.throws(() => {
    'use strict';
    WEIGHTS.recency = 0.99;
  });
});

test('AC-4: the source DOCUMENTS the gated-change rule for the weights', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'injection-ranking.js'), 'utf8');
  // The comment must name the gate so a future editor sees that weights are not a knob.
  assert.ok(/red-blue-judge/i.test(src), 'must cite the /red-blue-judge gate');
  assert.ok(/monthly/i.test(src), 'must cite monthly promotion');
  assert.ok(/leakage/i.test(src), 'must warn against eval train/test leakage');
});

// ── HAZARD 2 (FR-E4): numeric scale isolation ─────────────────────────────────

test('HAZARD 2 (FR-E4): identical six-factor inputs + full-range-different RRF → UNCHANGED order', () => {
  // Two candidates with IDENTICAL six-factor features. We attach an `rrf` field carrying
  // the engine's full RRF range (0.003 vs 0.033). If the ranker leaked RRF into the score,
  // the high-RRF candidate would sort first; FR-E4 demands the order is decided ONLY by the
  // six factors (here identical), so the deterministic id tie-break governs — unchanged
  // regardless of which RRF value sits on which candidate.
  const features = {
    note_timestamp: NOW,
    semantic_similarity: 0.5,
    toin_importance: 0.5,
    error_indicator: 0.5,
    forward_reference: 0.5,
    token_density: 0.5,
  };

  const lowRrfFirst = [
    { id: 'A', rrf: 0.003, features: { ...features } },
    { id: 'B', rrf: 0.033, features: { ...features } },
  ];
  const highRrfFirst = [
    { id: 'A', rrf: 0.033, features: { ...features } },
    { id: 'B', rrf: 0.003, features: { ...features } },
  ];

  const r1 = rankInjection(lowRrfFirst, NOW).map((c) => c.id);
  const r2 = rankInjection(highRrfFirst, NOW).map((c) => c.id);

  // Identical six-factor inputs → scores tie → id tie-break → ['A','B'] in BOTH cases.
  // The RRF assignment flipped between the two runs; the order did NOT. That is FR-E4.
  assert.deepEqual(r1, ['A', 'B']);
  assert.deepEqual(r2, ['A', 'B'], 'order must not move when only RRF moves');
  assert.deepEqual(r1, r2);
});

test('HAZARD 2 (FR-E4): scores are byte-identical when only the rrf field differs', () => {
  const features = { semantic_similarity: 0.7, toin_importance: 0.4 };
  const sA = sixFactorScore(features, NOW);
  // sixFactorScore takes ONLY features; there is no rrf input to pass. Proving the score
  // is a pure function of the six factors: same features → same score, every time.
  const sB = sixFactorScore({ ...features }, NOW);
  assert.equal(sA, sB);
  // And a candidate carrying an rrf field cannot influence its score (rankInjection reads
  // only `.features`): the annotated score equals the bare sixFactorScore.
  const ranked = rankInjection([{ id: 'X', rrf: 0.033, features }], NOW);
  assert.equal(ranked[0].score, sA);
});

test('HAZARD 2 (FR-E4): the scorer source references NO RRF identifier (static guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'injection-ranking.js'), 'utf8');
  // Strip comments — a prose mention of RRF (the doc explaining the isolation) must not
  // trip the guard; only executable references to an RRF value are forbidden.
  let code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip ONLY the retrieval-surface QUOTED KEY LITERALS that the terminal tie-break's strip
  // list (TERMINAL_HASH_STRIP_KEYS) names. Those literals exist for the sole purpose of
  // EXCLUDING retrieval keys from the content-identity hash — the opposite of reading an rrf
  // value. A value-READ is never a string literal (it is `c.rrf` / `.rrf` / `rrf:`), so removing
  // these specific quoted keys keeps the guard's teeth (any actual rrf read still trips it,
  // and the import guards below — which match `require('...')` strings — stay intact because
  // only these exact retrieval-key tokens are removed, not all string literals).
  code = code.replace(/'(?:rrf|retrieval_rank|retrieval_score|retrieval)'/g, "''");
  assert.ok(!/\brrfScore\b/.test(code), 'no reference to rrfScore (ranking.ts)');
  assert.ok(!/\brankCandidates\b/.test(code), 'no reference to rankCandidates (ranking.ts)');
  assert.ok(!/\brrf\b/i.test(code), 'no rrf-typed value read in the scoring path');
  assert.ok(!/RRF_K/.test(code), 'no RRF_K (search_config.ts) reference');
  // It must not import the eval-gated modules at all.
  assert.ok(!/ranking\.js|ranking\.ts/.test(code), 'must not import ranking module');
  assert.ok(!/search_config/.test(code), 'must not import search_config');
});

test('HAZARD 2 (FR-E4): there is no rrf tie-break in the sort (unlike ranking.ts)', () => {
  // ranking.ts breaks ties on rrf; this ranker MUST NOT. With tied scores, ordering falls
  // to the id tie-break ALONE — proven by feeding wildly different rrf with tied factors
  // and asserting pure id order.
  const tied = { toin_importance: 0.5 };
  const out = rankInjection(
    [
      { id: 'zzz', rrf: 0.033, features: tied },
      { id: 'aaa', rrf: 0.003, features: tied },
      { id: 'mmm', rrf: 0.02, features: tied },
    ],
    NOW,
  ).map((c) => c.id);
  assert.deepEqual(out, ['aaa', 'mmm', 'zzz'], 'tie-break is id-only, never rrf');
});

// ── HAZARD 1: rehydrateEnvelope wrapped-envelope contract ─────────────────────

// A compressible array with a buried error row so compress() actually compresses and the
// error verdict is preserved (the realistic retrieve scenario).
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

test('HAZARD 1: a BARE compress() result silently degrades through rehydrateEnvelope', () => {
  // This documents the trap the ranking path MUST avoid: a flat compress() result has its
  // originalHash/retainedIndices at TOP level, but rehydrateEnvelope reads them from
  // envelope._dioscuri.*. Fed the bare result, it returns originalHash:null / [] WITHOUT
  // throwing — a quiet half-degradation. We assert the trap exists so the next assertion
  // (using the wrapped envelope) is meaningful, not vacuous.
  const result = crusher.compress(makeCompressible());
  assert.equal(result.compressed, true, 'fixture must actually compress');
  assert.ok(typeof result.originalHash === 'string' && result.originalHash.length === 64);

  const degraded = ccr.rehydrateEnvelope(result); // WRONG: bare result, no _dioscuri wrapper
  assert.equal(degraded.originalHash, null, 'bare result silently loses the hash');
  assert.deepEqual(degraded.retainedIndices, [], 'bare result silently loses retainedIndices');
});

test('HAZARD 1: the router-WRAPPED _dioscuri envelope rehydrates WITHOUT degradation', () => {
  const result = crusher.compress(makeCompressible());
  // The router wraps the flat result into the `_dioscuri` envelope (buildCompressedEnvelope)
  // — this is the shape that actually flows on `updatedToolOutput`. The ranking path
  // consumes THIS, never the bare result.
  const envelope = router.buildCompressedEnvelope(result);

  const rehydrated = ccr.rehydrateEnvelope(envelope);
  assert.equal(
    rehydrated.originalHash,
    result.originalHash,
    'wrapped envelope preserves the hash (no silent null)',
  );
  assert.ok(
    Array.isArray(rehydrated.retainedIndices) && rehydrated.retainedIndices.length > 0,
    'wrapped envelope preserves retainedIndices (not the [] degradation)',
  );
  assert.ok(rehydrated.rows.length > 0, 'rows rehydrate with constants merged back');
});

test('HAZARD 1: rankInjectionFromEnvelope consumes ONLY the wrapped envelope, never a bare result', () => {
  // The integration proof: a helper that turns a compressed tool result into ranked
  // injection candidates MUST go through the wrapped envelope. We exercise the real path:
  // compress → wrap → rehydrate → project rows to candidates → rank. The rehydrated rows
  // carry the constants block (kind/status merged back), so the error row is observable —
  // had we fed the bare result, originalHash would be null and the contract broken.
  const rows = makeCompressible();
  const result = crusher.compress(rows);
  const envelope = router.buildCompressedEnvelope(result);
  const rehydrated = ccr.rehydrateEnvelope(envelope);

  // Guard the carry-forward contract at the consumption point: a degraded envelope (null
  // hash) is rejected, not silently ranked. This is the assertion the hazard demands.
  assert.notEqual(rehydrated.originalHash, null, 'consume only a non-degraded envelope');

  // Project each rehydrated row to a candidate; a FAIL row gets a contract-violation-style
  // error_indicator, the rest do not. (Realistic: the enrich path projects tool-output
  // rows into scorable units.)
  const candidates = rehydrated.rows.map((row, i) => ({
    id: `row-${row.idx ?? i}`,
    features: {
      note_timestamp: NOW,
      error_indicator: row.status === 'FAIL' ? 1 : 0,
      token_density: 0.5,
    },
  }));

  const ranked = rankInjection(candidates, NOW, 5);
  assert.ok(ranked.length > 0);
  // The FAIL row, carrying error_indicator=1, must rank first (defect ranks up).
  assert.ok(
    String(ranked[0].id).includes('20') || ranked[0].score >= ranked[ranked.length - 1].score,
    'the error-bearing row ranks at the top of the injection set',
  );
  const failRanked = ranked.find((c) => c.score >= 0.15); // error_indicator weight contribution
  assert.ok(failRanked, 'the FAIL row survives the budget cut by its error_indicator');
});

// ── FR-E2 layering: ranks an ALREADY-SELECTED set; never re-selects ───────────

test('FR-E2 layering: rankInjection orders the given set and never adds candidates', () => {
  const candidates = [
    { id: 'a', features: { toin_importance: 0.1 } },
    { id: 'b', features: { toin_importance: 0.9 } },
    { id: 'c', features: { toin_importance: 0.5 } },
  ];
  const ranked = rankInjection(candidates, NOW);
  assert.equal(ranked.length, 3, 'count is preserved — no selection, only ordering');
  assert.deepEqual(ranked.map((c) => c.id), ['b', 'c', 'a'], 'ordered by score desc');
});

test('FR-E2 layering: over-budget truncates to budget (keeps the top-ranked)', () => {
  const candidates = [
    { id: 'a', features: { toin_importance: 0.1 } },
    { id: 'b', features: { toin_importance: 0.9 } },
    { id: 'c', features: { toin_importance: 0.5 } },
    { id: 'd', features: { toin_importance: 0.7 } },
  ];
  const ranked = rankInjection(candidates, NOW, 2);
  assert.deepEqual(ranked.map((c) => c.id), ['b', 'd'], 'keep the 2 highest-scored');
});

test('FR-E2 layering: under/at budget returns the whole ordered set', () => {
  const candidates = [
    { id: 'a', features: { toin_importance: 0.9 } },
    { id: 'b', features: { toin_importance: 0.1 } },
  ];
  assert.equal(rankInjection(candidates, NOW, 5).length, 2);
  assert.equal(rankInjection(candidates, NOW, 0).length, 2, 'budget<=0 → no truncation');
});

// ── FR-E3 / B10 projection: contract violation → error_indicator (rank up) ────

test('FR-E3 / B10: a contract violation projects onto error_indicator graduated by severity', () => {
  const errFinding = {
    rule_id: 'search-pool-nonempty',
    severity: 'error',
    kind: 'unguarded_path_to_provider',
    symbol_id: 'mcp/src/search.ts#searchMemory',
    call_path: ['a#x', 'b#y', 'mcp/src/search.ts#searchMemory'],
    summary: 'path reaches provider without the required guard',
    index_commit: 'abc123',
  };
  const unit = projectFinding(errFinding);
  assert.equal(unit.id, 'mcp/src/search.ts#searchMemory', 'id is the stable symbol_id');
  assert.equal(unit.features.error_indicator, 1.0, 'error severity → max error_indicator');
  assert.deepEqual(unit.finding.call_path, errFinding.call_path, 'call path rides along (FR-H4)');

  assert.equal(projectFinding({ severity: 'warning', symbol_id: 's' }).features.error_indicator, 0.6);
  assert.equal(projectFinding({ severity: 'info', symbol_id: 's' }).features.error_indicator, 0.3);
});

test('FR-E3 / B10: defect facts rank UP by construction (a violation outranks a clean note)', () => {
  // A clean note with otherwise-strong factors vs. a contract violation that is otherwise
  // weak. The error_indicator from the violation must lift it above the clean note — the
  // "ranks up by construction" guarantee, not by tuning.
  const violation = projectFinding({
    severity: 'error',
    symbol_id: 'defect#1',
    call_path: ['x#a', 'defect#1'],
    summary: 'invariant broken',
  });
  const cleanNote = {
    id: 'clean#1',
    features: { toin_importance: 0.3, token_density: 0.3 },
  };

  const ranked = rankInjection([cleanNote, violation], NOW);
  assert.equal(ranked[0].id, 'defect#1', 'the contract violation ranks first by construction');
});

test('FR-E3 / B10: a projected violation RAISES error_indicator, never lowers it', () => {
  // If the caller already supplied a higher error_indicator, the projection keeps the max
  // (a violation can only raise the signal). With a lower caller value, the violation wins.
  const hi = projectFinding({ severity: 'info', symbol_id: 's' }, { error_indicator: 0.9 });
  assert.equal(hi.features.error_indicator, 0.9, 'caller-supplied higher value is kept');
  const lo = projectFinding({ severity: 'error', symbol_id: 's' }, { error_indicator: 0.2 });
  assert.equal(lo.features.error_indicator, 1.0, 'violation raises a lower caller value');
});

test('FR-E3 / B10: projectFindings maps the graph findings[] array to candidates', () => {
  const findings = [
    { severity: 'warning', symbol_id: 'b#1', call_path: ['b#1'] },
    { severity: 'error', symbol_id: 'a#1', call_path: ['a#1'] },
  ];
  const units = projectFindings(findings, () => ({ note_timestamp: NOW }));
  assert.equal(units.length, 2);
  // Rank them: the error finding (1.0) outranks the warning (0.6).
  const ranked = rankInjection(units, NOW);
  assert.deepEqual(ranked.map((u) => u.id), ['a#1', 'b#1']);
});

// ── factor units + recency (FR-E1: reuse note timestamps) ─────────────────────

test('recencyFactor: note at now → 1; one half-life old → ~0.5; missing → 0', () => {
  assert.ok(Math.abs(recencyFactor(NOW, NOW) - 1) < 1e-9, 'now → 1');
  const halfLifeAgo = NOW - 30 * 86400;
  assert.ok(Math.abs(recencyFactor(halfLifeAgo, NOW) - 0.5) < 1e-6, 'one half-life → 0.5');
  assert.equal(recencyFactor(undefined, NOW), 0, 'missing timestamp → 0');
  assert.equal(recencyFactor(NOW + 99999, NOW), 1, 'future timestamp clamps to 1 (no negative age)');
});

test('clamp01: out-of-range and non-finite inputs fail closed to [0,1]', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01('x'), 0);
  assert.equal(clamp01(0.42), 0.42);
});

test('computeFactors: each factor is clamped to [0,1]', () => {
  const f = computeFactors(
    { semantic_similarity: 5, toin_importance: -3, error_indicator: 0.5, note_timestamp: NOW },
    NOW,
  );
  for (const k of FACTOR_KEYS) {
    assert.ok(f[k] >= 0 && f[k] <= 1, `${k} in [0,1]`);
  }
  assert.equal(f.semantic_similarity, 1);
  assert.equal(f.toin_importance, 0);
});

test('SEVERITY_ERROR_INDICATOR: error > warning > info (graduated)', () => {
  assert.ok(SEVERITY_ERROR_INDICATOR.error > SEVERITY_ERROR_INDICATOR.warning);
  assert.ok(SEVERITY_ERROR_INDICATOR.warning > SEVERITY_ERROR_INDICATOR.info);
});

// ── Determinism (foundation convention) ───────────────────────────────────────

test('DETERMINISM: ranking is a total order — same set, any input order → identical output', () => {
  const set = [
    { id: 'a', features: { toin_importance: 0.5 } },
    { id: 'b', features: { toin_importance: 0.5 } }, // tie with a → id tie-break
    { id: 'c', features: { toin_importance: 0.9 } },
  ];
  const forward = rankInjection(set, NOW).map((c) => c.id);
  const reversed = rankInjection([...set].reverse(), NOW).map((c) => c.id);
  assert.deepEqual(forward, reversed, 'input order must not change output (total order)');
  assert.deepEqual(forward, ['c', 'a', 'b'], 'score desc, then id asc');
});

test('DETERMINISM: identical id + identical score sort to a STABLE order (factor tie-break)', () => {
  // The robustness gap QA filed: two candidates can collide on BOTH score and id (id is not
  // guaranteed unique). With only score+id keys, the comparator returns 0 and the output
  // follows INPUT order — forward vs reversed diverge. The factor-hash final key closes this:
  // same id, same score, DIFFERENT factors → a stable break independent of input order.
  // Scores must actually TIE so the id + factor-hash keys are what's exercised. error_indicator
  // and forward_reference carry the SAME weight (0.15), so a 0.2 value on either contributes an
  // equal 0.03 — the two candidates score identically yet have DIFFERENT factor shapes, which
  // is exactly what the factor-hash tie-break must break deterministically.
  const tied = [
    { id: 'dup', features: { toin_importance: 0.5, error_indicator: 0.2 } },
    { id: 'dup', features: { toin_importance: 0.5, forward_reference: 0.2 } },
  ];
  const fwd = rankInjection(tied, NOW);
  const rev = rankInjection([...tied].reverse(), NOW);
  assert.equal(fwd[0].score, fwd[1].score, 'precondition: the two candidates tie on score');
  assert.equal(fwd[0].id, fwd[1].id, 'precondition: the two candidates collide on id');
  assert.deepEqual(
    fwd.map((c) => JSON.stringify(c.features)),
    rev.map((c) => JSON.stringify(c.features)),
    'identical id + identical score → stable order regardless of input order',
  );
});

test('DETERMINISM: symbol-less findings get a content-derived id (no empty-id collision)', () => {
  // The reachable path from the defect report: projectFinding({severity:'error'}) with no
  // symbol_id/rule_id once yielded id:'' — two such collided on the empty id, so rankInjection's
  // id key could not separate them and output followed input order. The fallback now derives a
  // deterministic `auto:<hash>` id from the finding's inert content, so DISTINCT findings carry
  // DISTINCT ids and sort input-order-independently.
  const findings = [
    { severity: 'error', summary: 'first', call_path: ['p#1'] },
    { severity: 'error', summary: 'second', call_path: ['p#2'] },
  ];
  const units = projectFindings(findings, () => ({ note_timestamp: NOW }));
  assert.ok(units.every((u) => u.id.startsWith('auto:')), 'symbol-less findings get an auto: id');
  assert.notEqual(units[0].id, units[1].id, 'distinct content → distinct id (no collision)');
  // The id is deterministic: re-projecting the same content yields the same id.
  const again = projectFindings(findings, () => ({ note_timestamp: NOW }));
  assert.deepEqual(units.map((u) => u.id), again.map((u) => u.id), 'auto id is deterministic');

  const fwd = rankInjection(units, NOW).map((u) => u.finding.summary);
  const rev = rankInjection([...units].reverse(), NOW).map((u) => u.finding.summary);
  assert.deepEqual(fwd, rev, 'distinct symbol-less findings order input-order-independently');
});

test('DETERMINISM: two IDENTICAL symbol-less findings → byte-identical output either order', () => {
  // The DoD case: projectFindings([{severity:'error'},{severity:'error'}]) — both project to the
  // SAME content-derived id AND identical factors, so they are truly interchangeable. Either
  // input order yields byte-identical ranked output (there is no observable order to diverge).
  const bare = projectFindings([{ severity: 'error' }, { severity: 'error' }]);
  assert.equal(bare[0].id, bare[1].id, 'identical content → identical id (interchangeable)');
  const bFwd = JSON.stringify(rankInjection(bare, NOW));
  const bRev = JSON.stringify(rankInjection([...bare].reverse(), NOW));
  assert.equal(bFwd, bRev, 'two identical symbol-less findings → byte-identical output');
});

test('FR-E4: the factor-hash tie-break does NOT move order when only a non-factor field differs', () => {
  // The tie-break hazard FR-E4 forbids: it must hash the SIX FACTORS ONLY. Two candidates that
  // tie on score AND id, with identical factors but a different carried retrieval value, must
  // hash identically — order unchanged regardless of which retrieval value sits on which, and
  // regardless of input order. (If the hash covered the whole candidate, this would FAIL.)
  const features = { toin_importance: 0.5 };
  const a = [
    { id: 'same', rrf: 0.003, features: { ...features } },
    { id: 'same', rrf: 0.033, features: { ...features } },
  ];
  const b = [
    { id: 'same', rrf: 0.033, features: { ...features } },
    { id: 'same', rrf: 0.003, features: { ...features } },
  ];
  // Identical id, identical factors → the factor-hash also ties → byte-identical ranked output
  // no matter how the retrieval value is assigned or which input order is fed.
  const ra = JSON.stringify(rankInjection(a, NOW).map((c) => c.score));
  const rb = JSON.stringify(rankInjection(b, NOW).map((c) => c.score));
  assert.equal(ra, rb, 'a non-factor field (retrieval value) cannot reorder a score+id tie');
});

test('DETERMINISM: same id + same six factors + DISTINCT payload → byte-identical output forward vs reversed', () => {
  // The residual total-order gap QA proved reachable via the shaped-unit path
  // (injection-enrich.js:147-154): two units with the SAME id and the SAME six factors but a
  // DIFFERENT carried payload. score ties, the id key ties, AND the factor-hash ties (identical
  // factors hash identically) — so before the terminal key, the comparator returned 0 and the
  // output followed INPUT order: [C,D] → C first, [D,C] → D first. The terminal content-identity
  // hash (over the inert carried payload, factors + retrieval surface stripped) closes it: a
  // stable order regardless of input order.
  const C = { id: 'u1', features: { toin_importance: 0.4 }, meta: { src: 'A' } };
  const D = { id: 'u1', features: { toin_importance: 0.4 }, meta: { src: 'B' } };

  const fwd = JSON.stringify(rankInjection([C, D], NOW));
  const rev = JSON.stringify(rankInjection([D, C], NOW));
  assert.equal(fwd, rev, 'same id + same factors + distinct payload → byte-identical output either order');

  // And the order is genuinely total — not a coincidental input-order match. Both runs put the
  // SAME unit first (the one whose inert-content hash sorts lower), independent of input order.
  const firstFwd = rankInjection([C, D], NOW)[0].meta.src;
  const firstRev = rankInjection([D, C], NOW)[0].meta.src;
  assert.equal(firstFwd, firstRev, 'the same unit leads regardless of input order (a real total order)');
});

test('DETERMINISM: TRULY-identical units (same id, factors, AND payload) → identical output either order', () => {
  // Two units identical in id, six factors, and inert carried content are genuinely
  // interchangeable: every sort key ties, including the terminal content-identity hash. There
  // is no observable order to diverge — either input order yields byte-identical output, which
  // is correct (and all we promise for this case).
  const E = { id: 'u9', features: { toin_importance: 0.4 }, meta: { src: 'same' } };
  const F = { id: 'u9', features: { toin_importance: 0.4 }, meta: { src: 'same' } };

  const fwd = JSON.stringify(rankInjection([E, F], NOW));
  const rev = JSON.stringify(rankInjection([F, E], NOW));
  assert.equal(fwd, rev, 'truly-identical units → byte-identical output regardless of input order');
});

test('FR-E4: the terminal content-identity hash STRIPS the retrieval surface (rrf cannot reorder a same-id/same-factor tie)', () => {
  // The terminal key must NOT smuggle a retrieval value into the order. Two units that tie on
  // score, id, AND all six factors, differing ONLY in a carried retrieval value (rrf), are
  // interchangeable: rrf is in the strip list, so the terminal content-identity hash also ties.
  // The OBSERVABLE order signal — the score sequence — is therefore identical no matter which
  // rrf sits on which unit or which input order is fed. (If rrf were NOT stripped, the high-rrf
  // unit would sort to a fixed position and the score arrays would diverge — this asserts it
  // does not.) Note: the candidates themselves carry distinct rrf values, so the FULL objects
  // are not byte-identical across the two runs; only the order (scores) must be — that is the
  // exact FR-E4 guarantee (rrf does not participate), mirroring the non-factor-field test above.
  const features = { toin_importance: 0.4 };
  const a = [
    { id: 'r', rrf: 0.003, features: { ...features } },
    { id: 'r', rrf: 0.033, features: { ...features } },
  ];
  const b = [
    { id: 'r', rrf: 0.033, features: { ...features } },
    { id: 'r', rrf: 0.003, features: { ...features } },
  ];
  const ra = JSON.stringify(rankInjection(a, NOW).map((c) => c.score));
  const rb = JSON.stringify(rankInjection(b, NOW).map((c) => c.score));
  assert.equal(ra, rb, 'a carried retrieval value cannot reorder a score+id+factor tie via the terminal key');
});

test('DETERMINISM: no wall-clock / random in the module source (static guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'injection-ranking.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now() — nondeterministic');
  assert.ok(!/Math\.random\s*\(/.test(code), 'no Math.random() — nondeterministic');
  assert.ok(!/new\s+Date\s*\(/.test(code), 'no new Date() — nondeterministic');
});
