'use strict';

const smartCrusher = require('./lib/smart-crusher.js');
const { createEnrichHandler } = require('./lib/injection-enrich.js');
const { isArmed } = require('./lib/fr-b5-flag.js');
const { appendSignal } = require('./lib/capture-buffer.js');

/**
 * posttooluse-content-router.js — the single PostToolUse dispatch seam.
 *
 * This is the ONE place two transforms ever attach to a tool result:
 *   - `updatedToolOutput`  — the compressed tool result   (Headroom side)
 *   - `additionalContext`  — graph/enrich text appended    (Gortex side)
 *
 * Both require the tool result, so both are PostToolUse (PreToolUse cannot see
 * tool output and is deliberately NOT used). A single `hookSpecificOutput` MAY
 * carry BOTH fields, so one tool result can be compressed AND enriched in one
 * pass (PRD FR-A1).
 *
 * SCOPE: DIO-4 built and FROZE this seam. DIO-7 plugs the real SmartCrusher
 * compressor into it — the JSON-array handler below now runs the real compress()
 * (lib/smart-crusher.js), NOT a pass-through, while honoring the frozen interface:
 * same `{ updatedToolOutput }` return contract, same registration, same skip
 * mechanism, same fail-safe-to-raw posture. DIO-13 plugs the real graph enrich
 * (additionalContext) in — `createEnrichHandler` (lib/injection-enrich.js) APPENDS a
 * new handler returning `{ additionalContext }` on the same frozen registration point;
 * it claims a call only when a graph-selected candidate set is staged, six-factor-ranks
 * the over-budget set, and injects the survivors. Both fields co-carry on one
 * hookSpecificOutput (FR-A1) and never collide. The frozen interface is documented in
 * docs/dioscuri-content-router-seam.md — read that before plugging a real handler in.
 *
 * AC-2 (prefix safety, PRD §3): both fields land in the volatile tool-result
 * tail, downstream of the stable identity/rules prefix. This hook never writes
 * Layer 1 or the rendered prefix — prefix-safety holds by POSITION in the stream
 * (PostToolUse fires after the prefix is rendered). The byte-stability of the
 * prefix is proven against hooks/test/fixtures/prefix-baseline.txt by
 * hooks/test/posttooluse-content-router.test.js.
 *
 * AC-3 (per-call skippable, PRD §3): a per-call skip suppresses a transform and
 * passes the raw result through byte-unchanged. Both fields are INDEPENDENTLY
 * skippable. See `skipFlags()` for the mechanism.
 *
 * Reversibility (PRD §1): removing the PostToolUse entry from CANONICAL_HOOKS in
 * hooks-install.js fully disables the seam and restores raw append. The per-call
 * skip is the inline escape hatch.
 */

// ── The frozen handler-registration point ─────────────────────────────────────
// A handler is { detect(input) -> bool, route(input) -> { updatedToolOutput?, additionalContext? } }.
// detect() decides whether this handler claims the tool result; route() returns
// zero, one, or both fields. The router runs handlers in order and merges their
// returns into ONE hookSpecificOutput. Real handlers (DIO-7 compressor, DIO-13
// enrich) register here without touching the seam — that is the freeze.
//
// DIO-7 replaces the `route` BODY of this handler with the real SmartCrusher
// compress() — same `{ updatedToolOutput }` return contract (seam doc §5). `detect`
// is unchanged (JSON-shaped claim). The router, input decode, output schema, and
// skip mechanism are untouched — that is the freeze.

/**
 * True if the tool response is (or parses to) a JSON value. Used by the handler's
 * detect(). Strings are probed by a parse attempt; objects/arrays are already
 * structured.
 */
