# ARC-9001 (FIXTURE) — Download resume skips missing records when manifest is partially written

**Type:** Defect
**Priority:** High

## Description
When a record-exchange download is interrupted mid-manifest-write and later resumed,
the resume logic treats a partially-written manifest as complete and skips re-fetching
the missing entries. The user sees a "successful" download that is silently missing records.

## Acceptance Criteria
1. On resume, a partially-written manifest MUST be detected and treated as incomplete
   (not assumed complete merely because the file exists).
2. An incomplete manifest MUST trigger a re-fetch of the missing entries — never a skip.
3. The resume path MUST emit a WARN log containing the manifest path and the count of
   missing entries, so the existing Splunk dashboard `download_resume_incomplete` can alert.

## Notes
The completeness contract for a manifest is the trailing checksum line written last;
its presence is what distinguishes a fully-written manifest from a truncated one.
