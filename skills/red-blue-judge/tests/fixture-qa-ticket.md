# ARC-9100 (FIXTURE) — Manifest completeness guard on resume

**Type:** User Story
**Priority:** High
**Implementing PR:** #9999 (merged) — ships flag-less.

## Description
Resume treated any non-empty manifest as complete, so a manifest interrupted mid-write was
skipped instead of re-fetched. This story makes resume detect a truncated manifest by the
trailing checksum line, re-fetch the missing entries, and emit a WARN so the existing Splunk
dashboard can alert.

## Acceptance Criteria
1. On resume, a manifest **missing its trailing checksum line** is detected as incomplete and
   triggers a re-fetch of the missing entries (never a skip).
2. On resume, a manifest **with its trailing checksum line present** short-circuits — no re-fetch,
   the existing files are used as-is. (the clean / negative case)
3. When an incomplete manifest is detected, the resume path emits a WARN log with `event_type`
   **`manifest.resume.incomplete`** carrying the manifest path and the **count of missing entries**,
   so the Splunk dashboard `download_resume_incomplete` can alert.

## Implementing change (ground truth for the QA plan)
- `ResumeManagerGuarded.isManifestComplete(path)` returns true only when the trailing checksum line
  is present (was: `Files.exists && size > 0`). File: `codebase/ResumeManagerGuarded.java`.
- `ResumeManagerGuarded.resume(ctx)` calls `entryFetcher.fetchMissing(...)` on the incomplete branch
  and logs the WARN `manifest.resume.incomplete` with `{ manifestPath, missingCount }` before re-fetch.
- Flag-less: behavior is unconditional; there is no feature flag and no flag-off regression.
- Verification surface: AC1/AC2 are observable by resuming against a seeded manifest (truncated vs
  checksum-terminated) and watching whether a re-fetch occurs; AC3 is observable in Splunk via
  `event_type=manifest.resume.incomplete`.
