'use strict';

/**
 * stop-episodic-capture.js — Stop lifecycle hook: acted-on-findings capture producer
 * (PRD FR-F2/FR-F3, DIO-14).
 *
 * Claude Code has NO PostTask event (the Gortex PRD's "PostTask" wording describes a
 * trigger that does not exist) — the episodic-capture worker is launched by the
 * existing `Stop` hook (session-observer.js). This hook is a SECOND Stop entry: at
 * session close it records WHICH FINDINGS WERE ACTED ON during the session into the
 * session-scoped findings buffer, which the background worker WILL read as a second
 * input ("one path, two inputs", FR-F3) once that consumer lands (DIO-18's lane —
 * nothing reads the buffer yet). It FEEDS that worker; it does not replace it and does
 * not itself summarize, call Haiku, or write episodes.
 *
 * Where acted-on findings come from: during a session the graph-auditor / enrich flow
 * (DIO-10/DIO-13) stages the findings it acts on into a session-scoped staging file
 * (~/.claude-data/findings-acted/<sessionId>.jsonl). DIO-14 owns only the Stop-time
 * FLUSH of that staging input into the promoted:false buffer — it produces the buffer
 * the worker will consume; it does not produce the findings themselves (that is the
 * auditor flow's lane). When no findings were staged, this is a clean no-op.
 *
 * AC-4 (load-bearing): every record written is promoted:false (enforced in
 * findings-buffer.toRecord, not caller-supplied), and the buffer dir is indexer-
 * excluded (a sibling of capture-queue/ — classify() returns null for it). No path
 * here writes promoted memory, an observations row, or the eval-gated corpus.
 *
 * Reversibility: removing this entry from CANONICAL_HOOKS disables the capture with no
 * residue — a settings registration.
 *
 * Fast + detached, mirroring session-observer.js: reads the hook JSON, does the cheap
 * buffer flush, and exits. The flush is local file I/O (no network, no model), so it
 * runs inline rather than detaching a worker — it is bounded and quick.
 *
 * Determinism: the record payload is a pure function of the staged findings
 * (findings-buffer.toRecord). No Date.now()/Math.random() enters any written record,
 * so a replay over the same staged findings yields a byte-identical buffer.
 */

const { readFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { appendFindings } = require('./lib/findings-buffer.js');

// Session-scoped staging input the in-session auditor/enrich flow writes to. Also
// indexer-excluded (sibling of capture-queue/). DIO-14 reads it at Stop and flushes
// it into the promoted:false buffer; producing its contents is the auditor's lane.
const FINDINGS_ACTED_DIR = join(homedir(), '.claude-data', 'findings-acted');

function safeId(sessionId) {
  return (String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') || 'noid').slice(0, 64);
}

function stagingPath(sessionId, dir = FINDINGS_ACTED_DIR) {
  return join(dir, safeId(sessionId) + '.jsonl');
}

/**
 * Read the staged acted-on findings for a session. Returns [] when nothing was staged
 * (the common case — a session with no graph findings acted on) or on any read error.
 * Skips malformed lines. Pure read; does not delete.
 *
 * `dir` is the STAGING dir (the auditor flow's input); it is deliberately distinct
 * from the buffer dir appendFindings writes to (see captureSession).
 */
function readStaged(sessionId, { dir = FINDINGS_ACTED_DIR, read = readFileSync, exists = existsSync } = {}) {
  const path = stagingPath(sessionId, dir);
  if (!exists(path)) return [];
  let raw;
  try { raw = read(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Flush a session's staged acted-on findings into the promoted:false buffer, then
 * clear the staging file (the staging input is session-scoped and consumed once at
 * Stop). Returns { written }.
 *
 * The staging dir (input) and the buffer dir (output) are SEPARATE surfaces, so the
 * injectable deps name them separately:
 *   - `stagingDir` → where readStaged reads (default ~/.claude-data/findings-acted/)
 *   - `bufferDir`  → where appendFindings writes (default the findings-buffer/ dir)
 * Both default to the real dirs; tests pass temp dirs. (`read`/`exists`/`append`/
 * `mkdir`/`rm` are also injectable for pure unit testing.)
 *
 * AC-4 is preserved by construction: appendFindings only ever writes promoted:false
 * records to the indexer-excluded buffer; the staging clear removes a non-indexed
 * file. Nothing here can reach promoted memory or the observations corpus.
 */
function captureSession(sessionId, deps = {}) {
  const { stagingDir, bufferDir, rm = rmSync, ...io } = deps;
  const staged = readStaged(sessionId, { ...io, dir: stagingDir });
  const res = appendFindings(sessionId, staged, { ...io, dir: bufferDir });
  // Clear staging so a re-fired Stop on the same session does not double-append.
  // (This is not dedup machinery — it is session-scoped consume-once, the same
  // lifetime capture-queue uses; cross-input dedup is DIO-18's concern.)
  if (res.written > 0) {
    try { rm(stagingPath(sessionId, stagingDir), { force: true }); } catch { /* best effort */ }
  }
  return res;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');

  const stdinTimer = setTimeout(() => {
    try { process.exit(0); } catch {}
  }, 5_000);

  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimer);
    let sessionId = null;
    try {
      const data = JSON.parse(input);
      // stop_hook_active guard mirrors session-observer.js: skip if another Stop
      // hook already set the flag (avoids reentrancy churn).
      if (data && data.stop_hook_active) process.exit(0);
      if (data && typeof data.session_id === 'string') sessionId = data.session_id;
    } catch { /* no/invalid stdin → nothing to capture */ }

    if (sessionId) {
      try { captureSession(sessionId); } catch { /* capture must never break session close */ }
    }
    process.exit(0);
  });
}

module.exports = {
  FINDINGS_ACTED_DIR,
  stagingPath,
  readStaged,
  captureSession,
};

if (require.main === module) main();
