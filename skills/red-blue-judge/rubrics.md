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
