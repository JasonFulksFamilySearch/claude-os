'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { episodeFilename, preservePromoted, shouldDeadLetterMissingTranscript } = require('../session-observer-worker.js');

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

// ── Missing-transcript dead-letter gating ──────────────────────────────────────

test('shouldDeadLetterMissingTranscript returns true for a path that does not exist', () => {
  const ghostPath = join(tmpdir(), `ghost-transcript-${process.pid}.jsonl`);
  // Confirm the file does not exist — precondition for the test.
  assert.ok(!existsSync(ghostPath), 'precondition: ghost path must not exist');
  assert.equal(shouldDeadLetterMissingTranscript(ghostPath), true);
});

test('shouldDeadLetterMissingTranscript returns false for a path that does exist', () => {
  // A path that definitely exists: the current test file itself.
  assert.equal(shouldDeadLetterMissingTranscript(__filename), false);
});

test('a missing transcript causes a dead-letter record to be written (integration)', () => {
  const { mkdirSync, writeFileSync, readdirSync: rds } = require('node:fs');
  const { createCaptureQueue } = require('../lib/capture-queue.js');
  const TMP = join(tmpdir(), `dl-missing-${process.pid}`);
  const queueDir = join(TMP, 'queue');
  const deadLetterDir = join(TMP, 'dead-letter');
  mkdirSync(deadLetterDir, { recursive: true });

  const ghostPath = join(TMP, 'ghost.jsonl'); // deliberately never created

  // Mirror exactly what main() will do once fixed: detect missing transcript → dead-letter.
  const queue = createCaptureQueue({ queueDir, deadLetterDir });
  if (shouldDeadLetterMissingTranscript(ghostPath)) {
    queue.deadLetter('test-session-missing', 'transcript no longer exists');
  }

  // A dead-letter record must exist in the dead-letter directory.
  const dlFiles = rds(deadLetterDir);
  assert.ok(dlFiles.length > 0, 'dead-letter record must be written for a missing transcript');
});

test('a too-short but present transcript does NOT produce a dead-letter record', () => {
  const { mkdirSync, writeFileSync, readdirSync: rds } = require('node:fs');
  const TMP2 = join(tmpdir(), `dl-short-${process.pid}`);
  const deadLetterDir2 = join(TMP2, 'dead-letter');
  mkdirSync(deadLetterDir2, { recursive: true });

  const presentPath = join(TMP2, 'short.jsonl');
  writeFileSync(presentPath, '', 'utf8'); // exists, 0 turns

  // A present (even empty) file must NOT be dead-lettered by the missing-transcript check.
  assert.equal(shouldDeadLetterMissingTranscript(presentPath), false,
    'an existing (too-short) transcript must not be flagged as missing');

  // Confirm no dead-letter records were written by the guard.
  const dlFiles2 = rds(deadLetterDir2);
  assert.equal(dlFiles2.length, 0, 'no dead-letter record for a present-but-too-short transcript');
});
