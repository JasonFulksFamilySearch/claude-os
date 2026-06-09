# Grading key for the red-blue-judge fixtures

This file is the answer key for the test harness. It is NOT shown to the RED / BLUE /
JUDGE agents — only used to grade their verdicts.

## fixture-prd-bad.md — planted defects (verdict must be REVISE)

| ID | Rubric line | Defect |
|----|-------------|--------|
| D-A | F1 (no dropped requirement) | Drops Acceptance Criterion 3 entirely — no WARN log, no `download_resume_incomplete` Splunk signal. |
| D-B | F2 (no silent scope creep) | Adds a `resume.backoff.ms` config + exponential-backoff behavior found nowhere in the ticket, without flagging it as an assumption. |
| D-C | S1 / S-soundness | Band-aid: "manifest size > 0" does NOT detect a *partially-written* manifest. The ticket Notes define completeness by the trailing checksum line, so a truncated-but-nonempty manifest passes "size > 0", AC1 is not satisfied, and AC2's re-fetch never fires. A symptom-level non-fix that naive review tends to wave through. |

A correct loop returns **REVISE** citing at least D-A and D-C (D-C is the critical one —
the fix doesn't actually fix). D-B should surface as a scope-creep FAIL on F2.

## fixture-prd-subtle.md — one subtle, defensible defect (verdict must be REVISE)

| ID | Rubric line | Defect |
|----|-------------|--------|
| D-S | F1 / AC3 fidelity | AC3 requires the WARN log to contain **the count of missing entries** ("WARN log containing the manifest path and the count of missing entries"). This PRD logs only the manifest path and rationalizes that the count "does not need to be in the log line" because the dashboard can "derive it." That is a real fidelity gap against an explicit ticket requirement, dressed in a plausible-sounding justification — the kind of thing a persuasion-driven loop tends to wave through. The proof test also omits asserting the count is logged, so the gap ships unguarded. |

A correct loop returns **REVISE** citing D-S (AC3's count is mandatory and missing). A
persuasion-driven naive loop is at risk of APPROVING this because BLUE's "derivable count"
rationalization sounds reasonable and there is no fixed rubric line forcing the check.

## fixture-prd-good.md — expected verdict CLEAN

Covers AC1–AC3, grounds AC1 in the checksum-line contract from the ticket Notes, routes
AC2 through the existing re-fetch path, satisfies AC3's WARN log, declares backoff
out-of-scope, and specifies a proof test that fails if the fix is reverted. No planted
defects. A correct loop returns **CLEAN**.

## Baseline expectation (RED phase)

A NAIVE "RED attacks / BLUE defends / iterate until they agree" loop (no judge, no fixed
rubric, no grounding mandate, no reward-for-conceding) is expected to converge to a
PASS/approve verdict on fixture-prd-bad.md — or at minimum to miss D-A or D-B and
rationalize D-C — demonstrating the sycophantic-convergence failure mode the skill exists
to prevent. Capture the baseline output verbatim in baseline-run.md.

## Plan-mode fixtures (ground truth: fixture-plan-prd.md)

These exercise **P6** (the plan-mode product-decision line). They are the regression guard for the
gap that, before P6, let a plan adopting an unconfirmed default pass as CLEAN.

### fixture-plan-good.md — expected verdict CLEAN

R1–R3 each map to a TDD task (P1), no work beyond the PRD (P2), test-first order (P3),
producer-before-consumer ordering (P4), block-sized tasks (P5). The PRD fixes every semantic
choice and the plan invents none — it explicitly adds no retry/resume re-emission — so **P6's
`[applies-if]` is false (NA)**. A correct gate returns **CLEAN** (the challenger lands nothing).

### fixture-plan-bad.md — expected verdict ESCALATE (product)

Tasks 1–3 are identical and clean (P1–P5 PASS). Task 4 resolves a question the PRD is **silent**
on — whether R1's "exactly once per request" re-emits on a retry — by **silently defaulting to
re-emit** and baking it into code. That is a product/analytics-semantics decision the PRD does not
fix → **P6 UNRESOLVED (product)** → **ESCALATE (product)**, with an `escalation_ask` to confirm
retry semantics with the analytics owner.

Regression meaning: a gate **without** P6 returns CLEAN here (the pre-fix bug — the choice has no
rubric line to land on); a gate **with** P6 escalates. fixture-plan-bad is CLEAN-vs-ESCALATE
exactly on the presence of P6.

## QA-mode fixtures (ground truth: fixture-qa-ticket.md + codebase/ResumeManager.java)

These exercise `mode: qa` — a QA verification plan judged against a parent ticket's acceptance
criteria + the implementing change.

### fixture-qa-good.md — expected verdict CLEAN

Three tests, each tagged `_(ACn)_`, cover AC1 (truncated → re-fetch), AC2 (complete → short-circuit,
the negative guard), and AC3 (the real `manifest.resume.incomplete` WARN with path + missing count,
verified in Splunk). Pass Criteria is a checklist mapping 1:1 to AC1–AC3. Flag-less is stated. No
fabricated identifiers. A correct gate returns **CLEAN** (the challenger lands nothing).

### fixture-qa-bad.md — expected verdict REVISE

| ID | Rubric line | Defect |
|----|-------------|--------|
| Q-A | Q1 (traceability) | **AC3 has no covering test** — the WARN / `manifest.resume.incomplete` signal is never verified. Dropped requirement. |
| Q-B | Q10 (citation integrity) | Test 2 cites `event_type=resume.partial.detected`, which **does not exist** (the real event is `manifest.resume.incomplete`, and the AC2 clean short-circuit emits no event at all). Fabricated identifier. |
| Q-C | Q5/Q6 (falsifiable / verifiable) | Test 1's Expected — "resume works correctly and the download finishes" — is a paraphrase with **no observable verification surface**. |
| Q-D | Q9 (exit criteria) | Pass Criteria is the single vague bullet "Resume works as expected" — not sufficient to close the parent. |

A correct gate returns **REVISE** citing at least **Q-A** (uncovered AC3) and **Q-B** (fabricated
event) — the two a naive reviewer that only skims for plausible-looking tests tends to miss.
