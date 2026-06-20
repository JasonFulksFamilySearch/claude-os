'use strict';

/**
 * precompact-graph-staleness.js — PreCompact lifecycle hook (PRD FR-F1 / DIO-14).
 *
 * Claude Code fires PreCompact right before it compacts the context window. A
 * compaction loses the in-context view of the repo, so this is the moment to make
 * sure the on-demand code-graph artifact (mcp/src/.dioscuri/graph/graph.json, DIO-9)
 * still matches the working tree — a stale graph that survives a compact would answer
 * later reach/contract queries against an out-of-date index with no signal that it
 * drifted.
 *
 * Staleness is detected by comparing the artifact's build-commit stamp against the
 * working tree's HEAD:
 *   - stamp === HEAD  → fresh → no-op (cheap: one git call + one small file read).
 *   - stamp !== HEAD  → HEAD moved → rebuild via `npm run graph:build` so the next
 *     query sees a current graph.
 *   - no artifact yet → nothing to keep fresh; do NOT build here (a PreCompact is not
 *     the place to do a first-ever build — the operator runs graph:build to opt in).
 *
 * AC-4 (no write-back to promoted memory): the only write this hook can cause is a
 * rebuild of the THROWAWAY, indexer-excluded .dioscuri/graph/ artifact (per-repo,
 * rebuildable, never an observations row). It never touches promoted memory, the
 * observations corpus, or scoring weights. This is the AC-4 carve-out the PRD names
 * explicitly (the throwaway-index rebuild on stale-detect).
 *
 * Reversibility (PRD §1): removing this entry from CANONICAL_HOOKS fully disables the
 * staleness check — a settings registration, no residue.
 *
 * Determinism: the only non-deterministic inputs are git HEAD and the artifact stamp,
 * both of which are facts about the repo, not generated values. There is no Date.now()
 * / Math.random() in the decision path — the staleness verdict is a pure function of
 * (stamp, head, artifactExists), so a replay over the same repo state is identical.
 */

const { readFileSync, existsSync } = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const { join, resolve, dirname } = require('node:path');

// Repo root = three levels up from hooks/ ... no: this hook ships installed at
// ~/.claude-os/hooks/, but the graph it keeps fresh is the AUDITED repo's graph,
// rooted at the session cwd. The cwd is the repo an agent is working in, so the
// artifact + git HEAD are both read relative to it. Falls back to process.cwd().
function repoRootFromCwd(cwd) {
  return resolve(cwd || process.cwd());
}

// The artifact lives at <repoRoot>/<GRAPH_TARGET_REL>/.dioscuri/graph/. The per-build
// sidecar graph.meta.json carries build_commit (echoed from graph.json) — read the
// sidecar rather than the (potentially large) graph.json: it is the dedicated
// provenance file and parsing it is cheap. graph.json is the authoritative stamp, but
// the sidecar echoes the same value at the same write (graph/artifact-io.ts
// writeArtifact), so for staleness the sidecar is sufficient and falls back to
// graph.json if absent.
//
// GRAPH_TARGET_REL must AGREE with the builder's default target, or the read here and
// the rebuild's write diverge and staleness never fires. SOURCE OF TRUTH:
// mcp/src/scripts/graph-build.ts:74 defaults `targetRel = "mcp/src"`, and
// graph/artifact-io.ts writeArtifact emits to <target>/.dioscuri/graph/. The rebuild
// below runs `npm run graph:build` with NO arg, so it writes to this same
// mcp/src/.dioscuri/graph/ — read and write must point at the identical place.
// (Hardcoded rather than imported: the builder default lives in a CLI-only TS/ESM
// constant the CommonJS hook cannot import without a build step; this comment keeps the
// coupling greppable. Search "graph-build.ts:74" to find both ends.)
const GRAPH_TARGET_REL = join('mcp', 'src');
const GRAPH_DIR = join('.dioscuri', 'graph');
const META_FILE = 'graph.meta.json';
const GRAPH_FILE = 'graph.json';

function metaPath(repoRoot) {
  return join(repoRoot, GRAPH_TARGET_REL, GRAPH_DIR, META_FILE);
}
function graphPath(repoRoot) {
  return join(repoRoot, GRAPH_TARGET_REL, GRAPH_DIR, GRAPH_FILE);
}

/**
 * Read the artifact's recorded build-commit, or null if no artifact exists. Reads the
 * sidecar first (cheap), then graph.json (authoritative) as a fallback. A malformed
 * file yields null (treated as "no usable stamp" — see decideStaleness: that means a
 * present-but-unreadable artifact does NOT trigger a rebuild here, it is simply
 * skipped, because we cannot prove it is stale; the operator's graph:build owns
 * repair of a corrupt artifact).
 */
