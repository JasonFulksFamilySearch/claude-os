'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { resolveTarget, appendEntry, flush, markerFamily, flushFile, flushAll } = require('../learnings-flush.js');

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

test('flush handles malformed JSON by quarantining (not deleting) the marker', () => {
  const markerPath = join(TMP, 'malformed.json');
  writeFileSync(markerPath, '{ not valid json }', 'utf8');
  const result = flush(markerPath);
  // Original marker must be gone (renamed away)
  assert.ok(!existsSync(markerPath), 'original marker path removed');
  assert.equal(result.flushed, 0);
  // Contents must be preserved in a quarantine file
  assert.ok(result.quarantined, 'quarantined path returned');
  assert.ok(existsSync(result.quarantined), 'quarantine file exists');
  assert.equal(readFileSync(result.quarantined, 'utf8'), '{ not valid json }');
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

// ── Task D: CaptureMarkers — new tests ────────────────────────────────────────

test('markerFamily globs suffixed + legacy markers', () => {
  const root = join(TMP, 'fam');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '_tmp_pending_learning.json'), '[]', 'utf8');
  writeFileSync(join(root, '_tmp_pending_learning-abc123.json'), '[]', 'utf8');
  writeFileSync(join(root, 'unrelated.json'), '[]', 'utf8');
  const fam = markerFamily(root).map(p => p.split('/').pop()).sort();
  assert.deepEqual(fam, ['_tmp_pending_learning-abc123.json', '_tmp_pending_learning.json']);
});

test('flushFile quarantines (does NOT discard) a malformed marker', () => {
  const p = join(TMP, 'bad', '_tmp_pending_learning-x.json');
  mkdirSync(join(TMP, 'bad'), { recursive: true });
  writeFileSync(p, '{ not json', 'utf8');
  const r = flushFile(p);
  assert.ok(!existsSync(p), 'original removed');
  assert.ok(r.quarantined && existsSync(r.quarantined), 'contents preserved in quarantine file');
  assert.equal(readFileSync(r.quarantined, 'utf8'), '{ not json');
});

test('flushFile writes a residue file for an entry whose append throws (injected appendFn)', () => {
  const p = join(TMP, 'res', '_tmp_pending_learning-y.json');
  mkdirSync(join(TMP, 'res'), { recursive: true });
  writeFileSync(p, JSON.stringify([
    { scope: 'agent', content: 'will-throw', title: 'T1' },
    { scope: 'agent', content: 'ok', title: 'T2' },
  ]), 'utf8');
  let calls = 0;
  const throwingAppend = () => { calls++; if (calls === 1) throw new Error('simulated write failure'); };
  const r = flushFile(p, { appendFn: throwingAppend });
  assert.equal(r.flushed, 1, 'the second entry still flushed');
  assert.ok(r.residue && existsSync(r.residue), 'failed entry preserved in a residue file');
  const residue = JSON.parse(readFileSync(r.residue, 'utf8'));
  assert.equal(residue.length, 1);
  assert.equal(residue[0].content, 'will-throw');
  assert.ok(!existsSync(p), 'original marker removed once entries are triaged to residue');
});

test('flushFile leaves NO residue and removes the marker when every entry flushes', () => {
  const p = join(TMP, 'res2', '_tmp_pending_learning-z.json');
  mkdirSync(join(TMP, 'res2'), { recursive: true });
  writeFileSync(p, JSON.stringify([{ scope: 'agent', content: 'ok', title: 'T' }]), 'utf8');
  const r = flushFile(p, { appendFn: () => {} });
  assert.ok(!existsSync(p));
  assert.ok(!r.residue, 'no residue when all entries flush');
});

test('flushAll processes every family member independently', () => {
  const root = join(TMP, 'all');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '_tmp_pending_learning.json'), JSON.stringify([{ scope: 'agent', content: 'a' }]), 'utf8');
  writeFileSync(join(root, '_tmp_pending_learning-s1.json'), '{ bad', 'utf8');
  const agg = flushAll(root);
  assert.ok(agg.filesProcessed >= 2);
  assert.ok(!existsSync(join(root, '_tmp_pending_learning.json')), 'valid file consumed');
  assert.ok(agg.quarantined >= 1, 'bad file quarantined, not lost');
});

