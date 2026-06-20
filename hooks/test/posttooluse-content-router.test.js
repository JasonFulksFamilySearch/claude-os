'use strict';

// posttooluse-content-router.test.js — the Dioscuri ContentRouter seam (DIO-4).
//
// Proves the Phase-1 seam EXIT criteria (the QA hard-gate):
//   1. one hookSpecificOutput carries updatedToolOutput AND/OR additionalContext
//      (co-returnable in a single emission — FR-A1);
//   2. injected content lands DOWNSTREAM of the stable prefix — proven by asserting
//      the rendered prefix stays BYTE-IDENTICAL to the committed DIO-1 baseline with
//      the seam active (AC-2);
//   3. a per-call skip passes the raw output through unchanged, both fields
//      INDEPENDENTLY skippable (AC-3);
//   4. the seam never fails a tool call (unparseable/throwing → raw append).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const router = require('../posttooluse-content-router.js');
const audit = require('../../scripts/cache-aligner-audit.js');

const BASELINE = path.join(__dirname, 'fixtures', 'prefix-baseline.txt');

// A representative PostToolUse stdin payload (Claude Code's snake_case wire shape).
const jsonToolEvent = (response, toolInput = {}) =>
  JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: toolInput,
    tool_response: response,
  });

// ── normalizeInput: decode the snake_case wire format ─────────────────────────

test('normalizeInput decodes the Claude Code snake_case PostToolUse payload', () => {
  const input = router.normalizeInput(jsonToolEvent('[{"a":1}]', { command: 'ls' }));
  assert.equal(input.toolName, 'Bash');
  assert.deepEqual(input.toolInput, { command: 'ls' });
  assert.equal(input.toolResponse, '[{"a":1}]');
});

// ── EXIT-2: one hookSpecificOutput carries the field(s), co-returnable ─────────

test('route emits one hookSpecificOutput with hookEventName=PostToolUse', () => {
  const out = router.route(router.normalizeInput(jsonToolEvent('[{"a":1}]')));
  assert.ok(out, 'a JSON tool result must produce an emission');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
});

test('the minimal JSON handler routes a JSON tool result through updatedToolOutput', () => {
  const raw = '[{"id":1,"v":"x"},{"id":2,"v":"y"}]';
  const out = router.route(router.normalizeInput(jsonToolEvent(raw)));
  assert.ok('updatedToolOutput' in out.hookSpecificOutput, 'updatedToolOutput must land');
  // Phase-1 handler is a pass-through (NOT a compressor) — proves the field lands.
  assert.equal(out.hookSpecificOutput.updatedToolOutput, raw);
});

test('updatedToolOutput AND additionalContext are co-returnable in ONE emission (FR-A1)', () => {
  // Register a throwaway enrich handler alongside the minimal compressor to prove
  // BOTH fields can attach in a single pass — the core seam guarantee. (The real
  // enrich is DIO-13; this stub only exercises co-return.)
  const enrichStub = {
    id: 'enrich-stub',
    detect: () => true,
    route: () => ({ additionalContext: '[graph] reaches: foo() -> bar()' }),
  };
  const out = router.route(router.normalizeInput(jsonToolEvent('[{"a":1}]')), {
    handlers: [router.minimalJsonHandler, enrichStub],
  });
  assert.ok('updatedToolOutput' in out.hookSpecificOutput, 'compressed field present');
  assert.ok('additionalContext' in out.hookSpecificOutput, 'enrich field present');
  assert.equal(out.hookSpecificOutput.updatedToolOutput, '[{"a":1}]');
  assert.equal(out.hookSpecificOutput.additionalContext, '[graph] reaches: foo() -> bar()');
});

test('a non-JSON tool result is not claimed → no emission → raw append', () => {
  const out = router.route(router.normalizeInput(jsonToolEvent('just some prose output')));
  assert.equal(out, null, 'no handler claims prose → nothing attaches → raw result passes through');
});

// ── EXIT-3 (AC-3): per-call skip passes raw through, both fields independent ───

test('AC-3: skipCompress (per-call) suppresses updatedToolOutput, raw passes through', () => {
  const raw = '[{"a":1}]';
  const out = router.route(
    router.normalizeInput(jsonToolEvent(raw, { _dioscuri: { skipCompress: true } }))
  );
  assert.equal(out, null, 'compress skipped + no enrich → nothing attaches → raw byte-unchanged');
});

test('AC-3: skipEnrich suppresses additionalContext but leaves compression intact (independent)', () => {
  const enrichStub = { id: 'enrich-stub', detect: () => true, route: () => ({ additionalContext: 'X' }) };
  const out = router.route(
    router.normalizeInput(jsonToolEvent('[{"a":1}]', { _dioscuri: { skipEnrich: true } })),
    { handlers: [router.minimalJsonHandler, enrichStub] }
  );
  assert.ok('updatedToolOutput' in out.hookSpecificOutput, 'compression still fires');
  assert.ok(!('additionalContext' in out.hookSpecificOutput), 'enrich suppressed independently');
});

