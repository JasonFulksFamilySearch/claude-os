# PRD (FIXTURE — SOUND): ARC-9001 download resume

> Control fixture. A correct review loop should return CLEAN on this one.

## Goal and context
On resume, a partially-written manifest is wrongly treated as complete, so missing entries
are never re-fetched and the user gets a silently incomplete download (ARC-9001, AC1–AC3).

## Open product questions
None — the completeness contract (trailing checksum line) is specified in the ticket Notes.

## Solution / Architecture approach
Root cause: `ResumeManager.isManifestComplete()` (`ResumeManager.java:31`) treats any
existing, non-empty manifest as complete (`Files.exists(p) && size(p) > 0`), so a truncated
manifest passes. Replace that with a true completeness check: a manifest is complete only if
its trailing checksum line is present (the write-side contract emits that line last).
- AC1: `isManifestComplete()` (`ResumeManager.java:31`) checks for the trailing checksum
  line instead of file size.
- AC2: when the check fails, `resume()` (`ResumeManager.java:36`) already routes to the
  existing missing-entry re-fetch — `entryFetcher.fetchMissing(...)` at `ResumeManager.java:41`,
  shared with the cold-start path. Correcting the predicate makes a truncated manifest take
  that branch instead of the early return (`ResumeManager.java:38`), rather than skipping.
- AC3: on detecting an incomplete manifest, emit a WARN log with the manifest path AND the
  count of missing entries, matching the `download_resume_incomplete` Splunk dashboard fields.

## File structure
- Modify `ResumeManager.java` — `isManifestComplete()` (line 31) performs checksum-line
  detection; `resume()` (line 36) then reaches the existing re-fetch and emits the WARN log.

## Out of scope
- Changes to the download initiation path.
- Network backoff/retry tuning (not requested by this ticket).

## Further notes
Proof: a unit test writes a truncated manifest (no checksum line), runs resume, and asserts
(a) the missing entries are re-fetched and (b) the WARN log is emitted. The test fails if
`isManifestComplete()` is reverted to the size check.
