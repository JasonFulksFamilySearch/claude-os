'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { appendSignal, readSignals, toSignalRecord, CAPTURE_BUFFER_DIR } =
  require('../lib/capture-buffer.js');

// NOTE the REAL shapes, verified against compress() (smart-crusher.js:359 `verdicts: string[]`,
// :175-186 plain strings indexed by ORIGINAL row position): `verdicts` is a FLAT STRING ARRAY,
// not objects; `retained` is the kept-rows array. Fixtures MUST use the real shape or the
// containment test is tautological.
const SIGNAL = {
  tool: 'Bash',
  retained: [{ id: 1 }, { id: 2 }],
  dropped_count: 7,
  verdicts: ['error', 'droppable', 'boundary', 'anomaly'], // flat strings, index = original row
  originalHash: 'abc123', // envelope field; record key is ccr_hash
};

test('toSignalRecord maps originalHash → ccr_hash and a retained SUMMARY (not raw rows)', () => {
  const r = toSignalRecord(SIGNAL);
  assert.equal(r.tool, 'Bash');
  assert.equal(r.ccr_hash, 'abc123');
  assert.equal(r.dropped_count, 7);
  assert.equal(typeof r.retained, 'string'); // a summary string, never the raw row array
  assert.ok(Array.isArray(r.preserved)); // preserved = the non-droppable verdicts + their indices
});

test('toSignalRecord captures the PRESERVED verdicts (error/anomaly/boundary) with indices, AC-5b', () => {
  const r = toSignalRecord(SIGNAL);
  // index 1 is 'droppable' → excluded; indices 0/2/3 are error/boundary/anomaly → preserved.
  assert.deepEqual(r.preserved, [
    { index: 0, kind: 'error' },
    { index: 2, kind: 'boundary' },
    { index: 3, kind: 'anomaly' },
  ]);
});

test('append then read round-trips one record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capbuf-'));
  try {
    assert.deepEqual(appendSignal('sess-1', SIGNAL, { dir }), { written: 1 });
    const got = readSignals('sess-1', { dir });
    assert.equal(got.length, 1);
    assert.equal(got[0].ccr_hash, 'abc123');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identical signal ⇒ byte-identical line (determinism, AC-5c.1)', () => {
  const a = JSON.stringify(toSignalRecord(SIGNAL));
  const b = JSON.stringify(toSignalRecord(SIGNAL));
  assert.equal(a, b);
});

test('a write error never throws — returns { written: 0 }', () => {
  const boom = () => { throw new Error('disk full'); };
  assert.deepEqual(appendSignal('s', SIGNAL, { dir: '/x', append: boom }), { written: 0 });
});

test('size cap: a buffer at/over the cap skips the append (no write), #58 AC', () => {
  const MAX = 256 * 1024;
  let appendCalls = 0;
  const append = () => { appendCalls += 1; };
  const stat = () => ({ size: MAX }); // already at the cap
  assert.deepEqual(
    appendSignal('s', SIGNAL, { dir: '/x', append, mkdir: () => {}, stat }),
    { written: 0 },
  );
  assert.equal(appendCalls, 0); // the cap short-circuited before the append
});

test('size cap: under the cap still writes { written: 1 }', () => {
  let appendCalls = 0;
  const append = () => { appendCalls += 1; };
  const stat = () => ({ size: 0 }); // empty / well under the cap
  assert.deepEqual(
    appendSignal('s', SIGNAL, { dir: '/x', append, mkdir: () => {}, stat }),
    { written: 1 },
  );
  assert.equal(appendCalls, 1);
});

test('CAPTURE_BUFFER_DIR is a sibling of capture-queue (indexer-excluded)', () => {
  assert.ok(CAPTURE_BUFFER_DIR.endsWith(join('.claude-data', 'capture-buffer')));
});