function isJsonToolResponse(toolResponse) {
  if (toolResponse == null) return false;
  if (typeof toolResponse === 'object') return true; // already-parsed JSON
  if (typeof toolResponse !== 'string') return false;
  const trimmed = toolResponse.trim();
  if (!trimmed) return false;
  // Only probe things that look like JSON containers — cheap pre-filter so we
  // don't JSON.parse arbitrary prose on every tool call.
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a JSON tool response (string or already-structured) into a value, or return
 * undefined if it is not parseable. The router catches throws too (fail-safe to raw
 * append), but parsing here lets the handler decide passthrough WITHOUT throwing.
 */
function parseJsonResponse(toolResponse) {
  if (toolResponse == null) return undefined;
  if (typeof toolResponse === 'object') return toolResponse; // already parsed
  if (typeof toolResponse !== 'string') return undefined;
  const trimmed = toolResponse.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Build the compressed `updatedToolOutput` envelope from a SmartCrusher result. The
 * envelope is a self-describing JSON object that carries:
 *   - the retained (constant-factored) rows — the compressed payload the agent reads;
 *   - the factored-out `constants` block (shared fields lifted once);
 *   - the per-row classification `verdicts` (AC-5b: the preservation rule is asserted
 *     against this, so it MUST be observable on the output, not discarded);
 *   - a reversibility `marker` carrying the original hash + retained indices so a CCR
 *     retrieve path (DIO-11) can recover the byte-exact original (AC-1).
 * Deterministic: every field derives from compress(), which is deterministic.
 */
function buildCompressedEnvelope(result) {
  return {
    _dioscuri: {
      compressed: true,
      // AC-1 reversibility surface: the original is a recoverable projection. The
      // marker is the retrieve key (full CCR retrieve is DIO-11); the original is
      // never destroyed in place — `retainedIndices` + `originalHash` are what a
      // retrieve path needs to resolve and verify the byte-exact original.
      marker: `[${result.originalCount} items compressed to ${result.retainedIndices.length}. Retrieve more: hash=${result.originalHash}]`,
      originalHash: result.originalHash,
      originalCount: result.originalCount,
      droppedCount: result.droppedCount,
      retainedIndices: result.retainedIndices,
      // AC-5b: per-row classification verdict surfaced on the output (not just the
      // retained array) — error/anomaly/boundary vs droppable, by original index.
      verdicts: result.verdicts,
    },
    constants: result.constants,
    retained: result.retained,
  };
}

/**
 * The JSON-array compressor handler — the real SmartCrusher port (DIO-7).
 *
 * detect: claims any JSON-shaped tool response (unchanged from the seam exerciser).
 * route:  runs SmartCrusher compress() over a JSON ARRAY and returns the compressed
 *         envelope in `updatedToolOutput`. Degrades to raw passthrough (returns the
 *         input unchanged) for any input compress() cannot meaningfully shrink — a
 *         non-array JSON value, an array under the compression floor, or anything
 *         that would otherwise crash the tool call. Same `{ updatedToolOutput }`
 *         contract the seam froze.
 */
const minimalJsonHandler = Object.freeze({
  id: 'json-smartcrusher',
  detect: (input) => isJsonToolResponse(input.toolResponse),
  route: (input) => {
    const raw =
      typeof input.toolResponse === 'string'
        ? input.toolResponse
        : JSON.stringify(input.toolResponse);

    const parsed = parseJsonResponse(input.toolResponse);

    // Only JSON ARRAYS are compressible by SmartCrusher. A JSON object / primitive,
    // or an unparseable value, degrades to raw passthrough — never a crash, never a
    // lossy rewrite (seam doc §8: malformed input → raw passthrough).
    if (!Array.isArray(parsed)) {
      return { updatedToolOutput: raw };
    }

    let result;
    try {
      result = smartCrusher.compress(parsed);
    } catch {
      // Any compressor fault degrades to raw passthrough — the seam never fails a
      // tool call, and we never ship a half-compressed (unrecoverable) payload.
      return { updatedToolOutput: raw };
    }

    // Below the floor (small array) → compress() returns compressed:false. Pass the
    // raw output through unchanged — no overhead where there is no benefit.
    if (!result.compressed) {
      return { updatedToolOutput: raw };
    }

    return { updatedToolOutput: JSON.stringify(buildCompressedEnvelope(result)) };
  },
});

// The DIO-13 LIVE graph-enrich handler. APPENDED after the compressor — appending is the
// FR-A2 freeze (no seam redesign). The compressor owns `updatedToolOutput`; this owns
// `additionalContext`. They are different keys, so the router co-carries BOTH on one
// hookSpecificOutput without collision (FR-A1). It claims a call ONLY when a graph-selected
// candidate set is staged (toolInput._dioscuri.enrichCandidates), so it spends no tokens on
// ordinary results (FR-A3). The recency clock is injected (determinism); a missing clock
// makes recency contribute nothing rather than reading the system clock here.
const enrichHandler = createEnrichHandler();

// The registered handler chain. Real handlers append here (compressor first, then enrich) —
// appending does not change the seam, which is the FR-A2 freeze. Order matters only for a
// SHARED field: the compressor wins `updatedToolOutput`; the enrich owns `additionalContext`,
// a different field, so there is no contention — the order documents intent, not a conflict.
const HANDLERS = Object.freeze([minimalJsonHandler, enrichHandler]);

// ── The per-call skip mechanism (AC-3) ────────────────────────────────────────
// Both fields are INDEPENDENTLY skippable. A skip is read from the tool input or
// an env var, so a single tool call can suppress a transform without disabling
// the seam globally. Resolution order (first match wins per field):
//   1. input.toolInput._dioscuri.skipCompress / .skipEnrich  (per-call, structured)
//   2. env DIOSCURI_SKIP_COMPRESS / DIOSCURI_SKIP_ENRICH = '1' (session/global)
// When compress is skipped, `updatedToolOutput` is never emitted → the raw tool
// result passes through byte-unchanged. When enrich is skipped, `additionalContext`
// is never emitted. The two are orthogonal.
function skipFlags(input, env = process.env) {
  const ctl =
    (input && input.toolInput && input.toolInput._dioscuri) || {};
  return {
    skipCompress: ctl.skipCompress === true || env.DIOSCURI_SKIP_COMPRESS === '1',
    skipEnrich: ctl.skipEnrich === true || env.DIOSCURI_SKIP_ENRICH === '1',
  };
}

// ── The router: detect type → route → merge into one hookSpecificOutput ───────
/**
 * Run the registered handler chain over a normalized hook input and produce the
 * PostToolUse hookSpecificOutput payload (or null to emit nothing — the raw
 * append default).
 *
 * @param {{toolName?: string, toolInput?: object, toolResponse?: *}} input
 * @returns {{hookSpecificOutput: object} | null}
 */
function route(input, { handlers = HANDLERS, env = process.env } = {}) {
  const { skipCompress, skipEnrich } = skipFlags(input, env);

  let updatedToolOutput;
  let additionalContext;

  for (const handler of handlers) {
    let claimed = false;
    try {
      claimed = handler.detect(input);
    } catch {
      claimed = false; // a throwing detector never claims — fail safe to raw append
    }
    if (!claimed) continue;

    let out;
    try {
      out = handler.route(input) || {};
    } catch {
      continue; // a throwing handler is skipped — fail safe to raw append
    }

    // Merge, honoring the per-call skips. First handler to set a field wins for
    // that field (compressor before enrich in the registration order).
    if (!skipCompress && updatedToolOutput === undefined && out.updatedToolOutput !== undefined) {
      updatedToolOutput = out.updatedToolOutput;
    }
    if (!skipEnrich && additionalContext === undefined && out.additionalContext !== undefined) {
      additionalContext = out.additionalContext;
    }
  }

  // Nothing to attach → emit nothing → raw tool result passes through unchanged.
  if (updatedToolOutput === undefined && additionalContext === undefined) return null;

  const hookSpecificOutput = { hookEventName: 'PostToolUse' };
  if (updatedToolOutput !== undefined) hookSpecificOutput.updatedToolOutput = updatedToolOutput;
  if (additionalContext !== undefined) hookSpecificOutput.additionalContext = additionalContext;
  return { hookSpecificOutput };
}

/**
 * FR-B5 producer side-effect (DIO-18). NOT a handler and NOT part of the frozen
 * route() contract — a fail-safe write main() performs AFTER route(), gated by the
 * file-sentinel flag and the per-call compress skip. When the flag is OFF (default),
 * compress was skipped, or route() produced no compressed envelope, this is a no-op
 * → byte-identical reversibility. Errors are swallowed: capture must never break a
 * tool call.
 *
 * It parses the envelope route() already built (updatedToolOutput) to recover the
 * compressed signal — it does NOT re-run compress(), so producer and transform stay
 * in lockstep on one compression result.
 */
function captureSignal(
  input,
  payload,
  { isArmedFn = isArmed, append, mkdir, env = process.env, sessionId } = {},
) {
  try {
    if (!isArmedFn('fr_b5_capture')) return { written: 0 };
    if (skipFlags(input, env).skipCompress) return { written: 0 };
    const out = payload && payload.hookSpecificOutput;
    if (!out || typeof out.updatedToolOutput !== 'string') return { written: 0 };

    let env_;
    try { env_ = JSON.parse(out.updatedToolOutput); } catch { return { written: 0 }; }
    const d = env_ && env_._dioscuri;
    if (!d || d.compressed !== true) return { written: 0 }; // raw passthrough → nothing to capture

    const signal = {
      tool: input && input.toolName,
      retained: env_.retained,
      dropped_count: d.droppedCount,
      verdicts: d.verdicts,
      originalHash: d.originalHash,
    };
    const opts = {};
    if (append) opts.append = append;
    if (mkdir) opts.mkdir = mkdir;
    return appendSignal(sessionId || 'noid', signal, opts);
  } catch {
    return { written: 0 }; // capture never breaks the tool call
  }
}

/**
 * Normalize the raw Claude Code PostToolUse stdin payload into the router's input
 * shape. Claude Code sends { tool_name, tool_input, tool_response, ... }; the
 * router works in camelCase so the snake_case wire format is decoded once, here.
 */
function normalizeInput(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    toolName: data.tool_name,
    toolInput: data.tool_input,
    toolResponse: data.tool_response,
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let normalized;
  try {
    normalized = normalizeInput(input);
  } catch {
    // Unparseable stdin → emit nothing → raw append. The seam never fails a tool call.
    process.exit(0);
  }

  let payload;
  try {
    payload = route(normalized);
  } catch {
    process.exit(0); // any router error → raw append, never break the tool call
  }

  // FR-B5 capture side-effect — never affects stdout / the tool result. Gated by the
  // flag sentinel; a no-op when OFF (default). Wrapped so it can never break the call.
  if (payload) {
    let sid;
    try { sid = JSON.parse(input).session_id; } catch { sid = undefined; }
    try { captureSignal(normalized, payload, { sessionId: sid }); } catch { /* never break the call */ }
  }

  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

module.exports = {
  isJsonToolResponse,
  parseJsonResponse,
  buildCompressedEnvelope,
  minimalJsonHandler,
  enrichHandler,
  HANDLERS,
  skipFlags,
  route,
  captureSignal,
  normalizeInput,
};

if (require.main === module) {
  main().catch(() => process.exit(0));
}
