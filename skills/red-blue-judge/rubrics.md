# Rubrics for red-blue-judge

The reviewer scores **every applicable line** PASS / FAIL / UNRESOLVED with cited evidence.
Lines test **invariants** — questions true of every good artifact of that kind — so one
rubric spans all ticket types. A few lines are gated by `[applies-if: …]`; skip a line whose
condition does not hold. These rubrics are FIXED: the reviewer and challenger score against
them, they do not edit them (a measured agent must not author its own measure).

---

## mode: `prd` — Gate 1 (PRD vs. ticket + codebase)

**Ground truth:** the originating ticket; the codebase.

*Fidelity — does the PRD faithfully represent the ticket?*
- **F1** Every requirement / acceptance criterion in the ticket maps to a specific part of the PRD. (no dropped requirement)
- **F2** The PRD adds no file, behavior, or capability absent from the ticket — unless listed under Out of Scope or flagged as an assumption. (no silent scope creep)
- **F3** The PRD's problem statement is the same problem the ticket states, not a reinterpreted or adjacent one.
- **F4** Any ticket requirement the PRD cannot satisfy is surfaced as an open question, not silently omitted.

*Soundness — is the proposed fix grounded, not just plausible?*
- **S1** Names a root cause (or, for a feature, the integration point) and cites at least one concrete `file:line` as evidence.
- **S2** Every existing file the PRD names actually exists (verify by Glob/Read) and is the correct place for the change; every new file is named with its responsibility.
- **S3** Mirrors an existing codebase pattern (cite it) — or, if it introduces a new pattern, justifies why existing patterns don't fit. `[applies-if: new pattern]`
- **S4** The change would not obviously break an adjacent/calling module the reviewer can name.
- **S5** States how the fix will be proven: a failing test the change makes pass. `[applies-if: bug ticket]`

---

## mode: `plan` — Gate 2 (implementation plan vs. PRD + codebase)

**Ground truth:** the approved PRD; the codebase.

- **P1** Every PRD requirement maps to at least one plan task. (no dropped requirement)
- **P2** No task does work outside the PRD's scope. (no scope creep)
- **P3** Each task follows TDD order: failing test → implement → commit.
- **P4** Task ordering respects dependencies — no task needs the output of a later task.
- **P5** Each task is small enough to implement and review independently (fits a ~3-hour block).
- **P6** Every product/stakeholder decision the plan depends on is settled by the approved PRD; any the PRD left open is surfaced as blocking, not resolved by an unconfirmed default the plan adopts on its own. (no silent product default) `[applies-if: the plan makes a product/semantic choice the PRD does not fix]` — a violation is a **product** UNRESOLVED (a human/stakeholder must confirm before implementation), not a technical FAIL.

---

## mode: `diff` — Gate 3 (implemented diff vs. ticket + PRD + tests)

**Ground truth:** the diff; the ticket; the PRD; the test suite; **the codebase / working tree**.
This is the only gate that can judge the *implemented* fix, not merely the intended one. The
codebase is required ground truth here — G3/G4 cannot be scored without grepping it for callers
and consumers, so a run that omits it must mark those lines UNRESOLVED (evidence), not PASS.

*Fidelity*
- **D1** Every PRD requirement / plan task is reflected in the diff. (nothing silently dropped)
- **D2** The diff contains nothing outside the PRD/plan scope without justification. (no unrelated changes)

*Genuineness — a real fix, not a plausible non-fix*
- **G1** Addresses the root cause named in the PRD at the cited location — not a downstream symptom.
- **G2** The new/changed test would FAIL if the production change were reverted. (anti-tautological-test — the challenger may demand this be demonstrated, e.g. by reasoning about the revert or by `git stash`+run)
- **G3** Not symptom suppression: no swallowed exception, widened type, or test-input special-casing standing in for a fix.
- **G4** No adjacent behavior is broken — for every symbol, guard, or behavior the diff **removes or changes**, name its consumers (grep the codebase) and show each still holds. Removing a guard counts: name what depended on it *or on its side effects*, including consumers in other layers (UI, workers, telemetry).
- **G5** A regression test reproduces the original bug. `[applies-if: bug ticket]`
- **G6** If the change's correctness depends on behavior outside the diff's reach — a server contract, a deploy ordering, another service's response — that dependency is UNRESOLVED (product or evidence) → **ESCALATE**, never PASS. Name the contract and what must be verified.

