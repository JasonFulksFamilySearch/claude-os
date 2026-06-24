'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEpisodeContent } = require('../session-observer-worker.js');

const OBS = { summary: 'did things', decisions: [], corrections: [], discoveries: [], files_of_note: [] };

test('no toolSignals ⇒ byte-identical to the 3-arg call (reversibility)', () => {
  const a = buildEpisodeContent(OBS, 'sess', 5);
  const b = buildEpisodeContent(OBS, 'sess', 5, []);
  assert.equal(a, b);
  assert.ok(!a.includes('## Tool signals'));
});

// Records use the REAL shape toSignalRecord produces: `preserved` = [{index,kind}] of the
// non-droppable verdicts, derived from compress()'s flat string array. (NOT a `verdicts`
// field of {index,kind} objects — that shape does not exist; using it here would be a
// tautological fixture that hides the real contract.)
test('toolSignals present ⇒ a "## Tool signals" section is appended', () => {
  const signals = [
    { tool: 'Bash', retained: '2 retained', dropped_count: 7,
      preserved: [{ index: 0, kind: 'error' }], ccr_hash: 'h1' },
  ];
  const out = buildEpisodeContent(OBS, 'sess', 5, signals);
  assert.ok(out.includes('## Tool signals'));
  assert.ok(out.includes('Bash'));
  assert.ok(out.includes('h1'));     // ccr_hash retrievability marker present
  assert.ok(out.includes('7'));      // dropped_count surfaced
});

test('AC-5b containment: a preserved error verdict (with its index) appears in the section', () => {
  const signals = [
    { tool: 'Bash', retained: '1 retained', dropped_count: 0,
      preserved: [{ index: 3, kind: 'error' }], ccr_hash: 'h2' },
  ];
  const out = buildEpisodeContent(OBS, 'sess', 5, signals);
  const section = out.slice(out.indexOf('## Tool signals'));
  assert.ok(section.includes('error'));  // preserved error kind ⊆ section
  assert.ok(section.includes('3'));      // its original row index is named ⇒ row identifiable
});
