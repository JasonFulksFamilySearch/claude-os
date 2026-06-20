'use strict';

// smart-crusher.test.js — the SmartCrusher JSON-array compressor (DIO-7 / FR-B1).
//
// Proves the DIO-7 EXIT criteria at the engine layer:
//   (a) full SmartCrusher: Kneedle subset-selection, 30/15/55 split, constant-field
//       factoring, errors-preserved-unconditionally;
//   (b) the per-row classification verdict is surfaced (AC-5b);
//   (c) DETERMINISM — same input twice → byte-identical output (AC-5c.1, load-bearing);
//   (f) AC-1 reversibility surface — the original hash + retained indices are carried.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crusher = require('../smart-crusher.js');

// A large droppable array: uniform records with no errors/anomalies/boundaries, so
// the compressor is free to drop rows. Used to prove the split + Kneedle + factoring.
function uniformRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ kind: 'lint', file: `src/file${i}.ts`, line: i + 1, rule: 'no-unused', ok: true });
  }
  return rows;
}

// ── (c) DETERMINISM — the load-bearing precondition (AC-5c.1) ──────────────────

test('DETERMINISM: compress() is byte-identical across two runs for identical input', () => {
  const input = uniformRows(120);
  const a = JSON.stringify(crusher.compress(input));
  const b = JSON.stringify(crusher.compress(input));
  assert.equal(a, b, 'two runs over identical input MUST be byte-identical');
});

test('DETERMINISM: output is invariant to input key ORDER (canonical serialization)', () => {
  // Same semantic rows, keys written in a different order → identical compression.
  const rowsA = [];
  const rowsB = [];
  for (let i = 0; i < 60; i++) {
    rowsA.push({ a: i, b: `v${i}`, c: i % 3, kind: 'x' });
    rowsB.push({ kind: 'x', c: i % 3, b: `v${i}`, a: i });
  }
  const a = JSON.stringify(crusher.compress(rowsA));
  const b = JSON.stringify(crusher.compress(rowsB));
  assert.equal(a, b, 'key order must not change the compressed output (determinism spine)');
});

test('DETERMINISM: no wall-clock / random in the module source (static guard)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'smart-crusher.js'), 'utf8');
  // Strip comments so a mention in prose does not trip the guard.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now() — nondeterministic');
  assert.ok(!/Math\.random\s*\(/.test(code), 'no Math.random() — nondeterministic');
  assert.ok(!/new\s+Date\s*\(/.test(code), 'no new Date() — nondeterministic');
});

// ── (a) errors-preserved-unconditionally — the NON-NEGOTIABLE rule ─────────────

test('PRESERVE-FIRST: the single error row in a large result survives compression', () => {
  // 499 clean rows + 1 failing row buried in the middle. A naive truncation (keep
  // first/last N) would drop row 250; SmartCrusher keeps it by construction.
  const rows = [];
  for (let i = 0; i < 500; i++) {
    if (i === 250) {
      rows.push({ file: 'src/broken.ts', line: 42, rule: 'no-undef', status: 'error', message: 'x is not defined' });
    } else {
      rows.push({ file: `src/ok${i}.ts`, line: i, rule: 'no-unused', status: 'ok' });
    }
  }
  const result = crusher.compress(rows);

  // The error row's verdict is 'error'...
  assert.equal(result.verdicts[250], 'error', 'the failing row is classified error');
  // ...and it appears in the retained output (set-containment — AC-5b at the engine).
  assert.ok(result.retainedIndices.includes(250), 'the error row MUST be retained unconditionally');

  // Sanity: the compressor actually dropped rows (otherwise "preserved" is vacuous).
  assert.ok(result.droppedCount > 0, 'compression must have dropped clean rows');

  // The retained payload still contains the error message content.
  const retainedJson = JSON.stringify(result.retained);
  assert.ok(retainedJson.includes('x is not defined'), 'the error content survives in the output');
});

test('PRESERVE-FIRST: a naive truncation WOULD drop the error row — proving the rule earns its keep', () => {
  const rows = uniformRows(500);
  rows[300] = { file: 'src/fail.ts', errors: 3, status: 'failed' };

  // The naive baseline this rule defends against: keep first 30% + last 15%, drop the
  // middle 55%. Row 300 is in that dropped middle.
  const headEnd = Math.floor(500 * 0.30);   // 150
  const tailStart = 500 - Math.floor(500 * 0.15); // 425
  const naiveKept = (i) => i < headEnd || i >= tailStart;
  assert.equal(naiveKept(300), false, 'baseline: a naive head/tail truncation drops row 300');

  // SmartCrusher keeps it.
  const result = crusher.compress(rows);
  assert.equal(result.verdicts[300], 'error', 'row 300 classified error');
  assert.ok(result.retainedIndices.includes(300), 'SmartCrusher retains it where naive truncation would not');
});

test('PRESERVE-FIRST: every classified error/anomaly/boundary row is retained (AC-5b containment)', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ kind: 'row', i, v: `v${i}`, score: 5 });
  rows[10] = { kind: 'row', i: 10, v: 'v10', score: 5, error: 'boom' };       // error
  rows[20] = { kind: 'row', i: 20, v: 'v20', score: 5, EXTRA_ODD_FIELD: true }; // anomaly (rare shape)
  rows[30] = { kind: 'row', i: 30, v: 'v30', score: 9999 };                     // boundary (numeric max)
  rows[40] = { kind: 'row', i: 40, v: 'v40', score: -9999 };                    // boundary (numeric min)

  const result = crusher.compress(rows);
  const retained = new Set(result.retainedIndices);
  for (let i = 0; i < rows.length; i++) {
    if (result.verdicts[i] !== 'droppable') {
      assert.ok(retained.has(i), `row ${i} (${result.verdicts[i]}) must be retained — AC-5b containment`);
    }
  }
  // And confirm we actually classified the planted rows.
  assert.equal(result.verdicts[10], 'error');
  assert.equal(result.verdicts[20], 'anomaly');
  assert.ok(result.verdicts[30] === 'boundary', 'numeric max is a boundary');
  assert.ok(result.verdicts[40] === 'boundary', 'numeric min is a boundary');
});

