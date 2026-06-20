# SmartCrusher JSON compression — DIO-7 / FR-B1

**Status:** built (Phase 2). Plugs into the FROZEN DIO-4 ContentRouter seam
(`docs/dioscuri-content-router-seam.md` §5) without changing its interface.

**Source:** `hooks/lib/smart-crusher.js` (the engine), wired into
`hooks/posttooluse-content-router.js` (the seam handler `minimalJsonHandler.route`).
**Tests:** `hooks/lib/test/smart-crusher.test.js` (engine),
`hooks/test/posttooluse-content-router-compression.test.js` (seam integration).

---

## 1. What it does, in one line

Compresses a JSON **array** of records emitted by a tool by keeping a representative
subset, factoring out fields that are constant across the array, and **preserving
error / anomaly / distribution-boundary rows unconditionally** — so a 500-row lint
result with one failing row never loses that row to a budget.

## 2. The mechanism (in order of operation)

1. **Parse** the JSON array (string or already-structured).
2. **Classify every row FIRST** — `verdict(row) ∈ {error | anomaly | boundary |
   droppable}`. The preserve-first rule is non-negotiable for an audit/defect agent,
   so classification gates every later drop decision.
   - *error* — an error-named key with a present value (`error`, `errors:3`,
     `failed:true`), or a status-like field reading as a failure (`status:"error"`).
     `errors:0` / `status:"ok"` are NOT errors.
   - *boundary* — holds the global min or max of a numeric field (the distribution
     extreme a naive subset clips off).
   - *anomaly* — a rare row SHAPE (key set occurring in <10% of a ≥10-row array).
3. **Field statistics + constant-field factoring** — fields equal across every row
   are lifted into a shared `constants` block once and removed from each retained row.
4. **Kneedle subset-selection on bigram coverage** — order droppable rows by greedy
   maximum new-bigram coverage, build the cumulative-coverage curve, and take the
   Kneedle knee (max perpendicular distance from the first-to-last chord) as the
   **importance budget**: how many droppable rows are worth keeping at all. A flat
   curve resolves to a fixed fraction (never a random pick).
5. **The 30% schema / 15% recency / 55% importance split** over the budget:
   - 30% from the array START (schema/shape exemplars),
   - 15% from the array END (positional recency — NOT timestamp-derived),
   - 55% by importance score (bigram richness),
   - **UNIONED** with the unconditionally-preserved error/anomaly/boundary rows.

The retained set = preserved ∪ selected-droppable, emitted in original-index order.

## 3. Determinism (AC-5c.1 — load-bearing)

`compress(payload)` is **byte-identical across runs and across machines** for
identical input. Proof: `hooks/lib/test/smart-crusher.test.js` hashes the output of
two runs and asserts equality; the seam test asserts byte-identical
`updatedToolOutput` for the same input twice.

Guarantees that make it deterministic:
- **No wall-clock, no randomness** — no `Date.now()`, `new Date()`, or `Math.random`
  (statically guarded by a test). "Recency" is positional, never a timestamp.
- **Canonical serialization** — object keys are sorted recursively before hashing,
  bigram extraction, AND in the emitted retained rows, so inputs differing only in
  key order produce byte-identical output.
- **Stable tie-breaks** — every selection tie (Kneedle greedy pick, importance rank,
  boundary min/max) breaks on the lowest original index.

This is the precondition for DIO-18 (the FR-B5 capture path): a lossy *and*
non-deterministic write would drift the eval baseline run-to-run. It is pinned here.

## 4. The AC-1 reversibility contract

The compressed form is a **recoverable projection** of the original, never a lossy
rewrite of it. `compress()`:

- **Never mutates or destroys its input** (asserted by test).
- Returns the **`originalHash`** — a sha256 of the canonical original — and the full
  **`retainedIndices`** set, both carried onto the `updatedToolOutput` envelope under
  `_dioscuri`, plus a CCR-style **`marker`**:
  `[<N> items compressed to <M>. Retrieve more: hash=<sha256>]`.

**The contract:** given the `originalHash`, a retrieve path can resolve and verify the
byte-exact original; the compressed envelope carries everything that path needs
(`originalHash`, `originalCount`, `retainedIndices`, `droppedCount`). DIO-7 does not
itself write the backing store or implement `retrieve()` — that is **DIO-11 (CCR)**,
which keys the ephemeral session-scoped store by exactly this hash. DIO-7's
obligation, met here, is: (a) the original is never lossily destroyed in place, and
(b) the compressed output carries the marker/hash a retrieve path needs.

Until DIO-11 wires the store, the original is still recoverable two ways: the per-call
skip (`_dioscuri.skipCompress` / `DIOSCURI_SKIP_COMPRESS=1`) passes the raw result
through byte-unchanged, and removing the PostToolUse registration reverts to raw
append entirely (seam doc §7).

## 5. The output envelope (`updatedToolOutput`)

When an array is compressed, the seam serializes this envelope into
`updatedToolOutput`:

```jsonc
{
  "_dioscuri": {
    "compressed": true,
    "marker": "[500 items compressed to 72. Retrieve more: hash=<sha256>]",
    "originalHash": "<sha256 of the canonical original>",
    "originalCount": 500,
    "droppedCount": 428,
    "retainedIndices": [0, 1, 2, ... 250 ...],   // the error row's index is here
    "verdicts": ["droppable", "boundary", ..., "error", ...]  // per ORIGINAL row (AC-5b)
  },
  "constants": { /* fields constant across all rows, lifted out once */ },
  "retained":  [ /* retained rows, constant fields removed, canonical key order */ ]
}
```

`verdicts` is per **original** row (length = `originalCount`), so AC-5b can assert
`{ row : verdict(row) ∈ {error,anomaly,boundary} } ⊆ retainedIndices` against an
observable verdict, not a discarded one.

## 6. Passthrough cases (degrade, never crash)

The handler returns the raw tool output **byte-unchanged** (no envelope) when:
- the JSON value is **not an array** (a bare object/primitive) — SmartCrusher only
  compresses arrays;
- the array is **under the floor** (`MIN_ROWS_TO_COMPRESS = 8`) — no benefit, no
  overhead (the structural analog of Headroom's "<200 tokens passes through");
- the input is **unparseable** or `compress()` throws — the seam never fails a tool
  call, and never ships a half-compressed (unrecoverable) payload.

The per-call skip (AC-3) and the env skip suppress compression independently of the
enrich field, exactly as the frozen seam specifies.

## 7. What DIO-7 deliberately does NOT do

- **No CCR store / `retrieve()`** — DIO-11. DIO-7 carries the marker; DIO-11 backs it.
- **No capture-path write** — DIO-18 / FR-B5 (default-off, arms only after the
  determinism proof above + an eval re-baseline + DIO-19).
- **No AST/code compression** — out of v1 scope (FR-B4).
- **No change to the seam interface** — the router, input decode, output schema, and
  skip mechanism are untouched (the FR-A2 freeze).
