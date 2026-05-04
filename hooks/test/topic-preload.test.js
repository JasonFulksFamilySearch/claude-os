'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIndex, matchTopics } = require('../topic-preload.js');

const SAMPLE_INDEX = `
# Context Index

## Topics

- **arc** — keywords: arc, arc-record-exchange, orch, orchestration, zion — file: arc.md
- **java** — keywords: java, maven, mvn, gradle, spring boot — file: java.md
- **github** — keywords: github, pr, pull request, gh, repo — file: github.md
- **goals** — keywords: goals, metrics, fix commit, rework — file: goals.md
`;

test('parseIndex extracts all topics', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  assert.equal(topics.length, 4);
  assert.equal(topics[0].name, 'arc');
  assert.deepEqual(topics[0].keywords, ['arc', 'arc-record-exchange', 'orch', 'orchestration', 'zion']);
  assert.equal(topics[0].file, 'arc.md');
});

test('parseIndex returns empty array for empty content', () => {
  assert.deepEqual(parseIndex(''), []);
});

test('parseIndex skips non-topic lines', () => {
  const partial = `# Header\n\nSome text\n- **only** — keywords: one — file: only.md\n`;
  const topics = parseIndex(partial);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].name, 'only');
});

test('matchTopics finds exact keyword match', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'I need to look at the ARC orch timeout');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'arc');
  assert.ok(matched[0].hits.includes('arc'));
  assert.ok(matched[0].hits.includes('orch'));
});

test('matchTopics does not match orch inside orchestration', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'the orchestration layer is slow');
  // orchestration is not a standalone keyword — only 'arc' and 'zion' are in the index
  const arcMatch = matched.find(t => t.name === 'arc');
  assert.ok(!arcMatch || !arcMatch.hits.includes('orch'));
});

test('matchTopics is case-insensitive', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'Run MVN clean install');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'java');
  assert.ok(matched[0].hits.includes('mvn'));
});

test('matchTopics returns multiple topic matches', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'Create a PR for the Java maven changes');
  const names = matched.map(t => t.name);
  assert.ok(names.includes('java'));
  assert.ok(names.includes('github'));
});

test('matchTopics returns empty array when no match', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'fix a typo in the readme');
  assert.deepEqual(matched, []);
});

test('matchTopics returns empty array for empty message', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  assert.deepEqual(matchTopics(topics, ''), []);
});

test('matchTopics handles multi-word keyword as substring', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'check the pull request status');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'github');
  assert.ok(matched[0].hits.includes('pull request'));
});

test('matchTopics does not fire on partial word (pr inside prefer/approach)', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'I prefer this approach');
  assert.deepEqual(matched, []);
});

test('matchTopics fires on standalone pr', () => {
  const topics = parseIndex(SAMPLE_INDEX);
  const matched = matchTopics(topics, 'open a pr for this fix');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'github');
});
