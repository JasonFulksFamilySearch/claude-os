'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir, homedir } = require('node:os');

// Tests import from the worker, not the launcher.
const {
  parseTurns,
  buildTranscriptText,
  buildEpisodeContent,
  extractJsonFromText,
  coerceObservation,
} = require('../session-observer-worker.js');

const TMP = join(tmpdir(), `session-observer-test-${process.pid}`);
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

// --- parseTurns ---

test('parseTurns returns empty array for missing file', () => {
  assert.deepEqual(parseTurns(join(TMP, 'ghost.jsonl')), []);
});

test('parseTurns extracts user and assistant turns (type: user — real Claude Code format)', () => {
  const path = join(TMP, 'transcript-real-format.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello Willis' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello Sir' }] } }),
    JSON.stringify({ type: 'tool_use', id: 'tool1', name: 'Read' }),
  ].join('\n'), 'utf8');

  const turns = parseTurns(path);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[0].text, 'Hello Willis');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[1].text, 'Hello Sir');
});

test('parseTurns rejects type: human (wrong format — Claude Code uses type: user)', () => {
  const path = join(TMP, 'wrong-format.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'human', message: { role: 'user', content: [{ type: 'text', text: 'Wrong type' }] } }),
  ].join('\n'), 'utf8');

  const turns = parseTurns(path);
  assert.equal(turns.length, 0);
});

test('parseTurns skips malformed JSONL lines gracefully', () => {
  const path = join(TMP, 'malformed.jsonl');
  writeFileSync(path, [
    '{ this is not valid JSON',
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Valid turn' }] } }),
  ].join('\n'), 'utf8');

  const turns = parseTurns(path);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Valid turn');
});

// --- buildTranscriptText ---

test('buildTranscriptText produces role-prefixed lines', () => {
  const turns = [
    { role: 'user', text: 'Fix the bug' },
    { role: 'assistant', text: 'I found the issue' },
  ];
  const text = buildTranscriptText(turns);
  assert.ok(text.includes('USER: Fix the bug'));
  assert.ok(text.includes('ASSISTANT: I found the issue'));
});

test('buildTranscriptText keeps most recent turns when truncating (does not drop last turn)', () => {
  const turns = [
    { role: 'user', text: 'First message — should be dropped' },
    { role: 'user', text: 'x'.repeat(30_000) },
    { role: 'assistant', text: 'Last message — must survive' },
  ];
  const text = buildTranscriptText(turns);
  assert.ok(!text.includes('First message — should be dropped'));
  assert.ok(text.includes('Last message — must survive'));
});

test('buildTranscriptText includes at least one turn even when a single turn exceeds MAX_CHARS', () => {
  const turns = [{ role: 'user', text: 'x'.repeat(35_000) }];
  const text = buildTranscriptText(turns);
  assert.ok(text.length > 0);
  assert.ok(text.includes('USER:'));
});

// --- extractJsonFromText ---

test('extractJsonFromText extracts clean JSON', () => {
  const result = extractJsonFromText('{"summary":"ok","decisions":[]}');
  assert.equal(result.summary, 'ok');
});

test('extractJsonFromText handles JSON wrapped in prose', () => {
  const result = extractJsonFromText('Here is my analysis:\n{"summary":"Fixed bug","decisions":[]}\n\nLet me know.');
  assert.equal(result.summary, 'Fixed bug');
});

test('extractJsonFromText handles braces inside string values', () => {
  const result = extractJsonFromText('{"summary":"Fixed the {stall} in SplunkService","decisions":[]}');
  assert.equal(result.summary, 'Fixed the {stall} in SplunkService');
});

test('extractJsonFromText returns null when no JSON present', () => {
  assert.equal(extractJsonFromText('No JSON here.'), null);
});

test('extractJsonFromText returns null when JSON is malformed', () => {
  assert.equal(extractJsonFromText('{"summary": "broken"'), null);
});

// --- coerceObservation ---

