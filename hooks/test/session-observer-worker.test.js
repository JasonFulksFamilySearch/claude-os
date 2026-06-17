'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { episodeFilename, preservePromoted } = require('../session-observer-worker.js');

test('episodeFilename is deterministic per session (no Date.now suffix)', () => {
  const rec = { firstSeenDate: '2026-06-16', sessionId: 'abc-123' };
  assert.equal(episodeFilename(rec), '2026-06-16-abc-123.md');
  assert.equal(episodeFilename(rec), episodeFilename(rec), 'stable across calls');
});

test('episodeFilename sanitizes the session id', () => {
  const rec = { firstSeenDate: '2026-06-16', sessionId: '../../evil id' };
  assert.ok(!episodeFilename(rec).includes('/'));
  assert.ok(!episodeFilename(rec).includes(' '));
});

test('preservePromoted keeps promoted:true from an existing episode', () => {
  const existing = '---\ndate: 2026-06-16\npromoted: true\n---\n## Summary\nold\n';
  const fresh = '---\ndate: 2026-06-16\npromoted: false\n---\n## Summary\nnew\n';
  const out = preservePromoted(existing, fresh);
  assert.ok(/promoted: true/.test(out));
  assert.ok(out.includes('## Summary\nnew'));
});

test('preservePromoted leaves promoted:false when no prior file', () => {
  const fresh = '---\ndate: 2026-06-16\npromoted: false\n---\n## Summary\nnew\n';
  assert.ok(/promoted: false/.test(preservePromoted(null, fresh)));
});