---

## mode: `experience` — Gate (synthesized experience-learning vs. source episodes + existing learnings)

**Ground truth:** the cited source episodes (read them); the existing learnings (agent + project).
A synthesized cross-session "experience" learning is only as good as its grounding. These lines
test that the abstraction is *earned* and *not redundant or contradictory* — the anti-"insight
inflation" bar the strategic briefing's B1 ruling requires. An LLM will happily manufacture a
profound-sounding lesson from a coincidental cluster; this rubric is what catches that.

*Grounding — is the claim actually supported by the evidence?*
- **E1** Every claim in the proposed learning is supported by at least one cited source episode (read the episodes — a claim no cited episode supports is ungrounded). (grounding)
- **E2** Every cited episode is real and genuinely pertains to the claim — no fabricated, mismatched, or padding citation. (citation integrity)

*Non-redundancy — does it actually add knowledge?*
- **E3** The proposed learning is not contradicted by an existing learning; if it reverses one, that supersession is named explicitly, not silently asserted. (non-contradiction)
- **E4** The proposed learning is not already stated by an existing learning. (no redundant re-derivation)

*Earned abstraction — is the cluster real?*
- **E5** The episodes share a genuine recurring situation, and the learning names that shared situation — not a coincidental embedding proximity dressed up as a pattern. A cluster that is only superficially related is an E5 FAIL. (coherence, not coincidence)
- **E6** Scope and altitude are correct: agent scope only if the lesson generalizes beyond a single project, and the learning is a concrete, actionable rule, not a platitude. (scope & specificity)

---

## mode: `defect` — Gate (defect verdict vs. ticket claims + codebase)

**Ground truth:** the ticket (description, comments, acceptance criteria); the codebase; git
history; Harness flags.

A "this defect is honest / true / current" verdict is only as good as its grounding. These lines
test that each claim was checked against the code, that the verdict (CONFIRMED-LIVE / STALE /
SYMPTOM / CANNOT-DETERMINE) is earned, and that cross-repo and flag-state honesty is preserved — the
anti-"plausible but unverified" bar.

- **V1** Every verifiable claim in the ticket is scored against the code with a cited `file:line` (or a named backend repo/endpoint). (no unverified claim)
- **V2** The verdict is grounded: a STALE verdict cites the commit/refactor that fixed it (pickaxe/log); a CONFIRMED-LIVE verdict shows the bug path still present at `file:line`. (grounded verdict)
- **V3** Claims are anchored on stable identifiers (error codes, function names), not the ticket's cited line numbers. (drift-robust)
- **V4** Any flag the verdict depends on is checked for EXISTENCE in Harness (not just `dev.flags.js`) in the relevant environment; a dev-only flag is treated as off in prod. `[applies-if: the verdict hinges on a feature flag]`
- **V5** The prescribed fix names a real insertion point (`file:line`) and does not re-implement code already present. `[applies-if: CONFIRMED-LIVE]`
- **V6** Dedup / relationship claims (duplicate-of, caused-by) are verified against the named tickets/commits, not asserted. `[applies-if: a dedup/causal claim is made]`
- **V7** If the root cause or fix lives outside this repo (backend / another service), that dependency is UNRESOLVED → ESCALATE, not a confident code verdict. `[applies-if: backend/symptom class]`
- **V8** For a STALE / already-fixed verdict, a surviving instance of the same bug class *off the verified path* was searched for (sibling call sites, other consumers of the anti-pattern, guard-bypassing paths) and none reaches the failure boundary. `[applies-if: STALE / already-fixed verdict]` (anti-"fixed on the happy path only")