test('coerceObservation accepts a well-formed observation', () => {
  const raw = {
    summary: 'Fixed something.',
    project: 'arc',
    decisions: ['Used sliding window.'],
    corrections: [],
    discoveries: [],
    files_of_note: [],
  };
  const obs = coerceObservation(raw);
  assert.equal(obs.summary, 'Fixed something.');
  assert.deepEqual(obs.decisions, ['Used sliding window.']);
});

test('coerceObservation coerces decisions string to array', () => {
  const raw = { summary: 'ok', project: null, decisions: 'Used sliding window', corrections: [], discoveries: [], files_of_note: [] };
  const obs = coerceObservation(raw);
  assert.ok(Array.isArray(obs.decisions));
  assert.equal(obs.decisions[0], 'Used sliding window');
});

test('coerceObservation treats null arrays as empty arrays', () => {
  const raw = { summary: 'ok', project: null, decisions: null, corrections: null, discoveries: null, files_of_note: null };
  const obs = coerceObservation(raw);
  assert.deepEqual(obs.decisions, []);
  assert.deepEqual(obs.corrections, []);
});

test('coerceObservation ignores extra unknown keys', () => {
  const raw = { summary: 'ok', project: null, decisions: [], corrections: [], discoveries: [], files_of_note: [], unexpected: 'ignored' };
  assert.doesNotThrow(() => coerceObservation(raw));
});

// --- buildEpisodeContent ---

test('buildEpisodeContent produces valid frontmatter and sections', () => {
  const obs = {
    summary: 'Fixed a stall detection bug.',
    project: 'arc',
    decisions: ['Used sliding window approach.'],
    corrections: [],
    discoveries: ['Timer resets on every heartbeat.'],
    files_of_note: [{ path: 'src/SplunkService.java', reason: 'Core fix location' }],
  };
  const content = buildEpisodeContent(obs, 'sess001', 12);
  assert.ok(content.startsWith('---\n'));
  assert.ok(content.includes('project: arc'));
  assert.ok(content.includes('promoted: false'));
  assert.ok(content.includes('## Summary'));
  assert.ok(content.includes('Fixed a stall detection bug.'));
  assert.ok(content.includes('## Decisions'));
  assert.ok(content.includes('Used sliding window approach.'));
  assert.ok(content.includes('## Discoveries'));
  assert.ok(content.includes('## Files of note'));
  assert.ok(content.includes('`src/SplunkService.java`'));
  assert.ok(!content.includes('## Corrections'));
});

test('buildEpisodeContent omits empty sections', () => {
  const obs = { summary: 'Quiet session.', project: null, decisions: [], corrections: [], discoveries: [], files_of_note: [] };
  const content = buildEpisodeContent(obs, 'sess002', 4);
  assert.ok(!content.includes('## Decisions'));
  assert.ok(!content.includes('## Corrections'));
  assert.ok(!content.includes('## Discoveries'));
  assert.ok(!content.includes('## Files of note'));
  assert.ok(content.includes('## Summary'));
  assert.ok(content.includes('Quiet session.'));
});

test('buildEpisodeContent with null project omits the project key from frontmatter', () => {
  const obs = { summary: 'Test.', project: null, decisions: [], corrections: [], discoveries: [], files_of_note: [] };
  const content = buildEpisodeContent(obs, 'sess003', 3);
  const fmLines = content.slice(4, content.indexOf('\n---\n', 4)).split('\n');
  const projectLine = fmLines.find(l => l.startsWith('project:'));
  assert.ok(!projectLine || projectLine === 'project: ~');
});

test('buildEpisodeContent sanitizes session_id to safe filename characters', () => {
  const obs = { summary: 'Test.', project: null, decisions: [], corrections: [], discoveries: [], files_of_note: [] };
  const content = buildEpisodeContent(obs, '../../../etc/evil', 3);
  assert.ok(!content.includes('..'));
  assert.ok(!content.includes('/'));
});