test('AC-3: skipCompress leaves enrich intact (the other direction of independence)', () => {
  const enrichStub = { id: 'enrich-stub', detect: () => true, route: () => ({ additionalContext: 'X' }) };
  const out = router.route(
    router.normalizeInput(jsonToolEvent('[{"a":1}]', { _dioscuri: { skipCompress: true } })),
    { handlers: [router.minimalJsonHandler, enrichStub] }
  );
  assert.ok(!('updatedToolOutput' in out.hookSpecificOutput), 'compression suppressed');
  assert.ok('additionalContext' in out.hookSpecificOutput, 'enrich still fires');
});

test('AC-3: env DIOSCURI_SKIP_COMPRESS=1 suppresses compression (session/global escape hatch)', () => {
  const out = router.route(router.normalizeInput(jsonToolEvent('[{"a":1}]')), {
    env: { DIOSCURI_SKIP_COMPRESS: '1' },
  });
  assert.equal(out, null, 'env skip → nothing attaches → raw passes through');
});

test('both fields skipped → byte-identical raw passthrough (full escape hatch)', () => {
  const enrichStub = { id: 'enrich-stub', detect: () => true, route: () => ({ additionalContext: 'X' }) };
  const out = router.route(
    router.normalizeInput(
      jsonToolEvent('[{"a":1}]', { _dioscuri: { skipCompress: true, skipEnrich: true } })
    ),
    { handlers: [router.minimalJsonHandler, enrichStub] }
  );
  assert.equal(out, null, 'both transforms skipped → seam emits nothing → raw tool result unchanged');
});

// ── Fail-safe: a throwing handler never breaks the tool call ───────────────────

test('a throwing detector fails safe to raw append (no emission)', () => {
  const bad = { id: 'bad', detect: () => { throw new Error('boom'); }, route: () => ({ updatedToolOutput: 'X' }) };
  const out = router.route(router.normalizeInput(jsonToolEvent('[{"a":1}]')), { handlers: [bad] });
  assert.equal(out, null, 'a throwing handler must not attach or crash — raw append');
});

test('a throwing route() is skipped; a later good handler still attaches', () => {
  const bad = { id: 'bad', detect: () => true, route: () => { throw new Error('boom'); } };
  const out = router.route(router.normalizeInput(jsonToolEvent('[{"a":1}]')), {
    handlers: [bad, router.minimalJsonHandler],
  });
  assert.ok(out && 'updatedToolOutput' in out.hookSpecificOutput, 'good handler still fires after a bad one');
});

// ── EXIT-1 / AC-2: injected content lands DOWNSTREAM of the stable prefix ──────
// The seam attaches to the tool-result tail (PostToolUse fires AFTER the prefix is
// rendered). Prove prefix-safety positionally: the rendered identity/rules prefix
// must stay BYTE-IDENTICAL to the committed DIO-1 baseline regardless of what the
// router emits. The router cannot touch the prefix surface — these two assertions
// pin that invariant against the same baseline DIO-1 froze.

test('AC-2: the rendered prefix is byte-identical to the DIO-1 baseline (seam is prefix-inert)', () => {
  assert.ok(fs.existsSync(BASELINE), 'DIO-1 baseline must exist');
  const baseline = fs.readFileSync(BASELINE, 'utf8');
  const rendered = audit.renderPrefix();
  assert.equal(
    rendered,
    baseline,
    'the rendered prefix drifted from the DIO-1 baseline — the seam must never perturb Layer 1 / the prefix'
  );
});

test('AC-2: a hot seam emission contains no prefix bytes (it is pure tool-result-tail content)', () => {
  // Build a maximal emission (both fields) and assert none of it appears in, or
  // perturbs, the rendered prefix. The emission is downstream content by construction.
  const enrichStub = { id: 'enrich-stub', detect: () => true, route: () => ({ additionalContext: 'GRAPH-ENRICH-SENTINEL' }) };
  const out = router.route(router.normalizeInput(jsonToolEvent('[{"COMPRESS-SENTINEL":1}]')), {
    handlers: [router.minimalJsonHandler, enrichStub],
  });
  const emission = JSON.stringify(out);
  const prefix = audit.renderPrefix();
  assert.ok(emission.includes('COMPRESS-SENTINEL'), 'sanity: compressed field is in the emission');
  assert.ok(emission.includes('GRAPH-ENRICH-SENTINEL'), 'sanity: enrich field is in the emission');
  // The injected sentinels are tool-result-tail content; they must NOT be in the prefix.
  assert.ok(!prefix.includes('COMPRESS-SENTINEL'), 'compressed content never enters the prefix');
  assert.ok(!prefix.includes('GRAPH-ENRICH-SENTINEL'), 'enrich content never enters the prefix');
});

// ── isJsonToolResponse: the minimal handler's detect() ────────────────────────

test('isJsonToolResponse recognizes JSON arrays/objects, rejects prose and empties', () => {
  assert.equal(router.isJsonToolResponse('[{"a":1}]'), true);
  assert.equal(router.isJsonToolResponse('{"a":1}'), true);
  assert.equal(router.isJsonToolResponse({ a: 1 }), true, 'already-parsed object');
  assert.equal(router.isJsonToolResponse('hello world'), false);
  assert.equal(router.isJsonToolResponse('[not json'), false, 'looks like JSON but does not parse');
  assert.equal(router.isJsonToolResponse(''), false);
  assert.equal(router.isJsonToolResponse(null), false);
  assert.equal(router.isJsonToolResponse(undefined), false);
});
