# qa-mode run record

Validation of `mode: qa` (added to `rubrics.md`) against the qa fixtures. Ground truth for both:
`fixture-qa-ticket.md` (ARC-9100 + AC1–AC3 + implementing change) and
`codebase/ResumeManagerGuarded.java` (the guarded/fixed implementation).

## fixture-qa-good.md → CLEAN

Reviewer scored Q1–Q7,Q9,Q10 PASS, Q8 NA (flag-less). Provisional CLEAN → red challenge dispatched.
The challenger made three grounded attempts across iterations — each surfaced a real inconsistency
in the fixture, not a rubric defect:
1. code did not yet implement the change (fixed: added `ResumeManagerGuarded.java`);
2. log emitted an unstructured message, so `event_type=` wasn't a queryable Splunk field (fixed: code now emits `event_type=manifest.resume.incomplete`);
3. Test 1 asserted "the final manifest gains its trailing checksum line" — an outcome outside the visible code's reach (fixed: Expected trimmed to the observable `fetchMissing` branch).
After those fixes the challenger returned `no-grounded-fail` → **CLEAN confirmed**. The challenge that
imagined a zero-gap truncation the test never seeds was correctly judged an over-reach and discarded.

## fixture-qa-bad.md → REVISE

Reviewer landed technical FAILs at the reviewer stage (no red challenge — not provisional CLEAN):
- **Q1** — AC3's only touch asserts a fabricated event, so AC3's real signal is never verified (planted defect Q-A).
- **Q10 / Q6** — `event_type=resume.partial.detected` is fabricated; the real event is `manifest.resume.incomplete` (planted defect Q-B).
- **Q5** — "resume works correctly" is a paraphrase, not observable.
- **Q9** — "Resume works as expected" is not an exit checklist.
- **Q3 / Q4** — no `file:line` traceability, no provisioned RID.

Verdict **REVISE**, `revise_lines: Q1,Q3,Q4,Q5,Q6,Q9,Q10`. Both planted defects (Q-A, Q-B) were caught.

## Conclusion

The qa rubric discriminates: a well-formed, code-grounded plan passes; a plan with an uncovered AC
and a fabricated identifier fails on exactly those lines. The challenger is rigorously code-grounded
(it caught three real fixture inconsistencies before confirming CLEAN), which is the property the
gate exists to provide.
