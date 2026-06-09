'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVmStat, parseSwapusage, parseLoadavg, parseMemsize } = require('../resource-stats.js');
const { VMSTAT_TEXT, SWAP_TEXT, LOADAVG_TEXT, MEMSIZE_TEXT } = require('./fixtures.js');

test('parseVmStat reads page size from header, never hardcodes', () => {
  const v = parseVmStat(VMSTAT_TEXT);
  assert.equal(v.page_size, 16384);
  assert.equal(v.pages_free, 4011);
  assert.equal(v.pages_occupied_by_compressor, 130170);
  assert.equal(v.c_swapouts, 14430430);
  assert.equal(v.c_pageouts, 185622);
  assert.equal(v.c_compressions, 189157028);
});

test('parseVmStat tolerates a missing counter as null, never throws', () => {
  const v = parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.');
  assert.equal(v.pages_free, 10);
  assert.equal(v.c_swapouts, null);
});

test('parseSwapusage parses MB fields', () => {
  const s = parseSwapusage(SWAP_TEXT);
  assert.equal(s.swap_total_mb, 4096);
  assert.equal(s.swap_used_mb, 2648);
  assert.equal(s.swap_free_mb, 1448);
});

test('parseLoadavg parses the three averages', () => {
  assert.deepEqual(parseLoadavg(LOADAVG_TEXT), { load1: 4.80, load5: 5.64, load15: 5.66 });
});

test('parseMemsize parses total bytes', () => {
  assert.equal(parseMemsize(MEMSIZE_TEXT), 38654705664);
});
