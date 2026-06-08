'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { parseFrontmatter } = require('../lib/episode-utils.js');

test('parseFrontmatter accepts an integer value_score', () => {
  const fm = parseFrontmatter('---\ndate: 2026-06-08\nvalue_score: 3\n---\nbody\n');
  assert.strictEqual(fm.value_score, 3);
});

test('parseFrontmatter accepts string provenance keys', () => {
  const fm = parseFrontmatter('---\ndate: 2026-06-08\nvalue_source: llm-judge\nvalue_model: claude-haiku-4-5\n---\nbody\n');
  assert.strictEqual(fm.value_source, 'llm-judge');
  assert.strictEqual(fm.value_model, 'claude-haiku-4-5');
});

test('parseFrontmatter still drops unknown keys', () => {
  const fm = parseFrontmatter('---\ndate: 2026-06-08\nbogus: x\n---\nbody\n');
  assert.strictEqual(fm.bogus, undefined);
});

test('parseFrontmatter drops an out-of-range value_score (treated as unknown)', () => {
  const fm = parseFrontmatter('---\ndate: 2026-06-08\nvalue_score: 99\n---\nbody\n');
  assert.strictEqual(fm.value_score, undefined);
});
