'use strict';

// posttooluse-content-router-enrich.test.js — DIO-13 LIVE enrich path through the FROZEN
// DIO-4 seam. The enrich engine's own logic is unit-tested in
// hooks/lib/test/injection-enrich.test.js; THIS file proves the real graph-enrich handler
// plugs into the seam without changing its interface, and that the seam's invariants hold:
//   - the graph-selected over-budget set is six-factor-RANKED and injected as additionalContext
//     END-TO-END (the LIVE wiring — nothing in DIO-13 is dead code);
//   - additionalContext + updatedToolOutput CO-CARRY on one hookSpecificOutput without collision
//     (FR-A1);
//   - the per-call skip (skipEnrich) suppresses it independently (AC-3);
//   - a ranking error degrades to raw/unranked injection, never breaks the hook (fail-safe);
//   - the rendered prefix stays byte-identical to the DIO-1 baseline (AC-2 prefix-inertness).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const router = require('../posttooluse-content-router.js');
const enrichLib = require('../lib/injection-enrich.js');
const audit = require('../../scripts/cache-aligner-audit.js');

const BASELINE = path.join(__dirname, 'fixtures', 'prefix-baseline.txt');
const NOW = 1_700_000_000;

// A PostToolUse stdin event. The graph-selected candidate set + the recency clock are staged
// on toolInput._dioscuri — the per-call control channel the seam established (the same channel
// the skip flags use). This is how DIO-9's graph hands its recall set to the enrich pass.
const event = (response, dioscuri = {}) =>
  JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { _dioscuri: dioscuri },
    tool_response: response,
  });

// A graph-selected recall set that EXCEEDS budget, containing one contract-VIOLATION finding
// among otherwise-clean candidates. The violation must rank UP by construction (FR-E3) and
// survive the budget cut — the canonical "defect facts rank up" end-to-end scenario.
function graphSelectedSet() {
  const clean = [];
  for (let i = 0; i < 10; i++) {
    clean.push({ id: `clean#${i}`, features: { toin_importance: 0.2, semantic_similarity: 0.3, note_timestamp: NOW } });
  }
  const violation = {
    rule_id: 'search-pool-nonempty',
    severity: 'error',
    kind: 'unguarded_path_to_provider',
    symbol_id: 'mcp/src/search.ts#searchMemory',
    call_path: ['tools/search_memory.ts#searchMemory', 'mcp/src/search.ts#searchMemory'],
    summary: 'path reaches provider without the required guard',
    // The finding carries the same recency context as the clean notes (its index time), so the
    // comparison is apples-to-apples: the violation ranks up by its error_indicator, not because
    // the clean notes were handicapped. projectCandidate forwards extraFeatures to projectFinding.
    extraFeatures: { note_timestamp: NOW, semantic_similarity: 0.3 },
  };
  return [...clean, violation];
}

// ── The LIVE end-to-end wiring: graph-selected over-budget set → rank → inject ──────────

test('LIVE: a graph-selected over-budget set is six-factor-ranked + injected as additionalContext', () => {
  const out = router.route(
    router.normalizeInput(event('ok', { enrichCandidates: graphSelectedSet(), nowSeconds: NOW, budget: 3 })),
  );
  assert.ok(out, 'a staged enrich set must produce an emission');
  assert.ok('additionalContext' in out.hookSpecificOutput, 'additionalContext lands (the enrich field)');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith('[graph-enrich]'), 'the injected text is the graph-enrich block');
  // Budget=3 over an 11-candidate set → exactly 3 survive (the rank/truncate is LIVE).
  const bulletLines = ctx.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.equal(bulletLines.length, 3, 'the over-budget set is truncated to budget — ranking is live');
});