// ── isErrorRow: the classifier's error detection ──────────────────────────────

test('isErrorRow detects error-named keys, status fields, and ignores zero/clean signals', () => {
  assert.equal(crusher.isErrorRow({ error: 'x' }), true);
  assert.equal(crusher.isErrorRow({ errorCount: 3 }), true);
  assert.equal(crusher.isErrorRow({ status: 'failed' }), true);
  assert.equal(crusher.isErrorRow({ severity: 'critical', msg: 'y' }), true);
  assert.equal(crusher.isErrorRow({ failed: true }), true);
  // Clean / zero signals are NOT errors (so the preserve set isn't everything).
  assert.equal(crusher.isErrorRow({ errors: 0 }), false, 'zero errors is not an error');
  assert.equal(crusher.isErrorRow({ error: null }), false, 'null error is not an error');
  assert.equal(crusher.isErrorRow({ status: 'ok' }), false);
  assert.equal(crusher.isErrorRow({ status: 'passed' }), false);
  assert.equal(crusher.isErrorRow({ file: 'a.ts', line: 1 }), false);
});

// ── (b) per-row verdict surfaced ───────────────────────────────────────────────

test('VERDICT: a verdict is surfaced for EVERY original row, by original index', () => {
  const rows = uniformRows(50);
  rows[5] = { ...rows[5], error: 'nope' };
  const result = crusher.compress(rows);
  assert.equal(result.verdicts.length, rows.length, 'one verdict per original row');
  assert.equal(result.verdicts[5], 'error');
  for (const v of result.verdicts) {
    assert.ok(['error', 'anomaly', 'boundary', 'droppable'].includes(v), `valid verdict: ${v}`);
  }
});

// ── constant-field factoring ──────────────────────────────────────────────────

test('FACTORING: fields constant across all rows are lifted out and removed from rows', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ repo: 'claude-os', branch: 'master', file: `f${i}.ts`, line: i });
  }
  const result = crusher.compress(rows);
  assert.equal(result.constants.repo, 'claude-os', 'constant field lifted to constants');
  assert.equal(result.constants.branch, 'master', 'second constant lifted');
  // The retained rows no longer carry the factored fields.
  for (const row of result.retained) {
    assert.ok(!('repo' in row), 'factored field removed from retained row');
    assert.ok(!('branch' in row), 'factored field removed from retained row');
    assert.ok('file' in row && 'line' in row, 'varying fields stay on the row');
  }
});

