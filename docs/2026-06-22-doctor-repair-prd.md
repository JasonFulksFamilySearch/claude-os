# PRD — Dioscuri `doctor` / `repair`

**Status:** Draft for review
**Author:** Willis (with Jason Fulks)
**Date:** 2026-06-22
**Tracking issues:** [#83](https://github.com/JasonFulksFamilySearch/claude-os/issues/83) (this feature) · [#84](https://github.com/JasonFulksFamilySearch/claude-os/issues/84) (vitest upgrade, spun off) · [#82](https://github.com/JasonFulksFamilySearch/claude-os/issues/82) (retrieval gap — detected here, fixed elsewhere)

---

## Problem Statement

When a `claude-os` (Dioscuri) update or a memory-engine migration lands, the operator has no single, fast way to answer the question *"is my installation actually healthy?"* The C2 chunk-split cutover that prompted this PRD is the canonical example: the eval gate returned `INCONCLUSIVE`, the `npm audit` output flashed `1 critical / 1 high`, and the corpus observation count had drifted from what the labeled set recorded — and **every one of those signals turned out to be benign**, but distinguishing benign from broken took an expert a chain of manual steps:

- cross-checking all 22 held-out labels against the live DB to find the single one that pointed at a pruned episode (the real cause of `INCONCLUSIVE`);
- confirming the cutover *succeeded* (file set preserved, 0 errored files, recall 0.27 → 0.76) rather than regressed;
- re-capturing the baseline on the chunked index to retire the cutover-boundary shape guard;
- triaging the `npm audit` chain as dev-only and *not* running `npm audit fix --force` (which would have broken the toolchain);
- noticing the labeled set's `corpus_snapshot` metadata was stale.

That knowledge lives in one operator's head and in scattered docs. A first-time operator (or the operator six months from now) would either panic at false alarms or, worse, "fix" them destructively. The health of the installation is **observable in principle** — the DB, the baseline file, the labeled set, the lock directory, and `npm audit` all expose state — but there is no tool that **reads that state, classifies it, and tells the operator what (if anything) to do.**

## Solution

A `doctor` command that diagnoses the health of a Dioscuri installation, and an opt-in `repair` mode that applies only safe, confirmed remediations.

From the operator's perspective:

- **`npm run doctor`** runs a battery of read-only checks against the live installation and prints a grouped, human-readable report: each check is `OK`, `WARN`, or `FAIL`, with a one-line explanation and — where applicable — the exact remediation. The command exits non-zero if anything is `FAIL`, so it can gate `update.sh` and CI.
- **`npm run doctor -- --fix`** (or `/doctor` → "repair") re-runs the checks and, for each *fixable* finding, proposes the remediation and applies it **only after the operator confirms**. Safe, idempotent fixes are offered automatically; destructive operations are never auto-run. Report-only findings (dependency drift, build/test failures, the retrieval gap) are surfaced but never touched.
- A **`/doctor` skill** gives natural-language invocation ("run doctor", "is my memory engine healthy", "repair my installation").
- The **`/assimilate-claude-os`** skill ends every update with a non-blocking `doctor` health summary, so the operator sees a health read on every sync without having to remember to ask.

The design principle throughout: **doctor tells the truth about state and never surprises the operator.** Diagnosis is the default; remediation is explicit; the dangerous defaults (`--force`, overwriting a baseline before a PASS, deleting data) are structurally impossible to trigger by accident.

---

## User Stories

### A. Running the diagnosis

**1. As the operator, I want to run a single command and get a health verdict, so that I can tell at a glance whether my installation is healthy after an update.**
```
Given a Dioscuri installation with a live memory.db
When I run `npm run doctor`
Then I see a grouped report of every check with an OK / WARN / FAIL status
And the process exits 0 if there are no FAILs, non-zero if any check FAILs
```

**2. As the operator, I want each non-OK check to tell me what it means and how to fix it, so that I am never left with a status I cannot act on.**
```
Given a check returns WARN or FAIL
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
Then the baseline-present check reports WARN with the instruction to capture one
```

**5. As the operator, I want doctor to detect a stale baseline at the cutover boundary, so that I am warned before a memory-merger close nags me with INCONCLUSIVE.**
```
Given the baseline records chunking_enabled = false
And the live index has chunking enabled
When doctor runs
Then the baseline-staleness check reports WARN ("baseline predates the cutover; re-baseline on the chunked index after a PASS")
And marks it fixable by the recapture-baseline remediation
```

**6. As the operator, I want doctor to find any held-out label that matches zero rows, so that I can diagnose an INCONCLUSIVE verdict as broken labels rather than a broken ranker.**
```
Given a presence label whose expectedPathContains matches no observation row
When doctor runs the broken-labels check
Then it reports FAIL, names the offending query and its dead path substring
And marks it fixable by the drop-dead-label remediation
```

**7. As the operator, I want doctor to compare the labeled set's corpus_snapshot against the live corpus, so that stale provenance metadata is caught.**
```
Given the labeled set records corpus_snapshot = N
And the live corpus has a materially different distinct-file count
When doctor runs
Then the corpus-snapshot check reports WARN with both numbers
And marks it fixable by the recompute-corpus-snapshot remediation
```

**8. As the operator, I want doctor to report the most recent composed eval verdict, so that I know whether the gate currently passes.**
```
Given doctor can run the eval in read-only mode against a throwaway DB copy
When doctor runs the verdict check
Then it reports the composed verdict (PASS / FAIL / INCONCLUSIVE) as OK / FAIL / WARN respectively
And, if eval cannot be composed, reports WARN with the reason rather than failing hard
```

### C. Index / cutover state checks

**9. As the operator, I want doctor to report the chunking marker state, so that I know whether the cutover has been applied.**
```
Given the c2_chunking_enabled meta marker is present or absent
When doctor runs
Then it reports the marker state as informational OK (on/off), not an error either way
```

**10. As the operator, I want doctor to detect files present in the corpus directories but missing from the index, so that a partial cutover/reindex is caught.**
```
Given one or more expected source files are not represented by any observation row
When doctor runs the index-coverage check
Then it reports WARN, listing the missing files
And marks it fixable by the reindex/re-embed remediation
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
Given one or more observation rows have no corresponding embedding row
When doctor runs the embedding-coverage check
Then it reports WARN with the count of un-embedded rows
And marks it fixable by the re-embed remediation
```

**14. As the operator, I want doctor to sanity-check corpus shape, so that an empty or obviously-wrong corpus is flagged.**
```
Given the corpus is empty, or expected source types are entirely absent
When doctor runs the corpus-shape check
Then it reports FAIL (empty corpus) or WARN (a whole source type missing)
```

### E. Single-writer / lock checks

**15. As the operator, I want doctor to detect a stale writer-election lock, so that a crashed session does not block index maintenance indefinitely.**
```
Given a writer-lock directory whose holder is no longer alive / is past staleness
When doctor runs the lock check
Then it reports WARN identifying the stale lock
And marks it fixable by the clear-stale-lock remediation
```

### F. Dependency & build checks (report-only)

**16. As the operator, I want doctor to summarize npm audit without ever offering `--force`, so that I see dependency drift without risking a destructive auto-fix.**
```
Given `npm audit` reports vulnerabilities
When doctor runs the dependency check
Then it summarizes counts by severity and notes which are dev-only vs runtime
And explicitly states this is report-only (links issue #84); it is never auto-fixed
And `npm audit fix --force` is never invoked by doctor
```

**17. As the operator, I want doctor to optionally verify the build and test suite, so that a broken toolchain is caught — without slowing the default run.**
```
Given the build/test checks are expensive
When I run `npm run doctor` without a deep flag
Then build/test checks are skipped with an informational note
When I run doctor with the deep/`--full` flag
Then tsc and the test suite run and report OK / FAIL (report-only; never auto-fixed)
```

### G. Backup checks

**18. As the operator, I want doctor to confirm a recent verified pre-cutover snapshot exists, so that I know a rollback is possible if a migration goes wrong.**
```
Given the expected backup artifacts
When doctor runs the backup check
Then it reports OK if a recent verified snapshot exists, WARN if none is found
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
Then repair removes that label from the held-out set
And re-runs the eval and reports the new composed verdict
And surfaces a PASS (or the new status) so I can see the fix took
```

**21. As the operator, I want repair to recapture the baseline only after a validated PASS, so that I can never overwrite the reference with a failing state.**
```
Given the recapture-baseline remediation is offered
When the current eval does not compose a PASS
Then repair refuses to recapture and explains why
When the current eval composes a PASS and I confirm
Then repair recaptures the baseline on the current (chunked) index
```

**22. As the operator, I want each remediation to be idempotent, so that re-running repair after a partial fix is always safe.**
```
Given a remediation has already been applied
When repair runs again
Then the corresponding check reports OK and the remediation is not re-offered
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
```

**25. As the operator, I want every claude-os sync to end with a health read, so that problems surface at the moment they are introduced.**
```
Given I run `/assimilate-claude-os`
When the update completes
Then a non-blocking `doctor` summary is appended to the output
And a doctor FAIL is surfaced as a warning but does not abort the completed update
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

1. **Two new modules, split deep/thin.** A new **doctor check-registry module** holds the diagnostic logic as a registry of independent check functions. Each check is a pure function of installation state returning a structured result: a stable check `id`, a `severity` (info/warn/fail), a `status` (ok/warn/fail), a human `detail` string, a `fixable` flag, and an optional `remediation` descriptor. This is the deep, testable module. A separate **doctor CLI script** is the thin orchestrator: it runs the registry, formats the grouped report, sets the process exit code, and drives `--fix`. The CLI follows the established operator-script convention (a testable exported entry guarded by a direct-invocation check) and is wired as the `doctor` npm script.

2. **Diagnosis opens the database raw.** Because the normal open path fails fast on a pre-C2 schema, the doctor opens the database with a raw handle (mirroring the migration script's pragmas + extension load) so it can diagnose the pre-migration state instead of throwing on it.

3. **Eval-gate inspectors are promoted to a shared module.** The baseline reader, the label-match probe (the broken-labels detector), the chunking-marker reader, and the labeled-set loader currently live inside the eval script. They are extracted into a shared eval-gate inspection module that both the eval script and the doctor registry import, so the two never diverge. Scope is limited to the helpers doctor needs — no broader refactor of the eval pipeline.

4. **Reuse, don't reimplement.** Schema-version detection, backup/verify, the cutover-boundary and file-set-hash helpers, the corpus distinct-file query, and the embedding/lock state are read through existing modules. Doctor adds checks; it does not re-derive these primitives.

5. **Repair model is confirm-then-apply, with a hard report-only set.** `repair`/`--fix` is opt-in. For each fixable finding it describes the action and applies it only on explicit confirmation. The fixable remediations are: drop a dead label then re-run eval; recompute the labeled set's corpus_snapshot; run the schema migration; re-embed missing rows; recapture the baseline (gated on a validated PASS); clear a stale writer lock. The report-only set — never mutated by doctor — is: npm-audit/vitest drift, build/test failures, and the #82 retrieval gap.

6. **No `npm audit fix --force`, ever.** Doctor summarizes audit severity and dev-vs-runtime classification and points at the tracked upgrade issue; it never invokes a dependency auto-fix.

7. **Output is human-first with an exit-code contract.** The default report is human-readable, grouped by domain, with OK/WARN/FAIL per check. Exit code is non-zero when any check is FAIL so `update.sh`/CI can gate on it. A machine-readable `--json` mode is deliberately **not** built now (YAGNI) and can be added if a consumer needs it.

8. **Expensive checks are opt-in.** Build (tsc) and the full test suite run only under a deep/`--full` flag; the default run stays fast and side-effect-free.

9. **Invocation surfaces:** the `doctor` npm script (primary), a thin `/doctor` skill wrapper (natural language), and a non-blocking doctor summary appended to the end of the `/assimilate-claude-os` skill. Doctor is intentionally a CLI script, not an MCP tool — it matches the eval/cutover/migrate pattern and needs no server runtime.

## Testing Decisions

**What makes a good test here:** each test asserts *external behavior* — given a fixture database (or fixture baseline/labeled-set files) in a known state, the check returns the expected status and fixable flag, and a remediation, once applied, flips the corresponding check to OK. Tests must not assert on internal data structures or private helpers; they drive checks and remediations through their public interface against real fixture DBs, exactly as the existing migration and tools suites do.

- **Tested:** the doctor check-registry module — every check exercised against a fixture DB constructed to trigger OK, WARN, and FAIL paths; and every `--fix` remediation exercised apply-then-verify (apply against a broken fixture, assert the check now reports OK, and assert idempotency on a second run). The recapture-baseline remediation is tested for its PASS-gate refusal as well as its success path.
- **Tested:** the promoted eval-gate inspection module (baseline read, broken-label probe, chunking-marker read, labeled-set load) — with a regression test that the existing eval script still composes identical verdicts after the extraction.
- **Out of test scope:** the thin doctor CLI script (formatting/exit-code glue, verified by hand), the `/doctor` skill wrapper, and the `/assimilate-claude-os` summary hook (orchestration glue).

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
- `npm test` and `npm run eval` both green; doctor itself reports OK on a healthy install

## Out of Scope

- **The #82 retrieval gap fix.** Doctor *detects* that the small single-row context topics return zero recall, but improving the ranker/chunk-routing so they retrieve is a separate investigation tracked in #82. Doctor never attempts to "fix" it.
- **The vitest 4 upgrade itself.** Doctor *reports* the dependency drift; performing the major bump is its own chore in #84.
- **A `--json` / machine-readable output mode.** Deferred until a concrete consumer needs it.
- **Auto-remediation without confirmation, and any destructive remediation.** Doctor will not delete corpus data, force-resolve locks held by a live writer, or overwrite a baseline without a PASS.
- **A scheduled/background launchd doctor job.** Invocation is manual + the post-update summary; a recurring background health job is not built now.
- **Broad refactors of the eval, indexer, or election modules.** Only the minimal eval-gate inspector extraction needed for reuse is in scope.

## Further Notes

- **Codebase verification:** the module design was checked against the actual `mcp/` source this session — the operator-script + `npm run` convention, the raw-open requirement (the normal open path throws on a pre-C2 schema), the schema/backup/migration helpers, the DB schema (observations, FTS, embedding, access, novelty, meta tables), and the writer-election lock. The eval-gate helpers doctor needs were confirmed to live inside the eval script today, which is why their extraction is an explicit implementation decision rather than an assumption.
- **Origin:** this feature is the generalization of a real manual recovery performed on 2026-06-22 after a claude-os update + C2 cutover. The check catalog is a direct encoding of that recovery's steps, so the first acceptance test of the whole feature is: *would doctor have correctly classified that day's INCONCLUSIVE as a single dead label, and offered the exact fix we applied by hand?*
- **Held-out doctrine:** the dead-label remediation removes a genuinely dead label (its target no longer exists). It must never be repurposed to delete a *valid* label merely because a query scores zero recall — that would be curating the held-out set to make the gate pass, which the eval protocol forbids. The broken-labels check keys on "matches zero rows," not "scores zero recall," precisely to honor that line.