---

## Adding a rubric (for reuse beyond make-it-so)

red-blue-judge is reusable for any artifact with a checkable source of truth (PR review,
investigation confidence, release readiness). To add a mode:

1. Name the **ground truth** the lines cite.
2. Write lines as **invariants** — questions true of every good instance, not facts about one
   case. Gate case-specific lines with `[applies-if: …]`.
3. Keep each line **independently scorable** with concrete evidence (PASS/FAIL/UNRESOLVED).
4. Harden it the way these were: run good + flawed fixtures through it (see `tests/`) and
   adjust lines that misfire.

---

## mode: `compliance` — Gate (ai-scientist VERDICT vs. Anthropic standards + scanned files)

**Ground truth:** the scanned files (read them directly — do not trust the VERDICT's
description of what they contain); the named Anthropic documentation sources cited per finding;
the specialist check definitions in `prompt-linter.md`, `token-auditor.md`, `api-hygienist.md`.

A compliance VERDICT is only as good as its grounding. The ai-scientist specialist agents read
files and apply named checks — but they are LLMs and can hallucinate citations, misread line
ranges, or issue BLOCKs on findings that don't hold when the file is read directly. These lines
test that every finding is earned, every citation is real, and the VERDICT severity is calibrated
— the anti-"plausible but unverified" bar for AI systems compliance findings.

*Citation integrity — is the finding actually in the file?*
- **CI1** Every BLOCK and WARN finding names a specific file path. A finding without a file path
  is ungrounded → FAIL. (no floating findings)
- **CI2** Every BLOCK finding names a line range or specific parameter/pattern. A BLOCK citing
  only a file name without a location is insufficiently specific → FAIL. (BLOCK precision)
- **CI3** The cited file exists and is readable (Glob/Read it). A finding citing a file that
  does not exist at the named path is fabricated → FAIL. (file existence)
- **CI4** The quoted or described violation is actually present at the cited location (Read the
  file at the cited line). A BLOCK whose cited evidence is not present at the named location
  is invalid → FAIL. (evidence present at location)

*Standard provenance — is the finding grounded in a named standard?*
- **SP1** Every BLOCK finding names the check ID that fired (C1–C7, T1–T6, A1–A6, O1–O4).
  A BLOCK without a check ID cannot be verified against the standard → FAIL. (check traceability)
- **SP2** Every check ID cited actually exists in the specialist agent's definition. A finding
  citing a non-existent check ID indicates the agent fabricated the check → FAIL. (check validity)
- **SP3** The violation described matches what the named check tests. A finding where the cited
  check ID tests X but the finding describes Y is a mismatch → FAIL. (check-to-finding match)

*Severity calibration — is BLOCK vs. WARN correctly assigned?*
- **SC1** Every BLOCK finding describes a violation where the named check explicitly specifies
  BLOCK severity (not WARN). A BLOCK issued on a WARN-level check is an escalation violation
  → FAIL. (no severity inflation)
- **SC2** No finding issues BLOCK on a condition the specialist check explicitly gates with
  `[applies-if: …]` when that condition does not hold. Read the check definition and verify
  the applies-if condition is met. `[applies-if: the finding is on a gated check]` (applies-if
  gate respected)
- **SC3** The overall VERDICT (BLOCK / CONDITIONAL / PASS) correctly reflects the findings:
  BLOCK if any finding is BLOCK-severity; CONDITIONAL if findings are WARN-only; PASS only if
  zero findings. A VERDICT that contradicts its own findings is invalid → FAIL. (verdict math)

*Completeness — did the ai-scientist actually scan what it claims?*
- **CO1** The SCOPE section names specific files scanned. A SCOPE section that says "all
  claude-os files" without naming them is not auditable → FAIL. (scope specificity)
- **CO2** All three specialists were invoked (prompt-linter, token-auditor, api-hygienist).
  A VERDICT produced without invoking all three is incomplete → FAIL unless scope genuinely
  contained no files relevant to a specialist, in which case that specialist's absence must
  be explained. `[applies-if: any specialist is absent from the VERDICT]` (specialist coverage)