test('FACTORING: a field that varies even once is NOT factored', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ repo: 'claude-os', file: `f${i}.ts` });
  rows[7].repo = 'other'; // breaks the constancy
  const result = crusher.compress(rows);
  assert.ok(!('repo' in result.constants), 'a field that varies is not a constant');
});

// ── the 30/15/55 retention split ──────────────────────────────────────────────

test('SPLIT: schema-head and recency-tail droppable rows are represented in the output', () => {
  // Distinct, droppable rows (no errors), large enough to have a real budget. The
  // split must pull from the START (schema) and the END (recency) of the array.
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ token: `T${i}`, idx: i, kind: 'x' });
  const result = crusher.compress(rows);

  const kept = result.retainedIndices;
  assert.ok(result.droppedCount > 0, 'some rows dropped (split is meaningful)');
  // Schema head: the very first row is kept.
  assert.ok(kept.includes(0), 'schema head includes the first row');
  // Recency tail: the very last row is kept.
  assert.ok(kept.includes(99), 'recency tail includes the last row');
});

// ── Kneedle ───────────────────────────────────────────────────────────────────

test('KNEEDLE: a flat coverage curve resolves to a fixed fraction, never a random pick', () => {
  // Identical curve value everywhere → dy=0 → the deterministic flat-curve branch.
  const flat = new Array(20).fill(7);
  const a = crusher.kneeIndex(flat);
  const b = crusher.kneeIndex(flat);
  assert.equal(a, b, 'flat-curve knee is deterministic');
  assert.ok(a >= 1 && a <= flat.length, 'knee count in range');
});

test('KNEEDLE: an increasing concave curve returns a knee strictly inside the range', () => {
  // Classic diminishing-returns curve: fast rise then plateau.
  const curve = [0, 60, 90, 100, 103, 104, 105, 105, 105, 105];
  const knee = crusher.kneeIndex(curve);
  assert.ok(knee > 1 && knee < curve.length, `knee ${knee} is an interior point`);
});

test('KNEEDLE: budget never exceeds the droppable pool', () => {
  const rows = uniformRows(50);
  const droppable = rows.map((_, i) => i);
  const budget = crusher.kneedleBudget(rows, droppable);
  assert.ok(budget >= 0 && budget <= droppable.length, 'budget in [0, pool]');
});

// ── the compression floor ──────────────────────────────────────────────────────

test('FLOOR: an array under the floor is NOT compressed (passthrough), verdict still surfaced', () => {
  const small = [{ a: 1 }, { a: 2 }, { a: 3 }]; // 3 < MIN_ROWS_TO_COMPRESS
  const result = crusher.compress(small);
  assert.equal(result.compressed, false, 'below the floor → not compressed');
  assert.equal(result.droppedCount, 0, 'nothing dropped below the floor');
  assert.equal(result.verdicts.length, 3, 'verdict still surfaced even when not compressing');
  assert.deepEqual(result.retainedIndices, [0, 1, 2], 'all rows retained below the floor');
});

// ── (f) AC-1 reversibility surface ─────────────────────────────────────────────

test('AC-1: the result carries the original hash + retained indices (reversibility marker)', () => {
  const rows = uniformRows(60);
  const result = crusher.compress(rows);
  assert.match(result.originalHash, /^[0-9a-f]{64}$/, 'a sha256 hash of the canonical original');
  // The hash is stable for identical input (the retrieve key is deterministic).
  assert.equal(result.originalHash, crusher.compress(rows).originalHash, 'hash is deterministic');
  // The retained indices reference back into the original — a recoverable projection.
  for (const i of result.retainedIndices) {
    assert.ok(i >= 0 && i < rows.length, 'retained index points into the original');
  }
});

test('AC-1: compress() does not mutate its input', () => {
  const rows = uniformRows(40);
  const before = JSON.stringify(rows);
  crusher.compress(rows);
  assert.equal(JSON.stringify(rows), before, 'the original array is never mutated in place');
});

test('hashOriginal is order-invariant (canonical) — same hash for reordered keys', () => {
  const h1 = crusher.hashOriginal(crusher.stableStringify([{ a: 1, b: 2 }]));
  const h2 = crusher.hashOriginal(crusher.stableStringify([{ b: 2, a: 1 }]));
  assert.equal(h1, h2, 'canonical hash ignores key order');
});
