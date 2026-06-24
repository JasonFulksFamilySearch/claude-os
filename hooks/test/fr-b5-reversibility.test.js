'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { buildEpisodeContent } = require('../session-observer-worker.js');
const { CAPTURE_BUFFER_DIR } = require('../lib/capture-buffer.js');

const OBS = { summary: 's', decisions: ['d1'], corrections: [], discoveries: [], files_of_note: [] };

// A FROZEN golden snapshot of the pre-feature episode bytes for OBS — captured from the
// 3-arg builder BEFORE this feature existed. Comparing the OFF path to this literal (not to
// another call of the same new code) is what makes the test non-tautological: if any task
// regresses the OFF path's bytes, this literal no longer matches. If buildEpisodeContent's
// pre-existing format legitimately changes for another reason, update this snapshot deliberately.
// Byte-exact trace of buildEpisodeContent(OBS,'sess',4): fmLines.join('\n') ends with
// "...promoted: false\n---\n" (the trailing '' element yields exactly ONE \n after ---,
// NO blank line), then sections.join('\n\n') = "## Summary\ns\n\n## Decisions\n- d1",
// then a final '\n'. (session-observer-worker.js:111-138.)
const PRE_FEATURE_GOLDEN =
  '---\n' +
  'date: ' + require('../lib/episode-utils.js').todayLocal() + '\n' +
  'session_id: sess\n' +
  'turns: 4\n' +
  'promoted: false\n' +
  '---\n' +
  '## Summary\n' +
  's\n' +
  '\n' +
  '## Decisions\n' +
  '- d1\n';

test('AC-5c.2: flag-off path (no signals) is byte-identical to the FROZEN pre-feature golden', () => {
  // OFF path = no toolSignals. Must equal the frozen pre-feature bytes, AND equal the
  // 3-arg call (proving the new default param is inert).
  const offPath = buildEpisodeContent(OBS, 'sess', 4, []);
  assert.equal(offPath, PRE_FEATURE_GOLDEN);          // non-tautological: vs frozen literal
  assert.equal(offPath, buildEpisodeContent(OBS, 'sess', 4)); // 4th-arg default is inert
});

test('AC-5c.2 negative control: the golden has NO Tool signals section', () => {
  assert.ok(!PRE_FEATURE_GOLDEN.includes('## Tool signals'));
});

test('AC-4: CAPTURE_BUFFER_DIR is outside every indexed subtree', () => {
  const indexed = ['agent', 'context', 'projects', 'episodes'].map((s) => join('.claude-data', s));
  for (const sub of indexed) {
    assert.ok(!CAPTURE_BUFFER_DIR.includes(sub),
      `capture-buffer must not be under ${sub}`);
  }
  assert.ok(CAPTURE_BUFFER_DIR.endsWith(join('.claude-data', 'capture-buffer')));
});
