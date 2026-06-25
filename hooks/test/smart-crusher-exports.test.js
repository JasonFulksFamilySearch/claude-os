'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('../lib/smart-crusher.js');

test('smart-crusher exports the slot fractions DIO-19 needs to recompute the split', () => {
  assert.equal(sc.SCHEMA_FRACTION, 0.30);
  assert.equal(sc.RECENCY_FRACTION, 0.15);
  // already-exported surface the harness also relies on:
  assert.equal(typeof sc.classifyRows, 'function');
  assert.equal(typeof sc.kneedleBudget, 'function');
  assert.equal(typeof sc.MIN_ROWS_TO_COMPRESS, 'number');
});
