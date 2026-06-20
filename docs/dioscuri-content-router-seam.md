# Dioscuri ContentRouter seam — FROZEN interface contract (DIO-4 / FR-A2)

**Status:** FROZEN as of DIO-4 (Phase 1). The PostToolUse dispatch seam is built
once; this contract is the interface later handlers plug into without forcing a
redesign. Changing any signature below is a breaking change to DIO-7 (compressor)
and DIO-13 (graph enrich) and requires re-freezing here first.

**Source:** `hooks/posttooluse-content-router.js`.
**Tests:** `hooks/test/posttooluse-content-router.test.js`.
**Registration:** `hooks/hooks-install.js` → `CANONICAL_HOOKS` (PostToolUse entry).

---

## 1. Why this exists, in one line

This is the **single** place two transforms ever attach to a tool result:
`updatedToolOutput` (compressed result — Headroom side) and `additionalContext`
(graph enrich — Gortex side). One tool result can be **both** compressed and
enriched in one pass (PRD FR-A1). Phase 1 ships the seam plus a **minimal
pass-through JSON handler** to prove the route fires; it is **not** a real
compressor or graph handler.

## 2. The hook event — PostToolUse, never PreToolUse

Both transforms require the tool **result**, so both are **PostToolUse**.
PreToolUse cannot see tool output and is deliberately not used (PRD FR-A1, the
correction of the original Gortex PreToolUse contradiction).

The hook is registered as a **matcher-less lifecycle-style group** in
`CANONICAL_HOOKS` (the same shape the Stop / SessionStart hooks use), not a
matcher-scoped guard. It inspects every tool result, then attaches nothing unless
a handler claims it. `update.sh` Step 3 runs `hooks-install.js`, so the seam
provisions to both machines with no manual step ("machine setup goes in the
scripts").

## 3. Input shape (FROZEN)

Claude Code delivers the PostToolUse payload on **stdin as JSON** (snake_case wire
format). `normalizeInput(raw)` decodes it **once**, here, into the camelCase shape
every handler sees:

```
// wire (stdin)                     // normalized (what handlers receive)
{                                   {
  "tool_name":     string,           toolName:     string,
  "tool_input":    object,           toolInput:    object,
  "tool_response": <any>             toolResponse: <any>   // string | object | array
}                                   }
```

- `toolResponse` is the tool's raw output. The minimal handler treats a JSON
  array/object (or a string that parses to one) as claimable.
- `toolInput` is the tool's *invocation* args; the **per-call skip flags** live
  here under the `_dioscuri` key (see §6).

## 4. Output shape — the `hookSpecificOutput` schema (FROZEN)

The seam emits **at most one** `hookSpecificOutput`, co-carrying both fields:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",     // always
    "updatedToolOutput": "<string>",    // OPTIONAL — the compressed tool result (Headroom)
    "additionalContext": "<string>"     // OPTIONAL — graph/enrich text appended (Gortex)
  }
}
```

Rules:
- **Both fields are co-returnable in one emission.** A single tool result can be
  compressed *and* enriched in the same pass — this is the core FR-A1 guarantee.
- **A field is omitted, not nulled, when it does not apply.** Absent key = the
  transform did not fire.
- **No emission at all (the hook writes nothing to stdout)** when neither field
  applies → Claude Code keeps the raw tool result. This is the default and the
  reversibility floor.
- Both fields land in the **volatile tool-result tail, downstream of the stable
  identity/rules prefix** (AC-2). The hook never writes Layer 1 or the rendered
  prefix — prefix-safety holds by *position in the stream* (PostToolUse fires
  after the prefix is rendered). Proven byte-identical against the DIO-1 baseline
  `hooks/test/fixtures/prefix-baseline.txt` with the seam active.

## 5. The handler-registration point (FROZEN — this is the plug-in seam)

A handler is a plain object:

```ts
interface ContentHandler {
  id: string;
  detect(input: NormalizedInput): boolean;          // claim this tool result?
  route(input: NormalizedInput): {                  // produce zero, one, or both fields
    updatedToolOutput?: string;
    additionalContext?: string;
  };
}
```

Handlers register in the **`HANDLERS` array** in
`hooks/posttooluse-content-router.js`, in priority order. The router:

1. runs each handler's `detect()`; a **throwing detector never claims** (fail-safe
   to raw append);
2. for each claiming handler, runs `route()`; a **throwing `route()` is skipped**,
   and a later good handler can still attach;
3. merges returns into **one** `hookSpecificOutput`. **First handler to set a field
   wins for that field** — so register the compressor before the enrich if a single
   handler should not be overridden.

**How DIO-7 and DIO-13 plug in (no seam redesign):**
- **DIO-7 (SmartCrusher compressor)** replaces the body of `minimalJsonHandler.route`
  — same `{ updatedToolOutput }` return contract; the pass-through becomes real
  compression. Its `detect` may stay (JSON-shaped) or narrow.
- **DIO-13 (graph enrich)** appends a new handler returning `{ additionalContext }`,
  gated behind its relevance threshold (FR-A3: enrich fires only above threshold,
  so it does not spend tokens on every result). It does not touch the compressor.

Both append to `HANDLERS`; neither edits the router, the input decode, or the
output schema. That is the freeze.

## 6. Per-call skip mechanism (AC-3 — FROZEN)

Both fields are **independently** skippable per call. `skipFlags(input, env)`
resolves, first-match-wins per field:

1. **Per-call, structured:** `toolInput._dioscuri.skipCompress === true` /
   `…skipEnrich === true`.
2. **Session / global env:** `DIOSCURI_SKIP_COMPRESS=1` / `DIOSCURI_SKIP_ENRICH=1`.

When `skipCompress` is set, `updatedToolOutput` is never emitted → the raw tool
result passes through **byte-unchanged**. When `skipEnrich` is set,
`additionalContext` is never emitted. The two are orthogonal: skipping one leaves
the other intact (proven both directions in the test suite). Skipping both yields
no emission → raw passthrough.

## 7. Reversibility (PRD §1 — FROZEN)

- **Full disable:** remove the PostToolUse entry from `CANONICAL_HOOKS` in
  `hooks/hooks-install.js` and re-run `update.sh` (or `node hooks/hooks-install.js`).
  The seam is gone and Claude Code reverts to raw tool-result append. Nothing else
  references the hook.
- **Inline escape hatch:** the per-call skip (§6) suppresses a transform for a
  single call without disabling the seam.
- **Fail-safe:** unparseable stdin, a throwing detector, or a throwing `route()`
  all degrade to "emit nothing → raw append." The seam never fails a tool call.

## 8. What this seam is NOT (scope guard for QA)

- **Not a compressor.** The Phase-1 JSON handler is a pass-through that returns the
  tool output unchanged in `updatedToolOutput`. The real SmartCrusher port is
  **DIO-7**.
- **Not a graph enrich.** No `additionalContext` handler ships in Phase 1; the real
  enrich is **DIO-13**.
- **Not the capture path.** Routing compressed output into episodic capture
  (`additionalContext` notwithstanding) is **DIO-18 / FR-B5**, default-off and
  separately gated. This seam only attaches to live context.
- **No CCR retrieve wiring.** AC-1 reversibility via `retrieve(hash)` is **DIO-5 /
  DIO-11**. The minimal handler is a pass-through, so the original is trivially the
  output; no store is written here.
