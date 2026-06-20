'use strict';

// posttooluse-content-router-compression.test.js — DIO-7 integration through the
// FROZEN DIO-4 seam. The engine's own mechanism is unit-tested in
// hooks/lib/test/smart-crusher.test.js; THIS file proves the real compressor plugs
// into the seam without changing its interface, and that the seam's invariants
// (AC-3 skip, malformed passthrough, AC-2 prefix-inertness) still hold with REAL
// compressed content flowing through `updatedToolOutput`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const router = require('../posttooluse-content-router.js');
const audit = require('../../scripts/cache-aligner-audit.js');

const BASELINE = path.join(__dirname, 'fixtures', 'prefix-baseline.txt');

const event = (response, toolInput = {}) =>
  JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: toolInput,
    tool_response: response,
  });

// A large lint-style result with one failing row buried in the middle — the canonical
// "naive truncation drops the error" fixture, now exercised end-to-end through the seam.
function lintResultWithBuriedError(n = 300, errorAt = 150) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (i === errorAt) {
      rows.push({ file: 'src/broken.ts', line: 42, rule: 'no-undef', status: 'error', message: 'SENTINEL_ERROR x is not defined' });
    } else {
      rows.push({ file: `src/ok${i}.ts`, line: i, rule: 'no-unused', status: 'ok' });
    }
  }
  return rows;
}

// ── The real compressor plugs into the frozen seam (same contract) ─────────────

test('a large JSON array routes through updatedToolOutput as a COMPRESSED envelope', () => {
  const raw = JSON.stringify(lintResultWithBuriedError());
  const out = router.route(router.normalizeInput(event(raw)));
  assert.ok(out, 'a large JSON array must produce an emission');
  assert.ok('updatedToolOutput' in out.hookSpecificOutput, 'updatedToolOutput lands (frozen contract)');

  const env = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  assert.equal(env._dioscuri.compressed, true, 'the envelope marks itself compressed');
  // It is genuinely smaller than the raw input — real compression, not pass-through.
  assert.ok(
    out.hookSpecificOutput.updatedToolOutput.length < raw.length,
    'compressed output is smaller than the raw input'
  );
});

test('the buried error row SURVIVES compression end-to-end through the seam (preserve-first)', () => {
  const raw = JSON.stringify(lintResultWithBuriedError(300, 150));
  const out = router.route(router.normalizeInput(event(raw)));
  const compressed = out.hookSpecificOutput.updatedToolOutput;

  // The error content is present in the compressed envelope...
  assert.ok(compressed.includes('SENTINEL_ERROR'), 'the error row content survives compression');

  // ...and its per-row verdict is surfaced as 'error' at the original index (AC-5b).
  const env = JSON.parse(compressed);
  assert.equal(env._dioscuri.verdicts[150], 'error', 'the error verdict is observable on the output');
  assert.ok(env._dioscuri.retainedIndices.includes(150), 'the error row index is retained');
});

test('AC-1: the compressed envelope carries the reversibility marker + original hash', () => {
  const raw = JSON.stringify(lintResultWithBuriedError());
  const out = router.route(router.normalizeInput(event(raw)));
  const env = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  assert.match(env._dioscuri.originalHash, /^[0-9a-f]{64}$/, 'sha256 of the canonical original');
  assert.match(
    env._dioscuri.marker,
    /^\[\d+ items compressed to \d+\. Retrieve more: hash=[0-9a-f]{64}\]$/,
    'a CCR-style retrieval marker carrying the recover hash'
  );
});

// ── DETERMINISM through the seam (AC-5c.1) ─────────────────────────────────────

test('DETERMINISM: the same input twice yields BYTE-IDENTICAL updatedToolOutput', () => {
  const raw = JSON.stringify(lintResultWithBuriedError(400, 200));
  const a = router.route(router.normalizeInput(event(raw)));
  const b = router.route(router.normalizeInput(event(raw)));
  assert.equal(
    a.hookSpecificOutput.updatedToolOutput,
    b.hookSpecificOutput.updatedToolOutput,
    'identical input → byte-identical compressed output (the eval-gate precondition)'
  );
});

// ── AC-3 skip still works WITH the real compressor ─────────────────────────────

