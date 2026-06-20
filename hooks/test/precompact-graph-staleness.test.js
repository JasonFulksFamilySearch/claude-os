'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');
const { tmpdir } = require('node:os');

const {
  decideStaleness,
  readArtifactCommit,
  readHeadCommit,
  findMcpDir,
  rebuildGraph,
  checkAndRebuild,
  GRAPH_TARGET_REL,
  metaPath,
  graphPath,
} = require('../precompact-graph-staleness.js');

const TMP = join(tmpdir(), `precompact-test-${process.pid}`);
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Build the artifact directory at the REAL layout the builder writes to:
// <root>/mcp/src/.dioscuri/graph/. Going through metaPath() (not a hand-built
// `.dioscuri/graph` under the root) is what makes these tests exercise the defect —
// the OLD code's metaPath omitted the mcp/src segment, so a test that hand-built the
// root-level dir passed while the real layout was never read. Driving the dir off
// metaPath() ties the test to wherever the code actually looks.
function makeArtifact(root, buildCommit) {
  const meta = metaPath(root);
  mkdirSync(dirname(meta), { recursive: true });
  writeFileSync(meta, JSON.stringify({ built_at: 'whenever', build_commit: buildCommit }), 'utf8');
}

// ── decideStaleness — the pure verdict (no I/O, no clock, deterministic) ──────

test('decideStaleness: stamp differs from HEAD -> rebuild', () => {
  assert.equal(decideStaleness('aaa', 'bbb'), 'rebuild');
});

test('decideStaleness: stamp equals HEAD -> fresh (no-op)', () => {
  assert.equal(decideStaleness('abc123', 'abc123'), 'fresh');
});

test('decideStaleness: no artifact stamp -> no-artifact (do not first-build)', () => {
  assert.equal(decideStaleness(null, 'bbb'), 'no-artifact');
});

test('decideStaleness: HEAD unknown -> no-head (cannot judge)', () => {
  assert.equal(decideStaleness('aaa', null), 'no-head');
});

test('decideStaleness: an "unknown"-stamped artifact against a real HEAD rebuilds', () => {
  // builder.ts stamps "unknown" when git was unavailable at build time. Against a
  // real HEAD that is a non-match -> rebuild, so an un-stamped graph never survives.
  assert.equal(decideStaleness('unknown', 'realhead'), 'rebuild');
});

test('decideStaleness is a pure function of its two args (replay-stable)', () => {
  // Same inputs -> same verdict, every time. No hidden state.
  for (let i = 0; i < 5; i++) {
    assert.equal(decideStaleness('x', 'y'), 'rebuild');
    assert.equal(decideStaleness('x', 'x'), 'fresh');
  }
});

// ── readArtifactCommit — sidecar-first, graph.json fallback, malformed -> null ─

test('readArtifactCommit reads build_commit from the meta sidecar', () => {
  const root = join(TMP, 'sidecar');
  makeArtifact(root, 'deadbeef');
  assert.equal(readArtifactCommit(root), 'deadbeef');
});

test('readArtifactCommit falls back to graph.json when the sidecar is absent', () => {
  const root = join(TMP, 'graphonly');
  mkdirSync(dirname(graphPath(root)), { recursive: true });
  writeFileSync(graphPath(root), JSON.stringify({ build_commit: 'cafef00d', symbols: [] }), 'utf8');
  assert.equal(readArtifactCommit(root), 'cafef00d');
});

test('readArtifactCommit returns null when no artifact exists', () => {
  const root = join(TMP, 'nothing');
  mkdirSync(root, { recursive: true });
  assert.equal(readArtifactCommit(root), null);
});

// REGRESSION (QA Major / FR-F1): the artifact lives at <root>/mcp/src/.dioscuri/graph/,
// NOT root-level <root>/.dioscuri/graph/. The OLD metaPath omitted the mcp/src segment,
// so an artifact at the real (mcp/src) location read back as null → 'no-artifact' →
// rebuild never fired → a stale graph survived the compact. This asserts the read
// targets the builder's location: a sidecar placed root-level must be INVISIBLE, and
// the same stamp placed at mcp/src must be FOUND.
test('readArtifactCommit reads from mcp/src/.dioscuri/graph, not the repo root', () => {
  const root = join(TMP, 'reallayout');
  // Decoy at the OLD (wrong) root-level location — must be ignored.
  mkdirSync(join(root, '.dioscuri', 'graph'), { recursive: true });
  writeFileSync(
    join(root, '.dioscuri', 'graph', 'graph.meta.json'),
    JSON.stringify({ build_commit: 'ROOT-LEVEL-DECOY' }),
    'utf8',
  );
  assert.equal(readArtifactCommit(root), null, 'a root-level artifact must NOT be read');

  // Real artifact at the builder's location — must be found.
  makeArtifact(root, 'AT-MCP-SRC');
  assert.equal(readArtifactCommit(root), 'AT-MCP-SRC', 'the mcp/src artifact must be read');
});

