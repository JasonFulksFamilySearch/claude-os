'use strict';

/**
 * capture-buffer.js — the FR-B5 tool-signal buffer (DIO-18 producer storage).
 *
 * Mirrors lib/findings-buffer.js, but for a DIFFERENT signal: the compressed
 * tool-output SIGNAL SUMMARY, not acted-on graph findings. Kept as a separate
 * buffer (separate dir, separate record shape) so findings-buffer's AC-4 proof
 * stays single-shape (PRD ID-1).
 *
 * AC-4 / no-write-back: CAPTURE_BUFFER_DIR is a sibling of capture-queue/ under
 * ~/.claude-data — outside the four indexed subtrees, so the observations indexer's
 * classify() returns null for it. A buffer line can NEVER become an observations row.
 *
 * Determinism (AC-5c.1): the record is a pure function of its inputs. No Date.now()/
 * Math.random() participates — replaying the same signal yields a byte-identical line.
 *
 * Field name: the ticket's contract key is `ccr_hash`; the live envelope field is
 * `originalHash` (smart-crusher / buildCompressedEnvelope). toSignalRecord maps
 * originalHash → ccr_hash so the buffer honors the ticket's contract name.
 */

const { appendFileSync, mkdirSync, existsSync, readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const { safeString } = require('./observation.js');

// Sibling of capture-queue/ — same indexer-excluded class. NEVER under episodes/,
// context/, projects/, or agent/ (the only indexed subtrees).
const CAPTURE_BUFFER_DIR = join(homedir(), '.claude-data', 'capture-buffer');

function safeId(sessionId) {
  return (String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') || 'noid').slice(0, 64);
}

function bufferPath(sessionId, dir = CAPTURE_BUFFER_DIR) {
  return join(dir, safeId(sessionId) + '.jsonl');
}

// A compact, deterministic summary of the retained rows — count + tool, never the
// raw row array (signal, not dump). safeString guarantees no newline can break JSONL.
function retainedSummary(signal) {
  const n = Array.isArray(signal.retained) ? signal.retained.length : 0;
  return safeString(`${n} retained`, 200);
}

// The preservation set (AC-5b): compress()'s verdicts is a FLAT STRING ARRAY indexed by
// original row position (smart-crusher.js:359, :175-186). The non-`droppable` entries are
// the error/anomaly/boundary rows the preserve-first rule kept; we record each kind WITH its
// original index so the episode section can name exactly which rows were preserved and why.
// This is the containment evidence — counts alone would NOT satisfy US-6.
const PRESERVED_KINDS = new Set(['error', 'anomaly', 'boundary']);
function preservedVerdicts(signal) {
  const v = Array.isArray(signal.verdicts) ? signal.verdicts : [];
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const kind = safeString(v[i], 32);
    if (PRESERVED_KINDS.has(kind)) out.push({ index: i, kind });
  }
  return out;
}

function toSignalRecord(signal) {
  const s = signal && typeof signal === 'object' ? signal : {};
  return {
    tool: safeString(s.tool, 128),
    retained: retainedSummary(s),
    dropped_count: Number.isFinite(s.dropped_count) ? s.dropped_count : 0,
    // AC-5b: the preserved (non-droppable) verdict kinds + their original indices, derived
    // from compress()'s flat string `verdicts` array — the containment evidence.
    preserved: preservedVerdicts(s),
    // ticket contract key `ccr_hash` ← live envelope field `originalHash`.
    ccr_hash: safeString(s.originalHash, 128),
  };
}

function appendSignal(
  sessionId,
  signal,
  { dir = CAPTURE_BUFFER_DIR, append = appendFileSync, mkdir = mkdirSync } = {},
) {
  const rec = toSignalRecord(signal);
  const path = bufferPath(sessionId, dir);
  try {
    mkdir(dirname(path), { recursive: true });
    append(path, JSON.stringify(rec) + '\n', 'utf8');
    return { written: 1 };
  } catch {
    return { written: 0 }; // a buffer write can never crash the tool call
  }
}

function readSignals(
  sessionId,
  { dir = CAPTURE_BUFFER_DIR, read = readFileSync, exists = existsSync } = {},
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
  CAPTURE_BUFFER_DIR,
  bufferPath,
  toSignalRecord,
  appendSignal,
  readSignals,
};
