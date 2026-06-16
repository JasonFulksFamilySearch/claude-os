# C1 — Arm the Offline Retrieval Eval Gate (PRD)

> Persisted from GitHub issue #29. This is the approved revised PRD whose design gate
> passed (System Architect + AI Scientist BLOCKs cleared) and was authorized for
> implementation via #37. Implementation plan: `docs/superpowers/plans/2026-06-16-c1-eval-gate.md`.
> Gate protocol: `docs/eval-gate-protocol.md`.

---

## REVISED C1 PRD — 2026-06-16 (applies both finalized reviewer directions)

This comment carries the revised C1 PRD body for re-review. It applies the System Architect's Stage-1 relocation and the AI Scientist's finalized arming/schema/baseline/verdict direction (both authorized via #37). This revised body supersedes the original PRD in the issue description for design-gate purposes; reviewers should re-confirm against this.

Engineer note on the delta: `mcp/test/indexer.test.ts` already partially covers archive exclusion (`classify` "rejects archive files" at :145-148; `fullReindex` `not.toContain(archive/old.md)` at :397). The three Stage-1 assertions below STRENGTHEN/EXTEND that coverage — the genuinely new parts are the positive controls, the extracted `isWatchIgnored` predicate, and the control-backed corpus check.

---

# PRD — C1: Arm the Offline Retrieval Eval Gate (presence + forgetting-absence probes)

**Date:** 2026-06-11 (revised 2026-06-16) · **Status:** Draft for adoption · **Series:** Memory C-series, item 1 of 3 (build order C1 → C2 → C3)
**Provenance:** AI-generated (Walter), revised 2026-06-16 per System-Architect + AI-Scientist authorized direction (via #37) and verified against live MCP source. Pending human review.

## Revision note (2026-06-16)

Two finalized reviewer directions are applied; reviewers should diff against the prior body on three axes:

1. **Stage 1 relocated from retrieval-layer absence probes to indexer-boundary unit assertions.** Stage 1 (archive exclusion) is no longer a labeled-absence probe class in `labeled-queries.json` and is no longer scored by the eval runner. It is now three unit assertions in `mcp/test/indexer.test.ts` (classify guard + positive control; an extracted exported watcher predicate; a post-`fullReindex` corpus assertion). Stage 1 gates via `npm test`. This removes the "naive archive probes are vacuous" hazard at its root.
2. **Stage-2 arming protocol decided:** superseded-entry absence queries are **authored UNARMED (`armed:false`) at C1** and **armed (`armed:true`) at C2**. No new queries added at C2 — C2 flips the flag and adds anchor resolution.
3. **Schema, baseline file, and verdict logic finalized** (exact shapes, machine-local baseline path + capture procedure, PASS/FAIL/INCONCLUSIVE truth table with precedence).

KEEP set re-confirmed: presence half (recall@k, MRR, per-query reporting), recorded-baseline non-regression, tri-state verdict (now scoped to Stage 2 only), AND composition — with the composed gate verdict conditioned on the indexer unit suite passing.

## Problem Statement

The claude-os memory subsystem ships a retrieval-quality gate that has never been armed. The pieces all exist: presence metrics (recall@k, MRR) in `mcp/src/eval.ts` with a runner `mcp/src/scripts/eval.ts` (`npm run eval`); the labeled query set `mcp/eval/labeled-queries.json:2` whose own `_note` says the entries are ILLUSTRATIVE PLACEHOLDERS needing Jason's curation; and the tuning doctrine in `mcp/src/search_config.ts:3-5` (weights are FIXED defaults, NOT fit to the held-out eval set).

So every change to ranking, embedding, or indexing currently ships unverifiable: improvement is indistinguishable from regression. Worse, the harness has **no concept of absence** — nothing tests that superseded or archived content stays OUT of retrieval. The Memora/FAMA benchmark (arXiv 2604.20006, 2026-04-21) found 17.8–29.5% degradation across six memory agents from reliance on invalidated memories — invisible to retrieval-only metrics. claude-os has supersession mechanics (novelty flags with `superseded`; archive-before-delete) but no test that they keep retired content out of results.

This C1 work addresses absence at two distinct layers:

- **Archive exclusion (Stage 1)** is an *indexer-boundary* invariant: archived files must never enter the corpus. Already enforced in three places in `mcp/src/indexer.ts` — `classify` returns `null` for archive paths (`:42`), the watcher ignores `/archive/` (`:384`), and `fullReindex` only walks indexable trees (`:270`). The right test is at the indexer boundary, not retrieval: an archived file that is never indexed can never appear in a result, so a retrieval-layer "is the archived doc absent from top-k?" probe is *vacuously* satisfied and proves nothing.
- **Superseded-entry leak (Stage 2)** is a *retrieval-layer* invariant: a superseded entry IS in the corpus but must not surface in top-k once superseded. Only expressible at entry granularity, which does not exist until C2 — so Stage 2 is authored now but armed at C2.

Decisions blocked by the unarmed gate: C2's entry-granular cutover cannot prove non-regression; the "do we need a re-ranker?" question is undecidable (2026 guidance: rerank only on proven failure); C3 threshold calibration has no evidence protocol. Scale: memory.db holds 242 observations — a regression gate, not a statistical benchmark.

## Solution

Every future change to the memory engine has to prove itself, and forgetting becomes a tested property at both layers it can leak.

A one-time curation session replaces placeholder presence queries with 15–25 real ones (Walter drafts from the live corpus; Jason approves/edits each; the set stays held-out). Forgetting is guarded in two separated places:

- **Stage 1 — archive exclusion — standing unit assertions** in `mcp/test/indexer.test.ts`. Three assertions prove the invariant at its boundary: `classify` rejects an archive path (paired with a positive control proving the guard is selective); an extracted exported watcher predicate excludes `/archive/`; and after a real `fullReindex`, no `observations` row's `source_path` contains `/archive/` while a legitimately-indexed control IS present. Run on `npm test`; armed by definition (a Vitest assertion runs+passes or runs+fails — no NOT-ARMED state).
- **Stage 2 — superseded-entry leak — retrieval-layer absence probes** in `labeled-queries.json` under `stages.absence_stage_2`. Authored UNARMED at C1 (`armed:false`), armed at C2 (`armed:true`). An unarmed stage is skipped — cannot touch the verdict. An armed stage with zero queries reports INCONCLUSIVE rather than passing silently.

The eval runner runs before/after any engine change and at the close of every memory-merger session, comparing presence + armed-absence against a recorded machine-local baseline. The **composed gate verdict is conditioned on the indexer unit suite passing**: Stage 1 gates via `npm test`; the runner's composed verdict covers presence + Stage 2 only, with one orientation line noting Stage 1 is enforced by the unit suite.

## User Stories

1. Curated set of real memory queries with expected results — retrieval quality measured, not assumed.
2. Walter drafts candidates from the actual corpus for Jason's approval — minutes, not an afternoon; final say stays Jason's.
3. Gate run before/after any ranking, embedding, or indexing change — regressions caught before they ship.
4. A recorded baseline captured on the pre-change index — "non-regressing" is evidenced, not judged.
5. The indexer's archive-exclusion invariant asserted as standing unit tests — archived content can never enter the corpus; the guard is regression-tested at the boundary that enforces it, not tested vacuously at the retrieval layer.
6. The archive-exclusion logic extracted into a single exported predicate and asserted directly (classify guard + positive control; extracted watcher predicate; post-`fullReindex` corpus check with a non-archive control).
7. Superseded-entry absence probes authored now but unarmed, armed automatically when C2 lands — the new granularity is immediately regression-tested and the C1→C2 contract is a reviewable diff.
8. Any *armed* Stage-2 stage with zero probes reports INCONCLUSIVE; any *unarmed* stage is skipped — a gate that cannot fail can never masquerade as passing.
9. Gate run automatically at the end of each memory-merger session — every supersession/prune checked for leakage.
10. Labeled query set kept held-out — never used to tune ranking constants.
11. Runner shows per-query results alongside means — at small scale, see which query moved.
12. Verdict rule written down (PASS/FAIL/INCONCLUSIVE with precedence; presence non-regression AND every armed Stage-2 stage 100%; composed verdict conditioned on the indexer unit suite passing) — acceptance is mechanical though manual.

## Implementation Decisions

### Stage 1 — archive-exclusion unit assertions (`mcp/test/indexer.test.ts`)

The file already imports `classify`/`indexFile`/`fullReindex` (`:16-21`) and creates `dataRoot/archive/` in `beforeEach` (`:38`) — no new harness. Existing partial coverage: `classify` "rejects archive files" (`:145-148`); `fullReindex` `not.toContain(archive/old.md)` (`:397`). The three assertions STRENGTHEN/EXTEND this; fold into existing tests or add adjacent, but the new coverage must exist.

1. **`classify` guard + positive control.** `classify("<dataRoot>/archive/X.md", config) === null` (guard at `mcp/src/indexer.ts:42`), paired with a positive control asserting a non-archive path (e.g. `context/*.md`) classifies non-null. Pairing proves the guard is *selective*.
2. **Extracted, exported watcher predicate.** The watcher's archive logic is an inline anonymous `ignored` arrow inside `watchAll` (`mcp/src/indexer.ts:382-393`; archive check `:384`) — no exported predicate today. Extract into `export function isWatchIgnored(p: string, config: IndexerConfig): boolean`, preserving the three branches verbatim: archive (`norm.includes("/archive/")`), `_legacy*` basenames, episodes `_*` skip. `watchAll` then calls `ignored: (p) => isWatchIgnored(p, config)`. Pure refactor — behavior unchanged, no external callers. Test asserts `isWatchIgnored(<archive>, config) === true` AND `isWatchIgnored(<context>, config) === false`. Chosen name `isWatchIgnored`; if changed it must still be exported and preserve the three branches.
3. **Post-`fullReindex` corpus assertion.** Write an archived `.md` into `dataRoot/archive/` AND a legitimately-indexed file elsewhere, run `fullReindex(db, config)` (`:270`), then assert `SELECT source_path FROM observations` returns ZERO rows containing `/archive/` AND the non-archive control IS present (not vacuously true).

These gate via `npm test`. Armed by definition — no NOT-ARMED state.

### Stage 2 — labeled-queries.json schema (LabeledSet v2)

```jsonc
{
  "_note": "HELD-OUT ground truth. NEVER a tuning target (train/test leakage voids the gate).",
  "k": 5,
  "curation": { "date": "YYYY-MM-DD", "approver": "Jason", "corpus_snapshot": "<observation_count or ref>" },
  "presence": { "queries": [ { "query": "jira ticket transitions", "expectedPathContains": ["jira"] } ] },
  "stages": {
    "absence_stage_2": {
      "armed": false,
      "depends_on": "C2",
      "description": "Superseded entries must not surface in top-k once superseded. Entry-granular; unresolvable to an anchor until C2.",
      "granularity": "entry",
      "queries": [
        { "query": "<query that would surface the stale entry>",
          "forbidden": { "sourcePathContains": "<source_path substring>", "entryDate": "YYYY-MM-DD", "noveltyStatus": "superseded" } }
      ]
    }
  }
}
```

Rules: `k` stays top-level (serves recall@k and the absence top-k window). `presence` keeps the existing shape so the runner's presence loop (`mcp/src/scripts/eval.ts:73-83`) changes only to read `set.presence.queries`. **`armed` is the ONLY arming control** — queries present + `armed:false` = unarmed (skipped); `armed:true` + zero queries = INCONCLUSIVE. `noveltyStatus` defaults to `"superseded"` (dismissed coverage = added rows if Jason widens). **No `absence_stage_1` block exists** — Stage 1 is the unit suite; the runner prints one orientation line so its absence reads as intentional.

### Stage-2 arming decision (authorized — do not re-litigate)

Authored UNARMED (`armed:false`) at C1, armed (`armed:true`) at C2. No new queries added at C2 — C2 flips the flag and adds anchor resolution. Rationale: forbidden targets are knowable now from the live `superseded` flags (9 confirmed) but unresolvable to an index anchor until C2's entry-granular rows exist — exactly what `armed:false` encodes. Authoring at C1 makes the C1→C2 contract a reviewable diff; unarmed probes are skipped so they cannot touch the verdict pre-C2.

### Baseline file

- **File:** `~/.claude-data/eval-baseline.json` — machine-local, NOT committed (per-machine corpus state differs between Willis's and Walter's stores).
- **Structure:** `captured_at`, `captured_on_ref`, `corpus {db_path, observation_count}`, `presence {mean_recall_at_k, mrr, k}`, `absence {absence_stage_2: {armed:false, pass_rate:null, n:0}}`.
- **Capture:** once, on the first `npm run eval` after C1 approval, on the pre-change index. Absent ⇒ runner writes it and prints BASELINE CAPTURED (no verdict that run). Present ⇒ reads and composes a verdict. Never silently overwritten — re-baseline only via explicit `--rebaseline`. Rides the runner's existing throwaway-DB-copy behavior (`mcp/src/scripts/eval.ts:60-65`) so the baseline run never mutates the real store.

### Runner additions

Reads `set.presence.queries` and `set.stages`. Prints per-query presence + mean recall@k + MRR (retains the `[no ground-truth match — fix labels]` flag at `:81`, which now drives the presence INCONCLUSIVE case). Per stage: SKIPPED when `armed:false`; INCONCLUSIVE when `armed:true` + `n=0`; else per-stage pass-rate with `n`. First run (baseline absent) writes baseline + prints BASELINE CAPTURED (no verdict); else composes the verdict. Prints one orientation line that Stage 1 is enforced by the indexer unit suite. Preserves the existing doctrine banner (`:87-89`).

### Other decisions

- **Curation:** Walter drafts 20–30 presence candidates across source types and query shapes; Jason approves to 15–25 in one session. Stage-2 `forbidden` targets drafted from the live `superseded` flags. Date/approver/snapshot recorded in `curation`.
- **Doctrine preserved.** Labeled set never a tuning target; future calibration uses a disjoint set; the `search_config.ts` doctrine comment stays.
- **No engine changes.** Measurement only — no schema migration, no retrieval-behavior change, no new write paths. Sole production touch is the pure `isWatchIgnored` extraction (behavior-preserving).
- **Effort:** ~0.5–1.5 days plus Jason's curation session.

## Testing Decisions

Tests assert external behavior. Prior art: `mcp/test/eval.test.ts` (pure metrics) and `mcp/test/indexer.test.ts` (indexer boundary).

- **Stage 1 (indexer.test.ts), gates via `npm test`:** the three assertions above; not scored by the eval runner.
- **Stage 2 + presence (eval module/runner), tested as pure logic against fixtures:** absence-pass math at the k boundary; per-stage aggregation incl. `armed:false`→SKIPPED and `armed:true`+`n=0`→INCONCLUSIVE; verdict composition against a fixture baseline; baseline capture-vs-compose branch; runner output against a small fixture corpus.
- **Excluded:** the curation session (human protocol); the live baseline-capture run (operational); the memory-merger prose step; the `--rebaseline` destructive write (operational, guarded by being explicit).

### Verdict truth table (precedence FAIL > INCONCLUSIVE > PASS)

Covers presence + Stage 2 only; conditioned on the indexer unit suite passing (a Stage-1 unit failure is a hard stop via `npm test`, independent of this line).

Per absence stage: `armed:false` → SKIPPED; `armed:true`,`n=0` → INCONCLUSIVE; `armed:true`,`n>0`,all pass → PASS; `armed:true`,`n>0`,any fail → FAIL.

Presence: baseline absent → capturing (no verdict); recall@k ≥ baseline AND MRR ≥ baseline → PASS; either < baseline → FAIL; any presence query with `n=0` resolved relevant ids → INCONCLUSIVE (broken labels — the existing `[fix labels]` condition at `:81`).

Composed: PASS only when presence PASS AND every armed absence stage PASS (`n>0`, 100%). Any FAIL ⇒ FAIL. Else any INCONCLUSIVE ⇒ INCONCLUSIVE. INCONCLUSIVE halts like a FAIL but the fix is "fix labels / resolve anchor," not "fix the ranker." Tri-state now scoped to Stage 2 only.

## Reconciliation (for both reviewers)

- **Stage 1 — archive exclusion:** indexer-boundary unit assertions in `mcp/test/indexer.test.ts`; gates via `npm test`; NO block in `labeled-queries.json`; always-active, armed-by-definition.
- **Stage 2 — superseded-entry leak:** retrieval-layer absence probes under `stages.absence_stage_2`; authored unarmed at C1, armed at C2; gates via the eval runner's composed verdict.
- The composed verdict draws absence inputs ONLY from `stages`. The runner's orientation line marks Stage 1's absence from `stages` as intentional.

## Out of Scope

Re-ranking / query-intent classification (deferred until the gate proves fusion-resistant misses); Stage-2 anchor resolution (rides C2 and doubles as its acceptance tests); CI automation (acceptance stays manual); any change to retrieval behavior, ranking constants, schema, or write paths (sole touch is the behavior-preserving `isWatchIgnored` extraction); committing the baseline file (machine-local by design).

## Further Notes

- **RBJ history:** cycle 1 ESCALATE (verified live: 9 `superseded` flags; archive prune artifacts 2026-06-04/06-10); cycle 3 REVISE (entry-level absence probes not expressible pre-C2; naive archive probes vacuous → two-layer design); cycle 4 CLEAN. The 2026-06-16 revision carries cycle 3 to its conclusion: Stage 1 moved entirely off the retrieval layer onto indexer-boundary unit assertions.
- **Research grounding (2026-06-10):** Memora/FAMA (arXiv 2604.20006, 2026-04-21); Supermemory hybrid-search guidance (2026-04-23, RRF k=60); Mem0 State of AI Agent Memory 2026 (2026-06-10).
- **Risk register:** (1) curation leakage — doctrine + disjoint-set; (2) probe brittleness — Stage-2 references path substrings + entry dates, not row ids; Stage-1 references the stable archive-path convention; (3) small-n noise — per-query reporting + gate-not-benchmark framing; (4) `isWatchIgnored` extraction behavior drift — mitigated by verbatim branches + true/false assertions.
- **Deferred decisions:** `dismissed` coverage (default superseded-only; Jason may widen at curation); per-query verdict weighting (default unweighted).

