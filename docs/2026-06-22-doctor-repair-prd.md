# PRD — Dioscuri `doctor` / `repair`

**Status:** Draft for review
**Date:** 2026-06-22
**Tracking issues:** [#83](https://github.com/JasonFulksFamilySearch/claude-os/issues/83) (this feature) · [#84](https://github.com/JasonFulksFamilySearch/claude-os/issues/84) (vitest upgrade, spun off) · [#82](https://github.com/JasonFulksFamilySearch/claude-os/issues/82) (retrieval gap — detected here, fixed elsewhere)

> **Provenance:** Authored through the claude-os PRD process and reconciled from two independent agent drafts into one canonical spec. Verified by the red-blue-judge gate (3 cycles; audit records under `docs/superpowers/rbj/`). Re-validated 2026-06-25 against live `mcp/` source (21/21 source-anchored claims confirmed) with one post-judge amendment — the verdict-vocabulary section now maps the eval gate's `CAPTURING` verdict to `INCONCLUSIVE`; that amendment closes a gap toward the source and was not part of the original 3-cycle judging. Pending Jason's approval.

---

## Problem Statement

When a `claude-os` (Dioscuri) update or a memory-engine migration lands, the operator has no single, fast way to answer the question *"is my installation actually healthy?"* The C2 chunk-split cutover that prompted this PRD is the canonical example: the eval gate returned `INCONCLUSIVE`, the `npm audit` output flashed `1 critical / 1 high`, and the corpus observation count had drifted from what the labeled set recorded — and **every one of those signals turned out to be benign**, but distinguishing benign from broken took an expert a chain of manual steps:

- cross-checking every held-out presence label against the live DB (with `instr(source_path, ?)`) to find the single one that pointed at a pruned episode file matching **0 observation rows** (the real cause of `INCONCLUSIVE`);
- confirming the cutover *succeeded* (distinct file set preserved, 0 errored files, recall@5 rose 0.27 → 0.76) rather than regressed;
- re-capturing the baseline on the now-chunked index to retire the cutover-boundary shape guard, so future memory-merger runs stop flagging `INCONCLUSIVE`;
- triaging the `npm audit` chain (1 critical / 1 high — the entire `vitest → vite → esbuild` chain, exploitable only via a network-bound dev server never run) as dev-only and *not* running `npm audit fix --force` (which would have broken the toolchain via a vitest 2→4 major bump plus a gray-matter downgrade);
- noticing the labeled set's `corpus_snapshot` metadata was stale — **387** against the live corpus of **222 distinct files**, residue of a prior 2026-06-17 recovery half-state.

That knowledge lives in one operator's head and in scattered docs. A first-time operator (or the operator six months from now) would either panic at false alarms or, worse, "fix" them destructively. There is **no existing `doctor`, `diagnose`, or `repair` capability** in the repo today — `mcp/README.md` lists these steps as manual prose, and the sibling audit skills (`audit-claude-os`, `mcp-health-audit`, `resource-report`) cover governance, config integrity, and resource capacity respectively, not memory-engine *state*. The health of the installation is **observable in principle** — the DB, the baseline file, the labeled set, the lock directory, and `npm audit` all expose state — but there is no tool that **reads that state, classifies it, and tells the operator what (if anything) to do.** This work fills that gap.

## Solution

A `doctor` command that diagnoses the health of a Dioscuri installation, and an opt-in `repair` mode that applies only safe, confirmed remediations.

From the operator's perspective:

- **`npm run doctor`** runs a battery of read-only checks against the live installation and prints a grouped, human-readable report: each check is `PASS`, `FAIL`, or `INCONCLUSIVE` (with a separate `ADVISORY` section), with a one-line explanation and — where applicable — the exact remediation. The command composes a top-level verdict and exits non-zero if the verdict is anything other than `PASS`, so it can gate `update.sh` and CI.
- **`npm run doctor -- --fix`** (or `/doctor` → "repair") re-runs the checks and, for each *fixable* finding, proposes the remediation and applies it **only after the operator confirms**. Safe, idempotent fixes are offered automatically; destructive operations are never auto-run. Report-only findings (dependency drift, build/test failures, the retrieval gap) are surfaced but never touched.
- A **`/doctor` skill** gives natural-language invocation ("run doctor", "is my memory engine healthy", "repair my installation"), and drives **per-fix confirmation** for `--fix`: for each proposed fix it shows what it will do and why, asks, and applies-or-skips, one at a time.
- The **`/assimilate-claude-os`** skill ends every update with a non-blocking `doctor` health summary, so the operator sees a health read on every sync without having to remember to ask.

The design principle throughout: **doctor tells the truth about state and never surprises the operator.** Diagnosis is the default; remediation is explicit; the dangerous defaults (`--force`, overwriting a baseline before a `PASS`, deleting data) are structurally impossible to trigger by accident.

### The honesty invariant

The top-level verdict is `PASS` **only when every check actually ran and passed**. A check that could not execute — eval errored, the embedder would not load, the DB was locked, a file was absent — degrades the verdict to `INCONCLUSIVE`, **never silently to `PASS`**. "Clean bill of health" must mean the cancer screen *ran*, not that it was skipped and nothing else looked wrong. This reuses the eval gate's own doctrine, where `INCONCLUSIVE` is a first-class verdict distinct from `PASS`. The precedence is `FAIL > INCONCLUSIVE > PASS`. It is the spec's spine: a skipped check can never read as a passed check.

`doctor` always runs the full eval (no `--quick` escape hatch) for exactly this reason — a fast path that skips the expensive screen could emit a `PASS` the live index would not earn.

### Subprocess boundary (do not import the embedder)

The eval check, the `tsc` check, and the test-suite check run their existing runners as **subprocesses** (`npm run eval`, `tsc`/`npm run build`, `npm test`) and parse the structured output — they do **not** import the runners' internals. Two reasons, both verified against live source:

1. `mcp/src/eval.ts`/`scripts/eval.ts` and `reembed` deliberately avoid `process.exit()` to dodge an onnxruntime-node cleanup SIGABRT. Importing eval into `doctor` would pull the 400MB embedder into `doctor`'s process and inherit that cleanup quirk. Shelling out keeps the boundary the codebase already maintains.
2. The eval runner already copies the live DB to a throwaway temp dir before scoring, so a subprocess `npm run eval` never contends with a live MCP server holding the DB. `doctor` inherits that isolation for free, and the eval's best-effort reinforcement writes never touch the live store.

---

## User Stories

### A. Running the diagnosis

**1. As the operator, I want to run a single command and get a health verdict, so that I can tell at a glance whether my installation is healthy after an update.**
```
Given a Dioscuri installation with a live memory.db
When I run `npm run doctor`
Then I see a grouped report of every check with a PASS / FAIL / INCONCLUSIVE status (plus a separate ADVISORY section)
And the composed verdict is PASS only if every check ran and passed
And the process exits 0 on a PASS verdict, non-zero otherwise
```

**2. As the operator, I want each non-PASS check to tell me what it means and how to fix it, so that I am never left with a status I cannot act on.**
```
Given a check returns FAIL or INCONCLUSIVE
When the report is printed
Then that line includes a one-sentence explanation of the condition
And, if the finding is fixable, the exact remediation (command or `--fix` action)
```

**3. As the operator, I want doctor to run even when my DB is in a broken/pre-migration state, so that it can diagnose the very conditions it exists to catch.**
```
Given a memory.db on a pre-C2 (v2) schema, which the normal open path rejects
When I run `npm run doctor`
Then doctor opens the database raw (not via the fail-fast open path)
And reports the schema-version finding instead of crashing
```

### B. Eval-gate health checks

**4. As the operator, I want doctor to tell me whether an eval baseline exists, so that I know the regression gate is armed.**
```
Given the baseline file is absent
When doctor runs the eval-gate checks
Then the baseline-present check reports INCONCLUSIVE (the screen could not run) with the instruction to capture one
```

**5. As the operator, I want doctor to detect a stale baseline at the cutover boundary, so that I am warned before a memory-merger close nags me with INCONCLUSIVE.**
```
Given the baseline records chunking_enabled = false
And the live index has chunking enabled
When doctor runs
Then the baseline-staleness check reports FAIL ("baseline predates the cutover; re-baseline on the chunked index after a PASS")
And marks it fixable by the recapture-baseline remediation
```

**6. As the operator, I want doctor to find any held-out label that matches zero rows, so that I can diagnose an INCONCLUSIVE verdict as broken labels rather than a broken ranker.**
```
Given a presence label whose expectedPathContains matches no observation row
When doctor runs the broken-labels check
Then it reports INCONCLUSIVE ("fix the labels, not the ranker"), names the offending query and its dead path substring
And marks it fixable by the drop-dead-label remediation
```

**7. As the operator, I want doctor to compare the labeled set's corpus_snapshot against the live corpus, so that stale provenance metadata is caught.**
```
Given the labeled set records corpus_snapshot = N
And the live corpus has a materially different distinct-file count
When doctor runs
Then the corpus-snapshot check reports FAIL with both numbers (doctor recomputes the live COUNT(DISTINCT source_path) rather than trusting the snapshot)
And marks it fixable by the recompute-corpus-snapshot remediation
```

**8. As the operator, I want doctor to report the most recent composed eval verdict, so that I know whether the gate currently passes.**
```
Given doctor runs the eval as a subprocess (`npm run eval`) against the eval's own isolated throwaway DB copy (so reinforcement writes never touch the live store)
When doctor runs the verdict check
Then it surfaces the composed verdict (PASS / FAIL / INCONCLUSIVE) directly
And, if the eval cannot be composed (subprocess errored), reports INCONCLUSIVE with the reason rather than inflating to PASS
```

### C. Index / cutover state checks

**9. As the operator, I want doctor to report the chunking marker state and confirm it is consistent with the index, so that I know whether the cutover has been applied.**
```
Given the c2_chunking_enabled meta marker is present or absent
When doctor runs
Then it reports the marker state as informational PASS (on/off), consistent with whether chunked rows (anchor != '') actually exist
And reports FAIL if the marker claims chunked but no chunked rows exist (or vice versa)
```

**10. As the operator, I want doctor to detect chunk-shape divergence between the index and what the chunker would produce today, so that an incomplete cutover/reindex is caught without false-positives on legitimately-whole-file files.**
```
Given c2_chunking_enabled = '1'
When doctor runs the chunk-shape divergence check
Then for each distinct source_path it runs chunkFile({ sourceType, content: <current file content>, chunkingEnabled: true }) and compares the produced anchor-set against the indexed anchor-set
And it reports the count of files whose two anchor-sets diverge (set-inequality on anchors)
Then the check status is FAIL when divergenceCount > 0 and PASS when divergenceCount = 0 (divergence is the condition; the status stays in the PASS/FAIL/INCONCLUSIVE/ADVISORY vocabulary)
And the reported finding describes divergence only — not its cause — since a not-yet-reindexed edit also diverges
And it explicitly does NOT claim "cutover failed"; cause attribution defers to a fresh `npm run cutover`
```

**11. As the operator, I want doctor to verify the schema is current, so that I am told to migrate before the server refuses to start.**
```
Given the DB schema is not the current version
When doctor runs the schema check
Then it reports FAIL with the instruction to migrate
And marks it fixable by the run-migrate remediation
```

### D. Corpus integrity checks

**12. As the operator, I want doctor to run SQLite's integrity check, so that on-disk corruption is caught early.**
```
Given the database file
When doctor runs the integrity check
Then a non-"ok" integrity result reports FAIL (not auto-fixable; points to the rollback procedure)
```

**13. As the operator, I want doctor to detect observations with no embedding, so that silent retrieval degradation is caught.**
```
Given one or more observation rows have no corresponding embedding row (the LEFT JOIN orphan probe)
When doctor runs the embedding-coverage check
Then it reports FAIL with the count of un-embedded rows
And marks it fixable by the re-embed remediation
```

**14. As the operator, I want doctor to sanity-check corpus shape, so that an empty or obviously-wrong corpus is flagged.**
```
Given the corpus is empty, or expected source types are entirely absent
When doctor runs the corpus-shape check
Then it reports FAIL (empty corpus) or FAIL (a whole expected source type missing)
And the expected context/* set is derived from context-templates/ (the same source update.sh Step 7 provisions from), so it cannot drift from a separate manifest
```

### E. Single-writer / lock checks

**15. As the operator, I want doctor to detect a stale writer-election lock, so that a crashed session does not block index maintenance indefinitely.**
```
Given a writer-lock directory whose holder is no longer alive / is past staleness (election.ts isStale() against now − STALENESS_MULTIPLE × HEARTBEAT_REFRESH_MS)
When doctor runs the lock check
Then it reports FAIL identifying the stale lock
And marks it fixable by the clear-stale-lock remediation
```

### F. Dependency & build checks (report-only)

**16. As the operator, I want doctor to summarize npm audit without ever offering `--force`, so that I see dependency drift without risking a destructive auto-fix.**
```
Given `npm audit` reports vulnerabilities
When doctor runs the dependency check (parsing `npm audit --json`, not regexing stdout)
Then it summarizes counts by severity and notes which are dev-only vs runtime
And explicitly states this is report-only (links issue #84); it is never auto-fixed
And `npm audit fix --force` is never invoked by doctor
And if `npm audit` itself fails (offline, registry down) the check reports INCONCLUSIVE, never PASS
```

**17. As the operator, I want doctor to optionally verify the build and test suite, so that a broken toolchain is caught — without slowing the default run.**
```
Given the build/test checks are expensive
When I run `npm run doctor` without the deep/`--full` flag
Then the build/test checks report ADVISORY ("not run — pass --full to include them"), which is excluded from the composed verdict and the exit code by construction
And this is distinct from INCONCLUSIVE: a deliberately-deferred check is ADVISORY (the operator chose to skip it), whereas a check that was supposed to run but could not is INCONCLUSIVE (which the honesty invariant forbids from reading as PASS)
When I run doctor with the deep/`--full` flag
Then tsc and the test suite run as subprocesses and report PASS / FAIL (report-only; never auto-fixed)
And if either subprocess cannot run, that check reports INCONCLUSIVE, never PASS
```

### G. Backup checks

**18. As the operator, I want doctor to confirm a recent verified pre-cutover snapshot exists, so that I know a rollback is possible if a migration goes wrong.**
```
Given the expected backup artifacts (`<db>.pre-cutover.<UTC-timestamp>.bak` / `<db>.pre-c2.bak`)
When doctor runs the backup check
Then it reports PASS if a recent verified snapshot exists, FAIL if none is found
```

### H. Repair mode

**19. As the operator, I want repair to never change anything without my confirmation, so that I stay in control of every mutation.**
```
Given `npm run doctor -- --fix` finds a fixable condition
When repair proposes the remediation
Then it describes exactly what it will do and waits for explicit confirmation
And applies nothing if I decline
```

**20. As the operator, I want a dead label dropped and the eval re-run in one confirmed step, so that I can resolve an INCONCLUSIVE the safe way we established by hand.**
```
Given the broken-labels check found a dead label
When I confirm the drop-dead-label remediation
Then repair removes that label from the held-out set (backing up the labels file first)
And re-runs the eval and reports the new composed verdict
And surfaces a PASS (or the new status) so I can see the fix took
```

**21. As the operator, I want repair to recapture the baseline only after a validated PASS, so that I can never overwrite the reference with a failing state.**
```
Given the recapture-baseline remediation is offered
When the current eval does not compose a fresh PASS
Then repair refuses to recapture and explains why (the gate is enforced in code, not left to operator discipline)
When the current eval composes a fresh PASS and I confirm
Then repair recaptures the baseline on the current (chunked) index
```

**22. As the operator, I want each remediation to be idempotent, so that re-running repair after a partial fix is always safe.**
```
Given a remediation has already been applied
When repair runs again
Then the corresponding check reports PASS and the remediation is not re-offered
```

**23. As the operator, I want report-only findings to stay untouched in repair mode, so that doctor never attempts a fix it shouldn't.**
```
Given a report-only finding (npm audit, build/test failure, the #82 retrieval gap)
When I run `npm run doctor -- --fix`
Then repair lists it as report-only and applies no change
```

### I. Wiring & invocation

**24. As the operator, I want a `/doctor` skill, so that I can invoke diagnosis or repair in natural language.**
```
Given the `/doctor` skill is installed
When I say "run doctor" or "repair my installation"
Then the skill invokes `npm run doctor` (or `--fix`) and relays the report
And, in `--fix`, drives per-fix confirmation one finding at a time
```

**25. As the operator, I want every claude-os sync to end with a health read, so that problems surface at the moment they are introduced.**
```
Given I run `/assimilate-claude-os`
When the update completes
Then a non-blocking `doctor` summary is appended to the output
And a doctor non-PASS verdict is surfaced as a warning but does not abort the completed update
```

### J. Spun-off cleanup stories

**26. As the maintainer, I want the vitest dev-toolchain upgraded deliberately, so that the critical/high audit advisories are cleared without a `--force` breakage.** *(Tracked in issue #84; out of scope for the doctor build itself — see Out of Scope.)*
```
Given the dev chain pins vitest ^2 with known CVEs
When the upgrade is done on a branch
Then vitest is on v4, `npm test` passes, `npm run eval` composes PASS, and audit shows 0 critical/high
And `npm audit fix --force` was never used
```

---

## Implementation Decisions

### Verdict vocabulary (reuse the eval gate's words)

`doctor` composes a top-level verdict in the existing house vocabulary — `PASS` / `FAIL` / `INCONCLUSIVE` — not a new `OK`/`WARN` or `GREEN`/`INCOMPLETE` vocabulary. The whole eval subsystem, memory-merger, and `eval-gate-protocol.md` already speak these words with precedence `FAIL > INCONCLUSIVE > PASS`. Each check returns one of four per-check statuses:

- `PASS` — ran and is healthy.
- `FAIL` — ran and found a real fault.
- `INCONCLUSIVE` — **could not run** (the honesty invariant's "couldn't-run" state).
- `ADVISORY` — a known standing condition; reported but **never** contributes to the top verdict.

Composition: any `FAIL` ⇒ `FAIL`; else any `INCONCLUSIVE` ⇒ `INCONCLUSIVE`; else `PASS`. `ADVISORY` statuses are excluded from composition by construction.

The eval gate itself has a fourth verdict, `CAPTURING` (`eval.ts:83`; the eval's own precedence is `CAPTURING > FAIL > INCONCLUSIVE > PASS`), which it returns on a first run when no baseline exists yet — it records the current index *as* the baseline rather than judging against one. doctor's last-composed-verdict check (story 8) **maps a `CAPTURING` eval result to its own `INCONCLUSIVE`**: the regression gate isn't armed, so the screen could not actually judge — the honesty invariant's couldn't-run state, never `PASS`. This is the same no-baseline root cause story 4's baseline-present check already reports as `INCONCLUSIVE`, so the two checks agree rather than one reading `INCONCLUSIVE` and the other a fault.

### Module structure — two new modules, split deep/thin

1. **Pure-logic module (`mcp/src/doctor.ts`).** Holds the diagnostic logic as a registry of independent check functions. Each *check* and each *fix* is an independent, unit-testable function (mirroring how `mcp/src/eval.ts` holds pure metrics and `mcp/src/scripts/eval.ts` is the thin runner). Each check is a pure function of installation state returning a structured result: a stable check `id`, a `status` (`PASS`/`FAIL`/`INCONCLUSIVE`/`ADVISORY`), a human `detail` string, a `fixable` flag, and an optional `remediation` descriptor. Each check has an explicit "couldn't run" branch — the honesty invariant applies per-check, not just to eval. No I/O orchestration beyond what a check needs; no session; no mutation outside a fix function.

2. **Thin runner (`mcp/src/scripts/doctor.ts`).** The thin orchestrator: it runs the registry, formats the grouped report, composes the verdict, sets the process exit code, and drives `--fix`. `npm run doctor` emits a deterministic report (human-readable text + a structured trailer). Reads `CLAUDE_OS_DB_PATH` like its siblings (default `~/.claude-data/memory.db`). The CLI follows the established operator-script convention (a testable exported entry guarded by a direct-invocation check) and is wired as the `doctor` npm script. **Never spawns a Claude session** — it is headless-safe so CI, cron/launchd, or another script can consume its verdict.

3. **Skill layer (`skills/doctor/SKILL.md`).** The session layer, human-triggered. `/doctor` runs the script and interprets the output for the operator. `/doctor --fix` drives **per-fix voice confirmation**: for each proposed fix it shows what it will do and why, asks, and applies-or-skips, one at a time. The script owns each fix as a discrete idempotent operation; the skill owns the consent loop. The script never self-mutates; the skill never reimplements a check. `repair` therefore cannot run headless — correct for state-mutating recovery.

### Diagnosis opens the database raw

Because the normal open path fails fast on a pre-C2 schema, the doctor opens the database with a raw handle (mirroring the migration script's pragmas + extension load) so it can diagnose the pre-migration state instead of throwing on it. This is what makes story 3 possible: the tool can report a schema-version finding on the very DB the normal open path would refuse.

### Eval-gate inspectors are promoted to a shared module

The baseline reader, the label-match probe (the broken-labels detector), the chunking-marker reader, and the labeled-set loader currently live inside the eval script. They are extracted into a shared eval-gate inspection module that both the eval script and the doctor registry import, so the two never diverge. Scope is limited to the helpers doctor needs — no broader refactor of the eval pipeline.

### Reuse, don't reimplement

Schema-version detection (`isV3Schema()`), backup/verify (`backupDb` via `VACUUM INTO`, `verifyBackup`), the cutover-boundary and file-set-hash helpers, the corpus distinct-file query, the orphan-vector probe, and the writer-lock state (`election.ts isStale()`) are read through existing modules. Doctor adds checks; it does not re-derive these primitives.

### Check catalog

Grouped per #83's six categories. Each check is a pure function with an explicit "couldn't run" branch.

**Eval-gate health**
- Baseline present? (`~/.claude-data/eval-baseline.json`) — absent → `INCONCLUSIVE`.
- Baseline stale: captured pre-cutover (`baseline.corpus.chunking_enabled` falsy) while the live index is chunked (`meta.c2_chunking_enabled = '1'`) → the boundary-guard nag, fixable by recapture.
- Broken labels: each held-out presence label run through `instr(source_path, ?)`; any matching **0 rows** → `INCONCLUSIVE` ("fix the labels, not the ranker").
- `curation.corpus_snapshot` vs. live `COUNT(DISTINCT source_path)` — mismatch is a finding (the 387-vs-222 residue). `doctor` recomputes the live count rather than trusting the snapshot.
- Last composed verdict — **runs the full eval as a subprocess** (`npm run eval`), surfacing `PASS`/`FAIL`/`INCONCLUSIVE`. See "Subprocess boundary" above for why it is not imported.

**Index / cutover state**
- `c2_chunking_enabled` marker present and **consistent** with whether chunked rows (`anchor != ''`) actually exist.
- **Chunk-shape divergence count** — this is #83's "cutover errored-files count" checklist item, **scoped to what the index can actually prove.** #83 asks for the count of files the cutover failed to chunk; from index state alone that is not separable from a stale-but-correct index (see below), so the check reports the provable superset — chunk-shape divergence — and names the limit rather than over-claiming. **Re-derived from index state, not a persisted log, using the chunker itself as the oracle.** With `c2_chunking_enabled = '1'`, for each distinct `source_path`, run `chunkFile({ sourceType, content: <current file content>, chunkingEnabled: true })` (`chunker.ts:263`) and compare the **chunk-shape it produces now** (its set of `anchor` values) against the file's **current indexed chunk-shape** (the set of `anchor` values that `source_path` holds). The check reports the count of files whose two anchor-sets **diverge** (set-inequality on anchors — not "is the anchor empty?"). **The check claims only divergence, not its cause.** A divergence means "the index does not match what the chunker would produce from current content today"; it does **not** by itself prove a failed cutover, because a file edited after cutover and not yet reindexed produces the same divergence (the indexer converges the index to `chunkFile` output via reconcile/upsert + content-hash gate, `indexer.ts:147-158, 218-291`, so a pending reindex looks identical to a missed split from anchor-shape alone). Attributing a divergence to a cutover failure versus a stale-but-correct index is left to a fresh `npm run cutover` or the freshness signal, **not** asserted here. This is also why the check never contradicts the ADVISORY section below: correctly whole-file files — `learning`/`decision` with no dated entries (`chunker.ts:43-47`), `context`/`project_*` ≤ `SPLIT_THRESHOLD_CHARS` or H2+-less (`chunker.ts:240-241, 252-257`), `episode`/`agent` always (`chunker.ts:290-292`) — yield a `chunkFile` shape that *matches* their correct indexed anchor-set, so they do not diverge and are not counted. Reads current truth; needs no new persistence. (Cost note: this re-runs the pure `chunkFile` over current file contents — text parsing only, **no embedding** — so it is cheap relative to the eval check.)
- Schema current: `isV3Schema()` (anchor-column presence) + `PRAGMA user_version` — does it need `npm run migrate`? Not current → `FAIL`, fixable by run-migrate.

**Corpus integrity**
- `PRAGMA integrity_check` — non-"ok" → `FAIL` (not auto-fixable; points to rollback).
- Observation count vs. distinct `source_path` count; empty corpus → `FAIL`.
- Missing/zero embeddings: the `observations LEFT JOIN vec_items … WHERE v.observation_id IS NULL` orphan probe → `FAIL`, fixable by re-embed.
- Expected `context/*` files present — **expected set derived from `context-templates/`** (the same source `update.sh` Step 7 provisions from). A template whose provisioned copy is absent is a real "missing" finding; this is the single source of truth, so it cannot drift from a separate manifest.

**Single-writer election**
- Stale writer-lock detection: read `~/.claude-data/memory.db.writer.lock.d/meta` mtime against `now − STALENESS_MULTIPLE × HEARTBEAT_REFRESH_MS` (3 × 60s), reusing `election.ts`'s `isStale()` rather than reimplementing the threshold → `FAIL`, fixable by clear-stale-lock.

**Dependency & build health (report-only)**
- `npm audit` summary — **report only, never `--force`** (hard rule, straight from #83). Parse `npm audit --json`; do not regex stdout. If `npm audit` itself fails (offline, registry down), the check is `INCONCLUSIVE`, never `PASS`.
- `tsc` build clean — subprocess (`npm run build` or `tsc --noEmit`); can't run → `INCONCLUSIVE`. Opt-in under the deep/`--full` flag.
- Test suite green — subprocess (`npm test`); can't run → `INCONCLUSIVE`. Opt-in under the deep/`--full` flag.

**Backups**
- Presence of a recent verified pre-cutover snapshot (`<db>.pre-cutover.<UTC-timestamp>.bak`) / recovery backup (`<db>.pre-c2.bak`) → `PASS` if present, `FAIL` if none.

**Advisory (separate section, never reddens the verdict)**
- #82-style standing conditions: e.g. count of single-row `context/*` files that rank poorly per issue #82, labeled "not a fault." Surfaces the issue's cross-reference without letting a known limitation contaminate the bill of health. Reported as a separate `## Advisory — standing conditions` section, excluded from verdict composition by construction.

### Repair model is confirm-then-apply, with a hard report-only set

`repair`/`--fix` is opt-in. For each fixable finding it describes the action and applies it only on explicit confirmation. The fixable remediations are: drop/re-point a dead label then re-run eval; recompute the labeled set's `corpus_snapshot`; run the schema migration (`npm run migrate`); re-embed missing rows; clear a stale writer lock; recapture the baseline (gated on a code-verified fresh `PASS`). The report-only set — never mutated by doctor — is: npm-audit/vitest drift, build/test failures, and the #82 retrieval gap.

Gating rules, applied to every fix:

- **Back up before mutate.** "Idempotent" is not "reversible." Recomputing `corpus_snapshot` is safe to repeat but silently overwrites; re-embedding rows is not trivially undoable. Every mutating fix snapshots its target first (the cutover/migrate precedent: `VACUUM INTO` before the flag flip), so a wrong fix is recoverable.
- **Re-verify the precondition at apply-time.** A lock that was stale at diagnose-time must be re-confirmed stale via `isStale()` immediately before clearing — mtime can age past the threshold between diagnose and confirm.
- **Recapture the baseline only after a code-verified fresh `PASS`.** The ordering is enforced in code: the fix is gated on a fresh `PASS` verdict, not left to operator discipline.
- **One fix = one atomic unit.** No transaction spans multiple distinct fixes (they touch different stores — DB, baseline JSON, labels JSON, lock dir — so a cross-fix rollback would be incoherent). If fix N throws, `doctor` reports what *did* apply and leaves the rest untouched.
- **Destructive operations never auto-run.** Default mode is diagnosis; `--fix` is opt-in; each application is individually confirmed.

### No `npm audit fix --force`, ever

Doctor summarizes audit severity and dev-vs-runtime classification and points at the tracked upgrade issue (#84); it never invokes a dependency auto-fix under any flag.

### Output format (house style) with an exit-code contract

The default report is human-readable, grouped by category, mirroring the report style of `eval`/`audit-claude-os`/`resource-report`: `###` headings per category, per-check lines with an ALL-CAPS status, then a top `VERDICT:` line in the `PASS`/`FAIL`/`INCONCLUSIVE` vocabulary, then the separate `## Advisory — standing conditions` section. A structured (JSON) trailer carries the machine-readable verdict + per-check statuses so a headless caller can consume it. Exit code is non-zero when the composed verdict is not `PASS` so `update.sh`/CI can gate on it. A full machine-readable `--json` output *mode* is deliberately **not** built now (YAGNI) and can be added if a consumer needs it.

### Expensive checks are opt-in

Build (tsc) and the full test suite run only under a deep/`--full` flag; the default run stays fast and side-effect-free. The eval check, however, is **not** behind such a flag — `doctor` always runs the full eval (no `--quick` escape hatch), because a fast path that skips the expensive screen could emit a `PASS` the live index would not earn (the honesty invariant).

### Invocation surfaces

The `doctor` npm script (primary), a thin `/doctor` skill wrapper (natural language), and a non-blocking doctor summary appended to the end of the `/assimilate-claude-os` skill. Doctor is intentionally a CLI script, not an MCP tool — it matches the eval/cutover/migrate pattern and needs no server runtime.

### Provisioning

Per project `CLAUDE.md`, any machine-local setup goes in `update.sh`, not manual instructions. `doctor`/`repair` introduce **no new persistent machine state** — every check reads existing artifacts (DB, baseline, labels, lock, `context-templates/`) and every fix writes to stores that already exist. The only provisioning is wiring `doctor` into `mcp/package.json` scripts (`"doctor": "tsx src/scripts/doctor.ts"`) and installing the `skills/doctor/` skill (handled by the existing skill-install path). No `update.sh` step is required beyond what skill installation already does.

## Testing Decisions

**What makes a good test here:** each test asserts *external behavior* — given a fixture database (or fixture baseline/labeled-set files) in a known state, the check returns the expected status and fixable flag, and a remediation, once applied, flips the corresponding check to `PASS`. Tests must not assert on internal data structures or private helpers; they drive checks and remediations through their public interface against real fixture DBs, exactly as the existing migration and tools suites do. Prior art: `mcp/test/eval.test.ts` (pure metrics), `mcp/test/migrations.test.ts` (mocked embedder, in-memory DB fixtures), `mcp/test/election.test.ts` (lock staleness/takeover).

- **The honesty invariant is proven first.** A test asserts that when a check's underlying operation throws/unavailable (e.g. eval subprocess returns non-zero, DB locked, file absent), that check resolves `INCONCLUSIVE` and the composed verdict is `INCONCLUSIVE` — never `PASS`. This is the highest-priority test: a `doctor` that emits `PASS` while a check silently didn't run is worse than no `doctor`.
- **Tested — the doctor check-registry module:** every check exercised against a fixture DB constructed to trigger `PASS`, `FAIL`, and `INCONCLUSIVE` paths — broken-label detection (label → 0 rows → `INCONCLUSIVE`); corpus_snapshot mismatch; chunk-shape divergence re-derivation (anchor-set inequality under `c2_chunking_enabled='1'`); orphan-embedding probe; expected-vs-provisioned context-file diff against a fixture `context-templates/`; verdict composition (`FAIL > INCONCLUSIVE > PASS`; `ADVISORY` excluded). Every `--fix` remediation exercised apply-then-verify (apply against a broken fixture, assert the check now reports `PASS`, and assert idempotency on a second run). The clear-stale-lock fix is tested for apply-time re-verification; the recapture-baseline remediation is tested for its fresh-`PASS`-gate refusal as well as its success path; each mutating fix is asserted to back up its target first.
- **Tested — the promoted eval-gate inspection module** (baseline read, broken-label probe, chunking-marker read, labeled-set load) — with a regression test that the existing eval script still composes identical verdicts after the extraction.
- **Mock the embedder** (as `migrations.test.ts` does) so tests don't load `@huggingface/transformers`.
- **Out of test scope / excluded (operational glue, not unit-testable):** the thin doctor CLI script (formatting/exit-code glue, verified by hand), the `/doctor` skill wrapper and its voice-confirmation loop, the `/assimilate-claude-os` summary hook (orchestration glue), the live `npm run eval`/`npm audit`/`tsc`/`npm test` subprocess runs, and applying a fix against the real live store.

**Prior art:** the migration suite (operator-script `main()` driven against temp fixture DBs with backup/verify assertions) and the tools suite (behavior-level assertions over a seeded DB) are the models to follow for fixture construction and assertion style.

**Definition of Ready (before development):**
- Story meets INVEST criteria
- Acceptance criteria written in Gherkin format
- Dependent stories documented
- Effort estimated by team
- Stakeholders agree on goal

**Definition of Done (after development):**
- All acceptance criteria pass
- Code review approved (Copilot requested on the PR, per repo rule)
- Test coverage meets team standards (registry + remediations covered)
- Documentation updated (a doctor section in the docs, and the `/assimilate-claude-os` skill note)
- `npm test` and `npm run eval` both green; doctor itself reports `PASS` on a healthy install

## Out of Scope

- **The #82 retrieval gap fix.** Doctor *surfaces* (as an ADVISORY) that the small single-row context topics return zero recall, but improving the ranker/chunk-routing so they retrieve is a separate investigation tracked in #82. Doctor never attempts to "fix" it, and the ADVISORY never reddens the verdict.
- **The vitest 4 upgrade itself.** Doctor *reports* the dependency drift; performing the major bump is its own chore in #84.
- **A `--quick` / fast path.** Deliberately omitted; it would let a `PASS` be emitted while the expensive eval screen is skipped, breaking the honesty invariant.
- **A `--json` / machine-readable output *mode*.** A structured trailer ships by default for headless callers, but a full alternate output mode is deferred until a concrete consumer needs it.
- **Auto-applying any fix, and any destructive remediation.** Every remediation is individually confirmed; no tiered "auto-apply trivial fixes" mode (a wrong auto-fix is the exact false-confidence failure `doctor` exists to prevent). Doctor will not delete corpus data, force-resolve locks held by a live writer, or overwrite a baseline without a fresh `PASS`.
- **Headless/unattended `repair`.** `repair` is session-gated by design; only the read-only report path is headless-safe.
- **An MCP tool surface** (`diagnose_memory` etc.) — not needed for the `npm script + skill` form; can be added later without reworking the core if a session-callable path is wanted.
- **Persisting cutover results.** The cutover error count is re-derived from index state (chunk-shape divergence), so no new write surface is added to `runCutover`.
- **A scheduled/background launchd doctor job.** The report path is built headless-safe to *allow* this later, but wiring a launchd job is a separate change. Invocation is manual + the post-update summary for now.
- **`npm audit fix --force`** — never run by `doctor` or `repair` under any flag.
- **Broad refactors of the eval, indexer, or election modules.** Only the minimal eval-gate inspector extraction needed for reuse is in scope.

## Further Notes

- **Design review (2026-06-22, five-lens):** confidence High. Top risks and their mitigations: (1) importing eval/embedder internals → shell out as subprocess; (2) "expected context files" with no source of truth → derive from `context-templates/`; (3) an irreversible `repair` fix → per-fix backup-before-mutate + recapture-baseline gated on a code-verified fresh `PASS`. The single thing that kills this: `doctor` emitting `PASS` while a check silently didn't run — hence the honesty invariant is the first thing the test suite proves.
- **Form decision (do not re-litigate):** `npm script + thin skill`, chosen over skill-only (no unit coverage, query drift) and script+MCP-tool (extra server surface, harder fix-gating). The script stays headless; the session lives only in the skill.
- **Eval-depth decision (do not re-litigate):** `doctor` always runs the full eval, no escape hatch — "clean bill of health" means every screen ran.
- **Origin:** this feature is the generalization of a real manual recovery performed on 2026-06-22 after a claude-os update + C2 cutover. The check catalog is a direct encoding of that recovery's steps, so the first acceptance test of the whole feature is: *would doctor have correctly classified that day's `INCONCLUSIVE` as a single dead label, and offered the exact fix we applied by hand?*
- **Held-out doctrine:** the dead-label remediation removes/re-points a genuinely dead label (its target no longer exists). It must never be repurposed to delete a *valid* label merely because a query scores zero recall — that would be curating the held-out set to make the gate pass, which the eval protocol forbids. The broken-labels check keys on "matches zero rows," not "scores zero recall," precisely to honor that line.
- **Verified live source** (the module design was checked against the actual `mcp/` source this session, not assumed): `mcp/src/db.ts` (v3 schema, `meta` table, `UNIQUE(source_path,anchor)`); `mcp/src/migrations.ts` (`isV3Schema`, `backupDb` via `VACUUM INTO`, `verifyBackup`); `mcp/src/scripts/cutover.ts` (`c2_chunking_enabled` flip, timestamped backup, `erroredPaths` returned-not-persisted); `mcp/src/election.ts` (`isStale`, `HEARTBEAT_REFRESH_MS=60000`, `STALENESS_MULTIPLE=3`); `mcp/src/eval.ts` + `scripts/eval.ts` (temp-DB-copy isolation, `INCONCLUSIVE` doctrine, file-set shape guard); `mcp/src/indexer.ts` (orphan-vector probe, `vectorCoverageSweep`); `mcp/src/chunker.ts` (`chunkFile`, whole-file source-type rules); `update.sh` Step 7 (`context-templates/` provisioning). The raw-open requirement (the normal open path throws on a pre-C2 schema) and the fact that the eval-gate helpers doctor needs live inside the eval script today were both confirmed against live source — which is why the raw-open and the inspector-extraction are explicit implementation decisions rather than assumptions.
- **Cross-reference:** issue #82 (single-row context topics never rank top-5) is the canonical ADVISORY standing condition.
- **Effort:** ~1–2 days (pure-logic checks + fix functions + tests + thin runner + skill).
