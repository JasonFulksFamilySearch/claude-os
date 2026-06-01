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

---

## mode: `diff` — Gate 3 (implemented diff vs. ticket + PRD + tests)

**Ground truth:** the diff; the ticket; the PRD; the test suite. This is the only gate that
can judge the *implemented* fix, not merely the intended one.

*Fidelity*
- **D1** Every PRD requirement / plan task is reflected in the diff. (nothing silently dropped)
- **D2** The diff contains nothing outside the PRD/plan scope without justification. (no unrelated changes)

*Genuineness — a real fix, not a plausible non-fix*
- **G1** Addresses the root cause named in the PRD at the cited location — not a downstream symptom.
- **G2** The new/changed test would FAIL if the production change were reverted. (anti-tautological-test — the challenger may demand this be demonstrated, e.g. by reasoning about the revert or by `git stash`+run)
- **G3** Not symptom suppression: no swallowed exception, widened type, or test-input special-casing standing in for a fix.
- **G4** No adjacent behavior is broken — name an edge case / caller and show it is covered.
- **G5** A regression test reproduces the original bug. `[applies-if: bug ticket]`

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
