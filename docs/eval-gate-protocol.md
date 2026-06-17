# Retrieval eval gate — protocol

The offline retrieval-quality gate proves that every change to the memory engine
(ranking, embedding, indexing) does not regress retrieval, and that **forgetting**
is a tested property. Acceptance is manual, not CI. Implemented in C1; Stage-2
absence probes arm in C2.

Source of the design: `docs/2026-06-16-c1-eval-gate-prd.md` (issue #29).

## The two layers of "forgetting"

| Layer | Invariant | Where it is enforced | Falsifiable? |
|---|---|---|---|
| **Stage 1 — archive exclusion** | Archived files never enter the corpus | `mcp/test/indexer.test.ts` unit assertions, gated by `npm test` | Yes — `isWatchIgnored(archive)===true` flips if the `/archive/` branch is removed; the post-`fullReindex` corpus assertion flips if reindex ever walks `archive/` |
| **Stage 2 — superseded-entry leak** | A superseded entry must not surface in top-k once superseded | `~/.claude-data/eval/labeled-queries.json` `stages.absence_stage_2`, scored by `npm run eval` | Armed at C2 (entry granularity does not exist until then); authored `armed:false` at C1 |

Stage 1 is **not** a labeled-absence probe at the retrieval layer — that would be
vacuous (an archived file is never indexed, so a "is it absent from top-k?" probe
always passes). It lives at the indexer boundary where the guarantee is real.

Within that indexer-boundary suite the falsifiable load is carried by the
`isWatchIgnored` test (flips if the `/archive/` branch is removed) and the
post-`fullReindex` corpus assertion (flips if reindex ever walks `archive/`). The
`classify` archive assertion documents the archive→null invariant but is redundant
with `classify`'s terminal `return null` (no archive path matches a positive branch),
so it pins the invariant against a future catch-all branch rather than uniquely
exercising the guard line.

## Running the gate

```bash
cd ~/.claude-os/mcp && npm run eval            # against ~/.claude-data/memory.db
cd ~/.claude-os/mcp && npm run eval -- --rebaseline   # force re-capture the baseline
```

The runner copies the DB to a throwaway temp file first, so the eval's own
reinforcement writes never mutate the real store. Stage 1 is reported as an
orientation line only — it is enforced by `npm test`, not by this runner.

## The labeled set (held-out — never a tuning target)

`~/.claude-data/eval/labeled-queries.json` (LabeledSet v2) — machine-local DATA,
seeded from the committed `mcp/eval/labeled-queries.template.json` by `update.sh`
Step 2.6 (only-if-absent), then curated per-machine:

- `presence.queries` — `{ query, expectedPathContains[] }`. Recall@k / MRR are scored at
  **file granularity**: an expected file is a "hit" when ANY ranked top-k result's
  `source_path` contains that substring, and the recall denominator is the count of expected
  files (the `expectedPathContains` entries) — never an observation-row count. So whole-file
  and chunked indexes score on the same scale for identical retrieval quality (see the
  granularity-aware contract below).
- `stages.absence_stage_2` — `armed` (the only arming control), `depends_on`,
  `granularity`, and `queries[].forbidden { sourcePathContains, entryDate, noveltyStatus }`.
- `k` (top-level), `curation { date, approver, corpus_snapshot }`.

**Doctrine:** the ranking weights in `src/search_config.ts` are FIXED principled
defaults and must NEVER be tuned against this set — tuning and scoring on the same
queries is train/test leakage and voids the gate. Any future calibration uses a
disjoint query set.

## Curation (a one-time human session)

The presence half is not meaningful until the placeholder queries are replaced:

1. The agent (Walter/Willis) drafts 20–30 candidate presence queries from the live
   corpus, spanning all source types (context topics, learnings, episodes) and both
   query shapes (identifier-like and conceptual).
2. Jason approves/edits down to 15–25. The set stays held-out.
3. Record `curation.date`, `curation.approver`, and `curation.corpus_snapshot`
   (the observation count at curation time).
4. Stage-2 `forbidden` targets are drafted from the live `superseded` novelty flags
   (3 superseded + 1 dismissed as of 2026-06-16).

## Baseline (machine-local, never committed)

`~/.claude-data/eval-baseline.json` records `captured_at`, `captured_on_ref`,
`corpus { db_path, observation_count, file_set_hash }`, `presence { mean_recall_at_k, mrr, k }`,
and per-stage `absence` results. `file_set_hash` is a stable hash of the corpus's distinct
`source_path` set — the granularity-invariant SHAPE signal (see the shape guard below);
`observation_count` is retained as human-readable provenance only.

- **First run** (baseline absent): the runner writes the baseline and prints
  `BASELINE CAPTURED` with no verdict. Capture on the **pre-change** index so
  "non-regressing" is an evidenced comparison.
- **Subsequent runs:** read the baseline and compose a verdict.
- Never silently overwritten — re-baseline only via the explicit `--rebaseline` flag.
- Per-machine (Willis's and Walter's corpora differ), so it is not committed.

## Verdict rule (precedence: CAPTURING > FAIL > INCONCLUSIVE > PASS)

Per absence stage: `armed:false` → SKIPPED (cannot touch the verdict); `armed:true`
with zero probes → INCONCLUSIVE (a gate that cannot fail must not pass silently);
`armed:true`, all probes pass → PASS; any probe fails → FAIL.

Presence: baseline absent → CAPTURING (no verdict that run); `recall@k ≥ baseline`
AND `MRR ≥ baseline` → PASS; either below baseline → FAIL; any presence query that
resolves zero relevant ids → INCONCLUSIVE (broken labels — fix the labels, not the
ranker).

**Composed:** PASS only when presence PASS, every armed absence stage passes 100%, and no
corpus-shape change at the cutover boundary. Any FAIL ⇒ FAIL. Else any INCONCLUSIVE (a stage,
broken labels, or a shape change) ⇒ INCONCLUSIVE. INCONCLUSIVE halts like a FAIL, but the fix
is "fix labels / resolve anchor / investigate the file set," not "fix the ranker." The
composed verdict covers presence + Stage 2 + the shape guard; Stage 1 is enforced by the
indexer unit suite (`npm test`).

## Granularity-aware scoring (file-level) — the cutover precondition

Presence recall@k / MRR are scored at **file granularity**, not over observation rows. This is
what lets one labeled set score a whole-file index and a chunked index on the same scale:

- A presence query is a **hit** for an expected file if ANY chunk of that file
  (`source_path` containing the label substring) surfaces in top-k.
- **File-level recall** = (expected files with at least one chunk in top-k) / (expected
  files). The denominator is the `expectedPathContains` count — identical at both
  granularities by construction, so a chunk-split (one file → N rows) cannot suppress it.
- **File-level MRR** keys off the rank of the first ranked result whose `source_path` matches
  any expected substring — comparable across granularities.

Why it matters: scoring over observation-row ids made recall granularity-dependent — a file
split into ~118 chunks capped recall@5 at ~5/118 even with perfect retrieval, so a chunked
index spuriously FAILed non-regression against a whole-file baseline. File-level relevance
separates retrieval quality from index granularity. The held-out doctrine is unaffected: the
same labels are reinterpreted at file granularity; no `search_config.ts` weight changes, no
labeled-set schema change.

## File-set corpus-shape guard (WARN W2)

The verdict also asserts that the corpus's **file set** did not silently change across the
cutover. The guard keys on the distinct `source_path` set (a stable hash), NOT the row count —
a chunk-split multiplies rows but leaves the file set identical, so the guard does not trip on
the cutover itself, only on a file genuinely added or removed.

- **Runs ONLY at the cutover boundary** — discriminated by the `c2_chunking_enabled` marker on
  the index. At a routine `/memory-merger` close (marker off) the guard does not run: file
  churn is expected there and presence non-regression is the gate.
- **Zero tolerance, INCONCLUSIVE (never FAIL).** At the boundary, any file added or removed vs.
  the baseline's file set ⇒ INCONCLUSIVE with a verdict-line reason naming the delta. This
  mirrors the k-mismatch branch: incomparable inputs produce INCONCLUSIVE, not a misleading
  pass/fail. A genuine presence/absence FAIL still dominates — a shape change never masks a
  real regression.
- A baseline captured before this fix lacks `file_set_hash`, so it cannot be compared (no
  spurious escalation); the mandatory re-baseline at the version boundary recaptures it.

## When to run

- Before and after any change to a ranking, embedding, or indexing module
  (capture the baseline on the pre-change index; compose the verdict after).
- At the close of every `/memory-merger` session, so each supersession and prune is
  immediately checked for leakage (wired into the memory-merger skill's closing step).

## C2 cutover (System Architect watch-item 3)

The C2 chunk-split CUTOVER ships with `c2_chunking_enabled` **default off** — the
index continues serving whole-file rows until an eval baseline confirms non-regression.
With granularity-aware (file-level) scoring in place, this protocol is now executable as
written: a whole-file baseline and a post-cutover chunked run score on the same scale, so a
PASS means "the cutover did not regress retrieval."

**Before** flipping the flag or running `npm run cutover`:

1. **Mandatory re-baseline** on the pre-chunk (whole-file) index. This is required at this
   version boundary: a pre-fix baseline used observation-row-scaled recall and lacks
   `file_set_hash`, so it is not comparable to file-level numbers. Re-capture it first:
   ```bash
   cd ~/.claude-os/mcp && npm run eval -- --rebaseline
   ```
2. Run the cutover:
   ```bash
   cd ~/.claude-os/mcp && npm run cutover
   ```
3. Immediately run the gate to verify non-regression:
   ```bash
   cd ~/.claude-os/mcp && npm run eval
   ```
4. A PASS verdict is required before the cutover is considered safe. A FAIL or
   INCONCLUSIVE result means the migration must be investigated — do **not** leave
   the index in the chunked state without a passing gate. At this boundary the file-set
   shape guard is live: if the cutover quietly added or dropped a file, the verdict is
   INCONCLUSIVE (file set changed), distinct from a FAIL (retrieval regressed).

The cutover is a one-way migration (existing whole-file rows are replaced with
anchored per-entry rows). The pre-cutover (file-level) baseline is the comparison point;
never overwrite it with `--rebaseline` until a PASS is in hand.
