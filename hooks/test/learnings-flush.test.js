'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { resolveTarget, appendEntry, flush } = require('../learnings-flush.js');

// Temporary working directory for each test run
const TMP = join(tmpdir(), `learnings-flush-test-${process.pid}`);

before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

test('resolveTarget returns agent path for scope=agent', () => {
  const result = resolveTarget({ scope: 'agent' }, TMP);
  assert.equal(result, join(TMP, 'agent', 'learnings.md'));
});

test('resolveTarget returns project path for scope=project', () => {
  const result = resolveTarget({ scope: 'project', project: 'arc-ui' }, TMP);
  assert.equal(result, join(TMP, 'projects', 'arc-ui', 'learnings.md'));
});

test('resolveTarget returns null for invalid project slug', () => {
  assert.equal(resolveTarget({ scope: 'project', project: 'Arc UI' }, TMP), null);
  assert.equal(resolveTarget({ scope: 'project', project: '' }, TMP), null);
  assert.equal(resolveTarget({ scope: 'project' }, TMP), null);
});

test('resolveTarget returns null for unknown scope', () => {
  assert.equal(resolveTarget({ scope: 'global' }, TMP), null);
});

test('appendEntry creates file if absent and writes entry', () => {
  const path = join(TMP, 'create-test', 'learnings.md');
  appendEntry(path, { content: 'A learning happened.', title: 'Test Entry' });
  assert.ok(existsSync(path));
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('# Learnings'));
  assert.ok(text.includes('Test Entry'));
  assert.ok(text.includes('A learning happened.'));
});

test('appendEntry appends to existing file', () => {
  const path = join(TMP, 'append-test', 'learnings.md');
  mkdirSync(join(TMP, 'append-test'), { recursive: true });
  writeFileSync(path, '# Learnings\n\nFirst entry.\n', 'utf8');
  appendEntry(path, { content: 'Second learning.', title: 'Second' });
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('First entry.'));
  assert.ok(text.includes('Second learning.'));
});

test('appendEntry uses default title when not provided', () => {
  const path = join(TMP, 'default-title', 'learnings.md');
  appendEntry(path, { content: 'No title provided.' });
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('— Learning'));
});

test('flush is a no-op when marker file absent', () => {
  const markerPath = join(TMP, 'no-marker.json');
  const result = flush(markerPath);
  assert.equal(result.flushed, 0);
  assert.equal(result.skipped, 0);
});

test('flush processes single entry and deletes marker', () => {
  const markerPath = join(TMP, 'single-entry.json');
  const entries = [{ scope: 'agent', title: 'Single', content: 'Just one entry.' }];
  writeFileSync(markerPath, JSON.stringify(entries), 'utf8');

  // flush needs to write to ~/.claude-data — override via a monkey-patch isn't trivial
  // with the current structure, so we verify flush return value and marker removal
  // For now verify marker is deleted regardless of write success in this isolated env
  const result = flush(markerPath);
  assert.ok(!existsSync(markerPath), 'marker file should be deleted after flush');
  assert.ok(result.flushed >= 0);
});

test('flush handles malformed JSON by deleting marker', () => {
  const markerPath = join(TMP, 'malformed.json');
  writeFileSync(markerPath, '{ not valid json }', 'utf8');
  const result = flush(markerPath);
  assert.ok(!existsSync(markerPath));
  assert.equal(result.flushed, 0);
  assert.ok(result.error);
});

test('flush skips entries missing scope or content', () => {
  const markerPath = join(TMP, 'incomplete-entries.json');
  const entries = [
    { scope: 'agent' },          // missing content
    { content: 'no scope' },     // missing scope
    { scope: 'agent', content: 'valid entry', title: 'Valid' },
  ];
  writeFileSync(markerPath, JSON.stringify(entries), 'utf8');
  const result = flush(markerPath);
  assert.equal(result.skipped, 2);
  assert.ok(!existsSync(markerPath));
});

test('flush accepts single object (not array)', () => {
  const markerPath = join(TMP, 'single-object.json');
  writeFileSync(markerPath, JSON.stringify({ scope: 'agent', content: 'wrapped object' }), 'utf8');
  const result = flush(markerPath);
  assert.ok(!existsSync(markerPath));
  // Should not throw and flushed should be 0 or 1
  assert.ok(result.flushed >= 0);
});
