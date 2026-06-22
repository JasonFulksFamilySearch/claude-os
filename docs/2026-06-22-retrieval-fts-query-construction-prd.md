# PRD — Retrieval fix: FTS query construction for natural-language queries

**Status:** Draft for review — revised after RBJ cycles 1–3 (cycle 1 ESCALATE→product, resolved; cycle 2 REVISE→S4 contract break; cycle 3 ESCALATE→cap, S1 root-cause overclaim — corrected here, fix unchanged)
**Author:** Willis (with Jason Fulks)
**Date:** 2026-06-22
**Tracking issue:** [#82](https://github.com/JasonFulksFamilySearch/claude-os/issues/82) (retrieval gap — root cause confirmed here)
**Related:** [#85](https://github.com/JasonFulksFamilySearch/claude-os/issues/85) (single-retriever / reinforcement imbalance — out of scope) · [#83](https://github.com/JasonFulksFamilySearch/claude-os/issues/83) (doctor detects zero-recall labels)
**Confidence in root cause:** ~95% (empirically confirmed against the live corpus — see Further Notes)

> **Revision note (cycle 1 → 2):** The fix strategy changed from *unconditionally* sanitizing every query to a **fallback** strategy (try as-written, fall back to sanitized-OR only on throw/zero-hits). This preserves the tool's advertised phrase/boolean contract (was RBJ S4 FAIL) and makes regression of passing queries impossible by construction (was RBJ F4). Concrete `file:line` citations added (was S1 FAIL). The observability log change is now explicitly scoped (was F2).
>
> **Revision note (cycle 2 → 3):** The fallback trigger was narrowed. A *zero-hit* result triggers the fallback ONLY for a **bare natural-language** query (no quotes, no boolean operators, no `column:` filter); a valid FTS5 query (a quoted phrase or a boolean expression) that legitimately returns zero rows is preserved, not flattened. A *throw* always falls back. This closes the red challenger's cycle-2 S4 catch: a restrictive `checkstyle NOT gradle` that correctly matches nothing must not be rewritten into `checkstyle OR not OR gradle`.
>
> **Revision note (cycle 3 → final):** The root-cause framing was corrected. The cycle-3 red challenge (verified directly) showed the prior claims "file size is incidental" / "purely FTS-validity" were false: an FTS-silent multi-chunk file still retrieves, while an FTS-silent single-row file misses. The root cause is now stated as a **two-factor interaction** (invalid-FTS trigger × single-row-file exposure). **The fix itself is unchanged** — it was validated across all three cycles; only the causal narrative was overstated.

---

## Problem Statement

Certain topics in Jason's memory never surface when searched, even though the relevant file is in the corpus. Five labeled presence queries return **zero** recall — the operator asks a natural question ("familysearch role, team, and tech stack", "maven clean test and checkstyle pre-commit gate") and the file that answers it (`context/familysearch.md`, `context/java.md`) does not appear in the top results at all.

Beneath the symptom is a defect in how search is performed. The hybrid search fuses two retrievers — a keyword (FTS5) retriever and a vector (semantic) retriever. The keyword retriever is handed the **raw natural-language query string** directly as an FTS5 `MATCH` expression (`search_memory.ts:124`, `.all(args.query, …)`). Natural-language text is frequently not a valid or useful FTS5 query:

- Punctuation that is FTS5 syntax — commas, em-dashes, and hyphenated terms like `pre-commit` and `claude-os` — makes the expression **throw a syntax error**.
- A bare multi-word string is interpreted as an **implicit AND of all tokens**, so unless one document contains every word, it matches **nothing**.

Because the FTS call is wrapped in a swallowing `try/catch` (`search_memory.ts:133-135`), these failures are **silent**: the keyword retriever simply contributes nothing, the operator sees no error, and the hybrid model quietly degrades to vector-only. When that happens, a candidate's fused score collapses to a single vector-rank term (`ranking.ts:78-83`, `rrfScore`) that is small enough for reinforcement noise (frequently-accessed recent session episodes) to leapfrog the genuinely-best file — which, in every failing case measured, the vector retriever had ranked **first**.

The original issue (#82) framed this as "small single-row context topics don't rank." That observation is **half the picture** — file size is a real co-factor, not a red herring. The defect is an **interaction of two factors**: (1) **the trigger** — the raw NL query silences the FTS keyword retriever (it throws or implicit-AND-matches nothing), degrading the hybrid model to vector-only; (2) **the exposure** — when FTS is silent, a *single-row* file (≤2000 chars, `chunker.ts:79`) has exactly one vector hit, whose lone RRF term sits within the reinforcement band and is leapfrogged by reinforced episodes, whereas a *multi-chunk* file has many vector hits and survives on vector alone. So FTS-silence is only *fatal* for single-row files. #82 correctly identified *which* files miss; the missing piece was *why* (the FTS-construction trigger). The fix targets the trigger — restoring a valid FTS query gives the single-row files a keyword hit and lifts them specifically.

## Solution

Construct the FTS query through a **fallback strategy** before it reaches `MATCH`, so the keyword retriever contributes for natural-language input the way the design assumes — *without* breaking the FTS5 syntax the tool already advertises.

From the operator's perspective: searching memory with an ordinary phrase — punctuation, hyphens, and all — returns the file that answers it, in the top results; and a caller who deliberately uses FTS5 syntax (a quoted phrase, a boolean expression) still gets exactly that.

Concretely:

- **Try the query as written first.** This preserves the advertised contract (`search_memory.ts:42`: *"Phrase quoting allowed (e.g. \"checkstyle\"). Boolean operators OR/AND/NOT are supported."*) for callers — including a well-behaved model — who send valid FTS5.
- **Fall back when the as-written query (a) throws, or (b) returns zero hits AND the query is bare natural language** — i.e. it contains no explicit FTS5 syntax (no double-quotes, no boolean operators `OR`/`AND`/`NOT`/`NEAR`, no `column:` filter). A *valid* FTS5 query (a quoted phrase or a boolean expression) that legitimately returns zero rows — e.g. a restrictive `checkstyle NOT gradle` — is a correct empty result, **not** a construction failure, so it is left as-is and never flattened. When the fallback does fire, it **normalizes punctuation** (so it never throws), **lowercases tokens** (so an input word like `OR`/`NEAR` becomes a term, not an operator), and **OR-combines** the survivors (so a strong partial match counts instead of requiring every token).
- **Passing queries are byte-identical.** A query that already returns FTS hits never reaches the fallback, so the 16 currently-passing queries cannot regress — the fix is surgical to exactly the broken inputs.
- Leave the **vector retriever unchanged** — embeddings already handle natural language well (it is the keyword side that was broken).
- Change **no ranker weights.** `search_config.ts` is not touched, so the held-out eval set is never a tuning target and train/test leakage is structurally impossible.

This was proven against the live corpus: with only the FTS query construction changed (the sanitized fallback) and weights untouched, all five failing files move to FTS position 1 and four of five rise from absent into the top-5 (see Further Notes for the measured before/after).

---

## User Stories

### A. The core retrieval fix

**1. As the operator, I want a natural-language query containing commas or dashes to return results instead of silently failing, so that ordinary questions retrieve the right memory.**
```
Given a query like "familysearch role, team, and tech stack"
When I search memory
Then the as-written FTS query throws, so the builder falls back to a sanitized query that does not throw
And the file that answers the query appears in the top-5 results
```

**2. As the operator, I want hyphenated terms to be handled, so that topics like "pre-commit" and "claude-os" are searchable.**
```
Given a query containing "pre-commit" or "claude-os"
When the as-written query fails (throw or zero hits)
Then the fallback normalizes the hyphenated term into valid FTS5 tokens
And the query does not raise an FTS5 syntax error
```

**3. As the operator, I want a multi-word query that matches nothing under implicit-AND to fall back to matching most of the words, so that a good partial match is not discarded.**
```
Given a query "background agents scheduled cron jobs" that returns zero hits as written (implicit-AND)
When the builder detects zero hits AND the query is bare natural language (no quotes / boolean operators)
Then it retries with OR semantics (not implicit-AND-of-all-tokens)
And a document strongly matching a subset of terms is retrieved and ranked by bm25
```

**4. As the operator, I want both retrievers to contribute for natural-language queries, so that a clear best match is not leapfrogged by reinforcement noise.**
```
Given a query whose answer file is the #1 vector hit
When the FTS fallback now also surfaces that file
Then the file receives both an FTS and a vector RRF term
And it ranks above tangentially-related rows that only one retriever surfaced
```

### B. Contract preservation (the cycle-2 addition)

**5. As an MCP caller (or the model) using the advertised query syntax, I want a quoted phrase to be honored, so that the tool keeps the contract it documents.**
```
Given a query 'context "exact phrase"' that is valid FTS5 and returns hits as written
When I search memory
Then the as-written query is used and the phrase semantics are preserved
And the sanitized fallback is NOT invoked
```

**6. As an MCP caller, I want an explicit boolean query (A AND B, A NOT B, A OR B) to be honored, so that OR-combination does not override my intent.**
```
Given a query "checkstyle NOT gradle" that is valid FTS5 — whether it returns rows OR legitimately matches nothing
When I search memory
Then the as-written boolean query is used unchanged (the "intentional FTS5?" predicate is true, so the zero-hit fallback never fires)
And a zero-row result is returned as a correct empty result — NOT flattened into "checkstyle OR not OR gradle"
```

### C. Robustness of the query builder

**7. As the operator, I want the fallback to never throw, so that the keyword retriever is never silently disabled by a syntax error.**
```
Given any natural-language input, including FTS5 operator characters
When the fallback builder runs
Then it returns a valid FTS5 MATCH expression (or an explicit "no FTS query" signal that skips FTS)
And executing it against the FTS index does not raise
```

**8. As the operator, I want an input that reduces to zero usable terms to be handled gracefully, so that degenerate input does not error.**
```
Given an input that reduces to zero usable terms after normalization
When the builder runs
Then it signals "no FTS query" and the search proceeds on the vector retriever alone
And no exception is raised
```

**9. As a maintainer, I want a triggered FTS catch to be observable, so that a future silent failure is not invisible the way this bug was.** *(In-scope robustness addition beyond #82 — see Out of Scope note.)*
```
Given the FTS retriever's safety-net catch is triggered at runtime (search_memory.ts:133-135)
When it swallows an error
Then the event is logged via the existing logger (not silently discarded)
So that a future malformed-query regression is diagnosable
```

### D. Quality preservation (no regressions, no leakage)

**10. As a maintainer, I want every currently-passing query to be verified unchanged, so that the fix does not trade one set of misses for another.**
```
Given the held-out presence queries that already retrieve correctly
When the fix is applied
Then a per-query before/after comparison across ALL 21 queries shows none regressed
And (by construction) passing queries never entered the fallback path
```

**11. As a maintainer, I want no ranker weights changed, so that the held-out eval set is never a tuning target.**
```
Given the fix is implemented
When the change is reviewed
Then search_config.ts contains no modified weights
And the only behavioral change is in how the FTS query string is built
```

**12. As a maintainer, I want the held-out eval to compose PASS, with a per-query check as the real acceptance bar, so that a mean-masked swap cannot pass undetected.**
```
Given the fix is complete and tests pass
When `npm run eval` is run once as the non-regression gate
Then it composes a PASS verdict (mean recall/MRR >= baseline)
And a per-query before/after diff confirms each of the 21 individually held or improved
  (the eval verdict is MEAN-based — eval.ts presenceVerdict — so the per-query diff is required, not the mean alone)
```

### E. Scoped exclusion made explicit

**13. As a maintainer, I want the single-retriever/reinforcement imbalance left untouched here, so that this PR stays a focused query-construction fix.**
```
Given a query that genuinely only one retriever can answer even after the fix
When this fix is applied
Then the reinforcement-vs-single-RRF-term imbalance is unchanged
And that robustness question is tracked separately (#85), not addressed in this PR
```

---

## Implementation Decisions

1. **New pure module: the FTS query builder.** A deep, side-effect-free module whose interface takes a raw query string (and, for the fallback, performs normalization) and returns a valid FTS5 `MATCH` expression or a "no usable FTS query" signal. It also exposes a cheap predicate — **"is this query intentional FTS5?"** (contains a double-quote, a boolean operator `OR`/`AND`/`NOT`/`NEAR`, or a `column:` filter) — which the orchestrator uses to decide whether a zero-hit result should trigger the fallback. Pure (no DB, no embedder), mirroring how the ranking model is kept pure today (`ranking.ts:1-13`), so it is unit-testable in isolation.

2. **Fallback strategy (not unconditional rewrite).** The search orchestrator's FTS retriever step (`search_memory.ts:117-135`) (a) runs the query **as written** first; (b) falls back to a **sanitized** query via the new module only when the as-written query **throws**, or **returns zero rows AND is bare natural language** (the "intentional FTS5?" predicate is false). A valid FTS5 query — quoted or boolean — that legitimately returns zero rows is preserved as a correct empty result, never flattened. This preserves the advertised contract (including for boolean/phrase queries that correctly match nothing) and makes passing queries byte-identical.

3. **Fallback construction rules (principled, not fit to any query set):** lowercase; strip/replace FTS5-significant punctuation (commas, em-dashes); split hyphenated terms into component tokens; drop empty and single-character tokens; OR-combine the survivors. Lowercasing is required so an input word that is an FTS5 operator keyword (`OR`/`AND`/`NOT`/`NEAR`) is treated as a search term, not an operator. The result is always FTS5-valid.

4. **Vector retriever and exact-match bonus unchanged.** The vector retriever continues to embed the raw natural-language string (`search_memory.ts:140`); the exact-match bonus continues to use the raw query (`ranking.ts:64-76`).

5. **No ranker changes.** Fusion constant, reinforcement weight, exact-match weights, candidate oversampling, and the result shaper are unchanged. `search_config.ts` is not edited.

6. **Make the safety net observable (in-scope robustness add).** The existing swallowing `try/catch` (`search_memory.ts:133-135`) stays as defense in depth, but a triggered catch is logged via the existing `logger` helper rather than silently discarded. This is intentionally included beyond #82's literal ask because the silent catch is *why* the bug persisted undetected; it is flagged here rather than smuggled in.

7. **Minimal by intent.** Advanced query understanding (synonyms, expansion, field weighting) is not justified by the confirmed cause and is deferred (see Out of Scope).

## Testing Decisions

**What makes a good test here:** assert external behavior of the query builder — given an input, the produced FTS expression is valid (executing it against a fixture FTS table does not throw) and retrieves a fixture document containing a subset of the terms (proving OR semantics in the fallback). Tests must not assert on the exact internal token list beyond what behavior requires.

- **Tested (new):** the pure FTS query-builder module. Inputs deliberately include the strings that currently throw or under-match — comma-laden, em-dash, hyphenated (`pre-commit`, `claude-os`), many-token, and **operator-keyword-as-data** (`OR`, `NEAR`) — asserting (a) never throws, (b) produces a hit against a fixture doc, (c) degenerate input yields the explicit "no FTS query" signal. These dev/test queries are a **disjoint/synthetic set**, deliberately **not** the held-out labeled queries.
- **Tested (contract preservation):** a valid quoted-phrase query and a valid boolean query (`A NOT B`) are passed through **as written** and NOT flattened — **including the case where the valid boolean query legitimately returns zero rows** (the zero-hit fallback must not fire on it; it fires only on bare-NL zero-hit input) — directly guarding the RBJ cycle-2 S4 catch.
- **Tested (extend existing):** the search orchestrator's behavior via the existing tools suite — a punctuation-laden query returns results end-to-end, and a query with hits does not enter the fallback.
- **Acceptance bar (RBJ F4):** a **per-query before/after diff across all 21** held-out queries is the real acceptance check — each must individually hold or improve. The composed `npm run eval` PASS is the floor, but because `presenceVerdict` is **mean-based** (`eval.ts`), the per-query diff is required to rule out a masked swap.
- **Anti-leakage protocol:** the builder is developed against the principled rules + the synthetic set + unit tests; the held-out eval is run **once** at the end as the non-regression gate — never iterated against.
- **Out of test scope:** `search_config.ts` (unchanged), the vector retriever (unchanged), the ranking model (unchanged).

**Prior art:** the ranking suite (pure-module behavior tests) models the query-builder tests; the tools suite (seeded-DB behavior assertions) models the wiring tests; the eval gate models the final non-regression check.

**Definition of Ready (before development):**
- Story meets INVEST criteria
- Acceptance criteria written in Gherkin format
- Dependent stories documented
- Effort estimated by team
- Stakeholders agree on goal

**Definition of Done (after development):**
- All acceptance criteria pass
- Code review approved (Copilot requested on the PR, per repo rule)
- Query-builder module unit-tested (incl. contract-preservation + operator-keyword cases); tools-suite wiring case added; full `npm test` green
- Per-query before/after across all 21 shows no regression; `npm run eval` composes PASS
- No `search_config.ts` weight changes in the diff
- Documentation updated where retrieval behavior is described

## Out of Scope

- **The single-retriever / reinforcement imbalance.** When genuinely only one retriever can answer a query, a single RRF term is within the reinforcement band and reinforcement can reorder true relevance. The fix masks the common trigger but does not resolve the underlying balance — tracked in **#85**.
- **Ranker weight tuning of any kind.** Forbidden against the held-out set; not needed.
- **Chunking / file-size behavior.** Single-row file size is a co-factor (it determines whether FTS-silence is *fatal*), but the *fix* here is FTS query construction, not the chunk threshold (`chunker.ts:79`), which is left unchanged. Re-chunking small files to multiply their vector presence is a possible alternative lever, deliberately not pursued in this PR.
- **The `claude-os GitHub MCP endpoint…` query landing at #6.** Its top results (`github.md#github-mcp-setup`, `slack.md`, `jira.md#mcp-tools`) are genuinely relevant; whether `context/claude-os.md` *should* outrank them is a label-precision question, not a ranker bug.
- **Advanced query understanding** (synonyms, expansion, field weighting). Deferred; YAGNI. (Note: phrase/boolean preservation is **in** scope — it is preserved by the as-written-first path, not deferred.)
- **The stale `corpus_snapshot` metadata.** Owned by the doctor feature (#83).
- **Scope note (RBJ F2):** the observability log change (Decision 6 / Story 9) is an intentional in-scope addition beyond #82's literal text, included because it directly addresses why this class of bug stays invisible.

## Further Notes

### Investigation evidence (root cause, ~95% confidence)

Measured 2026-06-22 against a copy of the live corpus (487 observation rows, 222 distinct files), instrumenting the two retrievers and the final ranked output.

**Before — raw query passed to FTS5 `MATCH` (`search_memory.ts:124`):**

| Query | FTS | Vector | Final rank |
|---|---|---|---|
| maven clean test and checkstyle pre-commit gate | **throws** (`no such column: commit`) | target pos 1 | absent |
| commit quality goals — fix percentage and rework | 0 hits (implicit-AND) | target pos 1 | absent |
| familysearch role, team, and tech stack | **throws** (`syntax error near ","`) | target pos 1 | absent |
| background agents scheduled cron jobs | 0 hits (implicit-AND) | target pos 1 | rank 10 |
| claude-os GitHub MCP endpoint and token setup | **throws** (`no such column: os`) | target pos 1 | absent |

In every case the **vector retriever ranked the correct file #1**, yet with FTS silent the file fell out of the top-5, leapfrogged by recent/reinforced session episodes.

**After — sanitized FTS fallback (punctuation stripped, tokens OR-ed), weights unchanged:**

| Query | FTS target | Final rank |
|---|---|---|
| maven clean test and checkstyle pre-commit gate | pos 1 | **3** |
| commit quality goals — fix percentage and rework | pos 1 | **2** |
| familysearch role, team, and tech stack | pos 1 | **4** |
| background agents scheduled cron jobs | pos 1 | **3** |
| claude-os GitHub MCP endpoint and token setup | pos 1 | 6 |

Four of five move from absent into the top-5 with no weight change; the fifth reaches #6 behind genuinely-relevant results.

**The two-factor interaction, shown directly** (verified 2026-06-22): `arc-record-exchange repository local path and github` (a *passing* query, target `context/arc`) *also* goes FTS-silent — it throws `no such column: record` on the as-written `MATCH` — yet `context/arc` retrieves at **rank 1**, because `arc.md` is multi-chunk and contributes **7** vector hits to the pool. Under the *same* FTS-silence, `familysearch.md` (a single row, **1** vector hit) is leapfrogged and **misses**. So FTS-silence alone is not the differentiator: it is fatal only for single-row files. The fix works by restoring the keyword hit that single-row files depend on (FTS-clean controls `perch`/`jira` returned at rank 1 before and after and never touch the fallback).

### Codebase verification (cited)

- Raw query → FTS5 `MATCH`: `search_memory.ts:124` (`WHERE observations_fts MATCH ?`, bound with `args.query`).
- Swallowing catch that hides the failure: `search_memory.ts:133-135`.
- Advertised query contract the fix must preserve: `search_memory.ts:42`.
- Single-term RRF collapse when one retriever is silent: `ranking.ts:78-83` (`rrfScore`); reinforcement bound `W_REINFORCE` at `search_config.ts:27`.
- Eval verdict is mean-based (why the per-query diff is required): `presenceVerdict` in `eval.ts`, protocol in `docs/eval-gate-protocol.md`.
- Non-causal chunk threshold: `chunker.ts:79` (`SPLIT_THRESHOLD_CHARS = 2000`).
- Purity pattern the new module mirrors: `ranking.ts:1-13`.

### Premise correction for #82

#82's title named a real co-factor (single-row files are the ones that miss) but not the trigger (FTS query construction); the accurate cause is their **interaction**. An earlier #82 comment overstated this as "file size is incidental" — that line is corrected to the two-factor model above (correction comment to be posted to #82).
