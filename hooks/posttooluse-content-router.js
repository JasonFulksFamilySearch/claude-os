'use strict';

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
 * SCOPE (Phase 1, DIO-4): this builds the SEAM and FREEZES its interface. It is
 * NOT a real compressor (the SmartCrusher port is DIO-7) and NOT a real graph
 * enrich (DIO-13). A minimal pass-through JSON handler is wired only to prove the
 * route fires and the field lands. The frozen interface is documented in
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
// The minimal JSON handler below is the seam exerciser ONLY. It is a pass-through:
// it proves a JSON tool result routes through `updatedToolOutput` and the field
// lands, without being a real compressor. DIO-7 replaces its `route` body.

/**
 * True if the tool response is (or parses to) a JSON value. Used by the minimal
 * handler's detect(). Strings are probed by a parse attempt; objects/arrays are
 * already structured.
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
 * The minimal JSON handler — a SEAM EXERCISER, not a compressor.
 *
 * detect: claims any JSON-shaped tool response.
 * route:  returns the tool output UNCHANGED in `updatedToolOutput`. This is a
 *         deliberate pass-through (PRD FR-B2 / DIO-5) — its only job is to prove
 *         the route fires and `updatedToolOutput` lands. DIO-7 swaps the body for
 *         the real SmartCrusher compress() without changing this contract.
 */
const minimalJsonHandler = Object.freeze({
  id: 'minimal-json',
  detect: (input) => isJsonToolResponse(input.toolResponse),
  route: (input) => ({
    // Pass-through: byte-identical to the input. A real compressor returns a
    // smaller string here; the seam contract is the same either way.
    updatedToolOutput:
      typeof input.toolResponse === 'string'
        ? input.toolResponse
        : JSON.stringify(input.toolResponse),
  }),
});

// The registered handler chain. Phase 1 ships exactly the one exerciser. Real
// handlers append here (compressor first, then enrich) — appending does not
// change the seam, which is the FR-A2 freeze.
const HANDLERS = Object.freeze([minimalJsonHandler]);

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

  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

module.exports = {
  isJsonToolResponse,
  minimalJsonHandler,
  HANDLERS,
  skipFlags,
  route,
  normalizeInput,
};

if (require.main === module) {
  main().catch(() => process.exit(0));
}
