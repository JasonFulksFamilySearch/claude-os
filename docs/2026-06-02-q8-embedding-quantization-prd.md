# PRD: q8 Embedding Quantization for claude-os-mcp

- **Date:** 2026-06-02
- **Originating need:** Diagnostic session (no JIRA ticket — claude-os is personal tooling).
  "iTerm using 52GB" traced to each Claude Code session's claude-os-mcp loading its own fp32
  copy of nomic-embed-text-v1.5 (~1.5GB resident); 5+ concurrent sessions (~2-3x/year) exhaust
  a 36GB Mac and force ~30GB of swap.
- **Status:** Approved for planning. Supersedes the parked implementation plan at
  `~/.claude/plans/and-you-tell-me-pure-raven.md`.
- **Design note:** An earlier draft auto-reconciled the embedding precision on every server
  startup ("Option B"). A red-blue-judge review found that approach creates a cross-process
  rebuild storm when multiple sessions start during the one cutover window. Because a precision
  change is a one-and-done event per machine, the design was simplified to a **deliberate,
  one-time migration** run by hand per machine — removing the concurrency hazard by construction.

## Problem Statement

When Jason runs several Claude Code sessions at once — five or more, a few times a year — his Mac
becomes unresponsive: it thrashes, swap fills, and a memory-by-application view shows the terminal
app "using" ~50GB. He hasn't done anything unusual; he simply has multiple agent sessions open. He
should not have to ration how many sessions he runs, or manually kill processes, to keep his
machine usable. Underlying cause: the local memory server (claude-os-mcp) loads a full-precision
(fp32) copy of its text-embedding model into RAM (~1.5GB), and because each session runs its own
server process, that cost is paid once per session and never shared.

## Solution

The memory server uses roughly 4× less RAM per session by loading the embedding model with int8
(q8) quantized weights instead of fp32. The model's output is unchanged (768-dimensional float),
so the stored-vector format and all search behavior are untouched — only the in-memory weight
footprint shrinks.

Switching precision requires the existing memory index to be rebuilt once with the new model.
That rebuild is a **deliberate, one-time migration** Jason runs on each machine (Willis, and
Walter after he assimilates the code) — *not* always-on auto-detection. Run once with sessions
quiesced, it carries no concurrency risk and adds no permanent coordination machinery to the
running server. The migration is **atomic** — it embeds all new vectors in memory first, then swaps
them into the index in a single transaction — so an interruption (Ctrl-C, crash, OOM) leaves the
*previous* index fully intact rather than half-rebuilt. It is lossless (the index is a derived cache)
and idempotent, so it doubles as the rollback tool: revert the dtype and re-run it. Recall quality is
held to a measured, quantitative bar so the savings don't quietly degrade search.

## User Stories

1. As a Claude Code power user, I want each session's memory server to use far less RAM, so that
   running several sessions at once doesn't make my Mac thrash.
2. As a developer who occasionally runs 5+ concurrent sessions, I want the combined embedding-model
   footprint to stay within physical RAM, so the system doesn't swap heavily.
3. As the machine owner, I want this handled at the tool level, so I don't ration sessions or kill
   processes to recover responsiveness.
4. As a user of semantic recall, I want search quality effectively unchanged after the change.
5. As a careful operator, I want a measured, quantitative quality check, so I can trust the smaller
   model didn't degrade retrieval.
6. As the owner of two machines, I want a single, documented one-time migration I run on each, so
   both pick up q8 without any permanent auto-detection code in the server.
7. As someone whose memory DB is precious, I want the migration lossless, so no learnings, context,
   or episodes are lost when the index is regenerated.
8. As a cautious engineer, I want the migration atomic and idempotent, so that an interrupted run
   leaves the prior index fully intact and I can re-run it without fear (and reuse it for rollback).
9. As someone avoiding needless complexity, I want NO always-on reconcile/lease/marker logic added
   to the server, so the change introduces no concurrency risk and no hot-path cost.
10. As an operator, I want the migration to print what it cleared and re-embedded (count, duration),
    so I can confirm it completed.
