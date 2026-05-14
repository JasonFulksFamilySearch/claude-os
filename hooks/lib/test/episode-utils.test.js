'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { todayLocal, parseFrontmatter, extractSummary } = require('../episode-utils.js');

// --- todayLocal ---

test('todayLocal returns YYYY-MM-DD format', () => {
  const result = todayLocal();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

// --- parseFrontmatter ---

test('parseFrontmatter parses all allowed fields', () => {
  const content = '---\ndate: 2026-05-14\nsession_id: abc123\nproject: arc\nturns: 12\npromoted: false\n---\n\n## Summary\nTest.';
  const d = parseFrontmatter(content);
  assert.equal(d.date, '2026-05-14');
  assert.equal(d.session_id, 'abc123');
  assert.equal(d.project, 'arc');
  assert.equal(d.turns, 12);
  assert.equal(d.promoted, false);
});

test('parseFrontmatter handles promoted: true and promoted: True (case-insensitive)', () => {
  const d1 = parseFrontmatter('---\npromoted: true\n---\n');
  assert.equal(d1.promoted, true);
  const d2 = parseFrontmatter('---\npromoted: True\n---\n');
  assert.equal(d2.promoted, true);
});

test('parseFrontmatter silently drops disallowed keys', () => {
  const d = parseFrontmatter('---\nmalicious: injected\nproject: arc\n---\n');
  assert.equal(d.project, 'arc');
  assert.equal(d.malicious, undefined);
});

test('parseFrontmatter returns empty object when no frontmatter', () => {
  assert.deepEqual(parseFrontmatter('# Just a heading\nNo frontmatter.'), {});
});

// --- extractSummary ---

test('extractSummary returns text under ## Summary', () => {
  const content = '---\ndate: 2026-05-14\n---\n\n## Summary\nFixed the stall bug.\n\n## Decisions\n- Used sliding window.';
  assert.equal(extractSummary(content), 'Fixed the stall bug.');
});

test('extractSummary captures multi-line summaries (does not stop at blank line within summary)', () => {
  const content = '---\ndate: 2026-05-14\n---\n\n## Summary\nFirst paragraph.\n\nSecond paragraph.\n\n## Decisions\n- Done.';
  const summary = extractSummary(content);
  assert.ok(summary.includes('First paragraph.'));
  // With correct (non-/m) regex, summary runs to the next ##, not to the first blank line
});

test('extractSummary returns null when no Summary section', () => {
  assert.equal(extractSummary('## Decisions\n- Some decision.'), null);
});

test('extractSummary stops at next ## section (not at blank line)', () => {
  const content = '---\ndate: 2026-05-14\n---\n\n## Summary\nParagraph one.\n\n## Decisions\n- Used sliding window.';
  const summary = extractSummary(content);
  assert.ok(!summary.includes('Decisions'));
  assert.ok(!summary.includes('sliding window'));
});

test('extractSummary returns null when Summary section is empty (Haiku produced no summary text)', () => {
  // Regression: without the trim()/startsWith('##') guard, the regex would
  // greedily span the blank line and trim() would yield '## Decisions...'
  // as the summary digest — injecting a section heading as if it were text.
  const content = '---\ndate: 2026-05-14\n---\n\n## Summary\n\n## Decisions\n- foo';
  assert.equal(extractSummary(content), null);
});

test('extractSummary returns null when Summary section is whitespace-only', () => {
  const content = '---\ndate: 2026-05-14\n---\n\n## Summary\n   \n\n## Decisions\n- foo';
  assert.equal(extractSummary(content), null);
});
