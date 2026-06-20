'use strict';

/**
 * findings-buffer.js — the session-scoped acted-on-findings buffer (PRD FR-F2/FR-F3,
 * DIO-14 Stop episodic-capture producer).
 *
 * DIO-14's Stop trigger records WHICH FINDINGS WERE ACTED ON in a session and feeds
 * the EXISTING background episodic-capture worker — it does not replace it. The
 * coupling is "one path, two inputs" (FR-F3): the Stop worker already reads the
 * transcript; this buffer is a SECOND input it can read, decoupled from the producer
 * by the buffer file itself (the exact decoupling capture-queue/ uses — no race, no
 * dedup machinery, which is DIO-18's concern, not built here).
 *
 * AC-4 (THE load-bearing guarantee): every record written here is `promoted: false`,
 * and the buffer dir is a sibling of capture-queue/ under ~/.claude-data — a path the
 * observations indexer's classify() returns null for (it only indexes agent/,
 * context/, projects/, episodes/). So a buffer entry can NEVER become an observations
 * row and is NEVER promoted memory. The guarantee is STRUCTURAL (path position),
 * not prose: see mcp/src/indexer.ts classify() — anything outside those four
 * subtrees, and the archive/ prefix, is excluded.
 *
 * This module writes ONLY the buffer. It does not write episodes, does not call the
 * Haiku summarizer, and does not touch session-observer-worker.js (the consumer side
 * / `## Tool signals` episode section is DIO-18's lane). DIO-14 ships the producer +
 * its registration; the worker that will consume the buffer lands in a later unit
 * (nothing reads it yet).
 *
 * Determinism: the buffer line's content is a pure function of its inputs. The append
 * order is the session's natural order. No Date.now()/Math.random() participates in
 * the RECORD payload (a caller may pass a timestamp, but it is an explicit argument,
 * never generated here) — so replaying the same findings produces byte-identical lines.
 */

const { appendFileSync, mkdirSync, existsSync, readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const { safeString } = require('./observation.js');

// Sibling of capture-queue/ — same indexer-excluded class. NEVER under episodes/,
// context/, projects/, or agent/ (the only indexed subtrees).
const FINDINGS_BUFFER_DIR = join(homedir(), '.claude-data', 'findings-buffer');

function safeId(sessionId) {
  return (String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') || 'noid').slice(0, 64);
}

function bufferPath(sessionId, dir = FINDINGS_BUFFER_DIR) {
  return join(dir, safeId(sessionId) + '.jsonl');
}

/**
 * Normalize one acted-on finding into the buffer record shape. The record is the
 * compressed SIGNAL of what the session acted on, not a raw dump:
 *   { finding_id, summary, call_path, acted_on, promoted }
 * `promoted` is ALWAYS false — hard-coded here, not caller-supplied, so no path can
 * write a promoted:true buffer record (AC-4). Free-text fields go through safeString
 * (the project's canonical sanitizer: strips control chars incl. newlines, collapses
 * whitespace) so no field can inject a line break into the JSONL stream.
 */
function toRecord(finding) {
  const f = finding && typeof finding === 'object' ? finding : {};
  return {
    finding_id: safeString(f.finding_id || f.id || f.rule_id, 128),
    summary: safeString(f.summary, 1000),
    call_path: Array.isArray(f.call_path)
      ? f.call_path.map((s) => safeString(s, 256)).filter(Boolean).slice(0, 64)
      : [],
    acted_on: f.acted_on === true,
    // AC-4: hard invariant — a buffer record is NEVER promoted. Not caller-supplied.
    promoted: false,
  };
}

/**
 * Append acted-on findings for a session to its buffer file (one JSONL line each).
 * The buffer is append-only within a session and consumed/evicted by the worker side
 * (DIO-18); DIO-14 only produces.
 *
 * Returns { written } = number of lines appended. A non-array/empty `findings`, or a
 * set with nothing actually acted on, writes nothing (no empty line, no file churn).
 * All I/O is wrapped so a buffer write can never crash the Stop hook — a failed
 * capture must not break session close.
 */
function appendFindings(
  sessionId,
  findings,
  { dir = FINDINGS_BUFFER_DIR, append = appendFileSync, mkdir = mkdirSync } = {},
) {
  if (!Array.isArray(findings) || findings.length === 0) return { written: 0 };

  // Record only findings actually acted on — the criterion is "which findings were
  // ACTED ON in the session", not every finding surfaced.
  const records = findings.map(toRecord).filter((r) => r.acted_on);
  if (records.length === 0) return { written: 0 };

  const path = bufferPath(sessionId, dir);
  try {
    mkdir(dirname(path), { recursive: true });
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    append(path, lines, 'utf8');
    return { written: records.length };
  } catch {
    return { written: 0 };
  }
}

/**
 * Read back a session's buffered records (for tests / the consumer). Returns [] when
 * the buffer is absent or unreadable. Skips malformed lines (mirrors the worker's
 * tolerant parse posture).
 */
function readFindings(
  sessionId,
  { dir = FINDINGS_BUFFER_DIR, read = readFileSync, exists = existsSync } = {},
) {
  const path = bufferPath(sessionId, dir);
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

module.exports = {
  FINDINGS_BUFFER_DIR,
  bufferPath,
  toRecord,
  appendFindings,
  readFindings,
};