test('AC-3: skipCompress passes the raw result through (no compression) — still works', () => {
  const raw = JSON.stringify(lintResultWithBuriedError());
  const out = router.route(
    router.normalizeInput(event(raw, { _dioscuri: { skipCompress: true } }))
  );
  assert.equal(out, null, 'compress skipped → nothing attaches → raw byte-unchanged');
});

test('AC-3: env DIOSCURI_SKIP_COMPRESS=1 suppresses the real compressor too', () => {
  const raw = JSON.stringify(lintResultWithBuriedError());
  const out = router.route(router.normalizeInput(event(raw)), { env: { DIOSCURI_SKIP_COMPRESS: '1' } });
  assert.equal(out, null, 'env skip → raw passes through');
});

// ── Malformed / non-compressible input degrades to raw passthrough (no crash) ──

test('malformed JSON degrades to raw append (never crashes the tool call)', () => {
  // Looks like a container but does not parse → not claimed → no emission → raw append.
  const out = router.route(router.normalizeInput(event('[not valid json')));
  assert.equal(out, null, 'unparseable JSON is not claimed → raw append');
});

test('a JSON OBJECT (not an array) passes through unchanged — SmartCrusher only compresses arrays', () => {
  const raw = '{"summary":"one object, not an array","count":3}';
  const out = router.route(router.normalizeInput(event(raw)));
  assert.ok(out, 'a JSON object is still claimed by detect()');
  assert.equal(
    out.hookSpecificOutput.updatedToolOutput,
    raw,
    'a non-array JSON value passes through byte-unchanged (degrade, never crash)'
  );
});

test('a small array (under the floor) passes through unchanged — no overhead where no benefit', () => {
  const raw = '[{"a":1},{"a":2},{"a":3}]'; // under MIN_ROWS_TO_COMPRESS
  const out = router.route(router.normalizeInput(event(raw)));
  assert.equal(
    out.hookSpecificOutput.updatedToolOutput,
    raw,
    'a sub-floor array passes through byte-unchanged'
  );
});

test('an already-parsed array tool_response (object, not string) compresses too', () => {
  // Claude Code may deliver tool_response already structured; the handler must handle both.
  const arr = lintResultWithBuriedError(200, 100);
  const out = router.route({ toolName: 'X', toolInput: {}, toolResponse: arr });
  const env = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  assert.equal(env._dioscuri.compressed, true, 'a structured array response compresses');
  assert.ok(env._dioscuri.retainedIndices.includes(100), 'the buried error row is retained');
});

// ── AC-2: prefix stays byte-identical to the DIO-1 baseline WITH real compressed content
// (the carry-forward awareness item — re-run the DIO-1 baseline check with the real
// compressor active, not just the pass-through). PostToolUse fires after the prefix
// renders, so the compressed content lands in the tool-result tail — the prefix is inert.

test('AC-2: the rendered prefix is byte-identical to the DIO-1 baseline with the REAL compressor active', () => {
  assert.ok(fs.existsSync(BASELINE), 'DIO-1 baseline must exist');
  const baseline = fs.readFileSync(BASELINE, 'utf8');

  // Fire a real, heavy compression through the seam first — its output must not be
  // able to perturb the prefix (it cannot; the seam never writes Layer 1).
  const raw = JSON.stringify(lintResultWithBuriedError(500, 250));
  const out = router.route(router.normalizeInput(event(raw)));
  assert.ok(out.hookSpecificOutput.updatedToolOutput.includes('SENTINEL_ERROR'), 'sanity: real compression ran');

  const rendered = audit.renderPrefix();
  assert.equal(rendered, baseline, 'the prefix must stay byte-identical to the DIO-1 baseline');
});

test('AC-2: the compressed emission contains no prefix bytes (pure tool-result-tail content)', () => {
  const rows = lintResultWithBuriedError(300, 150);
  rows[0] = { file: 'COMPRESS-SENTINEL.ts', line: 1, rule: 'x', status: 'ok' };
  const out = router.route(router.normalizeInput(event(JSON.stringify(rows))));
  const emission = JSON.stringify(out);
  const prefix = audit.renderPrefix();
  assert.ok(emission.includes('SENTINEL_ERROR'), 'sanity: compressed content is in the emission');
  assert.ok(!prefix.includes('SENTINEL_ERROR'), 'compressed content never enters the prefix');
  assert.ok(!prefix.includes('COMPRESS-SENTINEL'), 'no compressed row content leaks into the prefix');
});
