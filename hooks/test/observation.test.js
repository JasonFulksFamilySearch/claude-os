'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { yamlScalar } = require('../lib/observation.js');

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