test('metaPath/graphPath resolve under mcp/src (agree with graph-build.ts default)', () => {
  const root = '/repo';
  assert.equal(metaPath(root), join(root, 'mcp', 'src', '.dioscuri', 'graph', 'graph.meta.json'));
  assert.equal(graphPath(root), join(root, 'mcp', 'src', '.dioscuri', 'graph', 'graph.json'));
  assert.equal(GRAPH_TARGET_REL, join('mcp', 'src'));
});

test('readArtifactCommit returns null for a malformed sidecar (no usable stamp)', () => {
  const root = join(TMP, 'malformed');
  mkdirSync(dirname(metaPath(root)), { recursive: true });
  writeFileSync(metaPath(root), '{ not json', 'utf8');
  assert.equal(readArtifactCommit(root), null);
});

// ── readHeadCommit — injected exec, non-repo -> null ──────────────────────────

test('readHeadCommit returns the trimmed HEAD from git', () => {
  const exec = () => 'abc123\n';
  assert.equal(readHeadCommit('/any', { exec }), 'abc123');
});

test('readHeadCommit returns null when git throws (not a repo)', () => {
  const exec = () => { throw new Error('fatal: not a git repository'); };
  assert.equal(readHeadCommit('/any', { exec }), null);
});

// ── findMcpDir ────────────────────────────────────────────────────────────────

test('findMcpDir finds mcp/ when package.json is present', () => {
  const root = join(TMP, 'hasmcp');
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'package.json'), '{}', 'utf8');
  assert.equal(findMcpDir(root), join(root, 'mcp'));
});

test('findMcpDir returns null when there is no mcp/package.json', () => {
  const root = join(TMP, 'nomcp');
  mkdirSync(root, { recursive: true });
  assert.equal(findMcpDir(root), null);
});

// ── rebuildGraph — spawns npm run graph:build from mcp/, no-ops when absent ────

test('rebuildGraph runs `npm run graph:build` from mcp/ when present', () => {
  const root = join(TMP, 'rebuild');
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'package.json'), '{}', 'utf8');

  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd }); return { status: 0 }; };
  const res = rebuildGraph(root, { spawn });

  assert.equal(res.ran, true);
  assert.equal(res.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'npm');
  assert.deepEqual(calls[0].args, ['run', 'graph:build']);
  assert.equal(calls[0].cwd, join(root, 'mcp'));
});

test('rebuildGraph is a no-op (does not spawn) when there is no mcp/ package', () => {
  const root = join(TMP, 'rebuild-nomcp');
  mkdirSync(root, { recursive: true });
  let spawned = false;
  const spawn = () => { spawned = true; return { status: 0 }; };
  const res = rebuildGraph(root, { spawn });
  assert.equal(res.ran, false);
  assert.equal(spawned, false);
});

// ── checkAndRebuild — the end-to-end decision (the QA-gate scenario) ───────────

test('STALENESS->REBUILD: moving HEAD triggers a rebuild', () => {
  const root = join(TMP, 'e2e-stale');
  makeArtifact(root, 'OLD-COMMIT'); // artifact at mcp/src/.dioscuri/graph
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'package.json'), '{}', 'utf8');

  let spawned = false;
  const deps = {
    exec: () => 'NEW-COMMIT\n', // HEAD has moved past the stamp
    spawn: () => { spawned = true; return { status: 0 }; },
  };
  const res = checkAndRebuild(root, deps);

  assert.equal(res.verdict, 'rebuild');
  assert.equal(res.rebuilt.ran, true, 'a rebuild was triggered on staleness');
  assert.equal(spawned, true);
});

test('FRESH INDEX IS A NO-OP: matching stamp does not rebuild', () => {
  const root = join(TMP, 'e2e-fresh');
  makeArtifact(root, 'SAME-COMMIT'); // artifact at mcp/src/.dioscuri/graph
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'package.json'), '{}', 'utf8');

  let spawned = false;
  const deps = {
    exec: () => 'SAME-COMMIT\n',
    spawn: () => { spawned = true; return { status: 0 }; },
  };
  const res = checkAndRebuild(root, deps);

  assert.equal(res.verdict, 'fresh');
  assert.equal(res.rebuilt.ran, false, 'a fresh index never rebuilds');
  assert.equal(spawned, false, 'no npm run on a fresh index');
});

