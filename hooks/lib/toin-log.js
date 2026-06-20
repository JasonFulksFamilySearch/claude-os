'use strict';

/**
 * toin-log.js — TOIN-style retrieval/observability SIGNAL log (DIO-15 / FR-G1).
 *
 * WHAT THIS IS. A single, append-only, structured signal sink for the three machine
 * events DIO-15 makes observable:
 *   - CCR retrieval events            (ccr-retrieve.js — which store served a hash, hit/miss)
 *   - graph-staleness verdicts        (precompact-graph-staleness.js — fresh/rebuild/...)
 *   - enrich fire-volume              (injection-enrich.js — the additionalContext token-cost
 *                                      guard: how often enrich fires and how much it injects)
 *
 * ── SIGNAL ONLY — THE WHOLE POINT (FR-G1) ─────────────────────────────────────
 * This module WRITES observability records and NOTHING ELSE. It never reads a record back,
 * never mutates ranking weights, never touches memory.db, never bumps access_stats, never
 * changes behaviour. Emitting a record cannot, by construction, feed back into a decision:
 * there is no read path here at all. That is what makes DIO-15 "observability without any
 * behaviour change."
 *
 * ── THE LOG→WEIGHT LOOP IS GATED BY CONSTRUCTION (Gate-3 hardening) ────────────
 * The danger DIO-15 must foreclose is NOT this write — it is a FUTURE step that READS this
 * log to re-tune the six-factor weights outside the human gate. This module makes that
 * structurally impossible from its own side: it imports NO ranking/weights module
 * (injection-ranking.js, mcp/src/search_config.ts, mcp/src/ranking.ts), exposes NO reader,
 * and returns nothing a caller could route into a weight. The accompanying audit test
 * (hooks/lib/test/toin-log.test.js) scans every runtime module for ANY write to the six-factor
 * WEIGHTS / search_config weights and asserts ZERO such paths — the proof that the loop is
 * closed by construction, not convention.
 *
 * ── SINK: OFF THE EVAL-GATED SURFACE (AC, FR-G1 sink rule) ────────────────────
 * Records go to ~/.claude-data/.logs/mcp-server.log — the same file sink mcp/src/logger.ts
 * uses. That path is PROVABLY off-corpus: the indexer walks only agent/, context/, projects/,
 * episodes/ (and excludes archive/); indexer.classify() returns null for anything under
 * .logs/. So a TOIN record can NEVER become an `observations` row and never enters the
 * retrieval eval surface. The test runs the REAL indexer.classify() against this path and
 * asserts null. It is a plain file append — no FTS trigger, no sqlite-vec, no memory.db.
 *
 * ── SELF-PROVISIONING (project CLAUDE.md machine-setup rule) ───────────────────
 * The sink dir is created on first write (mkdirSync recursive), exactly as mcp/src/logger.ts
 * does at module load. So emission never depends on update.sh having reached a particular
 * step on a fresh machine — there is no manual setup step to forget.
 *
 * ── REVERSIBLE + APPEND-ONLY (AC: disabling stops emission, no state change) ───
 * Setting DIOSCURI_TOIN_LOG_DISABLED=1 (or passing { enabled: false }) makes every emit a
 * no-op. Disabling changes NO state: the log is append-only and nothing reads it, so an
 * absent log is indistinguishable from a never-written one to every other code path.
 *
 * ── DETERMINISM (foundation convention) ───────────────────────────────────────
 * The record builders (buildRetrievalRecord / buildStalenessRecord / buildEnrichRecord) are
 * PURE functions of their inputs — no Date.now(), no Math.random(). The ONLY clock read is
 * the log line's own wall-clock `ts`, taken at WRITE time inside `emit()`; that timestamp is
 * a log fact, never an input to any deterministic computation (it is not returned to the
 * caller and not part of any signal the builders compute). A caller that needs a deterministic
 * record can pass an explicit `ts` and the writer will honour it.
 */

const { appendFileSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { homedir } = require('node:os');

// The file sink — identical to mcp/src/logger.ts DEFAULT_LOG_PATH so TOIN signal lands in the
// one operator-known log, and shares its proven-off-corpus location (.logs/, classify() → null).
const DEFAULT_LOG_PATH = join(homedir(), '.claude-data', '.logs', 'mcp-server.log');

// The env kill-switch. Set to '1' to disable all emission (reversibility floor: no emission,
// no state change). The constructor's `enabled` option overrides it for tests.
const DISABLE_ENV = 'DIOSCURI_TOIN_LOG_DISABLED';

// The canonical event-type tags. Frozen so a typo in an emit call is a missing-export error,
// not a silently-misclassified record.
const EVENT_TYPES = Object.freeze({
  RETRIEVAL: 'ccr_retrieval',
  STALENESS: 'graph_staleness',
  ENRICH: 'enrich_fire',
});

// ── Pure record builders (deterministic — no clock, no random) ────────────────

/**
 * A CCR retrieval signal record. Logs that a retrieve happened and which store (if any)
 * served it — fire-volume + store-hit distribution for observability. It records the HASH
 * (the retrieve key) and the resolving store, NOT the served payload: this is signal about
 * the access, never a copy of memory content.
 *
 * @param {object} r a ccr-retrieve result: { found, store?, hash, reason? }
 * @returns {object} the signal payload (no clock — `emit` stamps the line)
 */
function buildRetrievalRecord(r) {
  const res = r && typeof r === 'object' ? r : {};
  return {
    event_type: EVENT_TYPES.RETRIEVAL,
    found: res.found === true,
    // The store that owned the hash (ephemeral/archive/graph) on a hit, else null.
    store: typeof res.store === 'string' ? res.store : null,
    // The retrieve key. Signal about WHICH original was asked for, not its content.
    hash: typeof res.hash === 'string' ? res.hash : null,
    // On a miss, why (malformed-hash / no-store-owns-hash / hash-mismatch-on-resolve).
    reason: typeof res.reason === 'string' ? res.reason : null,
  };
}

/**
 * A graph-staleness signal record. Logs the PreCompact staleness verdict + whether a rebuild
 * was triggered — so a graph that drifts (or rebuilds churning) is detectable.
 *
 * @param {object} c a checkAndRebuild result: { verdict, rebuilt? }
 * @returns {object} the signal payload
 */
function buildStalenessRecord(c) {
  const res = c && typeof c === 'object' ? c : {};
  const rebuilt = res.rebuilt && typeof res.rebuilt === 'object' ? res.rebuilt : {};
  return {
    event_type: EVENT_TYPES.STALENESS,
    // 'fresh' | 'rebuild' | 'no-artifact' | 'no-head' (decideStaleness verdicts).
    verdict: typeof res.verdict === 'string' ? res.verdict : null,
    rebuilt: rebuilt.ran === true,
  };
}

/**
 * An enrich fire-volume signal record — the additionalContext token-cost guard (AC-1c). Logs
 * EVERY time the six-factor enrich handler injects, with the injected unit count and a coarse
 * token estimate of the injected text. This is what makes unconditional / over-firing enrich
 * detectable: if enrich fires on results that should be skipped, the fire-count and token sum
 * climb and the signal shows it.
 *
 * `injectedText` is measured (length / a ~4-chars-per-token estimate) but NEVER stored — the
 * record carries the SIZE of the injection, not the injected memory content. token_estimate is
 * a deterministic function of the text length; no model call, no clock.
 *
 * @param {object} ev { fired, unitCount, injectedText? }
 * @returns {object} the signal payload
 */
function buildEnrichRecord(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const text = typeof e.injectedText === 'string' ? e.injectedText : '';
  return {
    event_type: EVENT_TYPES.ENRICH,
    fired: e.fired === true,
    unit_count: Number.isFinite(e.unitCount) ? e.unitCount : 0,
    // Coarse cost guard: chars and a ~4-chars/token estimate of the injected text. Deterministic
    // (length-only); the TEXT itself is never logged — only its size, the token-cost signal.
    chars: text.length,
    token_estimate: Math.ceil(text.length / 4),
  };
}

// ── The append-only writer (the ONLY side effect in this module) ──────────────

/**
 * Create a TOIN signal logger bound to a sink. The returned object exposes `emit(record)` plus
 * the three record builders for convenience. There is DELIBERATELY no reader — this is a write
 * sink; nothing in the codebase reads TOIN records back into a decision.
 *
 * @param {object} [opts]
 * @param {string} [opts.logPath]  override the sink (tests use a temp file)
 * @param {boolean} [opts.enabled] force-enable/disable (overrides the env kill-switch)
 * @param {object}  [opts.env]     env source for the kill-switch (default process.env)
 */
function createToinLogger(opts = {}) {
  const logPath = typeof opts.logPath === 'string' && opts.logPath ? opts.logPath : DEFAULT_LOG_PATH;
  const env = opts.env || process.env;
  const enabled =
    typeof opts.enabled === 'boolean' ? opts.enabled : env[DISABLE_ENV] !== '1';

  /**
   * Append ONE structured signal record. No-op (returns false) when disabled — that is the
   * reversibility floor: disabling stops emission with zero state change. Wrapped so a sink
   * write failure NEVER throws into a hook (logging is best-effort observation, never a
   * tool-call breaker) — exactly the fail-safe posture of the hooks it serves.
   *
   * The wall-clock `ts` is stamped HERE (write time) — a log fact, never fed back into any
   * computation. A caller may pass an explicit `ts` on the record for a deterministic line.
   *
   * @param {object} record a built signal payload (buildRetrievalRecord/...)
   * @returns {boolean} true if a line was written, false if disabled/failed
   */
  function emit(record) {
    if (!enabled) return false;
    try {
      const line =
        JSON.stringify({
          ts: typeof record.ts === 'string' ? record.ts : new Date().toISOString(),
          level: 'info',
          source: 'dioscuri-toin',
          ...record,
        }) + '\n';
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line);
      return true;
    } catch {
      // Signal logging is best-effort: a sink failure must never break the hook it serves.
      return false;
    }
  }

  return Object.freeze({
    enabled,
    logPath,
    emit,
    // Convenience emit-and-build wrappers — the natural call shape from the emit points.
    logRetrieval: (r) => emit(buildRetrievalRecord(r)),
    logStaleness: (c) => emit(buildStalenessRecord(c)),
    logEnrich: (ev) => emit(buildEnrichRecord(ev)),
  });
}

// A process-wide default logger (the common path: a hook just wants to emit). Lazily built so
// constructing it never runs at require() time in a context that has no business writing.
let _default = null;
function defaultLogger() {
  if (_default === null) _default = createToinLogger();
  return _default;
}

module.exports = {
  DEFAULT_LOG_PATH,
  DISABLE_ENV,
  EVENT_TYPES,
  // pure builders (deterministic — asserted by the test's static + behavioural guards)
  buildRetrievalRecord,
  buildStalenessRecord,
  buildEnrichRecord,
  // the writer
  createToinLogger,
  defaultLogger,
};