function readArtifactCommit(repoRoot, { read = readFileSync, exists = existsSync } = {}) {
  for (const p of [metaPath(repoRoot), graphPath(repoRoot)]) {
    if (!exists(p)) continue;
    try {
      const parsed = JSON.parse(read(p, 'utf8'));
      if (parsed && typeof parsed.build_commit === 'string' && parsed.build_commit) {
        return parsed.build_commit;
      }
    } catch {
      // Unparseable file — fall through to the next candidate, else null.
    }
  }
  return null;
}

/**
 * Read the working tree's HEAD commit, or null if cwd is not a git repo / git is
 * unavailable. Mirrors builder.ts readBuildCommit's posture: stderr ignored so a
 * non-repo dir does not print git's fatal to the console.
 */
function readHeadCommit(repoRoot, { exec = execFileSync } = {}) {
  try {
    return exec('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pure staleness verdict. Returns one of:
 *   'rebuild'  — artifact exists, its stamp differs from HEAD → rebuild.
 *   'fresh'    — artifact exists and its stamp equals HEAD → no-op.
 *   'no-artifact' — no usable artifact → no-op (do not first-build on PreCompact).
 *   'no-head'  — HEAD unknown (not a git repo) → no-op (cannot judge staleness).
 *
 * Pure: a function of (artifactCommit, headCommit) only — no I/O, no clock, no random.
 * The special value 'unknown' (builder.ts uses it when git is unavailable AT BUILD
 * time) is treated as a non-matching stamp: an artifact stamped 'unknown' against a
 * real HEAD is rebuilt so we never keep an un-stamped graph past a compact.
 */
function decideStaleness(artifactCommit, headCommit) {
  if (headCommit == null) return 'no-head';
  if (artifactCommit == null) return 'no-artifact';
  return artifactCommit === headCommit ? 'fresh' : 'rebuild';
}

/**
 * Locate the mcp/ package dir under the repo root so the rebuild runs `npm run
 * graph:build` from the right place. The graph:build script defaults its target to
 * mcp/src and resolves the repo root itself, so we only need to run npm from mcp/.
 * Returns null if mcp/package.json is not found (no graph tooling in this repo →
 * nothing to rebuild).
 */
function findMcpDir(repoRoot, { exists = existsSync } = {}) {
  const candidate = join(repoRoot, 'mcp');
  return exists(join(candidate, 'package.json')) ? candidate : null;
}

/**
 * Trigger a graph rebuild via `npm run graph:build`, run synchronously from the mcp/
 * package dir. PreCompact is allowed to block briefly (unlike the Stop launcher) —
 * the rebuild must finish before compaction proceeds, or a stale graph survives the
 * compact. Returns { ran, code }. Failures are swallowed (logged by npm to its own
 * stderr) so a build error never blocks the compaction itself.
 */
function rebuildGraph(repoRoot, { spawn = spawnSync, exists = existsSync } = {}) {
  const mcpDir = findMcpDir(repoRoot, { exists });
  if (!mcpDir) return { ran: false, code: null };
  try {
    const res = spawn('npm', ['run', 'graph:build'], {
      cwd: mcpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return { ran: true, code: res.status };
  } catch {
    return { ran: false, code: null };
  }
}

/**
 * The full check: read both stamps, decide, and rebuild iff stale. Returns the
 * verdict and whether a rebuild was triggered. Injectable deps keep it unit-testable
 * without a real git repo or a real npm run.
 */
function checkAndRebuild(repoRoot, deps = {}) {
  const artifactCommit = readArtifactCommit(repoRoot, deps);
  const headCommit = readHeadCommit(repoRoot, deps);
  const verdict = decideStaleness(artifactCommit, headCommit);

  let rebuilt = { ran: false, code: null };
  if (verdict === 'rebuild') {
    rebuilt = rebuildGraph(repoRoot, deps);
  }
  return { verdict, rebuilt, artifactCommit, headCommit };
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');

  // Safety net mirrors session-observer.js: if stdin is never closed, exit rather
  // than hang and back-pressure Claude Code's hook caller.
  const stdinTimer = setTimeout(() => {
    try { process.exit(0); } catch {}
  }, 5_000);

  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimer);
    let cwd = process.cwd();
    try {
      const data = JSON.parse(input);
      if (data && typeof data.cwd === 'string' && data.cwd) cwd = data.cwd;
    } catch { /* no/invalid stdin → use process.cwd() */ }

    try {
      checkAndRebuild(repoRootFromCwd(cwd));
    } catch { /* never fail the compaction over a staleness check */ }
    process.exit(0);
  });
}

module.exports = {
  repoRootFromCwd,
  GRAPH_TARGET_REL,
  metaPath,
  graphPath,
  readArtifactCommit,
  readHeadCommit,
  decideStaleness,
  findMcpDir,
  rebuildGraph,
  checkAndRebuild,
};

if (require.main === module) main();