- **CO3** The orchestration checks O1–O4 appear in the VERDICT or are explicitly noted as not
  applicable with a reason. Silent omission of O1–O4 means they were not run → FAIL.
  (orchestration check coverage)

*Actionability — can Jason act on this?*
- **AC1** Every BLOCK finding includes a specific required fix — not "update this" but the
  exact change (e.g., "replace `budget_tokens: 8000` with `effort: \"high\"`"). A BLOCK
  without an actionable fix is a blocker Jason cannot resolve → FAIL. (fix specificity)
- **AC2** No finding recommends an action that would itself violate a standard. For example,
  a fix that moves content from CLAUDE.md to a skill must not recommend a skill structure
  that violates C4. `[applies-if: the recommended fix is structural]` (fix validity)

---

## mode: `qa` — Gate (QA verification plan vs. parent ticket + implementing PR + codebase)

**Ground truth:** the parent ticket (description, acceptance criteria `customfield_10085`,
comments); the implementing PR diff; the codebase (`file:line`); Harness flags; the named test
fixture / RID.

A QA verification sub-task is a *test plan derived from a ticket and the code that implements it*.
It is only as good as its grounding: an LLM will happily emit a plausible-looking test list that
restates the acceptance criteria without ever naming a way to observe pass/fail, leaves an AC
uncovered, or asserts an Expected result the code never produces. These lines test that every AC
is covered, every step is executable by a QA owner who lacks the dev's automation, and every cited
fixture/event/path is real — the anti-"plausible but unrunnable test plan" bar.

*Coverage / fidelity — does the plan test what the ticket requires?*
- **Q1** Every acceptance criterion in the parent ticket maps to ≥1 test, and the test names the AC it covers. A criterion with no covering test is a gap → FAIL. (traceability)
- **Q2** The plan adds no test for behavior absent from the ticket and PR — unless it is explicitly marked as a regression or guard. (no speculative scope creep)
- **Q3** Each test traces to a real change in the PR diff at a cited `file:line` (it exercises code the PR actually touched), not a generic feature wish. (grounded in the implementation)

*Executability / soundness — can a QA owner actually run each step?*
- **Q4** Each test states concrete preconditions — env/browser, flag state, and a REAL provisioned RID or named seed fixture, not "set up a request." (grounded prerequisites)
- **Q5** Each Expected result is observable and grounded in actual code behavior (a named dir/file/column/status value/event), not a paraphrase of the acceptance criterion. (falsifiable expected result)
- **Q6** Each test names a verification surface that exists for this change — a Splunk `event_type` query, an on-disk artifact to inspect, a network call to watch, or a named unit test to fall back on. A step with no observable pass/fail signal → FAIL. (verifiable)
- **Q7** Where the behavior is conditional, the plan includes the negative / false-positive guard (the clean case stays unflagged, resume produces no duplicate rows, flag-OFF reverts). (no happy-path-only)

*Regression & flag honesty*
- **Q8** If the change is feature-flagged, the plan includes a flag-ON and a flag-OFF (regression) case; if it ships flag-less, the plan says so and asserts there is no flag-off regression to run. `[applies-if: the change is gated by a feature flag]` (flag pairing)

*Exit & integrity*
- **Q9** The Pass Criteria are explicit exit criteria (a checklist) that, taken together, are sufficient to close the parent — not a vague "works as expected." (exit criteria)
- **Q10** Every RID, `event_type`, file path, column name, or status value the plan cites is real — verified against the PR diff, the code, or a provisioned fixture — not invented. A fabricated identifier is a FAIL even if the rest of the test is sound. (citation integrity)

The challenger's job: land ONE grounded FAIL — an acceptance criterion no test covers (Q1), an
Expected result the code never produces (Q5), a cited `event_type` the diff never emits (Q6/Q10),
or a fabricated RID/path (Q10).

---