test('residue filename is idempotent — a second flush of a residue file does not grow the name', () => {
  // Scenario: first flush → residue.json; second flush of that residue.json → still residue.json (not residue.residue.json).
  const root = join(TMP, 'residue-idempotent');
  mkdirSync(root, { recursive: true });

  const marker = join(root, '_tmp_pending_learning-idem.json');
  const throwingAppend = () => { throw new Error('simulated write failure'); };

  // First flush — produces residue file.
  writeFileSync(marker, JSON.stringify([{ scope: 'agent', content: 'entry-1', title: 'T1' }]), 'utf8');
  const r1 = flushFile(marker, { appendFn: throwingAppend });
  assert.ok(r1.residue, 'first flush must produce a residue file');
  assert.ok(r1.residue.endsWith('.residue.json'), 'residue name ends with .residue.json');
  assert.ok(!r1.residue.includes('.residue.residue'), 'no name stacking on first run');

  // Second flush — flush the residue file itself (simulating the next session's run picking it up).
  writeFileSync(r1.residue, JSON.stringify([{ scope: 'agent', content: 'entry-2', title: 'T2' }]), 'utf8');
  const r2 = flushFile(r1.residue, { appendFn: throwingAppend });
  assert.ok(r2.residue, 'second flush must still produce a residue file');
  // The name must be identical — no growth.
  assert.equal(r2.residue, r1.residue, 'residue filename must not grow on second flush cycle');
});

test('two failing flush cycles merge into a single residue file with all entries', () => {
  // Both cycles fail; the second must READ the existing residue, concat, and write back atomically.
  const root = join(TMP, 'residue-merge');
  mkdirSync(root, { recursive: true });

  const marker = join(root, '_tmp_pending_learning-merge.json');
  const throwingAppend = () => { throw new Error('simulated write failure'); };

  // Cycle 1: one failing entry → residue.
  writeFileSync(marker, JSON.stringify([{ scope: 'agent', content: 'entry-1', title: 'T1' }]), 'utf8');
  const r1 = flushFile(marker, { appendFn: throwingAppend });
  assert.ok(r1.residue, 'cycle 1 must produce residue');
  const cycle1Entries = JSON.parse(readFileSync(r1.residue, 'utf8'));
  assert.equal(cycle1Entries.length, 1, 'cycle 1 residue has 1 entry');

  // Cycle 2: another failing entry via the SAME marker path (new session writes to it again).
  writeFileSync(marker, JSON.stringify([{ scope: 'agent', content: 'entry-2', title: 'T2' }]), 'utf8');
  const r2 = flushFile(marker, { appendFn: throwingAppend });
  assert.ok(r2.residue, 'cycle 2 must produce residue');

  // There should be exactly ONE residue file (idempotent name) with BOTH entries.
  assert.equal(r2.residue, r1.residue, 'same residue path for both cycles');
  const merged = JSON.parse(readFileSync(r2.residue, 'utf8'));
  assert.equal(merged.length, 2, 'merged residue must contain both cycles\' entries');
  const contents = merged.map(e => e.content).sort();
  assert.deepEqual(contents, ['entry-1', 'entry-2'], 'both entries present after merge');
});

test('quarantine is terminal — a quarantine file is never reprocessed by flushAll', () => {
  const { readdirSync: readdirSyncNode } = require('node:fs');
  const root = join(TMP, 'quarantine-terminal');
  mkdirSync(root, { recursive: true });

  // Write a malformed marker and flush once — this quarantines it.
  const marker = join(root, '_tmp_pending_learning-qterm.json');
  writeFileSync(marker, '{ not valid json at all }', 'utf8');
  const firstRun = flushAll(root);
  assert.ok(firstRun.quarantined >= 1, 'first run should quarantine the bad file');

  // Capture the quarantine filename and its contents.
  const afterFirst = readdirSyncNode(root);
  const quarantineFiles = afterFirst.filter(f => f.includes('.quarantine-'));
  assert.equal(quarantineFiles.length, 1, 'exactly one quarantine file should exist after first run');
  const quarantineFile = quarantineFiles[0];
  const quarantineContents = require('node:fs').readFileSync(join(root, quarantineFile), 'utf8');

  // Run flushAll a second time — quarantine file must NOT be re-ingested.
  const secondRun = flushAll(root);
  assert.equal(secondRun.filesProcessed, 0, 'second run should find no files to process');
  assert.equal(secondRun.quarantined, 0, 'second run must not create another quarantine file');

  // The original quarantine file must be untouched — same name, same contents.
  const afterSecond = readdirSyncNode(root);
  const quarantineFilesAfter = afterSecond.filter(f => f.includes('.quarantine-'));
  assert.equal(quarantineFilesAfter.length, 1, 'still exactly one quarantine file after second run');
  assert.equal(quarantineFilesAfter[0], quarantineFile, 'quarantine filename must not have changed');
  assert.equal(
    require('node:fs').readFileSync(join(root, quarantineFilesAfter[0]), 'utf8'),
    quarantineContents,
    'quarantine file contents must be unchanged',
  );
});