test('LIVE: the contract-violation candidate RANKS UP and survives the budget cut (FR-E3)', () => {
  const out = router.route(
    router.normalizeInput(event('ok', { enrichCandidates: graphSelectedSet(), nowSeconds: NOW, budget: 1 })),
  );
  const ctx = out.hookSpecificOutput.additionalContext;
  // Budget=1 → ONLY the top-ranked survives. The violation (error_indicator → 1.0) must be it.
  assert.ok(ctx.includes('searchMemory'), 'the contract violation is the single surviving candidate');
  assert.ok(!ctx.includes('clean#'), 'every clean note is outranked and cut');
  // Its call path is cited — a finding without a call path is not shippable (FR-H4).
  assert.ok(
    ctx.includes('tools/search_memory.ts#searchMemory → mcp/src/search.ts#searchMemory'),
    'the violation cites its concrete call path',
  );
});

test('LIVE: similarity drives ordering through the seam (a high-similarity candidate ranks up)', () => {
  // Stage two otherwise-identical candidates whose precomputed embeddings differ from the query.
  const set = [
    { id: 'far', features: { toin_importance: 0.5 }, embedding: [0, 1, 0] },
    { id: 'near', features: { toin_importance: 0.5 }, embedding: [1, 0, 0] },
  ];
  const out = router.route(
    router.normalizeInput(event('ok', { enrichCandidates: set, nowSeconds: NOW, queryEmbedding: [1, 0, 0] })),
  );
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.indexOf('near') < ctx.indexOf('far'), 'the embedding-near candidate ranks first (similarity is live)');
});

// ── FR-A1: additionalContext + updatedToolOutput co-carry on ONE emission, no collision ─

test('FR-A1: a JSON array tool result is BOTH compressed AND enriched in one pass (co-carry)', () => {
  // A large JSON array → the compressor claims it (updatedToolOutput); a staged enrich set →
  // the enrich claims it too (additionalContext). BOTH land on one hookSpecificOutput.
  const bigArray = [];
  for (let i = 0; i < 300; i++) bigArray.push({ file: `src/ok${i}.ts`, line: i, status: 'ok' });
  const out = router.route(
    router.normalizeInput(event(JSON.stringify(bigArray), { enrichCandidates: graphSelectedSet(), nowSeconds: NOW })),
  );
  assert.ok('updatedToolOutput' in out.hookSpecificOutput, 'compressed field present (Headroom side)');
  assert.ok('additionalContext' in out.hookSpecificOutput, 'enrich field present (Gortex side)');
  // The two fields are DISTINCT keys — they co-carry, never collide.
  assert.notEqual(out.hookSpecificOutput.updatedToolOutput, out.hookSpecificOutput.additionalContext);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('[graph-enrich]'), 'enrich content is the graph block');
});

// ── AC-3: skipEnrich suppresses the enrich independently of compression ─────────────────

test('AC-3: skipEnrich suppresses additionalContext but leaves the staged set otherwise inert', () => {
  const out = router.route(
    router.normalizeInput(event('ok', { enrichCandidates: graphSelectedSet(), nowSeconds: NOW, skipEnrich: true })),
  );
  assert.equal(out, null, 'enrich skipped + no compressible result → nothing attaches → raw append');
});

test('AC-3: env DIOSCURI_SKIP_ENRICH=1 suppresses the enrich (session/global escape hatch)', () => {
  const out = router.route(
    router.normalizeInput(event('ok', { enrichCandidates: graphSelectedSet(), nowSeconds: NOW })),
    { env: { DIOSCURI_SKIP_ENRICH: '1' } },
  );
  assert.equal(out, null, 'env enrich-skip → nothing attaches → raw passes through');
});

test('AC-3: skipEnrich leaves COMPRESSION intact (the two transforms are independent)', () => {
  const bigArray = [];
  for (let i = 0; i < 300; i++) bigArray.push({ file: `src/ok${i}.ts`, line: i, status: 'ok' });
  const out = router.route(
    router.normalizeInput(event(JSON.stringify(bigArray), { enrichCandidates: graphSelectedSet(), nowSeconds: NOW, skipEnrich: true })),
  );
  assert.ok('updatedToolOutput' in out.hookSpecificOutput, 'compression still fires');
  assert.ok(!('additionalContext' in out.hookSpecificOutput), 'enrich suppressed independently');
});

// ── FR-A3: no staged set → enrich does not fire (no token spend on ordinary results) ────

