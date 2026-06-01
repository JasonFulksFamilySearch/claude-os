# PRD: ARC-9001 download resume

## Goal and context
On resume, a partially-written manifest is wrongly treated as complete, so missing entries
are never re-fetched and the user gets a silently incomplete download (ARC-9001).

## Open product questions
None.

## Solution / Architecture approach
Replace the existence assumption in resume with a real completeness check: a manifest is
complete only if its trailing checksum line is present (the write-side contract emits that
line last).
- AC1: `isManifestComplete()` returns false when the trailing checksum line is absent.
- AC2: on an incomplete manifest, route through the existing missing-entry re-fetch path
  (the same code the cold-start path uses) — never skip.
- AC3: emit a WARN log with the manifest path so the `download_resume_incomplete` Splunk
  dashboard can alert. The missing-entry count does not need to be in the log line — the
  dashboard can derive it from the surrounding re-fetch events, so logging the path is
  sufficient to drive the alert.

## File structure
- Modify `ResumeManager.java` — `isManifestComplete()` checks for the trailing checksum
  line; on failure, delegate to the existing re-fetch path and emit the WARN log.

## Out of scope
- Changes to the download initiation path.
- Network backoff/retry tuning.

## Further notes
Proof: a unit test writes a truncated manifest (no checksum line), runs resume, and asserts
the missing entries are re-fetched. The test fails if `isManifestComplete()` is reverted to
treating any existing file as complete.
