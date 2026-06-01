# GREEN verification — the written skill, end-to-end

**Date:** 2026-06-01
**Setup:** Subagents executing the *actual* `red-blue-judge` SKILL.md + `rubrics.md` (mode
`prd`) — reviewer scores the fixed rubric with grounded evidence; on provisional CLEAN a
separate, reviewer-blind challenger attempts one grounded FAIL. Each verdict graded against
`EXPECTED.md`.

## Test matrix — all paths correct

| Fixture | Ground truth | Expected | Reviewer verdict | Challenge | Final | ✓ |
|---|---|---|---|---|---|---|
| `fixture-prd-bad.md` | ticket | REVISE | REVISE (7 technical FAILs: F1–F4, S1, S3, S5) | n/a | **REVISE** | ✅ |
| `fixture-prd-subtle.md` | ticket | REVISE | REVISE (F1 — AC3 drops the missing-entry count) | n/a | **REVISE** | ✅ |
| `fixture-prd-good.md` | ticket only (no code) | (escalate) | ESCALATE — S1/S2/S4 UNRESOLVED (evidence-inaccessible) | n/a | **ESCALATE (evidence)** | ✅ |
| `fixture-prd-good.md` | ticket + `codebase/` | CLEAN | provisional CLEAN (all PASS, S3 N/A; file:lines verified @31/36/38/41) | reviewer-blind challenger: "NO GROUNDED FAIL" | **CLEAN confirmed** | ✅ |

## What each path demonstrates

- **REVISE (technical):** the skill catches both a blatant band-aid and a subtle, defensible
  fidelity gap — each FAIL cites ticket line or `file:line`, no rhetoric.
- **ESCALATE (evidence):** with no codebase to ground the soundness lines, the skill refuses
  to PASS them and escalates as a *setup gap* (supply the repo) — not a human product call.
  This validated the two-types-of-UNRESOLVED refinement.
- **CLEAN confirmed:** with the codebase present and the PRD citing real `file:line`s, all
  lines PASS; the adversarial challenger re-verified every citation and probed F1/S3/S4 before
  conceding it could not land a grounded FAIL. This is the auto-proceed path — verified to
  advance only after surviving an adversarial look.

## Note
`codebase/ResumeManager.java` is a non-compilable stub: enough structure (the buggy predicate
at line 31, the `resume()` guard, the shared `fetchMissing` re-fetch path) for the soundness
lines to be grounded. `fixture-prd-good.md` was updated to cite those concrete `file:line`s,
making it a proper CLEAN exemplar (a real "good" PRD cites its evidence).