test('FR-A3: a tool result with no staged enrich set does NOT inject (no token spend)', () => {
  const out = router.route(router.normalizeInput(event('ok', {})));
  assert.equal(out, null, 'prose result, no staged set → enrich does not claim → raw append');
});

// ── Fail-safe: a ranking error degrades to raw/unranked injection, never breaks the hook ─

test('FAIL-SAFE: a throwing similarity resolver degrades to raw injection (hook never breaks)', () => {
  // Register a handler whose injected resolver throws on every candidate. The route() must
  // fall back to the raw unranked set, never throw out of the router.
  const throwingHandler = enrichLib.createEnrichHandler({
    nowSecondsFn: () => NOW,
    similarityResolver: () => { throw new Error('embedding lookup failed'); },
  });
  const out = router.route(
    router.normalizeInput(event('ok', { enrichCandidates: graphSelectedSet() })),
    { handlers: [throwingHandler] },
  );
  assert.ok(out, 'fail-safe still produces an emission');
  assert.ok('additionalContext' in out.hookSpecificOutput, 'the raw candidate set is still injected');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('searchMemory'), 'raw injection lists candidates');
});

test('FAIL-SAFE: a throwing enrich route() is skipped by the router → raw append (seam posture)', () => {
  // A handler whose route() throws unconditionally. The router catches it (seam doc §7) and a
  // tool call with nothing else to attach degrades to raw append — the hook never fails.
  const hardThrow = { id: 'enrich-throw', detect: () => true, route: () => { throw new Error('boom'); } };
  const out = router.route(router.normalizeInput(event('ok', { enrichCandidates: graphSelectedSet() })), {
    handlers: [hardThrow],
  });
  assert.equal(out, null, 'a throwing enrich route is skipped → raw append, never a crash');
});

// ── AC-2: the enrich content lands DOWNSTREAM of the stable prefix (prefix-inertness) ───

test('AC-2: the rendered prefix is byte-identical to the DIO-1 baseline with the LIVE enrich active', () => {
  assert.ok(fs.existsSync(BASELINE), 'DIO-1 baseline must exist');
  const baseline = fs.readFileSync(BASELINE, 'utf8');

  // Fire a real enrich through the seam first — its injected content must not perturb the prefix.
  const out = router.route(
    router.normalizeInput(event('ok', { enrichCandidates: graphSelectedSet(), nowSeconds: NOW })),
  );
  assert.ok(out.hookSpecificOutput.additionalContext.includes('[graph-enrich]'), 'sanity: enrich ran');

  const rendered = audit.renderPrefix();
  assert.equal(rendered, baseline, 'the prefix must stay byte-identical to the DIO-1 baseline');
});

test('AC-2: the enrich emission contains no prefix bytes (pure tool-result-tail content)', () => {
  const set = graphSelectedSet();
  // Give the sentinel recency parity with the clean notes so it is not handicapped out of the
  // top-5 — the point of this test is prefix-inertness of injected content, not ranking.
  set[0] = { id: 'GRAPH-ENRICH-SENTINEL', features: { toin_importance: 0.99, note_timestamp: NOW } };
  const out = router.route(router.normalizeInput(event('ok', { enrichCandidates: set, nowSeconds: NOW, budget: 5 })));
  const emission = JSON.stringify(out);
  const prefix = audit.renderPrefix();
  assert.ok(emission.includes('GRAPH-ENRICH-SENTINEL'), 'sanity: enrich content is in the emission');
  assert.ok(!prefix.includes('GRAPH-ENRICH-SENTINEL'), 'enrich content never enters the prefix');
});

// ── DETERMINISM through the seam ────────────────────────────────────────────────────────

test('DETERMINISM: the same staged set twice yields byte-identical additionalContext', () => {
  const ev = event('ok', { enrichCandidates: graphSelectedSet(), nowSeconds: NOW, budget: 4 });
  const a = router.route(router.normalizeInput(ev));
  const b = router.route(router.normalizeInput(ev));
  assert.equal(
    a.hookSpecificOutput.additionalContext,
    b.hookSpecificOutput.additionalContext,
    'identical staged input → byte-identical injected text',
  );
});
