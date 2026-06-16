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
| **Stage 2 — superseded-entry leak** | A superseded entry must not surface in top-k once superseded | `mcp/eval/labeled-queries.json` `stages.absence_stage_2`, scored by `npm run eval` | Armed at C2 (entry granularity does not exist until then); authored `armed:false` at C1 |

Stage 1 is **not** a labeled-absence probe at the retrieval layer — that would be
vacuous (an archived file is never indexed, so a "is it absent from top-k?" probe
always passes). It lives at the indexer boundary where the guarantee is real.

## Running the gate

```bash
cd ~/.claude-os/mcp && npm run eval            # against ~/.claude-data/memory.db
cd ~/.claude-os/mcp && npm run eval -- --rebaseline   # force re-capture the baseline
```

The runner copies the DB to a throwaway temp file first, so the eval's own
reinforcement writes never mutate the real store. Stage 1 is reported as an
orientation line only — it is enforced by `npm test`, not by this runner.

## The labeled set (held-out — never a tuning target)

`mcp/eval/labeled-queries.json` (LabeledSet v2):

- `presence.queries` — `{ query, expectedPathContains[] }`. Recall@k / MRR are
  measured over the observations whose `source_path` contains any expected substring.
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
`corpus { db_path, observation_count }`, `presence { mean_recall_at_k, mrr, k }`,
and per-stage `absence` results.

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

**Composed:** PASS only when presence PASS and every armed absence stage passes 100%.
Any FAIL ⇒ FAIL. Else any INCONCLUSIVE ⇒ INCONCLUSIVE. INCONCLUSIVE halts like a
FAIL, but the fix is "fix labels / resolve anchor," not "fix the ranker." The
composed verdict covers presence + Stage 2 only; Stage 1 is enforced by the indexer
unit suite (`npm test`).

## When to run

- Before and after any change to a ranking, embedding, or indexing module
  (capture the baseline on the pre-change index; compose the verdict after).
- At the close of every `/memory-merger` session, so each supersession and prune is
  immediately checked for leakage (wired into the memory-merger skill's closing step).
