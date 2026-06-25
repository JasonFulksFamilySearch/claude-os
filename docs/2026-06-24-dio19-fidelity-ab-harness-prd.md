# PRD — DIO-19: Non-error fidelity A/B harness (the only non-error catch under reading (a))

**Status:** Draft (pre-Gate-1). Project-owned source of truth for GitHub issue #59.
**Surface:** offline measurement instrument for the FR-B5 capture path (#58, merged). Measurement-only; no runtime behavior, no writes to shared state.
**Date:** 2026-06-24
**Author:** Walter (AI), human-reviewed. Measurement-design rulings by system-architect; codebase facts verified file:line. Grafts the "why" from the issue-#59 thread PRD.

---

## Problem Statement

DIO-18 (FR-B5, merged in #98) writes compressed, lossy tool output into the eval-gated corpus. As established in DIO-18's PRD §4, **the eval gate is structurally blind to content fidelity** — `recall@k`/`MRR` score *presence* by `source_path` containment, never semantic content. So a `## Tool signals` section that silently dropped a non-error signal row still surfaces the episode and still passes the eval.

The error/anomaly/boundary slice is already covered: **AC-5b** guarantees those rows survive into the written episode by set-containment, with no model call (DIO-18 PRD US-6). But the **non-error residual** — facts that aren't errors but are still signal — has *no automatic guard at all*.

The cold-eye review found this was the softest link in the whole plan: AC-5c.4 was specified as an arming-checklist *intention* ("fidelity-bounded") with **no instrument** behind it — pure prose. A prose acceptance criterion with no measurement is a guard that cannot fail, which is the same as no guard. DIO-19 exists to give it teeth: a *number*, produced before the #72 flag flips.

**The deeper problem the instrument must solve (and not accidentally dodge):** `compress()` decides which droppable rows to keep by ranking them on **bigram diversity** (`rankByImportance` = count of distinct character bigrams of the serialized row, `smart-crusher.js:313-320`), then taking a 30/15/55 schema/recency/importance split (`smart-crusher.js:406-427`). A *terse but high-value* row — an identifier, a file path, a config/threshold value, a non-error status — has few bigrams, scores low, and is exactly what the importance budget drops. **That blind spot is the non-error fidelity loss the eval gate cannot see.** A harness that measured "what fraction of droppable rows survived, weighted by richness" would merely re-read `compress()`'s own keep rule — a tautology (it would re-report `droppedCount`, `smart-crusher.js:444`). The instrument must measure survival against a signal `compress()` does **not** consume, or the number is theater.

## Solution

A **named diff instrument** (a new offline script, mirroring `mcp/src/scripts/eval.ts`) that, over a **held-out, disjoint** content-level labeled set, runs each payload through `compress()` and reports the **important-droppable-row survival rate** — a single number. "Important" is assigned offline by a curator using semantic salience (a content property `compress()` provably does not use to rank), so the measure is deterministic, model-free, and non-tautological. Arming DIO-18 (#72) is gated on that number being within an owner-set fidelity floor agreed before arming.

It is measurement-only: no runtime behavior, no writes to shared state. It is almost entirely additive — the one exception is an export-only change to `smart-crusher.js` (adding two slot-fraction constants to `module.exports` so the harness mirrors the split sizing rather than hardcoding it — ID-13); no `compress()` logic and no eval-gated module is touched. It runs offline, before arming, and produces the number #72's arming checklist consumes.

---

## User Stories

**US-1 — As the operator gating #72, I want a single important-droppable survival rate over a labeled set, so "fidelity is acceptable" is a measured claim, not an assertion.**
```
Given a held-out-disjoint fidelity labeled set of tool-output payloads with curated important_indices
When I run `npm run fidelity`
Then the harness runs compress() on each payload, checks important_indices ⊆ retainedIndices,
  And prints an aggregate important-droppable survival rate (a number) and per-payload breakdown
```

**US-2 — As the operator, I want the measure to catch rows compress() drops for being terse, so it surfaces the exact loss the eval gate is blind to — and to credit survival to importance, not to array position.**
```
Given a labeled payload containing a terse high-value droppable row (low bigram count, high salience)
  And that row's index is in important_indices, IN THE IMPORTANCE-ELIGIBLE ZONE (not the schema-head/recency-tail position slots), with a note naming why it is salient and its pool position
When compress() drops it (the importance-middle slot ranked it low on bigrams and no position slot kept it)
Then the survival rate reflects that drop (the row's index is NOT in retainedIndices)
  And the measure is therefore NOT a restatement of compress()'s own keep rule

# Confounder guards (ID-11): a curated important row is credited as salience-retention ONLY if it is
# in the importance-attributable set — droppable (NOT preserved as error/anomaly/boundary, P1) AND
# outside the schema-head/recency-tail position bands (P2). A row that survives via P1 (class) or P2
# (position) is excluded from the denominator and reported as an audit count — never inflating the rate.
```

**US-3 — As the operator, I want the measure to be deterministic and model-free, so the number is stable across runs and machines (no baseline drift).**
```
Given the same labeled set and the same compress() (DIO-7, byte-deterministic)
When the harness runs twice (and across machines)
Then it reports the byte-identical survival rate
  And no per-run model call participates (the only judgment — importance — lives offline in the labeled set)
```

**US-4 — As the maintainer of the eval gate, I want the fidelity labeled set provably disjoint from the eval presence set, so measuring fidelity never leaks into / voids the retrieval gate.**
```
Given the eval presence set (mcp/eval/labeled-queries.template.json: {query, expectedPathContains})
  And the fidelity set (mcp/eval/fidelity-payloads.template.json: raw arrays + important_indices)
When both exist
Then they share no entries (different types entirely: retrieval queries vs compress() inputs)
  And a unit test asserts no overlap, and the template documents the disjointness rule (eval-gate-protocol.md)
```

**US-5 — As the operator, I want the harness scoped to ONLY the non-error residual, so it neither double-counts the error slice nor falsely claims to cover it.**
```
Given a payload with error/anomaly/boundary rows AND droppable rows
When the harness measures survival
Then it measures ONLY the curated important DROPPABLE rows
  And it does NOT re-measure error/anomaly/boundary (those are AC-5b's job, preserved unconditionally, no model call)
```

**US-6 — As the operator, I want the fidelity floor to be an owner-set number I agree before arming, so the threshold is never reverse-engineered to make the harness pass.**
```
Given the harness emits a measured survival rate
When #72 arming is considered
Then the arming floor is an operator (Jason) deliverable, set before arming and recorded in the labeled set's curation block
  And the harness reports the measured rate AGAINST that floor — the floor is never tuned to the measured number
```

**US-7 — As a future maintainer, I want a contract tripwire on compress()'s output shape, so a later DIO-7 indexing change fails loud instead of silently mismeasuring.**
```
Given the harness relies on retainedIndices and verdicts being original-row-position indexed (smart-crusher.js:175-186,:432)
When compress() output is consumed
Then the harness asserts verdicts.length === originalCount
  And aborts with a clear error if the contract drifted, rather than producing a wrong number
```

**US-8 — As the operator, I want the harness baselined like the eval gate, so a regression in the survival rate is visible run-over-run.**
```
Given a first run with no baseline
When `npm run fidelity` runs
Then it captures a baseline (survival rate + corpus provenance) to a machine-local file
  And subsequent runs compare to it and print the delta (informational; it gates the human #72 decision, not the eval verdict)
```

**INVEST note:** US-1/US-2/US-7 are the load-bearing correctness stories; US-4 is the leakage guard; US-6 is the threshold-honesty story. Each fits a 1–3 day slice.

---

## Implementation Decisions

**ID-1 — The measure is IMPORTANCE-ATTRIBUTABLE survival, over the IMPORTANCE-ATTRIBUTABLE SET only.** (Architect ruling 1, corrected at Gate-1 for TWO confounders — position and class-preservation — see ID-11.) `compress()`'s `retainedIndices` is the union of THREE independent free-survival paths (`smart-crusher.js:431`): **(P1) `preserved`** — every `error|anomaly|boundary` row, kept unconditionally regardless of salience (`:389-393`); **(P2) position** — the schema-head / recency-tail droppable rows, kept by array position regardless of salience (`:413-420`); **(P3) importance** — the droppable rows the bigram ranker keeps (`:421-427`). Only P3 is the signal `compress()` ranks by content-diversity and is therefore the only path a fidelity number may attribute to "the importance ranker retained salient content." The measure must subtract BOTH P1 and P2 from the denominator. Concretely, a curated `important_index` counts toward the measure **only if it is in the importance-attributable set**: `verdict === 'droppable'` (NOT P1) **AND** its rank in the droppable pool is outside the first `schemaCount` / last `recencyCount` position bands (NOT P2). The harness recomputes verdict + droppable-pool + the budget/slot sizes from `compress()`'s exported surface (ID-13). Survival = (importance-attributable important rows whose index ∈ retainedIndices) / (importance-attributable important rows). Curated rows excluded as P1 or P2 are reported as counts (auditability), never silently. **Aggregation (specified to avoid implementer ambiguity):** THE NUMBER is the **micro-average** — total importance-attributable survivors across all payloads ÷ total importance-attributable important rows across all payloads (one row = one unit of weight, so a payload with more curated rows counts proportionally; this is the rate the fidelity floor compares against). The per-payload breakdown is reported alongside for inspection. **Empty-denominator (0/0) rule:** a payload whose importance-attributable set is empty (all its curated important rows fell in P1/P2, or it carried none) contributes **0 to both** numerator and denominator of the micro-average (it simply adds no weight) and its per-payload rate is reported as `n/a`, never as 0% (which would falsely deflate) nor 100% (which would falsely inflate). This makes the rate reflect ONLY whether the bigram-blind importance ranker retained salient-but-terse content — not whether a row was preserved by class or kept by array position.

**ID-2 — Option (a) (droppable-survival weighted by richness) was considered and REJECTED as tautological.** It would re-report `compress()`'s own keep rule / `droppedCount` (`smart-crusher.js:444`). Option (b) (live semantic judge per row) was rejected as non-deterministic + costly — the judgment is moved offline into curation instead, buying the same signal deterministically (mirroring how `eval.ts` moves relevance offline into `expectedPathContains`).

**ID-3 — The issue's "decision/discovery/files_of_note class" does not exist at the row level.** Those are Haiku-summarizer episode-schema fields (`summarizer-client.js:16-19`), not tool-output row classes. `compress()` only ever emits `error|anomaly|boundary|droppable` (`smart-crusher.js:175-186`). The harness measures the non-error *droppable* residual; this PRD records that premise correction explicitly so the instrument is not asked to measure a class that cannot exist.

**ID-4 — Labeled set format (C): raw tool-output arrays + `important_indices` (+ per-index `note`).** (Architect ruling 2.) Each entry: the raw JSON array (the `compress()` input), `important_indices: number[]` into the *original* array (indices, not hashes — `retainedIndices` is index-based, so survival is a direct set-membership test), and an optional per-index `note` naming why the row is salient (the audit surface proving importance ≠ bigram-richness). Top-level `curation { date, approver, corpus_snapshot, fidelity_floor }` mirroring the eval set's provenance block.

**ID-5 — The harness mirrors `eval.ts`: a new `tsx` script + its own disjoint labeled set + a baseline.** New `mcp/src/scripts/fidelity.ts` (load labeled set → run compress() → compute survival → compose verdict → print number; capture/compare a machine-local baseline). New `npm run fidelity` script (`mcp/package.json`, mirroring `eval`/`migrate`/`cutover`/`graph:build`). Committed template `mcp/eval/fidelity-payloads.template.json` → machine-local `~/.claude-data/eval/fidelity-payloads.json`, provisioned only-if-absent by `update.sh` (mirroring the eval set's seeding). Baseline at `~/.claude-data/eval/fidelity-baseline.json`.

**ID-6 — Disjointness is structural AND enforced.** The two sets are different types: the eval set is `{query, expectedPathContains}` scoring retrieval over the indexed observations corpus; the fidelity set is raw `compress()` inputs (hook-layer, never `source_path`-addressable). There is no overlap to leak. Enforce anyway: a unit test asserts the two files share no entries, and the template + `docs/eval-gate-protocol.md` document the rule ("DISJOINT by construction — these are compress() inputs, not retrieval queries; never copy rows between them — train/test leakage voids the eval gate, protocol:56-59").

**ID-7 — Important indices are labeled against the ORIGINAL input array.** `compress()`'s `retainedIndices` and `verdicts` are original-position-indexed (`smart-crusher.js:175-186,:432`). Curate against raw input; compare against `retainedIndices`. Labeling against the post-`projectRow` retained output (which strips constants and re-sorts keys, `smart-crusher.js:455-462`) would misalign the indices.

**ID-8 — Contract tripwire.** The harness asserts `verdicts.length === originalCount` on each `compress()` result; a mismatch aborts loud (a future DIO-7 indexing change must fail, not silently mismeasure).

**ID-9 — The fidelity floor is an owner-set deliverable, reported-against, never tuned.** The harness emits the measured survival rate. The arming floor for #72 is set by the operator (Jason) before arming, recorded in the labeled set's `curation.fidelity_floor`, and compared against. It is never reverse-engineered to make the harness pass (that is train/test leakage in another costume).

**ID-10 — Importance criterion is a property compress() does not consume, AND must not name preserved-class rows (Gate-1 cycle-2 correction).** To keep importance orthogonal to bigram-richness, the template's `_criterion` field defines an important row as: "a **droppable** row (one `classifyRows` does NOT preserve as error/anomaly/boundary) that a session reader would want recalled — an identifier, a path, a plain config/value field, or a descriptive line — INCLUDING terse high-value rows (low bigram count)." **Deliberately removed from the criterion: "a status," "a config/THRESHOLD value," "a failure signal"** — these trip `isErrorRow` (status/error keys, `smart-crusher.js:78-95`), boundary (a field's min/max, `:147-158`), or anomaly (rare key-shape, `:164-182`), so `compress()` PRESERVES them unconditionally (P1) and their survival is class-guaranteed, not importance-attributable. Curating such a row would inflate the rate (cycle-2 confounder). The harness independently enforces this (ID-1: a curated index that turns out `verdict !== 'droppable'` is excluded from the denominator and reported), but the criterion must not *invite* the mistake. Curation still deliberately includes terse genuinely-droppable rows — that is where the measure earns its keep.

**ID-11 — Control for BOTH non-importance survival paths by recomputing the importance-attributable set from the exported surface (Gate-1 correction).** The harness, NOT curation-placement-by-eyeball, is the authority on which curated rows are importance-attributable. For each payload it recomputes, deterministically, exactly what `compress()` does (`smart-crusher.js:389-432`):
  1. `verdicts = classifyRows(array)` (exported, ID-13) → the **P1 preserved** set = indices with `verdict !== 'droppable'`. A curated `important_index` in P1 is EXCLUDED from the denominator (class-guaranteed survival).
  2. `droppableIndices` = indices not in P1, in original order; `budget = kneedleBudget(array, droppableIndices)` (exported, ID-13); `schemaCount = round(budget * SCHEMA_FRACTION)`, `recencyCount = round(budget * RECENCY_FRACTION)` (exported, ID-13 — mirrored, not hardcoded). The **P2 position** set = the first `schemaCount` and last `recencyCount` entries of `droppableIndices`. A curated `important_index` in P2 is EXCLUDED (position-guaranteed survival).
  3. The **importance-attributable set** = curated important rows that are droppable (not P1) AND not in P2. Survival is measured ONLY over this set: an index survives iff it ∈ `retainedIndices` — which, having excluded P1 and P2, can only be because the bigram importance ranker kept it (P3).
The earlier "zero-out the row's bigram importance and re-run" idea is dropped: it is NOT cleanly executable (`rankByImportance` is private and the score derives from row content, so it cannot be zeroed without mutating the payload). The recompute-from-exported-surface path above is the single sound mechanism; it is why ID-13 exports the needed functions/constants. The instrument's output reports the importance-attributable count plus the P1-excluded and P2-excluded counts, so the denominator is fully auditable.

**ID-12 — Curation aids (advisory; the harness, not curation, is authoritative), and payloads exceed the compression floor.** (a) Curation SHOULD aim important rows at genuinely-droppable, non-position rows and record each row's intent in the per-index `note` — but this is an *aid*, not the guarantee: ID-11's harness recompute is what actually excludes P1/P2, so a curation slip degrades to an excluded row + an audit count, never an inflated number. (b) Every labeled payload MUST have `originalCount >= MIN_ROWS_TO_COMPRESS` (exported; the floor below which `compress()` returns `compressed:false` with `retainedIndices = everything`, `smart-crusher.js:376-387`) — a sub-floor payload yields trivially 100% survival and measures nothing. The harness asserts `compressed === true` per payload and skips/flags any sub-floor entry rather than counting its vacuous 100%.

**ID-13 — Export the slot-sizing surface from `smart-crusher.js` so the harness mirrors, never hardcodes.** ID-11's recompute needs `classifyRows`, `kneedleBudget`, `MIN_ROWS_TO_COMPRESS` (ALREADY exported, `smart-crusher.js:464-475`) PLUS the split fractions `SCHEMA_FRACTION` and `RECENCY_FRACTION` (currently private module consts, `smart-crusher.js:47-48`). This PRD adds those two constants to `smart-crusher.js`'s `module.exports` so the harness imports the single source of truth — if a future DIO-7 change retunes the split, the harness follows automatically instead of silently mismeasuring against a stale hardcoded 0.30/0.15. **Blast-radius note (honest correction to the earlier "pure-additive" claim):** this means the build is NOT strictly pure-additive — it modifies ONE existing hook-layer file (`smart-crusher.js`) by adding two names to its export object. This is a non-behavioral export-only change (no logic touched), and `smart-crusher.js` is NOT an eval-gated module (it is the hook-layer compressor, separate from the retrieval index — `search_config.ts`/`ranking.ts`/`indexer.ts`/`embedder.ts` remain untouched), so the project's eval-gate rule still does not trigger. But the diff touches an existing file; Gate 3 (G4) must confirm the two added exports break no `compress()` consumer.

---

## Testing Decisions

A good test asserts external behavior, not implementation detail. Prior art: `mcp/src/scripts/eval.ts` + its tests (labeled-set load, verdict composition, baseline capture/compose), and the SmartCrusher determinism tests (`hooks/lib/test/smart-crusher.test.js`).

**Modules tested:**
- **The survival computation** — given a payload + `important_indices` and a known `compress()` result, the survival rate is correct; an important row that `compress()` drops lowers the rate (US-2); error/anomaly/boundary rows are not counted (US-5).
- **The position-confounder control (ID-11, P2)** — an important row that survives ONLY because it sits in the schema-head/recency-tail position slot is EXCLUDED from the denominator; a test constructs a payload with a low-bigram important row at the array head, confirms it survives `compress()` by position, and confirms the harness does NOT count it as importance-attributable survival.
- **The class-confounder control (ID-11, P1)** — an important row that survives because it is preserved (error/anomaly/boundary, `verdict !== 'droppable'`) is EXCLUDED from the denominator; a test curates an `important_index` pointing at a row that trips `isErrorRow`/boundary/anomaly, confirms `compress()` preserves it unconditionally, and confirms the harness excludes it (reports it under the P1-excluded count) rather than crediting class-guaranteed survival as importance-attributable.
- **The compression-floor guard (ID-12)** — a sub-`MIN_ROWS_TO_COMPRESS` payload (`compressed:false`) is flagged/skipped, not counted as vacuous 100% survival.
- **Determinism** — two runs over the same set yield the byte-identical rate (US-3).
- **Disjointness guard** — the fidelity set and the eval set share no entries (US-4) — the leakage tripwire.
- **Contract tripwire** — a stubbed `compress()` result with `verdicts.length !== originalCount` makes the harness abort (US-7).
- **Baseline capture/compose** — first run captures; second run composes a delta (US-8), mirroring `eval.ts`'s baseline tests.

**Excluded from new tests:** `compress()` itself (DIO-7, already tested + determinism-certified) — the harness consumes it, does not modify it.

**Definition of Ready:** all stories meet INVEST; Gherkin ACs written; the three measurement-design decisions (ID-1, ID-4, ID-9) resolved; #59 ACs mapped. **Definition of Done:** all ACs pass; `npm test` green (this is an independent instrument gated by `npm test`, NOT `npm run eval`); red-blue-judge (diff) CLEAN; the disjointness + determinism + tautology-avoidance (US-2) tests pass.

---

## Out of Scope

- **The error/anomaly/boundary slice.** Covered by AC-5b set-containment (no model call). The harness must not re-measure it (wasted effort) nor claim to cover it (false assurance).
- **The actual #72 arming flip.** DIO-19 produces the number; #72 consumes it. Arming, the eval re-baseline run, and creating the FR-B5 flag sentinel are all #72.
- **Routing through `npm run eval`.** DIO-19 is an *independent* instrument gated by `npm test`, not a stage of the eval runner, and does not influence the eval verdict. It shares the eval set's *provisioning pattern and held-out doctrine*, not its runner.
- **Modifying any eval-gated module** (`search_config.ts`, `ranking.ts`, `indexer.ts`, `embedder.ts`) — none is touched; the harness reads `compress()` output and reports a number. (The ONE existing-file change is the export-only addition to `smart-crusher.js` per ID-13 — a non-eval-gated hook-layer file, exports only, no logic. Everything else is new files.)
- **Pinning a concrete fidelity floor number** — that is the owner-set deliverable (ID-9), set before arming, not in this PRD.
- **A live semantic judge / model call** (option b) — explicitly rejected for non-determinism; importance is curated offline.

---

## Further Notes

- **Why a separate, blocking unit (grafted from the #59 thread PRD):** keeping AC-5c.4 as a checklist line in #58 would leave it a soft, prose-shaped step waved through under arming pressure. As its own unit that blocks #72, it forces a *number* to exist before the flag flips — the one fidelity catch the eval gate cannot provide cannot then slip silently.
- **The single most important thing to get right (grafted):** the labeled set MUST be disjoint from the eval gate's held-out presence set. A leaked set produces a fidelity number that *looks* rigorous but has silently compromised the very gate it's meant to protect (ID-6).
- **The Gate-1 challenge most likely to land:** the orthogonality of the "important" label. If a curator labels importance using intuition that correlates with bigram-richness, the measure collapses toward option (a)'s tautology, hidden in the labels. ID-10 fixes the importance criterion as a content property `compress()` provably does not consume, with terse-high-value rows deliberately included, so a reviewer can audit importance ≠ richness.
- **The survival confounders (TWO, both caught by Gate-1 adversarial challenges, both fixed):** `compress()`'s `retainedIndices` is the union of THREE independent free-survival paths — **P1 preserved** (error/anomaly/boundary, kept unconditionally), **P2 position** (schema-head/recency-tail, kept by array position), and **P3 importance** (the bigram ranker). Only P3 is salience-attributable. A naive `important_indices ⊆ retainedIndices` membership test credits P1 and P2 survival as salience-retention, inflating the number and falsifying US-2. *Cycle 1* caught P2 (position); *cycle 2* caught P1 (class-preservation — and found ID-10's earlier criterion was actively inviting P1 rows by naming "a status / a threshold value / a failure signal"). The fix (ID-1 + ID-11) subtracts BOTH P1 and P2 from the denominator by recomputing the importance-attributable set from `compress()`'s exported surface (ID-13 exports the two missing slot fractions); ID-10's criterion was tightened to stop naming preserved-class rows. The instrument now measures ONLY P3 — genuine importance-ranker retention. Two real measurement-validity holes the cooperative chain missed and the adversarial challenger caught, two cycles running; the harness, not curation, is the authority on which survivals count.
- **Dependency / circularity note:** depends on DIO-7 (SmartCrusher, merged) and DIO-18 (#58, merged — the path it measures). Resolved by sequencing: #58 built default-OFF first; DIO-19 measures the compressor's fidelity (which exists as soon as the producer is built — no arming needed to run); then #72 arms only if the number is within the owner-set floor.
- **Codebase facts verified (file:line):** compress() shape + classification (`smart-crusher.js:365-448`, `:114-189`, `:175-186`); importance=bigrams (`:313-320`); 30/15/55 split (`:406-427`); retainedIndices/droppedCount (`:432`,`:444`); eval.ts mirror (`mcp/src/scripts/eval.ts`); eval labeled set + held-out doctrine (`mcp/eval/labeled-queries.template.json`, `docs/eval-gate-protocol.md:40-59`); summarizer schema fields (`summarizer-client.js:16-19`).
- **Next gate:** run `red-blue-judge mode: prd` against this PRD with the codebase + #58/#59 ACs as ground truth before implementation.