11. As a developer, I want existing keyword/FTS search, MCP tool interfaces, and the on-disk `.md`
    memory files untouched, so the change's blast radius is limited to the embedding path.

## Implementation Decisions

- **Quantization:** Load the embedding model with int8 (q8) weights, exposed as a named constant in
  the embedder module (replacing the inline `fp32` literal) for clarity. Output remains 768-dim
  float, so the vector store's dimension and serialization are unchanged — no schema migration.
- **One-time migration command:** Add a small, separately-invoked command (e.g. an `npm run reembed`
  script) that, run against the local database, re-embeds every observation with the current model.
  It is **atomic**: it embeds all observations into an in-memory array first (no DB writes), then in a
  **single SQLite transaction** clears the vector table and inserts all new vectors. An interruption
  before the transaction commits leaves the prior index fully intact — there is no half-embedded
  terminal state, and the post-migration startup needs no recovery pass. It is **not** wired into
  server startup. It is idempotent (safe to re-run) and lossless (the vector table is a pure
  derivative of the observations, themselves derived from the `.md` files). Jason runs it once per
  machine after the dtype change, with sessions quiesced; re-running it after reverting the dtype
  performs rollback.
- **No always-on machinery:** No meta-versioning, no startup auto-reconcile, no per-startup
  embed-missing pass, no cross-process lease/lock. The running server changes by exactly the dtype
  constant; everything else (full reindex, watcher, backstop, tools) is unchanged.
- **Rationale:** A precision change is a one-and-done event per machine (~2-3 lifetime triggers
  incl. rollback). A deliberate manual migration is proportionate and removes — by construction —
  the concurrent-rebuild hazard that a per-startup auto-rebuild would create when multiple sessions
  start in the cutover window (see Gate review).

## Grounding (verified 2026-06-02 — point-in-time anchors; may drift)

> `file:line` evidence that the integration points are real and correctly located; verified at
> authoring time. Implementation Decisions stay module-level deliberately (paths rot).

- **dtype load site (the change):** `src/embedder.ts:31` — inline literal `{ dtype: "fp32" }` inside
  the `pipeline(...)` call (lines 28-32), behind the per-process singleton `_pipeline`
  (`embedder.ts:14`). Becomes a `q8` named constant.
- **Constants to sit beside:** `src/embedder.ts:6` (`MODEL_ID`), `:7` (`EMBEDDING_DIM`); output as
  `Float32Array` at `:38-42`; `serializeVector` at `:54-56` (unchanged — q8 keeps float32 output).
- **What the migration reuses:** `embedDocument` (`src/embedder.ts:45`) + `serializeVector` (`:54-56`)
  to compute each observation's vector into memory; a `SELECT` over the `observations` table; then a
  `better-sqlite3` transaction (`db.transaction(...)`) that does `DELETE FROM vec_items` + the inserts
  against `vec_items(embedding FLOAT[768])` (`src/db.ts:66-69`) as one atomic unit. (It does **not**
  reuse `embedObservation`'s per-row insert path, since that writes incrementally; atomicity needs the
  swap batched.) No new schema.
- **Brief window coverage:** during the migration's clear→re-embed, `search_memory`'s vector branch
  (`src/tools/search_memory.ts:114-122`) degrades to FTS-only via its guard (`:161-163`) — but since
  the migration is run with sessions quiesced, this is a non-issue in practice.
- **Test prior art:** `test/indexer.test.ts:3-9` mocks the embedder module; `test/embedder.test.ts`
  tests only `serializeVector` + constants and never loads the model.

## Testing Decisions

- **What makes a good test:** assert external behavior, not internals; never load the real model
  (prior art: the indexer test mocks the embedder module).
- **Migration command — unit tested (the primary new coverage):** with the embedder mocked — embeds
  every observation row and atomically swaps the vector table; idempotent on a second run; leaves the
  observations and FTS data untouched (only vectors are regenerated). **Atomicity/interrupt-safety:**
  with the mocked embedder made to throw on the Nth observation, `vec_items` is left **unchanged** (the
  pre-migration vectors remain) — proving the clear+insert never partially commits.
