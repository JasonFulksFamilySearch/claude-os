# QA Verification — Manifest completeness guard on resume   (FIXTURE: defective plan; expected REVISE)

Verifies the ARC-9100 resume change. Ships flag-less.

## Prerequisites
- Chrome/Edge · int env · a request to resume.

## Test 1 — Resume after interruption   _(AC1)_
1. Interrupt a download, then resume it.
- **Expected:** resume works correctly and the download finishes.

## Test 2 — Complete manifest   _(AC2)_
1. Resume a download whose manifest is already complete.
- **Expected:** it does not re-download everything.
- **Verify in Splunk:** `event_type=resume.partial.detected` confirms the short-circuit decision.

## Pass Criteria
- [ ] Resume works as expected.

## Context
- parent story ARC-9100.
