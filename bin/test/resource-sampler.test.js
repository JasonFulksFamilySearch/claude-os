'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePs, classifyProcesses } = require('../resource-sampler.js');
const { PS_TEXT } = require('./fixtures.js');

test('parsePs splits 5 fixed columns and keeps command (with spaces/JSON) intact', () => {
  const procs = parsePs(PS_TEXT);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  // header row is dropped
  assert.equal(byPid.has(2081), true);
  const cli = byPid.get(2081);
  assert.equal(cli.ppid, 12393);
  assert.equal(cli.rss, 566144);
  assert.equal(cli.command, '/Users/fulksjas/.local/bin/claude');
  // command with embedded spaces + JSON survives intact
  const daemon = byPid.get(58725);
  assert.match(daemon.command, /daemon run/);
  assert.match(daemon.command, /"pid":9553/);
});

test('classifyProcesses finds 2 interactive + 1 forked session, buckets daemon infra', () => {
  const c = classifyProcesses(parsePs(PS_TEXT));
  assert.equal(c.totals.interactive_count, 2);   // roots 2081, 78068
  assert.equal(c.totals.forked_count, 1);         // root 92394
  assert.equal(c.totals.session_count, 3);
  // exact: daemon (58725) + 2 spares (58735,58738) + forked-session pty-host parent (92062)
  assert.equal(c.totals.daemon_infra_rss_kib, 170288 + 123456 + 145312 + 64864);
});

test('classifyProcesses collapses the tsx 3-process chain into one tdd-advisor server', () => {
  const c = classifyProcesses(parsePs(PS_TEXT));
  const a = c.sessions.find((s) => s.root_pid === 2081);
  assert.equal(a.self_rss_kib, 566144);
  const names = a.mcp.map((m) => m.name).sort();
  assert.deepEqual(names, ['claude-os', 'tdd-advisor']);
  const tdd = a.mcp.find((m) => m.name === 'tdd-advisor');
  assert.deepEqual(tdd.pids.sort((x, y) => x - y), [2093, 2377, 2427]); // npm exec + tsx + node preflight
  assert.equal(tdd.rss_kib, 53168 + 39600 + 43920);
  const os = a.mcp.find((m) => m.name === 'claude-os');
  assert.equal(os.rss_kib, 457136);
  assert.equal(a.total_rss_kib, 566144 + 457136 + 53168 + 39600 + 43920);
  assert.equal(a.kind, 'interactive');
});

test('classifyProcesses excludes the sampler itself', () => {
  const c = classifyProcesses(parsePs(PS_TEXT));
  // pid 99001 runs resource-sampler.js — must not appear as a session
  const inSessions = c.sessions.some((s) => s.root_pid === 99001);
  assert.equal(inSessions, false);
});

const { buildSample } = require('../resource-sampler.js');
const fx = require('./fixtures.js');

test('buildSample produces a deterministic, well-formed row', () => {
  const row = buildSample({
    psText: fx.PS_TEXT, vmStatText: fx.VMSTAT_TEXT, swapText: fx.SWAP_TEXT,
    loadText: fx.LOADAVG_TEXT, memsizeText: fx.MEMSIZE_TEXT,
    host: 'willis', now: new Date('2026-06-09T20:55:00.000Z'),
  });
  assert.equal(row.schema, 1);
  assert.equal(row.ts, '2026-06-09T20:55:00.000Z');
  assert.equal(row.host, 'willis');
  assert.equal(row.page_size, 16384);
  assert.equal(row.sys.mem_total, 38654705664);
  assert.equal(row.sys.free_bytes, 4011 * 16384);
  assert.equal(row.sys.compressor_bytes, 130170 * 16384);
  assert.equal(row.totals.session_count, 3);
  assert.equal(row.sessions.length, 3);
  // round-trips through JSON cleanly (one line)
  assert.equal(JSON.parse(JSON.stringify(row)).schema, 1);
});

const { writeSampleLine } = require('../resource-sampler.js');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('writeSampleLine appends one JSON line per call and creates the dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsmpl-'));
  const file = join(dir, 'sub', 'resource-samples.jsonl');
  writeSampleLine(file, { schema: 1, n: 1 });
  writeSampleLine(file, { schema: 1, n: 2 });
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).n, 1);
  assert.equal(JSON.parse(lines[1]).n, 2);
});

test('classifyProcesses names only MCP servers; incidental children go to other_rss_kib', () => {
  const ps = [
    '  PID  PPID    RSS  %CPU     ELAPSED COMMAND',
    ' 500     1 500000   0.0    01:00:00 /Users/x/.local/bin/claude',
    ' 510   500 300000   0.0    01:00:00 npm exec slack-mcp-server@latest',
    ' 511   510 120000   0.0    01:00:00 /Users/x/.npm/_npx/abc/node_modules/.bin/slack-mcp-server-darwin-arm64',
    ' 520   500 200000   0.0    01:00:00 node /Users/x/.claude-os/mcp/dist/index.js',
    ' 530   500  10000   0.0    01:00:00 /usr/bin/caffeinate -i',
    ' 540   500  50000   0.0    01:00:00 node /Users/x/.local/share/claude/internal-helper.js',
  ].join('\n');
  const c = classifyProcesses(parsePs(ps));
  const s = c.sessions.find((x) => x.root_pid === 500);
  const names = s.mcp.map((m) => m.name).sort();
  assert.deepEqual(names, ['claude-os', 'slack-mcp-server']); // npx wrapper + binary collapsed; caffeinate/helper excluded
  const slack = s.mcp.find((m) => m.name === 'slack-mcp-server');
  assert.deepEqual(slack.pids.sort((a, b) => a - b), [510, 511]);
  assert.equal(slack.rss_kib, 300000 + 120000);
  // caffeinate (10000) + internal node helper (50000) are NOT MCP rows but ARE in the session total
  assert.equal(s.other_rss_kib, 10000 + 50000);
  assert.equal(s.total_rss_kib, 500000 + 300000 + 120000 + 200000 + 10000 + 50000);
});
