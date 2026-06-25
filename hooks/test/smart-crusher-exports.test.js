'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('../lib/smart-crusher.js');

test('smart-crusher exports the slot fractions the fidelity harness needs to recompute the split', () => {
  // Assert sane-range contract rather than exact values: the fidelity-measure module imports
  // these dynamically so a deliberate retune stays in sync automatically. Freezing 0.30/0.15
  // here would fail a valid retune while the export surface (and the measure) stayed correct.
  assert.equal(typeof sc.SCHEMA_FRACTION, 'number');
  assert.ok(Number.isFinite(sc.SCHEMA_FRACTION), 'SCHEMA_FRACTION must be finite');
  assert.ok(sc.SCHEMA_FRACTION >= 0 && sc.SCHEMA_FRACTION <= 1, 'SCHEMA_FRACTION must be in [0,1]');
  assert.equal(typeof sc.RECENCY_FRACTION, 'number');
  assert.ok(Number.isFinite(sc.RECENCY_FRACTION), 'RECENCY_FRACTION must be finite');
  assert.ok(sc.RECENCY_FRACTION >= 0 && sc.RECENCY_FRACTION <= 1, 'RECENCY_FRACTION must be in [0,1]');
  assert.ok(sc.SCHEMA_FRACTION + sc.RECENCY_FRACTION <= 1, 'SCHEMA_FRACTION + RECENCY_FRACTION must not exceed 1');
  // already-exported surface the harness also relies on:
  assert.equal(typeof sc.classifyRows, 'function');
  assert.equal(typeof sc.kneedleBudget, 'function');
  assert.equal(typeof sc.MIN_ROWS_TO_COMPRESS, 'number');
});
