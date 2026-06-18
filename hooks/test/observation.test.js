'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { yamlScalar, coerceObservation, slugify, stripWorktreeSuffix, truncateOnHyphenBoundary } = require('../lib/observation.js');

test('yamlScalar: clean slug passes through unchanged', () => {
  assert.strictEqual(yamlScalar('arc-record-exchange'), 'arc-record-exchange');
});

test('yamlScalar: colon forces double-quoting', () => {
  assert.strictEqual(yamlScalar('a: b'), '"a: b"');
});

test('yamlScalar: embedded double-quote and backslash are escaped inside quotes', () => {
  // input: say "hi"\path
  assert.strictEqual(yamlScalar('say "hi"\\path'), '"say \\"hi\\"\\\\path"');
});

test('yamlScalar: leading whitespace forces quoting', () => {
  assert.strictEqual(yamlScalar(' leading'), '" leading"');
});

test('yamlScalar: trailing whitespace forces quoting', () => {
  assert.strictEqual(yamlScalar('trailing '), '"trailing "');
});

test('yamlScalar: boolean-like strings are quoted', () => {
  assert.strictEqual(yamlScalar('true'), '"true"');
  assert.strictEqual(yamlScalar('false'), '"false"');
});

test('yamlScalar: null-like string is quoted', () => {
  assert.strictEqual(yamlScalar('null'), '"null"');
});

test('yamlScalar: integer-like string is quoted', () => {
  assert.strictEqual(yamlScalar('42'), '"42"');
});

test('yamlScalar: float-like string is quoted', () => {
  assert.strictEqual(yamlScalar('3.14'), '"3.14"');
});

test('yamlScalar: hash indicator forces quoting', () => {
  assert.strictEqual(yamlScalar('#hash'), '"#hash"');
});

test('yamlScalar: opening bracket forces quoting', () => {
  assert.strictEqual(yamlScalar('[bracket'), '"[bracket"');
});

test('yamlScalar: comma forces quoting', () => {
  assert.strictEqual(yamlScalar('a,b'), '"a,b"');
});

// ── coerceObservation: project normalization ──────────────────────────────────

test('coerceObservation: compound watched project with worktree suffix → slug', () => {
  const obs = coerceObservation({ project: 'ARC Record Exchange (worktree: feat/ARC-4539-nonpayload-file-iso)', summary: 'x' });
  assert.strictEqual(obs.project, 'arc-record-exchange');
});

test('coerceObservation: compound watched project with ticket suffix → slug', () => {
  const obs = coerceObservation({ project: 'arc-record-exchange (ARC-4803: surface delivery lock expiration)', summary: 'x' });
  assert.strictEqual(obs.project, 'arc-record-exchange');
});

test('coerceObservation: out-of-vocab compound project → slug-form label (not null, not raw)', () => {
  const obs = coerceObservation({ project: 'Some Experiment (worktree: feat/x)', summary: 'x' });
  assert.strictEqual(obs.project, 'some-experiment');
});

test('coerceObservation: plain in-vocab slug passes through unchanged', () => {
  const obs = coerceObservation({ project: 'perch', summary: 'x' });
  assert.strictEqual(obs.project, 'perch');
});

test('coerceObservation: over-64-char project truncated on hyphen boundary', () => {
  // Build a slug-able string that will exceed 64 chars after slugification
  const long = 'alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet-kilo';
  const obs = coerceObservation({ project: long, summary: 'x' });
  assert.ok(obs.project.length <= 64, `expected length <= 64, got ${obs.project.length}`);
  assert.ok(!obs.project.endsWith('-'), 'result must not end with a hyphen');
  // The truncation must land on a hyphen boundary — no partial token
  const full = slugify(long);
  assert.ok(full.startsWith(obs.project), 'truncated value must be a prefix of the full slug');
});

test('coerceObservation: legit parenthetical not stripped', () => {
  const obs = coerceObservation({ project: 'My Project (v2)', summary: 'x' });
  assert.strictEqual(obs.project, 'my-project-v2');
});

test('coerceObservation: control chars and newlines stripped by safeString', () => {
  const obs = coerceObservation({ project: 'line1\nline2', summary: 'x' });
  assert.strictEqual(obs.project, 'line1-line2');
});

test('coerceObservation: empty string → null', () => {
  const obs = coerceObservation({ project: '', summary: 'x' });
  assert.strictEqual(obs.project, null);
});

test('coerceObservation: whitespace-only project → null', () => {
  const obs = coerceObservation({ project: '   ', summary: 'x' });
  assert.strictEqual(obs.project, null);
});
