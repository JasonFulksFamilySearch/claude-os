'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { buildEpisodeContent } = require('../session-observer-worker.js');

const baseObs = () => ({
  summary: 'did a thing', decisions: [], corrections: [], discoveries: [], files_of_note: [],
});

test('writes value_score line when obs.value_score is a number', () => {
  const md = buildEpisodeContent({ ...baseObs(), value_score: 3 }, 'sess-1', 5);
  assert.match(md, /^value_score: 3$/m);
});

test('writes provenance keys alongside a present score', () => {
  const md = buildEpisodeContent({ ...baseObs(), value_score: 3 }, 'sess-1', 5);
  assert.match(md, /^value_source: llm-judge$/m);
  assert.match(md, /^value_rubric_version: v1$/m);
  assert.match(md, /^value_model: .+$/m);
});

test('omits the value_score line entirely when obs.value_score is absent', () => {
  const md = buildEpisodeContent(baseObs(), 'sess-1', 5);
  assert.ok(!/value_score/.test(md), 'no value_score key should be written');
});

test('omits the value_score line when obs.value_score is null (never a fabricated 0)', () => {
  const md = buildEpisodeContent({ ...baseObs(), value_score: null }, 'sess-1', 5);
  assert.ok(!/value_score/.test(md));
});

test('writes no provenance keys when the score is absent', () => {
  const md = buildEpisodeContent(baseObs(), 'sess-1', 5);
  assert.ok(!/value_source/.test(md));
});