- **Not unit tested:** the dtype value change (runtime/empirical — RAM, real model load, retrieval
  quality). Covered by the acceptance gate.
- **Acceptance gate (runtime — the proof in lieu of a model-loading test):**
  1. **Regression:** build succeeds; existing suite green.
  2. **Quality (quantitative, mandatory):** capture an fp32 baseline before running the migration;
     after it, **mean cosine similarity between each document's fp32 and q8 vector ≥ 0.98** over a
     **≥20-doc sample**, and **recall@5 ≥ 0.8** over **≥5 representative queries** (fp32 = ground
     truth). A material miss ⇒ roll back (revert dtype, re-run migration).
  3. **RAM (primary goal):** a warmed session's claude-os-mcp resident memory **≤ ~600MB** (was ~1.5GB).
  4. **Functional:** representative `search_memory` calls return sensible, ranked results.

## Out of Scope

- **Self-healing / meta-versioning auto-rebuild on startup** — explicitly deferred. It would add
  per-startup detection plus cross-process coordination (to avoid a concurrent-rebuild storm) for an
  event that happens ~2-3 times per machine ever. Not worth the hot-path complexity; the one-time
  manual migration covers it. (This is the deliberate resolution of the gate's S4 finding.)
- A shared embedding **sidecar** (one model process serving all sessions) — deferred; over-engineering
  for a ~2-3x/year spike.
- **fp16 and q4** dtypes — q8 is the chosen memory/quality sweet spot.
- Changing the embedding **model** itself (remains `nomic-embed-text-v1.5`).
- Any change to FTS/keyword search, MCP tool interfaces, or the on-disk `.md` memory files.

## Further Notes

- **Verified facts** (confirmed against source, HuggingFace, and red-blue-judge reviews): a quantized
  ONNX variant of `nomic-embed-text-v1.5` exists and is loadable; the memory DB is a fully derived
  cache rebuildable from `~/.claude-data/**` `.md` files (so clear-and-re-embed is lossless); the
  embedding output stays float32 under q8; no existing test loads the real model.
- **Zero-code alternative to the migration command:** "quit sessions, delete `~/.claude-data/memory.db`,
  start one session" relies on the existing startup full-reindex to rebuild from scratch. It works
  and is lossless, but the dedicated `reembed` command is preferred — it's explicit, surgical
  (keeps observations/FTS, regenerates only vectors), and safer to hand to oneself than "delete your
  database."
- **Propagation:** the dtype change ships to Walter via transmit/assimilate; he runs the same one-time
  migration once on his machine. No coupling between the two machines' data.
- **Next step:** re-derive the implementation plan from this PRD and gate it with red-blue-judge
  (`mode=plan`) before any code is written. Edits to `~/.claude-os/` require Jason's explicit
  go-ahead at implementation time.

## Gate review — red-blue-judge (mode: prd), 2026-06-02

- **Cycle 0:** review → CLEAN → red challenge landed **S1 FAIL** (artifact cited no `file:line`; its
  template forbids paths). → REVISE.
- **Revise 1:** added the **Grounding** section with verified `file:line` anchors. Re-gate review →
  CLEAN (anchors re-verified) → red challenge #2 landed **S4 FAIL (technical):** the then-current
  auto-reconcile-on-startup design would let concurrent sessions each clear the shared `vec_items`
  and re-embed the full corpus during the cutover window — a RAM storm at the exact 5+-session
  trigger this PRD targets. → REVISE (cap reached) → **ESCALATED to Jason.**
- **Revise 2 (Jason's decision):** **removed the always-on auto-reconcile entirely** in favor of a
  deliberate one-time manual migration per machine. This eliminates the concurrent-rebuild mechanism
  by construction — S4 no longer has a surface to occur on. Held-and-verified across all challenges:
  q8 loadability + float32 output, all Grounding anchors, lossless derived-cache rebuild.
- **Final re-gate (cycle 3):** review → CLEAN → red challenge landed **F4 FAIL (product):** dropping
  the always-on recovery pass meant an *interrupted* `reembed` would leave the index silently
  half-embedded — `fullReindex` never re-embeds unchanged-content docs (`indexer.ts:317-324`), so the
  missing vectors persist and `search_memory` degrades to FTS-only for them with no signal — yet the
  PRD claimed losslessness/idempotency unconditionally. → REVISE.
- **Revise 3 (Jason's decision):** made `reembed` **atomic** — embed all vectors in memory, then
  clear+insert in one transaction — so an interruption rolls back to the prior index. The losslessness
  and "run without fear" claims are now true, with no always-on machinery reintroduced.
- **Final re-gate (cycle 3):** review → CLEAN; red challenge **could not land a grounded FAIL**. The
  strongest angle pursued — an un-quiesced concurrent write landing between the migration's `SELECT`
  and its `DELETE`+insert — is closed by the stated quiescence assumption (surfaced, not omitted, so
  F2/F4 hold). Verified: atomicity is sound (`better-sqlite3` v11.10.0 synchronous `db.transaction`;
  the async embedding precedes the transaction), q8 loadability + float32 output, and every Grounding
  anchor exact.
- **VERDICT: CLEAN (confirmed) — PRD APPROVED (2026-06-02).** Four cycles; three real defects found
  and fixed (S1, S4, F4). Carry into the implementation plan: make **"quiesce sessions before running
  `reembed`"** a prominent operating step — it is the sole accepted residual (un-quiesced concurrent
  write), deliberately out of scope per the no-lease decision.

## Implementation findings (2026-06-02 — what the build actually revealed)

Recorded after implementation + empirical measurement. These supersede assumptions made at PRD time.

- **`vec_items` was empty (0 rows / 758 observations) — a pre-existing latent bug, now fixed.**
  `embedObservation` bound the observation id as a JS `number`; `better-sqlite3` binds numbers as
  `SQLITE_FLOAT`, and `sqlite-vec` v0.1.9's `vec0` PRIMARY KEY rejects floats ("Only integers are
  allowed"). The throw was swallowed by `embedObservation`'s `try/catch`, and `search_memory`'s vector
  branch has its own silent catch — so **semantic recall had silently been FTS-only since this shipped**,
  uncaught because no test asserted a vector landed. Fix: bind `BigInt(id)` at all three `vec_items` PK
  sites (`embedObservation` insert + skip-guard, and `removeFile`'s delete), plus a regression test that
  asserts `vec_items` is populated after `fullReindex`. **Consequence:** `reembed` is **first-time
  population**, not re-embedding. The PRD's premise of "capture an fp32 baseline from the existing index"
  was moot — the quality gate instead embedded a sample under both dtypes directly.

- **fp16 is NOT viable for this model.** The fp16 ONNX export of `nomic-embed-text-v1.5` hits a
  rotary-embedding broadcast bug (`Mul_16 ... 2752 by 2753`) on longer inputs and aborts the process
  (`libc++abi: terminating`). fp32 and q8 embed the same documents fine — the bug is fp16-specific. This
  removes the natural quality fallback, collapsing the decision to **q8 vs fp32**.

- **Measured q8 numbers (sample: 40 docs, 6 queries; fp32 = ground truth):**
  | dtype | approx RAM (RSS) | cosine vs fp32 | recall@5 |
  |---|---|---|---|
  | fp32 | ~1131 MB | 1.0000 | 1.000 |
  | q8 | **~209 MB (5.4×)** | **0.9397** | **0.800** |
  RAM goal decisively met (≪ ≤600 MB target). But q8 **misses the mandatory cosine bar** (0.94 < 0.98);
  recall@5 sits at the 0.80 floor. fp32's footprint (~1.1 GB) was below the PRD's ~1.5 GB estimate.

- **Decision (Jason, 2026-06-02): ship q8** despite the cosine miss. Rationale: it is the only viable
  option that solves the originating thrashing, recall is functional, and `reembed` is a **lossless
  one-line rollback** to fp32 (`EMBEDDING_DTYPE = "fp32"` + re-run) if recall proves weak in practice —
  a low-regret, reversible call rather than a one-way door.
