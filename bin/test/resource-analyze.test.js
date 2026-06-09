'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSamples, linearRegression } = require('../resource-analyze.js');

test('parseSamples ignores blank lines and bad JSON, keeps valid rows', () => {
  const text = '{"schema":1,"ts":"t1"}\n\n{bad}\n{"schema":1,"ts":"t2"}\n';
  const rows = parseSamples(text);
  assert.equal(rows.length, 2);
});

test('linearRegression recovers slope and intercept', () => {
  const r = linearRegression([[1, 3], [2, 5], [3, 7]]); // y = 2x + 1
  assert.ok(Math.abs(r.slope - 2) < 1e-9);
  assert.ok(Math.abs(r.intercept - 1) < 1e-9);
  assert.ok(Math.abs(r.r2 - 1) < 1e-9);
});

const { detectSwapOnset } = require('../resource-analyze.js');

function row(sessions, swapouts) {
  return { totals: { session_count: sessions }, sys: { c_swapouts: swapouts, c_decompressions: 0 } };
}

test('detectSwapOnset finds onset at the session count of a sustained swapping window', () => {
  // swapouts rise for 3 consecutive deltas at session_count 5 → onset observed at 5
  const rows = [row(3, 100), row(4, 100), row(5, 110), row(5, 130), row(5, 150), row(5, 170)];
  const o = detectSwapOnset(rows, { minWindow: 3 });
  assert.equal(o.observed, true);
  assert.equal(o.onset_session_count, 5);
});

test('detectSwapOnset reports not-observed when swap never rises', () => {
  const rows = [row(2, 100), row(3, 100), row(4, 100), row(5, 100)];
  const o = detectSwapOnset(rows, { minWindow: 3 });
  assert.equal(o.observed, false);
  assert.equal(o.onset_session_count, null);
});

const { perMcpCost, biggestLever } = require('../resource-analyze.js');

const sample = (mcps) => ({ totals: { session_count: 1 }, sessions: [{ mcp: mcps }] });

test('perMcpCost averages rss per live server over the recent window', () => {
  const rows = [
    sample([{ name: 'claude-os', rss_kib: 400000 }, { name: 'tdd-advisor', rss_kib: 130000 }]),
    sample([{ name: 'claude-os', rss_kib: 600000 }, { name: 'tdd-advisor', rss_kib: 170000 }]),
  ];
  const cost = perMcpCost(rows);
  const os = cost.find((c) => c.name === 'claude-os');
  assert.equal(os.mean_kib, 500000);
  assert.equal(os.n, 2);
});

test('perMcpCost excludes servers absent from the latest sample (current footprint, not all-time)', () => {
  const rows = [
    sample([{ name: 'claude-os', rss_kib: 400000 }, { name: 'npx-oneoff', rss_kib: 90000 }]),
    sample([{ name: 'claude-os', rss_kib: 600000 }]), // npx-oneoff gone from the latest sample
  ];
  const names = perMcpCost(rows).map((c) => c.name);
  assert.deepEqual(names, ['claude-os']); // dead one-off server aged out, no spurious row
});

test('biggestLever names the top aggregate contributor', () => {
  const rows = [sample([{ name: 'claude-os', rss_kib: 500000 }, { name: 'tdd-advisor', rss_kib: 150000 }])];
  assert.equal(biggestLever(rows).name, 'claude-os');
});

const { projectCeiling, buildReport, renderMarkdown } = require('../resource-analyze.js');

test('projectCeiling uses observed swap-onset as primary, marks it observed', () => {
  const onset = { observed: true, onset_session_count: 5 };
  const c = projectCeiling({ onset, slope_kib: 1200000, intercept_kib: 800000, mem_total: 38654705664 });
  assert.equal(c.ceiling, 5);
  assert.equal(c.basis, 'observed-swap-onset');
});

test('projectCeiling falls back to slope projection when onset not observed', () => {
  const onset = { observed: false, onset_session_count: null };
  // intercept 0.8GB, slope 1.2GB/session, free_floor 2GB on 36GB → N* ~ (36-2-0.8)/1.2
  const c = projectCeiling({ onset, slope_kib: 1200000, intercept_kib: 800000, mem_total: 38654705664, free_floor_bytes: 2 * 1024 ** 3 });
  assert.equal(c.basis, 'extrapolated-rss');
  assert.ok(c.ceiling >= 25 && c.ceiling <= 30);
});

test('buildReport + renderMarkdown produce the six labelled sections', () => {
  const rows = parseSamples('{"schema":1,"ts":"t","host":"willis","page_size":16384,'
    + '"sys":{"mem_total":38654705664,"free_bytes":1,"available_bytes":1,"c_swapouts":1,"c_decompressions":1,'
    + '"swap_used_mb":2648,"load1":4.8},'
    + '"totals":{"session_count":2,"interactive_count":2,"forked_count":0,"claude_rss_kib":2000000,"daemon_infra_rss_kib":440000,"proc_count":700},'
    + '"sessions":[{"root_pid":1,"kind":"interactive","total_rss_kib":1000000,"mcp":[{"name":"claude-os","rss_kib":500000}]}]}');
  const md = renderMarkdown(buildReport(rows));
  for (const h of ['Snapshot', 'Baseline', 'Per-MCP', 'Headroom', 'lever', 'Data health']) {
    assert.match(md, new RegExp(h, 'i'));
  }
});