// REAL-LAYOUT INTEGRATION (mirrors QA's by-execution proof). Runs checkAndRebuild
// against the ACTUAL worktree root — the committed pilot artifact at
// mcp/src/.dioscuri/graph/ must be found (build_commit, not null). The rebuild's npm
// spawn is stubbed so the gate stays read-only and offline; HEAD is read with the real
// git. The OLD code returned 'no-artifact' here (read missed mcp/src) — this is the
// scenario that false-passed before. Skips cleanly if not run inside the worktree.
test('REAL LAYOUT: checkAndRebuild finds the committed mcp/src artifact (not null)', () => {
  const worktreeRoot = resolve(__dirname, '..', '..');
  let realStamp;
  try {
    const raw = readFileSync(metaPath(worktreeRoot), 'utf8');
    realStamp = JSON.parse(raw).build_commit;
  } catch {
    return; // pilot artifact absent in this checkout — nothing to integration-prove.
  }
  assert.equal(typeof realStamp, 'string');
  assert.ok(realStamp.length > 0, 'committed artifact carries a build_commit');

  let spawned = false;
  // Force the 'rebuild' branch (HEAD != stamp) to prove the spawn path resolves the
  // artifact AND a moved HEAD fires exactly one rebuild — without running a real build.
  const movedHead = () => `${realStamp}-MOVED\n`;
  const res = checkAndRebuild(worktreeRoot, {
    exec: movedHead,
    spawn: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(res.artifactCommit, realStamp, 'reads the real mcp/src build_commit, not null');
  assert.equal(res.verdict, 'rebuild', 'moved HEAD vs real stamp -> rebuild');
  assert.equal(spawned, true, 'exactly the rebuild path runs against the real layout');
});

// REAL-LAYOUT FRESH: stamp == real HEAD -> zero rebuilds. Uses the real artifact stamp
// as the simulated HEAD so the fresh branch is exercised end-to-end on the true paths.
test('REAL LAYOUT: a fresh artifact (stamp == HEAD) fires zero rebuilds', () => {
  const worktreeRoot = resolve(__dirname, '..', '..');
  let realStamp;
  try {
    realStamp = JSON.parse(readFileSync(metaPath(worktreeRoot), 'utf8')).build_commit;
  } catch {
    return;
  }

  let spawned = false;
  const res = checkAndRebuild(worktreeRoot, {
    exec: () => `${realStamp}\n`,
    spawn: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(res.artifactCommit, realStamp);
  assert.equal(res.verdict, 'fresh');
  assert.equal(spawned, false, 'a fresh real artifact never rebuilds');
});

// REAL-LAYOUT CORRUPT-META FAIL-SAFE at the corrected path: a malformed sidecar at
// mcp/src/.dioscuri/graph yields 'no-artifact' (null stamp), never throws, never blocks.
test('REAL LAYOUT: corrupt meta at mcp/src fails safe (no crash, no rebuild)', () => {
  const root = join(TMP, 'e2e-corrupt-reallayout');
  mkdirSync(dirname(metaPath(root)), { recursive: true });
  writeFileSync(metaPath(root), 'not json at all', 'utf8');
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'package.json'), '{}', 'utf8');

  let spawned = false;
  const res = checkAndRebuild(root, {
    exec: () => 'ANY-HEAD\n',
    spawn: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(res.artifactCommit, null, 'unparseable meta -> no usable stamp');
  assert.equal(res.verdict, 'no-artifact', 'corrupt artifact is skipped, not rebuilt');
  assert.equal(spawned, false, 'never blocks compaction over a corrupt artifact');
});

test('NO ARTIFACT IS A NO-OP: PreCompact does not first-build', () => {
  const root = join(TMP, 'e2e-noartifact');
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'package.json'), '{}', 'utf8');

  let spawned = false;
  const deps = {
    exec: () => 'ANY-COMMIT\n',
    spawn: () => { spawned = true; return { status: 0 }; },
  };
  const res = checkAndRebuild(root, deps);

  assert.equal(res.verdict, 'no-artifact');
  assert.equal(spawned, false, 'PreCompact never does a first-ever build');
});

// ── Determinism guard: no Date.now()/Math.random() in the hook source ─────────

test('DETERMINISM: no wall-clock / random in the precompact hook source', () => {
  const src = readFileSync(join(__dirname, '..', 'precompact-graph-staleness.js'), 'utf8');
  // Strip comments so a prose mention does not trip the guard (smart-crusher.test.js:52-53).
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now() in the staleness hook');
  assert.ok(!/Math\.random\s*\(/.test(code), 'no Math.random() in the staleness hook');
  assert.ok(!/new\s+Date\s*\(/.test(code), 'no new Date() in the staleness hook');
});
